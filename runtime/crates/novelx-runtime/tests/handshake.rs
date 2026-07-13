use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use novelx_protocol::{
    ChildRunSpec, Envelope, MessageType, PROTOCOL_VERSION, RevisionReference, RunPrepare,
    RunSnapshot, RunStart, RuntimeApplicationIdentity, RuntimeError, RuntimeErrorClass,
    RuntimeHello, RuntimeInitialize, RuntimeReady, RuntimeStatus, RuntimeStopped,
    child_run_pinned_identity_sha256,
};
use novelx_runtime::agent_assignment_aggregate::{
    AgentAssignmentAggregate, AgentAssignmentIdentity, AgentAssignmentRepository,
    AssignmentDefinition, AssignmentEventMetadata, AssignmentScope, ChildAgentPermission,
    RevisionBinding,
};
use novelx_runtime::event_journal::EventJournal;
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate, RunAggregateError};
use novelx_runtime::workspace_event_journal::{NewWorkspaceEvent, WorkspaceEventJournal};
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};
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
            "projectRootPath": null,
            "projectId": null,
            "workspaceId": null,
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
        "missing_project_root",
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
            "missing_project_root" => {
                let temp = tempfile::tempdir().unwrap();
                let mut envelope = initialize_envelope_with_path(
                    PROTOCOL_VERSION,
                    "runtime.initialize",
                    Some(
                        temp.path()
                            .join("runtime.db")
                            .to_string_lossy()
                            .into_owned(),
                    ),
                );
                envelope.payload["projectRootPath"] = serde_json::Value::Null;
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
fn ordered_dispatcher_finishes_an_earlier_status_before_pipelined_shutdown() {
    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope(PROTOCOL_VERSION, "runtime.initialize");
    write_envelope(&mut child, &initialize);
    assert_eq!(read_next_envelope(&mut child).name, "runtime.ready");

    let status = command_envelope("runtime.status.get", 2, serde_json::json!({}));
    let shutdown = command_envelope("runtime.shutdown", 3, serde_json::json!({}));
    write_envelope(&mut child, &status);
    write_envelope(&mut child, &shutdown);

    assert_response(
        &read_next_envelope(&mut child),
        &status,
        "runtime.status",
        3,
    );
    assert_response(
        &read_next_envelope(&mut child),
        &shutdown,
        "runtime.stopped",
        4,
    );
    assert!(child.wait().unwrap().success());
}

#[test]
fn persists_gets_and_idempotently_retries_a_run_over_the_real_protocol() {
    let fixture = Fixture::new();
    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope_with_path(
        PROTOCOL_VERSION,
        "runtime.initialize",
        Some(fixture.database_path.to_string_lossy().into_owned()),
    );
    write_envelope(&mut child, &initialize);
    assert_eq!(read_next_envelope(&mut child).name, "runtime.ready");

    let run_id = uuid::Uuid::new_v4();
    let start_payload = RunStart {
        start_idempotency_key: "stable-start-1".to_owned(),
        pinned_identity: pinned_identity(),
    };
    let mut start = command_envelope(
        "run.start",
        2,
        serde_json::to_value(&start_payload).unwrap(),
    );
    start.run_id = Some(run_id);
    write_envelope(&mut child, &start);
    let started = read_next_envelope(&mut child);
    assert_response(&started, &start, "run.snapshot", 3);
    assert_eq!(started.run_id, Some(run_id));
    let started_snapshot: RunSnapshot = serde_json::from_value(started.payload).unwrap();
    assert_eq!(started_snapshot.run_id, run_id);
    assert_eq!(started_snapshot.aggregate_sequence, 1);
    assert_eq!(started_snapshot.pinned_identity, pinned_identity());

    let mut get = command_envelope("run.get", 3, serde_json::json!({}));
    get.run_id = Some(run_id);
    write_envelope(&mut child, &get);
    let fetched = read_next_envelope(&mut child);
    assert_response(&fetched, &get, "run.snapshot", 4);
    let fetched_snapshot: RunSnapshot = serde_json::from_value(fetched.payload).unwrap();
    assert_eq!(fetched_snapshot, started_snapshot);

    let mut retry = command_envelope("run.start", 4, serde_json::to_value(start_payload).unwrap());
    retry.run_id = Some(run_id);
    write_envelope(&mut child, &retry);
    let retried = read_next_envelope(&mut child);
    assert_response(&retried, &retry, "run.snapshot", 5);
    assert_eq!(
        serde_json::from_value::<RunSnapshot>(retried.payload).unwrap(),
        started_snapshot
    );

    let shutdown = command_envelope("runtime.shutdown", 5, serde_json::json!({}));
    write_envelope(&mut child, &shutdown);
    assert_response(
        &read_next_envelope(&mut child),
        &shutdown,
        "runtime.stopped",
        6,
    );
    assert!(child.wait().unwrap().success());

    let journal = EventJournal::open(&fixture.database_path).unwrap();
    assert_eq!(journal.read_run(&run_id.to_string(), 0).unwrap().len(), 1);
}

#[test]
fn binds_a_sensitive_provider_without_echoing_the_credential() {
    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope(PROTOCOL_VERSION, "runtime.initialize");
    write_envelope(&mut child, &initialize);
    assert_eq!(read_next_envelope(&mut child).name, "runtime.ready");

    let secret = "runtime-sensitive-provider-key";
    let message_id = uuid::Uuid::new_v4();
    write_line(
        &mut child,
        &serde_json::json!({
            "protocolVersion": 1,
            "messageId": message_id,
            "messageType": "sensitive_command",
            "name": "provider.bind",
            "sentAt": "2026-07-12T00:00:10Z",
            "correlationId": null,
            "runId": null,
            "sequence": 2,
            "payload": {
                "config": {
                    "schemaVersion": 1,
                    "profileId": "profile-1",
                    "providerId": "deepseek",
                    "displayName": "DeepSeek",
                    "baseUrl": "https://api.deepseek.com/v1",
                    "modelId": "deepseek-chat",
                    "apiFlavor": "open_ai_chat_completions",
                    "authScheme": "bearer",
                    "contextWindow": 1000000,
                    "maxTokens": null,
                    "reasoning": false,
                    "input": ["text"],
                    "requestTimeoutMs": 30000,
                    "totalDeadlineMs": 120000,
                    "retryPolicy": { "maxAttempts": 3, "maxTotalDelayMs": 30000 }
                },
                "configSha256": "bc9267f85e52b4ac2945b81966aa9a4cc7f513642cfa8f0057f7fc35b90586c8",
                "credential": secret
            }
        })
        .to_string(),
    );
    let bound = read_next_envelope(&mut child);
    assert_eq!(bound.name, "provider.bound");
    assert_eq!(bound.correlation_id, Some(message_id));
    assert!(!serde_json::to_string(&bound).unwrap().contains(secret));

    let status = command_envelope("runtime.status.get", 3, serde_json::json!({}));
    write_envelope(&mut child, &status);
    assert_response(
        &read_next_envelope(&mut child),
        &status,
        "runtime.status",
        4,
    );
    let shutdown = command_envelope("runtime.shutdown", 4, serde_json::json!({}));
    write_envelope(&mut child, &shutdown);
    assert_response(
        &read_next_envelope(&mut child),
        &shutdown,
        "runtime.stopped",
        5,
    );
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
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
fn only_one_runtime_process_can_own_a_workspace_database() {
    let fixture = Fixture::new();
    let database_path = fixture.database_path.to_string_lossy().into_owned();
    let (mut first, _hello) = spawn_and_read_hello();
    let first_initialize = initialize_envelope_with_path(
        PROTOCOL_VERSION,
        "runtime.initialize",
        Some(database_path.clone()),
    );
    write_envelope(&mut first, &first_initialize);
    assert_eq!(read_next_envelope(&mut first).name, "runtime.ready");

    let (mut second, _hello) = spawn_and_read_hello();
    let second_initialize = initialize_envelope_with_path(
        PROTOCOL_VERSION,
        "runtime.initialize",
        Some(database_path.clone()),
    );
    write_envelope(&mut second, &second_initialize);
    let rejected = read_next_envelope(&mut second);
    assert_eq!(rejected.name, "runtime.initialization_failed");
    let error: RuntimeError = serde_json::from_value(rejected.payload).unwrap();
    assert_eq!(error.code, "WORKSPACE_RUNTIME_LEASE_UNAVAILABLE");
    assert_eq!(error.stage, "runtime.initialize.workspace_lease");
    drop(second.stdin.take());
    assert!(!second.wait().unwrap().success());

    drop(first.stdin.take());
    assert!(first.wait().unwrap().success());

    let (mut third, _hello) = spawn_and_read_hello();
    let third_initialize =
        initialize_envelope_with_path(PROTOCOL_VERSION, "runtime.initialize", Some(database_path));
    write_envelope(&mut third, &third_initialize);
    assert_eq!(read_next_envelope(&mut third).name, "runtime.ready");
    drop(third.stdin.take());
    assert!(third.wait().unwrap().success());
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
fn repeated_startup_records_identical_operational_recovery_only_once() {
    let fixture = Fixture::new();
    {
        let mut journal = EventJournal::open(&fixture.database_path).unwrap();
        create_run(&mut journal, "recovery-run", "created");
    }
    for _ in 0..2 {
        let (mut child, _hello) = spawn_and_read_hello();
        let initialize = initialize_envelope_with_path(
            PROTOCOL_VERSION,
            "runtime.initialize",
            Some(fixture.database_path.to_string_lossy().into_owned()),
        );
        write_envelope(&mut child, &initialize);
        assert_eq!(read_next_envelope(&mut child).name, "runtime.ready");
        let shutdown = command_envelope("runtime.shutdown", 2, serde_json::json!({}));
        write_envelope(&mut child, &shutdown);
        assert_eq!(read_next_envelope(&mut child).name, "runtime.stopped");
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
    }
    let connection = Connection::open(&fixture.database_path).unwrap();
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM workspace_events WHERE stream_type = 'operational_recovery'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 2, "observed + waiting must not duplicate on restart");
}

#[test]
fn provider_bind_records_only_the_matching_recovery_candidate_without_inference() {
    let fixture = Fixture::new();
    let run_id = "provider-recovery-run";
    {
        let mut identity = pinned_identity();
        identity.provider.config_sha256 =
            "bc9267f85e52b4ac2945b81966aa9a4cc7f513642cfa8f0057f7fc35b90586c8".to_owned();
        let mut journal = EventJournal::open(&fixture.database_path).unwrap();
        RunAggregate::create(
            &mut journal,
            run_id,
            identity,
            EventMetadata {
                message_id: "provider-recovery-created",
                idempotency_key: "provider-recovery-created-key",
                created_at: "2026-07-13T00:00:00Z",
                reason: None,
            },
        )
        .unwrap();
    }
    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope_with_path(
        PROTOCOL_VERSION,
        "runtime.initialize",
        Some(fixture.database_path.to_string_lossy().into_owned()),
    );
    write_envelope(&mut child, &initialize);
    assert_eq!(read_next_envelope(&mut child).name, "runtime.ready");

    let message_id = uuid::Uuid::new_v4();
    write_line(
        &mut child,
        &provider_bind_json(message_id, 2, "recovery-test-key").to_string(),
    );
    let bound = read_next_envelope(&mut child);
    assert_eq!(bound.name, "provider.bound");

    let shutdown = command_envelope("runtime.shutdown", 3, serde_json::json!({}));
    write_envelope(&mut child, &shutdown);
    assert_eq!(read_next_envelope(&mut child).name, "runtime.stopped");
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());

    let connection = Connection::open(&fixture.database_path).unwrap();
    let recovery_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM workspace_events WHERE stream_type = 'operational_recovery' AND stream_id = ?1",
            [format!("run:{run_id}")],
            |row| row.get(0),
        )
        .unwrap();
    let provider_attempt_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM runtime_events WHERE aggregate_type = 'provider_attempt' AND run_id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        recovery_count, 4,
        "unbound observed/waiting + bound observed/explicit-execution waiting"
    );
    assert_eq!(
        provider_attempt_count, 0,
        "provider.bind must not call the model"
    );
}

