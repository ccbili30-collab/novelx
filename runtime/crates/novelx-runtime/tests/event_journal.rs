use novelx_runtime::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent};
use rusqlite::{Connection, params};
use serde_json::json;
use tempfile::TempDir;

const MIGRATION_0001: &str = include_str!("../migrations/0001_event_journal.sql");

#[test]
fn allocates_run_and_aggregate_sequences_and_reads_after_cursors() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let run_event = journal
        .append(event("run-a", "run", "run-a", "m1", "k1", 1), 0, 0)
        .unwrap();
    let tool_event = journal
        .append(event("run-a", "tool", "tool-a", "m2", "k2", 2), 1, 0)
        .unwrap();
    let run_event_2 = journal
        .append(event("run-a", "run", "run-a", "m3", "k3", 3), 2, 1)
        .unwrap();

    assert_eq!(
        (run_event.run_sequence, run_event.aggregate_sequence),
        (1, 1)
    );
    assert_eq!(
        (tool_event.run_sequence, tool_event.aggregate_sequence),
        (2, 1)
    );
    assert_eq!(
        (run_event_2.run_sequence, run_event_2.aggregate_sequence),
        (3, 2)
    );
    assert_eq!(
        journal.read_run("run-a", 1).unwrap(),
        vec![tool_event, run_event_2.clone()]
    );
    assert_eq!(
        journal.read_aggregate("run-a", "run", "run-a", 1).unwrap(),
        vec![run_event_2]
    );
}

#[test]
fn idempotency_ignores_retry_transport_identity_but_rejects_conflicts() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let original_event = event("run-a", "run", "run-a", "m1", "stable-key", 1);
    let original = journal.append(original_event.clone(), 0, 0).unwrap();
    assert_eq!(
        journal.append(original_event.clone(), 0, 0).unwrap(),
        original
    );

    let mut retried = original_event.clone();
    retried.message_id = "m-retry".to_owned();
    retried.created_at = "2026-07-12T00:00:09Z".to_owned();
    assert_eq!(journal.append(retried, 0, 0).unwrap(), original);

    let conflict = event("run-a", "run", "run-a", "m2", "stable-key", 2);
    assert!(matches!(
        journal.append(conflict, 0, 0),
        Err(EventJournalError::IdempotencyConflict { idempotency_key }) if idempotency_key == "stable-key"
    ));

    let occupied = journal
        .append(
            event("run-a", "tool", "tool-b", "m-occupied", "key-b", 3),
            1,
            0,
        )
        .unwrap();
    let mut masked = original_event.clone();
    masked.message_id = occupied.message_id.clone();
    assert!(matches!(
        journal.append(masked, 0, 0),
        Err(EventJournalError::MessageIdConflict { message_id }) if message_id == "m-occupied"
    ));

    let mut same_message_different_payload = original_event;
    same_message_different_payload.payload = json!({ "value": 999 });
    assert!(matches!(
        journal.append(same_message_different_payload, 0, 0),
        Err(EventJournalError::MessageIdConflict { message_id }) if message_id == "m1"
    ));
    assert_eq!(
        journal.read_run("run-a", 0).unwrap(),
        vec![original, occupied]
    );
}

#[test]
fn stale_run_or_aggregate_sequences_fail_without_writing() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    journal
        .append(event("run-a", "run", "run-a", "m1", "k1", 1), 0, 0)
        .unwrap();

    assert!(matches!(
        journal.append(event("run-a", "tool", "tool-a", "m2", "k2", 2), 0, 0),
        Err(EventJournalError::RunSequenceConflict {
            expected: 0,
            actual: 1
        })
    ));
    assert!(matches!(
        journal.append(event("run-a", "run", "run-a", "m3", "k3", 3), 1, 0),
        Err(EventJournalError::AggregateSequenceConflict {
            expected: 0,
            actual: 1
        })
    ));
    assert_eq!(journal.read_run("run-a", 0).unwrap().len(), 1);

    let mut invalid_version = event("run-b", "run", "run-b", "m4", "k4", 4);
    invalid_version.event_version = 0;
    assert!(matches!(
        journal.append(invalid_version, 0, 0),
        Err(EventJournalError::InvalidEventVersion)
    ));
}

