use std::path::{Path, PathBuf};

use novelx_protocol::ProviderRunIdentity;
use thiserror::Error;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    agent_assignment_recovery::{AgentAssignmentRecoveryError, recover_agent_assignments},
    event_journal::{EventJournal, EventJournalError},
    operational_recovery_aggregate::{
        MAX_RECOVERY_CLAIM_LEASE_SECONDS, OPERATIONAL_RECOVERY_POLICY_VERSION,
        OperationalRecoveryAggregate, OperationalRecoveryAggregateError, OperationalRecoveryClaim,
        OperationalRecoveryEffectClass, OperationalRecoveryEventMetadata,
        OperationalRecoveryExecution, OperationalRecoveryObservation,
        OperationalRecoveryObservedGate, OperationalRecoveryRepository, OperationalRecoveryStale,
        OperationalRecoverySubject,
    },
    operational_recovery_scanner::{
        OperationalRecoveryAction, OperationalRecoveryGate, OperationalRecoveryRun,
        OperationalRecoveryScanError, OperationalRecoveryScanner,
    },
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
    workspace_runtime_lease::{BoundWorkspaceRuntimeLease, BoundWorkspaceRuntimeLeaseError},
};

pub const OPERATIONAL_RECOVERY_EXECUTOR_VERSION: &str = "runtime-v2-local-projection-v1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryClaimRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub run_id: String,
    pub expected_operation_id: String,
    pub lease_duration_seconds: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryStartRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub run_id: String,
    pub operation_id: String,
    pub claim_id: String,
    pub owner_instance_id: String,
    pub fencing_token: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryTransferRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub run_id: String,
    pub operation_id: String,
    pub previous_claim_id: String,
    pub lease_duration_seconds: u64,
}

pub struct OperationalRecoveryClaimService {
    database_path: PathBuf,
}

impl OperationalRecoveryClaimService {
    pub fn new(database_path: impl AsRef<Path>) -> Self {
        Self {
            database_path: database_path.as_ref().to_owned(),
        }
    }

