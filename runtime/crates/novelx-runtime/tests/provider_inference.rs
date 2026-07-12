use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use novelx_protocol::{
    ContextBudgetAllocation, ContextBudgetCategory, ContextCompilationReceipt, ContextDisclosure,
    ContextRepresentation, ProviderRunIdentity, TokenizerIdentity, TokenizerKind,
};
use novelx_runtime::provider_gateway::{
    PreparedProviderHttpDispatch, ProviderApiFlavor, ProviderAuthScheme, ProviderConfig,
    ProviderGateway, ProviderGatewayError, ProviderInferenceFunctionCall, ProviderInferenceMessage,
    ProviderInferenceRequest, ProviderInferenceRole, ProviderInferenceToolCall,
    ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
};
use novelx_runtime::provider_retry_after::ProviderRetryAfterKind;
use sha2::Digest;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const API_KEY: &str = "provider-inference-sensitive-key";

macro_rules! assert_not_impl {
    ($type:ty, $trait:path) => {
        const _: fn() = || {
            trait AmbiguousIfImpl<A> {
                fn marker() {}
            }
            impl<T: ?Sized> AmbiguousIfImpl<()> for T {}
            struct Invalid;
            impl<T: ?Sized + $trait> AmbiguousIfImpl<Invalid> for T {}
            let _ = <$type as AmbiguousIfImpl<_>>::marker;
        };
    };
}

assert_not_impl!(PreparedProviderHttpDispatch, Clone);
assert_not_impl!(PreparedProviderHttpDispatch, std::fmt::Debug);
assert_not_impl!(PreparedProviderHttpDispatch, serde::Serialize);

#[tokio::test]
async fn posts_a_real_loopback_request_bound_to_the_compiled_context_receipt() {
    let response = json_response(
        200,
        r#"{"id":"response-1","model":"deepseek-chat","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"银湾仍在潮声中。"}}],"usage":{"prompt_tokens":321,"completion_tokens":45,"total_tokens":366}}"#,
    );
    let (base_url, requests, server) =
        spawn_http_server(vec![ServerReply::Immediate(response)]).await;
    let (registry, identity) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();

    let outcome = gateway
        .infer(
            registry.resolve(&identity).unwrap(),
            inference_request(compilation_receipt()),
        )
        .await
        .unwrap();

    assert_eq!(outcome.text.as_deref(), Some("银湾仍在潮声中。"));
    assert_eq!(
        outcome.receipt.context_compilation_id,
        compilation_receipt().compilation_id
    );
    assert_eq!(outcome.receipt.canonical_context_sha256, "1".repeat(64));
    assert_eq!(outcome.receipt.requested_model_id, "deepseek-chat");
    assert_eq!(outcome.receipt.actual_model_id, "deepseek-chat");
    assert_eq!(outcome.receipt.finish_reason, "stop");
    assert_eq!(outcome.receipt.usage.input_tokens, 321);
    assert_eq!(outcome.receipt.usage.output_tokens, 45);
    assert_eq!(outcome.receipt.usage.total_tokens, 366);
    assert_eq!(outcome.receipt.provider_request_count, 1);
    assert_eq!(outcome.receipt.response_id_sha256.len(), 64);

    server.await.unwrap();
    let captured = requests.lock().unwrap().join("\n");
    assert!(captured.starts_with("POST /v1/chat/completions HTTP/1.1"));
    assert!(captured.contains("authorization: Bearer provider-inference-sensitive-key"));
    assert!(captured.contains("\"model\":\"deepseek-chat\""));
    assert!(captured.contains("\"content\":\"继续银湾故事\""));
}

