use novelx_runtime::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate};
use novelx_runtime::tool_aggregate::{
    ToolAggregateError, ToolCallAggregate, ToolCallDefinition, ToolEventMetadata,
};
use novelx_runtime::tool_state::{
    ToolAuthorization, ToolOutcomeKnowledge, ToolRetryError, ToolSideEffect, ToolState,
};
use serde_json::json;
use tempfile::TempDir;

const ARGUMENTS_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn persists_all_transitions_and_recovers_after_reopening_sqlite() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        let mut tool = ToolCallAggregate::create(
            &mut journal,
            "run-1",
            "tool-1",
            definition(ToolSideEffect::StagedWrite),
            0,
            metadata("message-1", None),
        )
        .unwrap();
        tool.require_authorization(
            &mut journal,
            1,
            metadata("message-2", Some("review required")),
        )
        .unwrap();
        tool.authorize(&mut journal, 2, metadata("message-3", None))
            .unwrap();
        tool.start(&mut journal, 3, metadata("message-4", None))
            .unwrap();
        tool.complete(&mut journal, 4, metadata("message-5", None))
            .unwrap();
    }

    let journal = fixture.open();
    let recovered = ToolCallAggregate::recover(&journal, "run-1", "tool-1").unwrap();
    assert_eq!(recovered.state(), ToolState::Completed);
    assert_eq!(recovered.authorization(), ToolAuthorization::Allowed);
    assert_eq!(recovered.aggregate_sequence(), 5);
    assert_eq!(
        recovered.outcome_knowledge(),
        Some(ToolOutcomeKnowledge::Known)
    );
    let events = journal
        .read_aggregate("run-1", "tool", "tool-1", 0)
        .unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec![
            "tool.requested",
            "tool.authorization_required",
            "tool.authorized",
            "tool.started",
            "tool.completed",
        ]
    );
    assert_eq!(
        events[1].payload,
        json!({
            "previousState": "requested", "currentState": "requested", "authorization": "approval_required",
            "sideEffect": "staged_write", "outcomeKnowledge": null, "reason": "review required",
            "toolName": "project_file.put", "schemaVersion": 2, "argumentsHash": ARGUMENTS_HASH, "attempt": 1, "parallel": false,
        })
    );
}

#[test]
fn interleaves_with_run_events_while_preserving_run_and_aggregate_sequences() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut run =
        RunAggregate::create(&mut journal, "run-1", run_metadata("run-message-1")).unwrap();
    run.prepare(&mut journal, run_metadata("run-message-2"))
        .unwrap();
    let mut tool = ToolCallAggregate::create(
        &mut journal,
        "run-1",
        "tool-1",
        definition(ToolSideEffect::None),
        2,
        metadata("tool-message-1", None),
    )
    .unwrap();
    let mut run = RunAggregate::recover(&journal, "run-1").unwrap();
    run.start(&mut journal, run_metadata("run-message-3"))
        .unwrap();
    tool.authorize(&mut journal, 4, metadata("tool-message-2", None))
        .unwrap();

    let run_events = journal.read_run("run-1", 0).unwrap();
    assert_eq!(
        run_events
            .iter()
            .map(|event| event.run_sequence)
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5]
    );
    assert_eq!(
        journal
            .read_aggregate("run-1", "run", "run-1", 0)
            .unwrap()
            .iter()
            .map(|event| event.aggregate_sequence)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(
        journal
            .read_aggregate("run-1", "tool", "tool-1", 0)
            .unwrap()
            .iter()
            .map(|event| event.aggregate_sequence)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
}

#[test]
fn journal_failure_does_not_mutate_candidate_state() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut tool = ToolCallAggregate::create(
        &mut journal,
        "run-1",
        "tool-1",
        definition(ToolSideEffect::None),
        0,
        metadata("message-1", None),
    )
    .unwrap();

    assert!(
        tool.authorize(&mut journal, 99, metadata("message-2", None))
            .is_err()
    );
    assert_eq!(tool.state(), ToolState::Requested);
    assert_eq!(tool.authorization(), ToolAuthorization::Pending);
    assert_eq!(tool.aggregate_sequence(), 1);
}

