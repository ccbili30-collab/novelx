mod support;

use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use novelx_protocol::{
    ContextBudgetAllocation, ContextBudgetCategory, ContextCompilationReceipt, ContextDisclosure,
    ContextRepresentation, Envelope, MessageType, PROTOCOL_VERSION, ProviderRunIdentity,
    RuntimeApplicationIdentity, RuntimeInitialize, TokenizerIdentity, TokenizerKind,
    ToolPermissionPolicy, ToolSourceScope,
};
use novelx_runtime::{
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity, LoopPhase,
    },
    event_journal::{EventJournal, NewRuntimeEvent},
    operational_recovery_aggregate::{
        OperationalRecoveryEffectClass, OperationalRecoveryOperation, OperationalRecoveryOutcome,
        OperationalRecoveryRepository,
    },
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
    runtime_test_failpoint::{DIRECTORY_ENV, NAME_ENV, TOKEN_ENV},
};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use uuid::Uuid;

const SECRET: &str = "provider-recovery-killpoint-secret";
const WORKSPACE_ID: &str = "workspace-1";
const PROJECT_ID: &str = "project-1";
const EXECUTION_STARTED: &str = "provider_dispatch.execution_started";
const SENT_BEFORE_HTTP: &str = "provider_attempt.sent_before_http";
const RESPONSE_BEFORE_TERMINAL: &str = "provider_attempt.response_before_terminal";
const RECOVERY_BEFORE_HOST_RESPONSE: &str = "provider_bind.recovery_persisted_before_response";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static TEST_SERIAL: Mutex<()> = Mutex::new(());

#[test]
fn kill_after_execution_started_recovers_requested_and_sends_exactly_once() {
    let _serial = TEST_SERIAL
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let fixture = Fixture::new();
    let provider = LoopbackProvider::start();
    let configured = ConfiguredProvider::new(provider.base_url.clone());
    let seeded = fixture.seed_requested(&configured);
    let arm = fixture.arm(EXECUTION_STARTED);
    let mut crashed = RuntimeProcess::spawn(Some(&arm));
    crashed.initialize(&fixture.path);
    crashed.send_provider_bind(2, &configured);
    arm.wait_until_reached(&mut crashed);
    assert_eq!(provider.request_count.load(Ordering::SeqCst), 0);
    let _ = crashed.kill_exact();

    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Requested
    );
    assert_eq!(
        fixture.attempt_event_types(&seeded),
        vec!["provider.requested"]
    );
    let (operation_id, before) = fixture.dispatch_operation(&seeded.run_id);
    assert!(before.execution.is_some());
    assert!(before.outcome.is_none());

    let mut resumed = RuntimeProcess::spawn(None);
    resumed.initialize(&fixture.path);
    resumed.bind_provider(2, &configured);
    assert_eq!(provider.request_count.load(Ordering::SeqCst), 1);
    resumed.shutdown(3);

    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );
    assert_eq!(
        fixture.attempt_event_types(&seeded),
        vec!["provider.requested", "provider.sent", "provider.responded"]
    );
    assert!(matches!(
        fixture
            .dispatch_operation_by_id(&seeded.run_id, &operation_id)
            .outcome,
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
    assert_eq!(fixture.loop_phase(&seeded), LoopPhase::Completed);
    assert_eq!(provider.request_bodies().len(), 1);
    assert!(provider.request_bodies()[0].contains("权威正文"));
    assert!(
        provider.request_bodies()[0].contains(&format!("Bearer {SECRET}")),
        "the real loopback request must use the bound credential"
    );
}

#[test]
fn kill_after_sent_before_http_never_resends_and_closes_unknown() {
    let _serial = TEST_SERIAL
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let fixture = Fixture::new();
    let provider = LoopbackProvider::start();
    let configured = ConfiguredProvider::new(provider.base_url.clone());
    let seeded = fixture.seed_requested(&configured);
    let arm = fixture.arm(SENT_BEFORE_HTTP);
    let mut crashed = RuntimeProcess::spawn(Some(&arm));
    crashed.initialize(&fixture.path);
    crashed.send_provider_bind(2, &configured);
    arm.wait_until_reached(&mut crashed);
    assert_eq!(provider.request_count.load(Ordering::SeqCst), 0);
    let _ = crashed.kill_exact();

    assert_eq!(fixture.attempt_state(&seeded), ProviderAttemptState::Sent);
    assert_eq!(
        fixture.attempt_event_types(&seeded),
        vec!["provider.requested", "provider.sent"]
    );
    let (operation_id, before) = fixture.dispatch_operation(&seeded.run_id);
    assert!(before.execution.is_some());
    assert!(before.outcome.is_none());

    let mut resumed = RuntimeProcess::spawn(None);
    resumed.initialize(&fixture.path);
    resumed.bind_provider(2, &configured);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        provider.request_count.load(Ordering::SeqCst),
        0,
        "Sent evidence must never be automatically sent a second time"
    );
    resumed.shutdown(3);

    assert_eq!(fixture.attempt_state(&seeded), ProviderAttemptState::Sent);
    assert_eq!(
        fixture.attempt_event_types(&seeded),
        vec!["provider.requested", "provider.sent"]
    );
    assert!(matches!(
        fixture
            .dispatch_operation_by_id(&seeded.run_id, &operation_id)
            .outcome,
        Some(OperationalRecoveryOutcome::OutcomeUnknown { .. })
    ));
    assert_eq!(fixture.loop_phase(&seeded), LoopPhase::AwaitingProvider);
    assert!(provider.request_bodies().is_empty());
}