#[tokio::test]
async fn prepares_complete_http_dispatch_without_network_or_secret_projection() {
    let (base_url, request_count, server) = spawn_counting_server().await;
    let (registry, identity) = bound_registry(base_url.clone(), 2_000);
    let provider = registry.resolve(&identity).unwrap();
    let gateway = ProviderGateway::new().unwrap();
    let prepared = gateway
        .prepare_inference(provider, inference_request(compilation_receipt()))
        .unwrap();
    let expected_payload_sha256 = prepared.transport_payload_sha256().to_owned();
    let expected_payload_bytes = prepared.transport_payload_bytes();
    let before = tokio::time::Instant::now();

    let dispatch = gateway.prepare_http_dispatch(provider, prepared).unwrap();
    let after = tokio::time::Instant::now();

    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(dispatch.method(), reqwest::Method::POST);
    assert_eq!(
        dispatch.endpoint().as_str(),
        format!("{base_url}/chat/completions")
    );
    assert_eq!(
        dispatch.request_timeout(),
        Some(Duration::from_millis(2_000))
    );
    assert_eq!(dispatch.transport_payload_sha256(), expected_payload_sha256);
    assert_eq!(dispatch.transport_payload_bytes(), expected_payload_bytes);
    assert_eq!(dispatch.compilation(), &compilation_receipt());
    assert_eq!(dispatch.provider(), &identity);
    assert!(
        dispatch.total_deadline_at() >= before + Duration::from_millis(3_000)
            && dispatch.total_deadline_at() <= after + Duration::from_millis(3_000)
    );
    server.abort();
}

#[tokio::test]
async fn prebuilt_send_kernel_executes_exactly_one_request_and_parses_response() {
    let (base_url, requests, server) = spawn_http_server(vec![ServerReply::Immediate(
        json_response(200, successful_body()),
    )])
    .await;
    let (registry, identity) = bound_registry(base_url, 2_000);
    let provider = registry.resolve(&identity).unwrap();
    let gateway = ProviderGateway::new().unwrap();
    let prepared = gateway
        .prepare_inference(provider, inference_request(compilation_receipt()))
        .unwrap();
    let expected_payload_sha256 = prepared.transport_payload_sha256().to_owned();

    let outcome = gateway.infer_prepared(provider, prepared).await.unwrap();

    assert_eq!(outcome.text.as_deref(), Some("完成"));
    server.await.unwrap();
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 1);
    let request = &captured[0];
    assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
    assert!(request.contains("content-type: application/json"));
    assert!(request.contains(&format!("authorization: Bearer {API_KEY}")));
    let body = request.split_once("\r\n\r\n").unwrap().1.as_bytes();
    assert_eq!(
        format!("{:x}", sha2::Sha256::digest(body)),
        expected_payload_sha256
    );
}

#[test]
fn invalid_base_url_and_sensitive_header_fail_before_http_dispatch_exists() {
    let mut invalid_url = provider_config("not a provider URL".to_owned(), 2_000);
    let invalid_hash = provider_config_sha256(&invalid_url).unwrap();
    let mut registry = ProviderRegistry::default();
    assert!(matches!(
        registry.bind(invalid_url.clone(), &invalid_hash, API_KEY.to_owned()),
        Err(ProviderGatewayError::BaseUrlInvalid)
    ));

    invalid_url.base_url = "http://127.0.0.1:9/v1".to_owned();
    let valid_hash = provider_config_sha256(&invalid_url).unwrap();
    registry
        .bind(invalid_url, &valid_hash, "invalid\ncredential".to_owned())
        .unwrap();
    let identity = ProviderRunIdentity {
        profile_id: "profile-1".to_owned(),
        provider_id: "deepseek".to_owned(),
        model_id: "deepseek-chat".to_owned(),
        config_sha256: valid_hash,
    };
    let provider = registry.resolve(&identity).unwrap();
    let gateway = ProviderGateway::new().unwrap();
    let prepared = gateway
        .prepare_inference(provider, inference_request(compilation_receipt()))
        .unwrap();
    assert!(matches!(
        gateway.prepare_http_dispatch(provider, prepared),
        Err(ProviderGatewayError::RequestBuild(_))
    ));
}

