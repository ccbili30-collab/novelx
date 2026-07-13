#[allow(unused_macros)]
macro_rules! provider_inference_service_authorized_tests {
    () => {
mod suite {
mod support {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/support/mod.rs"));
}

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use novelx_protocol::{
    ContextBudgetAllocation, ContextBudgetCategory, ContextCompilationReceipt, ContextCompile,
    ContextDisclosure, ContextItem, ContextMessageRole, ContextRepresentation, ProviderRunIdentity,
    TokenizerIdentity, TokenizerKind, ToolPermissionPolicy, ToolSourceScope,
};
use novelx_runtime::agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository};
use novelx_runtime::agent_loop_service::{
    AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity,
};
use novelx_runtime::event_journal::{EventJournal, NewRuntimeEvent};
use novelx_runtime::provider_attempt::{
    ProviderAttemptAggregate, ProviderAttemptCancelledBeforeSent, ProviderAttemptFailure,
    ProviderAttemptMetadata, ProviderAttemptRecovery, ProviderDeliveryCertainty,
    ProviderResponseReceipt,
};
use novelx_runtime::provider_gateway::{
    ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderGateway,
    ProviderInferenceMessage, ProviderInferenceRequest, ProviderInferenceRole,
    ProviderInferenceOutcome, ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy,
    provider_config_sha256,
};
use novelx_runtime::provider_effect_authorization_service::{
    ProviderEffectAuthorizationService, ProviderLiveEffectAuthorization,
    ProviderLiveEffectAuthorizationRequest,
};
use novelx_runtime::provider_inference_service::{
    AuthorizedDispatchedProviderAttempt, AuthorizedProviderAttemptDispatch, EnsuredProviderAttempt,
    ProviderInferenceExecution, ProviderInferenceService, ProviderInferenceServiceError,
};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate};
use novelx_runtime::run_state::RunState;
use novelx_runtime::workspace_runtime_lease::{BoundWorkspaceRuntimeLease, WorkspaceRuntimeLease};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;
use uuid::Uuid;

const API_KEY: &str = "provider-service-sensitive-key";
const RUN_ID: &str = "8a393524-b419-4da4-94c6-c46299ff5557";
const ATTEMPT_ID: &str = "83dba3e8-49ee-4fd7-b03b-777d241d5933";
const INFERENCE_ID: &str = "bdcc47e4-c0d5-4b67-9803-c92d9781ffbb";
const INVOCATION_ID: &str = "provider-service-steward-1";

#[tokio::test]
async fn ensure_requested_is_pure_idempotent_and_releases_attempt_ownership() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应发送"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity);
    let mut journal = fixture.open();
    let mut service = ProviderInferenceService::new(&mut journal, &providers, &gateway);

    let first = service
        .ensure_requested(execution.clone(), fixture.lease.as_ref())
        .unwrap();
    let second = service
        .ensure_requested(execution, fixture.lease.as_ref())
        .unwrap();

    assert!(matches!(first, EnsuredProviderAttempt::Requested));
    assert!(matches!(second, EnsuredProviderAttempt::Requested));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        attempt_events(&journal)
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["provider.requested"]
    );
    server.abort();
}

