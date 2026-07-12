mod support;

use novelx_runtime::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate, RunAggregateError};
use novelx_runtime::run_state::{RunState, TransitionError};
use serde_json::json;
use support::pinned_identity;
use tempfile::TempDir;

#[test]
fn persists_transitions_and_recovers_after_reopening_sqlite() {
    let fixture = Fixture::new();
    let (expected_state, expected_sequence) = {
        let mut journal = fixture.open();
        let mut run = RunAggregate::create(
            &mut journal,
            "run-1",
            pinned_identity(),
            metadata("message-1", None),
        )
        .unwrap();
        run.prepare(&mut journal, metadata("message-2", None))
            .unwrap();
        run.start(&mut journal, metadata("message-3", None))
            .unwrap();
        run.wait_for_approval(&mut journal, metadata("message-4", Some("needs review")))
            .unwrap();
        run.begin_commit(&mut journal, metadata("message-5", Some("approved")))
            .unwrap();
        run.complete(&mut journal, metadata("message-6", None))
            .unwrap();
        (run.state(), run.last_sequence())
    };

    let journal = fixture.open();
    let recovered = RunAggregate::recover(&journal, "run-1").unwrap();
    assert_eq!(recovered.state(), expected_state);
    assert_eq!(recovered.pinned_identity(), &pinned_identity());
    assert_eq!(recovered.last_sequence(), expected_sequence);
    assert_eq!(expected_state, RunState::Completed);
    assert_eq!(expected_sequence, 6);

    let events = journal.read_aggregate("run-1", "run", "run-1", 0).unwrap();
    assert_eq!(
        events[0].payload,
        json!({
            "previousState": null,
            "currentState": "created",
            "reason": null,
            "pinnedIdentity": serde_json::to_value(pinned_identity()).unwrap(),
        })
    );
    assert_eq!(
        events[3].payload,
        json!({
            "previousState": "running",
            "currentState": "waiting_for_approval",
            "reason": "needs review",
        })
    );
}

#[test]
fn stable_start_idempotency_recovers_the_current_run_without_a_second_creation() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        let mut run = RunAggregate::create(
            &mut journal,
            "run-1",
            pinned_identity(),
            EventMetadata {
                message_id: "transport-1",
                idempotency_key: "start-key-1",
                created_at: "2026-07-12T00:00:00Z",
                reason: None,
            },
        )
        .unwrap();
        run.prepare(&mut journal, metadata("prepare-1", None))
            .unwrap();
    }

    let mut journal = fixture.open();
    let retried = RunAggregate::create(
        &mut journal,
        "run-1",
        pinned_identity(),
        EventMetadata {
            message_id: "transport-retry",
            idempotency_key: "start-key-1",
            created_at: "2026-07-12T00:05:00Z",
            reason: None,
        },
    )
    .unwrap();

    assert_eq!(retried.state(), RunState::Preparing);
    assert_eq!(retried.last_sequence(), 2);
    assert_eq!(journal.read_run("run-1", 0).unwrap().len(), 2);
}

#[test]
fn stable_start_key_rejects_any_changed_pinned_identity_without_writing() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    RunAggregate::create(
        &mut journal,
        "run-1",
        pinned_identity(),
        EventMetadata {
            message_id: "transport-1",
            idempotency_key: "start-key-1",
            created_at: "2026-07-12T00:00:00Z",
            reason: None,
        },
    )
    .unwrap();

    let mut changed = pinned_identity();
    changed.provider.model_id = "deepseek-reasoner".to_owned();
    let error = RunAggregate::create(
        &mut journal,
        "run-1",
        changed,
        EventMetadata {
            message_id: "transport-2",
            idempotency_key: "start-key-1",
            created_at: "2026-07-12T00:01:00Z",
            reason: None,
        },
    )
    .unwrap_err();

    assert!(matches!(
        error,
        RunAggregateError::Journal(EventJournalError::IdempotencyConflict { .. })
    ));
    assert_eq!(journal.read_run("run-1", 0).unwrap().len(), 1);
}

#[test]
fn rejects_unsorted_scope_and_unknown_transition_versions() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut invalid = pinned_identity();
    invalid.scope_resource_ids.reverse();
    assert!(matches!(
        RunAggregate::create(
            &mut journal,
            "run-invalid",
            invalid,
            metadata("message-invalid", None)
        ),
        Err(RunAggregateError::InvalidPinnedIdentity("scopeResourceIds"))
    ));
    assert!(journal.read_run("run-invalid", 0).unwrap().is_empty());

    RunAggregate::create(
        &mut journal,
        "run-1",
        pinned_identity(),
        metadata("message-1", None),
    )
    .unwrap();
    journal
        .append(
            NewRuntimeEvent {
                run_id: "run-1".to_owned(),
                aggregate_type: "run".to_owned(),
                aggregate_id: "run-1".to_owned(),
                message_id: "message-2".to_owned(),
                idempotency_key: "message-2".to_owned(),
                event_type: "run.preparing".to_owned(),
                event_version: 99,
                payload: transition_payload("created", "preparing"),
                created_at: "2026-07-12T00:00:01Z".to_owned(),
            },
            1,
            1,
        )
        .unwrap();
    assert!(matches!(
        RunAggregate::recover(&journal, "run-1"),
        Err(RunAggregateError::UnknownEventVersion { version: 99, .. })
    ));
}

