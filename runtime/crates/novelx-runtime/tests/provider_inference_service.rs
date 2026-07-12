mod support;

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use novelx_protocol::{
    ContextBudgetAllocation, ContextBudgetCategory, ContextCompilationReceipt, ContextDisclosure,
    ContextRepresentation, ProviderRunIdentity, TokenizerIdentity, TokenizerKind,
};
use novelx_runtime::event_journal::{EventJournal, NewRuntimeEvent};
use novelx_runtime::provider_gateway::{
    ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderGateway,
    ProviderInferenceMessage, ProviderInferenceRequest, ProviderInferenceRole,
    ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
};
use novelx_runtime::provider_inference_service::{
    PreparedProviderAttempt, ProviderInferenceExecution, ProviderInferenceService,
    ProviderInferenceServiceError,
};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate};
use novelx_runtime::run_state::RunState;
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const API_KEY: &str = "provider-service-sensitive-key";
const RUN_ID: &str = "run-provider-service-1";
const ATTEMPT_ID: &str = "attempt-provider-service-1";

#[tokio::test]
async fn dispatch_runs_with_the_journal_closed_and_finalize_writes_the_terminal_event_after_reopen()
{
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("分段完成"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();

    let prepared = {
        let mut journal = fixture.open();
        let mut service = ProviderInferenceService::new(&mut journal, &providers, &gateway);
        service
            .prepare_attempt(execution(identity.clone()))
            .unwrap()
    };
    let PreparedProviderAttempt::Dispatch(prepared) = prepared else {
        panic!("new attempt must require dispatch");
    };
    {
        let journal = fixture.open();
        assert_eq!(
            attempt_events(&journal)
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            vec!["provider.requested", "provider.sent"]
        );
    }

    let dispatched = ProviderInferenceService::dispatch_attempt(
        &gateway,
        providers.resolve(&identity).unwrap(),
        *prepared,
    )
    .await;
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    {
        let journal = fixture.open();
        assert_eq!(attempt_events(&journal).len(), 2);
    }

    let outcome = {
        let mut journal = fixture.open();
        ProviderInferenceService::new(&mut journal, &providers, &gateway)
            .finalize_attempt(dispatched)
            .unwrap()
    };

    server.await.unwrap();
    assert_eq!(outcome.text.as_deref(), Some("分段完成"));
    let journal = fixture.open();
    assert_eq!(
        attempt_events(&journal).last().unwrap().event_type,
        "provider.responded"
    );
}

#[tokio::test]
async fn dispatch_carries_a_definitive_provider_failure_until_finalize_persists_it() {
    let fixture = Fixture::new();
    let (base_url, _, _, server) = spawn_server(ServerReply::Immediate(json_response(
        401,
        r#"{"error":"invalid key"}"#,
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();

    let prepared = {
        let mut journal = fixture.open();
        let mut service = ProviderInferenceService::new(&mut journal, &providers, &gateway);
        service
            .prepare_attempt(execution(identity.clone()))
            .unwrap()
    };
    let PreparedProviderAttempt::Dispatch(prepared) = prepared else {
        panic!("new attempt must require dispatch");
    };
    let dispatched = ProviderInferenceService::dispatch_attempt(
        &gateway,
        providers.resolve(&identity).unwrap(),
        *prepared,
    )
    .await;
    {
        let journal = fixture.open();
        assert_eq!(attempt_events(&journal).len(), 2);
    }

    let error = {
        let mut journal = fixture.open();
        ProviderInferenceService::new(&mut journal, &providers, &gateway)
            .finalize_attempt(dispatched)
            .unwrap_err()
    };

    server.await.unwrap();
    assert!(matches!(error, ProviderInferenceServiceError::Gateway(_)));
    let journal = fixture.open();
    assert_eq!(
        attempt_events(&journal).last().unwrap().event_type,
        "provider.failed"
    );
}

#[tokio::test]
async fn persists_requested_sent_responded_and_recovers_the_response_text_after_reopen() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("银湾仍在潮声中。"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity);

    let outcome = {
        let mut journal = fixture.open();
        ProviderInferenceService::new(&mut journal, &providers, &gateway)
            .execute(execution.clone())
            .await
            .unwrap()
    };
    assert_eq!(outcome.text.as_deref(), Some("银湾仍在潮声中。"));
    server.await.unwrap();
    assert_eq!(request_count.load(Ordering::SeqCst), 1);

    let journal = fixture.open();
    let events = attempt_events(&journal);
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["provider.requested", "provider.sent", "provider.responded"]
    );
    drop(journal);

    let no_network_gateway = ProviderGateway::new().unwrap();
    let recovered = {
        let mut reopened = fixture.open();
        ProviderInferenceService::new(&mut reopened, &providers, &no_network_gateway)
            .execute(execution)
            .await
            .unwrap()
    };
    assert_eq!(recovered, outcome);
}

#[tokio::test]
async fn persists_and_recovers_tool_calls_without_a_second_provider_request() {
    let fixture = Fixture::new();
    let body = r#"{"id":"response-tools","model":"deepseek-chat","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_project","arguments":"{\"path\":\"README.md\"}"}}]}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#;
    let (base_url, request_count, _, server) =
        spawn_server(ServerReply::Immediate(json_response(200, body))).await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity);

    let outcome = {
        let mut journal = fixture.open();
        ProviderInferenceService::new(&mut journal, &providers, &gateway)
            .execute(execution.clone())
            .await
            .unwrap()
    };
    assert_eq!(outcome.text, None);
    assert_eq!(outcome.tool_calls.len(), 1);
    assert_eq!(outcome.tool_calls[0].name, "read_project");
    server.await.unwrap();

    let recovered = {
        let mut journal = fixture.open();
        ProviderInferenceService::new(&mut journal, &providers, &gateway)
            .execute(execution)
            .await
            .unwrap()
    };
    assert_eq!(recovered, outcome);
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn identical_execution_returns_the_original_result_without_a_second_network_request() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("第一次结果"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity);
    let mut journal = fixture.open();
    let mut service = ProviderInferenceService::new(&mut journal, &providers, &gateway);

    let first = service.execute(execution.clone()).await.unwrap();
    let second = service.execute(execution).await.unwrap();

    assert_eq!(second, first);
    server.await.unwrap();
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(attempt_events(&journal).len(), 3);
}

#[tokio::test]
async fn timeout_persists_outcome_unknown_and_the_same_execution_is_never_auto_retried() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Delayed {
        delay: Duration::from_millis(1_200),
        response: json_response(200, successful_body("迟到结果")),
    })
    .await;
    let (providers, identity) = bound_registry(base_url, 1_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity);
    let mut journal = fixture.open();
    let first = {
        let mut service = ProviderInferenceService::new(&mut journal, &providers, &gateway);
        service.execute(execution.clone()).await.unwrap_err()
    };
    assert!(matches!(
        first,
        ProviderInferenceServiceError::DeliveryUnknown(_)
    ));
    assert_eq!(
        RunAggregate::recover(&journal, RUN_ID).unwrap().state(),
        RunState::WaitingForReconciliation
    );
    let mut service = ProviderInferenceService::new(&mut journal, &providers, &gateway);
    let second = service.execute(execution).await.unwrap_err();
    assert!(matches!(
        second,
        ProviderInferenceServiceError::OutcomeUnknown
    ));

    server.await.unwrap();
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    let events = attempt_events(&journal);
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec![
            "provider.requested",
            "provider.sent",
            "provider.outcome_unknown"
        ]
    );
}

