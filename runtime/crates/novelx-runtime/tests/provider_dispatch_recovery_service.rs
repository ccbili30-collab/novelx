mod support;

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use novelx_protocol::{
    ContextBudgetAllocation, ContextBudgetCategory, ContextCompilationReceipt, ContextDisclosure,
    ContextRepresentation, ProviderRunIdentity, TokenizerIdentity, TokenizerKind,
    ToolPermissionPolicy, ToolSourceScope,
};
use novelx_runtime::{
    agent_assignment_recovery::recover_agent_assignments,
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity,
    },
    event_journal::{EventJournal, NewRuntimeEvent},
    operational_recovery_aggregate::{OperationalRecoveryOutcome, OperationalRecoveryRepository},
    operational_recovery_claim_service::{
        OperationalRecoveryClaimRequest, OperationalRecoveryClaimService,
        OperationalRecoveryStartRequest,
    },
    operational_recovery_recording_service::OperationalRecoveryRecordingService,
    operational_recovery_scanner::{OperationalRecoveryGate, OperationalRecoveryScanner},
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptMetadata,
        ProviderAttemptState, ProviderResponseReceipt,
    },
    provider_dispatch_recovery_service::{
        ProviderDispatchRecoveryError, ProviderDispatchRecoveryRequest,
        ProviderDispatchRecoveryService, ProviderDispatchRecoveryTerminal,
    },
    provider_gateway::{
        ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderGateway,
        ProviderInferenceMessage, ProviderInferenceRequest, ProviderInferenceRole,
        ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
    },
    run_aggregate::{EventMetadata, RunAggregate},
    workspace_runtime_lease::WorkspaceRuntimeLease,
};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const API_KEY: &str = "provider-dispatch-recovery-test-key";
const WORKSPACE_ID: &str = "workspace-1";
const PROJECT_ID: &str = "project-1";

#[tokio::test]
async fn requested_dispatches_once_and_terminal_reentry_never_sends_again() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("潮汐记录已恢复。"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-requested");
    let service = ProviderDispatchRecoveryService::new(&fixture.path);

    let first = service
        .execute_requested(seeded.request.clone(), &providers, &gateway, &seeded.lease)
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(first.terminal, ProviderDispatchRecoveryTerminal::Responded);
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );

    let second = service
        .execute_requested(
            seeded.request.clone(),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();
    assert_eq!(second, first);
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
}

#[tokio::test]
async fn sent_attempt_is_evidence_first_and_never_requires_provider_binding_or_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-sent");
    fixture.mark_sent(&seeded);

    let receipt = ProviderDispatchRecoveryService::new(&fixture.path)
        .execute_requested(
            seeded.request.clone(),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();

    assert_eq!(
        receipt.terminal,
        ProviderDispatchRecoveryTerminal::OutcomeUnknown
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.attempt_state(&seeded), ProviderAttemptState::Sent);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::OutcomeUnknown { .. })
    ));
    server.abort();
}

#[tokio::test]
async fn responded_attempt_is_evidence_first_and_never_requires_provider_binding_or_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-responded");
    fixture.mark_responded(&seeded);

    let receipt = ProviderDispatchRecoveryService::new(&fixture.path)
        .execute_requested(
            seeded.request.clone(),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();

    assert_eq!(
        receipt.terminal,
        ProviderDispatchRecoveryTerminal::Responded
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
    server.abort();
}

#[tokio::test]
async fn authentication_rejection_finishes_failed_safe_after_one_real_http_request() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        401,
        r#"{"error":"invalid key"}"#,
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-401");

    let receipt = ProviderDispatchRecoveryService::new(&fixture.path)
        .execute_requested(seeded.request.clone(), &providers, &gateway, &seeded.lease)
        .await
        .unwrap();

    server.await.unwrap();
    assert_eq!(
        receipt.terminal,
        ProviderDispatchRecoveryTerminal::FailedSafe
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.attempt_state(&seeded), ProviderAttemptState::Failed);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::FailedSafe { .. })
    ));
}

#[tokio::test]
async fn missing_provider_binding_blocks_before_dispatch_without_terminalizing_requested_attempt() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-unbound");

    let error = ProviderDispatchRecoveryService::new(&fixture.path)
        .execute_requested(
            seeded.request.clone(),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .expect_err("missing Provider binding must remain a resumable pre-dispatch block");

    let diagnostic = error.to_string().to_ascii_lowercase();
    assert!(
        diagnostic.contains("provider")
            && (diagnostic.contains("bound") || diagnostic.contains("binding")),
        "the block must identify the missing Provider binding: {error}"
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Requested
    );
    assert_eq!(fixture.outcome(&seeded), None);
    server.abort();
}