#[test]
fn startup_recovery_gate_prevents_prepare_from_terminalizing_a_missing_provider() {
    let fixture = Fixture::new();
    let run_id = uuid::Uuid::new_v4();
    seed_assignment_child_run(&fixture.database_path, run_id);
    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope_with_path(
        PROTOCOL_VERSION,
        "runtime.initialize",
        Some(fixture.database_path.to_string_lossy().into_owned()),
    );
    write_envelope(&mut child, &initialize);
    assert_eq!(read_next_envelope(&mut child).name, "runtime.ready");

    let mut prepare = command_envelope(
        "run.prepare",
        2,
        serde_json::to_value(RunPrepare {
            prepare_idempotency_key: "guarded-prepare".to_owned(),
        })
        .unwrap(),
    );
    prepare.run_id = Some(run_id);
    write_envelope(&mut child, &prepare);
    let rejected = read_next_envelope(&mut child);
    assert_response(&rejected, &prepare, "run.rejected", 3);
    let error: RuntimeError = serde_json::from_value(rejected.payload).unwrap();
    assert_eq!(error.code, "RUN_RECOVERY_AWAITING_PROVIDER_BINDING");
    assert!(error.retryable);

    let shutdown = command_envelope("runtime.shutdown", 3, serde_json::json!({}));
    write_envelope(&mut child, &shutdown);
    assert_eq!(read_next_envelope(&mut child).name, "runtime.stopped");
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    let journal = EventJournal::open(&fixture.database_path).unwrap();
    let run = RunAggregate::recover(&journal, &run_id.to_string()).unwrap();
    assert_eq!(run.state(), novelx_runtime::run_state::RunState::Created);
    assert!(run.terminal_error().is_none());
}

