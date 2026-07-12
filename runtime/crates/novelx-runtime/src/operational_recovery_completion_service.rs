use std::path::{Path, PathBuf};

use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    operational_recovery_aggregate::{
        OperationalRecoveryAggregate, OperationalRecoveryAggregateError,
        OperationalRecoveryEffectClass, OperationalRecoveryEventMetadata,
        OperationalRecoveryOutcome, OperationalRecoveryRepository,
    },
    operational_recovery_projection_service::{
        OperationalRecoveryProjectionError, PersistedProviderProjectionManifest,
    },
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
    workspace_runtime_lease::WorkspaceRuntimeLease,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryCompletionRequest {
    pub workspace_id: String,
    pub run_id: String,
    pub operation_id: String,
    pub execution_id: String,
}

pub struct OperationalRecoveryCompletionService {
    database_path: PathBuf,
}

impl OperationalRecoveryCompletionService {
    pub fn new(database_path: impl AsRef<Path>) -> Self {
        Self {
            database_path: database_path.as_ref().to_owned(),
        }
    }

    pub fn finish_persisted_provider_projection(
        &self,
        request: OperationalRecoveryCompletionRequest,
        manifest: &PersistedProviderProjectionManifest,
        exclusive_lease: &WorkspaceRuntimeLease,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryCompletionError> {
        if !exclusive_lease.protects_database(&self.database_path) {
            return Err(OperationalRecoveryCompletionError::WorkspaceLeaseMismatch);
        }
        manifest.verify()?;
        if manifest.run_id != request.run_id || manifest.execution_id != request.execution_id {
            return Err(OperationalRecoveryCompletionError::ManifestIdentityMismatch);
        }
        let mut repository = OperationalRecoveryRepository::open(&self.database_path)?;
        let aggregate = repository.load(&request.workspace_id, &request.run_id)?;
        let operation = aggregate
            .operations
            .get(&request.operation_id)
            .ok_or(OperationalRecoveryCompletionError::OperationMissing)?;
        let claim = operation
            .claim
            .as_ref()
            .ok_or(OperationalRecoveryCompletionError::ClaimMissing)?;
        let execution = operation
            .execution
            .as_ref()
            .ok_or(OperationalRecoveryCompletionError::ExecutionMissing)?;
        if execution.execution_id != request.execution_id
            || execution.claim_id != claim.claim_id
            || execution.fencing_token != claim.fencing_token
            || execution.effect_class
                != OperationalRecoveryEffectClass::PersistedProviderResultProjection
        {
            return Err(OperationalRecoveryCompletionError::FenceMismatch);
        }
        let claim_owner = exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id);
        let latest_resumer = operation.resumes.last().is_some_and(|resume| {
            resume.execution_id == execution.execution_id
                && resume.fencing_token == execution.fencing_token
                && exclusive_lease.proves_exclusive_owner(&resume.resumer_instance_id)
        });
        if !claim_owner && !latest_resumer {
            return Err(OperationalRecoveryCompletionError::ExclusiveOwnerMismatch);
        }
        if let Some(existing) = &operation.outcome {
            return if outcome_matches_manifest(existing, manifest) {
                Ok(aggregate)
            } else {
                Err(OperationalRecoveryCompletionError::OutcomeConflict)
            };
        }
        let completed_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let outcome = OperationalRecoveryOutcome::succeeded(
            execution,
            manifest.manifest_sha256.clone(),
            manifest.resulting_loop_checkpoint_sha256.clone(),
            completed_at.clone(),
        )?;
        let clock = WorkspaceEventJournal::open(&self.database_path)?.current_global_sequence()?;
        repository
            .finish_execution(
                &request.workspace_id,
                &request.run_id,
                &request.operation_id,
                outcome,
                exclusive_lease,
                clock,
                OperationalRecoveryEventMetadata {
                    created_at: completed_at,
                },
            )
            .map_err(Into::into)
    }
}

fn outcome_matches_manifest(
    outcome: &OperationalRecoveryOutcome,
    manifest: &PersistedProviderProjectionManifest,
) -> bool {
    matches!(
        outcome,
        OperationalRecoveryOutcome::Succeeded {
            execution_id,
            result_manifest_sha256,
            final_checkpoint_sha256,
            ..
        } if execution_id == &manifest.execution_id
            && result_manifest_sha256 == &manifest.manifest_sha256
            && final_checkpoint_sha256 == &manifest.resulting_loop_checkpoint_sha256
    )
}

#[derive(Debug, Error)]
pub enum OperationalRecoveryCompletionError {
    #[error("operational recovery workspace lease does not protect this database")]
    WorkspaceLeaseMismatch,
    #[error("operational recovery projection manifest identity does not match completion")]
    ManifestIdentityMismatch,
    #[error("operational recovery operation was not found")]
    OperationMissing,
    #[error("operational recovery Claim was not found")]
    ClaimMissing,
    #[error("operational recovery Execution was not found")]
    ExecutionMissing,
    #[error("operational recovery completion fence does not match")]
    FenceMismatch,
    #[error("operational recovery completion requires the current Claim owner or latest resumer")]
    ExclusiveOwnerMismatch,
    #[error("operational recovery completion conflicts with the persisted outcome")]
    OutcomeConflict,
    #[error(transparent)]
    Projection(#[from] OperationalRecoveryProjectionError),
    #[error(transparent)]
    Aggregate(#[from] OperationalRecoveryAggregateError),
    #[error(transparent)]
    WorkspaceJournal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Time(#[from] time::error::Format),
}
