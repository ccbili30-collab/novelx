use std::collections::{HashMap, HashSet};

use novelx_protocol::{
    ContextRuntimeExchangeKind, ProviderInferenceCompleted, RunPermissionMode,
    ToolPermissionPolicy, ToolProtocolSideEffect, ToolRequest, ToolSourceScope,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::provider_tool_materializer::MaterializedProviderToolCall;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLoopIdentity {
    pub run_id: Uuid,
    pub project_id: String,
    pub invocation_id: String,
    pub initial_context_compilation_id: Uuid,
    pub source_scope: ToolSourceScope,
    pub permission: ToolPermissionPolicy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLoopPolicy {
    pub maximum_tool_rounds: u32,
    pub tool_schema_version: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopPhase {
    AwaitingProvider,
    AwaitingApproval,
    AwaitingToolResults,
    AwaitingContextCompilation,
    AwaitingInferenceStart,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentLoopDirective {
    ExecuteTools(ToolExecutionBatch),
    AwaitApproval(ToolApprovalWait),
    CompileContext(ContextCompileIntent),
    StartInference(NextInferenceIntent),
    Completed { output: String },
    Cancelled { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolExecutionBatch {
    pub round: u32,
    pub assistant_message_id: String,
    pub requests: Vec<ToolRequest>,
    pub denied_provider_tool_call_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolApprovalWait {
    pub round: u32,
    pub assistant_message_id: String,
    pub requests: Vec<ToolRequest>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeExchangeIntent {
    pub kind: ContextRuntimeExchangeKind,
    pub content: Value,
    pub content_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextCompileIntent {
    pub round: u32,
    pub request_number: u64,
    pub assistant_message_id: String,
    pub exchanges: Vec<RuntimeExchangeIntent>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NextInferenceIntent {
    pub round: u32,
    pub request_number: u64,
    pub context_compilation_id: Uuid,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceDispatchIdentity {
    pub inference_id: Uuid,
    pub attempt_id: Uuid,
    pub request_number: u64,
    pub context_compilation_id: Uuid,
    pub attempt_number: u16,
    pub inference_idempotency_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssistToolDecision {
    pub provider_tool_call_id: String,
    pub approved: bool,
}

impl AssistToolDecision {
    pub fn approve(provider_tool_call_id: impl Into<String>) -> Self {
        Self {
            provider_tool_call_id: provider_tool_call_id.into(),
            approved: true,
        }
    }

    pub fn deny(provider_tool_call_id: impl Into<String>) -> Self {
        Self {
            provider_tool_call_id: provider_tool_call_id.into(),
            approved: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalizedToolResult {
    pub provider_tool_call_id: String,
    pub tool_name: String,
    pub content: Value,
    pub content_sha256: String,
    pub is_error: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLoopService {
    identity: AgentLoopIdentity,
    policy: AgentLoopPolicy,
    phase: LoopPhase,
    expected_request_number: u64,
    expected_context_compilation_id: Uuid,
    completed_tool_rounds: u32,
    pending: Option<PendingToolRound>,
    #[serde(default)]
    pending_inference: Option<InferenceDispatchIdentity>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingToolRound {
    round: u32,
    completion: ProviderInferenceCompleted,
    requests: Vec<ToolRequest>,
}

impl AgentLoopService {
    pub fn new(
        identity: AgentLoopIdentity,
        policy: AgentLoopPolicy,
        initial_inference: InferenceDispatchIdentity,
    ) -> Result<Self, AgentLoopError> {
        if identity.project_id.trim().is_empty()
            || identity.invocation_id.trim().is_empty()
            || identity.source_scope.source_checkpoint_id.trim().is_empty()
            || identity.source_scope.scope_sha256.trim().is_empty()
            || identity.permission.policy_id.trim().is_empty()
            || identity.permission.policy_version.trim().is_empty()
            || identity.permission.policy_sha256.trim().is_empty()
            || policy.maximum_tool_rounds == 0
            || policy.tool_schema_version == 0
            || !valid_inference_dispatch(&initial_inference)
            || initial_inference.request_number != 1
            || initial_inference.context_compilation_id != identity.initial_context_compilation_id
        {
            return Err(AgentLoopError::IdentityInvalid);
        }
        let expected_context_compilation_id = identity.initial_context_compilation_id;
        Ok(Self {
            identity,
            policy,
            phase: LoopPhase::AwaitingProvider,
            expected_request_number: 1,
            expected_context_compilation_id,
            completed_tool_rounds: 0,
            pending: None,
            pending_inference: Some(initial_inference),
        })
    }

    pub const fn phase(&self) -> LoopPhase {
        self.phase
    }

    pub const fn identity(&self) -> &AgentLoopIdentity {
        &self.identity
    }

    pub fn pending_requests(&self) -> &[ToolRequest] {
        self.pending
            .as_ref()
            .map_or(&[], |pending| pending.requests.as_slice())
    }

    pub fn pending_request(&self, tool_call_id: Uuid) -> Option<&ToolRequest> {
        self.pending_requests()
            .iter()
            .find(|request| request.tool_call_id == tool_call_id)
    }

    pub fn pending_completion(&self) -> Option<&ProviderInferenceCompleted> {
        self.pending.as_ref().map(|pending| &pending.completion)
    }

    pub const fn pending_inference(&self) -> Option<&InferenceDispatchIdentity> {
        self.pending_inference.as_ref()
    }

    pub const fn is_active(&self) -> bool {
        matches!(
            self.phase,
            LoopPhase::AwaitingProvider
                | LoopPhase::AwaitingApproval
                | LoopPhase::AwaitingToolResults
                | LoopPhase::AwaitingContextCompilation
                | LoopPhase::AwaitingInferenceStart
        )
    }

    pub fn checkpoint(&self) -> Result<Value, AgentLoopError> {
        serde_json::to_value(self).map_err(|_| AgentLoopError::Serialization)
    }

    pub fn checkpoint_sha256(&self) -> Result<String, AgentLoopError> {
        let checkpoint = self.checkpoint()?;
        hash_json(&checkpoint)
    }

    pub fn restore(checkpoint: Value) -> Result<Self, AgentLoopError> {
        let restored: Self =
            serde_json::from_value(checkpoint).map_err(|_| AgentLoopError::CheckpointInvalid)?;
        restored.validate_checkpoint()?;
        Ok(restored)
    }

    pub fn accept_provider_outcome(
        &mut self,
        completion: ProviderInferenceCompleted,
        materialized: Vec<MaterializedProviderToolCall>,
    ) -> Result<AgentLoopDirective, AgentLoopError> {
        self.require_phase(LoopPhase::AwaitingProvider)?;
        let dispatch = self
            .pending_inference
            .as_ref()
            .ok_or(AgentLoopError::InferenceDispatchMissing)?;
        if completion.identity.run_id != self.identity.run_id
            || completion.identity.request_number != self.expected_request_number
            || completion.identity.context_compilation_id != self.expected_context_compilation_id
            || completion.identity.inference_id != dispatch.inference_id
            || completion.identity.attempt_id != dispatch.attempt_id
            || completion.identity.request_number != dispatch.request_number
            || completion.identity.context_compilation_id != dispatch.context_compilation_id
            || completion.identity.attempt_number != u64::from(dispatch.attempt_number)
        {
            return Err(AgentLoopError::ProviderIdentityMismatch);
        }
        self.pending_inference = None;
        if completion.tool_calls.is_empty() {
            if !materialized.is_empty() {
                return Err(AgentLoopError::MaterializedCallsMismatch);
            }
            let output = completion
                .output
                .map(|output| output.text)
                .filter(|output| !output.trim().is_empty())
                .ok_or(AgentLoopError::ProviderTerminalOutputMissing)?;
            self.phase = LoopPhase::Completed;
            return Ok(AgentLoopDirective::Completed { output });
        }
        if self.completed_tool_rounds >= self.policy.maximum_tool_rounds {
            self.phase = LoopPhase::Failed;
            return Err(AgentLoopError::MaximumToolRoundsExceeded);
        }
        let requests = self.materialize_requests(&completion, &materialized)?;
        self.completed_tool_rounds += 1;
        let round = self.completed_tool_rounds;
        let assistant_message_id = completion.identity.inference_id.to_string();
        self.pending = Some(PendingToolRound {
            round,
            completion,
            requests: requests.clone(),
        });
        match self.identity.permission.mode {
            RunPermissionMode::Free => {
                self.phase = LoopPhase::AwaitingToolResults;
                Ok(AgentLoopDirective::ExecuteTools(ToolExecutionBatch {
                    round,
                    assistant_message_id,
                    requests,
                    denied_provider_tool_call_ids: Vec::new(),
                }))
            }
            RunPermissionMode::Assist => {
                self.phase = LoopPhase::AwaitingApproval;
                Ok(AgentLoopDirective::AwaitApproval(ToolApprovalWait {
                    round,
                    assistant_message_id,
                    requests,
                }))
            }
        }
    }

    pub fn resolve_assist(
        &mut self,
        decisions: Vec<AssistToolDecision>,
    ) -> Result<AgentLoopDirective, AgentLoopError> {
        self.require_phase(LoopPhase::AwaitingApproval)?;
        let pending = self
            .pending
            .as_ref()
            .ok_or(AgentLoopError::PendingRoundMissing)?;
        let mut by_id = HashMap::new();
        for decision in decisions {
            if decision.provider_tool_call_id.trim().is_empty()
                || by_id
                    .insert(decision.provider_tool_call_id, decision.approved)
                    .is_some()
            {
                return Err(AgentLoopError::ApprovalSetMismatch);
            }
        }
        if by_id.len() != pending.requests.len()
            || pending
                .requests
                .iter()
                .any(|request| !by_id.contains_key(&request.provider_tool_call_id))
        {
            return Err(AgentLoopError::ApprovalSetMismatch);
        }
        let mut requests = Vec::new();
        let mut denied = Vec::new();
        for request in &pending.requests {
            if by_id[&request.provider_tool_call_id] {
                requests.push(request.clone());
            } else {
                denied.push(request.provider_tool_call_id.clone());
            }
        }
        self.phase = LoopPhase::AwaitingToolResults;
        Ok(AgentLoopDirective::ExecuteTools(ToolExecutionBatch {
            round: pending.round,
            assistant_message_id: pending.completion.identity.inference_id.to_string(),
            requests,
            denied_provider_tool_call_ids: denied,
        }))
    }

    pub fn accept_tool_results(
        &mut self,
        results: Vec<FinalizedToolResult>,
    ) -> Result<AgentLoopDirective, AgentLoopError> {
        self.require_phase(LoopPhase::AwaitingToolResults)?;
        let pending = self
            .pending
            .as_ref()
            .ok_or(AgentLoopError::PendingRoundMissing)?;
        let mut results_by_id = HashMap::new();
        for result in results {
            if result.provider_tool_call_id.trim().is_empty()
                || result.tool_name.trim().is_empty()
                || hash_json(&result.content)? != result.content_sha256
                || results_by_id
                    .insert(result.provider_tool_call_id.clone(), result)
                    .is_some()
            {
                return Err(AgentLoopError::ToolResultSetMismatch);
            }
        }
        if results_by_id.len() != pending.completion.tool_calls.len() {
            return Err(AgentLoopError::ToolResultSetMismatch);
        }
        let assistant_message_id = pending.completion.identity.inference_id.to_string();
        let mut exchanges = Vec::with_capacity(pending.completion.tool_calls.len() * 2);
        for call in &pending.completion.tool_calls {
            let Some(result) = results_by_id.get(&call.id) else {
                return Err(AgentLoopError::ToolResultSetMismatch);
            };
            if result.tool_name != call.name {
                return Err(AgentLoopError::ToolResultSetMismatch);
            }
            exchanges.push(exchange(
                ContextRuntimeExchangeKind::ToolCall,
                serde_json::json!({
                    "assistantMessageId": assistant_message_id,
                    "providerToolCallId": call.id,
                    "toolName": call.name,
                    "arguments": call.arguments,
                    "argumentsSha256": call.arguments_sha256,
                }),
            )?);
        }
        for call in &pending.completion.tool_calls {
            let result = results_by_id
                .remove(&call.id)
                .unwrap_or_else(|| unreachable!());
            exchanges.push(exchange(
                ContextRuntimeExchangeKind::ToolResult,
                serde_json::json!({
                    "providerToolCallId": result.provider_tool_call_id,
                    "toolName": result.tool_name,
                    "result": result.content,
                    "resultSha256": result.content_sha256,
                    "isError": result.is_error,
                }),
            )?);
        }
        let intent = ContextCompileIntent {
            round: pending.round,
            request_number: pending.completion.identity.request_number + 1,
            assistant_message_id,
            exchanges,
        };
        self.phase = LoopPhase::AwaitingContextCompilation;
        Ok(AgentLoopDirective::CompileContext(intent))
    }

    pub fn accept_context_compiled(
        &mut self,
        context_compilation_id: Uuid,
    ) -> Result<AgentLoopDirective, AgentLoopError> {
        self.require_phase(LoopPhase::AwaitingContextCompilation)?;
        let pending = self
            .pending
            .as_ref()
            .ok_or(AgentLoopError::PendingRoundMissing)?;
        let request_number = pending.completion.identity.request_number + 1;
        let intent = NextInferenceIntent {
            round: pending.round + 1,
            request_number,
            context_compilation_id,
        };
        self.expected_request_number = request_number;
        self.expected_context_compilation_id = context_compilation_id;
        self.phase = LoopPhase::AwaitingInferenceStart;
        Ok(AgentLoopDirective::StartInference(intent))
    }

    pub fn acknowledge_inference_started(
        &mut self,
        dispatch: InferenceDispatchIdentity,
    ) -> Result<(), AgentLoopError> {
        self.require_phase(LoopPhase::AwaitingInferenceStart)?;
        if !valid_inference_dispatch(&dispatch)
            || dispatch.request_number != self.expected_request_number
            || dispatch.context_compilation_id != self.expected_context_compilation_id
        {
            return Err(AgentLoopError::ProviderIdentityMismatch);
        }
        self.pending = None;
        self.pending_inference = Some(dispatch);
        self.phase = LoopPhase::AwaitingProvider;
        Ok(())
    }

    pub fn cancel(&mut self, reason: &str) -> Result<AgentLoopDirective, AgentLoopError> {
        if matches!(
            self.phase,
            LoopPhase::Completed | LoopPhase::Cancelled | LoopPhase::Failed
        ) || reason.trim().is_empty()
        {
            return Err(AgentLoopError::PhaseInvalid);
        }
        self.pending = None;
        self.pending_inference = None;
        self.phase = LoopPhase::Cancelled;
        Ok(AgentLoopDirective::Cancelled {
            reason: reason.to_owned(),
        })
    }

    fn materialize_requests(
        &self,
        completion: &ProviderInferenceCompleted,
        materialized: &[MaterializedProviderToolCall],
    ) -> Result<Vec<ToolRequest>, AgentLoopError> {
        if completion.tool_calls.len() != materialized.len() {
            return Err(AgentLoopError::MaterializedCallsMismatch);
        }
        let mut provider_ids = HashSet::new();
        completion
            .tool_calls
            .iter()
            .zip(materialized)
            .map(|(call, stored)| {
                if call.id != stored.provider_tool_call_id
                    || call.name != stored.tool_name
                    || call.arguments_sha256 != stored.arguments.sha256
                    || !provider_ids.insert(call.id.as_str())
                {
                    return Err(AgentLoopError::MaterializedCallsMismatch);
                }
                let request = ToolRequest {
                    request_idempotency_key: format!(
                        "agent-loop:{}:{}:{}",
                        completion.identity.inference_id, call.id, stored.tool_call_id
                    ),
                    tool_call_id: stored.tool_call_id,
                    provider_tool_call_id: call.id.clone(),
                    invocation_id: self.identity.invocation_id.clone(),
                    tool_name: call.name.clone(),
                    schema_version: self.policy.tool_schema_version,
                    attempt: 1,
                    side_effect: ToolProtocolSideEffect::None,
                    parallel: false,
                    arguments: stored.arguments.clone(),
                    source_scope: self.identity.source_scope.clone(),
                    permission: self.identity.permission.clone(),
                };
                request
                    .validate()
                    .map_err(|_| AgentLoopError::MaterializedCallsMismatch)?;
                Ok(request)
            })
            .collect()
    }

    fn require_phase(&self, expected: LoopPhase) -> Result<(), AgentLoopError> {
        if self.phase == expected {
            Ok(())
        } else {
            Err(AgentLoopError::PhaseInvalid)
        }
    }

    fn validate_checkpoint(&self) -> Result<(), AgentLoopError> {
        if self.expected_request_number == 0
            || self.policy.maximum_tool_rounds == 0
            || self.completed_tool_rounds > self.policy.maximum_tool_rounds
        {
            return Err(AgentLoopError::CheckpointInvalid);
        }
        let pending_required = matches!(
            self.phase,
            LoopPhase::AwaitingApproval
                | LoopPhase::AwaitingToolResults
                | LoopPhase::AwaitingContextCompilation
                | LoopPhase::AwaitingInferenceStart
        );
        let duplicate_tool_call_id = self.pending.as_ref().is_some_and(|pending| {
            let mut ids = HashSet::new();
            pending
                .requests
                .iter()
                .any(|request| !ids.insert(request.tool_call_id))
        });
        if pending_required != self.pending.is_some()
            || duplicate_tool_call_id
            || (self.phase == LoopPhase::AwaitingApproval
                && self.identity.permission.mode != RunPermissionMode::Assist)
            || (matches!(
                self.phase,
                LoopPhase::Completed | LoopPhase::Cancelled | LoopPhase::Failed
            ) && self.pending.is_some())
            || (self.phase == LoopPhase::AwaitingProvider
                && self.pending_inference.as_ref().is_some_and(|dispatch| {
                    !valid_inference_dispatch(dispatch)
                        || dispatch.request_number != self.expected_request_number
                        || dispatch.context_compilation_id != self.expected_context_compilation_id
                }))
            || (self.phase != LoopPhase::AwaitingProvider && self.pending_inference.is_some())
        {
            return Err(AgentLoopError::CheckpointInvalid);
        }
        Ok(())
    }
}

fn valid_inference_dispatch(dispatch: &InferenceDispatchIdentity) -> bool {
    dispatch.request_number > 0
        && dispatch.attempt_number > 0
        && !dispatch.inference_idempotency_key.trim().is_empty()
}

fn exchange(
    kind: ContextRuntimeExchangeKind,
    content: Value,
) -> Result<RuntimeExchangeIntent, AgentLoopError> {
    Ok(RuntimeExchangeIntent {
        kind,
        content_sha256: hash_json(&content)?,
        content,
    })
}

fn hash_json(value: &Value) -> Result<String, AgentLoopError> {
    serde_json::to_vec(value)
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
        .map_err(|_| AgentLoopError::Serialization)
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum AgentLoopError {
    #[error("agent loop identity or policy is invalid")]
    IdentityInvalid,
    #[error("agent loop command is invalid in the current phase")]
    PhaseInvalid,
    #[error("Provider completion identity does not match the scheduled inference")]
    ProviderIdentityMismatch,
    #[error("scheduled Provider inference identity is missing from the AgentLoop checkpoint")]
    InferenceDispatchMissing,
    #[error("Provider terminal output is missing")]
    ProviderTerminalOutputMissing,
    #[error("materialized Provider calls do not match the finalized outcome")]
    MaterializedCallsMismatch,
    #[error("Assist approval decisions do not exactly cover the pending calls")]
    ApprovalSetMismatch,
    #[error("tool results do not exactly cover the pending Provider calls")]
    ToolResultSetMismatch,
    #[error("maximum tool rounds exceeded")]
    MaximumToolRoundsExceeded,
    #[error("pending tool round is missing")]
    PendingRoundMissing,
    #[error("agent loop JSON serialization failed")]
    Serialization,
    #[error("agent loop checkpoint is invalid")]
    CheckpointInvalid,
}
