mod support;

use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

use novelx_protocol::{
    ContextBudgetAllocation, ContextBudgetCategory, ContextCompilationReceipt, ContextDisclosure,
    ContextRepresentation, Envelope, MessageType, PROTOCOL_VERSION, ProviderRunIdentity,
    RuntimeApplicationIdentity, RuntimeInitialize, TokenizerIdentity, TokenizerKind,
    ToolPermissionPolicy, ToolSourceScope,
};
use novelx_runtime::{
    agent_assignment_recovery::recover_agent_assignments,
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity, LoopPhase,
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
        ProviderAttemptState,
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
use uuid::Uuid;

const SECRET: &str = "provider-dispatch-handshake-secret";
const WORKSPACE_ID: &str = "workspace-1";
const PROJECT_ID: &str = "project-1";

#[test]
fn runtime_bind_recovers_old_owner_dispatch_projects_locally_and_never_resends() {
    let fixture = Fixture::new();
    let server = LoopbackProvider::start();
    let config = test_provider_config(server.base_url.clone());
    let config_sha256 = provider_config_sha256(&config).unwrap();
    let provider = ProviderRunIdentity {
        profile_id: config.profile_id.clone(),
        provider_id: config.provider_id.clone(),
        model_id: config.model_id.clone(),
        config_sha256: config_sha256.clone(),
    };
    let mut providers = ProviderRegistry::default();
    providers
        .bind(config.clone(), &config_sha256, SECRET.to_owned())
        .unwrap();
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway);
    let started = fixture.start_provider_dispatch(&seeded, "dead-runtime-owner");
    drop(started.lease);

    let (mut first, mut first_output) = spawn_runtime();
    write_envelope(&mut first, &initialize_envelope(&fixture.path));
    let ready = read_envelope(&mut first_output);
    if ready.name != "runtime.ready" {
        drop(first.stdin.take());
        let mut stderr = String::new();
        first
            .stderr
            .as_mut()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        let _ = first.wait();
        let recovery = OperationalRecoveryRepository::open(&fixture.path)
            .unwrap()
            .load(WORKSPACE_ID, &seeded.run_id)
            .unwrap();
        panic!(
            "runtime initialize failed: {:?}; stderr={stderr}; recovery={recovery:?}",
            ready.payload,
        );
    }

    bind_provider(&mut first, &mut first_output, 2, &config, &config_sha256);
    assert_eq!(server.request_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );
    assert!(matches!(
        fixture.dispatch_outcome(&seeded.run_id, &started.operation_id),
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
    assert_eq!(fixture.loop_phase(&seeded), LoopPhase::Completed);

    bind_provider(&mut first, &mut first_output, 3, &config, &config_sha256);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        server.request_count.load(Ordering::SeqCst),
        1,
        "refresh after the second bind must consume persisted evidence without another request"
    );
    shutdown(&mut first, &mut first_output, 4);

    let (mut restarted, mut restarted_output) = spawn_runtime();
    write_envelope(&mut restarted, &initialize_envelope(&fixture.path));
    assert_eq!(read_envelope(&mut restarted_output).name, "runtime.ready");
    bind_provider(
        &mut restarted,
        &mut restarted_output,
        2,
        &config,
        &config_sha256,
    );
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        server.request_count.load(Ordering::SeqCst),
        1,
        "restart and rebind must not redispatch a terminal Provider Attempt"
    );
    shutdown(&mut restarted, &mut restarted_output, 3);

    assert_eq!(fixture.loop_phase(&seeded), LoopPhase::Completed);
    assert_eq!(
        EventJournal::open(&fixture.path)
            .unwrap()
            .read_aggregate(&seeded.run_id, "provider_attempt", &seeded.attempt_id, 0,)
            .unwrap()
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["provider.requested", "provider.sent", "provider.responded"]
    );
    server.stop();
}

struct Fixture {
    _temp: TempDir,
    path: std::path::PathBuf,
}

struct SeededRun {
    run_id: String,
    invocation_id: String,
    attempt_id: String,
    provider: ProviderRunIdentity,
}

