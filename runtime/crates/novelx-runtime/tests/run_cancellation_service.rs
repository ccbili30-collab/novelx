mod support;

use std::sync::{Arc, Barrier};
use std::thread;

use novelx_protocol::{MAX_SAFE_SEQUENCE, RunReconciliationDecision};
use novelx_runtime::event_journal::{EventJournal, GlobalEventOrder, RuntimeEvent};
use novelx_runtime::run_aggregate::{
    EventMetadata, RunAggregate, RunAggregateError, RunCancellationState,
};
use novelx_runtime::run_cancellation_service::{
    RunCancellationRecordOutcome, RunCancellationService, RunCancellationServiceError,
    run_cancellation_intent_event_sha256,
};
use novelx_runtime::run_state::RunState;
use novelx_runtime::workspace_event_journal::WorkspaceEventJournal;
use novelx_runtime::workspace_runtime_lease::{BoundWorkspaceRuntimeLease, WorkspaceRuntimeLease};
use rusqlite::{Connection, ErrorCode};
use serde_json::json;
use support::pinned_identity;
use tempfile::TempDir;

const WORKSPACE_ID: &str = "workspace-1";
const PROJECT_ID: &str = "project-1";
const REASON: &str = "Stop before another Provider request.";
const MIGRATION_0005: &str = include_str!("../migrations/0005_global_event_clock.sql");

#[test]
fn record_intent_returns_an_exact_durable_proof_and_semantic_retry_reuses_it() {
    let fixture = Fixture::new();
    fixture.running_run("run-record");
    let service = fixture.service();
    let before = fixture.global_sequence();

    let first_outcome = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-record",
            "cancel-key-1",
            REASON,
            "cancel-command-1",
            "2026-07-13T10:00:00Z",
        )
        .unwrap();
    assert!(first_outcome.is_active());
    let first = first_outcome.proof().clone();
    assert_eq!(fixture.global_sequence(), before + 1);
    assert_eq!(first.workspace_id(), WORKSPACE_ID);
    assert_eq!(first.project_id(), PROJECT_ID);
    assert_eq!(first.run_id(), "run-record");
    assert_eq!(first.intent().reason(), REASON);
    assert_eq!(first.intent_event_run_sequence(), 4);
    assert_eq!(first.intent_event_aggregate_sequence(), 4);
    assert_eq!(first.intent_event_global_sequence(), before + 1);
    assert_eq!(first.intent_event_sha256().len(), 64);
    assert_eq!(first.pinned_identity_sha256().len(), 64);
    assert_eq!(first.database_canonical_path_sha256().len(), 64);
    assert_eq!(first.database_instance_id().len(), 36);
    assert_eq!(first.lease_owner_id(), fixture.lease.owner_id());
    assert_eq!(first.lease_epoch(), fixture.lease.lease_epoch());
    assert_eq!(first.database_file_identity_sha256().len(), 64);
    assert_eq!(
        first.database_file_identity_sha256(),
        fixture.lease.database_file_identity_sha256()
    );

    let retry = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-record",
            "cancel-key-1",
            REASON,
            "transport-retry-must-not-replace-the-command",
            "2026-07-13T10:10:00Z",
        )
        .unwrap();
    assert!(retry.is_active());
    assert_eq!(retry.proof(), &first);
    assert_eq!(fixture.global_sequence(), before + 1);

    let journal = EventJournal::open(&fixture.database).unwrap();
    let exact = journal
        .read_run("run-record", 0)
        .unwrap()
        .into_iter()
        .find(|event| event.event_type == "run.cancellation_intent_recorded")
        .unwrap();
    assert_eq!(
        run_cancellation_intent_event_sha256(&exact).unwrap(),
        first.intent_event_sha256()
    );
    assert_eq!(exact.message_id, "cancel-command-1");
    assert_eq!(exact.created_at, "2026-07-13T10:00:00Z");
    assert_eq!(
        journal.global_order_for_message(&exact.message_id).unwrap(),
        Some(GlobalEventOrder::Ordered(
            first.intent_event_global_sequence()
        ))
    );
    assert_eq!(journal.database_instance_id(), first.database_instance_id());
}