#[test]
fn kill_after_http_response_before_responded_never_resends_and_closes_unknown() {
    let _serial = TEST_SERIAL
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let fixture = Fixture::new();
    let provider = LoopbackProvider::start();
    let configured = ConfiguredProvider::new(provider.base_url.clone());
    let seeded = fixture.seed_requested(&configured);
    let arm = fixture.arm(RESPONSE_BEFORE_TERMINAL);
    let mut crashed = RuntimeProcess::spawn(Some(&arm));
    crashed.initialize(&fixture.path);
    crashed.send_provider_bind(2, &configured);
    arm.wait_until_reached(&mut crashed);
    assert_eq!(
        provider.request_count.load(Ordering::SeqCst),
        1,
        "the response failpoint must be reached only after real HTTP completed"
    );
    let _ = crashed.kill_exact();

    assert_eq!(fixture.attempt_state(&seeded), ProviderAttemptState::Sent);
    assert_eq!(
        fixture.attempt_event_types(&seeded),
        vec!["provider.requested", "provider.sent"]
    );
    let (operation_id, before) = fixture.dispatch_operation(&seeded.run_id);
    assert!(before.execution.is_some());
    assert!(before.outcome.is_none());

    let mut resumed = RuntimeProcess::spawn(None);
    resumed.initialize(&fixture.path);
    resumed.bind_provider(2, &configured);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        provider.request_count.load(Ordering::SeqCst),
        1,
        "an in-memory Provider response that was not journaled cannot authorize a resend"
    );
    resumed.shutdown(3);

    assert_eq!(fixture.attempt_state(&seeded), ProviderAttemptState::Sent);
    assert_eq!(
        fixture.attempt_event_types(&seeded),
        vec!["provider.requested", "provider.sent"]
    );
    assert!(matches!(
        fixture
            .dispatch_operation_by_id(&seeded.run_id, &operation_id)
            .outcome,
        Some(OperationalRecoveryOutcome::OutcomeUnknown { .. })
    ));
    assert_eq!(fixture.loop_phase(&seeded), LoopPhase::AwaitingProvider);
    assert_eq!(provider.request_bodies().len(), 1);
}

