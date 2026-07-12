use novelx_protocol::{
    ContextCompilationReceipt, ContextDisclosure, ContextItem, ContextRuntimeExchangeKind,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::agent_loop_service::ContextCompileIntent;
use crate::context_compile_service::{
    ContextCompileService, ContextCompileServiceError, recover_compiled_record,
};
use crate::event_journal::EventJournal;
use crate::provider_gateway::ProviderRegistry;

pub struct ContinuationContextService<'a> {
    journal: &'a mut EventJournal,
    providers: &'a ProviderRegistry,
}

impl<'a> ContinuationContextService<'a> {
    pub const fn new(journal: &'a mut EventJournal, providers: &'a ProviderRegistry) -> Self {
        Self { journal, providers }
    }

    pub fn apply(
        &mut self,
        run_id: Uuid,
        command_message_id: Uuid,
        base_compilation_id: Uuid,
        intent: &ContextCompileIntent,
    ) -> Result<ContextCompilationReceipt, ContinuationContextServiceError> {
        let base = recover_compiled_record(self.journal, &run_id.to_string(), base_compilation_id)?;
        if !base.receipt.accepted
            || intent.request_number != base.receipt.request_number + 1
            || intent.round == 0
            || intent.assistant_message_id.trim().is_empty()
            || intent.exchanges.is_empty()
        {
            return Err(ContinuationContextServiceError::IntentInvalid);
        }
        let mut command = base
            .source_command
            .ok_or(ContinuationContextServiceError::SourceCommandUnavailable)?;
        if command.request_number != base.receipt.request_number {
            return Err(ContinuationContextServiceError::SourceCommandInvalid);
        }
        validate_intent(intent)?;
        let intent_sha256 = intent_sha256(intent)?;
        command.compile_idempotency_key =
            format!("continuation:{base_compilation_id}:{intent_sha256}");
        command.request_number = intent.request_number;
        let insertion = command
            .items
            .iter()
            .position(|item| matches!(item, ContextItem::OutputReserve { .. }))
            .unwrap_or(command.items.len());
        let exchanges = intent
            .exchanges
            .iter()
            .enumerate()
            .map(|(index, exchange)| ContextItem::RuntimeExchange {
                item_id: format!(
                    "continuation:{}:{}:{index}",
                    intent.request_number, intent.assistant_message_id
                ),
                exchange_id: format!("{}:{index}", intent.assistant_message_id),
                kind: exchange.kind,
                content: exchange.content.clone(),
                content_sha256: exchange.content_sha256.clone(),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            })
            .collect::<Vec<_>>();
        command.items.splice(insertion..insertion, exchanges);

        ContextCompileService::new(self.journal, self.providers)
            .compile(run_id, command_message_id, command)
            .map_err(ContinuationContextServiceError::Compile)
    }
}

fn validate_intent(intent: &ContextCompileIntent) -> Result<(), ContinuationContextServiceError> {
    let mut call_count = 0usize;
    let mut result_count = 0usize;
    for exchange in &intent.exchanges {
        if hash_json(&exchange.content)? != exchange.content_sha256 {
            return Err(ContinuationContextServiceError::IntentHashMismatch);
        }
        match exchange.kind {
            ContextRuntimeExchangeKind::ToolCall => {
                if exchange.content["assistantMessageId"].as_str()
                    != Some(intent.assistant_message_id.as_str())
                {
                    return Err(ContinuationContextServiceError::IntentInvalid);
                }
                call_count += 1;
            }
            ContextRuntimeExchangeKind::ToolResult => result_count += 1,
            _ => return Err(ContinuationContextServiceError::IntentInvalid),
        }
    }
    if call_count == 0 || call_count != result_count {
        return Err(ContinuationContextServiceError::IntentInvalid);
    }
    Ok(())
}

fn intent_sha256(intent: &ContextCompileIntent) -> Result<String, ContinuationContextServiceError> {
    hash_json(&json!({
        "round": intent.round,
        "requestNumber": intent.request_number,
        "assistantMessageId": intent.assistant_message_id,
        "exchanges": intent.exchanges.iter().map(|exchange| json!({
            "kind": exchange.kind,
            "contentSha256": exchange.content_sha256,
        })).collect::<Vec<_>>(),
    }))
}

fn hash_json(value: &serde_json::Value) -> Result<String, ContinuationContextServiceError> {
    serde_json::to_vec(value)
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
        .map_err(|_| ContinuationContextServiceError::Serialization)
}

#[derive(Debug, Error)]
pub enum ContinuationContextServiceError {
    #[error("continuation context intent is invalid")]
    IntentInvalid,
    #[error("continuation context exchange hash does not match its content")]
    IntentHashMismatch,
    #[error("base context record does not contain its source command")]
    SourceCommandUnavailable,
    #[error("base context source command does not match its receipt")]
    SourceCommandInvalid,
    #[error("continuation context intent could not be serialized")]
    Serialization,
    #[error(transparent)]
    Compile(#[from] ContextCompileServiceError),
}
