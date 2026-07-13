use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::{
    event_journal::{EventJournal, EventJournalError},
    operational_recovery_action::OperationalRecoveryAction,
    operational_recovery_aggregate::{
        OPERATIONAL_RECOVERY_POLICY_VERSION, OperationalRecoveryAggregateError,
        OperationalRecoveryDispositionAuthority, OperationalRecoveryEventMetadata,
        OperationalRecoveryExecutionInterruption, OperationalRecoveryInterruptionCause,
        OperationalRecoveryObservation, OperationalRecoveryObservedGate,
        OperationalRecoveryRepository, OperationalRecoverySubject,
        OperationalRecoveryWaitingReason,
    },
    operational_recovery_scanner::{
        OperationalRecoveryGate, OperationalRecoveryReport, OperationalRecoveryRun,
    },
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptError, ProviderAttemptState,
        provider_attempt_definition_sha256, provider_attempt_evidence_sha256,
    },
    runtime_cancellation_hub::CancellationCause,
    workspace_event_journal::WorkspaceEventJournal,
    workspace_runtime_lease::{BoundWorkspaceRuntimeLease, BoundWorkspaceRuntimeLeaseError},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordedOperationalRecovery {
    pub run_id: String,
    pub operation_id: String,
    pub gate: OperationalRecoveryGate,
    pub aggregate_revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryInterruptionRequest {
    pub workspace_id: String,
    pub run_id: String,
    pub operation_id: String,
    pub execution_id: String,
    pub attempt_id: String,
    pub cause: CancellationCause,
    pub cancellation_intent_id: Option<String>,
    pub transport_boundary_crossed: bool,
    pub resumable: bool,
    pub interrupted_at: String,
}

pub struct OperationalRecoveryRecordingService {
    database_path: PathBuf,
}

impl OperationalRecoveryRecordingService {
    pub fn new(database_path: impl AsRef<Path>) -> Self {
        Self {
            database_path: database_path.as_ref().to_owned(),
        }
    }

    pub fn record(
        &self,
        workspace_id: &str,
        project_id: &str,
        report: &OperationalRecoveryReport,
        exclusive_lease: &BoundWorkspaceRuntimeLease,
        created_at: &str,
    ) -> Result<Vec<RecordedOperationalRecovery>, OperationalRecoveryRecordingError> {
        exclusive_lease.verify_database_authority(&self.database_path)?;
        let mut repository = OperationalRecoveryRepository::open(&self.database_path)?;
        let mut recorded = Vec::with_capacity(report.runs.len());
        for run in &report.runs {
            recorded.push(record_run(
                &mut repository,
                workspace_id,
                project_id,
                run,
                exclusive_lease,
                created_at,
            )?);
        }
        recorded.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        Ok(recorded)
    }

    pub fn record_execution_interruption(
        &self,
        request: OperationalRecoveryInterruptionRequest,
        exclusive_lease: &BoundWorkspaceRuntimeLease,
    ) -> Result<OperationalRecoveryExecutionInterruption, OperationalRecoveryRecordingError> {
        exclusive_lease.verify_database_authority(&self.database_path)?;
        let clock = WorkspaceEventJournal::open(&self.database_path)?;
        let expected_global_sequence = clock.current_global_sequence()?;
        let mut repository = OperationalRecoveryRepository::open(&self.database_path)?;
        let aggregate = repository.load(&request.workspace_id, &request.run_id)?;
        let operation = aggregate
            .operations
            .get(&request.operation_id)
            .ok_or(OperationalRecoveryRecordingError::InterruptionEvidenceMismatch)?;
        let claim = operation
            .claim
            .as_ref()
            .ok_or(OperationalRecoveryRecordingError::InterruptionEvidenceMismatch)?;
        let execution = operation
            .execution
            .as_ref()
            .ok_or(OperationalRecoveryRecordingError::InterruptionEvidenceMismatch)?;
        let action = claim
            .action_spec
            .as_ref()
            .ok_or(OperationalRecoveryRecordingError::InterruptionEvidenceMismatch)?;
        let OperationalRecoveryAction::PersistedProviderAttemptDispatch {
            attempt_id,
            expected_attempt_sequence,
            ..
        } = action
        else {
            return Err(OperationalRecoveryRecordingError::InterruptionEvidenceMismatch);
        };
        if aggregate.subject.workspace_id != request.workspace_id
            || aggregate.subject.run_id != request.run_id
            || execution.execution_id != request.execution_id
            || attempt_id != &request.attempt_id
        {
            return Err(OperationalRecoveryRecordingError::InterruptionEvidenceMismatch);
        }
        let journal = EventJournal::open(&self.database_path)?;
        let attempt =
            ProviderAttemptAggregate::recover(&journal, &request.run_id, &request.attempt_id)?;
        if attempt.state() != ProviderAttemptState::Requested
            || attempt.aggregate_sequence() != *expected_attempt_sequence
        {
            return Err(OperationalRecoveryRecordingError::AttemptCrossedTransportBoundary);
        }
        let interruption = OperationalRecoveryExecutionInterruption::derive(
            request.workspace_id.clone(),
            request.run_id.clone(),
            request.operation_id.clone(),
            execution,
            request.attempt_id,
            attempt.aggregate_sequence(),
            provider_attempt_definition_sha256(&attempt)?,
            provider_attempt_evidence_sha256(&attempt)?,
            map_interruption_cause(request.cause),
            request.cancellation_intent_id,
            request.transport_boundary_crossed,
            request.resumable,
            exclusive_lease.owner_id().to_owned(),
            exclusive_lease.lease_epoch().to_owned(),
            request.interrupted_at.clone(),
        )?;
        let persisted = repository.record_execution_interruption(
            &request.workspace_id,
            &request.run_id,
            &request.operation_id,
            interruption.clone(),
            exclusive_lease,
            expected_global_sequence,
            OperationalRecoveryEventMetadata {
                created_at: request.interrupted_at,
            },
        )?;
        let recorded = persisted.operations[&request.operation_id]
            .interruptions
            .iter()
            .find(|candidate| candidate.interruption_id == interruption.interruption_id)
            .ok_or(OperationalRecoveryRecordingError::InterruptionPersistenceMissing)?;
        if persisted.operations[&request.operation_id]
            .outcome
            .is_some()
        {
            return Err(OperationalRecoveryRecordingError::InterruptionPersistenceConflict);
        }
        Ok(recorded.clone())
    }
}

fn map_interruption_cause(value: CancellationCause) -> OperationalRecoveryInterruptionCause {
    match value {
        CancellationCause::RuntimeShutdown => OperationalRecoveryInterruptionCause::RuntimeShutdown,
        CancellationCause::HostDisconnected => {
            OperationalRecoveryInterruptionCause::HostDisconnected
        }
        CancellationCause::RunCancel => OperationalRecoveryInterruptionCause::RunCancel,
    }
}

fn record_run(
    repository: &mut OperationalRecoveryRepository,
    workspace_id: &str,
    project_id: &str,
    run: &OperationalRecoveryRun,
    exclusive_lease: &BoundWorkspaceRuntimeLease,
    created_at: &str,
) -> Result<RecordedOperationalRecovery, OperationalRecoveryRecordingError> {
    let subject = OperationalRecoverySubject {
        workspace_id: workspace_id.to_owned(),
        project_id: project_id.to_owned(),
        run_id: run.run_id.clone(),
        policy_version: OPERATIONAL_RECOVERY_POLICY_VERSION.to_owned(),
    };
    let observed_gate = map_gate(run.gate);
    let observation = OperationalRecoveryObservation::derive(
        &subject,
        run.source_fingerprint.clone(),
        observed_gate,
        run.reasons.clone(),
    )?;
    let operation_id = observation.operation_id.clone();
    let metadata = || OperationalRecoveryEventMetadata {
        created_at: created_at.to_owned(),
    };
    let disposition_authority =
        OperationalRecoveryDispositionAuthority::new(workspace_id, &run.run_id, exclusive_lease);
    let mut aggregate = repository.observe(subject, observation, exclusive_lease, metadata())?;
    aggregate = match run.gate {
        OperationalRecoveryGate::AwaitingProviderBinding => repository.wait(
            disposition_authority,
            &operation_id,
            OperationalRecoveryWaitingReason::ProviderBinding,
            run.source_fingerprint.clone(),
            metadata(),
        )?,
        OperationalRecoveryGate::WaitingForApproval => repository.wait(
            disposition_authority,
            &operation_id,
            OperationalRecoveryWaitingReason::HostApproval,
            run.source_fingerprint.clone(),
            metadata(),
        )?,
        OperationalRecoveryGate::WaitingForReconciliation => repository.wait(
            disposition_authority,
            &operation_id,
            OperationalRecoveryWaitingReason::Reconciliation,
            run.source_fingerprint.clone(),
            metadata(),
        )?,
        OperationalRecoveryGate::WaitingForExplicitExecution => repository.wait(
            disposition_authority,
            &operation_id,
            OperationalRecoveryWaitingReason::ExplicitExecution,
            run.source_fingerprint.clone(),
            metadata(),
        )?,
        OperationalRecoveryGate::Quarantined => repository.quarantine(
            disposition_authority,
            &operation_id,
            run.reasons.clone(),
            run.source_fingerprint.clone(),
            metadata(),
        )?,
        OperationalRecoveryGate::RecoveryReady
        | OperationalRecoveryGate::ProviderDispatchReady
        | OperationalRecoveryGate::TerminalProjectionOnly => aggregate,
    };
    Ok(RecordedOperationalRecovery {
        run_id: run.run_id.clone(),
        operation_id,
        gate: run.gate,
        aggregate_revision: aggregate.revision,
    })
}

fn map_gate(value: OperationalRecoveryGate) -> OperationalRecoveryObservedGate {
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

#[derive(Debug, Error)]
pub enum OperationalRecoveryRecordingError {
    #[error(transparent)]
    WorkspaceLease(#[from] BoundWorkspaceRuntimeLeaseError),
    #[error("operational recovery interruption evidence does not match the active execution")]
    InterruptionEvidenceMismatch,
    #[error(
        "operational recovery interruption cannot be recorded after the Provider transport boundary"
    )]
    AttemptCrossedTransportBoundary,
    #[error("operational recovery interruption event was not persisted")]
    InterruptionPersistenceMissing,
    #[error("operational recovery interruption persistence conflicts with active operation state")]
    InterruptionPersistenceConflict,
    #[error(transparent)]
    Aggregate(#[from] OperationalRecoveryAggregateError),
    #[error(transparent)]
    Attempt(#[from] ProviderAttemptError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    WorkspaceJournal(#[from] crate::workspace_event_journal::WorkspaceEventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