#[test]
fn quarantined_assignment_is_readable_but_mutations_are_blocked_after_real_restart() {
    let fixture = Fixture::new();
    {
        let mut journal = EventJournal::open(&fixture.database_path).unwrap();
        create_run(&mut journal, "parent-run", "created");
    }
    let resources = vec!["resource-1".to_owned()];
    let mut assignments = AgentAssignmentRepository::open(&fixture.database_path).unwrap();
    let allocated = assignments
        .allocate(
            AgentAssignmentIdentity {
                assignment_id: "quarantined-assignment".into(),
                workspace_id: "workspace-1".into(),
                project_id: "project-1".into(),
                goal: RevisionBinding {
                    id: "goal-1".into(),
                    revision: 1,
                    sha256: "a".repeat(64),
                },
                plan: RevisionBinding {
                    id: "plan-1".into(),
                    revision: 1,
                    sha256: "b".repeat(64),
                },
                plan_step_id: "step-1".into(),
                parent_run_id: "parent-run".into(),
                parent_invocation_id: "invocation-1".into(),
                child_profile_id: "checker".into(),
            },
            AssignmentScope {
                scope_sha256: format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&resources).unwrap())
                ),
                resource_ids: resources,
            },
            AssignmentDefinition {
                bounded_objective: "核对来源".into(),
                source_checkpoint_id: "checkpoint-1".into(),
                expected_artifact: "source-report".into(),
                capabilities: vec!["project.read".into()],
            },
            ChildAgentPermission::ReadOnly,
            assignment_metadata("assignment-created"),
        )
        .unwrap();
    drop(assignments);
    append_legacy_assignment_started(&fixture.database_path, &allocated, "missing-child-run");

    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope_with_path(
        PROTOCOL_VERSION,
        "runtime.initialize",
        Some(fixture.database_path.to_string_lossy().into_owned()),
    );
    write_envelope(&mut child, &initialize);
    let ready = read_next_envelope(&mut child);
    assert_eq!(ready.name, "runtime.ready");

    let get = command_envelope(
        "agent.assignment.get",
        2,
        serde_json::json!({ "assignmentId": "quarantined-assignment" }),
    );
    write_envelope(&mut child, &get);
    let snapshot = read_next_envelope(&mut child);
    assert_response(&snapshot, &get, "agent.assignment.snapshot", 3);

    let cancel = command_envelope(
        "agent.assignment.request_cancel",
        3,
        serde_json::json!({
            "cancelIdempotencyKey": "blocked-cancel",
            "assignmentId": "quarantined-assignment",
            "expectedRevision": 2
        }),
    );
    write_envelope(&mut child, &cancel);
    let rejected = read_next_envelope(&mut child);
    assert_response(&rejected, &cancel, "agent.assignment.rejected", 4);
    let error: RuntimeError = serde_json::from_value(rejected.payload).unwrap();
    assert_eq!(error.code, "ASSIGNMENT_RECOVERY_QUARANTINED");
    assert!(
        EventJournal::open(&fixture.database_path)
            .unwrap()
            .read_run("missing-child-run", 0)
            .unwrap()
            .is_empty()
    );

    let shutdown = command_envelope("runtime.shutdown", 4, serde_json::json!({}));
    write_envelope(&mut child, &shutdown);
    let stopped = read_next_envelope(&mut child);
    assert_response(&stopped, &shutdown, "runtime.stopped", 5);
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
    let has_workspace = workspace_database_path.is_some();
    let project_root_path = workspace_database_path.as_ref().map(|database_path| {
        std::path::Path::new(database_path)
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    });
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
            project_root_path,
            project_id: has_workspace.then(|| "project-1".to_owned()),
            workspace_id: has_workspace.then(|| "workspace-1".to_owned()),
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

