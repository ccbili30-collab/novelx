mod support;

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;

use novelx_protocol::{
    ContextBudgetAllocation, ContextBudgetCategory, ContextCompilationReceipt, ContextCompile,
    ContextDisclosure, ContextRepresentation, Envelope, MessageType, PROTOCOL_VERSION,
    ProviderInferenceAccepted, ProviderInferenceCompleted, ProviderInferenceStart, RunCancel,
    RunLifecycleState, RunReconcile, RunReconciliationDecision, RunReconciliationReceipt,
    RunSnapshot, RuntimeApplicationIdentity, RuntimeError, RuntimeInitialize, RuntimeStatus,
    TokenizerIdentity, TokenizerKind,
};
use novelx_runtime::event_journal::{EventJournal, NewRuntimeEvent};
use novelx_runtime::provider_gateway::{
    ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderInputCapability,
    ProviderRetryPolicy, provider_config_sha256,
};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate};
use novelx_runtime::run_state::RunState;
use novelx_runtime::{
    agent_loop_journal::AgentLoopJournalRepository, agent_loop_service::LoopPhase,
};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use uuid::Uuid;

const SECRET: &str = "runtime-inference-loopback-secret";

#[test]
fn real_provider_inference_accepts_before_completion_and_does_not_block_status() {
    let fixture = Fixture::new();
    let (config, config_hash, release, request_received, _, server) = loopback_provider();
    let (run_id, receipt) = fixture.seed(&config, &config_hash);
    let (mut child, mut output) = spawn_runtime();

    let initialize = initialize_envelope(&fixture.path);
    write_envelope(&mut child, &initialize);
    assert_eq!(read_envelope(&mut output).name, "runtime.ready");

    let bind_id = Uuid::new_v4();
    write_json(
        &mut child,
        serde_json::json!({
            "protocolVersion": 1,
            "messageId": bind_id,
            "messageType": "sensitive_command",
            "name": "provider.bind",
            "sentAt": "2026-07-12T00:00:01Z",
            "correlationId": null,
            "runId": null,
            "sequence": 2,
            "payload": {
                "config": config,
                "configSha256": config_hash,
                "credential": SECRET,
            }
        }),
    );
    let bound = read_envelope(&mut output);
    assert_eq!(bound.name, "provider.bound");
    assert_eq!(bound.sequence, 3);

    let start_payload = ProviderInferenceStart {
        inference_id: Uuid::new_v4(),
        attempt_id: Uuid::new_v4(),
        invocation_id: format!("{run_id}:steward"),
        context_compilation_id: receipt.compilation_id,
        request_number: receipt.request_number,
        attempt_number: 1,
        inference_idempotency_key: "runtime-inference-key-1".to_owned(),
    };
    let mut start = command("provider.inference.start", 3, &start_payload);
    start.run_id = Some(run_id);
    write_envelope(&mut child, &start);
    let accepted = read_envelope(&mut output);
    assert_eq!(accepted.name, "provider.inference.accepted");
    assert_eq!(accepted.sequence, 4);
    assert_eq!(accepted.correlation_id, Some(start.message_id));
    let accepted_payload: ProviderInferenceAccepted =
        serde_json::from_value(accepted.payload).unwrap();
    assert_eq!(
        accepted_payload.context_compilation_id,
        receipt.compilation_id
    );

    request_received.recv().unwrap();
    let status = command("runtime.status.get", 4, &serde_json::json!({}));
    write_envelope(&mut child, &status);
    let status_response = read_envelope(&mut output);
    assert_eq!(status_response.name, "runtime.status");
    assert_eq!(status_response.sequence, 5);
    let _: RuntimeStatus = serde_json::from_value(status_response.payload).unwrap();

    release.send(()).unwrap();
    let completed = read_envelope(&mut output);
    assert_eq!(completed.name, "provider.inference.completed");
    assert_eq!(completed.message_type, MessageType::Event);
    assert_eq!(completed.sequence, 6);
    assert_eq!(completed.correlation_id, Some(start.message_id));
    let completed_payload: ProviderInferenceCompleted =
        serde_json::from_value(completed.payload).unwrap();
    completed_payload.validate().unwrap();
    assert_eq!(
        completed_payload.output.as_ref().unwrap().text,
        "银湾继续向前。"
    );

    let shutdown = command("runtime.shutdown", 5, &serde_json::json!({}));
    write_envelope(&mut child, &shutdown);
    assert_eq!(read_envelope(&mut output).sequence, 7);
    assert!(child.wait().unwrap().success());
    server.join().unwrap();

    let journal = EventJournal::open(&fixture.path).unwrap();
    assert_eq!(
        RunAggregate::recover(&journal, &run_id.to_string())
            .unwrap()
            .state(),
        RunState::Running
    );
    let attempt_events = journal
        .read_aggregate(
            &run_id.to_string(),
            "provider_attempt",
            &start_payload.attempt_id.to_string(),
            0,
        )
        .unwrap();
    assert_eq!(
        attempt_events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["provider.requested", "provider.sent", "provider.responded"]
    );
    assert_eq!(attempt_events[1].event_version, 2);
    assert_eq!(
        attempt_events[1].payload["grant"]["material"]["authority"]["kind"],
        "initial_agent_loop"
    );
    let mut loop_journal = EventJournal::open(&fixture.path).unwrap();
    let persisted_loop = AgentLoopJournalRepository::new(&mut loop_journal)
        .recover(&run_id.to_string(), &start_payload.invocation_id)
        .unwrap();
    assert_eq!(persisted_loop.service.phase(), LoopPhase::Completed);
    assert!(!format!("{:?}", journal.read_run(&run_id.to_string(), 0).unwrap()).contains(SECRET));
}

