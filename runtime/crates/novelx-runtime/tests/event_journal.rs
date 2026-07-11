use novelx_runtime::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent};
use rusqlite::Connection;
use serde_json::json;
use tempfile::TempDir;

#[test]
fn appends_monotonic_events_per_run_and_reads_them_in_order() {
    let fixture = Fixture::new();
    let mut journal = EventJournal::open(&fixture.database_path).expect("open journal");

    let run_a_1 = journal
        .append(event("run-a", "message-a-1", "turn.started", 1))
        .unwrap();
    let run_b_1 = journal
        .append(event("run-b", "message-b-1", "turn.started", 2))
        .unwrap();
    let run_a_2 = journal
        .append(event("run-a", "message-a-2", "tool.started", 3))
        .unwrap();

    assert_eq!(run_a_1.sequence, 1);
    assert_eq!(run_b_1.sequence, 1);
    assert_eq!(run_a_2.sequence, 2);
    let events = journal.read_run("run-a").unwrap();
    assert_eq!(events, vec![run_a_1, run_a_2]);
}

#[test]
fn duplicate_message_id_is_idempotent_and_returns_the_original_event() {
    let fixture = Fixture::new();
    let mut journal = EventJournal::open(&fixture.database_path).expect("open journal");
    let original = journal
        .append(event("run-a", "same-message", "turn.started", 1))
        .unwrap();

    let duplicate = journal
        .append(event("run-a", "same-message", "turn.started", 1))
        .unwrap();

    assert_eq!(duplicate, original);
    assert_eq!(journal.read_run("run-a").unwrap(), vec![original]);
}

#[test]
fn duplicate_message_id_with_different_semantics_is_rejected_without_writing() {
    let fixture = Fixture::new();
    let mut journal = EventJournal::open(&fixture.database_path).expect("open journal");
    let original = journal
        .append(event("run-a", "same-message", "turn.started", 1))
        .unwrap();

    let conflict = journal
        .append(event("different-run", "same-message", "different.type", 99))
        .unwrap_err();

    assert!(matches!(
        conflict,
        EventJournalError::MessageIdConflict { message_id } if message_id == "same-message"
    ));
    assert_eq!(journal.read_run("run-a").unwrap(), vec![original]);
    assert!(journal.read_run("different-run").unwrap().is_empty());
}

#[test]
fn concurrent_connections_keep_each_run_sequence_unique_and_monotonic() {
    let fixture = Fixture::new();
    EventJournal::open(&fixture.database_path).expect("initialize journal");
    let handles = (0..8)
        .map(|index| {
            let database_path = fixture.database_path.clone();
            std::thread::spawn(move || {
                let mut journal =
                    EventJournal::open(database_path).expect("open concurrent journal");
                journal
                    .append(event(
                        "run-concurrent",
                        &format!("message-{index}"),
                        "tool.completed",
                        index,
                    ))
                    .expect("append concurrent event")
            })
        })
        .collect::<Vec<_>>();
    for handle in handles {
        handle.join().expect("join append thread");
    }

    let journal = EventJournal::open(&fixture.database_path).expect("reopen journal");
    let events = journal.read_run("run-concurrent").unwrap();
    assert_eq!(events.len(), 8);
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        (1..=8).collect::<Vec<u64>>()
    );
}

#[test]
fn update_and_delete_are_rejected_by_the_database() {
    let fixture = Fixture::new();
    {
        let mut journal = EventJournal::open(&fixture.database_path).expect("open journal");
        journal
            .append(event("run-a", "message-a-1", "turn.started", 1))
            .unwrap();
    }
    let connection = Connection::open(&fixture.database_path).unwrap();

    let update = connection.execute(
        "UPDATE runtime_events SET event_type = 'tampered' WHERE message_id = 'message-a-1'",
        [],
    );
    let delete = connection.execute(
        "DELETE FROM runtime_events WHERE message_id = 'message-a-1'",
        [],
    );

    assert!(
        update
            .unwrap_err()
            .to_string()
            .contains("RUNTIME_EVENT_IMMUTABLE")
    );
    assert!(
        delete
            .unwrap_err()
            .to_string()
            .contains("RUNTIME_EVENT_IMMUTABLE")
    );
}

fn event(run_id: &str, message_id: &str, event_type: &str, value: u64) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: run_id.to_owned(),
        message_id: message_id.to_owned(),
        event_type: event_type.to_owned(),
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
        let temp = tempfile::tempdir().expect("create temporary directory");
        let database_path = temp.path().join("runtime-events.db");
        Self {
            _temp: temp,
            database_path,
        }
    }
}