#[test]
fn kill_after_recovery_persisted_before_host_response_is_restart_idempotent() {
    let _serial = TEST_SERIAL
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let fixture = Fixture::new();
    let provider = LoopbackProvider::start();
    let configured = ConfiguredProvider::new(provider.base_url.clone());
    let seeded = fixture.seed_requested(&configured);
    let arm = fixture.arm(RECOVERY_BEFORE_HOST_RESPONSE);
    let mut crashed = RuntimeProcess::spawn(Some(&arm));
    crashed.initialize(&fixture.path);
    crashed.send_provider_bind(2, &configured);
    arm.wait_until_reached(&mut crashed);
    assert_eq!(provider.request_count.load(Ordering::SeqCst), 1);
    let unacknowledged = crashed.kill_exact();
    assert!(
        unacknowledged
            .iter()
            .all(|envelope| envelope.name != "provider.bound"),
        "Host must not observe provider.bound before the armed post-persistence failpoint"
    );

    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );
    assert_eq!(
        fixture.attempt_event_types(&seeded),
        vec!["provider.requested", "provider.sent", "provider.responded"]
    );
    let (operation_id, persisted) = fixture.dispatch_operation(&seeded.run_id);
    assert!(matches!(
        persisted.outcome,
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
    assert_eq!(fixture.loop_phase(&seeded), LoopPhase::Completed);

    let mut resumed = RuntimeProcess::spawn(None);
    resumed.initialize(&fixture.path);
    resumed.bind_provider(2, &configured);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        provider.request_count.load(Ordering::SeqCst),
        1,
        "lost Host acknowledgement must not repeat a completed Provider effect"
    );
    resumed.shutdown(3);

    assert!(matches!(
        fixture
            .dispatch_operation_by_id(&seeded.run_id, &operation_id)
            .outcome,
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
    assert_eq!(fixture.loop_phase(&seeded), LoopPhase::Completed);
    assert_eq!(provider.request_bodies().len(), 1);
}

struct RuntimeProcess {
    child: Child,
    output: BufReader<std::process::ChildStdout>,
    finished: bool,
}

impl RuntimeProcess {
    fn spawn(arm: Option<&FailpointArm>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_novelx-runtime"));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        if let Some(arm) = arm {
            command
                .env(NAME_ENV, arm.name)
                .env(TOKEN_ENV, arm.token.to_string())
                .env(DIRECTORY_ENV, &arm.directory);
        } else {
            command
                .env_remove(NAME_ENV)
                .env_remove(TOKEN_ENV)
                .env_remove(DIRECTORY_ENV);
        }
        let mut child = command.spawn().expect("Runtime child must spawn");
        let mut output = BufReader::new(child.stdout.take().expect("Runtime stdout must be piped"));
        let hello = read_envelope(&mut output);
        assert_eq!(hello.name, "runtime.hello");
        Self {
            child,
            output,
            finished: false,
        }
    }

    fn initialize(&mut self, database_path: &Path) {
        write_envelope(&mut self.child, &initialize_envelope(database_path));
        let ready = read_envelope(&mut self.output);
        assert_eq!(ready.name, "runtime.ready", "{:?}", ready.payload);
    }

    fn send_provider_bind(&mut self, sequence: u64, provider: &ConfiguredProvider) {
        write_json(
            &mut self.child,
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
                    "config": provider.config,
                    "configSha256": provider.config_sha256,
                    "credential": SECRET,
                }
            }),
        );
    }

    fn bind_provider(&mut self, sequence: u64, provider: &ConfiguredProvider) {
        self.send_provider_bind(sequence, provider);
        let bound = read_envelope(&mut self.output);
        assert_eq!(bound.name, "provider.bound", "{:?}", bound.payload);
    }

    fn shutdown(&mut self, sequence: u64) {
        let shutdown = Envelope::new(
            MessageType::Command,
            "runtime.shutdown",
            "2026-07-13T00:00:02Z",
            sequence,
            serde_json::json!({}),
        )
        .unwrap();
        write_envelope(&mut self.child, &shutdown);
        assert_eq!(read_envelope(&mut self.output).name, "runtime.stopped");
        drop(self.child.stdin.take());
        let status = self.child.wait().expect("Runtime shutdown must wait");
        self.finished = true;
        assert!(status.success());
    }

    fn kill_exact(&mut self) -> Vec<Envelope> {
        assert!(
            self.child
                .try_wait()
                .expect("Runtime status must be readable")
                .is_none(),
            "Runtime must still be blocked at the armed failpoint"
        );
        self.child
            .kill()
            .expect("exact Runtime child must be killed");
        let status = self
            .child
            .wait()
            .expect("killed Runtime child must be reaped");
        self.finished = true;
        assert!(!status.success());
        let mut remaining = String::new();
        self.output
            .read_to_string(&mut remaining)
            .expect("killed Runtime stdout must close");
        remaining
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("Runtime output must remain envelopes"))
            .collect()
    }

    fn unexpected_exit(&mut self, status: ExitStatus) -> ! {
        let mut stderr = String::new();
        if let Some(stream) = self.child.stderr.as_mut() {
            let _ = stream.read_to_string(&mut stderr);
        }
        self.finished = true;
        panic!("Runtime exited before failpoint marker: {status}; stderr={stderr}");
    }
}

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        match self.child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
            Err(_) => {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
        self.finished = true;
    }
}

struct FailpointArm {
    name: &'static str,
    token: Uuid,
    directory: PathBuf,
    reached_path: PathBuf,
}

