use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::{
    operational_recovery_aggregate::{
        OPERATIONAL_RECOVERY_POLICY_VERSION, OperationalRecoveryAggregateError,
        OperationalRecoveryEventMetadata, OperationalRecoveryObservation,
        OperationalRecoveryObservedGate, OperationalRecoveryRepository, OperationalRecoverySubject,
        OperationalRecoveryWaitingReason,
    },
    operational_recovery_scanner::{
        OperationalRecoveryGate, OperationalRecoveryReport, OperationalRecoveryRun,
    },
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordedOperationalRecovery {
    pub run_id: String,
    pub operation_id: String,
    pub gate: OperationalRecoveryGate,
    pub aggregate_revision: u64,
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
        created_at: &str,
    ) -> Result<Vec<RecordedOperationalRecovery>, OperationalRecoveryRecordingError> {
        let mut repository = OperationalRecoveryRepository::open(&self.database_path)?;
        let mut recorded = Vec::with_capacity(report.runs.len());
        for run in &report.runs {
            recorded.push(record_run(
                &mut repository,
                workspace_id,
                project_id,
                run,
                created_at,
            )?);
        }
        recorded.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        Ok(recorded)
    }
}

fn record_run(
    repository: &mut OperationalRecoveryRepository,
    workspace_id: &str,
    project_id: &str,
    run: &OperationalRecoveryRun,
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
    let mut aggregate = repository.observe(subject, observation, metadata())?;
    aggregate = match run.gate {
        OperationalRecoveryGate::AwaitingProviderBinding => repository.wait(
            workspace_id,
            &run.run_id,
            &operation_id,
            OperationalRecoveryWaitingReason::ProviderBinding,
            run.source_fingerprint.clone(),
            metadata(),
        )?,
        OperationalRecoveryGate::WaitingForApproval => repository.wait(
            workspace_id,
            &run.run_id,
            &operation_id,
            OperationalRecoveryWaitingReason::HostApproval,
            run.source_fingerprint.clone(),
            metadata(),
        )?,
        OperationalRecoveryGate::WaitingForReconciliation => repository.wait(
            workspace_id,
            &run.run_id,
            &operation_id,
            OperationalRecoveryWaitingReason::Reconciliation,
            run.source_fingerprint.clone(),
            metadata(),
        )?,
        OperationalRecoveryGate::Quarantined => repository.quarantine(
            workspace_id,
            &run.run_id,
            &operation_id,
            run.reasons.clone(),
            run.source_fingerprint.clone(),
            metadata(),
        )?,
        OperationalRecoveryGate::RecoveryReady
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
        OperationalRecoveryGate::RecoveryReady => OperationalRecoveryObservedGate::RecoveryReady,
        OperationalRecoveryGate::Quarantined => OperationalRecoveryObservedGate::Quarantined,
        OperationalRecoveryGate::TerminalProjectionOnly => {
            OperationalRecoveryObservedGate::TerminalProjectionOnly
        }
    }
}

#[derive(Debug, Error)]
pub enum OperationalRecoveryRecordingError {
    #[error(transparent)]
    Aggregate(#[from] OperationalRecoveryAggregateError),
}