#[test]
fn stable_idempotency_key_returns_the_same_event_and_rejects_conflicting_semantics() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let stable_metadata =
        metadata_with_key("transport-message-1", "tool-request-operation-1", None);
    let first = ToolCallAggregate::create(
        &mut journal,
        "run-1",
        "tool-1",
        definition(ToolSideEffect::None),
        0,
        stable_metadata,
    )
    .unwrap();
    let duplicate = ToolCallAggregate::create(
        &mut journal,
        "run-1",
        "tool-1",
        definition(ToolSideEffect::None),
        0,
        metadata_with_key_at(
            "transport-message-2",
            "tool-request-operation-1",
            "2026-07-12T00:00:01Z",
            None,
        ),
    )
    .unwrap();
    assert_eq!(duplicate, first);
    let stored = journal
        .read_aggregate("run-1", "tool", "tool-1", 0)
        .unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].message_id, "transport-message-1");
    assert_eq!(stored[0].idempotency_key, "tool-request-operation-1");

    let mut conflicting_definition = definition(ToolSideEffect::None);
    conflicting_definition.tool_name = "different.tool".to_owned();
    let conflict = ToolCallAggregate::create(
        &mut journal,
        "run-1",
        "tool-1",
        conflicting_definition,
        0,
        metadata_with_key_at(
            "transport-message-3",
            "tool-request-operation-1",
            "2026-07-12T00:00:02Z",
            None,
        ),
    )
    .unwrap_err();
    assert!(matches!(
        conflict,
        ToolAggregateError::Journal(EventJournalError::IdempotencyConflict { idempotency_key })
            if idempotency_key == "tool-request-operation-1"
    ));
    assert_eq!(
        journal
            .read_aggregate("run-1", "tool", "tool-1", 0)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn rejects_arguments_hashes_that_are_not_lowercase_sha256() {
    for invalid_hash in [
        "abc123",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
    ] {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        let mut invalid = definition(ToolSideEffect::None);
        invalid.arguments_hash = invalid_hash.to_owned();

        let result = ToolCallAggregate::create(
            &mut journal,
            "run-1",
            "tool-1",
            invalid,
            0,
            metadata_with_key("message-1", "operation-1", None),
        );

        assert!(matches!(result, Err(ToolAggregateError::InvalidPayload)));
        assert!(
            journal
                .read_aggregate("run-1", "tool", "tool-1", 0)
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn external_effect_unknown_outcome_remains_not_auto_retryable_after_recovery() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        let mut tool = ToolCallAggregate::create(
            &mut journal,
            "run-1",
            "tool-1",
            definition(ToolSideEffect::ExternalEffect),
            0,
            metadata("message-1", None),
        )
        .unwrap();
        tool.authorize(&mut journal, 1, metadata("message-2", None))
            .unwrap();
        tool.start(&mut journal, 2, metadata("message-3", None))
            .unwrap();
        tool.fail(
            &mut journal,
            3,
            ToolOutcomeKnowledge::Unknown,
            metadata("message-4", Some("provider disconnected")),
        )
        .unwrap();
    }
    let journal = fixture.open();
    let recovered = ToolCallAggregate::recover(&journal, "run-1", "tool-1").unwrap();
    assert_eq!(recovered.state(), ToolState::Failed);
    assert_eq!(
        recovered.outcome_knowledge(),
        Some(ToolOutcomeKnowledge::Unknown)
    );
    assert_eq!(
        recovered.ensure_auto_retry_allowed(),
        Err(ToolRetryError::ExternalEffectOutcomeUnknown)
    );
}

#[test]
fn writes_and_replays_denied_cancelled_and_timed_out_terminal_events() {
    for case in ["denied", "cancelled", "timed_out"] {
        let fixture = Fixture::new();
        {
            let mut journal = fixture.open();
            let mut tool = ToolCallAggregate::create(
                &mut journal,
                "run-1",
                "tool-1",
                definition(ToolSideEffect::None),
                0,
                metadata("message-1", None),
            )
            .unwrap();
            match case {
                "denied" => tool
                    .deny(&mut journal, 1, metadata("message-2", Some("policy")))
                    .unwrap(),
                "cancelled" => tool
                    .cancel(&mut journal, 1, metadata("message-2", Some("user")))
                    .unwrap(),
                "timed_out" => {
                    tool.authorize(&mut journal, 1, metadata("message-2", None))
                        .unwrap();
                    tool.start(&mut journal, 2, metadata("message-3", None))
                        .unwrap();
                    tool.time_out(
                        &mut journal,
                        3,
                        ToolOutcomeKnowledge::Unknown,
                        metadata("message-4", Some("deadline")),
                    )
                    .unwrap();
                }
                _ => unreachable!(),
            }
        }
        let journal = fixture.open();
        let recovered = ToolCallAggregate::recover(&journal, "run-1", "tool-1").unwrap();
        let expected = match case {
            "denied" => ToolState::Denied,
            "cancelled" => ToolState::Cancelled,
            "timed_out" => ToolState::TimedOut,
            _ => unreachable!(),
        };
        assert_eq!(recovered.state(), expected);
        let terminal_event = journal
            .read_aggregate("run-1", "tool", "tool-1", 0)
            .unwrap()
            .last()
            .unwrap()
            .event_type
            .clone();
        assert_eq!(terminal_event, format!("tool.{case}"));
    }
}

#[test]
fn recovery_rejects_unknown_version_event_malformed_payload_and_second_terminal() {
    for case in [
        "unknown_version",
        "unknown_event",
        "malformed",
        "second_terminal",
    ] {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        let mut tool = ToolCallAggregate::create(
            &mut journal,
            "run-1",
            "tool-1",
            definition(ToolSideEffect::None),
            0,
            metadata("message-1", None),
        )
        .unwrap();
        tool.authorize(&mut journal, 1, metadata("message-2", None))
            .unwrap();
        tool.start(&mut journal, 2, metadata("message-3", None))
            .unwrap();
        tool.complete(&mut journal, 3, metadata("message-4", None))
            .unwrap();
        let mut payload = journal
            .read_aggregate("run-1", "tool", "tool-1", 0)
            .unwrap()
            .last()
            .unwrap()
            .payload
            .clone();
        let (event_type, event_version) = match case {
            "unknown_version" => ("tool.failed", 2),
            "unknown_event" => ("tool.future", 1),
            "malformed" => {
                payload
                    .as_object_mut()
                    .unwrap()
                    .insert("extra".to_owned(), json!(true));
                ("tool.failed", 1)
            }
            "second_terminal" => ("tool.failed", 1),
            _ => unreachable!(),
        };
        payload["previousState"] = json!("completed");
        payload["currentState"] = json!("failed");
        payload["outcomeKnowledge"] = json!("known");
        journal
            .append(
                NewRuntimeEvent {
                    run_id: "run-1".to_owned(),
                    aggregate_type: "tool".to_owned(),
                    aggregate_id: "tool-1".to_owned(),
                    message_id: "message-5".to_owned(),
                    idempotency_key: "message-5".to_owned(),
                    event_type: event_type.to_owned(),
                    event_version,
                    payload,
                    created_at: "2026-07-12T00:00:01Z".to_owned(),
                },
                4,
                4,
            )
            .unwrap();

        let error = ToolCallAggregate::recover(&journal, "run-1", "tool-1").unwrap_err();
        match case {
            "unknown_version" => {
                assert!(matches!(error, ToolAggregateError::UnknownEventVersion(2)))
            }
            "unknown_event" => assert!(matches!(error, ToolAggregateError::UnknownEvent(_))),
            "malformed" => assert!(matches!(error, ToolAggregateError::InvalidPayload)),
            "second_terminal" => assert!(matches!(error, ToolAggregateError::Transition(_))),
            _ => unreachable!(),
        }
    }
}

fn definition(side_effect: ToolSideEffect) -> ToolCallDefinition {
    ToolCallDefinition {
        tool_name: "project_file.put".to_owned(),
        schema_version: 2,
        arguments_hash: ARGUMENTS_HASH.to_owned(),
        attempt: 1,
        side_effect,
        parallel: false,
    }
}

fn metadata<'a>(message_id: &'a str, reason: Option<&'a str>) -> ToolEventMetadata<'a> {
    metadata_with_key(message_id, message_id, reason)
}

fn metadata_with_key<'a>(
    message_id: &'a str,
    idempotency_key: &'a str,
    reason: Option<&'a str>,
) -> ToolEventMetadata<'a> {
    metadata_with_key_at(message_id, idempotency_key, "2026-07-12T00:00:00Z", reason)
}

fn metadata_with_key_at<'a>(
    message_id: &'a str,
    idempotency_key: &'a str,
    created_at: &'a str,
    reason: Option<&'a str>,
) -> ToolEventMetadata<'a> {
    ToolEventMetadata {
        message_id,
        idempotency_key,
        created_at,
        reason,
    }
}

fn run_metadata(message_id: &str) -> EventMetadata<'_> {
    EventMetadata {
        message_id,
        created_at: "2026-07-12T00:00:00Z",
        reason: None,
    }
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