#[tokio::test]
async fn wrong_database_lease_and_wrong_execution_fence_fail_before_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-fence");
    let unrelated = Fixture::new();
    let wrong_lease = unrelated.lease("runtime-other-database");
    let service = ProviderDispatchRecoveryService::new(&fixture.path);

    let wrong_database = service
        .execute_requested(seeded.request.clone(), &providers, &gateway, &wrong_lease)
        .await
        .unwrap_err();
    assert!(matches!(
        wrong_database,
        ProviderDispatchRecoveryError::WorkspaceLeaseMismatch
    ));

    let mut wrong_fence_request = seeded.request.clone();
    wrong_fence_request.execution_id = Uuid::new_v4().to_string();
    let wrong_fence = service
        .execute_requested(wrong_fence_request, &providers, &gateway, &seeded.lease)
        .await
        .unwrap_err();
    assert!(matches!(
        wrong_fence,
        ProviderDispatchRecoveryError::RecoveryFenceMismatch
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Requested
    );
    assert_eq!(fixture.outcome(&seeded), None);
    server.abort();
}

#[tokio::test]
async fn concurrent_execute_is_single_flight_and_never_marks_the_live_request_outcome_unknown() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Delayed {
        delay: Duration::from_millis(500),
        response: json_response(200, successful_body("唯一响应")),
    })
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-single-flight");
    let first_service = ProviderDispatchRecoveryService::new(&fixture.path);
    let second_service = ProviderDispatchRecoveryService::new(&fixture.path);
    let first_request = seeded.request.clone();
    let second_request = seeded.request.clone();

    let first = first_service.execute_requested(first_request, &providers, &gateway, &seeded.lease);
    let second = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        second_service
            .execute_requested(second_request, &providers, &gateway, &seeded.lease)
            .await
    };
    let (first, second) = tokio::join!(first, second);

    server.await.unwrap();
    assert_eq!(
        first.unwrap().terminal,
        ProviderDispatchRecoveryTerminal::Responded
    );
    assert!(matches!(
        second.unwrap_err(),
        ProviderDispatchRecoveryError::DispatchAlreadyInFlight
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
}

struct Fixture {
    _temp: TempDir,
    path: std::path::PathBuf,
}

struct SeededRecovery {
    run_id: String,
    attempt_id: String,
    provider: ProviderRunIdentity,
    request: ProviderDispatchRecoveryRequest,
    lease: WorkspaceRuntimeLease,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        Self { _temp: temp, path }
    }

    fn lease(&self, instance_id: &str) -> WorkspaceRuntimeLease {
        WorkspaceRuntimeLease::acquire(&self.path, instance_id).unwrap()
    }

    fn seed_requested(
        &self,
        providers: &ProviderRegistry,
        provider: &ProviderRunIdentity,
        gateway: &ProviderGateway,
        owner_instance_id: &str,
    ) -> SeededRecovery {
        let run_uuid = Uuid::new_v4();
        let run_id = run_uuid.to_string();
        let invocation_id = format!("{run_id}:steward");
        let inference_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();
        let compilation_id = Uuid::new_v4();
        let receipt = compilation_receipt(compilation_id);
        let authoritative_request = authoritative_request(receipt.clone());
        let bound = providers.resolve(provider).unwrap();
        let prepared = gateway
            .prepare_inference(bound, authoritative_request)
            .unwrap();
        let mut identity = pinned_identity();
        identity.provider = provider.clone();
        let source_scope = ToolSourceScope {
            source_checkpoint_id: identity.source_checkpoint_id.clone(),
            resource_ids: identity.scope_resource_ids.clone(),
            scope_sha256: identity.resource_scope_sha256.clone(),
        };
        let permission = ToolPermissionPolicy {
            mode: identity.mode,
            policy_id: identity.tool_policy.id.clone(),
            policy_version: identity.tool_policy.version.clone(),
            policy_sha256: identity.tool_policy.sha256.clone(),
        };
        let mut journal = EventJournal::open(&self.path).unwrap();
        let mut run = RunAggregate::create(
            &mut journal,
            &run_id,
            identity,
            metadata("run-create", "run-create-key"),
        )
        .unwrap();
        run.prepare(&mut journal, metadata("run-prepare", "run-prepare-key"))
            .unwrap();
        run.start(&mut journal, metadata("run-start", "run-start-key"))
            .unwrap();
        let normalized = serde_json::json!({
            "messages": [{
                "role": "user",
                "content": "权威正文",
            }],
            "tools": [],
        });
        let normalized_sha256 = format!(
            "{:x}",
            Sha256::digest(
                r#"{"messages":[{"role":"user","content":"权威正文"}],"tools":[]}"#.as_bytes()
            )
        );
        let expected_run_sequence = current_run_sequence(&journal, &run_id);
        journal
            .append(
                NewRuntimeEvent {
                    run_id: run_id.clone(),
                    aggregate_type: "context".to_owned(),
                    aggregate_id: format!("{invocation_id}:1"),
                    message_id: "context-message-1".to_owned(),
                    idempotency_key: "context-key-1".to_owned(),
                    event_type: "context.compiled".to_owned(),
                    event_version: 1,
                    payload: serde_json::json!({
                        "requestSha256": "9".repeat(64),
                        "receipt": receipt,
                        "normalizedInput": normalized,
                        "normalizedInputSha256": normalized_sha256,
                    }),
                    created_at: "2026-07-13T00:00:01Z".to_owned(),
                },
                expected_run_sequence,
                0,
            )
            .unwrap();
        let loop_service = AgentLoopService::new(
            AgentLoopIdentity {
                run_id: run_uuid,
                project_id: PROJECT_ID.to_owned(),
                invocation_id: invocation_id.clone(),
                initial_context_compilation_id: compilation_id,
                source_scope,
                permission,
            },
            AgentLoopPolicy {
                maximum_tool_rounds: 4,
                tool_schema_version: 1,
            },
            InferenceDispatchIdentity {
                inference_id,
                attempt_id,
                request_number: 1,
                context_compilation_id: compilation_id,
                attempt_number: 1,
                inference_idempotency_key: format!("{run_id}:inference:1"),
            },
        )
        .unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &loop_service,
                "agent-loop:create",
                AgentLoopEventMetadata {
                    message_id: "agent-loop-create",
                    created_at: "2026-07-13T00:00:02Z",
                },
            )
            .unwrap();
        let attempt_id_string = attempt_id.to_string();
        let attempt_definition = ProviderAttemptDefinition {
            run_id: run_id.clone(),
            inference_id: inference_id.to_string(),
            invocation_id,
            context_compilation_id: compilation_id,
            canonical_context_sha256: prepared.compilation().canonical_context_sha256.clone(),
            transport_payload_sha256: prepared.transport_payload_sha256().to_owned(),
            provider: provider.clone(),
            request_number: 1,
            attempt_number: 1,
            output_reserve_tokens: prepared.compilation().output_reserve_tokens,
            request_timeout_ms: bound.config().request_timeout_ms,
            total_deadline_ms: bound.config().total_deadline_ms,
            max_attempts: bound.config().retry_policy.max_attempts,
            max_total_delay_ms: bound.config().retry_policy.max_total_delay_ms,
        };
        let sequence = current_run_sequence(&journal, &run_id);
        ProviderAttemptAggregate::create(
            &mut journal,
            &run_id,
            &attempt_id_string,
            attempt_definition,
            sequence,
            provider_metadata("provider-requested", "provider-requested-key"),
        )
        .unwrap();
        drop(journal);

        let assignments = recover_agent_assignments(&self.path, WORKSPACE_ID, PROJECT_ID).unwrap();
        let report = {
            let mut journal = EventJournal::open(&self.path).unwrap();
            OperationalRecoveryScanner::new(
                &mut journal,
                &assignments,
                std::slice::from_ref(provider),
            )
            .scan(WORKSPACE_ID, PROJECT_ID)
            .unwrap()
        };
        let scanned = report.runs.iter().find(|run| run.run_id == run_id).unwrap();
        assert_eq!(scanned.gate, OperationalRecoveryGate::ProviderDispatchReady);
        let operation_id = OperationalRecoveryRecordingService::new(&self.path)
            .record(WORKSPACE_ID, PROJECT_ID, &report, "2026-07-13T00:00:03Z")
            .unwrap()
            .into_iter()
            .find(|record| record.run_id == run_id)
            .unwrap()
            .operation_id;
        let lease = self.lease(owner_instance_id);
        let claim_service = OperationalRecoveryClaimService::new(&self.path);
        let claimed = claim_service
            .claim_provider_dispatch_ready(
                claim_request(&run_id, &operation_id),
                std::slice::from_ref(provider),
                &lease,
            )
            .unwrap();
        let claim = claimed.operations[&operation_id]
            .claim
            .as_ref()
            .unwrap()
            .clone();
        let started = claim_service
            .start_claimed(
                OperationalRecoveryStartRequest {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    project_id: PROJECT_ID.to_owned(),
                    run_id: run_id.clone(),
                    operation_id: operation_id.clone(),
                    claim_id: claim.claim_id,
                    owner_instance_id: claim.owner_instance_id,
                    fencing_token: claim.fencing_token,
                },
                std::slice::from_ref(provider),
                &lease,
            )
            .unwrap();
        let execution_id = started.operations[&operation_id]
            .execution
            .as_ref()
            .unwrap()
            .execution_id
            .clone();
        SeededRecovery {
            run_id: run_id.clone(),
            attempt_id: attempt_id_string,
            provider: provider.clone(),
            request: ProviderDispatchRecoveryRequest {
                workspace_id: WORKSPACE_ID.to_owned(),
                run_id,
                operation_id,
                execution_id,
            },
            lease,
        }
    }

    fn mark_sent(&self, seeded: &SeededRecovery) {
        let mut journal = EventJournal::open(&self.path).unwrap();
        let mut attempt =
            ProviderAttemptAggregate::recover(&journal, &seeded.run_id, &seeded.attempt_id)
                .unwrap();
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        attempt
            .mark_sent(
                &mut journal,
                sequence,
                "persisted-dispatch-id",
                provider_metadata("provider-sent", "provider-sent-key"),
            )
            .unwrap();
    }

    fn mark_responded(&self, seeded: &SeededRecovery) {
        self.mark_sent(seeded);
        let mut journal = EventJournal::open(&self.path).unwrap();
        let mut attempt =
            ProviderAttemptAggregate::recover(&journal, &seeded.run_id, &seeded.attempt_id)
                .unwrap();
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        attempt
            .respond_with_output(
                &mut journal,
                sequence,
                ProviderResponseReceipt {
                    http_status: 200,
                    actual_provider_id: seeded.provider.provider_id.clone(),
                    actual_model_id: seeded.provider.model_id.clone(),
                    response_id_sha256: Some("c".repeat(64)),
                    response_body_sha256: "d".repeat(64),
                    stop_reason: "stop".to_owned(),
                    input_tokens: 10,
                    output_tokens: 2,
                    total_tokens: 12,
                },
                Some("持久化响应".to_owned()),
                vec![],
                provider_metadata("provider-responded", "provider-responded-key"),
            )
            .unwrap();
    }

    fn attempt_state(&self, seeded: &SeededRecovery) -> ProviderAttemptState {
        ProviderAttemptAggregate::recover(
            &EventJournal::open(&self.path).unwrap(),
            &seeded.run_id,
            &seeded.attempt_id,
        )
        .unwrap()
        .state()
    }

    fn outcome(&self, seeded: &SeededRecovery) -> Option<OperationalRecoveryOutcome> {
        OperationalRecoveryRepository::open(&self.path)
            .unwrap()
            .load(WORKSPACE_ID, &seeded.run_id)
            .unwrap()
            .operations[&seeded.request.operation_id]
            .outcome
            .clone()
    }
}

