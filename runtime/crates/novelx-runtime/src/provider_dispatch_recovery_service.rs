use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use novelx_protocol::ProviderRunIdentity;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    agent_loop_journal::{AgentLoopJournalError, AgentLoopJournalRepository},
    context_compile_service::{ContextCompileServiceError, recover_compilation_receipt},
    event_journal::{EventJournal, EventJournalError},
    operational_recovery_action::OperationalRecoveryAction,
    operational_recovery_aggregate::{
        OperationalRecoveryAggregateError, OperationalRecoveryEffectClass,
        OperationalRecoveryEventMetadata, OperationalRecoveryOutcome,
        OperationalRecoveryRepository,
    },
    provider_attempt::{ProviderAttemptAggregate, ProviderAttemptError, ProviderAttemptState},
    provider_gateway::{ProviderGateway, ProviderInferenceRequest, ProviderRegistry},
    provider_inference_service::{
        ProviderInferenceExecution, ProviderInferenceService, ProviderInferenceServiceError,
    },
    run_aggregate::{RunAggregate, RunAggregateError},
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
        exclusive_lease: &WorkspaceRuntimeLease,
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
        dispatch.verify_attempt(&request.run_id, &attempt_before)?;
        if operation.outcome.is_some() {
            return self.finish_from_attempt(request, &dispatch, exclusive_lease);
        }
        if !exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id) {
            return Err(ProviderDispatchRecoveryError::RecoveryFenceMismatch);
        }
        let _single_flight = ProviderDispatchSingleFlight::acquire(
            &self.database_path,
            &request.operation_id,
            &request.execution_id,
        )?;
        if attempt_before.state() == ProviderAttemptState::Requested {
            let provider_execution = self.reconstruct_execution(&request.run_id, &dispatch)?;
            let result = {
                let mut journal = EventJournal::open(&self.database_path)?;
                ProviderInferenceService::new(&mut journal, providers, gateway)
                    .execute(provider_execution)
                    .await
            };
            if let Err(error) = result {
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
        self.finish_from_attempt(request, &dispatch, exclusive_lease)
    }

    fn reconstruct_execution(
        &self,
        run_id: &str,
        dispatch: &DispatchEvidence,
    ) -> Result<ProviderInferenceExecution, ProviderDispatchRecoveryError> {
        let mut journal = EventJournal::open(&self.database_path)?;
        let loop_record = AgentLoopJournalRepository::new(&mut journal)
            .recover(run_id, &dispatch.invocation_id)?;
        if loop_record.service.checkpoint_sha256()? != dispatch.expected_loop_checkpoint_sha256 {
            return Err(ProviderDispatchRecoveryError::LoopCheckpointMismatch);
        }
        let pending = loop_record
            .service
            .pending_inference()
            .ok_or(ProviderDispatchRecoveryError::PendingInferenceMissing)?;
        if pending.attempt_id.to_string() != dispatch.attempt_id
            || pending.inference_id.to_string() != dispatch.inference_id
            || pending.context_compilation_id.to_string() != dispatch.context_compilation_id
            || pending.attempt_number != dispatch.attempt_number
        {
            return Err(ProviderDispatchRecoveryError::ProviderIdentityMismatch);
        }
        let run = RunAggregate::recover(&journal, run_id)?;
        if run.pinned_identity().provider != dispatch.provider {
            return Err(ProviderDispatchRecoveryError::ProviderIdentityMismatch);
        }
        let compilation_id = Uuid::parse_str(&dispatch.context_compilation_id)?;
        let receipt = recover_compilation_receipt(&journal, run_id, compilation_id)?;
        Ok(ProviderInferenceExecution {
            run_id: run_id.to_owned(),
            attempt_id: dispatch.attempt_id.clone(),
            inference_id: dispatch.inference_id.clone(),
            invocation_id: dispatch.invocation_id.clone(),
            inference_idempotency_key: pending.inference_idempotency_key.clone(),
            attempt_number: dispatch.attempt_number,
            provider: dispatch.provider.clone(),
            request: ProviderInferenceRequest {
                compilation: receipt,
                messages: vec![],
                tools: vec![],
            },
        })
    }

    fn finish_from_attempt(
        &self,
        request: ProviderDispatchRecoveryRequest,
        dispatch: &DispatchEvidence,
        exclusive_lease: &WorkspaceRuntimeLease,
    ) -> Result<ProviderDispatchRecoveryReceipt, ProviderDispatchRecoveryError> {
        let journal = EventJournal::open(&self.database_path)?;
        let attempt =
            ProviderAttemptAggregate::recover(&journal, &request.run_id, &dispatch.attempt_id)?;
        dispatch.verify_attempt(&request.run_id, &attempt)?;
        let evidence = serde_json::json!({
            "attemptId": dispatch.attempt_id,
            "aggregateSequence": attempt.aggregate_sequence(),
            "state": attempt.state(),
            "definition": attempt.definition(),
            "dispatchId": attempt.dispatch_id(),
            "response": attempt.response_receipt(),
            "responseTextSha256": attempt.response_text_sha256(),
            "toolCalls": attempt.tool_calls(),
            "failure": attempt.failure(),
        });
        let evidence_sha256 = canonical_sha256(&evidence)?;
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
        self.finish_recovery_operation(&request, &manifest, exclusive_lease)?;
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
        if !exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id) {
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
            clock,
            OperationalRecoveryEventMetadata { created_at: now },
        )?;
        Ok(())
    }
}

static ACTIVE_PROVIDER_DISPATCHES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct ProviderDispatchSingleFlight {
    key: String,
}

impl ProviderDispatchSingleFlight {
    fn acquire(
        database_path: &Path,
        operation_id: &str,
        execution_id: &str,
    ) -> Result<Self, ProviderDispatchRecoveryError> {
        let key = format!(
            "{}:{operation_id}:{execution_id}",
            database_path
                .canonicalize()
                .unwrap_or_else(|_| database_path.to_owned())
                .display()
        );
        let mut active = ACTIVE_PROVIDER_DISPATCHES
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .map_err(|_| ProviderDispatchRecoveryError::DispatchGuardPoisoned)?;
        if !active.insert(key.clone()) {
            return Err(ProviderDispatchRecoveryError::DispatchAlreadyInFlight);
        }
        Ok(Self { key })
    }
}

impl Drop for ProviderDispatchSingleFlight {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_PROVIDER_DISPATCHES
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
        {
            active.remove(&self.key);
        }
    }
}

#[derive(Clone)]
struct DispatchEvidence {
    invocation_id: String,
    attempt_id: String,
    inference_id: String,
    context_compilation_id: String,
    attempt_number: u16,
    provider: ProviderRunIdentity,
    canonical_context_sha256: String,
    transport_payload_sha256: String,
    expected_loop_checkpoint_sha256: String,
    expected_attempt_sequence: u64,
}

impl DispatchEvidence {
    fn from_action(
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

    fn verify_attempt(
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
    #[error("Provider dispatch was blocked before crossing the transport boundary: {0}")]
    PreDispatchBlocked(Box<ProviderInferenceServiceError>),
    #[error("Provider dispatch execution is already in flight in this Runtime instance")]
    DispatchAlreadyInFlight,
    #[error("Provider dispatch single-flight guard is poisoned")]
    DispatchGuardPoisoned,
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
