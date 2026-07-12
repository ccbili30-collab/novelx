use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use novelx_protocol::{
    Envelope, MessageType, PROTOCOL_VERSION, RuntimeApplicationIdentity, RuntimeError,
    RuntimeErrorClass, RuntimeHello, RuntimeInitialize, RuntimeReady, RuntimeStatus,
    RuntimeStopped,
};
use novelx_runtime::event_journal::EventJournal;
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate, RunAggregateError};
use rusqlite::Connection;
use support::pinned_identity;
use tempfile::TempDir;

#[test]
fn completes_one_correlated_initialize_and_waits_for_eof() {
    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope(PROTOCOL_VERSION, "runtime.initialize");
    assert_eq!(
        initialize.payload,
        serde_json::json!({
            "selectedProtocolVersion": 1,
            "application": { "id": "novelx.desktop", "version": "0.2.7", "commit": "desktop-development" },
            "workspaceDatabasePath": null,
            "featureFlags": { "recovery": false, "runtime_v2": true },
            "hostCapabilityVersions": { "change_set": "2.0.0", "project_tools": "1.0.0" }
        })
    );
    write_envelope(&mut child, &initialize);

    let mut output = BufReader::new(child.stdout.take().expect("stdout must exist"));
    let mut ready_line = String::new();
    output
        .read_line(&mut ready_line)
        .expect("ready must be readable");
    let ready_envelope: Envelope = serde_json::from_str(ready_line.trim()).expect("ready envelope");
    assert_eq!(ready_envelope.name, "runtime.ready");
    assert_eq!(ready_envelope.message_type, MessageType::Control);
    assert_eq!(ready_envelope.correlation_id, Some(initialize.message_id));
    assert_eq!(ready_envelope.run_id, None);
    assert_eq!(ready_envelope.sequence, 2);
    assert_eq!(
        ready_envelope.payload,
        serde_json::json!({
            "selectedProtocolVersion": 1,
            "runtime": {
                "version": env!("CARGO_PKG_VERSION"),
                "build": {
                    "commit": option_env!("NOVELX_BUILD_COMMIT").unwrap_or("development"),
                    "target": option_env!("NOVELX_BUILD_TARGET").unwrap_or(std::env::consts::ARCH)
                }
            },
            "recoveredRunCount": 0
        })
    );
    let ready: RuntimeReady =
        serde_json::from_value(ready_envelope.payload).expect("ready payload");
    assert_eq!(ready.selected_protocol_version, PROTOCOL_VERSION);
    assert_eq!(ready.runtime.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(ready.recovered_run_count, 0);

    assert!(
        child.try_wait().expect("status query").is_none(),
        "runtime must wait for EOF"
    );
    drop(child.stdin.take());
    assert!(child.wait().expect("runtime exits after EOF").success());
}

#[test]
fn rejects_invalid_handshake_input_without_emitting_ready() {
    let cases = [
        "invalid_json",
        "unsupported_version",
        "wrong_name",
        "wrong_correlation",
        "wrong_sequence",
        "extra_payload",
    ];
    for case in cases {
        let (mut child, hello) = spawn_and_read_hello();
        let mut correlated_message_id = None;
        match case {
            "invalid_json" => write_line(&mut child, "not-json"),
            "unsupported_version" => {
                let envelope = initialize_envelope(PROTOCOL_VERSION + 1, "runtime.initialize");
                correlated_message_id = Some(envelope.message_id);
                write_envelope(&mut child, &envelope);
            }
            "wrong_name" => {
                let envelope = initialize_envelope(PROTOCOL_VERSION, "run.start");
                correlated_message_id = Some(envelope.message_id);
                write_envelope(&mut child, &envelope);
            }
            "wrong_correlation" => {
                let mut envelope = initialize_envelope(PROTOCOL_VERSION, "runtime.initialize");
                envelope.correlation_id = Some(hello.message_id);
                correlated_message_id = Some(envelope.message_id);
                write_envelope(&mut child, &envelope);
            }
            "wrong_sequence" => {
                let mut envelope = initialize_envelope(PROTOCOL_VERSION, "runtime.initialize");
                envelope.sequence = 2;
                correlated_message_id = Some(envelope.message_id);
                write_envelope(&mut child, &envelope);
            }
            "extra_payload" => {
                let mut envelope = initialize_envelope(PROTOCOL_VERSION, "runtime.initialize");
                envelope.payload["unexpected"] = serde_json::json!(true);
                correlated_message_id = Some(envelope.message_id);
                write_envelope(&mut child, &envelope);
            }
            _ => unreachable!(),
        }
        drop(child.stdin.take());
        let output = child.wait_with_output().expect("runtime output");
        assert!(!output.status.success(), "{case} must fail");
        let stdout = String::from_utf8(output.stdout).unwrap();
        if let Some(message_id) = correlated_message_id {
            let envelopes = stdout
                .lines()
                .map(|line| serde_json::from_str::<Envelope>(line).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(envelopes.len(), 1, "{case}");
            assert_eq!(envelopes[0].name, "runtime.error", "{case}");
            assert_eq!(envelopes[0].sequence, 2, "{case}");
            assert_eq!(envelopes[0].correlation_id, Some(message_id), "{case}");
        } else {
            assert!(stdout.is_empty(), "{case} cannot be correlated");
        }
        assert!(
            !output.stderr.is_empty(),
            "{case} must explain failure on stderr"
        );
    }
}

#[test]
fn serves_multiple_status_requests_and_shutdown_with_continuous_sequences() {
    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope(PROTOCOL_VERSION, "runtime.initialize");
    write_envelope(&mut child, &initialize);
    let ready = read_next_envelope(&mut child);
    assert_eq!(ready.sequence, 2);

    let first_status = command_envelope("runtime.status.get", 2, serde_json::json!({}));
    write_envelope(&mut child, &first_status);
    let first_response = read_next_envelope(&mut child);
    assert_response(&first_response, &first_status, "runtime.status", 3);
    let first_payload: RuntimeStatus = serde_json::from_value(first_response.payload).unwrap();
    assert!(first_payload.initialized);
    assert!(!first_payload.workspace_database_configured);
    assert_eq!(first_payload.recovered_run_count, 0);
    assert_eq!(first_payload.protocol_version, PROTOCOL_VERSION);
    assert_eq!(first_payload.runtime_version, env!("CARGO_PKG_VERSION"));

    let second_status = command_envelope("runtime.status.get", 3, serde_json::json!({}));
    write_envelope(&mut child, &second_status);
    let second_response = read_next_envelope(&mut child);
    assert_response(&second_response, &second_status, "runtime.status", 4);

    let shutdown = command_envelope("runtime.shutdown", 4, serde_json::json!({}));
    write_envelope(&mut child, &shutdown);
    let stopped = read_next_envelope(&mut child);
    assert_response(&stopped, &shutdown, "runtime.stopped", 5);
    let stopped_payload: RuntimeStopped = serde_json::from_value(stopped.payload).unwrap();
    assert_eq!(stopped_payload.reason, "requested");
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}

#[test]
fn protocol_violations_emit_correlated_runtime_error_and_fail_closed() {
    let cases = [
        "duplicate_sequence",
        "skipped_sequence",
        "unknown_command",
        "extra_payload",
        "wrong_type",
        "wrong_version",
        "unexpected_correlation",
        "unexpected_run_id",
    ];

    for case in cases {
        let (mut child, _hello) = spawn_and_read_hello();
        let initialize = initialize_envelope(PROTOCOL_VERSION, "runtime.initialize");
        write_envelope(&mut child, &initialize);
        let ready = read_next_envelope(&mut child);
        assert_eq!(ready.name, "runtime.ready");

        let mut command = command_envelope("runtime.status.get", 2, serde_json::json!({}));
        match case {
            "duplicate_sequence" => command.sequence = 1,
            "skipped_sequence" => command.sequence = 3,
            "unknown_command" => command.name = "runtime.unknown".to_owned(),
            "extra_payload" => command.payload = serde_json::json!({ "unexpected": true }),
            "wrong_type" => command.message_type = MessageType::Event,
            "wrong_version" => command.protocol_version = PROTOCOL_VERSION + 1,
            "unexpected_correlation" => command.correlation_id = Some(ready.message_id),
            "unexpected_run_id" => command.run_id = Some(uuid::Uuid::new_v4()),
            _ => unreachable!(),
        }
        write_envelope(&mut child, &command);
        let error_envelope = read_next_envelope(&mut child);
        assert_eq!(error_envelope.message_type, MessageType::Event, "{case}");
        assert_eq!(error_envelope.name, "runtime.error", "{case}");
        assert_eq!(
            error_envelope.correlation_id,
            Some(command.message_id),
            "{case}"
        );
        assert_eq!(error_envelope.run_id, None, "{case}");
        assert_eq!(error_envelope.sequence, 3, "{case}");
        let error: RuntimeError = serde_json::from_value(error_envelope.payload).unwrap();
        assert_eq!(error.code, "RUNTIME_PROTOCOL_ERROR", "{case}");
        assert_eq!(
            error.public_message, "运行时收到不符合协议的消息，已停止处理。",
            "{case}"
        );
        assert_eq!(error.class, RuntimeErrorClass::Protocol, "{case}");
        assert!(!error.retryable, "{case}");

        drop(child.stdin.take());
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success(), "{case}");
        assert!(
            output.stdout.is_empty(),
            "{case} must stop after runtime.error"
        );
        assert!(!output.stderr.is_empty(), "{case}");
    }
}

#[test]
fn initializes_an_empty_database_with_zero_recovered_runs() {
    let fixture = Fixture::new();
    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope_with_path(
        PROTOCOL_VERSION,
        "runtime.initialize",
        Some(fixture.database_path.to_string_lossy().into_owned()),
    );
    write_envelope(&mut child, &initialize);
    let ready = read_next_envelope(&mut child);
    let payload: RuntimeReady = serde_json::from_value(ready.payload).unwrap();
    assert_eq!(payload.recovered_run_count, 0);
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}

#[test]
fn reports_the_real_nonterminal_recovery_count() {
    let fixture = Fixture::new();
    {
        let mut journal = EventJournal::open(&fixture.database_path).unwrap();
        create_run(&mut journal, "created", "created");
        create_run(&mut journal, "waiting", "waiting");
        create_run(&mut journal, "committing", "committing");
        create_run(&mut journal, "completed", "completed");
    }
    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope_with_path(
        PROTOCOL_VERSION,
        "runtime.initialize",
        Some(fixture.database_path.to_string_lossy().into_owned()),
    );
    write_envelope(&mut child, &initialize);
    let ready = read_next_envelope(&mut child);
    let payload: RuntimeReady = serde_json::from_value(ready.payload).unwrap();
    assert_eq!(payload.recovered_run_count, 3);

    let status_command = command_envelope("runtime.status.get", 2, serde_json::json!({}));
    write_envelope(&mut child, &status_command);
    let status_response = read_next_envelope(&mut child);
    assert_response(&status_response, &status_command, "runtime.status", 3);
    let status: RuntimeStatus = serde_json::from_value(status_response.payload).unwrap();
    assert!(status.workspace_database_configured);
    assert_eq!(status.recovered_run_count, 3);

    let shutdown = command_envelope("runtime.shutdown", 3, serde_json::json!({}));
    write_envelope(&mut child, &shutdown);
    let stopped = read_next_envelope(&mut child);
    assert_response(&stopped, &shutdown, "runtime.stopped", 4);
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}

#[test]
fn damaged_storage_emits_initialization_failed_without_ready() {
    let fixture = Fixture::new();
    drop(EventJournal::open(&fixture.database_path).unwrap());
    let connection = Connection::open(&fixture.database_path).unwrap();
    connection
        .execute_batch("DROP TRIGGER runtime_events_no_delete;")
        .unwrap();
    drop(connection);

    let (mut child, _hello) = spawn_and_read_hello();
    let path = fixture.database_path.to_string_lossy().into_owned();
    let initialize =
        initialize_envelope_with_path(PROTOCOL_VERSION, "runtime.initialize", Some(path.clone()));
    write_envelope(&mut child, &initialize);
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    let lines = String::from_utf8(output.stdout).unwrap();
    let envelopes = lines
        .lines()
        .map(|line| serde_json::from_str::<Envelope>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(envelopes.len(), 1);
    let failure = &envelopes[0];
    assert_eq!(failure.name, "runtime.initialization_failed");
    assert_eq!(failure.message_type, MessageType::Control);
    assert_eq!(failure.sequence, 2);
    assert_eq!(failure.correlation_id, Some(initialize.message_id));
    assert_eq!(failure.run_id, None);
    let error: RuntimeError = serde_json::from_value(failure.payload.clone()).unwrap();
    assert_eq!(error.code, "RUNTIME_STORAGE_INITIALIZATION_FAILED");
    assert_eq!(error.class, RuntimeErrorClass::Storage);
    assert_eq!(error.stage, "runtime.initialize.storage");
    assert!(!error.retryable);
    assert!(!error.public_message.contains(&path));
    assert_eq!(error.public_message, "运行时初始化失败，项目数据未被修改。");
    assert!(!String::from_utf8(output.stderr).unwrap().is_empty());
    assert!(
        envelopes
            .iter()
            .all(|envelope| envelope.name != "runtime.ready")
    );
}

fn spawn_and_read_hello() -> (Child, Envelope) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_novelx-runtime"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("runtime must spawn");
    let mut hello_line = String::new();
    BufReader::new(child.stdout.as_mut().expect("stdout must exist"))
        .read_line(&mut hello_line)
        .expect("hello must be readable");
    let envelope: Envelope = serde_json::from_str(hello_line.trim()).expect("hello envelope");
    assert_eq!(envelope.name, "runtime.hello");
    let _: RuntimeHello = serde_json::from_value(envelope.payload.clone()).expect("hello payload");
    (child, envelope)
}

fn initialize_envelope(version: u16, name: &str) -> Envelope {
    initialize_envelope_with_path(version, name, None)
}

fn initialize_envelope_with_path(
    version: u16,
    name: &str,
    workspace_database_path: Option<String>,
) -> Envelope {
    let mut envelope = Envelope::new(
        MessageType::Command,
        name,
        "2026-07-12T00:00:00Z",
        1,
        RuntimeInitialize {
            selected_protocol_version: version,
            application: RuntimeApplicationIdentity {
                id: "novelx.desktop".to_owned(),
                version: "0.2.7".to_owned(),
                commit: "desktop-development".to_owned(),
            },
            workspace_database_path,
            feature_flags: BTreeMap::from([
                ("recovery".to_owned(), false),
                ("runtime_v2".to_owned(), true),
            ]),
            host_capability_versions: BTreeMap::from([
                ("change_set".to_owned(), "2.0.0".to_owned()),
                ("project_tools".to_owned(), "1.0.0".to_owned()),
            ]),
        },
    )
    .unwrap();
    envelope.protocol_version = version;
    envelope.correlation_id = None;
    envelope
}

fn command_envelope(name: &str, sequence: u64, payload: serde_json::Value) -> Envelope {
    Envelope::new(
        MessageType::Command,
        name,
        "2026-07-12T00:00:01Z",
        sequence,
        payload,
    )
    .unwrap()
}

fn assert_response(
    response: &Envelope,
    command: &Envelope,
    expected_name: &str,
    expected_sequence: u64,
) {
    assert_eq!(response.message_type, MessageType::Response);
    assert_eq!(response.name, expected_name);
    assert_eq!(response.correlation_id, Some(command.message_id));
    assert_eq!(response.run_id, None);
    assert_eq!(response.sequence, expected_sequence);
}

fn read_next_envelope(child: &mut Child) -> Envelope {
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    serde_json::from_str(line.trim()).unwrap()
}

fn create_run(journal: &mut EventJournal, run_id: &str, target: &str) {
    let created_message = format!("{run_id}-created");
    let mut run = RunAggregate::create(
        journal,
        run_id,
        pinned_identity(),
        EventMetadata {
            message_id: &created_message,
            idempotency_key: &created_message,
            created_at: "2026-07-12T00:00:00Z",
            reason: None,
        },
    )
    .unwrap();
    match target {
        "created" => {}
        "waiting" => {
            apply_step(&mut run, journal, run_id, "prepare", RunAggregate::prepare);
            apply_step(&mut run, journal, run_id, "start", RunAggregate::start);
            apply_step(
                &mut run,
                journal,
                run_id,
                "wait",
                RunAggregate::wait_for_approval,
            );
        }
        "committing" => {
            apply_step(&mut run, journal, run_id, "prepare", RunAggregate::prepare);
            apply_step(&mut run, journal, run_id, "start", RunAggregate::start);
            apply_step(
                &mut run,
                journal,
                run_id,
                "commit",
                RunAggregate::begin_commit,
            );
        }
        "completed" => {
            apply_step(&mut run, journal, run_id, "prepare", RunAggregate::prepare);
            apply_step(&mut run, journal, run_id, "start", RunAggregate::start);
            apply_step(
                &mut run,
                journal,
                run_id,
                "complete",
                RunAggregate::complete,
            );
        }
        _ => unreachable!(),
    }
}

fn apply_step(
    run: &mut RunAggregate,
    journal: &mut EventJournal,
    run_id: &str,
    suffix: &str,
    operation: fn(
        &mut RunAggregate,
        &mut EventJournal,
        EventMetadata<'_>,
    ) -> Result<(), RunAggregateError>,
) {
    let message = format!("{run_id}-{suffix}");
    operation(
        run,
        journal,
        EventMetadata {
            message_id: &message,
            idempotency_key: &message,
            created_at: "2026-07-12T00:00:01Z",
            reason: None,
        },
    )
    .unwrap();
}

struct Fixture {
    _temp: TempDir,
    database_path: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let database_path = temp.path().join("runtime.db");
        Self {
            _temp: temp,
            database_path,
        }
    }
}

fn write_envelope(child: &mut Child, envelope: &Envelope) {
    write_line(child, &serde_json::to_string(envelope).unwrap());
}

fn write_line(child: &mut Child, line: &str) {
    let stdin = child.stdin.as_mut().expect("stdin must exist");
    writeln!(stdin, "{line}").expect("stdin write");
    stdin.flush().expect("stdin flush");
}
mod support;