#[test]
fn global_cas_entry_supports_a2_states_but_committing_does_not_self_settle() {
    for state in [
        RunState::Created,
        RunState::Preparing,
        RunState::Running,
        RunState::WaitingForApproval,
        RunState::Retrying,
        RunState::Committing,
    ] {
        let fixture = Fixture::new();
        fixture.run_at_state("run-a2-state", state);
        let service = fixture.service();
        let outcome = service
            .record_intent(
                WORKSPACE_ID,
                PROJECT_ID,
                "run-a2-state",
                "cancel-state-key",
                REASON,
                "cancel-state-command",
                "2026-07-13T10:00:00Z",
            )
            .unwrap();
        let proof = outcome.proof();
        assert_eq!(proof.intent().run_id(), "run-a2-state");
        let journal = EventJournal::open(&fixture.database).unwrap();
        let recovered = RunAggregate::recover(&journal, "run-a2-state").unwrap();
        assert_eq!(recovered.state(), state);
        assert_eq!(
            recovered.cancellation_state(),
            RunCancellationState::IntentRecorded
        );
        assert!(!recovered.permits_new_side_effects());
        if state == RunState::Committing {
            assert_ne!(recovered.state(), RunState::Cancelled);
        }
    }

    for state in [
        RunState::WaitingForReconciliation,
        RunState::Blocked,
        RunState::Cancelled,
        RunState::Failed,
        RunState::Completed,
    ] {
        let fixture = Fixture::new();
        fixture.run_at_state("run-a2-rejected", state);
        let service = fixture.service();
        let result = service.record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-a2-rejected",
            "cancel-rejected-key",
            REASON,
            "cancel-rejected-command",
            "2026-07-13T10:00:00Z",
        );
        assert!(matches!(
            result,
            Err(RunCancellationServiceError::Run(
                RunAggregateError::CancellationRunStateInvalid(actual)
                    | RunAggregateError::CancellationRunTerminal(actual)
            )) if actual == state
        ));
    }
}

#[test]
fn proof_recovery_scan_and_write_fence_require_the_same_stable_database_and_active_intent() {
    let fixture = Fixture::new();
    fixture.running_run("run-active-a");
    fixture.running_run("run-active-b");
    let service = fixture.service();
    let outcome = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-active-a",
            "cancel-a",
            REASON,
            "cancel-a-command",
            "2026-07-13T11:00:00Z",
        )
        .unwrap();
    let proof = outcome.proof().clone();

    assert_eq!(
        service.recover_active_intent("run-active-a").unwrap(),
        Some(proof.clone())
    );
    assert_eq!(service.recover_active_intent("run-active-b").unwrap(), None);
    assert_eq!(
        service
            .scan_active_intents(WORKSPACE_ID, PROJECT_ID)
            .unwrap(),
        vec![proof.clone()]
    );
    assert!(matches!(
        service.scan_active_intents(WORKSPACE_ID, "wrong-project"),
        Err(RunCancellationServiceError::ProjectMismatch { .. })
    ));
    assert!(matches!(
        service.scan_active_intents("wrong-workspace", PROJECT_ID),
        Err(RunCancellationServiceError::WorkspaceMismatch { .. })
    ));

    let fence = service.refresh_write_fence(&proof).unwrap();
    assert_eq!(fence.proof(), &proof);
    assert_eq!(fence.expected_run_sequence(), 4);
    assert_eq!(fence.expected_run_aggregate_sequence(), 4);
    assert_eq!(fence.expected_global_sequence(), fixture.global_sequence());
    assert_eq!(
        fence.intent_event_global_sequence(),
        proof.intent_event_global_sequence()
    );
    assert_eq!(fence.lease_owner_id(), proof.lease_owner_id());
    assert_eq!(fence.lease_epoch(), proof.lease_epoch());
    assert_eq!(
        fence.database_file_identity_sha256(),
        proof.database_file_identity_sha256()
    );

    let other = Fixture::new();
    other.running_run("run-active-a");
    let foreign = other.service();
    assert!(matches!(
        foreign.refresh_write_fence(&proof),
        Err(RunCancellationServiceError::DatabaseCanonicalPathMismatch)
    ));
}

#[test]
fn constructor_requires_the_exact_bound_database_path_and_maps_missing_files() {
    let fixture = Fixture::new();
    let missing = fixture._temp.path().join("missing.db");
    assert!(matches!(
        RunCancellationService::new(&missing, Arc::clone(&fixture.lease)),
        Err(RunCancellationServiceError::DatabaseFileMissing { path }) if path == missing
    ));

    let other = fixture._temp.path().join("other.db");
    drop(EventJournal::open(&other).unwrap());
    assert!(matches!(
        RunCancellationService::new(&other, Arc::clone(&fixture.lease)),
        Err(RunCancellationServiceError::DatabaseLeasePathMismatch {
            expected,
            actual,
        }) if expected == std::fs::canonicalize(&fixture.database).unwrap()
            && actual == std::fs::canonicalize(&other).unwrap()
    ));
}

