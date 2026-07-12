use std::path::{Path, PathBuf};

use novelx_protocol::ProviderRunIdentity;
use thiserror::Error;

use crate::{
    agent_assignment_recovery::{AgentAssignmentRecoveryError, recover_agent_assignments},
    event_journal::{EventJournal, EventJournalError},
    operational_recovery_aggregate::{
        OPERATIONAL_RECOVERY_POLICY_VERSION, OperationalRecoveryAggregate,
        OperationalRecoveryAggregateError, OperationalRecoveryClaim,
        OperationalRecoveryEventMetadata, OperationalRecoveryObservation,
        OperationalRecoveryObservedGate, OperationalRecoveryRepository, OperationalRecoverySubject,
    },
    operational_recovery_scanner::{
        OperationalRecoveryGate, OperationalRecoveryScanError, OperationalRecoveryScanner,
    },
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryClaimRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub run_id: String,
    pub expected_operation_id: String,
    pub owner_instance_id: String,
    pub claimed_at: String,
    pub lease_expires_at: String,
    pub executor_version: String,
    pub action_spec_sha256: String,
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
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryClaimError> {
        let clock = WorkspaceEventJournal::open(&self.database_path)?;
        let before = clock.current_global_sequence()?;
        let assignments = recover_agent_assignments(
            &self.database_path,
            &request.workspace_id,
            &request.project_id,
        )?;
        let mut runtime_journal = EventJournal::open(&self.database_path)?;
        let report =
            OperationalRecoveryScanner::new(&mut runtime_journal, &assignments, bound_providers)
                .scan(&request.workspace_id, &request.project_id)?;
        let after = clock.current_global_sequence()?;
        if before != after {
            return Err(OperationalRecoveryClaimError::SourceChangedDuringScan { before, after });
        }
        let run = report
            .runs
            .into_iter()
            .find(|run| run.run_id == request.run_id)
            .ok_or(OperationalRecoveryClaimError::RunNotFound)?;
        if run.gate != OperationalRecoveryGate::RecoveryReady {
            return Err(OperationalRecoveryClaimError::RunNotReady { gate: run.gate });
        }
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
            request.owner_instance_id,
            1,
            observation.source_fingerprint.clone(),
            request.claimed_at.clone(),
            request.lease_expires_at,
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
                    created_at: request.claimed_at,
                },
            )
            .map_err(Into::into)
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
}