struct StartedDispatch {
    operation_id: String,
    lease: WorkspaceRuntimeLease,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        Self { _temp: temp, path }
    }

    fn lease(&self, owner: &str) -> WorkspaceRuntimeLease {
        WorkspaceRuntimeLease::acquire(&self.path, owner).unwrap()
    }

    fn seed_requested(
        &self,
        providers: &ProviderRegistry,
        provider: &ProviderRunIdentity,
        gateway: &ProviderGateway,
    ) -> SeededRun {
        let run_uuid = Uuid::new_v4();
        let run_id = run_uuid.to_string();
        let invocation_id = format!("{run_id}:steward");
        let inference_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();
        let compilation_id = Uuid::new_v4();
        let receipt = compilation_receipt(compilation_id);
        let bound = providers.resolve(provider).unwrap();
        let prepared = gateway
            .prepare_inference(bound, authoritative_request(receipt.clone()))
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
            "messages": [{"role": "user", "content": "权威正文"}],
            "tools": [],
        });
        let normalized_sha256 = format!(
            "{:x}",
            Sha256::digest(
                r#"{"messages":[{"role":"user","content":"权威正文"}],"tools":[]}"#.as_bytes()
            )
        );
        let sequence = current_run_sequence(&journal, &run_id);
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
                sequence,
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
        let attempt_id = attempt_id.to_string();
        let definition = ProviderAttemptDefinition {
            run_id: run_id.clone(),
            inference_id: inference_id.to_string(),
            invocation_id: invocation_id.clone(),
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
            &attempt_id,
            definition,
            sequence,
            provider_metadata("provider-requested", "provider-requested-key"),
        )
        .unwrap();
        SeededRun {
            run_id,
            invocation_id,
            attempt_id,
            provider: provider.clone(),
        }
    }

    fn start_provider_dispatch(&self, seeded: &SeededRun, owner: &str) -> StartedDispatch {
        let assignments = recover_agent_assignments(&self.path, WORKSPACE_ID, PROJECT_ID).unwrap();
        let report = {
            let mut journal = EventJournal::open(&self.path).unwrap();
            OperationalRecoveryScanner::new(
                &mut journal,
                &assignments,
                std::slice::from_ref(&seeded.provider),
            )
            .scan(WORKSPACE_ID, PROJECT_ID)
            .unwrap()
        };
        let run = report
            .runs
            .iter()
            .find(|run| run.run_id == seeded.run_id)
            .unwrap();
        assert_eq!(run.gate, OperationalRecoveryGate::ProviderDispatchReady);
        let operation_id = OperationalRecoveryRecordingService::new(&self.path)
            .record(WORKSPACE_ID, PROJECT_ID, &report, "2026-07-13T00:00:03Z")
            .unwrap()
            .into_iter()
            .find(|record| record.run_id == seeded.run_id)
            .unwrap()
            .operation_id;
        let lease = self.lease(owner);
        let claims = OperationalRecoveryClaimService::new(&self.path);
        let claimed = claims
            .claim_provider_dispatch_ready(
                claim_request(&seeded.run_id, &operation_id),
                std::slice::from_ref(&seeded.provider),
                &lease,
            )
            .unwrap();
        let claim = claimed.operations[&operation_id]
            .claim
            .as_ref()
            .unwrap()
            .clone();
        claims
            .start_claimed(
                OperationalRecoveryStartRequest {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    project_id: PROJECT_ID.to_owned(),
                    run_id: seeded.run_id.clone(),
                    operation_id: operation_id.clone(),
                    claim_id: claim.claim_id,
                    owner_instance_id: claim.owner_instance_id,
                    fencing_token: claim.fencing_token,
                },
                std::slice::from_ref(&seeded.provider),
                &lease,
            )
            .unwrap();
        StartedDispatch {
            operation_id,
            lease,
        }
    }

    fn attempt_state(&self, seeded: &SeededRun) -> ProviderAttemptState {
        ProviderAttemptAggregate::recover(
            &EventJournal::open(&self.path).unwrap(),
            &seeded.run_id,
            &seeded.attempt_id,
        )
        .unwrap()
        .state()
    }

    fn dispatch_outcome(
        &self,
        run_id: &str,
        operation_id: &str,
    ) -> Option<OperationalRecoveryOutcome> {
        OperationalRecoveryRepository::open(&self.path)
            .unwrap()
            .load(WORKSPACE_ID, run_id)
            .unwrap()
            .operations[operation_id]
            .outcome
            .clone()
    }

    fn loop_phase(&self, seeded: &SeededRun) -> LoopPhase {
        let mut journal = EventJournal::open(&self.path).unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .recover(&seeded.run_id, &seeded.invocation_id)
            .unwrap()
            .service
            .phase()
    }
}

struct LoopbackProvider {
    base_url: String,
    request_count: Arc<AtomicUsize>,
    stop: mpsc::Sender<()>,
    thread: std::thread::JoinHandle<()>,
}

