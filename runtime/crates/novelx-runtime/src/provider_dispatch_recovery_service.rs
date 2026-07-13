use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use novelx_protocol::ProviderRunIdentity;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::watch;
use uuid::Uuid;

use crate::{
    agent_loop_journal::AgentLoopJournalError,
    context_compile_service::ContextCompileServiceError,
    event_journal::{EventJournal, EventJournalError},
    operational_recovery_action::OperationalRecoveryAction,
    operational_recovery_aggregate::{
        OperationalRecoveryAggregateError, OperationalRecoveryEffectClass,
        OperationalRecoveryEventMetadata, OperationalRecoveryOperation, OperationalRecoveryOutcome,
        OperationalRecoveryRepository, ProviderDispatchResumeCapability,
    },
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptError, ProviderAttemptState,
        provider_attempt_definition_sha256, provider_attempt_evidence_sha256,
    },
    provider_effect_authorization_service::recovery::{
        ProviderRecoveryEffectAuthorizationError, ProviderRecoveryEffectAuthorizationRequest,
        ProviderRecoveryEffectAuthorizationService,
    },
    provider_gateway::{ProviderGateway, ProviderRegistry},
    provider_inference_service::{
        ProviderAttemptExecutionGuard, ProviderInferenceService, ProviderInferenceServiceError,
    },
    run_aggregate::RunAggregateError,
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
    workspace_runtime_lease::WorkspaceRuntimeLease,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderDispatchRecoveryRequest {
    pub workspace_id: String,
    pub run_id: String,
    pub operation_id: String,
    pub execution_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderDispatchAuthorizedResumeRequest {
    pub recovery: ProviderDispatchRecoveryRequest,
    pub authorization_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderDispatchRecoveryTerminal {
    Responded,
    FailedSafe,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderDispatchRecoveryReceipt {
    pub run_id: String,
    pub attempt_id: String,
    pub operation_id: String,
    pub execution_id: String,
    pub terminal: ProviderDispatchRecoveryTerminal,
    pub evidence_sha256: String,
    pub final_checkpoint_sha256: String,
    pub manifest_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderDispatchRecoveryManifest {
    run_id: String,
    attempt_id: String,
    operation_id: String,
    execution_id: String,
    terminal: ProviderDispatchRecoveryTerminal,
    evidence_sha256: String,
    final_checkpoint_sha256: String,
    manifest_sha256: String,
}

impl ProviderDispatchRecoveryManifest {
    fn derive(
        request: &ProviderDispatchRecoveryRequest,
        attempt_id: &str,
        terminal: ProviderDispatchRecoveryTerminal,
        evidence_sha256: String,
        final_checkpoint_sha256: String,
    ) -> Result<Self, ProviderDispatchRecoveryError> {
        let unsigned = serde_json::json!({
            "runId": request.run_id,
            "attemptId": attempt_id,
            "operationId": request.operation_id,
            "executionId": request.execution_id,
            "terminal": terminal,
            "evidenceSha256": evidence_sha256,
            "finalCheckpointSha256": final_checkpoint_sha256,
        });
        let manifest_sha256 = canonical_sha256(&unsigned)?;
        Ok(Self {
            run_id: request.run_id.clone(),
            attempt_id: attempt_id.to_owned(),
            operation_id: request.operation_id.clone(),
            execution_id: request.execution_id.clone(),
            terminal,
            evidence_sha256,
            final_checkpoint_sha256,
            manifest_sha256,
        })
    }
}

pub struct ProviderDispatchRecoveryService {
    database_path: PathBuf,
}

impl ProviderDispatchRecoveryService {
    pub fn new(database_path: impl AsRef<Path>) -> Self {
        Self {
            database_path: database_path.as_ref().to_owned(),
        }
    }

    pub async fn execute_requested(
        &self,
        request: ProviderDispatchRecoveryRequest,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        exclusive_lease: &Arc<WorkspaceRuntimeLease>,
    ) -> Result<ProviderDispatchRecoveryReceipt, ProviderDispatchRecoveryError> {
        self.execute(request, None, providers, gateway, exclusive_lease)
            .await
    }

    pub async fn resume_authorized(
        &self,
        request: ProviderDispatchAuthorizedResumeRequest,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        exclusive_lease: &Arc<WorkspaceRuntimeLease>,
    ) -> Result<ProviderDispatchRecoveryReceipt, ProviderDispatchRecoveryError> {
        if request.authorization_id.trim().is_empty() {
            return Err(ProviderDispatchRecoveryError::ResumeAuthorizationMissing);
        }
        self.execute(
            request.recovery,
            Some(request.authorization_id.as_str()),
            providers,
            gateway,
            exclusive_lease,
        )
        .await
    }

    async fn execute(
        &self,
        request: ProviderDispatchRecoveryRequest,
        resume_authorization_id: Option<&str>,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        exclusive_lease: &Arc<WorkspaceRuntimeLease>,
    ) -> Result<ProviderDispatchRecoveryReceipt, ProviderDispatchRecoveryError> {
        if !exclusive_lease.protects_database(&self.database_path) {
            return Err(ProviderDispatchRecoveryError::WorkspaceLeaseMismatch);
        }
        let recovery = OperationalRecoveryRepository::open(&self.database_path)?
            .load(&request.workspace_id, &request.run_id)?;
        let operation = recovery
            .operations
            .get(&request.operation_id)
            .ok_or(ProviderDispatchRecoveryError::OperationMissing)?;
        let claim = operation
            .claim
            .as_ref()
            .ok_or(ProviderDispatchRecoveryError::ClaimMissing)?;
        let recovery_execution = operation
            .execution
            .as_ref()
            .ok_or(ProviderDispatchRecoveryError::ExecutionMissing)?;
        if operation.stale.is_some()
            || recovery_execution.execution_id != request.execution_id
            || recovery_execution.claim_id != claim.claim_id
            || recovery_execution.fencing_token != claim.fencing_token
            || recovery_execution.effect_class != OperationalRecoveryEffectClass::ProviderDispatch
        {
            return Err(ProviderDispatchRecoveryError::RecoveryFenceMismatch);
        }
        let action = claim
            .action_spec
            .as_ref()
            .ok_or(ProviderDispatchRecoveryError::ActionMissing)?;
        if action.action_spec_sha256()? != claim.action_spec_sha256 {
            return Err(ProviderDispatchRecoveryError::RecoveryFenceMismatch);
        }
        let dispatch = DispatchEvidence::from_action(action)?;
        let attempt_before = {
            let journal = EventJournal::open(&self.database_path)?;
            ProviderAttemptAggregate::recover(&journal, &request.run_id, &dispatch.attempt_id)?
        };
        let _terminal_projection_guard =
            if attempt_before.state() == ProviderAttemptState::Requested {
                None
            } else {
                let journal = EventJournal::open(&self.database_path)?;
                Some(ProviderAttemptExecutionGuard::acquire(
                    &journal,
                    &request.run_id,
                    &dispatch.attempt_id,
                )?)
            };
        dispatch.verify_attempt(&request.run_id, &attempt_before)?;
        if operation.outcome.is_some() {
            return self.finish_from_attempt(
                request,
                &dispatch,
                resume_authorization_id,
                exclusive_lease,
            );
        }
        if operation.disposition.is_some() {
            return Err(ProviderDispatchRecoveryError::OperationNotExecutable);
        }
        verify_dispatch_actor(
            operation,
            &attempt_before,
            &dispatch,
            resume_authorization_id,
            exclusive_lease.as_ref(),
        )?;
        if attempt_before.state() == ProviderAttemptState::Requested {
            let run_id = Uuid::parse_str(&request.run_id)?;
            let authorization = ProviderRecoveryEffectAuthorizationService::new(
                &self.database_path,
                request.workspace_id.clone(),
                recovery.subject.project_id.clone(),
            )?
            .authorize_recovery(
                ProviderRecoveryEffectAuthorizationRequest {
                    run_id,
                    operation_id: request.operation_id.clone(),
                    execution_id: request.execution_id.clone(),
                    resume_authorization_id: resume_authorization_id.map(str::to_owned),
                },
                providers,
                gateway,
                Arc::clone(exclusive_lease),
            )?;
            let armed = {
                let mut journal = EventJournal::open(&self.database_path)?;
                ProviderInferenceService::new(&mut journal, providers, gateway)
                    .arm_authorized_dispatch(authorization, &self.database_path, false)
            };
            let armed = match armed {
                Ok(armed) => armed,
                Err(error) => {
                    return self.handle_dispatch_error(&request, &dispatch, error);
                }
            };
            // Startup recovery currently has no user-facing cancellation source. The receiver is
            // still threaded through the Gateway so a real source can replace this local open
            // channel without changing the authorized effect boundary.
            let (_cancellation_sender, mut cancellation) = watch::channel(false);
            let dispatched = ProviderInferenceService::dispatch_authorized_attempt(
                gateway,
                armed,
                &mut cancellation,
            )
            .await;
            let finalized = {
                let mut journal = EventJournal::open(&self.database_path)?;
                ProviderInferenceService::finalize_authorized_attempt_in(&mut journal, dispatched)
            };
            match finalized {
                Ok(_) => {
                    #[cfg(feature = "runtime-test-failpoints")]
                    crate::runtime_test_failpoint::hit(
                        "provider_dispatch.responded_before_recovery_outcome",
                    );
                }
                Err(error) => {
                    let state_after = {
                        let journal = EventJournal::open(&self.database_path)?;
                        ProviderAttemptAggregate::recover(
                            &journal,
                            &request.run_id,
                            &dispatch.attempt_id,
                        )?
                        .state()
                    };
                    if state_after == ProviderAttemptState::Requested {
                        return Err(ProviderDispatchRecoveryError::PreDispatchBlocked(Box::new(
                            error,
                        )));
                    }
                }
            }
        }
        self.finish_from_attempt(request, &dispatch, resume_authorization_id, exclusive_lease)
    }

    fn handle_dispatch_error(
        &self,
        request: &ProviderDispatchRecoveryRequest,
        dispatch: &DispatchEvidence,
        error: ProviderInferenceServiceError,
    ) -> Result<ProviderDispatchRecoveryReceipt, ProviderDispatchRecoveryError> {
        let journal = EventJournal::open(&self.database_path)?;
        let state =
            ProviderAttemptAggregate::recover(&journal, &request.run_id, &dispatch.attempt_id)?
                .state();
        if state == ProviderAttemptState::Requested {
            Err(ProviderDispatchRecoveryError::PreDispatchBlocked(Box::new(
                error,
            )))
        } else {
            Err(error.into())
        }
    }

    fn finish_from_attempt(
        &self,
        request: ProviderDispatchRecoveryRequest,
        dispatch: &DispatchEvidence,
        resume_authorization_id: Option<&str>,
        exclusive_lease: &Arc<WorkspaceRuntimeLease>,
    ) -> Result<ProviderDispatchRecoveryReceipt, ProviderDispatchRecoveryError> {
        let journal = EventJournal::open(&self.database_path)?;
        let attempt =
            ProviderAttemptAggregate::recover(&journal, &request.run_id, &dispatch.attempt_id)?;
        dispatch.verify_attempt(&request.run_id, &attempt)?;
        let evidence_sha256 = provider_attempt_evidence_sha256(&attempt)?;
        let terminal = match attempt.state() {
            ProviderAttemptState::Responded => ProviderDispatchRecoveryTerminal::Responded,
            ProviderAttemptState::Failed => ProviderDispatchRecoveryTerminal::FailedSafe,
            ProviderAttemptState::Sent | ProviderAttemptState::OutcomeUnknown => {
                ProviderDispatchRecoveryTerminal::OutcomeUnknown
            }
            ProviderAttemptState::Requested => {
                return Err(ProviderDispatchRecoveryError::DispatchDidNotCrossBoundary);
            }
        };
        let manifest = ProviderDispatchRecoveryManifest::derive(
            &request,
            &dispatch.attempt_id,
            terminal,
            evidence_sha256.clone(),
            dispatch.expected_loop_checkpoint_sha256.clone(),
        )?;
        self.finish_recovery_operation(
            &request,
            &manifest,
            resume_authorization_id,
            exclusive_lease.as_ref(),
        )?;
        Ok(ProviderDispatchRecoveryReceipt {
            run_id: request.run_id,
            attempt_id: dispatch.attempt_id.clone(),
            operation_id: request.operation_id,
            execution_id: request.execution_id,
            terminal,
            evidence_sha256,
            final_checkpoint_sha256: manifest.final_checkpoint_sha256,
            manifest_sha256: manifest.manifest_sha256,
        })
    }

    fn finish_recovery_operation(
        &self,
        request: &ProviderDispatchRecoveryRequest,
        manifest: &ProviderDispatchRecoveryManifest,
        resume_authorization_id: Option<&str>,
        exclusive_lease: &WorkspaceRuntimeLease,
    ) -> Result<(), ProviderDispatchRecoveryError> {
        let mut repository = OperationalRecoveryRepository::open(&self.database_path)?;
        let aggregate = repository.load(&request.workspace_id, &request.run_id)?;
        let operation = aggregate
            .operations
            .get(&request.operation_id)
            .ok_or(ProviderDispatchRecoveryError::OperationMissing)?;
        let claim = operation
            .claim
            .as_ref()
            .ok_or(ProviderDispatchRecoveryError::ClaimMissing)?;
        let execution = operation
            .execution
            .as_ref()
            .ok_or(ProviderDispatchRecoveryError::ExecutionMissing)?;
        if execution.execution_id != request.execution_id
            || execution.effect_class != OperationalRecoveryEffectClass::ProviderDispatch
        {
            return Err(ProviderDispatchRecoveryError::RecoveryFenceMismatch);
        }
        if let Some(existing) = &operation.outcome {
            return if outcome_matches_manifest(existing, manifest) {
                Ok(())
            } else {
                Err(ProviderDispatchRecoveryError::OutcomeConflict)
            };
        }
        let resume_owner = resume_authorization_id.is_some_and(|authorization_id| {
            operation
                .latest_provider_dispatch_resume()
                .is_some_and(|authorization| {
                    authorization.authorization_id == authorization_id
                        && authorization.execution_id == execution.execution_id
                        && authorization.claim_id == claim.claim_id
                        && authorization.fencing_token == claim.fencing_token
                        && authorization.action_spec_sha256 == claim.action_spec_sha256
                        && exclusive_lease
                            .proves_exclusive_owner(&authorization.resumer_instance_id)
                })
        });
        if !exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id) && !resume_owner {
            return Err(ProviderDispatchRecoveryError::RecoveryFenceMismatch);
        }
        let now = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let outcome = match manifest.terminal {
            ProviderDispatchRecoveryTerminal::Responded => OperationalRecoveryOutcome::succeeded(
                execution,
                manifest.manifest_sha256.clone(),
                manifest.final_checkpoint_sha256.clone(),
                now.clone(),
            )?,
            ProviderDispatchRecoveryTerminal::FailedSafe => {
                OperationalRecoveryOutcome::failed_safe(
                    execution,
                    "PROVIDER_DISPATCH_FAILED_SAFE".to_owned(),
                    manifest.evidence_sha256.clone(),
                    now.clone(),
                )?
            }
            ProviderDispatchRecoveryTerminal::OutcomeUnknown => {
                OperationalRecoveryOutcome::outcome_unknown(
                    execution,
                    "PROVIDER_DISPATCH_OUTCOME_UNKNOWN".to_owned(),
                    manifest.evidence_sha256.clone(),
                    now.clone(),
                )?
            }
        };
        let clock = WorkspaceEventJournal::open(&self.database_path)?.current_global_sequence()?;
        repository.finish_execution(
            &request.workspace_id,
            &request.run_id,
            &request.operation_id,
            outcome,
            exclusive_lease,
            clock,
            OperationalRecoveryEventMetadata { created_at: now },
        )?;
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct DispatchEvidence {
    pub(crate) invocation_id: String,
    pub(crate) attempt_id: String,
    pub(crate) inference_id: String,
    pub(crate) context_compilation_id: String,
    pub(crate) attempt_number: u16,
    pub(crate) provider: ProviderRunIdentity,
    pub(crate) canonical_context_sha256: String,
    pub(crate) transport_payload_sha256: String,
    pub(crate) expected_loop_checkpoint_sha256: String,
    pub(crate) expected_attempt_sequence: u64,
}

impl DispatchEvidence {
    pub(crate) fn from_action(
        action: &OperationalRecoveryAction,
    ) -> Result<Self, ProviderDispatchRecoveryError> {
        let OperationalRecoveryAction::PersistedProviderAttemptDispatch {
            invocation_id,
            attempt_id,
            inference_id,
            context_compilation_id,
            attempt_number,
            provider,
            canonical_context_sha256,
            expected_loop_checkpoint_sha256,
            expected_attempt_sequence,
            transport_payload_sha256,
        } = action
        else {
            return Err(ProviderDispatchRecoveryError::ActionNotDispatch);
        };
        Ok(Self {
            invocation_id: invocation_id.clone(),
            attempt_id: attempt_id.clone(),
            inference_id: inference_id.clone(),
            context_compilation_id: context_compilation_id.clone(),
            attempt_number: *attempt_number,
            provider: provider.clone(),
            canonical_context_sha256: canonical_context_sha256.clone(),
            transport_payload_sha256: transport_payload_sha256.clone(),
            expected_loop_checkpoint_sha256: expected_loop_checkpoint_sha256.clone(),
            expected_attempt_sequence: *expected_attempt_sequence,
        })
    }

    pub(crate) fn verify_attempt(
        &self,
        run_id: &str,
        attempt: &ProviderAttemptAggregate,
    ) -> Result<(), ProviderDispatchRecoveryError> {
        let definition = attempt.definition();
        let context_compilation_id = Uuid::parse_str(&self.context_compilation_id)?;
        if definition.run_id != run_id
            || definition.inference_id != self.inference_id
            || definition.invocation_id != self.invocation_id
            || definition.context_compilation_id != context_compilation_id
            || definition.attempt_number != self.attempt_number
            || definition.provider != self.provider
            || definition.canonical_context_sha256 != self.canonical_context_sha256
            || definition.transport_payload_sha256 != self.transport_payload_sha256
        {
            return Err(ProviderDispatchRecoveryError::AttemptDefinitionMismatch);
        }
        if attempt.aggregate_sequence() < self.expected_attempt_sequence
            || (attempt.state() == ProviderAttemptState::Requested
                && attempt.aggregate_sequence() != self.expected_attempt_sequence)
        {
            return Err(ProviderDispatchRecoveryError::AttemptSequenceMismatch);
        }
        Ok(())
    }
}

fn verify_dispatch_actor(
    operation: &OperationalRecoveryOperation,
    attempt: &ProviderAttemptAggregate,
    dispatch: &DispatchEvidence,
    resume_authorization_id: Option<&str>,
    exclusive_lease: &WorkspaceRuntimeLease,
) -> Result<(), ProviderDispatchRecoveryError> {
    let claim = operation
        .claim
        .as_ref()
        .ok_or(ProviderDispatchRecoveryError::ClaimMissing)?;
    if exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id) {
        return if resume_authorization_id.is_none() {
            Ok(())
        } else {
            Err(ProviderDispatchRecoveryError::ResumeAuthorizationUnexpected)
        };
    }
    let authorization_id =
        resume_authorization_id.ok_or(ProviderDispatchRecoveryError::ResumeAuthorizationMissing)?;
    let authorization = operation
        .latest_provider_dispatch_resume()
        .ok_or(ProviderDispatchRecoveryError::ResumeAuthorizationMissing)?;
    let execution = operation
        .execution
        .as_ref()
        .ok_or(ProviderDispatchRecoveryError::ExecutionMissing)?;
    let expected_capability = match attempt.state() {
        ProviderAttemptState::Requested => ProviderDispatchResumeCapability::DispatchRequested,
        ProviderAttemptState::Sent | ProviderAttemptState::OutcomeUnknown => {
            ProviderDispatchResumeCapability::FinalizeOutcomeUnknown
        }
        ProviderAttemptState::Responded => ProviderDispatchResumeCapability::FinalizeResponded,
        ProviderAttemptState::Failed => ProviderDispatchResumeCapability::FinalizeFailed,
    };
    if authorization.authorization_id != authorization_id
        || authorization.operation_id != operation.observation.operation_id
        || authorization.execution_id != execution.execution_id
        || authorization.claim_id != claim.claim_id
        || authorization.original_owner_instance_id != execution.owner_instance_id
        || authorization.fencing_token != execution.fencing_token
        || authorization.action_spec_sha256 != claim.action_spec_sha256
        || authorization.attempt_id != dispatch.attempt_id
        || authorization.attempt_state != attempt.state()
        || authorization.attempt_aggregate_sequence != attempt.aggregate_sequence()
        || authorization.attempt_definition_sha256 != provider_attempt_definition_sha256(attempt)?
        || authorization.attempt_evidence_sha256 != provider_attempt_evidence_sha256(attempt)?
        || authorization.capability != expected_capability
        || !exclusive_lease.proves_exclusive_owner(&authorization.resumer_instance_id)
    {
        return Err(ProviderDispatchRecoveryError::ResumeEvidenceChanged);
    }
    Ok(())
}

fn outcome_matches_manifest(
    outcome: &OperationalRecoveryOutcome,
    manifest: &ProviderDispatchRecoveryManifest,
) -> bool {
    match outcome {
        OperationalRecoveryOutcome::Succeeded {
            execution_id,
            result_manifest_sha256,
            final_checkpoint_sha256,
            ..
        } => {
            manifest.terminal == ProviderDispatchRecoveryTerminal::Responded
                && execution_id == &manifest.execution_id
                && result_manifest_sha256 == &manifest.manifest_sha256
                && final_checkpoint_sha256 == &manifest.final_checkpoint_sha256
        }
        OperationalRecoveryOutcome::FailedSafe {
            execution_id,
            error_code,
            evidence_sha256,
            ..
        } => {
            manifest.terminal == ProviderDispatchRecoveryTerminal::FailedSafe
                && execution_id == &manifest.execution_id
                && error_code == "PROVIDER_DISPATCH_FAILED_SAFE"
                && evidence_sha256 == &manifest.evidence_sha256
        }
        OperationalRecoveryOutcome::OutcomeUnknown {
            execution_id,
            reason_code,
            evidence_sha256,
            ..
        } => {
            manifest.terminal == ProviderDispatchRecoveryTerminal::OutcomeUnknown
                && execution_id == &manifest.execution_id
                && reason_code == "PROVIDER_DISPATCH_OUTCOME_UNKNOWN"
                && evidence_sha256 == &manifest.evidence_sha256
        }
    }
}

fn canonical_sha256(value: &serde_json::Value) -> Result<String, serde_json::Error> {
    fn canonicalize(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(canonicalize).collect())
            }
            serde_json::Value::Object(values) => {
                let mut entries = values.into_iter().collect::<Vec<_>>();
                entries.sort_by(|left, right| left.0.cmp(&right.0));
                serde_json::Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key, canonicalize(value)))
                        .collect(),
                )
            }
            scalar => scalar,
        }
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonicalize(value.clone()))?)
    ))
}