#[test]
fn scan_excludes_settled_and_reconciliation_required_cancellations() {
    let fixture = Fixture::new();
    fixture.running_run("run-safe");
    fixture.running_run("run-reconciliation");
    fixture.running_run("run-abandoned");
    fixture.running_run("run-withdrawn");
    let service = fixture.service();
    let safe = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-safe",
            "cancel-safe",
            REASON,
            "cancel-safe-command",
            "2026-07-13T12:00:00Z",
        )
        .unwrap()
        .proof()
        .clone();
    let unknown = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-reconciliation",
            "cancel-reconciliation",
            REASON,
            "cancel-reconciliation-command",
            "2026-07-13T12:01:00Z",
        )
        .unwrap()
        .proof()
        .clone();
    let abandoned = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-abandoned",
            "cancel-abandoned",
            REASON,
            "cancel-abandoned-command",
            "2026-07-13T12:01:10Z",
        )
        .unwrap()
        .proof()
        .clone();
    let withdrawn = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-withdrawn",
            "cancel-withdrawn",
            REASON,
            "cancel-withdrawn-command",
            "2026-07-13T12:01:20Z",
        )
        .unwrap()
        .proof()
        .clone();
    let mut journal = EventJournal::open(&fixture.database).unwrap();
    let mut run = RunAggregate::recover(&journal, "run-safe").unwrap();
    run.mark_cancellation_safe(
        &mut journal,
        safe.intent().intent_id(),
        &"a".repeat(64),
        metadata("run-safe-settled", "2026-07-13T12:02:00Z"),
    )
    .unwrap();
    let mut run = RunAggregate::recover(&journal, "run-reconciliation").unwrap();
    run.mark_cancellation_reconciliation_required(
        &mut journal,
        unknown.intent().intent_id(),
        &"b".repeat(64),
        metadata("run-reconciliation-settled", "2026-07-13T12:03:00Z"),
    )
    .unwrap();
    let mut run = RunAggregate::recover(&journal, "run-abandoned").unwrap();
    run.mark_cancellation_reconciliation_required(
        &mut journal,
        abandoned.intent().intent_id(),
        &"c".repeat(64),
        metadata("run-abandoned-required", "2026-07-13T12:03:10Z"),
    )
    .unwrap();
    run.reconcile(
        &mut journal,
        "attempt-abandoned",
        RunReconciliationDecision::CancelRun,
        false,
        metadata("run-abandoned-final", "2026-07-13T12:04:10Z"),
    )
    .unwrap();
    let mut run = RunAggregate::recover(&journal, "run-withdrawn").unwrap();
    run.mark_cancellation_reconciliation_required(
        &mut journal,
        withdrawn.intent().intent_id(),
        &"d".repeat(64),
        metadata("run-withdrawn-required", "2026-07-13T12:03:20Z"),
    )
    .unwrap();
    run.reconcile(
        &mut journal,
        "attempt-withdrawn",
        RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate,
        true,
        metadata("run-withdrawn-final", "2026-07-13T12:04:20Z"),
    )
    .unwrap();
    drop(journal);

    let global_before_delayed_retries = fixture.global_sequence();
    let delayed_safe = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-safe",
            "cancel-safe",
            REASON,
            "delayed-safe-transport-retry",
            "2026-07-13T12:10:00Z",
        )
        .unwrap();
    assert!(matches!(
        &delayed_safe,
        RunCancellationRecordOutcome::AlreadySettled {
            settlement_state: RunCancellationState::CancelledSafe,
            evidence_sha256,
            ..
        } if evidence_sha256 == &"a".repeat(64)
    ));
    assert_eq!(delayed_safe.proof(), &safe);

    let delayed_unknown = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-reconciliation",
            "cancel-reconciliation",
            REASON,
            "delayed-reconciliation-transport-retry",
            "2026-07-13T12:11:00Z",
        )
        .unwrap();
    assert!(matches!(
        &delayed_unknown,
        RunCancellationRecordOutcome::AlreadySettled {
            settlement_state: RunCancellationState::ReconciliationRequired,
            evidence_sha256,
            ..
        } if evidence_sha256 == &"b".repeat(64)
    ));
    assert_eq!(delayed_unknown.proof(), &unknown);
    let delayed_abandoned = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-abandoned",
            "cancel-abandoned",
            REASON,
            "delayed-abandoned-transport-retry",
            "2026-07-13T12:12:00Z",
        )
        .unwrap();
    assert!(matches!(
        &delayed_abandoned,
        RunCancellationRecordOutcome::AlreadySettled {
            settlement_state: RunCancellationState::AbandonedAfterUnknown,
            evidence_sha256,
            ..
        } if evidence_sha256 == &"c".repeat(64)
    ));
    assert_eq!(delayed_abandoned.proof(), &abandoned);
    let delayed_withdrawn = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-withdrawn",
            "cancel-withdrawn",
            REASON,
            "delayed-withdrawn-transport-retry",
            "2026-07-13T12:13:00Z",
        )
        .unwrap();
    assert!(matches!(
        &delayed_withdrawn,
        RunCancellationRecordOutcome::AlreadySettled {
            settlement_state: RunCancellationState::WithdrawnForRetry,
            evidence_sha256,
            ..
        } if evidence_sha256 == &"d".repeat(64)
    ));
    assert_eq!(delayed_withdrawn.proof(), &withdrawn);
    assert_eq!(fixture.global_sequence(), global_before_delayed_retries);

    assert_eq!(service.recover_active_intent("run-safe").unwrap(), None);
    assert_eq!(
        service.recover_active_intent("run-reconciliation").unwrap(),
        None
    );
    assert_eq!(
        service.recover_active_intent("run-abandoned").unwrap(),
        None
    );
    assert_eq!(
        service.recover_active_intent("run-withdrawn").unwrap(),
        None
    );
    assert!(
        service
            .scan_active_intents(WORKSPACE_ID, PROJECT_ID)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn legacy_cancellation_is_a_typed_fail_closed_blocker() {
    let fixture = Fixture::new();
    let mut run = fixture.running_run("run-legacy");
    let mut journal = EventJournal::open(&fixture.database).unwrap();
    run.request_cancellation_reconciliation(
        &mut journal,
        fixture.lease.as_ref(),
        &["attempt-legacy".to_owned()],
        "legacy unknown result",
        metadata("legacy-request", "2026-07-13T13:00:00Z"),
    )
    .unwrap();
    drop(journal);
    let service = fixture.service();

    assert!(matches!(
        service.record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-legacy",
            "new-cancel",
            REASON,
            "new-cancel-command",
            "2026-07-13T13:01:00Z",
        ),
        Err(RunCancellationServiceError::LegacyCancellationPending)
    ));
    assert!(matches!(
        service.recover_active_intent("run-legacy"),
        Err(RunCancellationServiceError::LegacyCancellationPending)
    ));
    assert!(matches!(
        service.scan_active_intents(WORKSPACE_ID, PROJECT_ID),
        Err(RunCancellationServiceError::LegacyCancellationPending)
    ));
}