#[tokio::test]
async fn cancelled_before_sent_is_a_typed_terminal_and_never_reaches_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("must not be sent"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity);
    let mut journal = fixture.open();
    ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .ensure_requested(execution.clone(), fixture.lease.as_ref())
        .unwrap();
    let mut attempt = ProviderAttemptAggregate::recover(&journal, RUN_ID, ATTEMPT_ID).unwrap();
    let expected_run_sequence = current_run_sequence(&journal);
    drop(journal);
    let expected_global_sequence =
        novelx_runtime::workspace_event_journal::WorkspaceEventJournal::open(&fixture.path)
            .unwrap()
            .current_global_sequence()
            .unwrap();
    let mut journal = fixture.open();
    let cancellation =
        ProviderAttemptCancelledBeforeSent::derive(&attempt, "9".repeat(64), expected_run_sequence)
            .unwrap();
    let idempotency_key = format!(
        "provider:{ATTEMPT_ID}:cancel-before-sent:{}:{}",
        cancellation.cancellation_intent_id, cancellation.requested_evidence_sha256
    );
    attempt
        .cancel_before_sent(
            &mut journal,
            expected_run_sequence,
            expected_global_sequence,
            cancellation,
            ProviderAttemptMetadata {
                message_id: "cancel-before-sent-message",
                idempotency_key: &idempotency_key,
                created_at: "2026-07-13T00:00:00Z",
                reason: Some("run_cancel"),
            },
        )
        .unwrap();
    assert!(matches!(
        ProviderInferenceService::new(&mut journal, &providers, &gateway)
            .ensure_requested(execution, fixture.lease.as_ref()),
        Err(ProviderInferenceServiceError::CancelledBeforeDispatch)
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn ensure_requested_never_redispatches_sent_or_outcome_unknown_attempts() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应发送"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity);
    let mut journal = fixture.open();
    ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .ensure_requested(execution.clone(), fixture.lease.as_ref())
        .unwrap();
    let mut attempt = ProviderAttemptAggregate::recover(&journal, RUN_ID, ATTEMPT_ID).unwrap();
    let expected_run_sequence = current_run_sequence(&journal);
    attempt
        .mark_sent(
            &mut journal,
            expected_run_sequence,
            "dispatch-ensure-requested-test",
            attempt_metadata("sent"),
        )
        .unwrap();

    let sent = ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .ensure_requested(execution.clone(), fixture.lease.as_ref());
    assert!(matches!(
        sent,
        Err(ProviderInferenceServiceError::OutcomeUnknown)
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);

    let expected_run_sequence = current_run_sequence(&journal);
    attempt
        .mark_outcome_unknown(
            &mut journal,
            expected_run_sequence,
            Uuid::parse_str("58fa84a4-3b3e-4aa9-996a-2b74e0b0df94").unwrap(),
            attempt_metadata("outcome-unknown"),
        )
        .unwrap();
    let unknown = ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .ensure_requested(execution, fixture.lease.as_ref());
    assert!(matches!(
        unknown,
        Err(ProviderInferenceServiceError::OutcomeUnknown)
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        attempt_events(&journal)
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec![
            "provider.requested",
            "provider.sent",
            "provider.outcome_unknown"
        ]
    );
    server.abort();
}

#[test]
fn ensure_requested_projects_responded_attempt_without_provider_binding_or_network() {
    let fixture = Fixture::new();
    let (providers, identity) = bound_registry("http://127.0.0.1:9/v1".to_owned(), 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity.clone());
    let mut journal = fixture.open();
    ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .ensure_requested(execution.clone(), fixture.lease.as_ref())
        .unwrap();
    let mut attempt = ProviderAttemptAggregate::recover(&journal, RUN_ID, ATTEMPT_ID).unwrap();
    let expected_run_sequence = current_run_sequence(&journal);
    attempt
        .mark_sent(
            &mut journal,
            expected_run_sequence,
            "dispatch-responded-test",
            attempt_metadata("responded-sent"),
        )
        .unwrap();
    let expected_run_sequence = current_run_sequence(&journal);
    attempt
        .respond_with_output(
            &mut journal,
            expected_run_sequence,
            ProviderResponseReceipt {
                http_status: 200,
                actual_provider_id: identity.provider_id.clone(),
                actual_model_id: identity.model_id.clone(),
                response_id_sha256: Some("a".repeat(64)),
                response_body_sha256: "b".repeat(64),
                stop_reason: "stop".to_owned(),
                input_tokens: 10,
                output_tokens: 2,
                total_tokens: 12,
            },
            Some("持久化响应".to_owned()),
            vec![],
            attempt_metadata("responded"),
        )
        .unwrap();

    let recovered = ProviderInferenceService::new(
        &mut journal,
        &ProviderRegistry::default(),
        &ProviderGateway::new().unwrap(),
    )
    .ensure_requested(execution, fixture.lease.as_ref())
    .unwrap();

    let EnsuredProviderAttempt::Recovered(outcome) = recovered else {
        panic!("responded Attempt must project its persisted outcome");
    };
    assert_eq!(outcome.text.as_deref(), Some("持久化响应"));
    assert_eq!(attempt_events(&journal).len(), 3);
}

#[test]
fn ensure_requested_keeps_failed_attempt_terminal() {
    let fixture = Fixture::new();
    let (providers, identity) = bound_registry("http://127.0.0.1:9/v1".to_owned(), 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity);
    let mut journal = fixture.open();
    ProviderInferenceService::new(&mut journal, &providers, &gateway)
        .ensure_requested(execution.clone(), fixture.lease.as_ref())
        .unwrap();
    let mut attempt = ProviderAttemptAggregate::recover(&journal, RUN_ID, ATTEMPT_ID).unwrap();
    let expected_run_sequence = current_run_sequence(&journal);
    attempt
        .fail(
            &mut journal,
            expected_run_sequence,
            ProviderAttemptFailure {
                code: "LOCAL_AUTHORIZATION_REJECTED".to_owned(),
                retryable: false,
                retry_after_ms: None,
                retry_after: None,
                http_status: None,
                delivery_certainty: ProviderDeliveryCertainty::NotSent,
                diagnostic_id: Uuid::parse_str("1f25d22e-0773-4237-a84e-7031c0d668ee").unwrap(),
            },
            attempt_metadata("failed"),
        )
        .unwrap();

    let failed = ProviderInferenceService::new(
        &mut journal,
        &ProviderRegistry::default(),
        &ProviderGateway::new().unwrap(),
    )
    .ensure_requested(execution, fixture.lease.as_ref());
    assert!(matches!(
        failed,
        Err(ProviderInferenceServiceError::ExistingTerminal(
            ProviderAttemptRecovery::TerminalFailure
        ))
    ));
    assert_eq!(attempt_events(&journal).len(), 2);
}

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

    let execution = execution(identity);
    fixture
        .ensure_requested(&providers, &gateway, execution.clone())
        .unwrap();
    let authorization = fixture.authorize(&providers, &gateway, &execution);
    let armed = fixture.arm(&providers, &gateway, authorization);
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

    let dispatched = fixture.dispatch(&gateway, armed).await;
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    {
        let journal = fixture.open();
        assert_eq!(attempt_events(&journal).len(), 2);
    }

    let outcome = fixture.finalize(dispatched).unwrap();

    server.await.unwrap();
    assert_eq!(outcome.text.as_deref(), Some("分段完成"));
    let journal = fixture.open();
    assert_eq!(
        attempt_events(&journal).last().unwrap().event_type,
        "provider.responded"
    );
}

#[tokio::test]
async fn split_dispatch_holds_attempt_ownership_until_finalize() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("分离派发完成"),
    )))
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity.clone());
    fixture
        .ensure_requested(&providers, &gateway, execution.clone())
        .unwrap();
    let authorization = fixture.authorize(&providers, &gateway, &execution);
    let armed = fixture.arm(&providers, &gateway, authorization);

    let blocked = expect_ensure_error(fixture.ensure_requested(
        &providers,
        &gateway,
        execution.clone(),
    ));
    assert!(matches!(
        blocked,
        ProviderInferenceServiceError::AttemptInFlight { .. }
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);

    let dispatched = fixture.dispatch(&gateway, armed).await;
    let outcome = fixture.finalize(dispatched).unwrap();
    server.await.unwrap();
    assert_eq!(outcome.text.as_deref(), Some("分离派发完成"));
    assert_eq!(request_count.load(Ordering::SeqCst), 1);

    let recovered = fixture
        .ensure_requested(
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            execution,
        )
        .unwrap();
    let EnsuredProviderAttempt::Recovered(recovered) = recovered else {
        panic!("terminal response must recover without redispatch");
    };
    let recovered = *recovered;
    assert_eq!(recovered, outcome);
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

    let execution = execution(identity);
    fixture
        .ensure_requested(&providers, &gateway, execution.clone())
        .unwrap();
    let authorization = fixture.authorize(&providers, &gateway, &execution);
    let armed = fixture.arm(&providers, &gateway, authorization);
    let dispatched = fixture.dispatch(&gateway, armed).await;
    {
        let journal = fixture.open();
        assert_eq!(attempt_events(&journal).len(), 2);
    }

    let error = fixture.finalize(dispatched).unwrap_err();

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

    let outcome = fixture
        .execute_authorized(&providers, &gateway, execution.clone())
        .await
        .unwrap();
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
    let unbound_providers = ProviderRegistry::default();
    let recovered = fixture
        .ensure_requested(&unbound_providers, &no_network_gateway, execution)
        .unwrap();
    let EnsuredProviderAttempt::Recovered(recovered) = recovered else {
        panic!("terminal response must recover without provider binding");
    };
    let recovered = *recovered;
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

    let outcome = fixture
        .execute_authorized(&providers, &gateway, execution.clone())
        .await
        .unwrap();
    assert_eq!(outcome.text, None);
    assert_eq!(outcome.tool_calls.len(), 1);
    assert_eq!(outcome.tool_calls[0].name, "read_project");
    server.await.unwrap();

    let recovered = fixture
        .ensure_requested(&providers, &gateway, execution)
        .unwrap();
    let EnsuredProviderAttempt::Recovered(recovered) = recovered else {
        panic!("terminal tool calls must recover without redispatch");
    };
    let recovered = *recovered;
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
    let first = fixture
        .execute_authorized(&providers, &gateway, execution.clone())
        .await
        .unwrap();
    let second = fixture
        .ensure_requested(&providers, &gateway, execution)
        .unwrap();
    let EnsuredProviderAttempt::Recovered(second) = second else {
        panic!("identical execution must recover the original result");
    };
    let second = *second;

    assert_eq!(second, first);
    server.await.unwrap();
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(attempt_events(&fixture.open()).len(), 3);
}

