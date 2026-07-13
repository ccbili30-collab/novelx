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
    ContextCompilationReceipt, ContextDisclosure, ContextItem, ContextMessageRole, Envelope,
    MessageType, PROTOCOL_VERSION, ProviderRunIdentity, RuntimeApplicationIdentity,
    RuntimeInitialize, ToolPermissionPolicy, ToolSourceScope,
};
use novelx_runtime::{
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity, LoopPhase,
    },
    context_compile_service::ContextCompileService,
    event_journal::{EventJournal, RuntimeEvent},
    operational_recovery_aggregate::{
        OperationalRecoveryEffectClass, OperationalRecoveryOperation, OperationalRecoveryOutcome,
        OperationalRecoveryRepository,
    },
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptMetadata,
        ProviderAttemptState,
    },
    provider_effect_capability::{
        OperationalRecoveryActorBinding, ProviderEffectAuthorityBinding, ProviderEffectGrantReceipt,
    },
    provider_gateway::{
        ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderGateway,
        ProviderInferenceMessage, ProviderInferenceRequest, ProviderInferenceRole,
        ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
    },
    run_aggregate::{EventMetadata, RunAggregate},
    runtime_test_failpoint::{DIRECTORY_ENV, NAME_ENV, TOKEN_ENV},
    workspace_event_journal::WorkspaceEventJournal,
};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const SECRET: &str = "provider-recovery-killpoint-secret";
const WORKSPACE_ID: &str = "workspace-1";
const PROJECT_ID: &str = "project-1";
const EXECUTION_STARTED: &str = "provider_dispatch.execution_started";
const SENT_BEFORE_HTTP: &str = "provider_attempt.authorized_sent_before_http";
const RESPONSE_BEFORE_TERMINAL: &str = "provider_attempt.authorized_response_before_terminal";
const RESPONDED_BEFORE_RECOVERY_OUTCOME: &str =
    "provider_dispatch.responded_before_recovery_outcome";
const RECOVERY_BEFORE_HOST_RESPONSE: &str = "provider_bind.recovery_persisted_before_response";
const RUNTIME_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
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
    fixture.assert_authorized_sent(&seeded);
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
    fixture.assert_authorized_sent(&seeded);
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
    fixture.assert_authorized_sent(&seeded);
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
    fixture.assert_authorized_sent(&seeded);
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
fn kill_after_responded_before_recovery_outcome_projects_success_without_resend() {
    let _serial = TEST_SERIAL
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let fixture = Fixture::new();
    let provider = LoopbackProvider::start();
    let configured = ConfiguredProvider::new(provider.base_url.clone());
    let seeded = fixture.seed_requested(&configured);
    let arm = fixture.arm(RESPONDED_BEFORE_RECOVERY_OUTCOME);
    let mut crashed = RuntimeProcess::spawn(Some(&arm));
    crashed.initialize(&fixture.path);
    crashed.send_provider_bind(2, &configured);
    arm.wait_until_reached(&mut crashed);
    assert_eq!(
        provider.request_count.load(Ordering::SeqCst),
        1,
        "Responded evidence can exist only after the real HTTP effect completed"
    );
    let _ = crashed.kill_exact();

    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );
    assert_eq!(
        fixture.attempt_event_types(&seeded),
        vec!["provider.requested", "provider.sent", "provider.responded"]
    );
    fixture.assert_authorized_sent(&seeded);
    let (operation_id, before) = fixture.dispatch_operation(&seeded.run_id);
    assert!(before.execution.is_some());
    assert!(
        before.outcome.is_none(),
        "the failpoint must precede Operational Recovery outcome persistence"
    );

    let mut resumed = RuntimeProcess::spawn(None);
    resumed.initialize(&fixture.path);
    resumed.bind_provider(2, &configured);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        provider.request_count.load(Ordering::SeqCst),
        1,
        "persisted Responded evidence must be projected without another HTTP effect"
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
    fixture.assert_authorized_sent(&seeded);
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
    output: mpsc::Receiver<RuntimeOutput>,
    output_reader: Option<std::thread::JoinHandle<()>>,
    stderr: Arc<Mutex<String>>,
    stderr_reader: Option<std::thread::JoinHandle<()>>,
    finished: bool,
}

