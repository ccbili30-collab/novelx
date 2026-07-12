mod support;

use novelx_protocol::RunStart;
use novelx_runtime::event_journal::{EventJournal, NewRuntimeEvent};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate};
use novelx_runtime::run_command_service::{RunCommandService, WorkspaceBinding};
use serde_json::json;
use support::pinned_identity;
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn start_and_get_return_the_same_journal_snapshot_after_reopening() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4();
    let first = {
        let mut journal = Some(fixture.open());
        RunCommandService::new(&mut journal, Some(&binding()))
            .start(run_id, Uuid::new_v4(), start_payload())
            .unwrap()
    };
    let recovered = {
        let mut journal = Some(fixture.open());
        RunCommandService::new(&mut journal, Some(&binding()))
            .get(run_id)
            .unwrap()
    };
    assert_eq!(recovered, first);
}

#[test]
fn workspace_mismatch_is_nonfatal_and_writes_nothing() {
    let fixture = Fixture::new();
    let mut journal = Some(fixture.open());
    let run_id = Uuid::new_v4();
    let mut payload = start_payload();
    payload.pinned_identity.project_id = "other-project".to_owned();

    let error = RunCommandService::new(&mut journal, Some(&binding()))
        .start(run_id, Uuid::new_v4(), payload)
        .unwrap_err();

    assert_eq!(error.error.code, "RUN_WORKSPACE_BINDING_CONFLICT");
    assert!(!error.fatal);
    assert!(
        journal
            .as_ref()
            .unwrap()
            .read_run(&run_id.to_string(), 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn corrupted_run_history_returns_a_fatal_failure() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4();
    let mut journal = fixture.open();
    RunAggregate::create(
        &mut journal,
        &run_id.to_string(),
        pinned_identity(),
        EventMetadata {
            message_id: "create-message",
            idempotency_key: "create-key",
            created_at: "2026-07-12T00:00:00Z",
            reason: None,
        },
    )
    .unwrap();
    journal
        .append(
            NewRuntimeEvent {
                run_id: run_id.to_string(),
                aggregate_type: "run".to_owned(),
                aggregate_id: run_id.to_string(),
                message_id: "bad-message".to_owned(),
                idempotency_key: "bad-key".to_owned(),
                event_type: "run.preparing".to_owned(),
                event_version: 99,
                payload: json!({
                    "previousState": "created",
                    "currentState": "preparing",
                    "reason": null,
                }),
                created_at: "2026-07-12T00:00:01Z".to_owned(),
            },
            1,
            1,
        )
        .unwrap();
    let mut journal = Some(journal);

    let error = RunCommandService::new(&mut journal, Some(&binding()))
        .get(run_id)
        .unwrap_err();

    assert_eq!(error.error.code, "RUN_JOURNAL_INTEGRITY_FAILED");
    assert!(error.fatal);
}

fn start_payload() -> RunStart {
    RunStart {
        start_idempotency_key: "stable-start-1".to_owned(),
        pinned_identity: pinned_identity(),
    }
}

fn binding() -> WorkspaceBinding {
    WorkspaceBinding {
        project_id: "project-1".to_owned(),
        workspace_id: "workspace-1".to_owned(),
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

    fn open(&self) -> EventJournal {
        EventJournal::open(&self.path).unwrap()
    }
}
