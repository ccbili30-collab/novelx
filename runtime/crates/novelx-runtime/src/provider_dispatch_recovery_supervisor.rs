use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use novelx_protocol::ProviderRunIdentity;
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    agent_assignment_recovery::{AgentAssignmentRecoveryError, recover_agent_assignments},
    event_journal::{EventJournal, EventJournalError},
    operational_recovery_aggregate::{
        OperationalRecoveryAggregateError, OperationalRecoveryEffectClass,
        OperationalRecoveryRepository,
    },
    operational_recovery_claim_service::{
        OperationalRecoveryClaimError, OperationalRecoveryClaimRequest,
        OperationalRecoveryClaimService, OperationalRecoveryStartRequest,
        OperationalRecoveryTransferRequest,
    },
    operational_recovery_recording_service::{
        OperationalRecoveryInterruptionRequest, OperationalRecoveryRecordingError,
        OperationalRecoveryRecordingService,
    },
    operational_recovery_scanner::{
        OperationalRecoveryGate, OperationalRecoveryScanError, OperationalRecoveryScanner,
    },
    provider_attempt::{ProviderAttemptAggregate, ProviderAttemptError, ProviderAttemptState},
    provider_dispatch_recovery_service::{
        DispatchEvidence, ProviderDispatchAuthorizedResumeRequest,
        ProviderDispatchInterruptedBeforeSent, ProviderDispatchRecoveryError,
        ProviderDispatchRecoveryRequest, ProviderDispatchRecoveryResult,
        ProviderDispatchRecoveryService, ProviderDispatchRecoveryTerminal,
    },
    provider_dispatch_resume_authorization_service::{
        ProviderDispatchResumeAuthorizationError, ProviderDispatchResumeAuthorizationRequest,
        ProviderDispatchResumeAuthorizationService,
    },
    provider_gateway::{ProviderGateway, ProviderRegistry},
    provider_inference_service::ProviderInferenceServiceError,
    runtime_cancellation_hub::{RuntimeCancellationHub, RuntimeCancellationHubError},
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
    workspace_runtime_lease::{BoundWorkspaceRuntimeLease, BoundWorkspaceRuntimeLeaseError},
};