#[test]
fn changed_reason_conflicts_and_concurrent_distinct_intents_have_one_winner() {
    let fixture = Fixture::new();
    fixture.running_run("run-conflict");
    let service = fixture.service();
    service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-conflict",
            "same-key",
            REASON,
            "same-command",
            "2026-07-13T14:00:00Z",
        )
        .unwrap();
    assert!(matches!(
        service.record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-conflict",
            "same-key",
            "A changed reason must not replace the first command.",
            "changed-command",
            "2026-07-13T14:01:00Z",
        ),
        Err(RunCancellationServiceError::Run(
            RunAggregateError::CancellationIntentConflict { .. }
        ))
    ));

    fixture.running_run("run-race");
    let gate = Arc::new(Barrier::new(3));
    let mut handles = Vec::new();
    for index in 0..2 {
        let database = fixture.database.clone();
        let lease = Arc::clone(&fixture.lease);
        let gate = Arc::clone(&gate);
        handles.push(thread::spawn(move || {
            let service = RunCancellationService::new(database, lease).unwrap();
            gate.wait();
            service.record_intent(
                WORKSPACE_ID,
                PROJECT_ID,
                "run-race",
                &format!("race-key-{index}"),
                &format!("race reason {index}"),
                &format!("race-command-{index}"),
                "2026-07-13T14:02:00Z",
            )
        }));
    }
    gate.wait();
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
                Err(RunCancellationServiceError::Run(
                    RunAggregateError::CancellationIntentConflict { .. }
                ))
            ))
            .count(),
        1
    );
}

#[test]
fn intent_event_hash_has_a_fixed_recursive_utf8_golden_vector() {
    let event = RuntimeEvent {
        run_id: "run-小说-01".to_owned(),
        run_sequence: 7,
        aggregate_type: "run".to_owned(),
        aggregate_id: "run-小说-01".to_owned(),
        aggregate_sequence: 4,
        message_id: "消息-撤回-01".to_owned(),
        idempotency_key: "run:run-小说-01:cancel-intent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
        event_type: "run.cancellation_intent_recorded".to_owned(),
        event_version: 1,
        payload: json!({
            "zNested": {"β": [3, {"猫": "Snow"}], "a": true},
            "reason": "重写下一幕",
        }),
        created_at: "2026-07-13T15:00:00Z".to_owned(),
    };

    assert_eq!(
        run_cancellation_intent_event_sha256(&event).unwrap(),
        // Independently verified with Node.js over UTF-8 JSON whose recursively sorted material
        // starts with `aggregateId` and ends with `scheme`.
        "bbcd41249b0fd1a44823fce1ad9c8c1b32e59dcd5f4fd7ec41eb071352041077"
    );
    let mut unsafe_for_cross_language_json = event;
    unsafe_for_cross_language_json.run_sequence = MAX_SAFE_SEQUENCE + 1;
    assert!(matches!(
        run_cancellation_intent_event_sha256(&unsafe_for_cross_language_json),
        Err(RunCancellationServiceError::EventEvidenceMismatch)
    ));
}

