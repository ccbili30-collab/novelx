use std::sync::{Arc, Barrier};

use novelx_runtime::{
    event_journal::{EventJournal, NewRuntimeEvent},
    workspace_event_journal::{
        NewWorkspaceEvent, WorkspaceEventJournal, WorkspaceEventJournalError,
    },
};
use rusqlite::Connection;
use serde_json::json;

#[test]
fn upgrades_existing_runtime_database_and_round_trips_chinese_payload() {
    let fixture = Fixture::new();
    drop(EventJournal::open(&fixture.database).unwrap());
    let mut journal = fixture.open();
    let stored = journal
        .append(event("message-1", "key-1", "goal", "goal-1"), 0, 0)
        .unwrap();
    assert_eq!(stored.workspace_sequence, 1);
    assert_eq!(stored.stream_sequence, 1);
    assert_eq!(stored.payload["objective"], "整理银湾海岸世界观");
    drop(journal);

    let reopened = fixture.open();
    assert_eq!(
        reopened.current_workspace_sequence("workspace-1").unwrap(),
        1
    );
    assert_eq!(
        reopened
            .current_stream_sequence("workspace-1", "goal", "goal-1")
            .unwrap(),
        1
    );
    assert_eq!(
        reopened
            .read_stream("workspace-1", "goal", "goal-1", 0)
            .unwrap(),
        vec![stored]
    );
    assert_eq!(reopened.list_streams("workspace-1", None).unwrap().len(), 1);
    let connection = Connection::open(&fixture.database).unwrap();
    let migration_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM runtime_schema_migrations WHERE version = 4",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(migration_count, 1);
    let clock_migration_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM runtime_schema_migrations WHERE version = 5",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(clock_migration_count, 1);
}

#[test]
fn idempotent_retry_returns_original_and_conflicting_semantics_fail() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let original = event("message-1", "stable-key", "plan", "plan-1");
    let first = journal.append(original.clone(), 0, 0).unwrap();
    let retry = journal.append(original, 0, 0).unwrap();
    assert_eq!(retry, first);

    let mut conflicting = event("message-2", "stable-key", "plan", "plan-1");
    conflicting.payload = json!({"objective": "冲突内容"});
    assert!(matches!(
        journal.append(conflicting, 1, 1),
        Err(WorkspaceEventJournalError::IdempotencyConflict { idempotency_key })
            if idempotency_key == "stable-key"
    ));
}

#[test]
fn append_only_triggers_reject_update_and_delete() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    journal
        .append(event("message-1", "key-1", "goal", "goal-1"), 0, 0)
        .unwrap();
    drop(journal);
    let connection = Connection::open(&fixture.database).unwrap();
    assert!(
        connection
            .execute("UPDATE workspace_events SET event_type = 'tampered'", [])
            .is_err()
    );
    assert!(
        connection
            .execute("DELETE FROM workspace_events", [])
            .is_err()
    );
}

#[test]
fn migration_checksum_tampering_blocks_reopen() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let connection = Connection::open(&fixture.database).unwrap();
    connection
        .execute(
            "UPDATE runtime_schema_migrations SET checksum = ?1 WHERE version = 4",
            ["0".repeat(64)],
        )
        .unwrap();
    drop(connection);
    assert!(matches!(
        WorkspaceEventJournal::open(&fixture.database),
        Err(WorkspaceEventJournalError::MigrationChecksumMismatch)
    ));
}

#[test]
fn concurrent_writers_allow_only_one_expected_workspace_sequence() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let barrier = Arc::new(Barrier::new(3));
    let handles = (0..2)
        .map(|index| {
            let database = fixture.database.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let mut journal = WorkspaceEventJournal::open(database).unwrap();
                barrier.wait();
                journal.append(
                    event(
                        &format!("message-{index}"),
                        &format!("key-{index}"),
                        "agent",
                        &format!("agent-{index}"),
                    ),
                    0,
                    0,
                )
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                Err(WorkspaceEventJournalError::WorkspaceSequenceConflict {
                    expected: 0,
                    actual: 1
                })
            ))
            .count(),
        1
    );
}

#[test]
fn stream_sequence_is_independent_but_workspace_sequence_is_global() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let first = journal
        .append(event("m1", "k1", "goal", "g1"), 0, 0)
        .unwrap();
    let second = journal
        .append(event("m2", "k2", "plan", "p1"), 1, 0)
        .unwrap();
    let third = journal
        .append(event("m3", "k3", "goal", "g1"), 2, 1)
        .unwrap();
    assert_eq!(
        (
            first.workspace_sequence,
            second.workspace_sequence,
            third.workspace_sequence
        ),
        (1, 2, 3)
    );
    assert_eq!(
        (
            first.stream_sequence,
            second.stream_sequence,
            third.stream_sequence
        ),
        (1, 1, 2)
    );
    assert_eq!(
        journal
            .list_streams("workspace-1", Some("goal"))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn global_clock_covers_runtime_and_workspace_events_and_guards_append() {
    let fixture = Fixture::new();
    let mut workspace = fixture.open();
    assert_eq!(workspace.current_global_sequence().unwrap(), 0);
    workspace
        .append(event("m1", "k1", "goal", "g1"), 0, 0)
        .unwrap();
    assert_eq!(workspace.current_global_sequence().unwrap(), 1);

    let mut runtime = EventJournal::open(&fixture.database).unwrap();
    runtime
        .append(
            NewRuntimeEvent {
                run_id: "run-1".to_owned(),
                aggregate_type: "run".to_owned(),
                aggregate_id: "run-1".to_owned(),
                message_id: "runtime-m1".to_owned(),
                idempotency_key: "runtime-k1".to_owned(),
                event_type: "run.started".to_owned(),
                event_version: 1,
                payload: json!({"state": "started"}),
                created_at: "2026-07-13T00:00:00Z".to_owned(),
            },
            0,
            0,
        )
        .unwrap();
    assert_eq!(workspace.current_global_sequence().unwrap(), 2);

    assert!(matches!(
        workspace.append_at_global_sequence(event("m2", "k2", "plan", "p1"), 1, 0, 1),
        Err(WorkspaceEventJournalError::GlobalSequenceConflict {
            expected: 1,
            actual: 2
        })
    ));
    workspace
        .append_at_global_sequence(event("m2", "k2", "plan", "p1"), 1, 0, 2)
        .unwrap();
    assert_eq!(workspace.current_global_sequence().unwrap(), 3);
}

fn event(
    message_id: &str,
    idempotency_key: &str,
    stream_type: &str,
    stream_id: &str,
) -> NewWorkspaceEvent {
    NewWorkspaceEvent {
        workspace_id: "workspace-1".to_owned(),
        stream_type: stream_type.to_owned(),
        stream_id: stream_id.to_owned(),
        message_id: message_id.to_owned(),
        idempotency_key: idempotency_key.to_owned(),
        event_type: format!("{stream_type}.recorded"),
        event_version: 1,
        payload: json!({"objective": "整理银湾海岸世界观", "来源": "世界.md"}),
        created_at: "2026-07-12T00:00:00Z".to_owned(),
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    database: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("workspace.db");
        Self {
            _temp: temp,
            database,
        }
    }

    fn open(&self) -> WorkspaceEventJournal {
        WorkspaceEventJournal::open(&self.database).unwrap()
    }
}
