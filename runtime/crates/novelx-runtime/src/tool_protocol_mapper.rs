use novelx_protocol::{
    MessageType, RunPermissionMode, RuntimeError, ToolAuthorized, ToolEventIdentity, ToolFailed,
    ToolPermissionDecision, ToolRequest, ToolRequested, ToolRunning, ToolSucceeded,
};
use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;

use crate::runtime_actor::RuntimeOutputDraft;
use crate::tool_coordination_service::{ToolCoordinationSnapshot, ToolCoordinationStatus};

pub struct ToolProtocolMapper {
    correlation_id: Uuid,
    sent_at: String,
}

impl ToolProtocolMapper {
    pub fn new(correlation_id: Uuid, sent_at: impl Into<String>) -> Self {
        Self {
            correlation_id,
            sent_at: sent_at.into(),
        }
    }

    pub fn requested(
        &self,
        run_id: Uuid,
        request: &ToolRequest,
        snapshot: &ToolCoordinationSnapshot,
    ) -> Result<RuntimeOutputDraft, ToolProtocolMapperError> {
        let authorization = match request.permission.mode {
            RunPermissionMode::Free => ToolPermissionDecision::Allowed,
            RunPermissionMode::Assist => ToolPermissionDecision::ApprovalRequired,
        };
        let payload = ToolRequested {
            identity: identity(run_id, request, snapshot)?,
            permission: request.permission.clone(),
            authorization,
        };
        payload
            .validate()
            .map_err(|_| ToolProtocolMapperError::PayloadInvalid)?;
        self.draft("tool.requested", run_id, payload)
    }

    pub fn authorized(
        &self,
        run_id: Uuid,
        request: &ToolRequest,
        snapshot: &ToolCoordinationSnapshot,
    ) -> Result<RuntimeOutputDraft, ToolProtocolMapperError> {
        if snapshot.status != ToolCoordinationStatus::Authorized {
            return Err(ToolProtocolMapperError::StateMismatch);
        }
        let payload = ToolAuthorized {
            identity: identity(run_id, request, snapshot)?,
            lease: snapshot
                .lease
                .clone()
                .ok_or(ToolProtocolMapperError::LeaseMissing)?,
        };
        payload
            .validate()
            .map_err(|_| ToolProtocolMapperError::PayloadInvalid)?;
        self.draft("tool.authorized", run_id, payload)
    }

    pub fn running(
        &self,
        run_id: Uuid,
        request: &ToolRequest,
        snapshot: &ToolCoordinationSnapshot,
    ) -> Result<RuntimeOutputDraft, ToolProtocolMapperError> {
        if snapshot.status != ToolCoordinationStatus::Running {
            return Err(ToolProtocolMapperError::StateMismatch);
        }
        let payload = ToolRunning {
            identity: identity(run_id, request, snapshot)?,
            lease: snapshot
                .lease
                .clone()
                .ok_or(ToolProtocolMapperError::LeaseMissing)?,
        };
        payload
            .validate()
            .map_err(|_| ToolProtocolMapperError::PayloadInvalid)?;
        self.draft("tool.running", run_id, payload)
    }

    pub fn succeeded(
        &self,
        run_id: Uuid,
        request: &ToolRequest,
        snapshot: &ToolCoordinationSnapshot,
    ) -> Result<RuntimeOutputDraft, ToolProtocolMapperError> {
        if snapshot.status != ToolCoordinationStatus::Succeeded {
            return Err(ToolProtocolMapperError::StateMismatch);
        }
        let lease = snapshot
            .lease
            .as_ref()
            .ok_or(ToolProtocolMapperError::LeaseMissing)?;
        let payload = ToolSucceeded {
            identity: identity(run_id, request, snapshot)?,
            lease_id: lease.lease_id,
            result: snapshot
                .result
                .clone()
                .ok_or(ToolProtocolMapperError::ResultMissing)?,
        };
        payload
            .validate()
            .map_err(|_| ToolProtocolMapperError::PayloadInvalid)?;
        self.draft("tool.succeeded", run_id, payload)
    }

    pub fn failed(
        &self,
        run_id: Uuid,
        request: &ToolRequest,
        snapshot: &ToolCoordinationSnapshot,
        error: RuntimeError,
    ) -> Result<RuntimeOutputDraft, ToolProtocolMapperError> {
        if snapshot.status != ToolCoordinationStatus::Failed {
            return Err(ToolProtocolMapperError::StateMismatch);
        }
        let payload = ToolFailed {
            identity: identity(run_id, request, snapshot)?,
            lease_id: snapshot.lease.as_ref().map(|lease| lease.lease_id),
            error,
        };
        payload
            .validate()
            .map_err(|_| ToolProtocolMapperError::PayloadInvalid)?;
        self.draft("tool.failed", run_id, payload)
    }

    fn draft(
        &self,
        name: &str,
        run_id: Uuid,
        payload: impl Serialize,
    ) -> Result<RuntimeOutputDraft, ToolProtocolMapperError> {
        Ok(RuntimeOutputDraft {
            message_type: MessageType::Event,
            name: name.to_owned(),
            sent_at: self.sent_at.clone(),
            correlation_id: Some(self.correlation_id),
            run_id: Some(run_id),
            payload: serde_json::to_value(payload)?,
        })
    }
}

fn identity(
    run_id: Uuid,
    request: &ToolRequest,
    snapshot: &ToolCoordinationSnapshot,
) -> Result<ToolEventIdentity, ToolProtocolMapperError> {
    if snapshot.run_id != run_id.to_string() || snapshot.tool_call_id != request.tool_call_id {
        return Err(ToolProtocolMapperError::IdentityMismatch);
    }
    Ok(ToolEventIdentity {
        run_id,
        tool_call_id: request.tool_call_id,
        provider_tool_call_id: request.provider_tool_call_id.clone(),
        invocation_id: request.invocation_id.clone(),
        tool_name: request.tool_name.clone(),
        schema_version: request.schema_version,
        attempt: request.attempt,
        side_effect: request.side_effect,
        parallel: request.parallel,
        arguments_sha256: request.arguments.sha256.clone(),
        source_scope_sha256: request.source_scope.scope_sha256.clone(),
    })
}

#[derive(Debug, Error)]
pub enum ToolProtocolMapperError {
    #[error("ToolCall protocol identity does not match persisted coordination state")]
    IdentityMismatch,
    #[error("ToolCall protocol event does not match the persisted state")]
    StateMismatch,
    #[error("ToolCall permission lease is missing")]
    LeaseMissing,
    #[error("ToolCall result artifact is missing")]
    ResultMissing,
    #[error("ToolCall public protocol payload is invalid")]
    PayloadInvalid,
    #[error(transparent)]
    Serialize(#[from] serde_json::Error),
}