#[test]
fn missing_compilation_is_a_correlated_pre_accept_runtime_error() {
    let fixture = Fixture::new();
    let run_id = fixture.seed_run_only();
    let (mut child, mut output) = spawn_runtime();
    write_envelope(&mut child, &initialize_envelope(&fixture.path));
    assert_eq!(read_envelope(&mut output).name, "runtime.ready");
    let payload = ProviderInferenceStart {
        inference_id: Uuid::new_v4(),
        attempt_id: Uuid::new_v4(),
        invocation_id: format!("{run_id}:steward"),
        context_compilation_id: Uuid::new_v4(),
        request_number: 1,
        attempt_number: 1,
        inference_idempotency_key: "missing-context-key".to_owned(),
    };
    let mut start = command("provider.inference.start", 2, &payload);
    start.run_id = Some(run_id);
    write_envelope(&mut child, &start);
    let rejected = read_envelope(&mut output);
    assert_eq!(rejected.name, "runtime.error");
    assert_eq!(rejected.correlation_id, Some(start.message_id));
    assert_eq!(rejected.run_id, Some(run_id));
    let error: RuntimeError = serde_json::from_value(rejected.payload).unwrap();
    assert_eq!(error.code, "CONTEXT_RECEIPT_NOT_PERSISTED");
    let status = command("runtime.status.get", 3, &serde_json::json!({}));
    write_envelope(&mut child, &status);
    assert_eq!(read_envelope(&mut output).name, "runtime.status");
    let shutdown = command("runtime.shutdown", 4, &serde_json::json!({}));
    write_envelope(&mut child, &shutdown);
    assert_eq!(read_envelope(&mut output).name, "runtime.stopped");
    assert!(child.wait().unwrap().success());
}

