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
        OperationalRecoveryObservedGate, OperationalRecoveryRepository, OperationalRecoverySubject,
    },
    operational_recovery_scanner::{
        OperationalRecoveryGate, OperationalRecoveryScanError, OperationalRecoveryScanner,
    },
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
    workspace_runtime_lease::WorkspaceRuntimeLease,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryClaimRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub run_id: String,
    pub expected_operation_id: String,
    pub lease_duration_seconds: u64,
    pub executor_version: String,
    pub action_spec_sha256: String,
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
    pub effect_class: OperationalRecoveryEffectClass,
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
        exclusive_lease: &WorkspaceRuntimeLease,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryClaimError> {
        if !exclusive_lease.protects_database(&self.database_path) {
            return Err(OperationalRecoveryClaimError::WorkspaceLeaseMismatch);
        }
        validate_lease_duration(request.lease_duration_seconds)?;
        let claimed = OffsetDateTime::now_utc();
        let lease_seconds = i64::try_from(request.lease_duration_seconds)
            .map_err(|_| OperationalRecoveryClaimError::LeaseDurationInvalid)?;
        let claimed_at = claimed.format(&Rfc3339)?;
        let lease_expires_at = (claimed + Duration::seconds(lease_seconds)).format(&Rfc3339)?;
        let (run, after) = self.scan_ready(
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
        let observation = OperationalRecoveryObservation::derive(
            &subject,
            run.source_fingerprint.clone(),
            OperationalRecoveryObservedGate::RecoveryReady,
            run.reasons,
        )?;
        if observation.operation_id != request.expected_operation_id {
            return Err(OperationalRecoveryClaimError::OperationStale {
                expected: request.expected_operation_id,
                actual: observation.operation_id,
            });
        }
        let claim = OperationalRecoveryClaim::derive(
            observation.operation_id.clone(),
            exclusive_lease.instance_id().to_owned(),
            1,
            observation.source_fingerprint.clone(),
            claimed_at.clone(),
            lease_expires_at,
            request.executor_version,
            request.action_spec_sha256,
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
        exclusive_lease: &WorkspaceRuntimeLease,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryClaimError> {
        if !exclusive_lease.protects_database(&self.database_path) {
            return Err(OperationalRecoveryClaimError::WorkspaceLeaseMismatch);
        }
        let (run, after) = self.scan_ready(
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
        let observation = OperationalRecoveryObservation::derive(
            &subject,
            run.source_fingerprint,
            OperationalRecoveryObservedGate::RecoveryReady,
            run.reasons,
        )?;
        if observation.operation_id != request.operation_id {
            return Err(OperationalRecoveryClaimError::OperationStale {
                expected: request.operation_id,
                actual: observation.operation_id,
            });
        }
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
        let started_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let execution =
            OperationalRecoveryExecution::derive(claim, request.effect_class, started_at.clone())?;
        repository
            .start_execution(
                &request.workspace_id,
                &request.run_id,
                &observation.operation_id,
                execution,
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
        exclusive_lease: &WorkspaceRuntimeLease,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryClaimError> {
        if !exclusive_lease.protects_database(&self.database_path) {
            return Err(OperationalRecoveryClaimError::WorkspaceLeaseMismatch);
        }
        validate_lease_duration(request.lease_duration_seconds)?;
        let (run, after) = self.scan_ready(
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
        let observation = OperationalRecoveryObservation::derive(
            &subject,
            run.source_fingerprint,
            OperationalRecoveryObservedGate::RecoveryReady,
            run.reasons,
        )?;
        if observation.operation_id != request.operation_id {
            return Err(OperationalRecoveryClaimError::OperationStale {
                expected: request.operation_id,
                actual: observation.operation_id,
            });
        }
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
            exclusive_lease.instance_id().to_owned(),
            previous
                .fencing_token
                .checked_add(1)
                .ok_or(OperationalRecoveryAggregateError::FencingTokenInvalid)?,
            observation.source_fingerprint,
            claimed_at.clone(),
            (claimed + Duration::seconds(lease_seconds)).format(&Rfc3339)?,
            previous.executor_version.clone(),
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

    fn scan_ready(
        &self,
        workspace_id: &str,
        project_id: &str,
        run_id: &str,
        bound_providers: &[ProviderRunIdentity],
    ) -> Result<
        (
            crate::operational_recovery_scanner::OperationalRecoveryRun,
            u64,
        ),
        OperationalRecoveryClaimError,
    > {
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
        if run.gate != OperationalRecoveryGate::RecoveryReady {
            return Err(OperationalRecoveryClaimError::RunNotReady { gate: run.gate });
        }
        Ok((run, after))
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
    #[error("operational recovery observation must be recorded before claim")]
    ObservationMissing,
    #[error("operational recovery claim must be persisted before execution")]
    ClaimMissing,
    #[error("operational recovery claim fencing identity does not match")]
    FenceMismatch,
    #[error("operational recovery workspace lease does not protect this database")]
    WorkspaceLeaseMismatch,
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
    Aggregate(#[from] OperationalRecoveryAggregateError),
    #[error(transparent)]
    TimeFormat(#[from] time::error::Format),
}
