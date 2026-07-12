use std::path::{Path, PathBuf};

use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    event_journal::{EventJournal, EventJournalError},
    operational_recovery_aggregate::{
        OperationalRecoveryAggregateError, OperationalRecoveryEffectClass,
        OperationalRecoveryEventMetadata, OperationalRecoveryRepository,
        ProviderDispatchResumeAuthorization,
    },
    provider_attempt::{ProviderAttemptAggregate, ProviderAttemptError},
    provider_dispatch_recovery_service::{
        DispatchEvidence, ProviderDispatchRecoveryError, provider_attempt_definition_sha256,
        provider_attempt_evidence_sha256,
    },
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
    workspace_runtime_lease::WorkspaceRuntimeLease,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderDispatchResumeAuthorizationRequest {
    pub workspace_id: String,
    pub run_id: String,
    pub operation_id: String,
    pub execution_id: String,
}

pub struct ProviderDispatchResumeAuthorizationService {
    database_path: PathBuf,
}

impl ProviderDispatchResumeAuthorizationService {
    pub fn new(database_path: impl AsRef<Path>) -> Self {
        Self {
            database_path: database_path.as_ref().to_owned(),
        }
    }

    pub fn authorize(
        &self,
        request: ProviderDispatchResumeAuthorizationRequest,
        exclusive_lease: &WorkspaceRuntimeLease,
    ) -> Result<ProviderDispatchResumeAuthorization, ProviderDispatchResumeAuthorizationError> {
        if !exclusive_lease.protects_database(&self.database_path) {
            return Err(ProviderDispatchResumeAuthorizationError::WorkspaceLeaseMismatch);
        }
        let clock = WorkspaceEventJournal::open(&self.database_path)?;
        let before = clock.current_global_sequence()?;
        let mut repository = OperationalRecoveryRepository::open(&self.database_path)?;
        let aggregate = repository.load(&request.workspace_id, &request.run_id)?;
        let operation = aggregate
            .operations
            .get(&request.operation_id)
            .ok_or(ProviderDispatchResumeAuthorizationError::OperationMissing)?;
        let claim = operation
            .claim
            .as_ref()
            .ok_or(ProviderDispatchResumeAuthorizationError::ClaimMissing)?;
        let execution = operation
            .execution
            .as_ref()
            .ok_or(ProviderDispatchResumeAuthorizationError::ExecutionMissing)?;
        if operation.outcome.is_some() {
            return Err(ProviderDispatchResumeAuthorizationError::OutcomeAlreadyTerminal);
        }
        if operation.stale.is_some()
            || operation.disposition.is_some()
            || execution.execution_id != request.execution_id
            || execution.claim_id != claim.claim_id
            || execution.fencing_token != claim.fencing_token
            || execution.effect_class != OperationalRecoveryEffectClass::ProviderDispatch
            || execution.action_spec_sha256 != claim.action_spec_sha256
        {
            return Err(ProviderDispatchResumeAuthorizationError::RecoveryFenceMismatch);
        }
        if exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id) {
            return Err(ProviderDispatchResumeAuthorizationError::OriginalOwnerStillActive);
        }
        let action = claim
            .action_spec
            .as_ref()
            .ok_or(ProviderDispatchResumeAuthorizationError::ActionMissing)?;
        if action.action_spec_sha256()? != claim.action_spec_sha256 {
            return Err(ProviderDispatchResumeAuthorizationError::RecoveryFenceMismatch);
        }
        let dispatch = DispatchEvidence::from_action(action)?;
        let attempt = {
            let journal = EventJournal::open(&self.database_path)?;
            ProviderAttemptAggregate::recover(&journal, &request.run_id, &dispatch.attempt_id)?
        };
        dispatch.verify_attempt(&request.run_id, &attempt)?;
        let definition_sha256 = provider_attempt_definition_sha256(&attempt)?;
        let evidence_sha256 = provider_attempt_evidence_sha256(&attempt)?;
        if let Some(existing) = operation.latest_provider_dispatch_resume()
            && existing.resumer_instance_id == exclusive_lease.instance_id()
            && existing.action_spec_sha256 == claim.action_spec_sha256
            && existing.attempt_id == dispatch.attempt_id
            && existing.attempt_state == attempt.state()
            && existing.attempt_aggregate_sequence == attempt.aggregate_sequence()
            && existing.attempt_definition_sha256 == definition_sha256
            && existing.attempt_evidence_sha256 == evidence_sha256
        {
            let after = clock.current_global_sequence()?;
            return if after == before {
                Ok(existing.clone())
            } else {
                Err(
                    ProviderDispatchResumeAuthorizationError::EvidenceChangedDuringAuthorization {
                        before,
                        after,
                    },
                )
            };
        }
        let authorized_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let authorization = ProviderDispatchResumeAuthorization::derive(
            request.operation_id.clone(),
            execution,
            exclusive_lease.instance_id().to_owned(),
            claim.action_spec_sha256.clone(),
            dispatch.attempt_id,
            attempt.state(),
            attempt.aggregate_sequence(),
            definition_sha256,
            evidence_sha256,
            operation.latest_provider_dispatch_resume(),
            authorized_at.clone(),
        )?;
        let after = clock.current_global_sequence()?;
        if after != before {
            return Err(
                ProviderDispatchResumeAuthorizationError::EvidenceChangedDuringAuthorization {
                    before,
                    after,
                },
            );
        }
        let persisted = repository.authorize_provider_dispatch_resume(
            &request.workspace_id,
            &request.run_id,
            &request.operation_id,
            authorization.clone(),
            exclusive_lease,
            after,
            OperationalRecoveryEventMetadata {
                created_at: authorized_at,
            },
        )?;
        let found = persisted.operations[&request.operation_id]
            .latest_provider_dispatch_resume()
            .ok_or(ProviderDispatchResumeAuthorizationError::AuthorizationMissing)?;
        if found == &authorization {
            Ok(authorization)
        } else {
            Err(ProviderDispatchResumeAuthorizationError::AuthorizationConflict)
        }
    }
}