#[tokio::test]
async fn concurrent_execution_of_the_same_attempt_is_rejected_as_in_flight() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Delayed {
        delay: Duration::from_millis(500),
        response: json_response(200, successful_body("唯一响应")),
    })
    .await;
    let (providers, identity) = bound_registry(base_url, 2_000);
    fixture.seed(&identity, false);
    let gateway = ProviderGateway::new().unwrap();
    let execution = execution(identity);
    let first_call = fixture.execute_authorized(&providers, &gateway, execution.clone());
    let second_call = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        fixture.ensure_requested(&providers, &gateway, execution)
    };
    let (first_result, second_result) = tokio::join!(first_call, second_call);

    server.await.unwrap();
    assert_eq!(first_result.unwrap().text.as_deref(), Some("唯一响应"));
    assert!(matches!(
        expect_ensure_error(second_result),
        ProviderInferenceServiceError::AttemptInFlight { .. }
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        attempt_events(&fixture.open())
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["provider.requested", "provider.sent", "provider.responded"]
    );
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
    let first = fixture
        .execute_authorized(&providers, &gateway, execution.clone())
        .await
        .unwrap_err();
    assert!(matches!(
        first,
        ProviderInferenceServiceError::DeliveryUnknown(_)
    ));
    assert_eq!(
        RunAggregate::recover(&fixture.open(), RUN_ID).unwrap().state(),
        RunState::WaitingForReconciliation
    );
    let second = expect_ensure_error(fixture.ensure_requested(
        &providers,
        &gateway,
        execution,
    ));
    assert!(matches!(
        second,
        ProviderInferenceServiceError::OutcomeUnknown
    ));

    server.await.unwrap();
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    let events = attempt_events(&fixture.open());
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
    let error = fixture
        .execute_authorized(&providers, &gateway, execution(identity))
        .await
        .unwrap_err();

    assert!(matches!(error, ProviderInferenceServiceError::Gateway(_)));
    server.await.unwrap();
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    let events = attempt_events(&fixture.open());
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
async fn only_allowlisted_definitive_http_failures_persist_retry_eligibility() {
    for (status, headers, expected_retryable, expected_retry_after_ms) in [
        (429, Vec::<&str>::new(), false, None),
        (429, vec!["Retry-After: 0"], true, Some(0_u64)),
        (500, Vec::<&str>::new(), true, None),
        (501, Vec::<&str>::new(), false, None),
        (503, vec!["Retry-After: 2"], true, Some(2_000_u64)),
    ] {
        let fixture = Fixture::new();
        let response = json_response_with_headers(status, r#"{"error":"temporary"}"#, &headers);
        let (base_url, _, _, server) = spawn_server(ServerReply::Immediate(response)).await;
        let (providers, identity) = bound_registry(base_url, 2_000);
        fixture.seed(&identity, false);
        let gateway = ProviderGateway::new().unwrap();
        fixture
            .execute_authorized(&providers, &gateway, execution(identity))
            .await
            .unwrap_err();

        server.await.unwrap();
        let events = attempt_events(&fixture.open());
        let failure = &events.last().unwrap().payload["failure"];
        assert_eq!(failure["retryable"], expected_retryable, "HTTP {status}");
        match expected_retry_after_ms {
            Some(delay) => {
                assert_eq!(failure["retryAfterMs"], delay, "HTTP {status}");
                assert_eq!(failure["retryAfter"]["delayMs"], delay, "HTTP {status}");
                assert_eq!(
                    failure["retryAfter"]["valueSha256"].as_str().unwrap().len(),
                    64
                );
            }
            None => {
                assert!(failure["retryAfterMs"].is_null(), "HTTP {status}");
                assert!(failure["retryAfter"].is_null(), "HTTP {status}");
            }
        }
    }
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
    fixture
        .ensure_requested(&providers, &gateway, execution)
        .unwrap();

    server.abort();
    let requested = attempt_events(&fixture.open()).remove(0);
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
    fixture
        .execute_authorized(&providers, &gateway, execution(identity))
        .await
        .unwrap();

    server.await.unwrap();
    let serialized = format!("{:?}", fixture.open().read_run(RUN_ID, 0).unwrap());
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
    let error = expect_ensure_error(fixture.ensure_requested(
        &providers,
        &gateway,
        execution(changed),
    ));

    assert!(matches!(
        error,
        ProviderInferenceServiceError::PinnedProviderMismatch
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert!(attempt_events(&fixture.open()).is_empty());
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
    let mut malicious = execution(identity);
    malicious.request.messages[0].content = "恶意替换正文".to_owned();

    fixture
        .execute_authorized(&providers, &gateway, malicious)
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
    let error = expect_ensure_error(fixture.ensure_requested(
        &providers,
        &gateway,
        execution(identity),
    ));

    assert!(matches!(
        error,
        ProviderInferenceServiceError::ContextNormalizedInputHashMismatch
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert!(attempt_events(&fixture.open()).is_empty());
    server.abort();
}

fn execution(provider: ProviderRunIdentity) -> ProviderInferenceExecution {
    ProviderInferenceExecution {
        run_id: RUN_ID.to_owned(),
        attempt_id: ATTEMPT_ID.to_owned(),
        inference_id: INFERENCE_ID.to_owned(),
        invocation_id: INVOCATION_ID.to_owned(),
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

fn context_source_command(
    provider: ProviderRunIdentity,
    context_policy: novelx_protocol::VersionedPolicyIdentity,
) -> ContextCompile {
    let content = "权威正文";
    ContextCompile {
        compile_idempotency_key: "context-key-1".to_owned(),
        invocation_id: INVOCATION_ID.to_owned(),
        request_number: 1,
        provider,
        context_policy,
        compiler_version: "1.0.0".to_owned(),
        context_window: 64_000,
        configured_max_output_tokens: Some(8_000),
        safety_reserve_tokens: 6_400,
        items: vec![
            ContextItem::SessionMessage {
                item_id: "authoritative-user".to_owned(),
                message_id: "authoritative-message".to_owned(),
                role: ContextMessageRole::User,
                content: content.to_owned(),
                content_sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
                created_at: "2026-07-12T00:00:00Z".to_owned(),
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
    json_response_with_headers(status, body, &[])
}

fn json_response_with_headers(status: u16, body: impl AsRef<str>, headers: &[&str]) -> String {
    let body = body.as_ref();
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
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

fn attempt_events(journal: &EventJournal) -> Vec<novelx_runtime::event_journal::RuntimeEvent> {
    journal
        .read_aggregate(RUN_ID, "provider_attempt", ATTEMPT_ID, 0)
        .unwrap()
}

fn current_run_sequence(journal: &EventJournal) -> u64 {
    journal
        .read_run(RUN_ID, 0)
        .unwrap()
        .last()
        .map_or(0, |event| event.run_sequence)
}

fn attempt_metadata(idempotency_key: &'static str) -> ProviderAttemptMetadata<'static> {
    ProviderAttemptMetadata {
        message_id: idempotency_key,
        idempotency_key,
        created_at: "2026-07-13T00:00:00Z",
        reason: None,
    }
}

fn expect_ensure_error(
    result: Result<EnsuredProviderAttempt, ProviderInferenceServiceError>,
) -> ProviderInferenceServiceError {
    match result {
        Err(error) => error,
        Ok(_) => panic!("provider attempt unexpectedly passed request admission"),
    }
}

struct Fixture {
    _temp: TempDir,
    path: std::path::PathBuf,
    lease: Arc<BoundWorkspaceRuntimeLease>,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        EventJournal::open(&path).unwrap();
        let lease = Arc::new(
            WorkspaceRuntimeLease::acquire(&path, "provider-inference-service")
                .unwrap()
                .bind_database(&path)
                .unwrap(),
        );
        Self {
            _temp: temp,
            path,
            lease,
        }
    }

    fn open(&self) -> EventJournal {
        EventJournal::open(&self.path).unwrap()
    }

    fn seed(&self, provider: &ProviderRunIdentity, tamper_hash: bool) {
        let mut journal = self.open();
        let mut identity = pinned_identity();
        identity.provider = provider.clone();
        let source_command =
            context_source_command(provider.clone(), identity.context_policy.clone());
        let loop_identity = identity.clone();
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
                        "sourceCommand": source_command,
                    }),
                    created_at: "2026-07-12T00:00:01Z".to_owned(),
                },
                3,
                0,
            )
            .unwrap();

        let dispatch = InferenceDispatchIdentity {
            inference_id: Uuid::parse_str(INFERENCE_ID).unwrap(),
            attempt_id: Uuid::parse_str(ATTEMPT_ID).unwrap(),
            request_number: 1,
            context_compilation_id: compilation_receipt().compilation_id,
            attempt_number: 1,
            inference_idempotency_key: "inference-key-provider-service-1".to_owned(),
        };
        let agent_loop = AgentLoopService::new(
            AgentLoopIdentity {
                run_id: Uuid::parse_str(RUN_ID).unwrap(),
                project_id: loop_identity.project_id.clone(),
                invocation_id: INVOCATION_ID.to_owned(),
                initial_context_compilation_id: compilation_receipt().compilation_id,
                source_scope: ToolSourceScope {
                    source_checkpoint_id: loop_identity.source_checkpoint_id.clone(),
                    resource_ids: loop_identity.scope_resource_ids.clone(),
                    scope_sha256: loop_identity.resource_scope_sha256.clone(),
                },
                permission: ToolPermissionPolicy {
                    mode: loop_identity.mode,
                    policy_id: loop_identity.tool_policy.id.clone(),
                    policy_version: loop_identity.tool_policy.version.clone(),
                    policy_sha256: loop_identity.tool_policy.sha256.clone(),
                },
            },
            AgentLoopPolicy {
                maximum_tool_rounds: 4,
                tool_schema_version: 1,
            },
            dispatch,
        )
        .unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &agent_loop,
                "provider-service-loop:create",
                AgentLoopEventMetadata {
                    message_id: "provider-service-loop-message",
                    created_at: "2026-07-12T00:00:02Z",
                },
            )
            .unwrap();
    }

    fn ensure_requested(
        &self,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        execution: ProviderInferenceExecution,
    ) -> Result<EnsuredProviderAttempt, ProviderInferenceServiceError> {
        let mut journal = self.open();
        ProviderInferenceService::new(&mut journal, providers, gateway)
            .ensure_requested(execution, self.lease.as_ref())
    }

    fn authorize(
        &self,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        execution: &ProviderInferenceExecution,
    ) -> ProviderLiveEffectAuthorization {
        ProviderEffectAuthorizationService::new(&self.path, "workspace-1", "project-1")
            .unwrap()
            .authorize_live(
                ProviderLiveEffectAuthorizationRequest {
                    run_id: Uuid::parse_str(&execution.run_id).unwrap(),
                    invocation_id: execution.invocation_id.clone(),
                    attempt_id: Uuid::parse_str(&execution.attempt_id).unwrap(),
                },
                providers,
                gateway,
                Arc::clone(&self.lease),
            )
            .unwrap()
    }

    fn arm(
        &self,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        authorization: ProviderLiveEffectAuthorization,
    ) -> AuthorizedProviderAttemptDispatch {
        let mut journal = self.open();
        ProviderInferenceService::new(&mut journal, providers, gateway)
            .arm_authorized_dispatch(authorization, &self.path, false)
            .unwrap()
    }

    async fn dispatch(
        &self,
        gateway: &ProviderGateway,
        armed: AuthorizedProviderAttemptDispatch,
    ) -> AuthorizedDispatchedProviderAttempt {
        let (_cancel_tx, mut cancellation) = watch::channel(false);
        ProviderInferenceService::dispatch_authorized_attempt(gateway, armed, &mut cancellation)
            .await
    }

    fn finalize(
        &self,
        dispatched: AuthorizedDispatchedProviderAttempt,
    ) -> Result<ProviderInferenceOutcome, ProviderInferenceServiceError> {
        let mut journal = self.open();
        ProviderInferenceService::finalize_authorized_attempt_in(&mut journal, dispatched)
    }

    async fn execute_authorized(
        &self,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        execution: ProviderInferenceExecution,
    ) -> Result<ProviderInferenceOutcome, ProviderInferenceServiceError> {
        match self.ensure_requested(providers, gateway, execution.clone())? {
            EnsuredProviderAttempt::Recovered(outcome) => Ok(*outcome),
            EnsuredProviderAttempt::Requested => {
                let authorization = self.authorize(providers, gateway, &execution);
                let armed = self.arm(providers, gateway, authorization);
                let dispatched = self.dispatch(gateway, armed).await;
                self.finalize(dispatched)
            }
        }
    }
}
}
    };
}