fn claim_request(run_id: &str, operation_id: &str) -> OperationalRecoveryClaimRequest {
    OperationalRecoveryClaimRequest {
        workspace_id: WORKSPACE_ID.to_owned(),
        project_id: PROJECT_ID.to_owned(),
        run_id: run_id.to_owned(),
        expected_operation_id: operation_id.to_owned(),
        lease_duration_seconds: 30,
    }
}

fn compilation_receipt(compilation_id: Uuid) -> ContextCompilationReceipt {
    ContextCompilationReceipt {
        compilation_id,
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

fn authoritative_request(receipt: ContextCompilationReceipt) -> ProviderInferenceRequest {
    ProviderInferenceRequest {
        compilation: receipt,
        messages: vec![ProviderInferenceMessage {
            role: ProviderInferenceRole::User,
            content: "权威正文".to_owned(),
            tool_calls: vec![],
            tool_call_id: None,
        }],
        tools: vec![],
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

fn metadata<'a>(message_id: &'a str, idempotency_key: &'a str) -> EventMetadata<'a> {
    EventMetadata {
        message_id,
        idempotency_key,
        created_at: "2026-07-13T00:00:00Z",
        reason: None,
    }
}

fn provider_metadata<'a>(
    message_id: &'a str,
    idempotency_key: &'a str,
) -> ProviderAttemptMetadata<'a> {
    ProviderAttemptMetadata {
        message_id,
        idempotency_key,
        created_at: "2026-07-13T00:00:02Z",
        reason: None,
    }
}

fn current_run_sequence(journal: &EventJournal, run_id: &str) -> u64 {
    journal
        .read_run(run_id, 0)
        .unwrap()
        .last()
        .map_or(0, |event| event.run_sequence)
}
