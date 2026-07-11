use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use novelx_protocol::{
    Envelope, MessageType, PROTOCOL_VERSION, RuntimeApplicationIdentity, RuntimeHello,
    RuntimeInitialize, RuntimeReady,
};

#[test]
fn completes_one_correlated_initialize_and_waits_for_eof() {
    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope(PROTOCOL_VERSION, "runtime.initialize");
    assert_eq!(
        initialize.payload,
        serde_json::json!({
            "selectedProtocolVersion": 1,
            "application": { "id": "novelx.desktop", "version": "0.2.7", "commit": "desktop-development" },
            "workspaceDatabasePath": r"C:\NovelX\project\.novax\workspace.db",
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
    ];
    for case in cases {
        let (mut child, hello) = spawn_and_read_hello();
        match case {
            "invalid_json" => write_line(&mut child, "not-json"),
            "unsupported_version" => {
                let envelope = initialize_envelope(PROTOCOL_VERSION + 1, "runtime.initialize");
                write_envelope(&mut child, &envelope);
            }
            "wrong_name" => {
                let envelope = initialize_envelope(PROTOCOL_VERSION, "run.start");
                write_envelope(&mut child, &envelope);
            }
            "wrong_correlation" => {
                let mut envelope = initialize_envelope(PROTOCOL_VERSION, "runtime.initialize");
                envelope.correlation_id = Some(hello.message_id);
                write_envelope(&mut child, &envelope);
            }
            _ => unreachable!(),
        }
        drop(child.stdin.take());
        let output = child.wait_with_output().expect("runtime output");
        assert!(!output.status.success(), "{case} must fail");
        assert!(
            output.stdout.is_empty(),
            "{case} must not emit runtime.ready"
        );
        assert!(
            !output.stderr.is_empty(),
            "{case} must explain failure on stderr"
        );
    }
}

#[test]
fn rejects_a_second_message_after_ready() {
    let (mut child, _hello) = spawn_and_read_hello();
    let initialize = initialize_envelope(PROTOCOL_VERSION, "runtime.initialize");
    write_envelope(&mut child, &initialize);
    write_line(&mut child, "{}");
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("runtime output");
    assert!(!output.status.success());
    let lines: Vec<_> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(lines.len(), 1, "only runtime.ready may follow hello");
    assert!(!output.stderr.is_empty());
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
    let mut envelope = Envelope::new(
        MessageType::Command,
        name,
        "2026-07-12T00:00:00Z",
        2,
        RuntimeInitialize {
            selected_protocol_version: version,
            application: RuntimeApplicationIdentity {
                id: "novelx.desktop".to_owned(),
                version: "0.2.7".to_owned(),
                commit: "desktop-development".to_owned(),
            },
            workspace_database_path: Some(r"C:\NovelX\project\.novax\workspace.db".to_owned()),
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

fn write_envelope(child: &mut Child, envelope: &Envelope) {
    write_line(child, &serde_json::to_string(envelope).unwrap());
}

fn write_line(child: &mut Child, line: &str) {
    let stdin = child.stdin.as_mut().expect("stdin must exist");
    writeln!(stdin, "{line}").expect("stdin write");
    stdin.flush().expect("stdin flush");
}