#[derive(Debug, Error)]
pub enum ProviderDispatchResumeAuthorizationError {
    #[error("Provider dispatch resume workspace lease does not protect this database")]
    WorkspaceLeaseMismatch,
    #[error("Provider dispatch recovery operation is missing")]
    OperationMissing,
    #[error("Provider dispatch recovery Claim is missing")]
    ClaimMissing,
    #[error("Provider dispatch recovery Execution is missing")]
    ExecutionMissing,
    #[error("Provider dispatch recovery action is missing")]
    ActionMissing,
    #[error("Provider dispatch recovery outcome is already terminal")]
    OutcomeAlreadyTerminal,
    #[error("Provider dispatch recovery fence does not match")]
    RecoveryFenceMismatch,
    #[error("Provider dispatch resume is unnecessary while the original owner is active")]
    OriginalOwnerStillActive,
    #[error("Provider dispatch evidence changed during authorization: {before} -> {after}")]
    EvidenceChangedDuringAuthorization { before: u64, after: u64 },
    #[error("Provider dispatch resume authorization was not persisted")]
    AuthorizationMissing,
    #[error("Provider dispatch resume authorization conflicts with persisted state")]
    AuthorizationConflict,
    #[error(transparent)]
    Recovery(#[from] OperationalRecoveryAggregateError),
    #[error(transparent)]
    DispatchEvidence(#[from] ProviderDispatchRecoveryError),
    #[error(transparent)]
    Attempt(#[from] ProviderAttemptError),
    #[error(transparent)]
    RuntimeJournal(#[from] EventJournalError),
    #[error(transparent)]
    WorkspaceJournal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Time(#[from] time::error::Format),
}