enum RuntimeOutput {
    Envelope(Envelope),
    Closed,
    Failed(String),
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
        let stdout = child.stdout.take().expect("Runtime stdout must be piped");
        let (output_sender, output) = mpsc::channel();
        let output_reader = std::thread::spawn(move || {
            let mut output = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match output.read_line(&mut line) {
                    Ok(0) => {
                        let _ = output_sender.send(RuntimeOutput::Closed);
                        return;
                    }
                    Ok(_) => match serde_json::from_str(line.trim()) {
                        Ok(envelope) => {
                            if output_sender
                                .send(RuntimeOutput::Envelope(envelope))
                                .is_err()
                            {
                                return;
                            }
                        }
                        Err(error) => {
                            let _ = output_sender.send(RuntimeOutput::Failed(format!(
                                "Runtime stdout was not a protocol envelope: {error}; line={line:?}"
                            )));
                            return;
                        }
                    },
                    Err(error) => {
                        let _ = output_sender.send(RuntimeOutput::Failed(format!(
                            "Runtime stdout read failed: {error}"
                        )));
                        return;
                    }
                }
            }
        });
        let mut stderr_stream = child.stderr.take().expect("Runtime stderr must be piped");
        let stderr = Arc::new(Mutex::new(String::new()));
        let captured_stderr = Arc::clone(&stderr);
        let stderr_reader = std::thread::spawn(move || {
            let mut value = String::new();
            let _ = stderr_stream.read_to_string(&mut value);
            *captured_stderr
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = value;
        });
        let mut process = Self {
            child,
            output,
            output_reader: Some(output_reader),
            stderr,
            stderr_reader: Some(stderr_reader),
            finished: false,
        };
        let hello = process.read_envelope("runtime.hello");
        assert_eq!(hello.name, "runtime.hello");
        process
    }

    fn initialize(&mut self, database_path: &Path) {
        write_envelope(&mut self.child, &initialize_envelope(database_path));
        let ready = self.read_envelope("runtime.ready");
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
        let bound = self.read_envelope("provider.bound");
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
        assert_eq!(
            self.read_envelope("runtime.stopped").name,
            "runtime.stopped"
        );
        drop(self.child.stdin.take());
        let status = self.child.wait().expect("Runtime shutdown must wait");
        self.finished = true;
        self.join_readers();
        assert!(status.success());
    }

    fn read_envelope(&mut self, expected_stage: &'static str) -> Envelope {
        match self.output.recv_timeout(RUNTIME_RESPONSE_TIMEOUT) {
            Ok(RuntimeOutput::Envelope(envelope)) => envelope,
            Ok(RuntimeOutput::Closed) => {
                self.fail_and_cleanup(expected_stage, "Runtime stdout closed before the response")
            }
            Ok(RuntimeOutput::Failed(error)) => self.fail_and_cleanup(expected_stage, &error),
            Err(mpsc::RecvTimeoutError::Timeout) => self.fail_and_cleanup(
                expected_stage,
                &format!(
                    "Runtime response exceeded the {:?} hard timeout",
                    RUNTIME_RESPONSE_TIMEOUT
                ),
            ),
            Err(mpsc::RecvTimeoutError::Disconnected) => self.fail_and_cleanup(
                expected_stage,
                "Runtime stdout reader exited before the response",
            ),
        }
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
        self.join_readers();
        assert!(!status.success());
        self.remaining_envelopes()
    }

    fn unexpected_exit(&mut self, status: ExitStatus) -> ! {
        self.finished = true;
        self.join_readers();
        let stderr = self.stderr_snapshot();
        panic!("Runtime exited before failpoint marker: {status}; stderr={stderr}");
    }

    fn fail_and_cleanup(&mut self, expected_stage: &'static str, reason: &str) -> ! {
        let (status, termination_error) = match self
            .child
            .try_wait()
            .expect("Runtime status must be readable during timeout cleanup")
        {
            Some(status) => (status, None),
            None => {
                let termination_error = self.child.kill().err().map(|error| error.to_string());
                let status = self
                    .child
                    .wait()
                    .expect("timed-out Runtime child must be reaped");
                (status, termination_error)
            }
        };
        self.finished = true;
        self.join_readers();
        let stderr = self.stderr_snapshot();
        panic!(
            "Runtime failed while waiting for `{expected_stage}`: {reason}; status={status}; terminationError={termination_error:?}; stderr={stderr}"
        );
    }

    fn join_readers(&mut self) {
        if let Some(reader) = self.output_reader.take() {
            reader.join().expect("Runtime stdout reader must exit");
        }
        if let Some(reader) = self.stderr_reader.take() {
            reader.join().expect("Runtime stderr reader must exit");
        }
    }

    fn remaining_envelopes(&self) -> Vec<Envelope> {
        self.output
            .try_iter()
            .filter_map(|output| match output {
                RuntimeOutput::Envelope(envelope) => Some(envelope),
                RuntimeOutput::Closed => None,
                RuntimeOutput::Failed(error) => {
                    panic!("Runtime stdout failed after process termination: {error}")
                }
            })
            .collect()
    }

    fn stderr_snapshot(&self) -> String {
        self.stderr
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
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
        if let Some(reader) = self.output_reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
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
        let bound = provider.registry.resolve(&provider.identity).unwrap();
        let mut identity = pinned_identity();
        identity.provider = provider.identity.clone();
        let context_policy = identity.context_policy.clone();
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
        let receipt = ContextCompileService::new(&mut journal, &provider.registry)
            .compile(
                run_uuid,
                Uuid::new_v4(),
                context_command(
                    &invocation_id,
                    provider.identity.clone(),
                    context_policy,
                    bound.config(),
                ),
            )
            .unwrap();
        let compilation_id = receipt.compilation_id;
        let prepared = gateway
            .prepare_inference(bound, authoritative_request(receipt.clone()))
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
        let requested_at = OffsetDateTime::now_utc().format(&Rfc3339).unwrap();
        let inference_idempotency_key = format!("{run_id}:inference:1");
        ProviderAttemptAggregate::create(
            &mut journal,
            &run_id,
            &attempt_id,
            definition,
            sequence,
            ProviderAttemptMetadata {
                message_id: "provider-requested",
                idempotency_key: &inference_idempotency_key,
                created_at: &requested_at,
                reason: None,
            },
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
        self.attempt_events(seeded)
            .into_iter()
            .map(|event| event.event_type)
            .collect()
    }

    fn attempt_events(&self, seeded: &SeededRun) -> Vec<RuntimeEvent> {
        EventJournal::open(&self.path)
            .unwrap()
            .read_aggregate(&seeded.run_id, "provider_attempt", &seeded.attempt_id, 0)
            .unwrap()
    }

    fn assert_authorized_sent(&self, seeded: &SeededRun) {
        let sent = self
            .attempt_events(seeded)
            .into_iter()
            .find(|event| event.event_type == "provider.sent")
            .expect("authorized recovery dispatch must persist provider.sent");
        assert_eq!(
            sent.event_version, 2,
            "recovery must use authorized Sent v2"
        );
        let grant: ProviderEffectGrantReceipt =
            serde_json::from_value(sent.payload["grant"].clone()).unwrap();
        grant.validate().unwrap();
        assert_eq!(grant.material().workspace_id, WORKSPACE_ID);
        assert_eq!(grant.material().project_id, PROJECT_ID);
        assert_eq!(grant.material().run_id.to_string(), seeded.run_id);
        assert_eq!(grant.material().attempt_id.to_string(), seeded.attempt_id);
        let ProviderEffectAuthorityBinding::OperationalRecovery(authority) =
            &grant.material().authority
        else {
            panic!("recovery dispatch used a non-recovery Provider effect grant");
        };
        let (expected_operation_id, operation) = self.dispatch_operation(&seeded.run_id);
        assert_eq!(authority.operation_id, expected_operation_id);
        let claim = operation
            .claim
            .as_ref()
            .expect("grant operation must retain its claim");
        let execution = operation
            .execution
            .as_ref()
            .expect("grant operation must retain its execution");
        assert_eq!(authority.operation_id, operation.observation.operation_id);
        assert_eq!(authority.claim_id, claim.claim_id);
        assert_eq!(authority.execution_id, execution.execution_id);
        assert_eq!(authority.fencing_token, claim.fencing_token);
        assert_eq!(authority.fencing_token, execution.fencing_token);
        assert_eq!(authority.action_spec_sha256, claim.action_spec_sha256);
        let action = claim
            .action_spec
            .as_ref()
            .expect("Provider recovery claim must retain its action");
        assert_eq!(
            authority.action_spec_sha256,
            action.action_spec_sha256().unwrap()
        );
        let recovery_event = WorkspaceEventJournal::open(&self.path)
            .unwrap()
            .read_stream(
                WORKSPACE_ID,
                "operational_recovery",
                &format!("run:{}", seeded.run_id),
                0,
            )
            .unwrap()
            .into_iter()
            .find(|event| event.stream_sequence == authority.recovery_stream_sequence)
            .expect("grant recovery revision must exist in the authoritative stream");
        assert_eq!(
            recovery_event.payload["aggregate_revision"].as_u64(),
            Some(authority.recovery_stream_sequence)
        );
        assert_eq!(
            recovery_event.payload["event_hash"].as_str(),
            Some(authority.recovery_last_event_sha256.as_str())
        );
        match &authority.actor {
            OperationalRecoveryActorBinding::OriginalOwner {
                owner_lease_epoch,
                execution_started_at,
            } => {
                assert_eq!(owner_lease_epoch, &grant.material().lease_epoch);
                assert_eq!(execution_started_at, &execution.started_at);
            }
            OperationalRecoveryActorBinding::ResumeAuthorized {
                resumer_lease_epoch,
                authorization_id,
                authorization_sha256,
                authorization_generation,
                authorized_at,
            } => {
                let authorization = operation
                    .latest_provider_dispatch_resume()
                    .expect("resumed recovery grant must retain its authorization");
                assert_eq!(resumer_lease_epoch, &grant.material().lease_epoch);
                assert_eq!(authorization_id, &authorization.authorization_id);
                assert_eq!(
                    authorization_sha256,
                    &canonical_json_sha256(serde_json::to_value(authorization).unwrap())
                );
                assert_eq!(
                    *authorization_generation,
                    authorization.authorization_generation
                );
                assert_eq!(authorized_at, &authorization.authorized_at);
            }
        }
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
        total_deadline_ms: 60_000,
        retry_policy: ProviderRetryPolicy {
            max_attempts: 1,
            max_total_delay_ms: 0,
        },
    }
}

