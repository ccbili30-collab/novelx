use novelx_protocol::{
    ContextCompilationReceipt, ContextDisclosure, ContextRepresentation, MessageType,
    ProviderInferenceAccepted, ProviderInferenceCompleted, ProviderInferenceFailed,
    ProviderInferenceReconciliationReason, ProviderInferenceReconciliationRequired,
    ProviderRunIdentity, RuntimeErrorClass, TokenizerIdentity, TokenizerKind,
};
use novelx_runtime::provider_gateway::{
    ProviderGatewayError, ProviderInferenceMessage, ProviderInferenceOutcome,
    ProviderInferenceReceipt, ProviderInferenceRequest, ProviderInferenceRole,
    ProviderUsageReceipt,
};
use novelx_runtime::provider_inference_protocol::ProviderInferenceProtocolMapper;
use novelx_runtime::provider_inference_service::{
    ProviderInferenceExecution, ProviderInferenceServiceError,
};
use novelx_runtime::provider_retry_after::{ProviderRetryAfterKind, ProviderRetryAfterReceipt};
use uuid::Uuid;

#[test]
fn maps_acceptance_and_completion_with_identical_protocol_identity() {
    let command_id = Uuid::new_v4();
    let execution = execution();
    let mapper = ProviderInferenceProtocolMapper::new(command_id, "2026-07-12T00:00:00Z");
    let accepted = mapper.accepted(&execution).unwrap();
    let completed = mapper.completed(&execution, &outcome(&execution)).unwrap();
    let accepted_payload: ProviderInferenceAccepted =
        serde_json::from_value(accepted.payload).unwrap();
    let completed_payload: ProviderInferenceCompleted =
        serde_json::from_value(completed.payload).unwrap();

    assert_eq!(accepted.message_type, MessageType::Response);
    assert_eq!(accepted.name, "provider.inference.accepted");
    assert_eq!(completed.message_type, MessageType::Event);
    assert_eq!(completed.name, "provider.inference.completed");
    assert_eq!(accepted.correlation_id, Some(command_id));
    assert_eq!(completed.correlation_id, Some(command_id));
    assert_eq!(accepted_payload, completed_payload.identity);
    assert_eq!(completed_payload.output.as_ref().unwrap().utf8_bytes, 4);
    assert_eq!(completed_payload.usage.total_tokens, 12);
    completed_payload.validate().unwrap();
}

#[test]
fn maps_known_failure_with_the_attempt_ledgers_retryability_declaration() {
    let execution = execution();
    let mapper = ProviderInferenceProtocolMapper::new(Uuid::new_v4(), "2026-07-12T00:00:00Z");
    for (status, expected_retryable) in [(400, false), (500, true), (501, false), (503, true)] {
        let error = ProviderInferenceServiceError::Gateway(ProviderGatewayError::HttpRejected(
            novelx_runtime::provider_gateway::ProviderHttpFailureReceipt {
                status,
                retry_after: None,
            },
        ));
        let draft = mapper.failed(&execution, &error).unwrap();
        let payload: ProviderInferenceFailed = serde_json::from_value(draft.payload).unwrap();
        assert_eq!(payload.error.class, RuntimeErrorClass::ProviderRejected);
        assert_eq!(payload.error.retryable, expected_retryable);
        assert_eq!(payload.error.code, "PROVIDER_HTTP_REJECTED");
    }
}

#[test]
fn rate_limit_is_retryable_only_with_a_valid_persisted_wait_receipt() {
    let execution = execution();
    let mapper = ProviderInferenceProtocolMapper::new(Uuid::new_v4(), "2026-07-12T00:00:00Z");
    for (retry_after, expected_retryable) in [
        (None, false),
        (
            Some(ProviderRetryAfterReceipt {
                value_sha256: "a".repeat(64),
                kind: ProviderRetryAfterKind::DeltaSeconds,
                delay_ms: 0,
            }),
            true,
        ),
    ] {
        let error = ProviderInferenceServiceError::Gateway(ProviderGatewayError::RateLimited(
            novelx_runtime::provider_gateway::ProviderHttpFailureReceipt {
                status: 429,
                retry_after,
            },
        ));
        let draft = mapper.failed(&execution, &error).unwrap();
        let payload: ProviderInferenceFailed = serde_json::from_value(draft.payload).unwrap();
        assert_eq!(payload.error.retryable, expected_retryable);
        assert_eq!(payload.error.code, "PROVIDER_RATE_LIMITED");
    }
}

#[test]
fn maps_unknown_delivery_only_to_nonretryable_reconciliation() {
    let execution = execution();
    let mapper = ProviderInferenceProtocolMapper::new(Uuid::new_v4(), "2026-07-12T00:00:00Z");
    for error in [
        ProviderInferenceServiceError::OutcomeUnknown,
        ProviderInferenceServiceError::FinalizationOutcomeUnknown,
    ] {
        let draft = mapper.reconciliation_required(&execution, &error).unwrap();
        let payload: ProviderInferenceReconciliationRequired =
            serde_json::from_value(draft.payload).unwrap();
        assert_eq!(draft.name, "provider.inference.reconciliation_required");
        assert_eq!(
            payload.reason,
            ProviderInferenceReconciliationReason::OutcomeUnknown
        );
        assert!(!payload.error.retryable);
        payload.validate().unwrap();
    }
}

