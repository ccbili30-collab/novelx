use novelx_protocol::{
    MessageType, ProviderInferenceAccepted, ProviderInferenceCompleted, ProviderInferenceFailed,
    ProviderInferenceIdentity, ProviderInferenceOutput, ProviderInferenceReconciliationReason,
    ProviderInferenceReconciliationRequired, ProviderInferenceToolCall, ProviderInferenceUsage,
    ProviderInferenceValidationError, RuntimeError, RuntimeErrorClass,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::provider_attempt::ProviderAttemptRecovery;
use crate::provider_gateway::{ProviderGatewayError, ProviderInferenceOutcome};
use crate::provider_inference_service::{
    ProviderInferenceExecution, ProviderInferenceServiceError,
};
use crate::runtime_actor::RuntimeOutputDraft;

pub struct ProviderInferenceProtocolMapper {
    correlation_id: Uuid,
    sent_at: String,
}

#[derive(Debug, Error)]
pub enum ProviderInferenceProtocolMapperError {
    #[error("Provider inference protocol identity `{field}` is not a UUID")]
    InvalidUuid { field: &'static str },
    #[error("Provider inference outcome identity does not match its execution")]
    OutcomeIdentityMismatch,
    #[error("Provider inference error belongs to a different terminal protocol event")]
    WrongTerminalKind,
    #[error(transparent)]
    InvalidPayload(#[from] ProviderInferenceValidationError),
    #[error(transparent)]
    Serialize(#[from] serde_json::Error),
}

impl ProviderInferenceProtocolMapper {
    pub fn new(correlation_id: Uuid, sent_at: impl Into<String>) -> Self {
        Self {
            correlation_id,
            sent_at: sent_at.into(),
        }
    }

    pub fn accepted(
        &self,
        execution: &ProviderInferenceExecution,
    ) -> Result<RuntimeOutputDraft, ProviderInferenceProtocolMapperError> {
        let payload: ProviderInferenceAccepted = identity(execution)?;
        payload.validate()?;
        self.draft(
            MessageType::Response,
            "provider.inference.accepted",
            payload,
        )
    }

    pub fn rejected(
        &self,
        execution: &ProviderInferenceExecution,
        error: &ProviderInferenceServiceError,
    ) -> Result<RuntimeOutputDraft, ProviderInferenceProtocolMapperError> {
        Ok(RuntimeOutputDraft {
            message_type: MessageType::Event,
            name: "runtime.error".to_owned(),
            sent_at: self.sent_at.clone(),
            correlation_id: Some(self.correlation_id),
            run_id: Some(parse_uuid("runId", &execution.run_id)?),
            payload: serde_json::to_value(runtime_error(execution, error))?,
        })
    }

    pub fn completed(
        &self,
        execution: &ProviderInferenceExecution,
        outcome: &ProviderInferenceOutcome,
    ) -> Result<RuntimeOutputDraft, ProviderInferenceProtocolMapperError> {
        if outcome.receipt.context_compilation_id != execution.request.compilation.compilation_id
            || outcome.receipt.canonical_context_sha256
                != execution.request.compilation.canonical_context_sha256
            || outcome.receipt.requested_model_id != execution.provider.model_id
        {
            return Err(ProviderInferenceProtocolMapperError::OutcomeIdentityMismatch);
        }
        let payload = ProviderInferenceCompleted {
            identity: identity(execution)?,
            provider_id: execution.provider.provider_id.clone(),
            model_id: outcome.receipt.actual_model_id.clone(),
            response_id_sha256: outcome.receipt.response_id_sha256.clone(),
            response_body_sha256: outcome.receipt.response_body_sha256.clone(),
            stop_reason: outcome.receipt.finish_reason.clone(),
            usage: ProviderInferenceUsage {
                input_tokens: outcome.receipt.usage.input_tokens,
                output_tokens: outcome.receipt.usage.output_tokens,
                total_tokens: outcome.receipt.usage.total_tokens,
            },
            output: outcome.text.as_ref().map(|text| ProviderInferenceOutput {
                text: text.clone(),
                text_sha256: lowercase_sha256(text.as_bytes()),
                utf8_bytes: text.len() as u64,
            }),
            tool_calls: outcome
                .tool_calls
                .iter()
                .map(|call| ProviderInferenceToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                    arguments_sha256: call.arguments_sha256.clone(),
                })
                .collect(),
        };
        payload.validate()?;
        self.draft(MessageType::Event, "provider.inference.completed", payload)
    }

    pub fn failed(
        &self,
        execution: &ProviderInferenceExecution,
        error: &ProviderInferenceServiceError,
    ) -> Result<RuntimeOutputDraft, ProviderInferenceProtocolMapperError> {
        if is_unknown_outcome(error) {
            return Err(ProviderInferenceProtocolMapperError::WrongTerminalKind);
        }
        let payload = ProviderInferenceFailed {
            identity: identity(execution)?,
            error: runtime_error(execution, error),
        };
        payload.validate()?;
        self.draft(MessageType::Event, "provider.inference.failed", payload)
    }

    pub fn reconciliation_required(
        &self,
        execution: &ProviderInferenceExecution,
        error: &ProviderInferenceServiceError,
    ) -> Result<RuntimeOutputDraft, ProviderInferenceProtocolMapperError> {
        if !is_unknown_outcome(error) {
            return Err(ProviderInferenceProtocolMapperError::WrongTerminalKind);
        }
        let payload = ProviderInferenceReconciliationRequired {
            identity: identity(execution)?,
            reason: ProviderInferenceReconciliationReason::OutcomeUnknown,
            error: RuntimeError {
                code: "PROVIDER_OUTCOME_UNKNOWN".to_owned(),
                class: RuntimeErrorClass::ProviderRejected,
                retryable: false,
                public_message:
                    "Provider inference outcome is unknown and requires reconciliation.".to_owned(),
                stage: "provider.inference".to_owned(),
                attempt: u64::from(execution.attempt_number),
                diagnostic_id: Uuid::new_v4(),
            },
        };
        payload.validate()?;
        self.draft(
            MessageType::Event,
            "provider.inference.reconciliation_required",
            payload,
        )
    }

    fn draft(
        &self,
        message_type: MessageType,
        name: &str,
        payload: impl Serialize,
    ) -> Result<RuntimeOutputDraft, ProviderInferenceProtocolMapperError> {
        let run_id = payload_run_id(&payload)?;
        Ok(RuntimeOutputDraft {
            message_type,
            name: name.to_owned(),
            sent_at: self.sent_at.clone(),
            correlation_id: Some(self.correlation_id),
            run_id: Some(run_id),
            payload: serde_json::to_value(payload)?,
        })
    }
}

fn identity(
    execution: &ProviderInferenceExecution,
) -> Result<ProviderInferenceIdentity, ProviderInferenceProtocolMapperError> {
    Ok(ProviderInferenceIdentity {
        run_id: parse_uuid("runId", &execution.run_id)?,
        inference_id: parse_uuid("inferenceId", &execution.inference_id)?,
        attempt_id: parse_uuid("attemptId", &execution.attempt_id)?,
        context_compilation_id: execution.request.compilation.compilation_id,
        request_number: execution.request.compilation.request_number,
        attempt_number: u64::from(execution.attempt_number),
    })
}

fn payload_run_id(payload: &impl Serialize) -> Result<Uuid, ProviderInferenceProtocolMapperError> {
    let value = serde_json::to_value(payload)?;
    let run_id = value
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .ok_or(ProviderInferenceProtocolMapperError::InvalidUuid { field: "runId" })?;
    parse_uuid("runId", run_id)
}

fn parse_uuid(
    field: &'static str,
    value: &str,
) -> Result<Uuid, ProviderInferenceProtocolMapperError> {
    Uuid::parse_str(value).map_err(|_| ProviderInferenceProtocolMapperError::InvalidUuid { field })
}

fn runtime_error(
    execution: &ProviderInferenceExecution,
    error: &ProviderInferenceServiceError,
) -> RuntimeError {
    let (code, class, retryable, public_message) = classify_error(error);
    RuntimeError {
        code: code.to_owned(),
        class,
        retryable,
        public_message: public_message.to_owned(),
        stage: "provider.inference".to_owned(),
        attempt: u64::from(execution.attempt_number),
        diagnostic_id: Uuid::new_v4(),
    }
}

fn classify_error(
    error: &ProviderInferenceServiceError,
) -> (&'static str, RuntimeErrorClass, bool, &'static str) {
    match error {
        ProviderInferenceServiceError::Gateway(gateway) => classify_gateway_error(gateway),
        ProviderInferenceServiceError::InvalidExecution => (
            "PROVIDER_INFERENCE_INVALID",
            RuntimeErrorClass::Validation,
            false,
            "Provider inference execution is invalid.",
        ),
        ProviderInferenceServiceError::ContextReceiptNotPersisted => (
            "CONTEXT_RECEIPT_NOT_PERSISTED",
            RuntimeErrorClass::Validation,
            false,
            "The accepted Context Compilation is unavailable.",
        ),
        ProviderInferenceServiceError::PinnedProviderMismatch => (
            "PINNED_PROVIDER_MISMATCH",
            RuntimeErrorClass::Validation,
            false,
            "The Provider does not match the Run identity.",
        ),
        ProviderInferenceServiceError::RunNotRunning(crate::run_state::RunState::Cancelled) => (
            "RUN_CANCELLED",
            RuntimeErrorClass::Validation,
            false,
            "Provider inference finished after the Run was cancelled.",
        ),
        ProviderInferenceServiceError::RunNotRunning(_) => (
            "RUN_NOT_RUNNING",
            RuntimeErrorClass::Validation,
            false,
            "The Run cannot perform Provider inference in its current state.",
        ),
        ProviderInferenceServiceError::ContextNormalizedInputInvalid => (
            "CONTEXT_INPUT_INVALID",
            RuntimeErrorClass::Validation,
            false,
            "The persisted Provider input is invalid.",
        ),
        ProviderInferenceServiceError::ContextNormalizedInputHashMismatch => (
            "CONTEXT_INPUT_HASH_MISMATCH",
            RuntimeErrorClass::Validation,
            false,
            "The persisted Provider input failed integrity validation.",
        ),
        ProviderInferenceServiceError::ExistingTerminal(_) => (
            "PROVIDER_ATTEMPT_ALREADY_TERMINAL",
            RuntimeErrorClass::Validation,
            false,
            "The Provider attempt already has a terminal result.",
        ),
        ProviderInferenceServiceError::Attempt(_)
        | ProviderInferenceServiceError::Journal(_)
        | ProviderInferenceServiceError::Run(_) => (
            "PROVIDER_INFERENCE_STORAGE_FAILED",
            RuntimeErrorClass::Storage,
            false,
            "Provider inference state could not be persisted.",
        ),
        ProviderInferenceServiceError::Time(_) => (
            "PROVIDER_INFERENCE_RUNTIME_FAILED",
            RuntimeErrorClass::RuntimeCrash,
            false,
            "Provider inference runtime processing failed.",
        ),
        ProviderInferenceServiceError::OutcomeUnknown
        | ProviderInferenceServiceError::FinalizationOutcomeUnknown
        | ProviderInferenceServiceError::DeliveryUnknown(_) => (
            "PROVIDER_OUTCOME_UNKNOWN",
            RuntimeErrorClass::ProviderRejected,
            false,
            "Provider inference outcome is unknown and requires reconciliation.",
        ),
        ProviderInferenceServiceError::CancelledAfterDispatch => (
            "RUN_CANCELLED",
            RuntimeErrorClass::Cancelled,
            false,
            "Provider inference was cancelled after dispatch.",
        ),
    }
}

fn classify_gateway_error(
    error: &ProviderGatewayError,
) -> (&'static str, RuntimeErrorClass, bool, &'static str) {
    match error {
        ProviderGatewayError::AuthenticationRejected(_)
        | ProviderGatewayError::CredentialInvalid
        | ProviderGatewayError::CredentialRequired => (
            "PROVIDER_AUTH_REJECTED",
            RuntimeErrorClass::ProviderAuth,
            false,
            "Provider authentication failed.",
        ),
        ProviderGatewayError::RateLimited(_) => (
            "PROVIDER_RATE_LIMITED",
            RuntimeErrorClass::ProviderRateLimit,
            true,
            "The Provider rate limit was reached.",
        ),
        ProviderGatewayError::Timeout => (
            "PROVIDER_TIMEOUT",
            RuntimeErrorClass::ProviderTimeout,
            true,
            "The Provider request timed out.",
        ),
        ProviderGatewayError::HttpRejected(status) => (
            "PROVIDER_HTTP_REJECTED",
            RuntimeErrorClass::ProviderRejected,
            *status >= 500,
            "The Provider rejected the request.",
        ),
        ProviderGatewayError::ConnectionFailed | ProviderGatewayError::RequestFailed => (
            "PROVIDER_TRANSPORT_FAILED",
            RuntimeErrorClass::ProviderRejected,
            true,
            "The Provider request could not be completed.",
        ),
        _ => (
            "PROVIDER_REQUEST_REJECTED",
            RuntimeErrorClass::ProviderRejected,
            false,
            "Provider inference was rejected.",
        ),
    }
}

fn is_unknown_outcome(error: &ProviderInferenceServiceError) -> bool {
    matches!(
        error,
        ProviderInferenceServiceError::OutcomeUnknown
            | ProviderInferenceServiceError::FinalizationOutcomeUnknown
            | ProviderInferenceServiceError::CancelledAfterDispatch
            | ProviderInferenceServiceError::DeliveryUnknown(_)
            | ProviderInferenceServiceError::ExistingTerminal(
                ProviderAttemptRecovery::OutcomeUnknown
            )
    )
}

fn lowercase_sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

#[cfg(test)]
#[path = "../tests/provider_inference_protocol.rs"]
mod tests;