const DEFAULT_CLAIM_LEASE_SECONDS: u64 = 60;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderDispatchRecoverySupervisorReport {
    pub runs: Vec<ProviderDispatchRecoverySupervisorRun>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderDispatchRecoverySupervisorRun {
    pub run_id: String,
    pub operation_id: String,
    pub outcome: ProviderDispatchRecoverySupervisorOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderDispatchRecoverySupervisorOutcome {
    Completed(ProviderDispatchRecoveryTerminal),
    InterruptedBeforeSent(ProviderDispatchInterruptedBeforeSent),
    AwaitingAttemptOwner,
    StaleOperationClosed,
    AwaitingClaimExpiry,
    Waiting(OperationalRecoveryGate),
    Blocked(&'static str),
}

pub struct ProviderDispatchRecoverySupervisor {
    database_path: PathBuf,
}

impl ProviderDispatchRecoverySupervisor {
    pub fn new(database_path: impl AsRef<Path>) -> Self {
        Self {
            database_path: database_path.as_ref().to_owned(),
        }
    }

    pub async fn run_provider_dispatch_pass(
        &self,
        workspace_id: &str,
        project_id: &str,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        cancellation_hub: &RuntimeCancellationHub,
        exclusive_lease: &Arc<BoundWorkspaceRuntimeLease>,
    ) -> Result<ProviderDispatchRecoverySupervisorReport, ProviderDispatchRecoverySupervisorError>
    {
        require_text("workspace_id", workspace_id)?;
        require_text("project_id", project_id)?;
        exclusive_lease.verify_database_authority(&self.database_path)?;
        let bound_providers = providers.bound_identities();
        let report = self.scan_consistently(workspace_id, project_id, &bound_providers)?;
        let created_at = timestamp()?;
        let recorded = OperationalRecoveryRecordingService::new(&self.database_path).record(
            workspace_id,
            project_id,
            &report,
            exclusive_lease.as_ref(),
            &created_at,
        )?;
        let operation_by_run = recorded
            .into_iter()
            .map(|item| (item.run_id, item.operation_id))
            .collect::<BTreeMap<_, _>>();
        let mut results = Vec::with_capacity(report.runs.len());
        for run in report.runs {
            let operation_id = operation_by_run
                .get(&run.run_id)
                .ok_or(ProviderDispatchRecoverySupervisorError::StateInvariant(
                    "recording omitted a scanned run",
                ))?
                .clone();
            results.push(
                self.drive_run(
                    workspace_id,
                    project_id,
                    &run.run_id,
                    &operation_id,
                    run.gate,
                    &bound_providers,
                    providers,
                    gateway,
                    cancellation_hub,
                    exclusive_lease,
                )
                .await?,
            );
        }
        results.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        Ok(ProviderDispatchRecoverySupervisorReport { runs: results })
    }

    #[allow(clippy::too_many_arguments)]
    async fn drive_run(
        &self,
        workspace_id: &str,
        project_id: &str,
        run_id: &str,
        current_operation_id: &str,
        current_gate: OperationalRecoveryGate,
        bound_providers: &[ProviderRunIdentity],
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        cancellation_hub: &RuntimeCancellationHub,
        exclusive_lease: &Arc<BoundWorkspaceRuntimeLease>,
    ) -> Result<ProviderDispatchRecoverySupervisorRun, ProviderDispatchRecoverySupervisorError>
    {
        let aggregate =
            OperationalRecoveryRepository::open(&self.database_path)?.load(workspace_id, run_id)?;
        let active = aggregate
            .operations
            .iter()
            .filter(|(_, operation)| {
                operation.claim.is_some()
                    && operation.outcome.is_none()
                    && operation.stale.is_none()
            })
            .collect::<Vec<_>>();
        if active.len() > 1 {
            return Ok(result(
                run_id,
                current_operation_id,
                ProviderDispatchRecoverySupervisorOutcome::Blocked(
                    "multiple_active_recovery_operations",
                ),
            ));
        }
        if let Some((operation_id, operation)) = active.first().copied() {
            let claim = operation.claim.as_ref().ok_or(
                ProviderDispatchRecoverySupervisorError::StateInvariant(
                    "active operation lost its Claim",
                ),
            )?;
            let Some(action) = claim.action_spec.as_ref() else {
                return Ok(result(
                    run_id,
                    current_operation_id,
                    ProviderDispatchRecoverySupervisorOutcome::Waiting(current_gate),
                ));
            };
            if !action.is_persisted_provider_dispatch() {
                return Ok(result(
                    run_id,
                    current_operation_id,
                    ProviderDispatchRecoverySupervisorOutcome::Waiting(current_gate),
                ));
            }
            let dispatch = DispatchEvidence::from_action(action)?;
            let attempt = ProviderAttemptAggregate::recover(
                &EventJournal::open(&self.database_path)?,
                run_id,
                &dispatch.attempt_id,
            )?;
            dispatch.verify_attempt(run_id, &attempt)?;
            if operation.execution.is_none()
                && attempt.state() == ProviderAttemptState::Requested
                && current_gate == OperationalRecoveryGate::AwaitingProviderBinding
            {
                return Ok(result(
                    run_id,
                    operation_id,
                    ProviderDispatchRecoverySupervisorOutcome::Waiting(current_gate),
                ));
            }
            if let Some(execution) = operation.execution.as_ref() {
                if execution.effect_class != OperationalRecoveryEffectClass::ProviderDispatch {
                    return Ok(result(
                        run_id,
                        current_operation_id,
                        ProviderDispatchRecoverySupervisorOutcome::Waiting(current_gate),
                    ));
                }
                return self
                    .drive_started_execution(
                        workspace_id,
                        run_id,
                        operation_id,
                        current_gate,
                        providers,
                        gateway,
                        cancellation_hub,
                        exclusive_lease,
                    )
                    .await;
            }
            if operation_id != current_operation_id {
                let stale = OperationalRecoveryClaimService::new(&self.database_path)
                    .claim_provider_dispatch_ready(
                        claim_request(workspace_id, project_id, run_id, operation_id),
                        bound_providers,
                        exclusive_lease,
                    );
                return match stale {
                    Err(OperationalRecoveryClaimError::OperationMarkedStale { .. }) => Ok(result(
                        run_id,
                        operation_id,
                        ProviderDispatchRecoverySupervisorOutcome::StaleOperationClosed,
                    )),
                    Err(error) => Err(error.into()),
                    Ok(_) => Err(ProviderDispatchRecoverySupervisorError::StateInvariant(
                        "changed Provider dispatch operation unexpectedly remained claimable",
                    )),
                };
            }
            if !exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id) {
                if OffsetDateTime::now_utc()
                    < OffsetDateTime::parse(&claim.lease_expires_at, &Rfc3339)?
                {
                    return Ok(result(
                        run_id,
                        operation_id,
                        ProviderDispatchRecoverySupervisorOutcome::AwaitingClaimExpiry,
                    ));
                }
                OperationalRecoveryClaimService::new(&self.database_path)
                    .transfer_expired_unstarted_claim(
                        OperationalRecoveryTransferRequest {
                            workspace_id: workspace_id.to_owned(),
                            project_id: project_id.to_owned(),
                            run_id: run_id.to_owned(),
                            operation_id: operation_id.to_owned(),
                            previous_claim_id: claim.claim_id.clone(),
                            lease_duration_seconds: DEFAULT_CLAIM_LEASE_SECONDS,
                        },
                        bound_providers,
                        exclusive_lease,
                    )?;
            }
            return self
                .start_and_drive(
                    workspace_id,
                    project_id,
                    run_id,
                    operation_id,
                    bound_providers,
                    providers,
                    gateway,
                    cancellation_hub,
                    exclusive_lease,
                )
                .await;
        }
        if current_gate != OperationalRecoveryGate::ProviderDispatchReady {
            return Ok(result(
                run_id,
                current_operation_id,
                ProviderDispatchRecoverySupervisorOutcome::Waiting(current_gate),
            ));
        }
        OperationalRecoveryClaimService::new(&self.database_path).claim_provider_dispatch_ready(
            claim_request(workspace_id, project_id, run_id, current_operation_id),
            bound_providers,
            exclusive_lease,
        )?;
        self.start_and_drive(
            workspace_id,
            project_id,
            run_id,
            current_operation_id,
            bound_providers,
            providers,
            gateway,
            cancellation_hub,
            exclusive_lease,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn start_and_drive(
        &self,
        workspace_id: &str,
        project_id: &str,
        run_id: &str,
        operation_id: &str,
        bound_providers: &[ProviderRunIdentity],
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        cancellation_hub: &RuntimeCancellationHub,
        exclusive_lease: &Arc<BoundWorkspaceRuntimeLease>,
    ) -> Result<ProviderDispatchRecoverySupervisorRun, ProviderDispatchRecoverySupervisorError>
    {
        let aggregate =
            OperationalRecoveryRepository::open(&self.database_path)?.load(workspace_id, run_id)?;
        let claim = aggregate.operations[operation_id]
            .claim
            .as_ref()
            .ok_or(ProviderDispatchRecoverySupervisorError::StateInvariant(
                "claimed Provider dispatch operation lost its Claim",
            ))?
            .clone();
        let started = OperationalRecoveryClaimService::new(&self.database_path).start_claimed(
            OperationalRecoveryStartRequest {
                workspace_id: workspace_id.to_owned(),
                project_id: project_id.to_owned(),
                run_id: run_id.to_owned(),
                operation_id: operation_id.to_owned(),
                claim_id: claim.claim_id,
                owner_instance_id: claim.owner_instance_id,
                fencing_token: claim.fencing_token,
            },
            bound_providers,
            exclusive_lease,
        )?;
        let execution_id = started.operations[operation_id]
            .execution
            .as_ref()
            .ok_or(ProviderDispatchRecoverySupervisorError::StateInvariant(
                "Provider dispatch start did not persist Execution",
            ))?
            .execution_id
            .clone();
        #[cfg(feature = "runtime-test-failpoints")]
        crate::runtime_test_failpoint::hit("provider_dispatch.execution_started");
        self.execute_as_current_owner(
            workspace_id,
            run_id,
            operation_id,
            execution_id,
            providers,
            gateway,
            cancellation_hub,
            exclusive_lease,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn drive_started_execution(
        &self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        current_gate: OperationalRecoveryGate,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        cancellation_hub: &RuntimeCancellationHub,
        exclusive_lease: &Arc<BoundWorkspaceRuntimeLease>,
    ) -> Result<ProviderDispatchRecoverySupervisorRun, ProviderDispatchRecoverySupervisorError>
    {
        let aggregate =
            OperationalRecoveryRepository::open(&self.database_path)?.load(workspace_id, run_id)?;
        let operation = aggregate.operations.get(operation_id).ok_or(
            ProviderDispatchRecoverySupervisorError::StateInvariant(
                "started Provider dispatch operation disappeared",
            ),
        )?;
        let claim = operation.claim.as_ref().ok_or(
            ProviderDispatchRecoverySupervisorError::StateInvariant(
                "started Provider dispatch lost its Claim",
            ),
        )?;
        let execution = operation.execution.as_ref().ok_or(
            ProviderDispatchRecoverySupervisorError::StateInvariant(
                "started Provider dispatch lost its Execution",
            ),
        )?;
        let action = claim.action_spec.as_ref().ok_or(
            ProviderDispatchRecoverySupervisorError::StateInvariant(
                "started Provider dispatch lost its persisted action",
            ),
        )?;
        let dispatch = DispatchEvidence::from_action(action)?;
        let attempt = ProviderAttemptAggregate::recover(
            &EventJournal::open(&self.database_path)?,
            run_id,
            &dispatch.attempt_id,
        )?;
        dispatch.verify_attempt(run_id, &attempt)?;
        if attempt.state() == ProviderAttemptState::Requested
            && current_gate != OperationalRecoveryGate::ProviderDispatchReady
        {
            return Ok(result(
                run_id,
                operation_id,
                ProviderDispatchRecoverySupervisorOutcome::Waiting(current_gate),
            ));
        }
        let recovery = ProviderDispatchRecoveryRequest {
            workspace_id: workspace_id.to_owned(),
            run_id: run_id.to_owned(),
            operation_id: operation_id.to_owned(),
            execution_id: execution.execution_id.clone(),
        };
        if exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id) {
            return self
                .execute_as_current_owner(
                    workspace_id,
                    run_id,
                    operation_id,
                    execution.execution_id.clone(),
                    providers,
                    gateway,
                    cancellation_hub,
                    exclusive_lease,
                )
                .await;
        }
        let authorization = ProviderDispatchResumeAuthorizationService::new(&self.database_path)
            .authorize(
                ProviderDispatchResumeAuthorizationRequest {
                    workspace_id: workspace_id.to_owned(),
                    run_id: run_id.to_owned(),
                    operation_id: operation_id.to_owned(),
                    execution_id: execution.execution_id.clone(),
                },
                exclusive_lease,
            )?;
        let receipt = ProviderDispatchRecoveryService::new(&self.database_path)
            .resume_authorized(
                ProviderDispatchAuthorizedResumeRequest {
                    recovery,
                    authorization_id: authorization.authorization_id,
                },
                providers,
                gateway,
                cancellation_hub,
                exclusive_lease,
            )
            .await;
        let receipt = match receipt {
            Ok(receipt) => receipt,
            Err(error) if provider_attempt_is_in_flight(&error) => {
                return Ok(result(
                    run_id,
                    operation_id,
                    ProviderDispatchRecoverySupervisorOutcome::AwaitingAttemptOwner,
                ));
            }
            Err(error) => return Err(error.into()),
        };
        let outcome = persist_interruption_before_return(
            &self.database_path,
            workspace_id,
            run_id,
            operation_id,
            receipt,
            exclusive_lease,
        )?;
        Ok(result(run_id, operation_id, outcome))
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_as_current_owner(
        &self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        execution_id: String,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        cancellation_hub: &RuntimeCancellationHub,
        exclusive_lease: &Arc<BoundWorkspaceRuntimeLease>,
    ) -> Result<ProviderDispatchRecoverySupervisorRun, ProviderDispatchRecoverySupervisorError>
    {
        let receipt = ProviderDispatchRecoveryService::new(&self.database_path)
            .execute_requested(
                ProviderDispatchRecoveryRequest {
                    workspace_id: workspace_id.to_owned(),
                    run_id: run_id.to_owned(),
                    operation_id: operation_id.to_owned(),
                    execution_id,
                },
                providers,
                gateway,
                cancellation_hub,
                exclusive_lease,
            )
            .await;
        let receipt = match receipt {
            Ok(receipt) => receipt,
            Err(error) if provider_attempt_is_in_flight(&error) => {
                return Ok(result(
                    run_id,
                    operation_id,
                    ProviderDispatchRecoverySupervisorOutcome::AwaitingAttemptOwner,
                ));
            }
            Err(error) => return Err(error.into()),
        };
        let outcome = persist_interruption_before_return(
            &self.database_path,
            workspace_id,
            run_id,
            operation_id,
            receipt,
            exclusive_lease,
        )?;
        Ok(result(run_id, operation_id, outcome))
    }

    fn scan_consistently(
        &self,
        workspace_id: &str,
        project_id: &str,
        bound_providers: &[ProviderRunIdentity],
    ) -> Result<
        crate::operational_recovery_scanner::OperationalRecoveryReport,
        ProviderDispatchRecoverySupervisorError,
    > {
        let clock = WorkspaceEventJournal::open(&self.database_path)?;
        let before = clock.current_global_sequence()?;
        let assignments = recover_agent_assignments(&self.database_path, workspace_id, project_id)?;
        let mut journal = EventJournal::open(&self.database_path)?;
        let report = OperationalRecoveryScanner::new(&mut journal, &assignments, bound_providers)
            .scan(workspace_id, project_id)?;
        let after = clock.current_global_sequence()?;
        if before != after {
            return Err(
                ProviderDispatchRecoverySupervisorError::SourceChangedDuringScan { before, after },
            );
        }
        Ok(report)
    }
}

fn claim_request(
    workspace_id: &str,
    project_id: &str,
    run_id: &str,
    operation_id: &str,
) -> OperationalRecoveryClaimRequest {
    OperationalRecoveryClaimRequest {
        workspace_id: workspace_id.to_owned(),
        project_id: project_id.to_owned(),
        run_id: run_id.to_owned(),
        expected_operation_id: operation_id.to_owned(),
        lease_duration_seconds: DEFAULT_CLAIM_LEASE_SECONDS,
    }
}

fn result(
    run_id: &str,
    operation_id: &str,
    outcome: ProviderDispatchRecoverySupervisorOutcome,
) -> ProviderDispatchRecoverySupervisorRun {
    ProviderDispatchRecoverySupervisorRun {
        run_id: run_id.to_owned(),
        operation_id: operation_id.to_owned(),
        outcome,
    }
}

fn persist_interruption_before_return(
    database_path: &Path,
    workspace_id: &str,
    run_id: &str,
    operation_id: &str,
    recovery: ProviderDispatchRecoveryResult,
    exclusive_lease: &BoundWorkspaceRuntimeLease,
) -> Result<ProviderDispatchRecoverySupervisorOutcome, ProviderDispatchRecoverySupervisorError> {
    match recovery {
        ProviderDispatchRecoveryResult::Completed(receipt) => Ok(
            ProviderDispatchRecoverySupervisorOutcome::Completed(receipt.terminal),
        ),
        ProviderDispatchRecoveryResult::InterruptedBeforeSent(interrupted) => {
            let recorded_at = timestamp()?;
            OperationalRecoveryRecordingService::new(database_path).record_execution_interruption(
                OperationalRecoveryInterruptionRequest {
                    workspace_id: workspace_id.to_owned(),
                    run_id: run_id.to_owned(),
                    operation_id: operation_id.to_owned(),
                    execution_id: interrupted.execution_id.clone(),
                    attempt_id: interrupted.attempt_id.clone(),
                    cause: interrupted.cause,
                    cancellation_intent_id: interrupted.cancellation_intent_id.clone(),
                    transport_boundary_crossed: interrupted.transport_boundary_crossed,
                    resumable: interrupted.resumable,
                    interrupted_at: recorded_at,
                },
                exclusive_lease,
            )?;
            Ok(ProviderDispatchRecoverySupervisorOutcome::InterruptedBeforeSent(interrupted))
        }
    }
}

fn provider_attempt_is_in_flight(error: &ProviderDispatchRecoveryError) -> bool {
    matches!(
        error,
        ProviderDispatchRecoveryError::Provider(
            ProviderInferenceServiceError::AttemptInFlight { .. }
        ) | ProviderDispatchRecoveryError::CancellationHub(
            RuntimeCancellationHubError::RegistrationAlreadyActive
        )
    )
}

fn require_text(
    field: &'static str,
    value: &str,
) -> Result<(), ProviderDispatchRecoverySupervisorError> {
    if value.trim().is_empty() {
        Err(ProviderDispatchRecoverySupervisorError::EmptyField(field))
    } else {
        Ok(())
    }
}

fn timestamp() -> Result<String, time::error::Format> {
    OffsetDateTime::now_utc().format(&Rfc3339)
}

#[derive(Debug, Error)]
pub enum ProviderDispatchRecoverySupervisorError {
    #[error("Provider dispatch recovery Supervisor field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error(transparent)]
    WorkspaceLease(#[from] BoundWorkspaceRuntimeLeaseError),
    #[error("Provider dispatch recovery source changed during scan: {before} -> {after}")]
    SourceChangedDuringScan { before: u64, after: u64 },
    #[error("Provider dispatch recovery Supervisor invariant failed: {0}")]
    StateInvariant(&'static str),
    #[error(transparent)]
    AssignmentRecovery(#[from] AgentAssignmentRecoveryError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    Scan(#[from] OperationalRecoveryScanError),
    #[error(transparent)]
    Recording(#[from] OperationalRecoveryRecordingError),
    #[error(transparent)]
    Aggregate(#[from] OperationalRecoveryAggregateError),
    #[error(transparent)]
    Claim(#[from] OperationalRecoveryClaimError),
    #[error(transparent)]
    Authorization(#[from] ProviderDispatchResumeAuthorizationError),
    #[error(transparent)]
    Attempt(#[from] ProviderAttemptError),
    #[error(transparent)]
    Dispatch(#[from] ProviderDispatchRecoveryError),
    #[error(transparent)]
    WorkspaceJournal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Time(#[from] time::error::Parse),
    #[error(transparent)]
    TimeFormat(#[from] time::error::Format),
}