#[test]
fn maps_pre_accept_rejection_without_requiring_run_id_inside_runtime_error_payload() {
    let execution = execution();
    let mapper = ProviderInferenceProtocolMapper::new(
        Uuid::parse_str("1a74beb8-2fcf-41f8-b0eb-d846b68641dc").unwrap(),
        "2026-07-12T00:00:00Z",
    );
    let draft = mapper
        .rejected(&execution, &ProviderInferenceServiceError::InvalidExecution)
        .unwrap();

    assert_eq!(draft.name, "runtime.error");
    assert_eq!(draft.message_type, MessageType::Event);
    assert_eq!(
        draft.run_id,
        Some(Uuid::parse_str(&execution.run_id).unwrap())
    );
    assert_eq!(draft.payload["code"], "PROVIDER_INFERENCE_INVALID");
    assert!(draft.payload.get("runId").is_none());
}

#[test]
fn maps_attempt_single_flight_conflicts_without_suggesting_a_provider_retry() {
    let execution = execution();
    let mapper = ProviderInferenceProtocolMapper::new(Uuid::new_v4(), "2026-07-12T00:00:00Z");
    let draft = mapper
        .rejected(
            &execution,
            &ProviderInferenceServiceError::AttemptInFlight {
                run_id: execution.run_id.clone(),
                attempt_id: execution.attempt_id.clone(),
            },
        )
        .unwrap();

    assert_eq!(draft.payload["code"], "PROVIDER_ATTEMPT_IN_FLIGHT");
    assert_eq!(draft.payload["class"], "validation");
    assert_eq!(draft.payload["retryable"], false);
}

#[test]
fn refuses_completion_whose_context_identity_does_not_match_execution() {
    let execution = execution();
    let mapper = ProviderInferenceProtocolMapper::new(Uuid::new_v4(), "2026-07-12T00:00:00Z");
    let mut mismatched = outcome(&execution);
    mismatched.receipt.context_compilation_id = Uuid::new_v4();
    assert!(mapper.completed(&execution, &mismatched).is_err());
}

fn execution() -> ProviderInferenceExecution {
    let compilation = ContextCompilationReceipt {
        compilation_id: Uuid::new_v4(),
        request_number: 1,
        compiler_version: "1.0.0".to_owned(),
        tokenizer: TokenizerIdentity {
            kind: TokenizerKind::FallbackEstimate,
            id: "fallback".to_owned(),
            version: "1.0.0".to_owned(),
            provider_id: Some("deepseek".to_owned()),
            model_id: Some("deepseek-chat".to_owned()),
        },
        representation: ContextRepresentation::NormalizedMessages,
        canonical_context_sha256: "a".repeat(64),
        serialized_input_bytes: 1,
        estimated_input_tokens: 10,
        exact_input_tokens: None,
        context_window: 128_000,
        safety_reserve_tokens: 1_000,
        output_reserve_tokens: 1_000,
        available_input_tokens: 126_000,
        accepted: true,
        budget: vec![],
        included_item_ids: vec![],
        omitted_item_ids: vec![],
        incomplete: false,
        disclosure: ContextDisclosure::AgentInternal,
    };
    ProviderInferenceExecution {
        run_id: Uuid::new_v4().to_string(),
        attempt_id: Uuid::new_v4().to_string(),
        inference_id: Uuid::new_v4().to_string(),
        invocation_id: "invocation-1".to_owned(),
        inference_idempotency_key: "inference-key-1".to_owned(),
        attempt_number: 1,
        provider: ProviderRunIdentity {
            profile_id: "profile-1".to_owned(),
            provider_id: "deepseek".to_owned(),
            model_id: "deepseek-chat".to_owned(),
            config_sha256: "b".repeat(64),
        },
        request: ProviderInferenceRequest {
            compilation,
            messages: vec![ProviderInferenceMessage {
                role: ProviderInferenceRole::User,
                content: "ping".to_owned(),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            tools: vec![],
        },
    }
}

fn outcome(execution: &ProviderInferenceExecution) -> ProviderInferenceOutcome {
    ProviderInferenceOutcome {
        text: Some("done".to_owned()),
        tool_calls: vec![],
        receipt: ProviderInferenceReceipt {
            context_compilation_id: execution.request.compilation.compilation_id,
            canonical_context_sha256: execution
                .request
                .compilation
                .canonical_context_sha256
                .clone(),
            requested_model_id: execution.provider.model_id.clone(),
            actual_model_id: "deepseek-chat".to_owned(),
            response_id_sha256: "c".repeat(64),
            response_body_sha256: "d".repeat(64),
            finish_reason: "stop".to_owned(),
            usage: ProviderUsageReceipt {
                input_tokens: 10,
                output_tokens: 2,
                total_tokens: 12,
            },
            provider_request_count: 1,
        },
    }
}