#[test]
fn extreme_expected_sequences_return_errors_without_panicking() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let candidate = event("run-max", "run", "run-max", "m-max", "k-max", 1);
    assert!(matches!(
        journal.append(candidate.clone(), u64::MAX, 0),
        Err(EventJournalError::RunSequenceConflict {
            expected: u64::MAX,
            actual: 0
        })
    ));
    assert!(matches!(
        journal.append(candidate, 0, u64::MAX),
        Err(EventJournalError::AggregateSequenceConflict {
            expected: u64::MAX,
            actual: 0
        })
    ));
}

#[test]
fn concurrent_connections_allocate_one_run_order_and_independent_aggregate_orders() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let handles = (0..8)
        .map(|index| {
            let path = fixture.database_path.clone();
            std::thread::spawn(move || {
                let mut journal = EventJournal::open(path).unwrap();
                let candidate = event(
                    "run-concurrent",
                    "tool",
                    &format!("tool-{index}"),
                    &format!("message-{index}"),
                    &format!("key-{index}"),
                    index,
                );
                loop {
                    let expected_run = journal
                        .read_run("run-concurrent", 0)
                        .unwrap()
                        .last()
                        .map_or(0, |event| event.run_sequence);
                    match journal.append(candidate.clone(), expected_run, 0) {
                        Ok(event) => break event,
                        Err(EventJournalError::RunSequenceConflict { .. }) => continue,
                        Err(error) => panic!("unexpected append failure: {error}"),
                    }
                }
            })
        })
        .collect::<Vec<_>>();
    for handle in handles {
        handle.join().unwrap();
    }

    let journal = fixture.open();
    let events = journal.read_run("run-concurrent", 0).unwrap();
    assert_eq!(events.len(), 8);
    assert_eq!(
        events
            .iter()
            .map(|event| event.run_sequence)
            .collect::<Vec<_>>(),
        (1..=8).collect::<Vec<u64>>()
    );
    assert!(events.iter().all(|event| event.aggregate_sequence == 1));
}

#[test]
fn migrates_a_real_0001_database_and_preserves_rows_constraints_and_ledger() {
    let fixture = Fixture::new();
    {
        let connection = Connection::open(&fixture.database_path).unwrap();
        connection.execute_batch(MIGRATION_0001).unwrap();
        connection.execute(
            "INSERT INTO runtime_events (run_id, sequence, message_id, event_type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params!["run-old", 1, "old-message", "run.created", "{\"legacy\":true}", "2026-07-12T00:00:00Z"],
        ).unwrap();
    }

    {
        let journal = fixture.open();
        let rows = journal.read_run("run-old", 0).unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.run_sequence, 1);
        assert_eq!(row.aggregate_type, "run");
        assert_eq!(row.aggregate_id, "run-old");
        assert_eq!(row.aggregate_sequence, 1);
        assert_eq!(row.idempotency_key, "old-message");
        assert_eq!(row.event_version, 1);
        assert_eq!(row.payload, json!({ "legacy": true }));
    }

    let connection = Connection::open(&fixture.database_path).unwrap();
    let migrations: Vec<(i64, i64)> = connection
        .prepare("SELECT version, length(checksum) FROM runtime_schema_migrations ORDER BY version")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(migrations, vec![(1, 64), (2, 64), (3, 64)]);
    let indexes: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runtime_events' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(
        indexes
            .iter()
            .any(|name| name == "runtime_events_aggregate_replay")
    );
    assert!(
        indexes
            .iter()
            .any(|name| name == "runtime_events_run_type_order")
    );
    assert!(connection.execute(
        "INSERT INTO runtime_events (run_id, run_sequence, aggregate_type, aggregate_id, aggregate_sequence, message_id, idempotency_key, event_type, event_version, payload_json, created_at) \
         VALUES ('run-old', 2, 'run', 'run-old', 2, 'new-message', 'old-message', 'run.running', 1, '{}', '2026-07-12T00:00:01Z')",
        [],
    ).is_err());
    assert!(connection.execute(
        "INSERT INTO runtime_events (run_id, run_sequence, aggregate_type, aggregate_id, aggregate_sequence, message_id, idempotency_key, event_type, event_version, payload_json, created_at) \
         VALUES ('run-old', 2, 'run', 'run-old', 1, 'new-message-2', 'new-key', 'run.running', 1, '{}', '2026-07-12T00:00:01Z')",
        [],
    ).is_err());
    assert!(
        connection
            .execute("UPDATE runtime_events SET event_type='tampered'", [])
            .is_err()
    );
    assert!(
        connection
            .execute("DELETE FROM runtime_events", [])
            .is_err()
    );
}

