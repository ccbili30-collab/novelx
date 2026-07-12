use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
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
}