#[test]
fn illegal_or_second_terminal_transition_writes_nothing() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut run = RunAggregate::create(
        &mut journal,
        "run-1",
        pinned_identity(),
        metadata("message-1", None),
    )
    .unwrap();

    assert!(matches!(
        run.complete(&mut journal, metadata("message-2", None)),
        Err(RunAggregateError::Transition(
            TransitionError::IllegalTransition { .. }
        ))
    ));
    assert_eq!(run.last_sequence(), 1);
    assert_eq!(journal.read_run("run-1", 0).unwrap().len(), 1);

    run.cancel(&mut journal, metadata("message-3", Some("user request")))
        .unwrap();
    assert!(matches!(
        run.fail(&mut journal, metadata("message-4", None)),
        Err(RunAggregateError::Transition(
            TransitionError::TerminalState { .. }
        ))
    ));
    assert_eq!(run.state(), RunState::Cancelled);
    assert_eq!(run.last_sequence(), 2);
    assert_eq!(journal.read_run("run-1", 0).unwrap().len(), 2);
}

#[test]
fn duplicate_creation_message_and_stale_aggregate_fail_closed() {
    let fixture = Fixture::new();
    let mut first_journal = fixture.open();
    let mut first = RunAggregate::create(
        &mut first_journal,
        "run-1",
        pinned_identity(),
        metadata("message-1", None),
    )
    .unwrap();

    let duplicate = RunAggregate::create(
        &mut first_journal,
        "run-1",
        pinned_identity(),
        metadata("message-other", None),
    )
    .unwrap_err();
    assert!(matches!(
        duplicate,
        RunAggregateError::Journal(EventJournalError::RunSequenceConflict {
            expected: 0,
            actual: 1
        })
    ));

    let mut second_journal = fixture.open();
    let mut stale = RunAggregate::recover(&second_journal, "run-1").unwrap();
    first
        .prepare(&mut first_journal, metadata("message-2", None))
        .unwrap();
    let stale_result = stale
        .prepare(&mut second_journal, metadata("message-3", None))
        .unwrap_err();
    assert!(matches!(
        stale_result,
        RunAggregateError::Journal(EventJournalError::RunSequenceConflict {
            expected: 1,
            actual: 2
        })
    ));
    assert_eq!(stale.state(), RunState::Created);
}

#[test]
fn replay_rejects_unknown_duplicate_and_mismatched_events() {
    let cases = [
        "unknown",
        "duplicate_created",
        "mismatched_state",
        "missing_previous_state",
        "unknown_replaces_previous_state",
        "extra_unknown_key",
    ];
    for case in cases {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        RunAggregate::create(
            &mut journal,
            "run-1",
            pinned_identity(),
            metadata("message-1", None),
        )
        .unwrap();
        let (event_type, payload) = match case {
            "unknown" => ("run.future", transition_payload("created", "running")),
            "duplicate_created" => ("run.created", transition_payload("created", "created")),
            "mismatched_state" => ("run.running", transition_payload("preparing", "running")),
            "missing_previous_state" => (
                "run.running",
                json!({ "currentState": "running", "reason": null }),
            ),
            "unknown_replaces_previous_state" => (
                "run.running",
                json!({ "unknown": "created", "currentState": "running", "reason": null }),
            ),
            "extra_unknown_key" => (
                "run.running",
                json!({
                    "previousState": "created",
                    "currentState": "running",
                    "reason": null,
                    "unknown": true,
                }),
            ),
            _ => unreachable!(),
        };
        journal
            .append(
                NewRuntimeEvent {
                    run_id: "run-1".to_owned(),
                    aggregate_type: "run".to_owned(),
                    aggregate_id: "run-1".to_owned(),
                    message_id: "message-2".to_owned(),
                    idempotency_key: "message-2".to_owned(),
                    event_type: event_type.to_owned(),
                    event_version: 1,
                    payload,
                    created_at: "2026-07-12T00:00:01Z".to_owned(),
                },
                1,
                1,
            )
            .unwrap();

        let result = RunAggregate::recover(&journal, "run-1").unwrap_err();
        match case {
            "unknown" => assert!(matches!(result, RunAggregateError::UnknownEvent(_))),
            "duplicate_created" => assert!(matches!(result, RunAggregateError::DuplicateCreated)),
            "mismatched_state" => assert!(matches!(result, RunAggregateError::StateMismatch)),
            "missing_previous_state" | "unknown_replaces_previous_state" | "extra_unknown_key" => {
                assert!(matches!(result, RunAggregateError::InvalidPayload))
            }
            _ => unreachable!(),
        }
    }
}

fn metadata<'a>(message_id: &'a str, reason: Option<&'a str>) -> EventMetadata<'a> {
    EventMetadata {
        message_id,
        idempotency_key: message_id,
        created_at: "2026-07-12T00:00:00Z",
        reason,
    }
}

fn transition_payload(previous: &str, current: &str) -> serde_json::Value {
    json!({ "previousState": previous, "currentState": current, "reason": null })
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

    fn open(&self) -> EventJournal {
        EventJournal::open(&self.database_path).unwrap()
    }
}
