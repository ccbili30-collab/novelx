use novelx_protocol::{
    ContextBudgetAllocation, ContextBudgetCategory, ContextCompilationReceipt, ContextCompile,
    ContextDisclosure, ContextItem as ProtocolContextItem, ContextMessageRole,
    ContextRepresentation, ContextRuntimeExchangeKind, TokenizerIdentity, TokenizerKind,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::context_compiler::{
    CompiledContext, ContextCompileRequest, ContextCompiler, ContextCompilerError, ContextItem,
    ContextItemClass, ContextPolicy, OutputReservePolicy, ToolTranscriptEntry,
};
use crate::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent};
use crate::provider_gateway::{ProviderGatewayError, ProviderRegistry};
use crate::run_aggregate::{RunAggregate, RunAggregateError};
use crate::run_state::RunState;

const AGGREGATE_TYPE: &str = "context";
const EVENT_TYPE: &str = "context.compiled";
const EVENT_VERSION: u32 = 1;
const FALLBACK_ESTIMATOR_ID: &str = "novelx.unicode-mixed-v1";
const FALLBACK_ESTIMATOR_VERSION: &str = "1.0.0";

pub struct ContextCompileService<'a> {
    journal: &'a mut EventJournal,
    providers: &'a ProviderRegistry,
}

impl<'a> ContextCompileService<'a> {
    pub const fn new(journal: &'a mut EventJournal, providers: &'a ProviderRegistry) -> Self {
        Self { journal, providers }
    }

    pub fn compile(
        &mut self,
        run_id: Uuid,
        command_message_id: Uuid,
        command: ContextCompile,
    ) -> Result<ContextCompilationReceipt, ContextCompileServiceError> {
        validate_command(&command)?;
        let run = RunAggregate::recover(self.journal, &run_id.to_string())?;
        validate_pinned_identity(&run, &command)?;
        let request_sha256 = hash_json(&command)?;
        let aggregate_id = aggregate_id(&command);
        let existing =
            self.journal
                .read_aggregate(&run_id.to_string(), AGGREGATE_TYPE, &aggregate_id, 0)?;
        if let Some(event) = existing.first() {
            if existing.len() != 1
                || event.event_type != EVENT_TYPE
                || event.event_version != EVENT_VERSION
            {
                return Err(ContextCompileServiceError::InvalidHistory);
            }
            let record: ContextCompiledRecord = serde_json::from_value(event.payload.clone())
                .map_err(|_| ContextCompileServiceError::InvalidHistory)?;
            if event.idempotency_key == command.compile_idempotency_key
                && record.request_sha256 == request_sha256
            {
                return Ok(record.receipt);
            }
            return Err(ContextCompileServiceError::IdempotencyConflict);
        }

        if !matches!(
            run.state(),
            RunState::Preparing | RunState::Running | RunState::Retrying
        ) {
            return Err(ContextCompileServiceError::RunStateInvalid);
        }

        let bound = self.providers.resolve(&command.provider)?;
        if bound.config().context_window != command.context_window
            || bound.config().max_tokens != command.configured_max_output_tokens
        {
            return Err(ContextCompileServiceError::ProviderCapabilityMismatch);
        }

        let (compile_request, disclosure, source_incomplete) = to_compile_request(&command)?;
        let compiled = ContextCompiler::compile(compile_request)?;
        let receipt = receipt(&command, compiled, disclosure, source_incomplete)?;
        let created_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
        self.journal.append(
            NewRuntimeEvent {
                run_id: run_id.to_string(),
                aggregate_type: AGGREGATE_TYPE.to_owned(),
                aggregate_id,
                message_id: command_message_id.to_string(),
                idempotency_key: command.compile_idempotency_key.clone(),
                event_type: EVENT_TYPE.to_owned(),
                event_version: EVENT_VERSION,
                payload: serde_json::to_value(ContextCompiledRecord {
                    request_sha256,
                    receipt: receipt.clone(),
                })?,
                created_at,
            },
            run.last_run_sequence(),
            0,
        )?;
        Ok(receipt)
    }
}