fn context_command(
    invocation_id: &str,
    provider: ProviderRunIdentity,
    context_policy: novelx_protocol::VersionedPolicyIdentity,
    config: &ProviderConfig,
) -> novelx_protocol::ContextCompile {
    let content = "权威正文";
    novelx_protocol::ContextCompile {
        compile_idempotency_key: "context-key-1".to_owned(),
        invocation_id: invocation_id.to_owned(),
        request_number: 1,
        provider,
        context_policy,
        compiler_version: "1.0.0".to_owned(),
        context_window: config.context_window,
        configured_max_output_tokens: config.max_tokens,
        safety_reserve_tokens: 6_400,
        items: vec![
            ContextItem::SessionMessage {
                item_id: "current-user-turn".to_owned(),
                message_id: "current-user-message".to_owned(),
                role: ContextMessageRole::User,
                content: content.to_owned(),
                content_sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
                created_at: "2026-07-13T00:00:00Z".to_owned(),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            ContextItem::OutputReserve {
                item_id: "output-reserve".to_owned(),
                requested_tokens: config.max_tokens.unwrap_or(8_000),
                policy_id: "auto".to_owned(),
                disclosure: ContextDisclosure::AgentInternal,
            },
        ],
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

fn current_run_sequence(journal: &EventJournal, run_id: &str) -> u64 {
    journal
        .read_run(run_id, 0)
        .unwrap()
        .last()
        .map_or(0, |event| event.run_sequence)
}

fn canonical_json_sha256(value: serde_json::Value) -> String {
    fn canonicalize(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(canonicalize).collect())
            }
            serde_json::Value::Object(values) => {
                let mut entries = values.into_iter().collect::<Vec<_>>();
                entries.sort_by(|left, right| left.0.cmp(&right.0));
                serde_json::Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key, canonicalize(value)))
                        .collect(),
                )
            }
            scalar => scalar,
        }
    }
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonicalize(value)).unwrap())
    )
}
