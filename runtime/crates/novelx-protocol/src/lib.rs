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
}
