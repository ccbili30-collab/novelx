use std::collections::HashMap;

use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextCompileRequest {
    pub policy: ContextPolicy,
    pub items: Vec<ContextItem>,
    pub tool_transcript: Vec<ToolTranscriptEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextPolicy {
    pub context_window: u64,
    pub safety_reserve: u64,
    pub output_reserve: OutputReservePolicy,
    pub estimator_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutputReservePolicy {
    Fixed(u64),
    Auto {
        minimum: u64,
        maximum: u64,
        target: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextItemClass {
    SystemPrompt,
    ToolProtocol,
    SessionHistory,
    Retrieval,
    Collaboration,
    RuntimeConversation,
    CurrentUserTurn,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextItem {
    pub item_id: String,
    pub class: ContextItemClass,
    pub content: String,
    pub required: bool,
    pub priority: u32,
}

impl ContextItem {
    pub fn required(
        item_id: impl Into<String>,
        class: ContextItemClass,
        content: impl Into<String>,
    ) -> Self {
        Self {
            item_id: item_id.into(),
            class,
            content: content.into(),
            required: true,
            priority: u32::MAX,
        }
    }

    pub fn optional(
        item_id: impl Into<String>,
        class: ContextItemClass,
        content: impl Into<String>,
        priority: u32,
    ) -> Self {
        Self {
            item_id: item_id.into(),
            class,
            content: content.into(),
            required: false,
            priority,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolTranscriptEntry {
    Call {
        tool_call_id: String,
        tool_name: String,
        arguments_sha256: String,
    },
    Result {
        tool_call_id: String,
        tool_name: String,
        result_sha256: String,
        is_error: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPair {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments_sha256: String,
    pub result_sha256: String,
    pub is_error: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompiledContext {
    pub packet: String,
    pub packet_sha256: String,
    pub estimator_version: String,
    pub context_window: u64,
    pub breakdown: ContextBreakdown,
    pub completeness: ContextCompleteness,
    pub tool_pairs: Vec<ToolPair>,
    pub included_item_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdown {
    pub system_prompt_tokens: u64,
    pub tool_protocol_tokens: u64,
    pub session_history_tokens: u64,
    pub retrieval_tokens: u64,
    pub collaboration_tokens: u64,
    pub runtime_conversation_tokens: u64,
    pub current_user_turn_tokens: u64,
    pub estimated_input_tokens: u64,
    pub safety_reserve: u64,
    pub output_reserve: u64,
    pub available_input_budget: u64,
}

impl ContextBreakdown {
    pub const fn sum_classes(&self) -> u64 {
        self.system_prompt_tokens
            + self.tool_protocol_tokens
            + self.session_history_tokens
            + self.retrieval_tokens
            + self.collaboration_tokens
            + self.runtime_conversation_tokens
            + self.current_user_turn_tokens
    }

    fn add(&mut self, class: ContextItemClass, tokens: u64) {
        let target = match class {
            ContextItemClass::SystemPrompt => &mut self.system_prompt_tokens,
            ContextItemClass::ToolProtocol => &mut self.tool_protocol_tokens,
            ContextItemClass::SessionHistory => &mut self.session_history_tokens,
            ContextItemClass::Retrieval => &mut self.retrieval_tokens,
            ContextItemClass::Collaboration => &mut self.collaboration_tokens,
            ContextItemClass::RuntimeConversation => &mut self.runtime_conversation_tokens,
            ContextItemClass::CurrentUserTurn => &mut self.current_user_turn_tokens,
        };
        *target = target.saturating_add(tokens);
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompleteness {
    pub incomplete: bool,
    pub omitted_item_ids: Vec<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ContextCompilerError {
    #[error("required context item `{item_id}` does not fit the context window")]
    RequiredContextExceedsWindow {
        item_id: String,
        required_tokens: u64,
        available_tokens: u64,
    },
    #[error("tool transcript pairing is invalid for `{tool_call_id}`")]
    ToolPairingInvalid { tool_call_id: String },
    #[error("context compiler input is invalid: {0}")]
    InvalidInput(&'static str),
    #[error("context packet serialization failed")]
    Serialization,
}

pub struct ContextCompiler;

impl ContextCompiler {
    pub fn compile(
        request: ContextCompileRequest,
    ) -> Result<CompiledContext, ContextCompilerError> {
        validate_request(&request)?;
        let tool_pairs = pair_tools(&request.tool_transcript)?;
        let mut measured = request
            .items
            .into_iter()
            .enumerate()
            .map(|(ordinal, item)| MeasuredItem {
                tokens: estimate_text_tokens(&item.content),
                ordinal,
                item,
            })
            .collect::<Vec<_>>();
        let required_tokens = measured
            .iter()
            .filter(|item| item.item.required)
            .fold(0_u64, |total, item| total.saturating_add(item.tokens));
        let output_reserve = resolve_output_reserve(
            &request.policy.output_reserve,
            request.policy.context_window,
            request.policy.safety_reserve,
            required_tokens,
        );
        let available = request
            .policy
            .context_window
            .saturating_sub(request.policy.safety_reserve)
            .saturating_sub(output_reserve);

        if required_tokens > available {
            let mut consumed = 0_u64;
            let item_id = measured
                .iter()
                .filter(|item| item.item.required)
                .find_map(|item| {
                    consumed = consumed.saturating_add(item.tokens);
                    (consumed > available).then(|| item.item.item_id.clone())
                })
                .unwrap_or_else(|| "__required_context__".to_owned());
            return Err(ContextCompilerError::RequiredContextExceedsWindow {
                item_id,
                required_tokens,
                available_tokens: available,
            });
        }

        let mut included = vec![false; measured.len()];
        let mut used = 0_u64;
        for item in &measured {
            if item.item.required {
                included[item.ordinal] = true;
                used = used.saturating_add(item.tokens);
            }
        }
        let mut optional_order = measured
            .iter()
            .filter(|item| !item.item.required)
            .map(|item| (item.item.priority, item.ordinal))
            .collect::<Vec<_>>();
        optional_order.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
        for (_, ordinal) in optional_order {
            let item = &measured[ordinal];
            if used.saturating_add(item.tokens) <= available {
                included[ordinal] = true;
                used = used.saturating_add(item.tokens);
            }
        }

        let mut breakdown = ContextBreakdown {
            safety_reserve: request.policy.safety_reserve,
            output_reserve,
            available_input_budget: available,
            ..ContextBreakdown::default()
        };
        let mut omitted_item_ids = Vec::new();
        let mut included_item_ids = Vec::new();
        let mut packet_items = Vec::new();
        for item in measured.drain(..) {
            if included[item.ordinal] {
                included_item_ids.push(item.item.item_id.clone());
                breakdown.add(item.item.class, item.tokens);
                packet_items.push(PacketItem::from(item));
            } else {
                omitted_item_ids.push(item.item.item_id);
            }
        }
        breakdown.estimated_input_tokens = breakdown.sum_classes();
        let packet = serde_json::to_string(&Packet {
            items: packet_items,
            tool_pairs: &tool_pairs,
        })
        .map_err(|_| ContextCompilerError::Serialization)?;
        let packet_sha256 = format!("{:x}", Sha256::digest(packet.as_bytes()));

        Ok(CompiledContext {
            packet,
            packet_sha256,
            estimator_version: request.policy.estimator_version,
            context_window: request.policy.context_window,
            breakdown,
            completeness: ContextCompleteness {
                incomplete: !omitted_item_ids.is_empty(),
                omitted_item_ids,
            },
            tool_pairs,
            included_item_ids,
        })
    }
}

pub fn estimate_text_tokens(value: &str) -> u64 {
    let mut ascii = 0_u64;
    let mut non_ascii = 0_u64;
    for character in value.chars() {
        if character.is_ascii() {
            ascii += 1;
        } else {
            non_ascii += 1;
        }
    }
    ascii
        .div_ceil(4)
        .saturating_add(non_ascii)
        .saturating_add(8)
}

fn validate_request(request: &ContextCompileRequest) -> Result<(), ContextCompilerError> {
    if request.policy.context_window == 0 {
        return Err(ContextCompilerError::InvalidInput("context_window"));
    }
    if request.policy.estimator_version.trim().is_empty() {
        return Err(ContextCompilerError::InvalidInput("estimator_version"));
    }
    let mut ids = HashMap::new();
    for item in &request.items {
        if item.item_id.trim().is_empty() {
            return Err(ContextCompilerError::InvalidInput("item_id"));
        }
        if ids.insert(item.item_id.as_str(), ()).is_some() {
            return Err(ContextCompilerError::InvalidInput("duplicate item_id"));
        }
    }
    Ok(())
}

fn resolve_output_reserve(
    policy: &OutputReservePolicy,
    context_window: u64,
    safety_reserve: u64,
    required_tokens: u64,
) -> u64 {
    match policy {
        OutputReservePolicy::Fixed(value) => *value,
        OutputReservePolicy::Auto {
            minimum,
            maximum,
            target,
        } => {
            let remaining = context_window
                .saturating_sub(safety_reserve)
                .saturating_sub(required_tokens);
            if remaining == 0 {
                return 0;
            }
            let lower = (*minimum).min(remaining);
            let upper = (*maximum).max(lower).min(remaining);
            (*target).clamp(lower, upper)
        }
    }
}

fn pair_tools(entries: &[ToolTranscriptEntry]) -> Result<Vec<ToolPair>, ContextCompilerError> {
    let mut pairs = Vec::new();
    let mut index = 0;
    while index < entries.len() {
        let ToolTranscriptEntry::Call {
            tool_call_id,
            tool_name,
            arguments_sha256,
        } = &entries[index]
        else {
            return Err(ContextCompilerError::ToolPairingInvalid {
                tool_call_id: entry_id(&entries[index]).to_owned(),
            });
        };
        let Some(ToolTranscriptEntry::Result {
            tool_call_id: result_id,
            tool_name: result_name,
            result_sha256,
            is_error,
        }) = entries.get(index + 1)
        else {
            return Err(ContextCompilerError::ToolPairingInvalid {
                tool_call_id: tool_call_id.clone(),
            });
        };
        if tool_call_id != result_id
            || tool_name != result_name
            || !is_sha256(arguments_sha256)
            || !is_sha256(result_sha256)
        {
            return Err(ContextCompilerError::ToolPairingInvalid {
                tool_call_id: tool_call_id.clone(),
            });
        }
        pairs.push(ToolPair {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            arguments_sha256: arguments_sha256.clone(),
            result_sha256: result_sha256.clone(),
            is_error: *is_error,
        });
        index += 2;
    }
    Ok(pairs)
}

fn entry_id(entry: &ToolTranscriptEntry) -> &str {
    match entry {
        ToolTranscriptEntry::Call { tool_call_id, .. }
        | ToolTranscriptEntry::Result { tool_call_id, .. } => tool_call_id,
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

struct MeasuredItem {
    item: ContextItem,
    tokens: u64,
    ordinal: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Packet<'a> {
    items: Vec<PacketItem>,
    tool_pairs: &'a [ToolPair],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PacketItem {
    item_id: String,
    class: ContextItemClass,
    content: String,
    tokens: u64,
}

impl From<MeasuredItem> for PacketItem {
    fn from(value: MeasuredItem) -> Self {
        Self {
            item_id: value.item.item_id,
            class: value.item.class,
            content: value.item.content,
            tokens: value.tokens,
        }
    }
}