impl FailpointArm {
    fn wait_until_reached(&self, runtime: &mut RuntimeProcess) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if self.reached_path.exists() {
                let marker: serde_json::Value = serde_json::from_slice(
                    &fs::read(&self.reached_path).expect("failpoint marker must be readable"),
                )
                .expect("failpoint marker must be valid JSON");
                assert_eq!(marker["name"], self.name);
                assert_eq!(marker["token"], self.token.to_string());
                assert_eq!(marker["processId"], runtime.child.id());
                return;
            }
            if let Some(status) = runtime
                .child
                .try_wait()
                .expect("Runtime status must be readable")
            {
                runtime.unexpected_exit(status);
            }
            assert!(
                Instant::now() < deadline,
                "Runtime did not reach failpoint `{}` within the deadline",
                self.name
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

struct ConfiguredProvider {
    config: ProviderConfig,
    config_sha256: String,
    identity: ProviderRunIdentity,
    registry: ProviderRegistry,
}

impl ConfiguredProvider {
    fn new(base_url: String) -> Self {
        let config = test_provider_config(base_url);
        let config_sha256 = provider_config_sha256(&config).unwrap();
        let identity = ProviderRunIdentity {
            profile_id: config.profile_id.clone(),
            provider_id: config.provider_id.clone(),
            model_id: config.model_id.clone(),
            config_sha256: config_sha256.clone(),
        };
        let mut registry = ProviderRegistry::default();
        registry
            .bind(config.clone(), &config_sha256, SECRET.to_owned())
            .unwrap();
        Self {
            config,
            config_sha256,
            identity,
            registry,
        }
    }
}

struct LoopbackProvider {
    base_url: String,
    request_count: Arc<AtomicUsize>,
    bodies: Arc<Mutex<Vec<String>>>,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl LoopbackProvider {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let request_count = Arc::new(AtomicUsize::new(0));
        let observed_count = Arc::clone(&request_count);
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let observed_bodies = Arc::clone(&bodies);
        let (stop_tx, stop_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket
                            .set_nonblocking(false)
                            .expect("accepted Provider socket must return to blocking mode");
                        observed_count.fetch_add(1, Ordering::SeqCst);
                        socket
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut request = [0_u8; 65_536];
                        let length = socket.read(&mut request).unwrap();
                        observed_bodies
                            .lock()
                            .unwrap()
                            .push(String::from_utf8_lossy(&request[..length]).into_owned());
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
            bodies,
            stop: Some(stop_tx),
            thread: Some(thread),
        }
    }

    fn request_bodies(&self) -> Vec<String> {
        self.bodies.lock().unwrap().clone()
    }
}

impl Drop for LoopbackProvider {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let joined = thread.join();
            if joined.is_err() && !std::thread::panicking() {
                panic!("loopback Provider thread failed");
            }
        }
    }
}

struct Fixture {
    temp: TempDir,
    path: PathBuf,
}

struct SeededRun {
    run_id: String,
    invocation_id: String,
    attempt_id: String,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        Self { temp, path }
    }

    fn arm(&self, name: &'static str) -> FailpointArm {
        let token = Uuid::new_v4();
        let directory = self.temp.path().join(format!("failpoint-{token}"));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(format!("armed-{token}")), name).unwrap();
        let directory = directory.canonicalize().unwrap();
        FailpointArm {
            name,
            token,
            reached_path: directory.join(format!("reached-{token}.json")),
            directory,
        }
    }

    fn seed_requested(&self, provider: &ConfiguredProvider) -> SeededRun {
        let gateway = ProviderGateway::new().unwrap();
        let run_uuid = Uuid::new_v4();
        let run_id = run_uuid.to_string();
        let invocation_id = format!("{run_id}:steward");
        let inference_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();
        let compilation_id = Uuid::new_v4();
        let receipt = compilation_receipt(compilation_id);
        let bound = provider.registry.resolve(&provider.identity).unwrap();
        let prepared = gateway
            .prepare_inference(bound, authoritative_request(receipt.clone()))
            .unwrap();
        let mut identity = pinned_identity();
        identity.provider = provider.identity.clone();
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
            provider: provider.identity.clone(),
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

    fn attempt_event_types(&self, seeded: &SeededRun) -> Vec<String> {
        EventJournal::open(&self.path)
            .unwrap()
            .read_aggregate(&seeded.run_id, "provider_attempt", &seeded.attempt_id, 0)
            .unwrap()
            .into_iter()
            .map(|event| event.event_type)
            .collect()
    }

    fn dispatch_operation(&self, run_id: &str) -> (String, OperationalRecoveryOperation) {
        let recovery = OperationalRecoveryRepository::open(&self.path)
            .unwrap()
            .load(WORKSPACE_ID, run_id)
            .unwrap();
        let matching = recovery
            .operations
            .iter()
            .filter(|(_, operation)| {
                operation.execution.as_ref().is_some_and(|execution| {
                    execution.effect_class == OperationalRecoveryEffectClass::ProviderDispatch
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(matching.len(), 1);
        (matching[0].0.clone(), matching[0].1.clone())
    }

    fn dispatch_operation_by_id(
        &self,
        run_id: &str,
        operation_id: &str,
    ) -> OperationalRecoveryOperation {
        OperationalRecoveryRepository::open(&self.path)
            .unwrap()
            .load(WORKSPACE_ID, run_id)
            .unwrap()
            .operations[operation_id]
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

fn initialize_envelope(path: &Path) -> Envelope {
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
                commit: "provider-recovery-killpoints".to_owned(),
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

fn write_envelope(child: &mut Child, envelope: &Envelope) {
    write_json(child, serde_json::to_value(envelope).unwrap());
}

fn write_json(child: &mut Child, value: serde_json::Value) {
    let stdin = child.stdin.as_mut().expect("Runtime stdin must be piped");
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