#[test]
fn intent_event_hash_uses_javascript_utf16_order_for_non_bmp_object_keys() {
    let event = RuntimeEvent {
        run_id: "run-utf16-key-order".to_owned(),
        run_sequence: 8,
        aggregate_type: "run".to_owned(),
        aggregate_id: "run-utf16-key-order".to_owned(),
        aggregate_sequence: 4,
        message_id: "utf16-key-message".to_owned(),
        idempotency_key: format!("run:run-utf16-key-order:cancel-intent:{}", "b".repeat(64)),
        event_type: "run.cancellation_intent_recorded".to_owned(),
        event_version: 1,
        payload: json!({
            "\u{e000}": "bmp-private-use",
            "😀": "non-bmp-grinning-face",
            "nested": {
                "\u{10000}": "first-non-bmp",
                "\u{ffff}": "bmp-last",
            },
        }),
        created_at: "2026-07-13T15:10:00Z".to_owned(),
    };

    // Independently generated by Node.js using recursively sorted Object.keys().sort(),
    // JSON.stringify(), UTF-8 encoding, and SHA-256. These keys distinguish UTF-16 ordering
    // from Unicode scalar ordering at two nesting levels.
    assert_eq!(
        run_cancellation_intent_event_sha256(&event).unwrap(),
        "6168b45c7efce7ee612c1736b7a6d2092494c95b01f2db1f8211b125f3d4995d"
    );
}

#[test]
fn refresh_rejects_a_hash_covered_run_sequence_change_that_run_replay_accepts() {
    let fixture = Fixture::new();
    fixture.running_run("run-tamper");
    let service = fixture.service();
    let outcome = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-tamper",
            "tamper-key",
            REASON,
            "tamper-command",
            "2026-07-13T16:00:00Z",
        )
        .unwrap();
    let proof = outcome.proof().clone();

    let connection = Connection::open(&fixture.database).unwrap();
    connection
        .execute_batch("DROP TRIGGER runtime_events_no_update;")
        .unwrap();
    connection
        .execute(
            "UPDATE runtime_events SET run_sequence = 5 WHERE message_id = ?1",
            ["tamper-command"],
        )
        .unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER runtime_events_no_update BEFORE UPDATE ON runtime_events \
             BEGIN SELECT RAISE(ABORT, 'RUNTIME_EVENT_IMMUTABLE'); END;",
        )
        .unwrap();
    assert!(matches!(
        service.refresh_write_fence(&proof),
        Err(RunCancellationServiceError::ProofMismatch)
    ));
}

#[test]
fn global_order_tamper_or_missing_row_fails_closed_before_proof_refresh() {
    for mutation in [LedgerMutation::ChangeSequence, LedgerMutation::DeleteRow] {
        let fixture = Fixture::new();
        fixture.running_run("run-ledger-proof");
        let service = fixture.service();
        let proof = service
            .record_intent(
                WORKSPACE_ID,
                PROJECT_ID,
                "run-ledger-proof",
                "ledger-proof-key",
                REASON,
                "ledger-proof-command",
                "2026-07-13T16:05:00Z",
            )
            .unwrap()
            .proof()
            .clone();

        let connection = Connection::open(&fixture.database).unwrap();
        match mutation {
            LedgerMutation::ChangeSequence => connection
                .execute_batch("DROP TRIGGER runtime_global_event_ledger_no_update;")
                .unwrap(),
            LedgerMutation::DeleteRow => connection
                .execute_batch("DROP TRIGGER runtime_global_event_ledger_no_delete;")
                .unwrap(),
        }
        match mutation {
            LedgerMutation::ChangeSequence => {
                connection
                    .execute(
                        "UPDATE runtime_global_event_ledger \
                         SET global_sequence = global_sequence + 100 \
                         WHERE runtime_message_id = ?1",
                        ["ledger-proof-command"],
                    )
                    .unwrap();
                connection
                    .execute_batch(
                        "CREATE TRIGGER runtime_global_event_ledger_no_update \
                         BEFORE UPDATE ON runtime_global_event_ledger \
                         BEGIN SELECT RAISE(ABORT, 'runtime_global_event_ledger is append-only'); END;",
                    )
                    .unwrap();
            }
            LedgerMutation::DeleteRow => {
                connection
                    .execute(
                        "DELETE FROM runtime_global_event_ledger WHERE runtime_message_id = ?1",
                        ["ledger-proof-command"],
                    )
                    .unwrap();
                connection
                    .execute_batch(
                        "CREATE TRIGGER runtime_global_event_ledger_no_delete \
                         BEFORE DELETE ON runtime_global_event_ledger \
                         BEGIN SELECT RAISE(ABORT, 'runtime_global_event_ledger is append-only'); END;",
                    )
                    .unwrap();
            }
        }
        drop(connection);

        let refresh = service.refresh_write_fence(&proof);
        match mutation {
            LedgerMutation::ChangeSequence => assert!(
                matches!(refresh, Err(RunCancellationServiceError::ProofMismatch)),
                "unexpected sequence-tamper result: {refresh:?}"
            ),
            LedgerMutation::DeleteRow => assert!(
                matches!(
                    refresh,
                    Err(RunCancellationServiceError::IntentEventGlobalOrderMissing)
                ),
                "unexpected missing-ledger result: {refresh:?}"
            ),
        }
    }
}