#[test]
fn missing_in_memory_provider_binding_is_rejected_without_stopping_runtime() {
    let fixture = Fixture::new();
    let config = test_provider_config("http://127.0.0.1:9/v1".to_owned());
    let config_hash = provider_config_sha256(&config).unwrap();
    let (run_id, receipt) = fixture.seed(&config, &config_hash);
    let (mut child, mut output) = spawn_runtime();
    write_envelope(&mut child, &initialize_envelope(&fixture.path));
    assert_eq!(read_envelope(&mut output).name, "runtime.ready");
    let payload = ProviderInferenceStart {
        inference_id: Uuid::new_v4(),
        attempt_id: Uuid::new_v4(),
        invocation_id: format!("{run_id}:steward"),
        context_compilation_id: receipt.compilation_id,
        request_number: receipt.request_number,
        attempt_number: 1,
        inference_idempotency_key: "missing-provider-key".to_owned(),
    };
    let mut start = command("provider.inference.start", 2, &payload);
    start.run_id = Some(run_id);
    write_envelope(&mut child, &start);
    let rejected = read_envelope(&mut output);
    assert_eq!(rejected.name, "runtime.error");
    let error: RuntimeError = serde_json::from_value(rejected.payload).unwrap();
    assert_eq!(error.code, "PROVIDER_AUTH_REJECTED");
    let status = command("runtime.status.get", 3, &serde_json::json!({}));
    write_envelope(&mut child, &status);
    assert_eq!(read_envelope(&mut output).name, "runtime.status");
    let shutdown = command("runtime.shutdown", 4, &serde_json::json!({}));
    write_envelope(&mut child, &shutdown);
    assert_eq!(read_envelope(&mut output).name, "runtime.stopped");
    assert!(child.wait().unwrap().success());
}

#[test]
fn cancelling_a_run_while_http_is_pending_prevents_completed_output() {
    let fixture = Fixture::new();
    let (config, config_hash, release, request_received, connection_closed, server) =
        loopback_provider();
    let (run_id, receipt) = fixture.seed(&config, &config_hash);
    let (mut child, mut output) = spawn_runtime();
    write_envelope(&mut child, &initialize_envelope(&fixture.path));
    assert_eq!(read_envelope(&mut output).name, "runtime.ready");
    bind_provider(&mut child, &mut output, 2, &config, &config_hash);
    let payload = ProviderInferenceStart {
        inference_id: Uuid::new_v4(),
        attempt_id: Uuid::new_v4(),
        invocation_id: format!("{run_id}:steward"),
        context_compilation_id: receipt.compilation_id,
        request_number: receipt.request_number,
        attempt_number: 1,
        inference_idempotency_key: "cancel-race-key".to_owned(),
    };
    let mut start = command("provider.inference.start", 3, &payload);
    start.run_id = Some(run_id);
    write_envelope(&mut child, &start);
    assert_eq!(
        read_envelope(&mut output).name,
        "provider.inference.accepted"
    );
    request_received.recv().unwrap();
    let mut cancel = command(
        "run.cancel",
        4,
        &RunCancel {
            cancel_idempotency_key: "cancel-inference-run".to_owned(),
            reason: "user requested cancellation".to_owned(),
        },
    );
    cancel.run_id = Some(run_id);
    write_envelope(&mut child, &cancel);
    let cancelled: RunSnapshot =
        serde_json::from_value(read_envelope(&mut output).payload).unwrap();
    assert_eq!(cancelled.state, RunLifecycleState::WaitingForReconciliation);
    release.send(()).unwrap();
    let terminal = read_envelope(&mut output);
    assert_eq!(terminal.name, "provider.inference.reconciliation_required");
    assert!(connection_closed.recv().unwrap());
    let mut reconcile = command(
        "run.reconcile",
        5,
        &RunReconcile {
            reconciliation_idempotency_key: "reconcile-cancelled-inference".to_owned(),
            attempt_id: payload.attempt_id,
            decision: RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate,
            duplicate_execution_acknowledged: true,
        },
    );
    reconcile.run_id = Some(run_id);
    write_envelope(&mut child, &reconcile);
    let reconciled = read_envelope(&mut output);
    assert_eq!(reconciled.name, "run.reconciled");
    let receipt: RunReconciliationReceipt = serde_json::from_value(reconciled.payload).unwrap();
    assert_eq!(receipt.state, RunLifecycleState::Retrying);
    let mut get = command("run.get", 6, &serde_json::json!({}));
    get.run_id = Some(run_id);
    write_envelope(&mut child, &get);
    let retried: RunSnapshot = serde_json::from_value(read_envelope(&mut output).payload).unwrap();
    assert_eq!(retried.state, RunLifecycleState::Retrying);
    let shutdown = command("runtime.shutdown", 7, &serde_json::json!({}));
    write_envelope(&mut child, &shutdown);
    assert_eq!(read_envelope(&mut output).name, "runtime.stopped");
    assert!(child.wait().unwrap().success());
    server.join().unwrap();
    let journal = EventJournal::open(&fixture.path).unwrap();
    assert_eq!(
        RunAggregate::recover(&journal, &run_id.to_string())
            .unwrap()
            .state(),
        RunState::Retrying
    );
    assert_eq!(
        journal
            .read_aggregate(
                &run_id.to_string(),
                "provider_attempt",
                &payload.attempt_id.to_string(),
                0,
            )
            .unwrap()
            .last()
            .unwrap()
            .event_type,
        "provider.outcome_unknown"
    );
    let cancellation_event = journal
        .read_aggregate(&run_id.to_string(), "run", &run_id.to_string(), 0)
        .unwrap()
        .into_iter()
        .find(|event| event.event_type == "run.cancellation_requested")
        .unwrap();
    assert_eq!(
        cancellation_event.payload["cancellationReason"],
        "user requested cancellation"
    );
    assert_eq!(
        cancellation_event.payload["attemptIds"][0],
        payload.attempt_id.to_string()
    );
}