#[test]
fn rejects_a_tampered_migration_checksum() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let connection = Connection::open(&fixture.database_path).unwrap();
    connection
        .execute(
            "UPDATE runtime_schema_migrations SET checksum = ?1 WHERE version = 1",
            ["0".repeat(64)],
        )
        .unwrap();
    drop(connection);
    assert!(matches!(
        EventJournal::open(&fixture.database_path),
        Err(EventJournalError::MigrationChecksumMismatch { version: 1 })
    ));
}

#[test]
fn schema_integrity_gate_rejects_a_missing_immutable_trigger() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let connection = Connection::open(&fixture.database_path).unwrap();
    connection
        .execute_batch("DROP TRIGGER runtime_events_no_delete;")
        .unwrap();
    drop(connection);
    assert_schema_integrity_failure(&fixture);
}

#[test]
fn schema_integrity_gate_rejects_a_replaced_index() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let connection = Connection::open(&fixture.database_path).unwrap();
    connection
        .execute_batch(
            "DROP INDEX runtime_events_run_type_order; \
         CREATE INDEX runtime_events_run_type_order ON runtime_events (event_type);",
        )
        .unwrap();
    drop(connection);
    assert_schema_integrity_failure(&fixture);
}

#[test]
fn schema_integrity_gate_rejects_a_table_with_missing_columns() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let connection = Connection::open(&fixture.database_path).unwrap();
    connection.execute_batch(
        "DROP TRIGGER runtime_events_no_update; \
         DROP TRIGGER runtime_events_no_delete; \
         DROP TABLE runtime_events; \
         CREATE TABLE runtime_events (run_id TEXT NOT NULL, run_sequence INTEGER NOT NULL, PRIMARY KEY (run_id, run_sequence)) STRICT;",
    ).unwrap();
    drop(connection);
    assert_schema_integrity_failure(&fixture);
}

fn assert_schema_integrity_failure(fixture: &Fixture) {
    assert!(matches!(
        EventJournal::open(&fixture.database_path),
        Err(EventJournalError::SchemaIntegrityFailed)
    ));
}

fn event(
    run_id: &str,
    aggregate_type: &str,
    aggregate_id: &str,
    message_id: &str,
    idempotency_key: &str,
    value: u64,
) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: aggregate_type.to_owned(),
        aggregate_id: aggregate_id.to_owned(),
        message_id: message_id.to_owned(),
        idempotency_key: idempotency_key.to_owned(),
        event_type: "test.event".to_owned(),
        event_version: 1,
        payload: json!({ "value": value }),
        created_at: "2026-07-12T00:00:00Z".to_owned(),
    }
}

struct Fixture {
    _temp: TempDir,
    database_path: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let database_path = temp.path().join("runtime-events.db");
        Self {
            _temp: temp,
            database_path,
        }
    }

    fn open(&self) -> EventJournal {
        EventJournal::open(&self.database_path).unwrap()
    }
}