impl LoopbackProvider {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let request_count = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&request_count);
        let (stop_tx, stop_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        observed.fetch_add(1, Ordering::SeqCst);
                        socket.set_nonblocking(false).unwrap();
                        socket
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut request = [0_u8; 65_536];
                        let length = socket.read(&mut request).unwrap();
                        let request = String::from_utf8_lossy(&request[..length]);
                        assert!(request.contains("权威正文"));
                        assert!(request.contains(&format!("Bearer {SECRET}")));
                        let body = r#"{"id":"response-1","model":"deepseek-chat","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"银湾已恢复。"}}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}"#;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        socket.write_all(response.as_bytes()).unwrap();
                        let _ = socket.shutdown(std::net::Shutdown::Both);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("loopback Provider accept failed: {error}"),
                }
            }
        });
        Self {
            base_url: format!("http://{address}/v1"),
            request_count,
            stop: stop_tx,
            thread,
        }
    }

    fn stop(self) {
        self.stop.send(()).unwrap();
        self.thread.join().unwrap();
    }
}

fn spawn_runtime() -> (Child, BufReader<std::process::ChildStdout>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_novelx-runtime"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    assert_eq!(read_envelope(&mut output).name, "runtime.hello");
    (child, output)
}

fn initialize_envelope(path: &std::path::Path) -> Envelope {
    Envelope::new(
        MessageType::Command,
        "runtime.initialize",
        "2026-07-13T00:00:00Z",
        1,
        RuntimeInitialize {
            selected_protocol_version: PROTOCOL_VERSION,
            application: RuntimeApplicationIdentity {
                id: "novelx.desktop".to_owned(),
                version: "0.2.7".to_owned(),
                commit: "provider-dispatch-recovery-handshake".to_owned(),
            },
            workspace_database_path: Some(path.to_string_lossy().into_owned()),
            project_root_path: Some(path.parent().unwrap().to_string_lossy().into_owned()),
            project_id: Some(PROJECT_ID.to_owned()),
            workspace_id: Some(WORKSPACE_ID.to_owned()),
            feature_flags: BTreeMap::new(),
            host_capability_versions: BTreeMap::new(),
        },
    )
    .unwrap()
}

fn bind_provider(
    child: &mut Child,
    output: &mut BufReader<std::process::ChildStdout>,
    sequence: u64,
    config: &ProviderConfig,
    config_sha256: &str,
) {
    write_json(
        child,
        serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "messageId": Uuid::new_v4(),
            "messageType": "sensitive_command",
            "name": "provider.bind",
            "sentAt": "2026-07-13T00:00:01Z",
            "correlationId": null,
            "runId": null,
            "sequence": sequence,
            "payload": {
                "config": config,
                "configSha256": config_sha256,
                "credential": SECRET,
            }
        }),
    );
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    if line.trim().is_empty() {
        drop(child.stdin.take());
        let mut stderr = String::new();
        child
            .stderr
            .as_mut()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        let status = child.wait().unwrap();
        panic!("Runtime exited during provider.bind: status={status}; stderr={stderr}");
    }
    let response: Envelope = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(response.name, "provider.bound");
}

fn shutdown(child: &mut Child, output: &mut BufReader<std::process::ChildStdout>, sequence: u64) {
    let shutdown = Envelope::new(
        MessageType::Command,
        "runtime.shutdown",
        "2026-07-13T00:00:02Z",
        sequence,
        serde_json::json!({}),
    )
    .unwrap();
    write_envelope(child, &shutdown);
    assert_eq!(read_envelope(output).name, "runtime.stopped");
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}

fn write_envelope(child: &mut Child, envelope: &Envelope) {
    write_json(child, serde_json::to_value(envelope).unwrap());
}

fn write_json(child: &mut Child, value: serde_json::Value) {
    let stdin = child.stdin.as_mut().unwrap();
    writeln!(stdin, "{}", serde_json::to_string(&value).unwrap()).unwrap();
    stdin.flush().unwrap();
}

fn read_envelope(output: &mut BufReader<std::process::ChildStdout>) -> Envelope {
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    serde_json::from_str(line.trim()).unwrap()
}

fn test_provider_config(base_url: String) -> ProviderConfig {
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
        request_timeout_ms: 2_000,
        total_deadline_ms: 3_000,
        retry_policy: ProviderRetryPolicy {
            max_attempts: 1,
            max_total_delay_ms: 0,
        },
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
