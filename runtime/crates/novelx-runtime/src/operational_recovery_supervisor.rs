use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use novelx_protocol::ProviderRunIdentity;
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    agent_assignment_recovery::{AgentAssignmentRecoveryError, recover_agent_assignments},
    event_journal::{EventJournal, EventJournalError},
    operational_recovery_aggregate::{
        OperationalRecoveryAggregateError, OperationalRecoveryEffectClass,
        OperationalRecoveryEventMetadata, OperationalRecoveryRepository, OperationalRecoveryResume,
    },
    operational_recovery_claim_service::{
        OperationalRecoveryClaimError, OperationalRecoveryClaimRequest,
        OperationalRecoveryClaimService, OperationalRecoveryStartRequest,
        OperationalRecoveryTransferRequest,
    },
    operational_recovery_completion_service::{
        OperationalRecoveryCompletionError, OperationalRecoveryCompletionRequest,
        OperationalRecoveryCompletionService,
    },
    operational_recovery_projection_service::{
        OperationalRecoveryProjectionError, OperationalRecoveryProjectionService,
        PersistedProviderProjectionRequest,
    },
    operational_recovery_recording_service::{
        OperationalRecoveryRecordingError, OperationalRecoveryRecordingService,
    },
    operational_recovery_scanner::{
        OperationalRecoveryGate, OperationalRecoveryScanError, OperationalRecoveryScanner,
    },
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
    workspace_runtime_lease::WorkspaceRuntimeLease,
};