fn provider_bind_json(
    message_id: uuid::Uuid,
    sequence: u64,
    credential: &str,
) -> serde_json::Value {
    serde_json::json!({
        "protocolVersion": 1,
        "messageId": message_id,
        "messageType": "sensitive_command",
        "name": "provider.bind",
        "sentAt": "2026-07-13T00:00:10Z",
        "correlationId": null,
        "runId": null,
        "sequence": sequence,
        "payload": {
            "config": {
                "schemaVersion": 1,
                "profileId": "profile-1",
                "providerId": "deepseek",
                "displayName": "DeepSeek",
                "baseUrl": "https://api.deepseek.com/v1",
                "modelId": "deepseek-chat",
                "apiFlavor": "open_ai_chat_completions",
                "authScheme": "bearer",
                "contextWindow": 1000000,
                "maxTokens": null,
                "reasoning": false,
                "input": ["text"],
                "requestTimeoutMs": 30000,
                "totalDeadlineMs": 120000,
                "retryPolicy": { "maxAttempts": 3, "maxTotalDelayMs": 30000 }
            },
            "configSha256": "bc9267f85e52b4ac2945b81966aa9a4cc7f513642cfa8f0057f7fc35b90586c8",
            "credential": credential
        }
    })
}

fn assignment_metadata(id: &str) -> AssignmentEventMetadata {
    AssignmentEventMetadata {
        message_id: format!("{id}-message"),
        idempotency_key: format!("{id}-key"),
        created_at: "2026-07-12T00:00:01Z".into(),
    }
}