#[tokio::test]
async fn sends_strict_openai_compatible_tool_continuation_messages() {
    let response = json_response(
        200,
        r#"{"id":"response-2","model":"deepseek-chat","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"已读取。"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}"#,
    );
    let (base_url, requests, server) =
        spawn_http_server(vec![ServerReply::Immediate(response)]).await;
    let (registry, identity) = bound_registry(base_url, 2_000);
    let mut request = inference_request(compilation_receipt());
    request.messages.extend([
        ProviderInferenceMessage {
            role: ProviderInferenceRole::Assistant,
            content: String::new(),
            tool_calls: vec![
                ProviderInferenceToolCall {
                    id: "call-1".to_owned(),
                    call_type: "function".to_owned(),
                    function: ProviderInferenceFunctionCall {
                        name: "read_project_file".to_owned(),
                        arguments: serde_json::to_string(&serde_json::json!({
                            "path": "设定/海岸线.md",
                            "offsetChars": 0,
                            "maxChars": 4000
                        }))
                        .unwrap(),
                    },
                },
                ProviderInferenceToolCall {
                    id: "call-2".to_owned(),
                    call_type: "function".to_owned(),
                    function: ProviderInferenceFunctionCall {
                        name: "stat_project_file".to_owned(),
                        arguments: serde_json::to_string(&serde_json::json!({
                            "path": "设定/海岸线.md"
                        }))
                        .unwrap(),
                    },
                },
            ],
            tool_call_id: None,
        },
        ProviderInferenceMessage {
            role: ProviderInferenceRole::Tool,
            content: serde_json::to_string(&serde_json::json!({
                "content": "银湾海岸",
                "complete": true
            }))
            .unwrap(),
            tool_calls: vec![],
            tool_call_id: Some("call-1".to_owned()),
        },
        ProviderInferenceMessage {
            role: ProviderInferenceRole::Tool,
            content: serde_json::to_string(&serde_json::json!({
                "kind": "file",
                "size": 18
            }))
            .unwrap(),
            tool_calls: vec![],
            tool_call_id: Some("call-2".to_owned()),
        },
    ]);

    let outcome = ProviderGateway::new()
        .unwrap()
        .infer(registry.resolve(&identity).unwrap(), request)
        .await
        .unwrap();
    assert_eq!(outcome.text.as_deref(), Some("已读取。"));

    server.await.unwrap();
    let captured = requests.lock().unwrap().join("\n");
    let body: serde_json::Value = serde_json::from_str(
        captured
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap(),
    )
    .unwrap();
    let assistant = &body["messages"][1];
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["content"], "");
    assert_eq!(assistant["tool_calls"][0]["id"], "call-1");
    assert_eq!(assistant["tool_calls"][0]["type"], "function");
    assert_eq!(
        assistant["tool_calls"][0]["function"]["name"],
        "read_project_file"
    );
    assert_eq!(assistant["tool_calls"][1]["id"], "call-2");
    assert_eq!(
        assistant["tool_calls"][1]["function"]["name"],
        "stat_project_file"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            assistant["tool_calls"][0]["function"]["arguments"]
                .as_str()
                .unwrap()
        )
        .unwrap(),
        serde_json::json!({ "path": "设定/海岸线.md", "offsetChars": 0, "maxChars": 4000 })
    );
    let tool = &body["messages"][2];
    assert_eq!(tool["role"], "tool");
    assert_eq!(tool["tool_call_id"], "call-1");
    assert!(tool.get("name").is_none());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(tool["content"].as_str().unwrap()).unwrap(),
        serde_json::json!({ "content": "银湾海岸", "complete": true })
    );
    let second_tool = &body["messages"][3];
    assert_eq!(second_tool["role"], "tool");
    assert_eq!(second_tool["tool_call_id"], "call-2");
    assert!(!captured.contains("\"toolCalls\""));
    assert!(!captured.contains("\"toolCallId\""));
}

#[test]
fn deserializes_legacy_persisted_messages_without_new_tool_fields() {
    let legacy: ProviderInferenceMessage = serde_json::from_value(serde_json::json!({
        "role": "tool",
        "content": "legacy persisted exchange"
    }))
    .unwrap();
    assert_eq!(legacy.role, ProviderInferenceRole::Tool);
    assert!(legacy.tool_calls.is_empty());
    assert_eq!(legacy.tool_call_id, None);
}

