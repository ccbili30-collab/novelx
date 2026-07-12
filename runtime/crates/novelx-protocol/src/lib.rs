use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    Command,
    Event,
    Response,
    Control,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub protocol_version: u16,
    pub message_id: Uuid,
    pub message_type: MessageType,
    pub name: String,
    pub sent_at: String,
    pub correlation_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub sequence: u64,
    pub payload: Value,
}

impl Envelope {
    pub fn new(
        message_type: MessageType,
        name: impl Into<String>,
        sent_at: impl Into<String>,
        sequence: u64,
        payload: impl Serialize,
    ) -> Result<Self, serde_json::Error> {
        Ok(Self {
            protocol_version: PROTOCOL_VERSION,
            message_id: Uuid::new_v4(),
            message_type,
            name: name.into(),
            sent_at: sent_at.into(),
            correlation_id: None,
            run_id: None,
            sequence,
            payload: serde_json::to_value(payload)?,
        })
    }

    pub fn validate_version(&self) -> Result<(), ProtocolError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion {
                received: self.protocol_version,
                supported: PROTOCOL_VERSION,
            });
        }
        if self.sequence == 0 || self.sequence > MAX_SAFE_SEQUENCE {
            return Err(ProtocolError::SequenceOutOfRange {
                received: self.sequence,
                maximum: MAX_SAFE_SEQUENCE,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    UnsupportedVersion { received: u16, supported: u16 },
    SequenceOutOfRange { received: u64, maximum: u64 },
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedVersion {
                received,
                supported,
            } => write!(
                formatter,
                "unsupported protocol version {received}; supported version is {supported}"
            ),
            Self::SequenceOutOfRange { received, maximum } => write!(
                formatter,
                "protocol sequence {received} is outside the supported range 1..={maximum}"
            ),
        }
    }
}