fn append_legacy_assignment_started(
    path: &std::path::Path,
    allocation: &AgentAssignmentAggregate,
    child_run_id: &str,
) {
    #[derive(Serialize)]
    #[serde(tag = "kind", content = "data", rename_all = "snake_case")]
    enum LegacyData<'a> {
        Started { child_run_id: &'a str },
    }
    #[derive(Serialize)]
    struct HashMaterial<'a> {
        aggregate_revision: u64,
        previous_hash: &'a str,
        data: &'a LegacyData<'a>,
    }
    #[derive(Serialize)]
    struct Stored<'a> {
        aggregate_revision: u64,
        previous_hash: &'a str,
        data: &'a LegacyData<'a>,
        event_hash: &'a str,
    }
    let data = LegacyData::Started { child_run_id };
    let material = HashMaterial {
        aggregate_revision: 2,
        previous_hash: &allocation.last_event_hash,
        data: &data,
    };
    let event_hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&material).unwrap())
    );
    let payload = serde_json::to_value(Stored {
        aggregate_revision: 2,
        previous_hash: &allocation.last_event_hash,
        data: &data,
        event_hash: &event_hash,
    })
    .unwrap();
    let mut journal = WorkspaceEventJournal::open(path).unwrap();
    let workspace_sequence = journal.current_workspace_sequence("workspace-1").unwrap();
    journal
        .append(
            NewWorkspaceEvent {
                workspace_id: "workspace-1".into(),
                stream_type: "agent_assignment".into(),
                stream_id: allocation.identity.assignment_id.clone(),
                message_id: "legacy-start-message".into(),
                idempotency_key: "legacy-start-key".into(),
                event_type: "agent_assignment.started".into(),
                event_version: 1,
                payload,
                created_at: "2026-07-12T00:00:01Z".into(),
            },
            workspace_sequence,
            1,
        )
        .unwrap();
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
    assert_eq!(response.run_id, command.run_id);
    assert_eq!(response.sequence, expected_sequence);
}

fn read_next_envelope(child: &mut Child) -> Envelope {
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    serde_json::from_str(line.trim()).unwrap()
}

