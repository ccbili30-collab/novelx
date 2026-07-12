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
use crate::provider_gateway::{
    ProviderGatewayError, ProviderInferenceFunctionCall, ProviderInferenceMessage,
    ProviderInferenceRole, ProviderInferenceToolCall, ProviderRegistry,
};
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
        let normalized_input = normalized_provider_input(&command, &compiled.included_item_ids)?;
        let normalized_input_sha256 = hash_json(&normalized_input)?;
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
                    source_command: Some(command.clone()),
                    normalized_input,
                    normalized_input_sha256,
                })?,
                created_at,
            },
            run.last_run_sequence(),
            0,
        )?;
        Ok(receipt)
    }
}

pub fn recover_compilation_receipt(
    journal: &EventJournal,
    run_id: &str,
    compilation_id: Uuid,
) -> Result<ContextCompilationReceipt, ContextCompileServiceError> {
    let mut found = None;
    for event in journal.read_run(run_id, 0)? {
        if event.event_type != EVENT_TYPE || event.event_version != EVENT_VERSION {
            continue;
        }
        let record: ContextCompiledRecord = serde_json::from_value(event.payload)
            .map_err(|_| ContextCompileServiceError::InvalidHistory)?;
        if record.receipt.compilation_id == compilation_id
            && found.replace(record.receipt).is_some()
        {
            return Err(ContextCompileServiceError::InvalidHistory);
        }
    }
    found.ok_or(ContextCompileServiceError::CompilationNotFound)
}