impl std::error::Error for ProtocolError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeBuild {
    pub commit: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHello {
    pub runtime_version: String,
    pub protocol_versions: Vec<u16>,
    pub capabilities: Vec<String>,
    pub build: RuntimeBuild,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeApplicationIdentity {
    pub id: String,
    pub version: String,
    pub commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInitialize {
    pub selected_protocol_version: u16,
    pub application: RuntimeApplicationIdentity,
    pub workspace_database_path: Option<String>,
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    pub feature_flags: BTreeMap<String, bool>,
    pub host_capability_versions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeIdentity {
    pub version: String,
    pub build: RuntimeBuild,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeReady {
    pub selected_protocol_version: u16,
    pub runtime: RuntimeIdentity,
    pub recovered_run_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStatus {
    pub initialized: bool,
    pub workspace_database_configured: bool,
    pub recovered_run_count: u64,
    pub protocol_version: u16,
    pub runtime_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStopped {
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunPermissionMode {
    Free,
    Assist,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionReference {
    pub id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionedPolicyIdentity {
    pub id: String,
    pub version: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRunIdentity {
    pub profile_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub config_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunPinnedIdentity {
    pub project_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub session_branch_id: String,
    pub user_message_id: String,
    pub project_branch_id: String,
    pub goal: Option<RevisionReference>,
    pub plan: Option<RevisionReference>,
    pub provider: ProviderRunIdentity,
    pub prompt_bundle: VersionedPolicyIdentity,
    pub agent_profile: VersionedPolicyIdentity,
    pub tool_policy: VersionedPolicyIdentity,
    pub context_policy: VersionedPolicyIdentity,
    pub runtime_policy: VersionedPolicyIdentity,
    pub runtime_contract_version: String,
    pub mode: RunPermissionMode,
    pub source_checkpoint_id: String,
    pub scope_resource_ids: Vec<String>,
    pub resource_scope_sha256: String,
    pub user_input_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunStart {
    pub start_idempotency_key: String,
    pub pinned_identity: RunPinnedIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunCancel {
    pub cancel_idempotency_key: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunPrepare {
    pub prepare_idempotency_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunLifecycleState {
    Created,
    Preparing,
    Running,
    WaitingForApproval,
    WaitingForReconciliation,
    Committing,
    Retrying,
    Blocked,
    Cancelled,
    Failed,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunRecoveryClassification {
    Resumable,
    WaitingForApproval,
    WaitingForReconciliation,
    CommitUncertain,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSnapshot {
    pub run_id: Uuid,
    pub pinned_identity: RunPinnedIdentity,
    pub state: RunLifecycleState,
    pub recovery_classification: RunRecoveryClassification,
    pub run_sequence: u64,
    pub aggregate_sequence: u64,
    pub created_at: String,
    pub updated_at: String,
    pub terminal_error: Option<RuntimeError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextDisclosure {
    Public,
    ProjectPrivate,
    AgentInternal,
    PlayerHidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextMessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextRuntimeExchangeKind {
    UserMessage,
    AssistantMessage,
    ToolCall,
    ToolResult,
    Correction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSourceKind {
    Document,
    GraphAssertion,
    TaskMemory,
    ProjectFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ContextItem {
    SystemPrompt {
        item_id: String,
        content: String,
        content_sha256: String,
        disclosure: ContextDisclosure,
        required: bool,
    },
    ToolProtocol {
        item_id: String,
        tool_name: String,
        schema_version: u32,
        protocol: Value,
        content_sha256: String,
        disclosure: ContextDisclosure,
        required: bool,
    },
    SessionMessage {
        item_id: String,
        message_id: String,
        role: ContextMessageRole,
        content: String,
        content_sha256: String,
        created_at: String,
        disclosure: ContextDisclosure,
        required: bool,
    },
    RetrievalSource {
        item_id: String,
        source_receipt_id: String,
        source_kind: ContextSourceKind,
        stable_version_id: String,
        content: String,
        content_sha256: String,
        complete: bool,
        disclosure: ContextDisclosure,
        required: bool,
    },
    RuntimeExchange {
        item_id: String,
        exchange_id: String,
        kind: ContextRuntimeExchangeKind,
        content: Value,
        content_sha256: String,
        disclosure: ContextDisclosure,
        required: bool,
    },
    OutputReserve {
        item_id: String,
        requested_tokens: u64,
        policy_id: String,
        disclosure: ContextDisclosure,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenizerKind {
    ProviderExact,
    KnownModel,
    FallbackEstimate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenizerIdentity {
    pub kind: TokenizerKind,
    pub id: String,
    pub version: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextBudgetCategory {
    SystemPrompt,
    ToolProtocol,
    SessionHistory,
    Collaboration,
    Retrieval,
    RuntimeConversation,
    OutputReserve,
    SafetyReserve,
    AccountingOverhead,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextBudgetAllocation {
    pub category: ContextBudgetCategory,
    pub estimated_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompile {
    pub compile_idempotency_key: String,
    pub invocation_id: String,
    pub request_number: u64,
    pub provider: ProviderRunIdentity,
    pub context_policy: VersionedPolicyIdentity,
    pub compiler_version: String,
    pub context_window: u64,
    pub configured_max_output_tokens: Option<u64>,
    pub safety_reserve_tokens: u64,
    pub items: Vec<ContextItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextRepresentation {
    NormalizedMessages,
    PiContextJson,
    OpenAiChatCompletions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompilationReceipt {
    pub compilation_id: Uuid,
    pub request_number: u64,
    pub compiler_version: String,
    pub tokenizer: TokenizerIdentity,
    pub representation: ContextRepresentation,
    pub canonical_context_sha256: String,
    pub serialized_input_bytes: u64,
    pub estimated_input_tokens: u64,
    pub exact_input_tokens: Option<u64>,
    pub context_window: u64,
    pub safety_reserve_tokens: u64,
    pub output_reserve_tokens: u64,
    pub available_input_tokens: u64,
    pub accepted: bool,
    pub budget: Vec<ContextBudgetAllocation>,
    pub included_item_ids: Vec<String>,
    pub omitted_item_ids: Vec<String>,
    pub incomplete: bool,
    pub disclosure: ContextDisclosure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeErrorClass {
    Protocol,
    ProviderAuth,
    ProviderRateLimit,
    ProviderTimeout,
    ProviderRejected,
    ContextCapacity,
    ToolArguments,
    ToolPermission,
    ToolExecution,
    SourceConflict,
    StaleVersion,
    Storage,
    RuntimeCrash,
    Cancelled,
    Validation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeError {
    pub code: String,
    pub class: RuntimeErrorClass,
    pub retryable: bool,
    pub public_message: String,
    pub stage: String,
    pub attempt: u64,
    pub diagnostic_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceStart {
    pub inference_id: Uuid,
    pub attempt_id: Uuid,
    pub invocation_id: String,
    pub context_compilation_id: Uuid,
    pub request_number: u64,
    pub attempt_number: u64,
    pub inference_idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceIdentity {
    pub run_id: Uuid,
    pub inference_id: Uuid,
    pub attempt_id: Uuid,
    pub context_compilation_id: Uuid,
    pub request_number: u64,
    pub attempt_number: u64,
}

pub type ProviderInferenceAccepted = ProviderInferenceIdentity;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceOutput {
    pub text: String,
    pub text_sha256: String,
    pub utf8_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceCompleted {
    #[serde(flatten)]
    pub identity: ProviderInferenceIdentity,
    pub provider_id: String,
    pub model_id: String,
    pub response_id_sha256: String,
    pub response_body_sha256: String,
    pub stop_reason: String,
    pub usage: ProviderInferenceUsage,
    pub output: ProviderInferenceOutput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceFailed {
    #[serde(flatten)]
    pub identity: ProviderInferenceIdentity,
    pub error: RuntimeError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderInferenceReconciliationReason {
    OutcomeUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceReconciliationRequired {
    #[serde(flatten)]
    pub identity: ProviderInferenceIdentity,
    pub reason: ProviderInferenceReconciliationReason,
    pub error: RuntimeError,
}

pub const MAX_PROVIDER_INFERENCE_OUTPUT_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderInferenceValidationError {
    EmptyIdentity { field: &'static str },
    NumberMustBePositive { field: &'static str },
    InvalidSha256 { field: &'static str },
    UsageTotalMismatch,
    OutputEmpty,
    OutputTooLarge { actual: usize, maximum: usize },
    OutputByteLengthMismatch { declared: u64, actual: usize },
    OutputHashMismatch,
    ReconciliationCannotBeRetryable,
}

impl std::fmt::Display for ProviderInferenceValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyIdentity { field } => write!(formatter, "{field} must not be empty"),
            Self::NumberMustBePositive { field } => write!(formatter, "{field} must be positive"),
            Self::InvalidSha256 { field } => write!(formatter, "{field} must be lowercase SHA-256"),
            Self::UsageTotalMismatch => write!(
                formatter,
                "totalTokens must equal inputTokens plus outputTokens"
            ),
            Self::OutputEmpty => write!(formatter, "Provider inference output must not be empty"),
            Self::OutputTooLarge { actual, maximum } => write!(
                formatter,
                "Provider inference output is {actual} bytes; maximum is {maximum}"
            ),
            Self::OutputByteLengthMismatch { declared, actual } => write!(
                formatter,
                "declared output byte length {declared} does not match actual length {actual}"
            ),
            Self::OutputHashMismatch => write!(
                formatter,
                "textSha256 does not match Provider inference output"
            ),
            Self::ReconciliationCannotBeRetryable => write!(
                formatter,
                "unknown Provider outcomes cannot be automatically retryable"
            ),
        }
    }
}

impl std::error::Error for ProviderInferenceValidationError {}

impl ProviderInferenceStart {
    pub fn validate(&self) -> Result<(), ProviderInferenceValidationError> {
        require_identity("invocationId", &self.invocation_id)?;
        require_identity("inferenceIdempotencyKey", &self.inference_idempotency_key)?;
        require_positive("requestNumber", self.request_number)?;
        require_positive("attemptNumber", self.attempt_number)
    }
}

impl ProviderInferenceIdentity {
    pub fn validate(&self) -> Result<(), ProviderInferenceValidationError> {
        require_positive("requestNumber", self.request_number)?;
        require_positive("attemptNumber", self.attempt_number)
    }
}

impl ProviderInferenceCompleted {
    pub fn validate(&self) -> Result<(), ProviderInferenceValidationError> {
        self.identity.validate()?;
        require_identity("providerId", &self.provider_id)?;
        require_identity("modelId", &self.model_id)?;
        require_identity("stopReason", &self.stop_reason)?;
        require_sha256("responseIdSha256", &self.response_id_sha256)?;
        require_sha256("responseBodySha256", &self.response_body_sha256)?;
        require_sha256("textSha256", &self.output.text_sha256)?;
        if self
            .usage
            .input_tokens
            .checked_add(self.usage.output_tokens)
            != Some(self.usage.total_tokens)
        {
            return Err(ProviderInferenceValidationError::UsageTotalMismatch);
        }
        if self.output.text.is_empty() {
            return Err(ProviderInferenceValidationError::OutputEmpty);
        }
        let actual_bytes = self.output.text.len();
        if actual_bytes > MAX_PROVIDER_INFERENCE_OUTPUT_BYTES {
            return Err(ProviderInferenceValidationError::OutputTooLarge {
                actual: actual_bytes,
                maximum: MAX_PROVIDER_INFERENCE_OUTPUT_BYTES,
            });
        }
        if self.output.utf8_bytes != actual_bytes as u64 {
            return Err(ProviderInferenceValidationError::OutputByteLengthMismatch {
                declared: self.output.utf8_bytes,
                actual: actual_bytes,
            });
        }
        if lowercase_sha256(self.output.text.as_bytes()) != self.output.text_sha256 {
            return Err(ProviderInferenceValidationError::OutputHashMismatch);
        }
        Ok(())
    }
}

impl ProviderInferenceFailed {
    pub fn validate(&self) -> Result<(), ProviderInferenceValidationError> {
        self.identity.validate()
    }
}

impl ProviderInferenceReconciliationRequired {
    pub fn validate(&self) -> Result<(), ProviderInferenceValidationError> {
        self.identity.validate()?;
        if self.error.retryable {
            return Err(ProviderInferenceValidationError::ReconciliationCannotBeRetryable);
        }
        Ok(())
    }
}

fn require_identity(
    field: &'static str,
    value: &str,
) -> Result<(), ProviderInferenceValidationError> {
    if value.trim().is_empty() {
        return Err(ProviderInferenceValidationError::EmptyIdentity { field });
    }
    Ok(())
}

fn require_positive(
    field: &'static str,
    value: u64,
) -> Result<(), ProviderInferenceValidationError> {
    if value == 0 {
        return Err(ProviderInferenceValidationError::NumberMustBePositive { field });
    }
    Ok(())
}

fn require_sha256(
    field: &'static str,
    value: &str,
) -> Result<(), ProviderInferenceValidationError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ProviderInferenceValidationError::InvalidSha256 { field });
    }
    Ok(())
}

fn lowercase_sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips_with_camel_case_fields() {
        let envelope = Envelope::new(
            MessageType::Control,
            "runtime.hello",
            "2026-07-12T00:00:00Z",
            1,
            RuntimeHello {
                runtime_version: "0.1.0".to_owned(),
                protocol_versions: vec![PROTOCOL_VERSION],
                capabilities: vec!["runs".to_owned()],
                build: RuntimeBuild {
                    commit: "test".to_owned(),
                    target: "x86_64-pc-windows-msvc".to_owned(),
                },
            },
        )
        .expect("hello payload should serialize");

        let encoded = serde_json::to_string(&envelope).expect("envelope should serialize");
        assert!(encoded.contains("\"protocolVersion\":1"));
        assert!(encoded.contains("\"messageType\":\"control\""));

        let decoded: Envelope = serde_json::from_str(&encoded).expect("envelope should parse");
        assert_eq!(decoded, envelope);
        assert_eq!(decoded.validate_version(), Ok(()));
    }

    #[test]
    fn unsupported_protocol_version_is_rejected() {
        let mut envelope = Envelope::new(
            MessageType::Command,
            "runtime.initialize",
            "2026-07-12T00:00:00Z",
            1,
            serde_json::json!({}),
        )
        .expect("empty payload should serialize");
        envelope.protocol_version = PROTOCOL_VERSION + 1;

        assert_eq!(
            envelope.validate_version(),
            Err(ProtocolError::UnsupportedVersion {
                received: PROTOCOL_VERSION + 1,
                supported: PROTOCOL_VERSION,
            })
        );
    }

    #[test]
    fn sequence_must_fit_the_cross_language_safe_integer_range() {
        let mut envelope = Envelope::new(
            MessageType::Event,
            "run.created",
            "2026-07-12T00:00:00Z",
            1,
            serde_json::json!({}),
        )
        .expect("empty payload should serialize");

        envelope.sequence = MAX_SAFE_SEQUENCE + 1;
        assert_eq!(
            envelope.validate_version(),
            Err(ProtocolError::SequenceOutOfRange {
                received: MAX_SAFE_SEQUENCE + 1,
                maximum: MAX_SAFE_SEQUENCE,
            })
        );
    }

    #[test]
    fn context_compile_and_receipt_round_trip_with_strict_tagged_items() {
        let items = vec![
            ContextItem::SystemPrompt {
                item_id: "system-1".to_owned(),
                content: "Stay within the project.".to_owned(),
                content_sha256: "a".repeat(64),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            ContextItem::ToolProtocol {
                item_id: "tool-1".to_owned(),
                tool_name: "project.read".to_owned(),
                schema_version: 1,
                protocol: serde_json::json!({ "type": "object" }),
                content_sha256: "b".repeat(64),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            ContextItem::SessionMessage {
                item_id: "session-1".to_owned(),
                message_id: "message-1".to_owned(),
                role: ContextMessageRole::User,
                content: "Continue the coastline discussion.".to_owned(),
                content_sha256: "c".repeat(64),
                created_at: "2026-07-12T00:00:00Z".to_owned(),
                disclosure: ContextDisclosure::ProjectPrivate,
                required: false,
            },
            ContextItem::RetrievalSource {
                item_id: "source-1".to_owned(),
                source_receipt_id: "receipt-1".to_owned(),
                source_kind: ContextSourceKind::Document,
                stable_version_id: "version-1".to_owned(),
                content: "The coast was formed by subsidence.".to_owned(),
                content_sha256: "d".repeat(64),
                complete: true,
                disclosure: ContextDisclosure::ProjectPrivate,
                required: true,
            },
            ContextItem::RuntimeExchange {
                item_id: "exchange-1".to_owned(),
                exchange_id: "tool-call-1".to_owned(),
                kind: ContextRuntimeExchangeKind::ToolResult,
                content: serde_json::json!({ "ok": true }),
                content_sha256: "e".repeat(64),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            ContextItem::OutputReserve {
                item_id: "output-1".to_owned(),
                requested_tokens: 8_192,
                policy_id: "auto-output-v1".to_owned(),
                disclosure: ContextDisclosure::AgentInternal,
            },
        ];
        let compile = ContextCompile {
            compile_idempotency_key: "compile-1".to_owned(),
            invocation_id: "run-1:steward".to_owned(),
            request_number: 1,
            provider: ProviderRunIdentity {
                profile_id: "profile-1".to_owned(),
                provider_id: "provider-1".to_owned(),
                model_id: "model-1".to_owned(),
                config_sha256: "f".repeat(64),
            },
            context_policy: VersionedPolicyIdentity {
                id: "context-policy".to_owned(),
                version: "1.0.0".to_owned(),
                sha256: "1".repeat(64),
            },
            compiler_version: "1.0.0".to_owned(),
            context_window: 262_144,
            configured_max_output_tokens: None,
            safety_reserve_tokens: 26_215,
            items,
        };
        let encoded = serde_json::to_string(&compile).unwrap();
        assert!(encoded.contains("\"type\":\"system_prompt\""));
        assert!(encoded.contains("\"requestedTokens\":8192"));
        assert_eq!(
            serde_json::from_str::<ContextCompile>(&encoded).unwrap(),
            compile
        );

        let receipt = ContextCompilationReceipt {
            compilation_id: Uuid::new_v4(),
            request_number: 1,
            compiler_version: "1.0.0".to_owned(),
            tokenizer: TokenizerIdentity {
                kind: TokenizerKind::FallbackEstimate,
                id: "unicode-mixed".to_owned(),
                version: "1.0.0".to_owned(),
                provider_id: Some("provider-1".to_owned()),
                model_id: Some("model-1".to_owned()),
            },
            representation: ContextRepresentation::NormalizedMessages,
            canonical_context_sha256: "2".repeat(64),
            serialized_input_bytes: 12_000,
            estimated_input_tokens: 4_000,
            exact_input_tokens: None,
            context_window: 262_144,
            safety_reserve_tokens: 26_215,
            output_reserve_tokens: 8_192,
            available_input_tokens: 227_737,
            accepted: true,
            budget: vec![ContextBudgetAllocation {
                category: ContextBudgetCategory::SystemPrompt,
                estimated_tokens: 500,
            }],
            included_item_ids: vec!["system-1".to_owned()],
            omitted_item_ids: vec!["session-1".to_owned()],
            incomplete: true,
            disclosure: ContextDisclosure::AgentInternal,
        };
        let encoded = serde_json::to_string(&receipt).unwrap();
        assert_eq!(
            serde_json::from_str::<ContextCompilationReceipt>(&encoded).unwrap(),
            receipt
        );
    }

    #[test]
    fn context_protocol_rejects_unknown_compile_and_item_fields() {
        let compile_with_unknown = serde_json::json!({
            "compileIdempotencyKey": "compile-1",
            "invocationId": "run-1:steward",
            "requestNumber": 1,
            "provider": {
                "profileId": "profile-1",
                "providerId": "provider-1",
                "modelId": "model-1",
                "configSha256": "a"
            },
            "contextPolicy": { "id": "policy", "version": "1", "sha256": "b" },
            "compilerVersion": "1.0.0",
            "contextWindow": 128000,
            "configuredMaxOutputTokens": null,
            "safetyReserveTokens": 12800,
            "items": [],
            "unexpected": true
        });
        assert!(serde_json::from_value::<ContextCompile>(compile_with_unknown).is_err());

        let item_with_unknown = serde_json::json!({
            "type": "system_prompt",
            "itemId": "system-1",
            "content": "prompt",
            "contentSha256": "a",
            "disclosure": "agent_internal",
            "required": true,
            "unexpected": true
        });
        assert!(serde_json::from_value::<ContextItem>(item_with_unknown).is_err());

        let tokenizer_with_unknown = serde_json::json!({
            "kind": "fallback_estimate",
            "id": "unicode-mixed",
            "version": "1.0.0",
            "providerId": null,
            "modelId": null,
            "unexpected": true
        });
        assert!(serde_json::from_value::<TokenizerIdentity>(tokenizer_with_unknown).is_err());

        let receipt_with_unknown = serde_json::json!({
            "compilationId": Uuid::new_v4(),
            "requestNumber": 1,
            "compilerVersion": "1.0.0",
            "tokenizer": {
                "kind": "fallback_estimate",
                "id": "unicode-mixed",
                "version": "1.0.0",
                "providerId": null,
                "modelId": null
            },
            "representation": "normalized_messages",
            "canonicalContextSha256": "a",
            "serializedInputBytes": 1,
            "estimatedInputTokens": 1,
            "exactInputTokens": null,
            "contextWindow": 128000,
            "safetyReserveTokens": 12800,
            "outputReserveTokens": 8192,
            "availableInputTokens": 107008,
            "accepted": true,
            "budget": [],
            "includedItemIds": [],
            "omittedItemIds": [],
            "disclosure": "agent_internal",
            "unexpected": true
        });
        assert!(serde_json::from_value::<ContextCompilationReceipt>(receipt_with_unknown).is_err());
    }

    #[test]
    fn provider_inference_payloads_round_trip_strictly() {
        let run_id = Uuid::new_v4();
        let identity = ProviderInferenceIdentity {
            run_id,
            inference_id: Uuid::new_v4(),
            attempt_id: Uuid::new_v4(),
            context_compilation_id: Uuid::new_v4(),
            request_number: 1,
            attempt_number: 1,
        };
        let start = ProviderInferenceStart {
            inference_id: identity.inference_id,
            attempt_id: identity.attempt_id,
            invocation_id: "invocation-1".to_owned(),
            context_compilation_id: identity.context_compilation_id,
            request_number: 1,
            attempt_number: 1,
            inference_idempotency_key: "inference-key-1".to_owned(),
        };
        let accepted: ProviderInferenceAccepted = identity.clone();
        let error = RuntimeError {
            code: "PROVIDER_REJECTED".to_owned(),
            class: RuntimeErrorClass::ProviderRejected,
            retryable: false,
            public_message: "Provider rejected the request.".to_owned(),
            stage: "provider.inference".to_owned(),
            attempt: 1,
            diagnostic_id: Uuid::new_v4(),
        };
        let completed = ProviderInferenceCompleted {
            identity: identity.clone(),
            provider_id: "deepseek".to_owned(),
            model_id: "deepseek-chat".to_owned(),
            response_id_sha256: "a".repeat(64),
            response_body_sha256: "b".repeat(64),
            stop_reason: "stop".to_owned(),
            usage: ProviderInferenceUsage {
                input_tokens: 10,
                output_tokens: 2,
                total_tokens: 12,
            },
            output: ProviderInferenceOutput {
                text: "done".to_owned(),
                text_sha256: lowercase_sha256(b"done"),
                utf8_bytes: 4,
            },
        };
        let failed = ProviderInferenceFailed {
            identity: identity.clone(),
            error: error.clone(),
        };
        let reconciliation = ProviderInferenceReconciliationRequired {
            identity,
            reason: ProviderInferenceReconciliationReason::OutcomeUnknown,
            error,
        };

        let start_json = serde_json::to_value(&start).unwrap();
        let accepted_json = serde_json::to_value(&accepted).unwrap();
        let completed_json = serde_json::to_value(&completed).unwrap();
        let failed_json = serde_json::to_value(&failed).unwrap();
        let reconciliation_json = serde_json::to_value(&reconciliation).unwrap();
        assert_eq!(start.validate(), Ok(()));
        assert_eq!(accepted.validate(), Ok(()));
        assert_eq!(completed.validate(), Ok(()));
        assert_eq!(failed.validate(), Ok(()));
        assert_eq!(reconciliation.validate(), Ok(()));
        assert_eq!(
            serde_json::from_value::<ProviderInferenceStart>(start_json).unwrap(),
            start
        );
        assert_eq!(
            serde_json::from_value::<ProviderInferenceAccepted>(accepted_json).unwrap(),
            accepted
        );
        assert_eq!(
            serde_json::from_value::<ProviderInferenceCompleted>(completed_json).unwrap(),
            completed
        );
        assert_eq!(
            serde_json::from_value::<ProviderInferenceFailed>(failed_json).unwrap(),
            failed
        );
        assert_eq!(
            serde_json::from_value::<ProviderInferenceReconciliationRequired>(reconciliation_json)
                .unwrap(),
            reconciliation
        );
    }

    #[test]
    fn provider_inference_payloads_reject_unknown_fields_and_bad_uuids() {
        let start_with_unknown = serde_json::json!({
            "inferenceId": Uuid::new_v4(),
            "attemptId": Uuid::new_v4(),
            "invocationId": "invocation-1",
            "contextCompilationId": Uuid::new_v4(),
            "requestNumber": 1,
            "attemptNumber": 1,
            "inferenceIdempotencyKey": "inference-key-1",
            "credential": "must-not-cross-protocol"
        });
        assert!(serde_json::from_value::<ProviderInferenceStart>(start_with_unknown).is_err());

        let identity_with_bad_uuid = serde_json::json!({
            "runId": "not-a-uuid",
            "inferenceId": Uuid::new_v4(),
            "attemptId": Uuid::new_v4(),
            "contextCompilationId": Uuid::new_v4(),
            "requestNumber": 1,
            "attemptNumber": 1
        });
        assert!(
            serde_json::from_value::<ProviderInferenceIdentity>(identity_with_bad_uuid).is_err()
        );

        let reconciliation_with_bad_reason = serde_json::json!({
            "runId": Uuid::new_v4(),
            "inferenceId": Uuid::new_v4(),
            "attemptId": Uuid::new_v4(),
            "contextCompilationId": Uuid::new_v4(),
            "requestNumber": 1,
            "attemptNumber": 1,
            "reason": "retry",
            "error": {
                "code": "PROVIDER_OUTCOME_UNKNOWN",
                "class": "provider_timeout",
                "retryable": false,
                "publicMessage": "Outcome unknown.",
                "stage": "provider.inference",
                "attempt": 1,
                "diagnosticId": Uuid::new_v4()
            }
        });
        assert!(
            serde_json::from_value::<ProviderInferenceReconciliationRequired>(
                reconciliation_with_bad_reason
            )
            .is_err()
        );
    }

    #[test]
    fn provider_inference_validation_rejects_semantically_invalid_payloads() {
        let identity = ProviderInferenceIdentity {
            run_id: Uuid::new_v4(),
            inference_id: Uuid::new_v4(),
            attempt_id: Uuid::new_v4(),
            context_compilation_id: Uuid::new_v4(),
            request_number: 1,
            attempt_number: 1,
        };
        let error = RuntimeError {
            code: "PROVIDER_OUTCOME_UNKNOWN".to_owned(),
            class: RuntimeErrorClass::ProviderTimeout,
            retryable: false,
            public_message: "Outcome unknown.".to_owned(),
            stage: "provider.inference".to_owned(),
            attempt: 1,
            diagnostic_id: Uuid::new_v4(),
        };
        let valid_completed = ProviderInferenceCompleted {
            identity: identity.clone(),
            provider_id: "deepseek".to_owned(),
            model_id: "deepseek-chat".to_owned(),
            response_id_sha256: "a".repeat(64),
            response_body_sha256: "b".repeat(64),
            stop_reason: "stop".to_owned(),
            usage: ProviderInferenceUsage {
                input_tokens: 10,
                output_tokens: 2,
                total_tokens: 12,
            },
            output: ProviderInferenceOutput {
                text: "done".to_owned(),
                text_sha256: lowercase_sha256(b"done"),
                utf8_bytes: 4,
            },
        };

        let mut start = ProviderInferenceStart {
            inference_id: identity.inference_id,
            attempt_id: identity.attempt_id,
            invocation_id: " ".to_owned(),
            context_compilation_id: identity.context_compilation_id,
            request_number: 1,
            attempt_number: 1,
            inference_idempotency_key: "key".to_owned(),
        };
        assert_eq!(
            start.validate(),
            Err(ProviderInferenceValidationError::EmptyIdentity {
                field: "invocationId"
            })
        );
        start.invocation_id = "invocation".to_owned();
        start.request_number = 0;
        assert_eq!(
            start.validate(),
            Err(ProviderInferenceValidationError::NumberMustBePositive {
                field: "requestNumber"
            })
        );

        let mut completed = valid_completed.clone();
        completed.provider_id.clear();
        assert!(matches!(
            completed.validate(),
            Err(ProviderInferenceValidationError::EmptyIdentity {
                field: "providerId"
            })
        ));
        completed = valid_completed.clone();
        completed.response_id_sha256 = "A".repeat(64);
        assert!(matches!(
            completed.validate(),
            Err(ProviderInferenceValidationError::InvalidSha256 {
                field: "responseIdSha256"
            })
        ));
        completed = valid_completed.clone();
        completed.usage.total_tokens = 11;
        assert_eq!(
            completed.validate(),
            Err(ProviderInferenceValidationError::UsageTotalMismatch)
        );
        completed = valid_completed.clone();
        completed.output.text.clear();
        assert_eq!(
            completed.validate(),
            Err(ProviderInferenceValidationError::OutputEmpty)
        );
        completed = valid_completed.clone();
        completed.output.utf8_bytes = 3;
        assert!(matches!(
            completed.validate(),
            Err(ProviderInferenceValidationError::OutputByteLengthMismatch { .. })
        ));
        completed = valid_completed.clone();
        completed.output.text_sha256 = "c".repeat(64);
        assert_eq!(
            completed.validate(),
            Err(ProviderInferenceValidationError::OutputHashMismatch)
        );
        completed = valid_completed;
        completed.output.text = "a".repeat(MAX_PROVIDER_INFERENCE_OUTPUT_BYTES + 1);
        completed.output.text_sha256 = lowercase_sha256(completed.output.text.as_bytes());
        completed.output.utf8_bytes = completed.output.text.len() as u64;
        assert!(matches!(
            completed.validate(),
            Err(ProviderInferenceValidationError::OutputTooLarge { .. })
        ));

        let reconciliation = ProviderInferenceReconciliationRequired {
            identity,
            reason: ProviderInferenceReconciliationReason::OutcomeUnknown,
            error: RuntimeError {
                retryable: true,
                ..error
            },
        };
        assert_eq!(
            reconciliation.validate(),
            Err(ProviderInferenceValidationError::ReconciliationCannotBeRetryable)
        );
    }
}