#[tokio::test]
async fn authentication_rejection_persists_failed_with_response_received_certainty() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        401,
        r#"{"error":"invalid key"}"#,
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let mut journal = fixture.open();

    let error = ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .execute(execution(identity))
        .await
        .unwrap_err();

    assert!(matches!(error, ProviderInferenceServiceError::Gateway(_)));
    server.await.unwrap();
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    let events = attempt_events(&journal);
    assert_eq!(events.last().unwrap().event_type, "provider.failed");
    assert_eq!(
        events.last().unwrap().payload["failure"]["code"],
        "PROVIDER_AUTH_REJECTED"
    );
    assert_eq!(events.last().unwrap().payload["failure"]["httpStatus"], 401);
    assert_eq!(
        events.last().unwrap().payload["failure"]["deliveryCertainty"],
        "response_received"
    );
}

#[tokio::test]
async fn requested_event_uses_the_exact_prepared_transport_payload_hash() {
    let fixture = Fixture::new();
    let (base_url, _, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("完成"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity.clone());
    let expected_hash = gateway
        .prepare_inference(
            providers.resolve(&identity).unwrap(),
            authoritative_request(),
        )
        .unwrap()
        .transport_payload_sha256()
        .to_owned();
    let mut journal = fixture.open();

    ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .execute(execution)
        .await
        .unwrap();

    server.await.unwrap();
    let requested = attempt_events(&journal).remove(0);
    assert_eq!(
        requested.payload["definition"]["transportPayloadSha256"],
        expected_hash
    );
}

#[tokio::test]
async fn journal_never_contains_the_provider_api_key() {
    let fixture = Fixture::new();
    let (base_url, _, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("完成"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let mut journal = fixture.open();

    ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .execute(execution(identity))
        .await
        .unwrap();

    server.await.unwrap();
    let serialized = format!("{:?}", journal.read_run(RUN_ID, 0).unwrap());
    assert!(!serialized.contains(API_KEY));
}

#[tokio::test]
async fn rejects_provider_identity_that_differs_from_the_run_pin_without_network_or_attempt() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应发送"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let mut changed = identity.clone();
    changed.config_sha256 = "f".repeat(64);
    let gateway = ProviderGateway::new().unwrap();
    let mut journal = fixture.open();

    let error = ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .execute(execution(changed))
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        ProviderInferenceServiceError::PinnedProviderMismatch
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert!(attempt_events(&journal).is_empty());
    server.abort();
}

#[tokio::test]
async fn sends_persisted_authoritative_input_instead_of_caller_supplied_messages() {
    let fixture = Fixture::new();
    let (base_url, _, request_body, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("完成"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let mut journal = fixture.open();
    let mut malicious = execution(identity);
    malicious.request.messages[0].content = "恶意替换正文".to_owned();

    ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .execute(malicious)
        .await
        .unwrap();

    server.await.unwrap();
    let body = request_body.lock().unwrap().clone();
    assert!(body.contains("权威正文"));
    assert!(!body.contains("恶意替换正文"));
}

#[tokio::test]
async fn rejects_tampered_persisted_input_hash_without_network_or_attempt() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应发送"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, true);
    let gateway = ProviderGateway::new().unwrap();
    let mut journal = fixture.open();

    let error = ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .execute(execution(identity))
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        ProviderInferenceServiceError::ContextNormalizedInputHashMismatch
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert!(attempt_events(&journal).is_empty());
    server.abort();
}

fn execution(provider: ProviderRunIdentity) -> ProviderInferenceExecution {
    ProviderInferenceExecution {
        run_id: RUN_ID.to_owned(),
        attempt_id: ATTEMPT_ID.to_owned(),
        inference_id: "inference-provider-service-1".to_owned(),
        invocation_id: "run-provider-service-1:steward".to_owned(),
        inference_idempotency_key: "inference-key-provider-service-1".to_owned(),
        attempt_number: 1,
        provider,
        request: ProviderInferenceRequest {
            compilation: compilation_receipt(),
            messages: vec![ProviderInferenceMessage {
                role: ProviderInferenceRole::User,
                content: "继续银湾故事".to_owned(),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            tools: vec![],
        },
    }
}

fn authoritative_request() -> ProviderInferenceRequest {
    ProviderInferenceRequest {
        compilation: compilation_receipt(),
        messages: vec![ProviderInferenceMessage {
            role: ProviderInferenceRole::User,
            content: "权威正文".to_owned(),
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

enum ServerReply {
    Immediate(String),
    Delayed { delay: Duration, response: String },
}

async fn spawn_server(
    reply: ServerReply,
) -> (
    String,
    Arc<AtomicUsize>,
    Arc<Mutex<String>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&count);
    let request_body = Arc::new(Mutex::new(String::new()));
    let observed_body = Arc::clone(&request_body);
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        observed.fetch_add(1, Ordering::SeqCst);
        let mut request = vec![0_u8; 65_536];
        let length = socket.read(&mut request).await.unwrap();
        *observed_body.lock().unwrap() = String::from_utf8_lossy(&request[..length]).into_owned();
        let response = match reply {
            ServerReply::Immediate(response) => response,
            ServerReply::Delayed { delay, response } => {
                tokio::time::sleep(delay).await;
                response
            }
        };
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
    });
    (format!("http://{address}/v1"), count, request_body, server)
}

fn successful_body(text: &str) -> String {
    format!(
        r#"{{"id":"response-1","model":"deepseek-chat","choices":[{{"finish_reason":"stop","message":{{"role":"assistant","content":"{text}"}}}}],"usage":{{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}}}"#
    )
}

fn json_response(status: u16, body: impl AsRef<str>) -> String {
    let body = body.as_ref();
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        _ => "Error",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn attempt_events(journal: &EventJournal) -> Vec<novelx_runtime::event_journal::RuntimeEvent> {
    journal
        .read_aggregate(RUN_ID, "provider_attempt", ATTEMPT_ID, 0)
        .unwrap()
}

struct Fixture {
    _temp: TempDir,
    path: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        Self { _temp: temp, path }
    }

    fn open(&self) -> EventJournal {
        EventJournal::open(&self.path).unwrap()
    }

    fn seed(&self, provider: &ProviderRunIdentity, tamper_hash: bool) {
        let mut journal = self.open();
        let mut identity = pinned_identity();
        identity.provider = provider.clone();
        let mut run = RunAggregate::create(
            &mut journal,
            RUN_ID,
            identity,
            EventMetadata {
                message_id: "run-message-1",
                idempotency_key: "run-key-1",
                created_at: "2026-07-12T00:00:00Z",
                reason: None,
            },
        )
        .unwrap();
        run.prepare(
            &mut journal,
            EventMetadata {
                message_id: "run-message-2",
                idempotency_key: "run-key-2",
                created_at: "2026-07-12T00:00:00Z",
                reason: None,
            },
        )
        .unwrap();
        run.start(
            &mut journal,
            EventMetadata {
                message_id: "run-message-3",
                idempotency_key: "run-key-3",
                created_at: "2026-07-12T00:00:00Z",
                reason: None,
            },
        )
        .unwrap();
        let normalized = serde_json::json!({
            "messages": [{"role": "user", "content": "权威正文"}],
            "tools": [],
        });
        let normalized_hash = if tamper_hash {
            "0".repeat(64)
        } else {
            format!(
                "{:x}",
                Sha256::digest(
                    r#"{"messages":[{"role":"user","content":"权威正文"}],"tools":[]}"#.as_bytes()
                )
            )
        };
        journal
            .append(
                NewRuntimeEvent {
                    run_id: RUN_ID.to_owned(),
                    aggregate_type: "context".to_owned(),
                    aggregate_id: "context-provider-service-1".to_owned(),
                    message_id: "context-message-1".to_owned(),
                    idempotency_key: "context-key-1".to_owned(),
                    event_type: "context.compiled".to_owned(),
                    event_version: 1,
                    payload: serde_json::json!({
                        "requestSha256": "9".repeat(64),
                        "receipt": compilation_receipt(),
                        "normalizedInput": normalized,
                        "normalizedInputSha256": normalized_hash,
                    }),
                    created_at: "2026-07-12T00:00:01Z".to_owned(),
                },
                3,
                0,
            )
            .unwrap();
    }
}