#[derive(Debug, Error)]
pub enum ProviderDispatchRecoveryError {
    #[error("Provider dispatch recovery workspace lease does not protect this database")]
    WorkspaceLeaseMismatch,
    #[error("Provider dispatch recovery operation is missing")]
    OperationMissing,
    #[error("Provider dispatch recovery Claim is missing")]
    ClaimMissing,
    #[error("Provider dispatch recovery Execution is missing")]
    ExecutionMissing,
    #[error("Provider dispatch recovery fence does not match")]
    RecoveryFenceMismatch,
    #[error("Provider dispatch recovery action is missing")]
    ActionMissing,
    #[error("Operational recovery action is not a Provider dispatch")]
    ActionNotDispatch,
    #[error("Agent Loop checkpoint changed before Provider dispatch")]
    LoopCheckpointMismatch,
    #[error("Pending Provider inference is missing")]
    PendingInferenceMissing,
    #[error("Provider dispatch identity does not match persisted evidence")]
    ProviderIdentityMismatch,
    #[error("Provider Attempt definition does not match the persisted dispatch action")]
    AttemptDefinitionMismatch,
    #[error("Provider Attempt sequence moved backwards")]
    AttemptSequenceMismatch,
    #[error("Provider dispatch did not cross the transport boundary")]
    DispatchDidNotCrossBoundary,
    #[error("Provider dispatch recovery outcome conflicts with persisted evidence")]
    OutcomeConflict,
    #[error("Provider dispatch recovery operation is waiting or quarantined")]
    OperationNotExecutable,
    #[error("Provider dispatch resume authorization is required")]
    ResumeAuthorizationMissing,
    #[error("Provider dispatch resume authorization is not valid for the original owner")]
    ResumeAuthorizationUnexpected,
    #[error("Provider dispatch resume authorization no longer matches persisted evidence")]
    ResumeEvidenceChanged,
    #[error("Provider dispatch was blocked before crossing the transport boundary: {0}")]
    PreDispatchBlocked(Box<ProviderInferenceServiceError>),
    #[error(transparent)]
    Authorization(#[from] ProviderRecoveryEffectAuthorizationError),
    #[error(transparent)]
    RuntimeJournal(#[from] EventJournalError),
    #[error(transparent)]
    RecoveryAggregate(#[from] OperationalRecoveryAggregateError),
    #[error(transparent)]
    AgentLoopJournal(#[from] AgentLoopJournalError),
    #[error(transparent)]
    AgentLoop(#[from] crate::agent_loop_service::AgentLoopError),
    #[error(transparent)]
    Context(#[from] ContextCompileServiceError),
    #[error(transparent)]
    Attempt(#[from] ProviderAttemptError),
    #[error(transparent)]
    Run(#[from] RunAggregateError),
    #[error(transparent)]
    Provider(#[from] ProviderInferenceServiceError),
    #[error(transparent)]
    Uuid(#[from] uuid::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    WorkspaceJournal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Time(#[from] time::error::Format),
}