#[test]
fn same_path_database_replacement_is_rejected_by_database_instance_id() {
    let fixture = Fixture::new();
    fixture.running_run("run-replaced-database");
    let service = fixture.service();
    let proof = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-replaced-database",
            "replace-proof-key",
            REASON,
            "replace-proof-command",
            "2026-07-13T16:06:00Z",
        )
        .unwrap()
        .proof()
        .clone();
    checkpoint(&fixture.database);
    let Fixture {
        _temp,
        database,
        lease,
    } = fixture;
    drop(service);
    drop(lease);
    let backup = _temp.path().join("original-backup.db");
    std::fs::rename(&database, &backup).unwrap();

    let replacement = EventJournal::open(&database).unwrap();
    let replacement_id = replacement.database_instance_id().to_owned();
    assert_ne!(replacement_id, proof.database_instance_id());
    drop(replacement);
    let replacement_lease = bound_runtime_lease(&database, "replacement-database");
    let replacement_service =
        RunCancellationService::new(&database, Arc::clone(&replacement_lease)).unwrap();

    assert!(matches!(
        replacement_service.refresh_write_fence(&proof),
        Err(RunCancellationServiceError::DatabaseInstanceMismatch {
            expected,
            actual,
        }) if expected == replacement_id && actual == proof.database_instance_id()
    ));
}

#[test]
fn a_new_lease_epoch_rejects_a_process_local_proof_from_the_previous_owner() {
    let fixture = Fixture::new();
    fixture.running_run("run-old-lease-proof");
    let service = fixture.service();
    let proof = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-old-lease-proof",
            "old-lease-proof-key",
            REASON,
            "old-lease-proof-command",
            "2026-07-13T16:06:30Z",
        )
        .unwrap()
        .proof()
        .clone();
    let stale_fence = service.refresh_write_fence(&proof).unwrap();
    let old_epoch = proof.lease_epoch().to_owned();
    let old_file_identity = proof.database_file_identity_sha256().to_owned();
    let Fixture {
        _temp,
        database,
        lease,
    } = fixture;
    drop(service);
    drop(lease);

    let restarted_lease = bound_runtime_lease(&database, "restarted-runtime");
    assert_ne!(restarted_lease.lease_epoch(), old_epoch);
    assert_eq!(
        restarted_lease.database_file_identity_sha256(),
        old_file_identity
    );
    let restarted_service =
        RunCancellationService::new(&database, Arc::clone(&restarted_lease)).unwrap();
    assert!(matches!(
        restarted_service.refresh_write_fence(&proof),
        Err(RunCancellationServiceError::LeaseEpochMismatch {
            expected,
            actual,
        }) if expected == old_epoch && actual == restarted_lease.lease_epoch()
    ));
    assert!(matches!(
        restarted_service.refresh_write_fence(stale_fence.proof()),
        Err(RunCancellationServiceError::LeaseEpochMismatch { .. })
    ));
}

#[cfg(unix)]
#[test]
fn same_uuid_copy_reinstalled_at_the_bound_path_is_rejected_by_file_identity() {
    let fixture = Fixture::new();
    fixture.running_run("run-file-replaced");
    let service = fixture.service();
    let proof = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-file-replaced",
            "file-replaced-key",
            REASON,
            "file-replaced-command",
            "2026-07-13T16:06:40Z",
        )
        .unwrap()
        .proof()
        .clone();
    checkpoint(&fixture.database);
    let replacement = fixture._temp.path().join("same-uuid-copy.db");
    let displaced = fixture._temp.path().join("displaced-original.db");
    std::fs::copy(&fixture.database, &replacement).unwrap();
    assert_eq!(
        EventJournal::open(&replacement)
            .unwrap()
            .database_instance_id(),
        proof.database_instance_id()
    );
    std::fs::rename(&fixture.database, &displaced).unwrap();
    std::fs::rename(&replacement, &fixture.database).unwrap();

    assert!(matches!(
        service.refresh_write_fence(&proof),
        Err(RunCancellationServiceError::DatabaseFileReplaced { .. })
    ));
}

#[cfg(windows)]
#[test]
fn active_windows_file_anchor_prevents_same_uuid_copy_replacement() {
    let fixture = Fixture::new();
    fixture.running_run("run-windows-anchor");
    let service = fixture.service();
    let proof = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-windows-anchor",
            "windows-anchor-key",
            REASON,
            "windows-anchor-command",
            "2026-07-13T16:06:50Z",
        )
        .unwrap()
        .proof()
        .clone();
    checkpoint(&fixture.database);
    let replacement = fixture._temp.path().join("windows-same-uuid-copy.db");
    let displaced = fixture._temp.path().join("windows-displaced-original.db");
    std::fs::copy(&fixture.database, &replacement).unwrap();
    assert_eq!(
        EventJournal::open(&replacement)
            .unwrap()
            .database_instance_id(),
        proof.database_instance_id()
    );

    let replacement_attempt = std::fs::rename(&fixture.database, &displaced);
    assert!(replacement_attempt.is_err());
    fixture.lease.verify_database_file_current().unwrap();
    service.refresh_write_fence(&proof).unwrap();
}