fn bind_provider(
    child: &mut Child,
    output: &mut BufReader<std::process::ChildStdout>,
    sequence: u64,
    config: &ProviderConfig,
    config_hash: &str,
) {
    write_json(
        child,
        serde_json::json!({
            "protocolVersion": 1,
            "messageId": Uuid::new_v4(),
            "messageType": "sensitive_command",
            "name": "provider.bind",
            "sentAt": "2026-07-12T00:00:01Z",
            "correlationId": null,
            "runId": null,
            "sequence": sequence,
            "payload": { "config": config, "configSha256": config_hash, "credential": SECRET }
        }),
    );
    assert_eq!(read_envelope(output).name, "provider.bound");
}

fn loopback_provider() -> (
    ProviderConfig,
    String,
    mpsc::Sender<()>,
    mpsc::Receiver<()>,
    mpsc::Receiver<bool>,
    std::thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (release_tx, release_rx) = mpsc::channel();
    let (received_tx, received_rx) = mpsc::channel();
    let (closed_tx, closed_rx) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0_u8; 65_536];
        let length = socket.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..length]);
        assert!(request.contains("权威正文"));
        assert!(request.contains(&format!("Bearer {SECRET}")));
        received_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_millis(300)))
            .unwrap();
        let mut probe = [0_u8; 1];
        match socket.read(&mut probe) {
            Ok(0) => {
                let _ = closed_tx.send(true);
                return;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Ok(_) | Err(_) => {}
        }
        let _ = closed_tx.send(false);
        let body = r#"{"id":"response-1","model":"deepseek-chat","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"银湾继续向前。"}}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).unwrap();
    });
    let config = test_provider_config(format!("http://{address}/v1"));
    let hash = provider_config_sha256(&config).unwrap();
    (config, hash, release_tx, received_rx, closed_rx, server)
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
        "2026-07-12T00:00:00Z",
        1,
        RuntimeInitialize {
            selected_protocol_version: PROTOCOL_VERSION,
            application: RuntimeApplicationIdentity {
                id: "novelx.desktop".to_owned(),
                version: "0.2.7".to_owned(),
                commit: "provider-inference-handshake".to_owned(),
            },
            workspace_database_path: Some(path.to_string_lossy().into_owned()),
            project_root_path: Some(path.parent().unwrap().to_string_lossy().into_owned()),
            project_id: Some("project-1".to_owned()),
            workspace_id: Some("workspace-1".to_owned()),
            feature_flags: BTreeMap::new(),
            host_capability_versions: BTreeMap::new(),
        },
    )
    .unwrap()
}

