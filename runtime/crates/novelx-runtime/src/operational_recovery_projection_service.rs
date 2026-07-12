use std::path::{Path, PathBuf};

use novelx_protocol::{
    ProviderInferenceCompleted, ProviderInferenceIdentity, ProviderInferenceOutput,
    ProviderInferenceUsage,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    agent_loop_journal::{
        AgentLoopEventMetadata, AgentLoopJournalError, AgentLoopJournalRepository,
    },
    artifact_store::{ArtifactStore, ArtifactStoreError},
    event_journal::{EventJournal, EventJournalError},
    operational_recovery_scanner::OperationalRecoveryAction,
    provider_attempt::{ProviderAttemptAggregate, ProviderAttemptError, ProviderAttemptState},
    provider_tool_materializer::{ProviderToolMaterializer, ProviderToolMaterializerError},
    run_aggregate::{RunAggregate, RunAggregateError},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistedProviderProjectionRequest {
    pub run_id: String,
    pub execution_id: String,
    pub action: OperationalRecoveryAction,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistedProviderProjectionManifest {
    pub run_id: String,
    pub invocation_id: String,
    pub attempt_id: String,
    pub execution_id: String,
    pub resulting_loop_checkpoint_sha256: String,
    pub directive: PersistedProviderProjectionDirective,
    pub manifest_sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersistedProviderProjectionDirective {
    Completed,
    AwaitApproval,
    AwaitToolResults,
}

pub struct OperationalRecoveryProjectionService {
    database_path: PathBuf,
}

impl OperationalRecoveryProjectionService {
    pub fn new(database_path: impl AsRef<Path>) -> Self {
        Self {
            database_path: database_path.as_ref().to_owned(),
        }
    }

    pub fn project_persisted_provider_result(
        &self,
        request: PersistedProviderProjectionRequest,
    ) -> Result<PersistedProviderProjectionManifest, OperationalRecoveryProjectionError> {
        require_text("run_id", &request.run_id)?;
        require_text("execution_id", &request.execution_id)?;
        let OperationalRecoveryAction::PersistedProviderResultProjection {
            invocation_id,
            attempt_id,
            expected_loop_checkpoint_sha256,
            expected_attempt_sequence,
            response_body_sha256,
        } = request.action
        else {
            return Err(OperationalRecoveryProjectionError::ActionNotProjectable);
        };

        let command_key = format!(
            "operational-recovery:{}:provider-result",
            request.execution_id
        );

        let mut journal = EventJournal::open(&self.database_path)?;
        let repository = AgentLoopJournalRepository::new(&mut journal);
        if let Some(existing) =
            repository.recover_if_last_command(&request.run_id, &invocation_id, &command_key)?
        {
            let directive = directive_from_phase(existing.service.phase())?;
            return manifest(
                request.run_id,
                invocation_id,
                attempt_id,
                request.execution_id,
                existing.service.checkpoint_sha256()?,
                directive,
            );
        }
        let mut loop_record = repository.recover(&request.run_id, &invocation_id)?;
        if loop_record.service.checkpoint_sha256()? != expected_loop_checkpoint_sha256 {
            return Err(OperationalRecoveryProjectionError::LoopCheckpointChanged);
        }
        let dispatch = loop_record
            .service
            .pending_inference()
            .cloned()
            .ok_or(OperationalRecoveryProjectionError::PendingInferenceMissing)?;
        if dispatch.attempt_id.to_string() != attempt_id {
            return Err(OperationalRecoveryProjectionError::ProviderIdentityMismatch);
        }
        let attempt = ProviderAttemptAggregate::recover(&journal, &request.run_id, &attempt_id)?;
        let run = RunAggregate::recover(&journal, &request.run_id)?;
        if attempt.aggregate_sequence() != expected_attempt_sequence
            || attempt.state() != ProviderAttemptState::Responded
            || attempt.definition().invocation_id != invocation_id
            || attempt.definition().inference_id != dispatch.inference_id.to_string()
            || attempt.definition().context_compilation_id != dispatch.context_compilation_id
            || attempt.definition().request_number != dispatch.request_number
            || attempt.definition().attempt_number != dispatch.attempt_number
            || attempt.definition().provider != run.pinned_identity().provider
        {
            return Err(OperationalRecoveryProjectionError::ProviderIdentityMismatch);
        }
        let receipt = attempt
            .response_receipt()
            .ok_or(OperationalRecoveryProjectionError::ProviderReceiptMissing)?;
        if receipt.response_body_sha256 != response_body_sha256 {
            return Err(OperationalRecoveryProjectionError::ProviderResponseChanged);
        }
        if receipt.actual_provider_id != run.pinned_identity().provider.provider_id
            || receipt.actual_model_id != run.pinned_identity().provider.model_id
        {
            return Err(OperationalRecoveryProjectionError::ProviderIdentityMismatch);
        }
        let response_id_sha256 = receipt
            .response_id_sha256
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or(OperationalRecoveryProjectionError::ProviderReceiptMissing)?;
        let completion = ProviderInferenceCompleted {
            identity: ProviderInferenceIdentity {
                run_id: Uuid::parse_str(&request.run_id)?,
                inference_id: dispatch.inference_id,
                attempt_id: dispatch.attempt_id,
                context_compilation_id: dispatch.context_compilation_id,
                request_number: dispatch.request_number,
                attempt_number: u64::from(dispatch.attempt_number),
            },
            provider_id: receipt.actual_provider_id.clone(),
            model_id: receipt.actual_model_id.clone(),
            response_id_sha256,
            response_body_sha256: receipt.response_body_sha256.clone(),
            stop_reason: receipt.stop_reason.clone(),
            usage: ProviderInferenceUsage {
                input_tokens: receipt.input_tokens,
                output_tokens: receipt.output_tokens,
                total_tokens: receipt.total_tokens,
            },
            output: attempt.response_text().map(|text| ProviderInferenceOutput {
                text: text.to_owned(),
                text_sha256: attempt
                    .response_text_sha256()
                    .unwrap_or_else(|| unreachable!("responded text hash validated on replay"))
                    .to_owned(),
                utf8_bytes: u64::try_from(text.len()).unwrap_or(u64::MAX),
            }),
            tool_calls: attempt.tool_calls().to_vec(),
        };
        let materialized = {
            let mut artifacts = ArtifactStore::open(&self.database_path)?;
            ProviderToolMaterializer::new(&mut artifacts).materialize(
                &request.run_id,
                &invocation_id,
                &dispatch.inference_id.to_string(),
                &completion.tool_calls,
            )?
        };
        let previous = loop_record.service.clone();
        let directive = loop_record
            .service
            .accept_provider_outcome(completion, materialized)?;
        let directive_kind = match &directive {
            crate::agent_loop_service::AgentLoopDirective::Completed { .. } => {
                PersistedProviderProjectionDirective::Completed
            }
            crate::agent_loop_service::AgentLoopDirective::AwaitApproval(_) => {
                PersistedProviderProjectionDirective::AwaitApproval
            }
            crate::agent_loop_service::AgentLoopDirective::ExecuteTools(_) => {
                PersistedProviderProjectionDirective::AwaitToolResults
            }
            _ => return Err(OperationalRecoveryProjectionError::DirectiveInvalid),
        };
        let created_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
        loop_record = AgentLoopJournalRepository::new(&mut journal).append_transition(
            &previous,
            &loop_record.service,
            &directive,
            &command_key,
            AgentLoopEventMetadata {
                message_id: &command_key,
                created_at: &created_at,
            },
        )?;
        manifest(
            request.run_id,
            invocation_id,
            attempt_id,
            request.execution_id,
            loop_record.service.checkpoint_sha256()?,
            directive_kind,
        )
    }
}

fn directive_from_phase(
    phase: crate::agent_loop_service::LoopPhase,
) -> Result<PersistedProviderProjectionDirective, OperationalRecoveryProjectionError> {
    match phase {
        crate::agent_loop_service::LoopPhase::Completed => {
            Ok(PersistedProviderProjectionDirective::Completed)
        }
        crate::agent_loop_service::LoopPhase::AwaitingApproval => {
            Ok(PersistedProviderProjectionDirective::AwaitApproval)
        }
        crate::agent_loop_service::LoopPhase::AwaitingToolResults => {
            Ok(PersistedProviderProjectionDirective::AwaitToolResults)
        }
        _ => Err(OperationalRecoveryProjectionError::DirectiveInvalid),
    }
}

fn manifest(
    run_id: String,
    invocation_id: String,
    attempt_id: String,
    execution_id: String,
    resulting_loop_checkpoint_sha256: String,
    directive: PersistedProviderProjectionDirective,
) -> Result<PersistedProviderProjectionManifest, OperationalRecoveryProjectionError> {
    let material = serde_json::json!({
        "runId": run_id,
        "invocationId": invocation_id,
        "attemptId": attempt_id,
        "executionId": execution_id,
        "resultingLoopCheckpointSha256": resulting_loop_checkpoint_sha256,
        "directive": directive,
    });
    let manifest_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(&material)?));
    Ok(PersistedProviderProjectionManifest {
        run_id,
        invocation_id,
        attempt_id,
        execution_id,
        resulting_loop_checkpoint_sha256,
        directive,
        manifest_sha256,
    })
}

fn require_text(
    field: &'static str,
    value: &str,
) -> Result<(), OperationalRecoveryProjectionError> {
    if value.trim().is_empty() {
        Err(OperationalRecoveryProjectionError::EmptyField(field))
    } else {
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum OperationalRecoveryProjectionError {
    #[error("operational recovery projection field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("operational recovery action is not a persisted Provider result projection")]
    ActionNotProjectable,
    #[error("agent loop checkpoint changed before local projection")]
    LoopCheckpointChanged,
    #[error("pending Provider inference is missing")]
    PendingInferenceMissing,
    #[error("persisted Provider identity does not match the pending inference")]
    ProviderIdentityMismatch,
    #[error("persisted Provider receipt is incomplete")]
    ProviderReceiptMissing,
    #[error("persisted Provider response changed before local projection")]
    ProviderResponseChanged,
    #[error("persisted Provider result produced an unsupported local directive")]
    DirectiveInvalid,
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    AgentLoopJournal(#[from] AgentLoopJournalError),
    #[error(transparent)]
    AgentLoop(#[from] crate::agent_loop_service::AgentLoopError),
    #[error(transparent)]
    ProviderAttempt(#[from] ProviderAttemptError),
    #[error(transparent)]
    Run(#[from] RunAggregateError),
    #[error(transparent)]
    Artifact(#[from] ArtifactStoreError),
    #[error(transparent)]
    Materializer(#[from] ProviderToolMaterializerError),
    #[error(transparent)]
    Uuid(#[from] uuid::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Time(#[from] time::error::Format),
}