#[test]
fn copied_database_retains_logical_identity_but_path_binding_rejects_proof_movement() {
    let fixture = Fixture::new();
    fixture.running_run("run-copied-database");
    let original_service = fixture.service();
    let proof = original_service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-copied-database",
            "copy-proof-key",
            REASON,
            "copy-proof-command",
            "2026-07-13T16:07:00Z",
        )
        .unwrap()
        .proof()
        .clone();
    checkpoint(&fixture.database);
    let copied_path = fixture._temp.path().join("copied-workspace.db");
    std::fs::copy(&fixture.database, &copied_path).unwrap();

    let copied_journal = EventJournal::open(&copied_path).unwrap();
    assert_eq!(
        copied_journal.database_instance_id(),
        proof.database_instance_id()
    );
    drop(copied_journal);
    let copied_lease = bound_runtime_lease(&copied_path, "copied-database");
    let copied_service =
        RunCancellationService::new(&copied_path, Arc::clone(&copied_lease)).unwrap();
    assert!(matches!(
        copied_service.refresh_write_fence(&proof),
        Err(RunCancellationServiceError::DatabaseCanonicalPathMismatch)
    ));
}

#[test]
fn pre_global_ledger_intent_is_a_typed_legacy_unordered_blocker() {
    let fixture = Fixture::new();
    fixture.running_run("run-legacy-order");
    let service = fixture.service();
    service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-legacy-order",
            "legacy-order-key",
            REASON,
            "legacy-order-command",
            "2026-07-13T16:08:00Z",
        )
        .unwrap();
    drop(service);
    downgrade_database_to_v5(&fixture.database);

    let migrated = EventJournal::open(&fixture.database).unwrap();
    assert_eq!(
        migrated
            .global_order_for_message("legacy-order-command")
            .unwrap(),
        Some(GlobalEventOrder::LegacyUnordered)
    );
    drop(migrated);
    let service = fixture.service();
    assert!(matches!(
        service.recover_active_intent("run-legacy-order"),
        Err(RunCancellationServiceError::IntentEventLegacyUnordered)
    ));
    assert!(matches!(
        service.scan_active_intents(WORKSPACE_ID, PROJECT_ID),
        Err(RunCancellationServiceError::IntentEventLegacyUnordered)
    ));
}

#[test]
fn global_ledger_foreign_key_prevents_deleting_run_evidence() {
    let fixture = Fixture::new();
    fixture.running_run("run-missing-proof");
    let service = fixture.service();
    let proof = service
        .record_intent(
            WORKSPACE_ID,
            PROJECT_ID,
            "run-missing-proof",
            "missing-proof-key",
            REASON,
            "missing-proof-command",
            "2026-07-13T16:10:00Z",
        )
        .unwrap()
        .proof()
        .clone();

    let connection = Connection::open(&fixture.database).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys = ON; DROP TRIGGER runtime_events_no_delete;")
        .unwrap();
    let deletion = connection.execute(
        "DELETE FROM runtime_events WHERE run_id = ?1",
        ["run-missing-proof"],
    );
    assert!(matches!(
        deletion,
        Err(rusqlite::Error::SqliteFailure(error, _))
            if error.code == ErrorCode::ConstraintViolation
    ));
    connection
        .execute_batch(
            "CREATE TRIGGER runtime_events_no_delete BEFORE DELETE ON runtime_events \
             BEGIN SELECT RAISE(ABORT, 'RUNTIME_EVENT_IMMUTABLE'); END;",
        )
        .unwrap();
    drop(connection);

    service.refresh_write_fence(&proof).unwrap();
}

#[derive(Clone, Copy)]
enum LedgerMutation {
    ChangeSequence,
    DeleteRow,
}

fn checkpoint(path: &std::path::Path) {
    Connection::open(path)
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
}