fn command(name: &str, sequence: u64, payload: &impl serde::Serialize) -> Envelope {
    Envelope::new(
        MessageType::Command,
        name,
        "2026-07-12T00:00:01Z",
        sequence,
        payload,
    )
    .unwrap()
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

fn receipt() -> ContextCompilationReceipt {
    ContextCompilationReceipt {
        compilation_id: Uuid::new_v4(),
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
        serialized_input_bytes: 128,
        estimated_input_tokens: 32,
        exact_input_tokens: None,
        context_window: 64_000,
        safety_reserve_tokens: 6_400,
        output_reserve_tokens: 8_000,
        available_input_tokens: 49_600,
        accepted: true,
        budget: vec![ContextBudgetAllocation {
            category: ContextBudgetCategory::SessionHistory,
            estimated_tokens: 32,
        }],
        included_item_ids: vec!["current-user-turn".to_owned()],
        omitted_item_ids: vec![],
        incomplete: false,
        disclosure: ContextDisclosure::AgentInternal,
    }
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

    fn seed(
        &self,
        config: &ProviderConfig,
        config_hash: &str,
    ) -> (Uuid, ContextCompilationReceipt) {
        let run_id = Uuid::new_v4();
        let mut identity = pinned_identity();
        identity.provider.config_sha256 = config_hash.to_owned();
        let source_command = ContextCompile {
            compile_idempotency_key: "context-key-1".to_owned(),
            invocation_id: format!("{run_id}:steward"),
            request_number: 1,
            provider: identity.provider.clone(),
            context_policy: identity.context_policy.clone(),
            compiler_version: "1.0.0".to_owned(),
            context_window: config.context_window,
            configured_max_output_tokens: config.max_tokens,
            safety_reserve_tokens: 6_400,
            items: vec![],
        };
        let mut journal = EventJournal::open(&self.path).unwrap();
        let mut run = RunAggregate::create(
            &mut journal,
            &run_id.to_string(),
            identity,
            EventMetadata {
                message_id: "run-created",
                idempotency_key: "run-created",
                created_at: "2026-07-12T00:00:00Z",
                reason: None,
            },
        )
        .unwrap();
        run.prepare(
            &mut journal,
            EventMetadata {
                message_id: "run-preparing",
                idempotency_key: "run-preparing",
                created_at: "2026-07-12T00:00:01Z",
                reason: None,
            },
        )
        .unwrap();
        let receipt = receipt();
        let normalized = serde_json::json!({
            "messages": [{"role": "user", "content": "权威正文"}],
            "tools": [],
        });
        let normalized_hash = format!(
            "{:x}",
            Sha256::digest(
                r#"{"messages":[{"role":"user","content":"权威正文"}],"tools":[]}"#.as_bytes()
            )
        );
        journal
            .append(
                NewRuntimeEvent {
                    run_id: run_id.to_string(),
                    aggregate_type: "context".to_owned(),
                    aggregate_id: "inference-context-1".to_owned(),
                    message_id: "context-message-1".to_owned(),
                    idempotency_key: "context-key-1".to_owned(),
                    event_type: "context.compiled".to_owned(),
                    event_version: 1,
                    payload: serde_json::json!({
                        "requestSha256": "9".repeat(64),
                        "receipt": receipt,
                        "sourceCommand": source_command,
                        "normalizedInput": normalized,
                        "normalizedInputSha256": normalized_hash,
                    }),
                    created_at: "2026-07-12T00:00:02Z".to_owned(),
                },
                2,
                0,
            )
            .unwrap();
        assert_eq!(config.profile_id, "profile-1");
        (run_id, receipt)
    }

    fn seed_run_only(&self) -> Uuid {
        let run_id = Uuid::new_v4();
        let mut journal = EventJournal::open(&self.path).unwrap();
        let mut run = RunAggregate::create(
            &mut journal,
            &run_id.to_string(),
            pinned_identity(),
            EventMetadata {
                message_id: "run-only-created",
                idempotency_key: "run-only-created",
                created_at: "2026-07-12T00:00:00Z",
                reason: None,
            },
        )
        .unwrap();
        run.prepare(
            &mut journal,
            EventMetadata {
                message_id: "run-only-preparing",
                idempotency_key: "run-only-preparing",
                created_at: "2026-07-12T00:00:01Z",
                reason: None,
            },
        )
        .unwrap();
        run_id
    }
}