#[derive(Debug, Error)]
pub enum ContextCompileServiceError {
    #[error("context compile input is invalid: {0}")]
    InvalidInput(&'static str),
    #[error("context compile identity does not match the pinned Run")]
    PinnedIdentityMismatch,
    #[error("context cannot be compiled from the current Run state")]
    RunStateInvalid,
    #[error("context compile Provider capability differs from the bound profile")]
    ProviderCapabilityMismatch,
    #[error("context compile idempotency key conflicts with an existing compilation")]
    IdempotencyConflict,
    #[error("context compilation history is invalid")]
    InvalidHistory,
    #[error(transparent)]
    Compiler(#[from] ContextCompilerError),
    #[error(transparent)]
    Provider(#[from] ProviderGatewayError),
    #[error(transparent)]
    Run(#[from] RunAggregateError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Time(#[from] time::error::Format),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextCompiledRecord {
    request_sha256: String,
    receipt: ContextCompilationReceipt,
}

fn validate_command(command: &ContextCompile) -> Result<(), ContextCompileServiceError> {
    if command.compile_idempotency_key.trim().is_empty()
        || command.invocation_id.trim().is_empty()
        || command.request_number == 0
        || command.compiler_version.trim().is_empty()
        || command.context_window == 0
        || command.items.is_empty()
    {
        return Err(ContextCompileServiceError::InvalidInput("command"));
    }
    Ok(())
}

fn validate_pinned_identity(
    run: &RunAggregate,
    command: &ContextCompile,
) -> Result<(), ContextCompileServiceError> {
    if run.pinned_identity().provider != command.provider
        || run.pinned_identity().context_policy != command.context_policy
    {
        return Err(ContextCompileServiceError::PinnedIdentityMismatch);
    }
    Ok(())
}

fn to_compile_request(
    command: &ContextCompile,
) -> Result<(ContextCompileRequest, ContextDisclosure, bool), ContextCompileServiceError> {
    let mut items = Vec::new();
    let mut transcript = Vec::new();
    let mut disclosure = ContextDisclosure::Public;
    let mut source_incomplete = false;
    for item in &command.items {
        disclosure = max_disclosure(disclosure, item_disclosure(item));
        validate_content_hash(item)?;
        match item {
            ProtocolContextItem::SystemPrompt {
                item_id,
                content,
                required,
                ..
            } => items.push(context_item(
                item_id,
                ContextItemClass::SystemPrompt,
                content.clone(),
                *required,
                u32::MAX,
            )),
            ProtocolContextItem::ToolProtocol {
                item_id,
                tool_name,
                schema_version,
                protocol,
                required,
                ..
            } => items.push(context_item(
                item_id,
                ContextItemClass::ToolProtocol,
                serde_json::to_string(&json!({
                    "toolName": tool_name,
                    "schemaVersion": schema_version,
                    "protocol": protocol,
                }))?,
                *required,
                u32::MAX,
            )),
            ProtocolContextItem::SessionMessage {
                item_id,
                role,
                content,
                required,
                ..
            } => {
                let class = if *required && *role == ContextMessageRole::User {
                    ContextItemClass::CurrentUserTurn
                } else {
                    ContextItemClass::SessionHistory
                };
                items.push(context_item(item_id, class, content.clone(), *required, 80));
            }
            ProtocolContextItem::RetrievalSource {
                item_id,
                content,
                complete,
                required,
                ..
            } => {
                source_incomplete |= !complete;
                items.push(context_item(
                    item_id,
                    ContextItemClass::Retrieval,
                    content.clone(),
                    *required,
                    60,
                ));
            }
            ProtocolContextItem::RuntimeExchange {
                item_id,
                kind,
                content,
                required,
                ..
            } => {
                if matches!(
                    kind,
                    ContextRuntimeExchangeKind::ToolCall | ContextRuntimeExchangeKind::ToolResult
                ) {
                    transcript.push(parse_tool_entry(*kind, content)?);
                }
                items.push(context_item(
                    item_id,
                    ContextItemClass::RuntimeConversation,
                    serde_json::to_string(content)?,
                    *required,
                    90,
                ));
            }
            ProtocolContextItem::OutputReserve { .. } => {}
        }
    }
    let output_reserve = command.configured_max_output_tokens.map_or_else(
        || {
            let target = command
                .context_window
                .saturating_sub(command.safety_reserve_tokens)
                / 4;
            OutputReservePolicy::Auto {
                minimum: 1_024,
                maximum: 32_768,
                target,
            }
        },
        OutputReservePolicy::Fixed,
    );
    Ok((
        ContextCompileRequest {
            policy: ContextPolicy {
                context_window: command.context_window,
                safety_reserve: command.safety_reserve_tokens,
                output_reserve,
                estimator_version: format!("{FALLBACK_ESTIMATOR_ID}@{FALLBACK_ESTIMATOR_VERSION}"),
            },
            items,
            tool_transcript: transcript,
        },
        disclosure,
        source_incomplete,
    ))
}

fn context_item(
    item_id: &str,
    class: ContextItemClass,
    content: String,
    required: bool,
    priority: u32,
) -> ContextItem {
    if required {
        ContextItem::required(item_id, class, content)
    } else {
        ContextItem::optional(item_id, class, content, priority)
    }
}

fn parse_tool_entry(
    kind: ContextRuntimeExchangeKind,
    content: &Value,
) -> Result<ToolTranscriptEntry, ContextCompileServiceError> {
    let object = content
        .as_object()
        .ok_or(ContextCompileServiceError::InvalidInput("tool exchange"))?;
    let string = |name: &'static str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or(ContextCompileServiceError::InvalidInput(name))
    };
    match kind {
        ContextRuntimeExchangeKind::ToolCall => Ok(ToolTranscriptEntry::Call {
            tool_call_id: string("toolCallId")?,
            tool_name: string("toolName")?,
            arguments_sha256: string("argumentsSha256")?,
        }),
        ContextRuntimeExchangeKind::ToolResult => Ok(ToolTranscriptEntry::Result {
            tool_call_id: string("toolCallId")?,
            tool_name: string("toolName")?,
            result_sha256: string("resultSha256")?,
            is_error: object
                .get("isError")
                .and_then(Value::as_bool)
                .ok_or(ContextCompileServiceError::InvalidInput("isError"))?,
        }),
        _ => Err(ContextCompileServiceError::InvalidInput(
            "tool exchange kind",
        )),
    }
}

fn validate_content_hash(item: &ProtocolContextItem) -> Result<(), ContextCompileServiceError> {
    let (content, expected) = match item {
        ProtocolContextItem::SystemPrompt {
            content,
            content_sha256,
            ..
        }
        | ProtocolContextItem::SessionMessage {
            content,
            content_sha256,
            ..
        }
        | ProtocolContextItem::RetrievalSource {
            content,
            content_sha256,
            ..
        } => (content.as_bytes().to_vec(), content_sha256),
        ProtocolContextItem::ToolProtocol {
            protocol,
            content_sha256,
            ..
        }
        | ProtocolContextItem::RuntimeExchange {
            content: protocol,
            content_sha256,
            ..
        } => (serde_json::to_vec(protocol)?, content_sha256),
        ProtocolContextItem::OutputReserve { .. } => return Ok(()),
    };
    if format!("{:x}", Sha256::digest(content)) != *expected {
        return Err(ContextCompileServiceError::InvalidInput("content_sha256"));
    }
    Ok(())
}

fn receipt(
    command: &ContextCompile,
    compiled: CompiledContext,
    disclosure: ContextDisclosure,
    source_incomplete: bool,
) -> Result<ContextCompilationReceipt, ContextCompileServiceError> {
    let budget = vec![
        allocation(
            ContextBudgetCategory::SystemPrompt,
            compiled.breakdown.system_prompt_tokens,
        ),
        allocation(
            ContextBudgetCategory::ToolProtocol,
            compiled.breakdown.tool_protocol_tokens,
        ),
        allocation(
            ContextBudgetCategory::SessionHistory,
            compiled.breakdown.session_history_tokens,
        ),
        allocation(
            ContextBudgetCategory::Collaboration,
            compiled.breakdown.collaboration_tokens,
        ),
        allocation(
            ContextBudgetCategory::Retrieval,
            compiled.breakdown.retrieval_tokens,
        ),
        allocation(
            ContextBudgetCategory::RuntimeConversation,
            compiled
                .breakdown
                .runtime_conversation_tokens
                .saturating_add(compiled.breakdown.current_user_turn_tokens),
        ),
        allocation(
            ContextBudgetCategory::OutputReserve,
            compiled.breakdown.output_reserve,
        ),
        allocation(
            ContextBudgetCategory::SafetyReserve,
            compiled.breakdown.safety_reserve,
        ),
        allocation(ContextBudgetCategory::AccountingOverhead, 0),
    ];
    let incomplete = source_incomplete || compiled.completeness.incomplete;
    Ok(ContextCompilationReceipt {
        compilation_id: Uuid::new_v4(),
        request_number: command.request_number,
        compiler_version: command.compiler_version.clone(),
        tokenizer: TokenizerIdentity {
            kind: TokenizerKind::FallbackEstimate,
            id: FALLBACK_ESTIMATOR_ID.to_owned(),
            version: FALLBACK_ESTIMATOR_VERSION.to_owned(),
            provider_id: Some(command.provider.provider_id.clone()),
            model_id: Some(command.provider.model_id.clone()),
        },
        representation: ContextRepresentation::NormalizedMessages,
        canonical_context_sha256: compiled.packet_sha256,
        serialized_input_bytes: u64::try_from(compiled.packet.len())
            .map_err(|_| ContextCompileServiceError::InvalidInput("serialized input size"))?,
        estimated_input_tokens: compiled.breakdown.estimated_input_tokens,
        exact_input_tokens: None,
        context_window: compiled.context_window,
        safety_reserve_tokens: compiled.breakdown.safety_reserve,
        output_reserve_tokens: compiled.breakdown.output_reserve,
        available_input_tokens: compiled.breakdown.available_input_budget,
        accepted: true,
        budget,
        included_item_ids: compiled.included_item_ids,
        omitted_item_ids: compiled.completeness.omitted_item_ids,
        incomplete,
        disclosure,
    })
}

const fn allocation(
    category: ContextBudgetCategory,
    estimated_tokens: u64,
) -> ContextBudgetAllocation {
    ContextBudgetAllocation {
        category,
        estimated_tokens,
    }
}

fn item_disclosure(item: &ProtocolContextItem) -> ContextDisclosure {
    match item {
        ProtocolContextItem::SystemPrompt { disclosure, .. }
        | ProtocolContextItem::ToolProtocol { disclosure, .. }
        | ProtocolContextItem::SessionMessage { disclosure, .. }
        | ProtocolContextItem::RetrievalSource { disclosure, .. }
        | ProtocolContextItem::RuntimeExchange { disclosure, .. }
        | ProtocolContextItem::OutputReserve { disclosure, .. } => *disclosure,
    }
}

fn max_disclosure(left: ContextDisclosure, right: ContextDisclosure) -> ContextDisclosure {
    if disclosure_rank(right) > disclosure_rank(left) {
        right
    } else {
        left
    }
}

const fn disclosure_rank(value: ContextDisclosure) -> u8 {
    match value {
        ContextDisclosure::Public => 0,
        ContextDisclosure::ProjectPrivate => 1,
        ContextDisclosure::AgentInternal => 2,
        ContextDisclosure::PlayerHidden => 3,
    }
}

fn hash_json<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

fn aggregate_id(command: &ContextCompile) -> String {
    format!("{}:{}", command.invocation_id, command.request_number)
}
