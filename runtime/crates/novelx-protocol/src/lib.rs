use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;

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
        if self.protocol_version == PROTOCOL_VERSION {
            Ok(())
        } else {
            Err(ProtocolError::UnsupportedVersion {
                received: self.protocol_version,
                supported: PROTOCOL_VERSION,
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    UnsupportedVersion { received: u16, supported: u16 },
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
}
