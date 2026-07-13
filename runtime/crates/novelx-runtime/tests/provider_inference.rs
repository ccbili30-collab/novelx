use std::time::Duration;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

mod support;

use novelx_protocol::{
    ContextBudgetAllocation, ContextBudgetCategory, ContextCompilationReceipt, ContextCompile,
    ContextDisclosure, ContextItem, ContextMessageRole, ContextRepresentation,
    ProviderInferenceCompleted, ProviderRunIdentity, RunPermissionMode, TokenizerIdentity,
    TokenizerKind, ToolPermissionPolicy, ToolSourceScope,
};
use novelx_runtime::provider_gateway::{
    PreparedProviderHttpDispatch, ProviderApiFlavor, ProviderAuthScheme, ProviderConfig,
    ProviderGateway, ProviderGatewayError, ProviderInferenceFunctionCall, ProviderInferenceMessage,
    ProviderInferenceRequest, ProviderInferenceRole, ProviderInferenceToolCall,
    ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
};
use novelx_runtime::provider_retry_after::ProviderRetryAfterKind;
use novelx_runtime::{
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity,
    },
    context_compile_service::ContextCompileService,
    event_journal::EventJournal,
    live_agent_loop_runner::{
        LiveAgentLoopError, LiveAgentLoopOutcome, LiveAgentLoopProgress, LiveAgentLoopRunner,
    },
    project_path::ProjectRoot,
    provider_effect_authorization_service::ProviderEffectAuthorizationError,
    provider_inference_service::{ProviderInferenceExecution, ProviderInferenceServiceError},
    run_aggregate::{EventMetadata, RunAggregate},
    workspace_runtime_lease::{BoundWorkspaceRuntimeLease, WorkspaceRuntimeLease},
};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
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
    let fixture = LiveProviderFixture::new(&registry, identity.clone());
    let receipt = fixture.receipt.clone();
    let outcome = completed(fixture.run(registry).await.result.unwrap());

    assert_eq!(outcome.output.as_ref().unwrap().text, "银湾仍在潮声中。");
    assert_eq!(
        outcome.identity.context_compilation_id,
        receipt.compilation_id
    );
    assert_eq!(fixture.execution.provider.model_id, "deepseek-chat");
    assert_eq!(outcome.model_id, "deepseek-chat");
    assert_eq!(outcome.stop_reason, "stop");
    assert_eq!(outcome.usage.input_tokens, 321);
    assert_eq!(outcome.usage.output_tokens, 45);
    assert_eq!(outcome.usage.total_tokens, 366);
    assert_eq!(outcome.response_id_sha256.len(), 64);

    server.await.unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let captured = requests.join("\n");
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
    let fixture = LiveProviderFixture::new(&registry, identity.clone());
    let provider = registry.resolve(&identity).unwrap();
    let gateway = ProviderGateway::new().unwrap();
    let prepared = gateway
        .prepare_inference(provider, fixture.execution.request.clone())
        .unwrap();
    let expected_payload_sha256 = prepared.transport_payload_sha256().to_owned();

    let outcome = completed(fixture.run(registry).await.result.unwrap());

    assert_eq!(outcome.output.as_ref().unwrap().text, "完成");
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
    let tool_response = json_response(
        200,
        r#"{"id":"response-tools","model":"deepseek-chat","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_project_file","arguments":"{\"path\":\"设定/海岸线.md\",\"offsetChars\":0,\"maxChars\":4000}"}},{"id":"call-2","type":"function","function":{"name":"stat_project_file","arguments":"{\"path\":\"设定/海岸线.md\"}"}}]}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#,
    );
    let completion_response = json_response(
        200,
        r#"{"id":"response-2","model":"deepseek-chat","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"已读取。"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}"#,
    );
    let (base_url, requests, server) = spawn_http_server(vec![
        ServerReply::Immediate(tool_response),
        ServerReply::Immediate(completion_response),
    ])
    .await;
    let (registry, identity) = bound_registry(base_url, 2_000);
    let fixture = LiveProviderFixture::new(&registry, identity);
    let setting = fixture.project.path().join("设定");
    std::fs::create_dir_all(&setting).unwrap();
    std::fs::write(setting.join("海岸线.md"), "银湾海岸").unwrap();
    let outcome = completed(fixture.run(registry).await.result.unwrap());
    assert_eq!(outcome.output.as_ref().unwrap().text, "已读取。");

    server.await.unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let captured = &requests[1];
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
    let tool_content =
        serde_json::from_str::<serde_json::Value>(tool["content"].as_str().unwrap()).unwrap();
    assert_eq!(tool_content["content"], "银湾海岸");
    assert_eq!(tool_content["complete"], true);
    assert_eq!(tool_content["path"], "设定/海岸线.md");
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

        let prepared = ProviderGateway::new()
            .unwrap()
            .prepare_inference(registry.resolve(&identity).unwrap(), request);
        let error = match prepared {
            Ok(_) => panic!("malformed tool exchange reached a prepared Provider request"),
            Err(error) => error,
        };
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

    let prepared = ProviderGateway::new().unwrap().prepare_inference(
        registry.resolve(&identity).unwrap(),
        inference_request(receipt),
    );
    let error = match prepared {
        Ok(_) => panic!("foreign-model Context receipt reached a prepared Provider request"),
        Err(error) => error,
    };

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
        let fixture = LiveProviderFixture::new(&registry, identity);
        let error = gateway_error(fixture.run(registry).await.result.unwrap_err());
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
        let fixture = LiveProviderFixture::new(&registry, identity);
        let error = gateway_error(fixture.run(registry).await.result.unwrap_err());
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
    let fixture = LiveProviderFixture::new(&registry, identity);
    let error = gateway_error(fixture.run(registry).await.result.unwrap_err());
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
        let fixture = LiveProviderFixture::new(&registry, identity);
        let error = gateway_error(fixture.run(registry).await.result.unwrap_err());
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
        let fixture = LiveProviderFixture::new(&registry, identity);
        let error = gateway_error(fixture.run(registry).await.result.unwrap_err());
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

    let fixture = LiveProviderFixture::new(&registry, identity);
    let error = gateway_error(fixture.run(registry).await.result.unwrap_err());

    assert!(matches!(error, ProviderGatewayError::Timeout));
    server.await.unwrap();
}

