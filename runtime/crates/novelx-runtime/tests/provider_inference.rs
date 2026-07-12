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
    ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderGateway, ProviderGatewayError,
    ProviderInferenceMessage, ProviderInferenceRequest, ProviderInferenceRole,
    ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const API_KEY: &str = "provider-inference-sensitive-key";

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

    assert_eq!(outcome.text, "银湾仍在潮声中。");
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
            ProviderGatewayError::AuthenticationRejected,
        ),
        (
            ServerReply::Immediate(json_response(429, r#"{"error":"slow down"}"#)),
            ProviderGatewayError::RateLimited,
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
    let config = ProviderConfig {
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
    };
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
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        429 => "Too Many Requests",
        _ => "Error",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