fn downgrade_database_to_v5(path: &std::path::Path) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "PRAGMA foreign_keys = OFF; \
             DROP TRIGGER runtime_database_identity_no_insert; \
             DROP TRIGGER runtime_database_identity_no_update; \
             DROP TRIGGER runtime_database_identity_no_delete; \
             DROP TRIGGER runtime_global_event_ordering_no_insert; \
             DROP TRIGGER runtime_global_event_ordering_no_update; \
             DROP TRIGGER runtime_global_event_ordering_no_delete; \
             DROP TRIGGER runtime_legacy_unordered_events_no_insert; \
             DROP TRIGGER runtime_legacy_unordered_events_no_update; \
             DROP TRIGGER runtime_legacy_unordered_events_no_delete; \
             DROP TRIGGER runtime_events_safe_sequence_insert; \
             DROP TRIGGER workspace_events_safe_sequence_insert; \
             DROP TRIGGER runtime_global_event_ledger_validate_insert; \
             DROP TRIGGER runtime_events_record_global_order; \
             DROP TRIGGER workspace_events_record_global_order; \
             DROP TRIGGER runtime_global_event_ledger_no_update; \
             DROP TRIGGER runtime_global_event_ledger_no_delete; \
             DROP TABLE runtime_global_event_ledger; \
             DROP TABLE runtime_legacy_unordered_events; \
             DROP TABLE runtime_global_event_ordering; \
             DROP TABLE runtime_database_identity; \
             DELETE FROM runtime_schema_migrations WHERE version = 6;",
        )
        .unwrap();
    connection.execute_batch(MIGRATION_0005).unwrap();
}

struct Fixture {
    _temp: TempDir,
    database: std::path::PathBuf,
    lease: Arc<BoundWorkspaceRuntimeLease>,
}

impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let database = temp.path().join("workspace.db");
        EventJournal::open(&database).unwrap();
        WorkspaceEventJournal::open(&database).unwrap();
        let lease = bound_runtime_lease(&database, "run-cancellation-fixture");
        Self {
            _temp: temp,
            database,
            lease,
        }
    }

    fn service(&self) -> RunCancellationService {
        RunCancellationService::new(&self.database, Arc::clone(&self.lease)).unwrap()
    }

    fn global_sequence(&self) -> u64 {
        WorkspaceEventJournal::open(&self.database)
            .unwrap()
            .current_global_sequence()
            .unwrap()
    }

    fn running_run(&self, run_id: &str) -> RunAggregate {
        self.run_at_state(run_id, RunState::Running)
    }

    fn run_at_state(&self, run_id: &str, target: RunState) -> RunAggregate {
        let mut journal = EventJournal::open(&self.database).unwrap();
        let identity = pinned_identity();
        let mut run = RunAggregate::create(
            &mut journal,
            run_id,
            identity,
            metadata(&format!("{run_id}-create"), "2026-07-13T09:00:00Z"),
        )
        .unwrap();
        if target == RunState::Created {
            return run;
        }
        run.prepare(
            &mut journal,
            metadata(&format!("{run_id}-prepare"), "2026-07-13T09:00:01Z"),
        )
        .unwrap();
        if target == RunState::Preparing {
            return run;
        }
        run.start(
            &mut journal,
            metadata(&format!("{run_id}-start"), "2026-07-13T09:00:02Z"),
        )
        .unwrap();
        match target {
            RunState::Running => {}
            RunState::WaitingForApproval => run
                .wait_for_approval(
                    &mut journal,
                    metadata(&format!("{run_id}-approval"), "2026-07-13T09:00:03Z"),
                )
                .unwrap(),
            RunState::WaitingForReconciliation => run
                .wait_for_reconciliation(
                    &mut journal,
                    metadata(&format!("{run_id}-reconciliation"), "2026-07-13T09:00:03Z"),
                )
                .unwrap(),
            RunState::Committing => run
                .begin_commit(
                    &mut journal,
                    metadata(&format!("{run_id}-commit"), "2026-07-13T09:00:03Z"),
                )
                .unwrap(),
            RunState::Retrying => run
                .retry(
                    &mut journal,
                    metadata(&format!("{run_id}-retry"), "2026-07-13T09:00:03Z"),
                )
                .unwrap(),
            RunState::Blocked => run
                .block(
                    &mut journal,
                    metadata(&format!("{run_id}-blocked"), "2026-07-13T09:00:03Z"),
                )
                .unwrap(),
            RunState::Cancelled => run
                .cancel(
                    &mut journal,
                    self.lease.as_ref(),
                    metadata(&format!("{run_id}-cancelled"), "2026-07-13T09:00:03Z"),
                )
                .unwrap(),
            RunState::Failed => run
                .fail(
                    &mut journal,
                    metadata(&format!("{run_id}-failed"), "2026-07-13T09:00:03Z"),
                )
                .unwrap(),
            RunState::Completed => run
                .complete(
                    &mut journal,
                    metadata(&format!("{run_id}-completed"), "2026-07-13T09:00:03Z"),
                )
                .unwrap(),
            RunState::Created | RunState::Preparing => unreachable!(),
        }
        run
    }
}

fn bound_runtime_lease(
    database: &std::path::Path,
    instance_label: &str,
) -> Arc<BoundWorkspaceRuntimeLease> {
    let raw_lease = WorkspaceRuntimeLease::acquire(database, instance_label).unwrap();
    Arc::new(raw_lease.bind_database(database).unwrap())
}

fn metadata<'a>(message: &'a str, created_at: &'a str) -> EventMetadata<'a> {
    EventMetadata {
        message_id: message,
        idempotency_key: message,
        created_at,
        reason: None,
    }
}