pub(crate) fn recover_compiled_record(
    journal: &EventJournal,
    run_id: &str,
    compilation_id: Uuid,
) -> Result<ContextCompiledRecord, ContextCompileServiceError> {
    let mut found = None;
    for event in journal.read_run(run_id, 0)? {
        if event.event_type != EVENT_TYPE || event.event_version != EVENT_VERSION {
            continue;
        }
        let record: ContextCompiledRecord = serde_json::from_value(event.payload)
            .map_err(|_| ContextCompileServiceError::InvalidHistory)?;
        if record.receipt.compilation_id == compilation_id && found.replace(record).is_some() {
            return Err(ContextCompileServiceError::InvalidHistory);
        }
    }
    found.ok_or(ContextCompileServiceError::CompilationNotFound)
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
    #[error("context compilation was not found for this Run")]
    CompilationNotFound,
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
pub(crate) struct ContextCompiledRecord {
    pub(crate) request_sha256: String,
    pub(crate) receipt: ContextCompilationReceipt,
    #[serde(default)]
    pub(crate) source_command: Option<ContextCompile>,
    pub(crate) normalized_input: PersistedNormalizedProviderInput,
    pub(crate) normalized_input_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PersistedNormalizedProviderInput {
    pub(crate) messages: Vec<ProviderInferenceMessage>,
    pub(crate) tools: Vec<Value>,
}

pub(crate) fn normalized_provider_input_sha256(
    input: &PersistedNormalizedProviderInput,
) -> Result<String, serde_json::Error> {
    hash_json(input)
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
                let is_tool_exchange = matches!(
                    kind,
                    ContextRuntimeExchangeKind::ToolCall | ContextRuntimeExchangeKind::ToolResult
                );
                items.push(context_item(
                    item_id,
                    ContextItemClass::RuntimeConversation,
                    serde_json::to_string(content)?,
                    *required || is_tool_exchange,
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

fn normalized_provider_input(
    command: &ContextCompile,
    included_item_ids: &[String],
) -> Result<PersistedNormalizedProviderInput, ContextCompileServiceError> {
    let mut messages = Vec::new();
    let mut tools = Vec::new();
    let mut pending_tool_calls: Option<(String, Vec<ProviderInferenceToolCall>)> = None;
    for item in &command.items {
        let item_id = protocol_item_id(item);
        if !included_item_ids.iter().any(|included| included == item_id) {
            continue;
        }
        if let ProtocolContextItem::RuntimeExchange {
            kind: ContextRuntimeExchangeKind::ToolCall,
            content,
            ..
        } = item
        {
            let (group_id, call) = provider_tool_call(content)?;
            match &mut pending_tool_calls {
                Some((current_group, calls)) if current_group == &group_id => calls.push(call),
                Some(_) => {
                    return Err(ContextCompileServiceError::InvalidInput(
                        "tool call group ordering",
                    ));
                }
                None => pending_tool_calls = Some((group_id, vec![call])),
            }
            continue;
        }
        flush_tool_calls(&mut messages, &mut pending_tool_calls);
        match item {
            ProtocolContextItem::SystemPrompt { content, .. } => {
                messages.push(provider_message(
                    ProviderInferenceRole::System,
                    content.clone(),
                ));
            }
            ProtocolContextItem::ToolProtocol { protocol, .. } => tools.push(protocol.clone()),
            ProtocolContextItem::SessionMessage { role, content, .. } => {
                let role = match role {
                    ContextMessageRole::User => ProviderInferenceRole::User,
                    ContextMessageRole::Assistant => ProviderInferenceRole::Assistant,
                };
                messages.push(provider_message(role, content.clone()));
            }
            ProtocolContextItem::RetrievalSource { content, .. } => {
                messages.push(provider_message(
                    ProviderInferenceRole::User,
                    content.clone(),
                ));
            }
            ProtocolContextItem::RuntimeExchange { kind, content, .. } => {
                messages.push(match kind {
                    ContextRuntimeExchangeKind::UserMessage
                    | ContextRuntimeExchangeKind::Correction => provider_message(
                        ProviderInferenceRole::User,
                        serde_json::to_string(content)?,
                    ),
                    ContextRuntimeExchangeKind::AssistantMessage => provider_message(
                        ProviderInferenceRole::Assistant,
                        serde_json::to_string(content)?,
                    ),
                    ContextRuntimeExchangeKind::ToolCall => unreachable!(),
                    ContextRuntimeExchangeKind::ToolResult => {
                        provider_tool_result_message(content)?
                    }
                });
            }
            ProtocolContextItem::OutputReserve { .. } => {}
        }
    }
    flush_tool_calls(&mut messages, &mut pending_tool_calls);
    if messages.is_empty() {
        return Err(ContextCompileServiceError::InvalidInput(
            "normalized provider messages",
        ));
    }
    Ok(PersistedNormalizedProviderInput { messages, tools })
}

fn protocol_item_id(item: &ProtocolContextItem) -> &str {
    match item {
        ProtocolContextItem::SystemPrompt { item_id, .. }
        | ProtocolContextItem::ToolProtocol { item_id, .. }
        | ProtocolContextItem::SessionMessage { item_id, .. }
        | ProtocolContextItem::RetrievalSource { item_id, .. }
        | ProtocolContextItem::RuntimeExchange { item_id, .. }
        | ProtocolContextItem::OutputReserve { item_id, .. } => item_id,
    }
}

fn provider_message(role: ProviderInferenceRole, content: String) -> ProviderInferenceMessage {
    ProviderInferenceMessage {
        role,
        content,
        tool_calls: Vec::new(),
        tool_call_id: None,
    }
}

fn provider_tool_call(
    content: &Value,
) -> Result<(String, ProviderInferenceToolCall), ContextCompileServiceError> {
    let (tool_call_id, tool_name, value) = tool_exchange_value(content, "arguments")?;
    let assistant_message_id = content
        .get("assistantMessageId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(ContextCompileServiceError::InvalidInput(
            "assistantMessageId",
        ))?
        .to_owned();
    Ok((
        assistant_message_id,
        ProviderInferenceToolCall {
            id: tool_call_id,
            call_type: "function".to_owned(),
            function: ProviderInferenceFunctionCall {
                name: tool_name,
                arguments: serde_json::to_string(value)?,
            },
        },
    ))
}

fn flush_tool_calls(
    messages: &mut Vec<ProviderInferenceMessage>,
    pending: &mut Option<(String, Vec<ProviderInferenceToolCall>)>,
) {
    let Some((_assistant_message_id, tool_calls)) = pending.take() else {
        return;
    };
    messages.push(ProviderInferenceMessage {
        role: ProviderInferenceRole::Assistant,
        content: String::new(),
        tool_calls,
        tool_call_id: None,
    });
}

fn provider_tool_result_message(
    content: &Value,
) -> Result<ProviderInferenceMessage, ContextCompileServiceError> {
    let (tool_call_id, _tool_name, value) = tool_exchange_value(content, "result")?;
    Ok(ProviderInferenceMessage {
        role: ProviderInferenceRole::Tool,
        content: serde_json::to_string(value)?,
        tool_calls: Vec::new(),
        tool_call_id: Some(tool_call_id),
    })
}

fn tool_exchange_value<'a>(
    content: &'a Value,
    value_name: &'static str,
) -> Result<(String, String, &'a Value), ContextCompileServiceError> {
    let object = content
        .as_object()
        .ok_or(ContextCompileServiceError::InvalidInput("tool exchange"))?;
    let text = |name: &'static str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .ok_or(ContextCompileServiceError::InvalidInput(name))
    };
    let value = object
        .get(value_name)
        .ok_or(ContextCompileServiceError::InvalidInput(value_name))?;
    let expected_hash = text(if value_name == "arguments" {
        "argumentsSha256"
    } else {
        "resultSha256"
    })?;
    if hash_json(value)? != expected_hash {
        return Err(ContextCompileServiceError::InvalidInput(
            "tool exchange hash",
        ));
    }
    Ok((text("providerToolCallId")?, text("toolName")?, value))
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
            tool_call_id: string("providerToolCallId")?,
            tool_name: string("toolName")?,
            arguments_sha256: string("argumentsSha256")?,
        }),
        ContextRuntimeExchangeKind::ToolResult => Ok(ToolTranscriptEntry::Result {
            tool_call_id: string("providerToolCallId")?,
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