#[tokio::test]
async fn rejects_orphaned_or_unfinished_tool_messages_before_provider_io() {
    for malformed in [
        ProviderInferenceMessage {
            role: ProviderInferenceRole::Tool,
            content: "{}".to_owned(),
            tool_calls: vec![],
            tool_call_id: Some("orphan".to_owned()),
        },
        ProviderInferenceMessage {
            role: ProviderInferenceRole::Assistant,
            content: String::new(),
            tool_calls: vec![ProviderInferenceToolCall {
                id: "unfinished".to_owned(),
                call_type: "function".to_owned(),
                function: ProviderInferenceFunctionCall {
                    name: "read_project_file".to_owned(),
                    arguments: "{}".to_owned(),
                },
            }],
            tool_call_id: None,
        },
    ] {
        let (base_url, request_count, server) = spawn_counting_server().await;
        let (registry, identity) = bound_registry(base_url, 2_000);
        let mut request = inference_request(compilation_receipt());
        request.messages.push(malformed);

        let error = ProviderGateway::new()
            .unwrap()
            .infer(registry.resolve(&identity).unwrap(), request)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderGatewayError::ContextReceiptMismatch
        ));
        assert_eq!(request_count.load(Ordering::SeqCst), 0);
        server.abort();
    }
}

#[tokio::test]
async fn rejects_a_compilation_receipt_for_another_model_before_network_io() {
    let (base_url, request_count, server) = spawn_counting_server().await;
    let (registry, identity) = bound_registry(base_url, 2_000);
    let mut receipt = compilation_receipt();
    receipt.tokenizer.model_id = Some("another-model".to_owned());

    let error = ProviderGateway::new()
        .unwrap()
        .infer(
            registry.resolve(&identity).unwrap(),
            inference_request(receipt),
        )
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        ProviderGatewayError::ContextReceiptMismatch
    ));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn validates_actual_model_and_finish_reason() {
    for (body, expected) in [
        (
            r#"{"id":"response-1","model":"other-model","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"text"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"#,
            ProviderGatewayError::ResponseModelMismatch,
        ),
        (
            r#"{"id":"response-1","model":"deepseek-chat","choices":[{"message":{"role":"assistant","content":"text"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"#,
            ProviderGatewayError::ResponseMalformed,
        ),
    ] {
        let (base_url, _, server) =
            spawn_http_server(vec![ServerReply::Immediate(json_response(200, body))]).await;
        let (registry, identity) = bound_registry(base_url, 2_000);
        let error = ProviderGateway::new()
            .unwrap()
            .infer(
                registry.resolve(&identity).unwrap(),
                inference_request(compilation_receipt()),
            )
            .await
            .unwrap_err();
        assert_eq!(
            std::mem::discriminant(&error),
            std::mem::discriminant(&expected)
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn classifies_auth_rate_limit_and_invalid_json_without_retrying_them_as_success() {
    for (reply, expected) in [
        (
            ServerReply::Immediate(json_response(401, r#"{"error":"bad key"}"#)),
            ProviderGatewayError::AuthenticationRejected(401),
        ),
        (
            ServerReply::Immediate(json_response(429, r#"{"error":"slow down"}"#)),
            ProviderGatewayError::RateLimited(
                novelx_runtime::provider_gateway::ProviderHttpFailureReceipt {
                    status: 429,
                    retry_after: None,
                },
            ),
        ),
        (
            ServerReply::Immediate(json_response(200, "{not-json")),
            ProviderGatewayError::ResponseMalformed,
        ),
    ] {
        let (base_url, _, server) = spawn_http_server(vec![reply]).await;
        let (registry, identity) = bound_registry(base_url, 2_000);
        let error = ProviderGateway::new()
            .unwrap()
            .infer(
                registry.resolve(&identity).unwrap(),
                inference_request(compilation_receipt()),
            )
            .await
            .unwrap_err();
        assert_eq!(
            std::mem::discriminant(&error),
            std::mem::discriminant(&expected)
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn captures_one_valid_retry_after_header_without_retaining_its_raw_value() {
    let response =
        json_response_with_headers(429, r#"{"error":"slow down"}"#, &["Retry-After: 120"]);
    let (base_url, _, server) = spawn_http_server(vec![ServerReply::Immediate(response)]).await;
    let (registry, identity) = bound_registry(base_url, 2_000);
    let error = ProviderGateway::new()
        .unwrap()
        .infer(
            registry.resolve(&identity).unwrap(),
            inference_request(compilation_receipt()),
        )
        .await
        .unwrap_err();
    let ProviderGatewayError::RateLimited(receipt) = error else {
        panic!("expected a typed rate-limit receipt");
    };
    assert_eq!(receipt.status, 429);
    let retry_after = receipt.retry_after.unwrap();
    assert_eq!(retry_after.kind, ProviderRetryAfterKind::DeltaSeconds);
    assert_eq!(retry_after.delay_ms, 120_000);
    assert_eq!(retry_after.value_sha256.len(), 64);
    server.await.unwrap();
}

#[tokio::test]
async fn duplicate_or_invalid_retry_after_headers_never_authorize_a_retry_delay() {
    for headers in [
        vec!["Retry-After: tomorrow"],
        vec!["Retry-After: 1", "Retry-After: 2"],
    ] {
        let response = json_response_with_headers(429, r#"{"error":"slow down"}"#, &headers);
        let (base_url, _, server) = spawn_http_server(vec![ServerReply::Immediate(response)]).await;
        let (registry, identity) = bound_registry(base_url, 2_000);
        let error = ProviderGateway::new()
            .unwrap()
            .infer(
                registry.resolve(&identity).unwrap(),
                inference_request(compilation_receipt()),
            )
            .await
            .unwrap_err();
        let ProviderGatewayError::RateLimited(receipt) = error else {
            panic!("expected a typed rate-limit receipt");
        };
        assert!(receipt.retry_after.is_none());
        server.await.unwrap();
    }
}

#[tokio::test]
async fn preserves_the_actual_auth_and_redirect_http_status_for_audit() {
    for (status, expected) in [(403, "auth"), (307, "redirect")] {
        let (base_url, _, server) = spawn_http_server(vec![ServerReply::Immediate(json_response(
            status,
            r#"{"error":"rejected"}"#,
        ))])
        .await;
        let (registry, identity) = bound_registry(base_url, 2_000);
        let error = ProviderGateway::new()
            .unwrap()
            .infer(
                registry.resolve(&identity).unwrap(),
                inference_request(compilation_receipt()),
            )
            .await
            .unwrap_err();
        match (expected, error) {
            ("auth", ProviderGatewayError::AuthenticationRejected(actual)) => {
                assert_eq!(actual, status);
            }
            ("redirect", ProviderGatewayError::RedirectRejected(actual)) => {
                assert_eq!(actual, status);
            }
            (_, other) => panic!("unexpected Provider error: {other}"),
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn classifies_request_timeout() {
    let (base_url, _, server) = spawn_http_server(vec![ServerReply::Delayed {
        delay: Duration::from_millis(1_200),
        response: json_response(200, successful_body()),
    }])
    .await;
    let (registry, identity) = bound_registry(base_url, 1_000);

    let error = ProviderGateway::new()
        .unwrap()
        .infer(
            registry.resolve(&identity).unwrap(),
            inference_request(compilation_receipt()),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, ProviderGatewayError::Timeout));
    server.await.unwrap();
}

#[tokio::test]
async fn treats_length_finish_reason_as_incomplete_output() {
    let body = r#"{"id":"response-1","model":"deepseek-chat","choices":[{"finish_reason":"length","message":{"role":"assistant","content":"被截断"}}],"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}"#;
    let (base_url, _, server) =
        spawn_http_server(vec![ServerReply::Immediate(json_response(200, body))]).await;
    let (registry, identity) = bound_registry(base_url, 2_000);

    let error = ProviderGateway::new()
        .unwrap()
        .infer(
            registry.resolve(&identity).unwrap(),
            inference_request(compilation_receipt()),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, ProviderGatewayError::OutputIncomplete));
    server.await.unwrap();
}

#[tokio::test]
async fn parses_pure_and_mixed_structured_tool_calls_without_executing_them() {
    for (content, expected_text) in [
        ("null", None),
        (r#""I will inspect it.""#, Some("I will inspect it.")),
    ] {
        let body = format!(
            r#"{{"id":"response-tools","model":"deepseek-chat","choices":[{{"finish_reason":"tool_calls","message":{{"role":"assistant","content":{content},"tool_calls":[{{"id":"call-1","type":"function","function":{{"name":"read_project","arguments":"{{\"path\":\"README.md\",\"depth\":2}}"}}}}]}}}}],"usage":{{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}}}"#
        );
        let (base_url, _, server) =
            spawn_http_server(vec![ServerReply::Immediate(json_response(200, &body))]).await;
        let (registry, identity) = bound_registry(base_url, 2_000);
        let outcome = ProviderGateway::new()
            .unwrap()
            .infer(
                registry.resolve(&identity).unwrap(),
                inference_request(compilation_receipt()),
            )
            .await
            .unwrap();

        assert_eq!(outcome.text.as_deref(), expected_text);
        assert_eq!(outcome.tool_calls.len(), 1);
        assert_eq!(outcome.tool_calls[0].id, "call-1");
        assert_eq!(outcome.tool_calls[0].name, "read_project");
        assert_eq!(
            outcome.tool_calls[0].arguments,
            serde_json::json!({"depth": 2, "path": "README.md"})
        );
        assert_eq!(outcome.tool_calls[0].arguments_sha256.len(), 64);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn rejects_malformed_or_inconsistent_tool_call_responses() {
    let cases = [
        r#"{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[]}}"#,
        r#"{"finish_reason":"stop","message":{"role":"assistant","content":"done","tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_project","arguments":"{}"}}]}}"#,
        r#"{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_project","arguments":"{}"}},{"id":"call-1","type":"function","function":{"name":"search_project","arguments":"{}"}}]}}"#,
        r#"{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"","arguments":"{}"}}]}}"#,
        r#"{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_project","arguments":"not-json"}}]}}"#,
        r#"{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_project","arguments":"[]"}}]}}"#,
    ];
    for choice in cases {
        let body = format!(
            r#"{{"id":"response-tools","model":"deepseek-chat","choices":[{choice}],"usage":{{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}}}"#
        );
        let (base_url, _, server) =
            spawn_http_server(vec![ServerReply::Immediate(json_response(200, &body))]).await;
        let (registry, identity) = bound_registry(base_url, 2_000);
        let error = ProviderGateway::new()
            .unwrap()
            .infer(
                registry.resolve(&identity).unwrap(),
                inference_request(compilation_receipt()),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderGatewayError::ResponseMalformed));
        server.await.unwrap();
    }
}

#[tokio::test]
async fn never_exposes_the_api_key_in_receipts_or_debug_output() {
    let (base_url, _, server) = spawn_http_server(vec![ServerReply::Immediate(json_response(
        200,
        successful_body(),
    ))])
    .await;
    let (registry, identity) = bound_registry(base_url, 2_000);

    let outcome = ProviderGateway::new()
        .unwrap()
        .infer(
            registry.resolve(&identity).unwrap(),
            inference_request(compilation_receipt()),
        )
        .await
        .unwrap();

    assert!(
        !serde_json::to_string(&outcome.receipt)
            .unwrap()
            .contains(API_KEY)
    );
    assert!(!format!("{outcome:?}").contains(API_KEY));
    server.await.unwrap();
}

fn inference_request(compilation: ContextCompilationReceipt) -> ProviderInferenceRequest {
    ProviderInferenceRequest {
        compilation,
        messages: vec![ProviderInferenceMessage {
            role: ProviderInferenceRole::User,
            content: "继续银湾故事".to_owned(),
            tool_calls: vec![],
            tool_call_id: None,
        }],
        tools: vec![],
    }
}

fn compilation_receipt() -> ContextCompilationReceipt {
    ContextCompilationReceipt {
        compilation_id: Uuid::parse_str("4fd4ac92-f863-49ca-8844-69d36d716cdf").unwrap(),
        request_number: 1,
        compiler_version: "1.0.0".to_owned(),
        tokenizer: TokenizerIdentity {
            kind: TokenizerKind::FallbackEstimate,
            id: "unicode-mixed".to_owned(),
            version: "1.0.0".to_owned(),
            provider_id: Some("deepseek".to_owned()),
            model_id: Some("deepseek-chat".to_owned()),
        },
        representation: ContextRepresentation::NormalizedMessages,
        canonical_context_sha256: "1".repeat(64),
        serialized_input_bytes: 1_024,
        estimated_input_tokens: 256,
        exact_input_tokens: None,
        context_window: 64_000,
        safety_reserve_tokens: 6_400,
        output_reserve_tokens: 8_000,
        available_input_tokens: 49_600,
        accepted: true,
        incomplete: false,
        budget: vec![ContextBudgetAllocation {
            category: ContextBudgetCategory::SessionHistory,
            estimated_tokens: 256,
        }],
        included_item_ids: vec!["current-user-turn".to_owned()],
        omitted_item_ids: vec![],
        disclosure: ContextDisclosure::AgentInternal,
    }
}

fn bound_registry(
    base_url: String,
    request_timeout_ms: u64,
) -> (ProviderRegistry, ProviderRunIdentity) {
    let config = provider_config(base_url, request_timeout_ms);
    let hash = provider_config_sha256(&config).unwrap();
    let identity = ProviderRunIdentity {
        profile_id: config.profile_id.clone(),
        provider_id: config.provider_id.clone(),
        model_id: config.model_id.clone(),
        config_sha256: hash.clone(),
    };
    let mut registry = ProviderRegistry::default();
    registry.bind(config, &hash, API_KEY.to_owned()).unwrap();
    (registry, identity)
}

fn provider_config(base_url: String, request_timeout_ms: u64) -> ProviderConfig {
    ProviderConfig {
        schema_version: 1,
        profile_id: "profile-1".to_owned(),
        provider_id: "deepseek".to_owned(),
        display_name: "DeepSeek".to_owned(),
        base_url,
        model_id: "deepseek-chat".to_owned(),
        api_flavor: ProviderApiFlavor::OpenAiChatCompletions,
        auth_scheme: ProviderAuthScheme::Bearer,
        context_window: 64_000,
        max_tokens: Some(8_000),
        reasoning: false,
        input: vec![ProviderInputCapability::Text],
        request_timeout_ms,
        total_deadline_ms: request_timeout_ms + 1_000,
        retry_policy: ProviderRetryPolicy {
            max_attempts: 1,
            max_total_delay_ms: 0,
        },
    }
}

#[derive(Clone)]
enum ServerReply {
    Immediate(String),
    Delayed { delay: Duration, response: String },
}

async fn spawn_http_server(
    replies: Vec<ServerReply>,
) -> (
    String,
    Arc<std::sync::Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = Arc::clone(&requests);
    let server = tokio::spawn(async move {
        for reply in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 65_536];
            let read = socket.read(&mut request).await.unwrap();
            captured
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&request[..read]).to_string());
            let response = match reply {
                ServerReply::Immediate(response) => response,
                ServerReply::Delayed { delay, response } => {
                    tokio::time::sleep(delay).await;
                    response
                }
            };
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });
    (format!("http://{address}/v1"), requests, server)
}

async fn spawn_counting_server() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&count);
    let server = tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            observed.fetch_add(1, Ordering::SeqCst);
            let _ = socket.shutdown().await;
        }
    });
    (format!("http://{address}/v1"), count, server)
}

fn successful_body() -> &'static str {
    r#"{"id":"response-1","model":"deepseek-chat","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"完成"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}"#
}

fn json_response(status: u16, body: &str) -> String {
    json_response_with_headers(status, body, &[])
}

fn json_response_with_headers(status: u16, body: &str, headers: &[&str]) -> String {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        429 => "Too Many Requests",
        _ => "Error",
    };
    let extra_headers = if headers.is_empty() {
        String::new()
    } else {
        format!("{}\r\n", headers.join("\r\n"))
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