#[tokio::test]
async fn treats_length_finish_reason_as_incomplete_output() {
    let body = r#"{"id":"response-1","model":"deepseek-chat","choices":[{"finish_reason":"length","message":{"role":"assistant","content":"被截断"}}],"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}"#;
    let (base_url, _, server) =
        spawn_http_server(vec![ServerReply::Immediate(json_response(200, body))]).await;
    let (registry, identity) = bound_registry(base_url, 2_000);

    let fixture = LiveProviderFixture::new(&registry, identity);
    let error = gateway_error(fixture.run(registry).await.result.unwrap_err());

    assert!(matches!(error, ProviderGatewayError::OutputIncomplete));
    server.await.unwrap();
}

#[tokio::test]
async fn parses_pure_and_mixed_structured_tool_calls_through_the_authorized_tool_round() {
    for (content, expected_text) in [
        ("null", None),
        (r#""I will inspect it.""#, Some("I will inspect it.")),
    ] {
        let body = format!(
            r#"{{"id":"response-tools","model":"deepseek-chat","choices":[{{"finish_reason":"tool_calls","message":{{"role":"assistant","content":{content},"tool_calls":[{{"id":"call-1","type":"function","function":{{"name":"read_project_file","arguments":"{{\"path\":\"README.md\",\"offsetChars\":0,\"maxChars\":4000}}"}}}}]}}}}],"usage":{{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}}}"#
        );
        let (base_url, _, server) = spawn_http_server(vec![
            ServerReply::Immediate(json_response(200, &body)),
            ServerReply::Immediate(json_response(200, successful_body())),
        ])
        .await;
        let (registry, identity) = bound_registry(base_url, 2_000);
        let fixture = LiveProviderFixture::new(&registry, identity);
        std::fs::write(fixture.project.path().join("README.md"), "NovelX").unwrap();
        let run = fixture.run(registry).await;
        completed(run.result.unwrap());
        let outcome = first_provider_completion(&run.progress);

        assert_eq!(
            outcome.output.as_ref().map(|output| output.text.as_str()),
            expected_text
        );
        assert_eq!(outcome.tool_calls.len(), 1);
        assert_eq!(outcome.tool_calls[0].id, "call-1");
        assert_eq!(outcome.tool_calls[0].name, "read_project_file");
        assert_eq!(
            outcome.tool_calls[0].arguments,
            serde_json::json!({
                "maxChars": 4000,
                "offsetChars": 0,
                "path": "README.md"
            })
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
        let fixture = LiveProviderFixture::new(&registry, identity);
        let error = gateway_error(fixture.run(registry).await.result.unwrap_err());
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

    let fixture = LiveProviderFixture::new(&registry, identity);
    let outcome = completed(fixture.run(registry).await.result.unwrap());

    assert!(!serde_json::to_string(&outcome).unwrap().contains(API_KEY));
    assert!(!format!("{outcome:?}").contains(API_KEY));
    server.await.unwrap();
}

const WORKSPACE_ID: &str = "workspace-1";
const PROJECT_ID: &str = "project-1";

struct LiveProviderFixture {
    _workspace: TempDir,
    project: TempDir,
    database: PathBuf,
    lease: Arc<BoundWorkspaceRuntimeLease>,
    execution: ProviderInferenceExecution,
    receipt: ContextCompilationReceipt,
}

struct LiveProviderRun {
    result: Result<LiveAgentLoopOutcome, LiveAgentLoopError>,
    progress: Vec<LiveAgentLoopProgress>,
}

impl LiveProviderFixture {
    fn new(providers: &ProviderRegistry, provider: ProviderRunIdentity) -> Self {
        let workspace = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let database = workspace.path().join("runtime.db");
        let mut journal = EventJournal::open(&database).unwrap();
        let lease = Arc::new(
            WorkspaceRuntimeLease::acquire(
                &database,
                format!("provider-black-box-{}", Uuid::new_v4()),
            )
            .unwrap()
            .bind_database(&database)
            .unwrap(),
        );
        let run_id = Uuid::new_v4();
        let run_id_text = run_id.to_string();
        let invocation_id = format!("{run_id}:steward");
        let mut pinned = support::pinned_identity();
        pinned.provider = provider.clone();
        pinned.mode = RunPermissionMode::Free;
        let context_policy = pinned.context_policy.clone();
        let source_scope = ToolSourceScope {
            source_checkpoint_id: pinned.source_checkpoint_id.clone(),
            resource_ids: pinned.scope_resource_ids.clone(),
            scope_sha256: pinned.resource_scope_sha256.clone(),
        };
        let permission = ToolPermissionPolicy {
            mode: pinned.mode,
            policy_id: pinned.tool_policy.id.clone(),
            policy_version: pinned.tool_policy.version.clone(),
            policy_sha256: pinned.tool_policy.sha256.clone(),
        };
        let mut run = RunAggregate::create(
            &mut journal,
            &run_id_text,
            pinned,
            runtime_metadata("provider-black-box-run-create"),
        )
        .unwrap();
        run.prepare(
            &mut journal,
            runtime_metadata("provider-black-box-run-prepare"),
        )
        .unwrap();
        run.start(
            &mut journal,
            runtime_metadata("provider-black-box-run-start"),
        )
        .unwrap();
        let receipt = ContextCompileService::new(&mut journal, providers)
            .compile(
                run_id,
                Uuid::new_v4(),
                live_context_command(&invocation_id, provider.clone(), context_policy),
            )
            .unwrap();
        let dispatch = InferenceDispatchIdentity {
            inference_id: Uuid::new_v4(),
            attempt_id: Uuid::new_v4(),
            request_number: 1,
            context_compilation_id: receipt.compilation_id,
            attempt_number: 1,
            inference_idempotency_key: format!("{run_id}:inference:1"),
        };
        let loop_service = AgentLoopService::new(
            AgentLoopIdentity {
                run_id,
                project_id: PROJECT_ID.to_owned(),
                invocation_id: invocation_id.clone(),
                initial_context_compilation_id: receipt.compilation_id,
                source_scope,
                permission,
            },
            live_loop_policy(),
            dispatch.clone(),
        )
        .unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &loop_service,
                "provider-black-box-loop-create",
                AgentLoopEventMetadata {
                    message_id: "provider-black-box-loop-create",
                    created_at: "2026-07-13T00:00:03Z",
                },
            )
            .unwrap();
        let execution = ProviderInferenceExecution {
            run_id: run_id_text,
            attempt_id: dispatch.attempt_id.to_string(),
            inference_id: dispatch.inference_id.to_string(),
            invocation_id,
            inference_idempotency_key: dispatch.inference_idempotency_key,
            attempt_number: dispatch.attempt_number,
            provider,
            request: inference_request(receipt.clone()),
        };
        Self {
            _workspace: workspace,
            project,
            database,
            lease,
            execution,
            receipt,
        }
    }

    async fn run(&self, providers: ProviderRegistry) -> LiveProviderRun {
        let runner = LiveAgentLoopRunner::open(
            &self.database,
            WORKSPACE_ID.to_owned(),
            Arc::clone(&self.lease),
            ProjectRoot::open(self.project.path().to_str().unwrap()).unwrap(),
            PROJECT_ID.to_owned(),
            providers,
            ProviderGateway::new().unwrap(),
            live_loop_policy(),
        )
        .unwrap();
        let progress = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&progress);
        let (_cancel_tx, mut cancellation) = tokio::sync::watch::channel(false);
        let result = runner
            .run(
                self.execution.clone(),
                None,
                move |event| {
                    let captured = Arc::clone(&captured);
                    async move {
                        captured.lock().unwrap().push(event);
                        Ok(())
                    }
                },
                &mut cancellation,
            )
            .await;
        let progress = progress.lock().unwrap().clone();
        LiveProviderRun { result, progress }
    }
}

const fn live_loop_policy() -> AgentLoopPolicy {
    AgentLoopPolicy {
        maximum_tool_rounds: 4,
        tool_schema_version: 1,
    }
}

fn live_context_command(
    invocation_id: &str,
    provider: ProviderRunIdentity,
    context_policy: novelx_protocol::VersionedPolicyIdentity,
) -> ContextCompile {
    let content = "继续银湾故事";
    ContextCompile {
        compile_idempotency_key: "provider-black-box-context".to_owned(),
        invocation_id: invocation_id.to_owned(),
        request_number: 1,
        provider,
        context_policy,
        compiler_version: "1.0.0".to_owned(),
        context_window: 64_000,
        configured_max_output_tokens: Some(8_000),
        safety_reserve_tokens: 6_400,
        items: vec![
            ContextItem::SessionMessage {
                item_id: "current-user-turn".to_owned(),
                message_id: "provider-black-box-user".to_owned(),
                role: ContextMessageRole::User,
                content: content.to_owned(),
                content_sha256: sha(content.as_bytes()),
                created_at: "2026-07-13T00:00:00Z".to_owned(),
                disclosure: ContextDisclosure::ProjectPrivate,
                required: true,
            },
            ContextItem::OutputReserve {
                item_id: "output-reserve".to_owned(),
                requested_tokens: 8_000,
                policy_id: "auto".to_owned(),
                disclosure: ContextDisclosure::AgentInternal,
            },
        ],
    }
}

fn runtime_metadata(message_id: &'static str) -> EventMetadata<'static> {
    EventMetadata {
        message_id,
        idempotency_key: message_id,
        created_at: "2026-07-13T00:00:00Z",
        reason: None,
    }
}

fn completed(outcome: LiveAgentLoopOutcome) -> ProviderInferenceCompleted {
    match outcome {
        LiveAgentLoopOutcome::Completed { completion, .. } => completion,
        other => panic!("expected completed live Provider loop, got {other:?}"),
    }
}

fn gateway_error(error: LiveAgentLoopError) -> ProviderGatewayError {
    match error {
        LiveAgentLoopError::Provider(ProviderInferenceServiceError::Gateway(error)) => error,
        LiveAgentLoopError::Provider(ProviderInferenceServiceError::DeliveryUnknown(error)) => {
            *error
        }
        LiveAgentLoopError::ProviderAuthorization(ProviderEffectAuthorizationError::Provider(
            error,
        )) => error,
        other => panic!("expected a typed Provider Gateway error, got {other:?}"),
    }
}

fn first_provider_completion(progress: &[LiveAgentLoopProgress]) -> &ProviderInferenceCompleted {
    progress
        .iter()
        .find_map(|event| match event {
            LiveAgentLoopProgress::ProviderCompleted(completion) => Some(completion),
            _ => None,
        })
        .expect("live Provider loop did not emit a Provider completion")
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