    pub fn claim_ready(
        &self,
        request: OperationalRecoveryClaimRequest,
        bound_providers: &[ProviderRunIdentity],
        exclusive_lease: &BoundWorkspaceRuntimeLease,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryClaimError> {
        self.claim_for_gate(
            request,
            bound_providers,
            exclusive_lease,
            OperationalRecoveryGate::RecoveryReady,
        )
    }

    pub fn claim_provider_dispatch_ready(
        &self,
        request: OperationalRecoveryClaimRequest,
        bound_providers: &[ProviderRunIdentity],
        exclusive_lease: &BoundWorkspaceRuntimeLease,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryClaimError> {
        self.claim_for_gate(
            request,
            bound_providers,
            exclusive_lease,
            OperationalRecoveryGate::ProviderDispatchReady,
        )
    }

    fn claim_for_gate(
        &self,
        request: OperationalRecoveryClaimRequest,
        bound_providers: &[ProviderRunIdentity],
        exclusive_lease: &BoundWorkspaceRuntimeLease,
        expected_gate: OperationalRecoveryGate,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryClaimError> {
        exclusive_lease.verify_database_authority(&self.database_path)?;
        validate_lease_duration(request.lease_duration_seconds)?;
        let claimed = OffsetDateTime::now_utc();
        let lease_seconds = i64::try_from(request.lease_duration_seconds)
            .map_err(|_| OperationalRecoveryClaimError::LeaseDurationInvalid)?;
        let claimed_at = claimed.format(&Rfc3339)?;
        let lease_expires_at = (claimed + Duration::seconds(lease_seconds)).format(&Rfc3339)?;
        let (run, after) = self.scan_run(
            &request.workspace_id,
            &request.project_id,
            &request.run_id,
            bound_providers,
        )?;
        let action_spec = run.action.clone();
        let action_spec_sha256 = action_spec.action_spec_sha256()?;
        let subject = OperationalRecoverySubject {
            workspace_id: request.workspace_id.clone(),
            project_id: request.project_id.clone(),
            run_id: request.run_id.clone(),
            policy_version: OPERATIONAL_RECOVERY_POLICY_VERSION.to_owned(),
        };
        let observation = self.ensure_current_operation(
            &subject,
            &request.expected_operation_id,
            run,
            after,
            exclusive_lease,
            std::slice::from_ref(&expected_gate),
        )?;
        let claim = OperationalRecoveryClaim::derive(
            observation.operation_id.clone(),
            exclusive_lease.owner_id().to_owned(),
            1,
            observation.source_fingerprint.clone(),
            claimed_at.clone(),
            lease_expires_at,
            OPERATIONAL_RECOVERY_EXECUTOR_VERSION.to_owned(),
            Some(action_spec),
            action_spec_sha256,
        )?;
        let mut repository = OperationalRecoveryRepository::open(&self.database_path)?;
        let persisted = repository.load(&request.workspace_id, &request.run_id)?;
        if persisted
            .operations
            .get(&observation.operation_id)
            .is_none_or(|operation| operation.observation != observation)
        {
            return Err(OperationalRecoveryClaimError::ObservationMissing);
        }
        repository
            .claim(
                &request.workspace_id,
                &request.run_id,
                claim,
                exclusive_lease,
                after,
                OperationalRecoveryEventMetadata {
                    created_at: claimed_at,
                },
            )
            .map_err(Into::into)
    }

    pub fn start_claimed(
        &self,
        request: OperationalRecoveryStartRequest,
        bound_providers: &[ProviderRunIdentity],
        exclusive_lease: &BoundWorkspaceRuntimeLease,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryClaimError> {
        exclusive_lease.verify_database_authority(&self.database_path)?;
        let (run, after) = self.scan_run(
            &request.workspace_id,
            &request.project_id,
            &request.run_id,
            bound_providers,
        )?;
        let action_spec_sha256 = run.action.action_spec_sha256()?;
        let effect_class = effect_class_for_action(&run.action)?;
        let subject = OperationalRecoverySubject {
            workspace_id: request.workspace_id.clone(),
            project_id: request.project_id.clone(),
            run_id: request.run_id.clone(),
            policy_version: OPERATIONAL_RECOVERY_POLICY_VERSION.to_owned(),
        };
        let observation = self.ensure_current_operation(
            &subject,
            &request.operation_id,
            run,
            after,
            exclusive_lease,
            &[
                OperationalRecoveryGate::RecoveryReady,
                OperationalRecoveryGate::ProviderDispatchReady,
            ],
        )?;
        let mut repository = OperationalRecoveryRepository::open(&self.database_path)?;
        let aggregate = repository.load(&request.workspace_id, &request.run_id)?;
        let operation = aggregate
            .operations
            .get(&observation.operation_id)
            .ok_or(OperationalRecoveryClaimError::ObservationMissing)?;
        let claim = operation
            .claim
            .as_ref()
            .ok_or(OperationalRecoveryClaimError::ClaimMissing)?;
        if claim.claim_id != request.claim_id
            || claim.owner_instance_id != request.owner_instance_id
            || claim.fencing_token != request.fencing_token
        {
            return Err(OperationalRecoveryClaimError::FenceMismatch);
        }
        if !exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id) {
            return Err(OperationalRecoveryClaimError::ExclusiveOwnerMismatch);
        }
        if claim.executor_version != OPERATIONAL_RECOVERY_EXECUTOR_VERSION
            || claim.action_spec_sha256 != action_spec_sha256
        {
            return Err(OperationalRecoveryClaimError::ActionFenceMismatch);
        }
        let started_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let execution =
            OperationalRecoveryExecution::derive(claim, effect_class, started_at.clone())?;
        repository
            .start_execution(
                &request.workspace_id,
                &request.run_id,
                &observation.operation_id,
                execution,
                exclusive_lease,
                after,
                OperationalRecoveryEventMetadata {
                    created_at: started_at,
                },
            )
            .map_err(Into::into)
    }

    pub fn transfer_expired_unstarted_claim(
        &self,
        request: OperationalRecoveryTransferRequest,
        bound_providers: &[ProviderRunIdentity],
        exclusive_lease: &BoundWorkspaceRuntimeLease,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryClaimError> {
        exclusive_lease.verify_database_authority(&self.database_path)?;
        validate_lease_duration(request.lease_duration_seconds)?;
        let (run, after) = self.scan_run(
            &request.workspace_id,
            &request.project_id,
            &request.run_id,
            bound_providers,
        )?;
        let subject = OperationalRecoverySubject {
            workspace_id: request.workspace_id.clone(),
            project_id: request.project_id.clone(),
            run_id: request.run_id.clone(),
            policy_version: OPERATIONAL_RECOVERY_POLICY_VERSION.to_owned(),
        };
        let observation = self.ensure_current_operation(
            &subject,
            &request.operation_id,
            run,
            after,
            exclusive_lease,
            &[
                OperationalRecoveryGate::RecoveryReady,
                OperationalRecoveryGate::ProviderDispatchReady,
            ],
        )?;
        let mut repository = OperationalRecoveryRepository::open(&self.database_path)?;
        let aggregate = repository.load(&request.workspace_id, &request.run_id)?;
        let previous = aggregate.operations[&observation.operation_id]
            .claim
            .as_ref()
            .ok_or(OperationalRecoveryClaimError::ClaimMissing)?;
        let claimed = OffsetDateTime::now_utc();
        let claimed_at = claimed.format(&Rfc3339)?;
        let lease_seconds = i64::try_from(request.lease_duration_seconds)
            .map_err(|_| OperationalRecoveryClaimError::LeaseDurationInvalid)?;
        let claim = OperationalRecoveryClaim::derive(
            observation.operation_id.clone(),
            exclusive_lease.owner_id().to_owned(),
            previous
                .fencing_token
                .checked_add(1)
                .ok_or(OperationalRecoveryAggregateError::FencingTokenInvalid)?,
            observation.source_fingerprint,
            claimed_at.clone(),
            (claimed + Duration::seconds(lease_seconds)).format(&Rfc3339)?,
            previous.executor_version.clone(),
            previous.action_spec.clone(),
            previous.action_spec_sha256.clone(),
        )?;
        repository
            .transfer_claim(
                &request.workspace_id,
                &request.run_id,
                &observation.operation_id,
                &request.previous_claim_id,
                claim,
                exclusive_lease,
                after,
                OperationalRecoveryEventMetadata {
                    created_at: claimed_at,
                },
            )
            .map_err(Into::into)
    }

    fn ensure_current_operation(
        &self,
        subject: &OperationalRecoverySubject,
        expected_operation_id: &str,
        run: OperationalRecoveryRun,
        scan_global_sequence: u64,
        exclusive_lease: &BoundWorkspaceRuntimeLease,
        claimable_gates: &[OperationalRecoveryGate],
    ) -> Result<OperationalRecoveryObservation, OperationalRecoveryClaimError> {
        let actual = OperationalRecoveryObservation::derive(
            subject,
            run.source_fingerprint,
            observed_gate(run.gate),
            run.reasons,
        )?;
        if actual.operation_id == expected_operation_id {
            return if claimable_gates.contains(&run.gate) {
                Ok(actual)
            } else {
                Err(OperationalRecoveryClaimError::RunNotReady { gate: run.gate })
            };
        }
        let mut repository = OperationalRecoveryRepository::open(&self.database_path)?;
        let aggregate = repository.load(&subject.workspace_id, &subject.run_id)?;
        let expected = aggregate
            .operations
            .get(expected_operation_id)
            .ok_or_else(|| OperationalRecoveryClaimError::OperationStale {
                expected: expected_operation_id.to_owned(),
                actual: actual.operation_id.clone(),
            })?;
        if let Some(stale) = &expected.stale {
            return if stale.actual_operation_id == actual.operation_id
                && stale.actual_source_fingerprint == actual.source_fingerprint
            {
                Err(OperationalRecoveryClaimError::OperationMarkedStale {
                    expected: expected_operation_id.to_owned(),
                    actual: actual.operation_id,
                })
            } else {
                Err(OperationalRecoveryClaimError::Aggregate(
                    OperationalRecoveryAggregateError::OperationTerminal,
                ))
            };
        }
        let (current_claim_id, current_fencing_token) =
            expected.claim.as_ref().map_or((None, None), |claim| {
                (Some(claim.claim_id.clone()), Some(claim.fencing_token))
            });
        let detected_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let stale = OperationalRecoveryStale::derive(
            expected.observation.operation_id.clone(),
            expected.observation.source_fingerprint.clone(),
            actual.operation_id.clone(),
            actual.source_fingerprint,
            current_claim_id,
            current_fencing_token,
            exclusive_lease.owner_id().to_owned(),
            detected_at.clone(),
            scan_global_sequence,
        )?;
        repository.mark_stale(
            &subject.workspace_id,
            &subject.run_id,
            expected_operation_id,
            stale,
            exclusive_lease,
            scan_global_sequence,
            OperationalRecoveryEventMetadata {
                created_at: detected_at,
            },
        )?;
        Err(OperationalRecoveryClaimError::OperationMarkedStale {
            expected: expected_operation_id.to_owned(),
            actual: actual.operation_id,
        })
    }

    fn scan_run(
        &self,
        workspace_id: &str,
        project_id: &str,
        run_id: &str,
        bound_providers: &[ProviderRunIdentity],
    ) -> Result<(OperationalRecoveryRun, u64), OperationalRecoveryClaimError> {
        let clock = WorkspaceEventJournal::open(&self.database_path)?;
        let before = clock.current_global_sequence()?;
        let assignments = recover_agent_assignments(&self.database_path, workspace_id, project_id)?;
        let mut runtime_journal = EventJournal::open(&self.database_path)?;
        let report =
            OperationalRecoveryScanner::new(&mut runtime_journal, &assignments, bound_providers)
                .scan(workspace_id, project_id)?;
        let after = clock.current_global_sequence()?;
        if before != after {
            return Err(OperationalRecoveryClaimError::SourceChangedDuringScan { before, after });
        }
        let run = report
            .runs
            .into_iter()
            .find(|run| run.run_id == run_id)
            .ok_or(OperationalRecoveryClaimError::RunNotFound)?;
        Ok((run, after))
    }
}

fn effect_class_for_action(
    action: &OperationalRecoveryAction,
) -> Result<OperationalRecoveryEffectClass, OperationalRecoveryClaimError> {
    match action {
        OperationalRecoveryAction::PersistedProviderResultProjection { .. } => {
            Ok(OperationalRecoveryEffectClass::PersistedProviderResultProjection)
        }
        OperationalRecoveryAction::PersistedProviderAttemptDispatch { .. } => {
            Ok(OperationalRecoveryEffectClass::ProviderDispatch)
        }
        _ => Err(OperationalRecoveryClaimError::ActionNotLocallyExecutable),
    }
}

fn observed_gate(value: OperationalRecoveryGate) -> OperationalRecoveryObservedGate {
    match value {
        OperationalRecoveryGate::AwaitingProviderBinding => {
            OperationalRecoveryObservedGate::AwaitingProviderBinding
        }
        OperationalRecoveryGate::WaitingForApproval => {
            OperationalRecoveryObservedGate::WaitingForApproval
        }
        OperationalRecoveryGate::WaitingForReconciliation => {
            OperationalRecoveryObservedGate::WaitingForReconciliation
        }
        OperationalRecoveryGate::WaitingForExplicitExecution => {
            OperationalRecoveryObservedGate::WaitingForExplicitExecution
        }
        OperationalRecoveryGate::RecoveryReady => OperationalRecoveryObservedGate::RecoveryReady,
        OperationalRecoveryGate::ProviderDispatchReady => {
            OperationalRecoveryObservedGate::ProviderDispatchReady
        }
        OperationalRecoveryGate::Quarantined => OperationalRecoveryObservedGate::Quarantined,
        OperationalRecoveryGate::TerminalProjectionOnly => {
            OperationalRecoveryObservedGate::TerminalProjectionOnly
        }
    }
}

fn validate_lease_duration(value: u64) -> Result<(), OperationalRecoveryClaimError> {
    if value == 0 || value > MAX_RECOVERY_CLAIM_LEASE_SECONDS {
        Err(OperationalRecoveryClaimError::LeaseDurationInvalid)
    } else {
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum OperationalRecoveryClaimError {
    #[error("operational recovery source changed during scan: {before} -> {after}")]
    SourceChangedDuringScan { before: u64, after: u64 },
    #[error("operational recovery run was not found")]
    RunNotFound,
    #[error("operational recovery run is not ready: {gate:?}")]
    RunNotReady { gate: OperationalRecoveryGate },
    #[error("operational recovery operation is stale: expected {expected}, actual {actual}")]
    OperationStale { expected: String, actual: String },
    #[error(
        "operational recovery operation was persistently marked stale: expected {expected}, actual {actual}"
    )]
    OperationMarkedStale { expected: String, actual: String },
    #[error("operational recovery observation must be recorded before claim")]
    ObservationMissing,
    #[error("operational recovery claim must be persisted before execution")]
    ClaimMissing,
    #[error("operational recovery claim fencing identity does not match")]
    FenceMismatch,
    #[error("operational recovery action or executor fence does not match the current scan")]
    ActionFenceMismatch,
    #[error("operational recovery action is not a local-only executable projection")]
    ActionNotLocallyExecutable,
    #[error(transparent)]
    WorkspaceLease(#[from] BoundWorkspaceRuntimeLeaseError),
    #[error("operational recovery claim owner is not the exclusive workspace runtime owner")]
    ExclusiveOwnerMismatch,
    #[error("operational recovery lease duration is outside the server policy")]
    LeaseDurationInvalid,
    #[error(transparent)]
    AssignmentRecovery(#[from] AgentAssignmentRecoveryError),
    #[error(transparent)]
    RuntimeJournal(#[from] EventJournalError),
    #[error(transparent)]
    WorkspaceJournal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Scan(#[from] OperationalRecoveryScanError),
    #[error(transparent)]
    ActionJson(#[from] serde_json::Error),
    #[error(transparent)]
    Aggregate(#[from] OperationalRecoveryAggregateError),
    #[error(transparent)]
    TimeFormat(#[from] time::error::Format),
}