const DEFAULT_CLAIM_LEASE_SECONDS: u64 = 60;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoverySupervisorReport {
    pub runs: Vec<OperationalRecoverySupervisorRun>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoverySupervisorRun {
    pub run_id: String,
    pub operation_id: String,
    pub outcome: OperationalRecoverySupervisorOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OperationalRecoverySupervisorOutcome {
    CompletedLocalProjection,
    StaleOperationClosed,
    AwaitingClaimExpiry,
    Waiting(OperationalRecoveryGate),
    Blocked(&'static str),
}

pub struct OperationalRecoverySupervisor {
    database_path: PathBuf,
}

impl OperationalRecoverySupervisor {
    pub fn new(database_path: impl AsRef<Path>) -> Self {
        Self {
            database_path: database_path.as_ref().to_owned(),
        }
    }

    pub fn run_local_recovery_pass(
        &self,
        workspace_id: &str,
        project_id: &str,
        bound_providers: &[ProviderRunIdentity],
        exclusive_lease: &WorkspaceRuntimeLease,
    ) -> Result<OperationalRecoverySupervisorReport, OperationalRecoverySupervisorError> {
        require_text("workspace_id", workspace_id)?;
        require_text("project_id", project_id)?;
        if !exclusive_lease.protects_database(&self.database_path) {
            return Err(OperationalRecoverySupervisorError::WorkspaceLeaseMismatch);
        }
        let report = self.scan_consistently(workspace_id, project_id, bound_providers)?;
        let created_at = timestamp()?;
        let recorded = OperationalRecoveryRecordingService::new(&self.database_path).record(
            workspace_id,
            project_id,
            &report,
            &created_at,
        )?;
        let operation_by_run = recorded
            .into_iter()
            .map(|item| (item.run_id, item.operation_id))
            .collect::<BTreeMap<_, _>>();
        let mut results = Vec::with_capacity(report.runs.len());
        for run in report.runs {
            let current_operation_id = operation_by_run
                .get(&run.run_id)
                .ok_or(OperationalRecoverySupervisorError::StateInvariant(
                    "recording omitted a scanned run",
                ))?
                .clone();
            results.push(self.drive_run(
                workspace_id,
                project_id,
                bound_providers,
                exclusive_lease,
                &run.run_id,
                &current_operation_id,
                run.gate,
            )?);
        }
        results.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        Ok(OperationalRecoverySupervisorReport { runs: results })
    }

    #[allow(clippy::too_many_arguments)]
    fn drive_run(
        &self,
        workspace_id: &str,
        project_id: &str,
        bound_providers: &[ProviderRunIdentity],
        exclusive_lease: &WorkspaceRuntimeLease,
        run_id: &str,
        current_operation_id: &str,
        current_gate: OperationalRecoveryGate,
    ) -> Result<OperationalRecoverySupervisorRun, OperationalRecoverySupervisorError> {
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
            return Ok(supervisor_result(
                run_id,
                current_operation_id,
                OperationalRecoverySupervisorOutcome::Blocked(
                    "multiple_active_recovery_operations",
                ),
            ));
        }
        if let Some((operation_id, operation)) = active.first().copied() {
            if operation.execution.is_some() {
                return self.drive_started_execution(
                    workspace_id,
                    run_id,
                    operation_id,
                    current_gate,
                    exclusive_lease,
                );
            }
            if operation_id != current_operation_id {
                let result = OperationalRecoveryClaimService::new(&self.database_path).claim_ready(
                    OperationalRecoveryClaimRequest {
                        workspace_id: workspace_id.to_owned(),
                        project_id: project_id.to_owned(),
                        run_id: run_id.to_owned(),
                        expected_operation_id: operation_id.to_string(),
                        lease_duration_seconds: DEFAULT_CLAIM_LEASE_SECONDS,
                    },
                    bound_providers,
                    exclusive_lease,
                );
                return match result {
                    Err(OperationalRecoveryClaimError::OperationMarkedStale { .. }) => {
                        Ok(supervisor_result(
                            run_id,
                            operation_id,
                            OperationalRecoverySupervisorOutcome::StaleOperationClosed,
                        ))
                    }
                    Err(error) => Err(error.into()),
                    Ok(_) => Err(OperationalRecoverySupervisorError::StateInvariant(
                        "changed operation unexpectedly remained claimable",
                    )),
                };
            }
            let claim = operation.claim.as_ref().ok_or(
                OperationalRecoverySupervisorError::StateInvariant(
                    "active operation lost its Claim",
                ),
            )?;
            if !exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id) {
                if OffsetDateTime::now_utc()
                    < OffsetDateTime::parse(&claim.lease_expires_at, &Rfc3339)?
                {
                    return Ok(supervisor_result(
                        run_id,
                        operation_id,
                        OperationalRecoverySupervisorOutcome::AwaitingClaimExpiry,
                    ));
                }
                OperationalRecoveryClaimService::new(&self.database_path)
                    .transfer_expired_unstarted_claim(
                        OperationalRecoveryTransferRequest {
                            workspace_id: workspace_id.to_owned(),
                            project_id: project_id.to_owned(),
                            run_id: run_id.to_owned(),
                            operation_id: operation_id.to_string(),
                            previous_claim_id: claim.claim_id.clone(),
                            lease_duration_seconds: DEFAULT_CLAIM_LEASE_SECONDS,
                        },
                        bound_providers,
                        exclusive_lease,
                    )?;
            }
            return self.start_and_drive(
                workspace_id,
                project_id,
                run_id,
                operation_id,
                bound_providers,
                exclusive_lease,
            );
        }
        if current_gate != OperationalRecoveryGate::RecoveryReady {
            return Ok(supervisor_result(
                run_id,
                current_operation_id,
                OperationalRecoverySupervisorOutcome::Waiting(current_gate),
            ));
        }
        OperationalRecoveryClaimService::new(&self.database_path).claim_ready(
            OperationalRecoveryClaimRequest {
                workspace_id: workspace_id.to_owned(),
                project_id: project_id.to_owned(),
                run_id: run_id.to_owned(),
                expected_operation_id: current_operation_id.to_owned(),
                lease_duration_seconds: DEFAULT_CLAIM_LEASE_SECONDS,
            },
            bound_providers,
            exclusive_lease,
        )?;
        self.start_and_drive(
            workspace_id,
            project_id,
            run_id,
            current_operation_id,
            bound_providers,
            exclusive_lease,
        )
    }

    fn start_and_drive(
        &self,
        workspace_id: &str,
        project_id: &str,
        run_id: &str,
        operation_id: &str,
        bound_providers: &[ProviderRunIdentity],
        exclusive_lease: &WorkspaceRuntimeLease,
    ) -> Result<OperationalRecoverySupervisorRun, OperationalRecoverySupervisorError> {
        let aggregate =
            OperationalRecoveryRepository::open(&self.database_path)?.load(workspace_id, run_id)?;
        let operation = aggregate.operations.get(operation_id).ok_or(
            OperationalRecoverySupervisorError::StateInvariant(
                "claimed operation disappeared before start",
            ),
        )?;
        let claim =
            operation
                .claim
                .as_ref()
                .ok_or(OperationalRecoverySupervisorError::StateInvariant(
                    "claimed operation lost its Claim",
                ))?;
        let started = OperationalRecoveryClaimService::new(&self.database_path).start_claimed(
            OperationalRecoveryStartRequest {
                workspace_id: workspace_id.to_owned(),
                project_id: project_id.to_owned(),
                run_id: run_id.to_owned(),
                operation_id: operation_id.to_owned(),
                claim_id: claim.claim_id.clone(),
                owner_instance_id: claim.owner_instance_id.clone(),
                fencing_token: claim.fencing_token,
            },
            bound_providers,
            exclusive_lease,
        )?;
        let execution_id = started.operations[operation_id]
            .execution
            .as_ref()
            .ok_or(OperationalRecoverySupervisorError::StateInvariant(
                "start did not persist execution",
            ))?
            .execution_id
            .clone();
        self.project_and_finish(
            workspace_id,
            run_id,
            operation_id,
            execution_id,
            exclusive_lease,
            false,
        )
    }

    fn drive_started_execution(
        &self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        current_gate: OperationalRecoveryGate,
        exclusive_lease: &WorkspaceRuntimeLease,
    ) -> Result<OperationalRecoverySupervisorRun, OperationalRecoverySupervisorError> {
        let mut repository = OperationalRecoveryRepository::open(&self.database_path)?;
        let aggregate = repository.load(workspace_id, run_id)?;
        let operation = aggregate.operations.get(operation_id).ok_or(
            OperationalRecoverySupervisorError::StateInvariant(
                "active execution operation disappeared",
            ),
        )?;
        let claim =
            operation
                .claim
                .as_ref()
                .ok_or(OperationalRecoverySupervisorError::StateInvariant(
                    "active execution lost its Claim",
                ))?;
        let execution = operation.execution.as_ref().ok_or(
            OperationalRecoverySupervisorError::StateInvariant("active execution disappeared"),
        )?;
        if execution.effect_class
            != OperationalRecoveryEffectClass::PersistedProviderResultProjection
        {
            return Ok(supervisor_result(
                run_id,
                operation_id,
                OperationalRecoverySupervisorOutcome::Waiting(current_gate),
            ));
        }
        if claim.action_spec.is_none() {
            return Ok(supervisor_result(
                run_id,
                operation_id,
                OperationalRecoverySupervisorOutcome::Blocked("legacy_action_spec_missing"),
            ));
        }
        let resuming = !exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id);
        if resuming {
            let already_authorized = operation.resumes.last().is_some_and(|resume| {
                resume.execution_id == execution.execution_id
                    && exclusive_lease.proves_exclusive_owner(&resume.resumer_instance_id)
            });
            if !already_authorized {
                let resumed_at = timestamp()?;
                let resume = OperationalRecoveryResume::derive(
                    execution,
                    exclusive_lease.instance_id().to_owned(),
                    resumed_at.clone(),
                )?;
                let clock =
                    WorkspaceEventJournal::open(&self.database_path)?.current_global_sequence()?;
                repository.authorize_local_execution_resume(
                    workspace_id,
                    run_id,
                    operation_id,
                    resume,
                    exclusive_lease,
                    clock,
                    OperationalRecoveryEventMetadata {
                        created_at: resumed_at,
                    },
                )?;
            }
        }
        self.project_and_finish(
            workspace_id,
            run_id,
            operation_id,
            execution.execution_id.clone(),
            exclusive_lease,
            resuming,
        )
    }

    fn project_and_finish(
        &self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        execution_id: String,
        exclusive_lease: &WorkspaceRuntimeLease,
        resuming: bool,
    ) -> Result<OperationalRecoverySupervisorRun, OperationalRecoverySupervisorError> {
        let request = PersistedProviderProjectionRequest {
            workspace_id: workspace_id.to_owned(),
            run_id: run_id.to_owned(),
            operation_id: operation_id.to_owned(),
            execution_id: execution_id.clone(),
        };
        let projection = OperationalRecoveryProjectionService::new(&self.database_path);
        let manifest = if resuming {
            projection.resume_started_persisted_provider_result(request, exclusive_lease)?
        } else {
            projection.project_persisted_provider_result(request, exclusive_lease)?
        };
        OperationalRecoveryCompletionService::new(&self.database_path)
            .finish_persisted_provider_projection(
                OperationalRecoveryCompletionRequest {
                    workspace_id: workspace_id.to_owned(),
                    run_id: run_id.to_owned(),
                    operation_id: operation_id.to_owned(),
                    execution_id,
                },
                &manifest,
                exclusive_lease,
            )?;
        Ok(supervisor_result(
            run_id,
            operation_id,
            OperationalRecoverySupervisorOutcome::CompletedLocalProjection,
        ))
    }

    fn scan_consistently(
        &self,
        workspace_id: &str,
        project_id: &str,
        bound_providers: &[ProviderRunIdentity],
    ) -> Result<
        crate::operational_recovery_scanner::OperationalRecoveryReport,
        OperationalRecoverySupervisorError,
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
                OperationalRecoverySupervisorError::SourceChangedDuringScan { before, after },
            );
        }
        Ok(report)
    }
}

