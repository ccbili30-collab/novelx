use novelx_protocol::ProviderRunIdentity;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum OperationalRecoveryAction {
    PersistedProviderResultProjection {
        invocation_id: String,
        attempt_id: String,
        expected_loop_checkpoint_sha256: String,
        expected_attempt_sequence: u64,
        response_body_sha256: String,
    },
    PersistedProviderAttemptDispatch {
        invocation_id: String,
        attempt_id: String,
        inference_id: String,
        context_compilation_id: String,
        attempt_number: u16,
        provider: ProviderRunIdentity,
        canonical_context_sha256: String,
        expected_loop_checkpoint_sha256: String,
        expected_attempt_sequence: u64,
        transport_payload_sha256: String,
    },
    ContextEvidenceRequired {
        invocation_id: String,
    },
    ProviderDispatchRequired {
        invocation_id: Option<String>,
    },
    ToolEvidenceOrDispatchRequired {
        invocation_id: String,
    },
    InferenceStartEvidenceRequired {
        invocation_id: String,
    },
    PersistedEvidenceConflict {
        invocation_id: String,
    },
    NoExecutableProjection,
    TerminalProjection,
}

impl OperationalRecoveryAction {
    pub fn action_spec_sha256(&self) -> Result<String, serde_json::Error> {
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
        let value = canonicalize(serde_json::to_value(self)?);
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(&value)?)))
    }

    pub const fn may_execute_without_new_external_effect(&self) -> bool {
        matches!(self, Self::PersistedProviderResultProjection { .. })
    }
}