fn seed_assignment_child_run(path: &std::path::Path, child_run_id: uuid::Uuid) {
    let parent_run_id = uuid::Uuid::new_v4().to_string();
    let goal = RevisionReference {
        id: "guard-goal".to_owned(),
        revision: 1,
        sha256: Some("7".repeat(64)),
    };
    let plan = RevisionReference {
        id: "guard-plan".to_owned(),
        revision: 1,
        sha256: Some("8".repeat(64)),
    };
    let mut parent_identity = pinned_identity();
    parent_identity.goal = Some(goal.clone());
    parent_identity.plan = Some(plan.clone());
    let mut journal = EventJournal::open(path).unwrap();
    let mut parent = RunAggregate::create(
        &mut journal,
        &parent_run_id,
        parent_identity,
        EventMetadata {
            message_id: "guard-parent-created",
            idempotency_key: "guard-parent-created-key",
            created_at: "2026-07-13T00:00:00Z",
            reason: None,
        },
    )
    .unwrap();
    parent
        .prepare(
            &mut journal,
            EventMetadata {
                message_id: "guard-parent-prepared",
                idempotency_key: "guard-parent-prepared-key",
                created_at: "2026-07-13T00:00:01Z",
                reason: None,
            },
        )
        .unwrap();
    parent
        .start(
            &mut journal,
            EventMetadata {
                message_id: "guard-parent-started",
                idempotency_key: "guard-parent-started-key",
                created_at: "2026-07-13T00:00:02Z",
                reason: None,
            },
        )
        .unwrap();
    drop(journal);

    let base_child = pinned_identity();
    let assignment_id = "guard-assignment";
    let mut assignments = AgentAssignmentRepository::open(path).unwrap();
    let allocation = assignments
        .allocate(
            AgentAssignmentIdentity {
                assignment_id: assignment_id.to_owned(),
                workspace_id: "workspace-1".to_owned(),
                project_id: "project-1".to_owned(),
                goal: RevisionBinding {
                    id: goal.id.clone(),
                    revision: goal.revision,
                    sha256: goal.sha256.clone().unwrap(),
                },
                plan: RevisionBinding {
                    id: plan.id.clone(),
                    revision: plan.revision,
                    sha256: plan.sha256.clone().unwrap(),
                },
                plan_step_id: "guard-step".to_owned(),
                parent_run_id: parent_run_id.clone(),
                parent_invocation_id: "guard-parent-invocation".to_owned(),
                child_profile_id: base_child.agent_profile.id.clone(),
            },
            AssignmentScope {
                resource_ids: base_child.scope_resource_ids.clone(),
                scope_sha256: base_child.resource_scope_sha256.clone(),
            },
            AssignmentDefinition {
                bounded_objective: "Guard a recovered child run".to_owned(),
                source_checkpoint_id: base_child.source_checkpoint_id.clone(),
                expected_artifact: "guard-report".to_owned(),
                capabilities: vec!["project.read".to_owned()],
            },
            ChildAgentPermission::ReadOnly,
            assignment_metadata("guard-assignment-allocated"),
        )
        .unwrap();
    let mut child_identity = base_child;
    child_identity.goal = Some(goal);
    child_identity.plan = Some(plan);
    child_identity.assignment = Some(RevisionReference {
        id: assignment_id.to_owned(),
        revision: allocation.revision,
        sha256: Some(allocation.last_event_hash.clone()),
    });
    child_identity.parent_run_id = Some(parent_run_id);
    child_identity.delegation_depth = 1;
    let spec = ChildRunSpec {
        child_run_id: child_run_id.to_string(),
        run_start_idempotency_key: "guard-child-run-start".to_owned(),
        pinned_identity_sha256: child_run_pinned_identity_sha256(&child_identity).unwrap(),
        pinned_identity: child_identity.clone(),
    };
    assignments
        .start(
            "workspace-1",
            assignment_id,
            allocation.revision,
            spec,
            assignment_metadata("guard-assignment-started"),
        )
        .unwrap();
    drop(assignments);
    RunAggregate::create(
        &mut EventJournal::open(path).unwrap(),
        &child_run_id.to_string(),
        child_identity,
        EventMetadata {
            message_id: "guarded-run-created",
            idempotency_key: "guarded-run-created-key",
            created_at: "2026-07-13T00:00:03Z",
            reason: None,
        },
    )
    .unwrap();
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