fn supervisor_result(
    run_id: &str,
    operation_id: &str,
    outcome: OperationalRecoverySupervisorOutcome,
) -> OperationalRecoverySupervisorRun {
    OperationalRecoverySupervisorRun {
        run_id: run_id.to_owned(),
        operation_id: operation_id.to_owned(),
        outcome,
    }
}

fn timestamp() -> Result<String, time::error::Format> {
    OffsetDateTime::now_utc().format(&Rfc3339)
}

fn require_text(
    field: &'static str,
    value: &str,
) -> Result<(), OperationalRecoverySupervisorError> {
    if value.trim().is_empty() {
        Err(OperationalRecoverySupervisorError::EmptyField(field))
    } else {
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum OperationalRecoverySupervisorError {
    #[error("operational recovery supervisor field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("operational recovery workspace lease does not protect this database")]
    WorkspaceLeaseMismatch,
    #[error("operational recovery source changed during scan: {before} -> {after}")]
    SourceChangedDuringScan { before: u64, after: u64 },
    #[error("operational recovery supervisor state invariant failed: {0}")]
    StateInvariant(&'static str),
    #[error(transparent)]
    AssignmentRecovery(#[from] AgentAssignmentRecoveryError),
    #[error(transparent)]
    RuntimeJournal(#[from] EventJournalError),
    #[error(transparent)]
    WorkspaceJournal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Scan(#[from] OperationalRecoveryScanError),
    #[error(transparent)]
    Recording(#[from] OperationalRecoveryRecordingError),
    #[error(transparent)]
    Claim(#[from] OperationalRecoveryClaimError),
    #[error(transparent)]
    Projection(#[from] OperationalRecoveryProjectionError),
    #[error(transparent)]
    Completion(#[from] OperationalRecoveryCompletionError),
    #[error(transparent)]
    Aggregate(#[from] OperationalRecoveryAggregateError),
    #[error(transparent)]
    TimeParse(#[from] time::error::Parse),
    #[error(transparent)]
    TimeFormat(#[from] time::error::Format),
}
