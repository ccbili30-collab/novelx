mod support;

use novelx_protocol::RunReconciliationDecision;
use novelx_runtime::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent};
use novelx_runtime::run_aggregate::{
    EventMetadata, RunAggregate, RunAggregateError, RunCancellationState,
    derive_run_cancellation_intent_id,
};
use novelx_runtime::run_state::RunState;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;

const REASON: &str = "Stop before the next provider request.";
const INTENT_KEY: &str = "cancel-intent-1";

#[test]
fn intent_hash_has_a_fixed_utf8_cross_language_vector_and_bounded_inputs() {
    // Cross-language contract: SHA-256 the UTF-8 bytes of compact JSON with fields ordered as
    // scheme, workspaceId, runId, cancelIdempotencyKey, reasonSha256.
    assert_eq!(
        derive_run_cancellation_intent_id(
            "工作区-alpha",
            "run-小说-01",
            "cancel-撤回-001",
            "用户请求停止，因为下一幕需要重写。",
        )
        .unwrap(),
        "ba8dd6ac16f0332d5fa3884a7abd9be4070d2211793f1d4269c1624029da2bf2"
    );
    assert!(matches!(
        derive_run_cancellation_intent_id("workspace-1", "run-1", &"k".repeat(1_025), REASON,),
        Err(RunAggregateError::InvalidPayload)
    ));
    assert!(matches!(
        derive_run_cancellation_intent_id(
            "workspace-1",
            "run-1",
            INTENT_KEY,
            &"r".repeat(16 * 1_024 + 1),
        ),
        Err(RunAggregateError::InvalidPayload)
    ));

    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut run = running_run(&mut journal, "run-bounded-request");
    assert!(matches!(
        run.record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "cancel-bounded-request",
            &"t".repeat(129),
        ),
        Err(RunAggregateError::InvalidPayload)
    ));
    assert_eq!(journal.read_run("run-bounded-request", 0).unwrap().len(), 3);
    assert!(matches!(
        run.record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "cancel-invalid-time",
            "not-rfc3339",
        ),
        Err(RunAggregateError::InvalidPayload)
    ));
}

#[test]
fn cancellation_intent_run_state_matrix_allows_only_running_and_retrying() {
    for allowed in [RunState::Running, RunState::Retrying] {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        let mut run = run_at_state(&mut journal, "run-matrix-allowed", allowed);
        run.record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "matrix-allowed-intent",
            "2026-07-13T00:10:00Z",
        )
        .unwrap();
        assert_eq!(run.state(), allowed);
        assert_eq!(
            run.cancellation_state(),
            RunCancellationState::IntentRecorded
        );
    }

    for rejected in [
        RunState::Created,
        RunState::Preparing,
        RunState::WaitingForApproval,
        RunState::WaitingForReconciliation,
        RunState::Committing,
        RunState::Blocked,
        RunState::Cancelled,
        RunState::Failed,
        RunState::Completed,
    ] {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        let mut run = run_at_state(&mut journal, "run-matrix-rejected", rejected);
        let before = journal.read_run("run-matrix-rejected", 0).unwrap().len();
        assert!(matches!(
            run.record_cancellation_intent(
                &mut journal,
                INTENT_KEY,
                REASON,
                "matrix-rejected-intent",
                "2026-07-13T00:10:00Z",
            ),
            Err(RunAggregateError::CancellationRunStateInvalid(actual)) if actual == rejected
        ));
        assert_eq!(
            journal.read_run("run-matrix-rejected", 0).unwrap().len(),
            before
        );
    }
}

#[test]
fn legacy_pending_cancellation_is_a_live_and_replay_barrier_without_mixing_new_intents() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut run = running_run(&mut journal, "run-legacy-barrier");
    let attempts = ["legacy-attempt".to_owned()];
    run.request_cancellation_reconciliation(
        &mut journal,
        &attempts,
        "legacy unknown outcome",
        EventMetadata {
            message_id: "legacy-request-message",
            idempotency_key: "legacy-request-key",
            created_at: "2026-07-13T00:00:03Z",
            reason: None,
        },
    )
    .unwrap();
    assert!(!run.permits_new_side_effects());
    let event_count = journal.read_run("run-legacy-barrier", 0).unwrap().len();

    run.start(
        &mut journal,
        EventMetadata {
            message_id: "run-legacy-barrier-start",
            idempotency_key: "run-legacy-barrier-start",
            created_at: "2026-07-13T00:00:02Z",
            reason: None,
        },
    )
    .unwrap();
    run.request_cancellation_reconciliation(
        &mut journal,
        &attempts,
        "legacy unknown outcome",
        EventMetadata {
            message_id: "legacy-request-transport-retry",
            idempotency_key: "legacy-request-key",
            created_at: "2026-07-13T00:01:00Z",
            reason: None,
        },
    )
    .unwrap();
    for result in [
        run.retry(&mut journal, metadata("legacy-blocked-retry")),
        run.cancel(&mut journal, metadata("legacy-blocked-cancel")),
        run.fail(&mut journal, metadata("legacy-blocked-fail")),
    ] {
        assert!(matches!(
            result,
            Err(RunAggregateError::CancellationSettlementRequired)
        ));
    }
    assert!(matches!(
        run.record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "legacy-blocked-new-intent",
            "2026-07-13T00:01:01Z",
        ),
        Err(RunAggregateError::CancellationSettlementRequired)
    ));
    assert_eq!(
        journal.read_run("run-legacy-barrier", 0).unwrap().len(),
        event_count
    );

    let mixed_intent_id =
        derive_run_cancellation_intent_id("workspace-1", "run-legacy-barrier", INTENT_KEY, REASON)
            .unwrap();
    journal
        .append(
            NewRuntimeEvent {
                run_id: "run-legacy-barrier".to_owned(),
                aggregate_type: "run".to_owned(),
                aggregate_id: "run-legacy-barrier".to_owned(),
                message_id: "mixed-new-intent".to_owned(),
                idempotency_key: format!("run:run-legacy-barrier:cancel-intent:{mixed_intent_id}"),
                event_type: "run.cancellation_intent_recorded".to_owned(),
                event_version: 1,
                payload: json!({
                    "previousCancellationState": "none",
                    "currentCancellationState": "intent_recorded",
                    "runState": "waiting_for_reconciliation",
                    "intentId": mixed_intent_id,
                    "runId": "run-legacy-barrier",
                    "workspaceId": "workspace-1",
                    "cancelIdempotencyKey": INTENT_KEY,
                    "reason": REASON,
                    "reasonSha256": format!("{:x}", Sha256::digest(REASON.as_bytes())),
                    "requestedAt": "2026-07-13T00:01:01Z",
                    "commandMessageId": "mixed-new-intent",
                }),
                created_at: "2026-07-13T00:01:01Z".to_owned(),
            },
            run.last_run_sequence(),
            run.last_sequence(),
        )
        .unwrap();
    assert!(matches!(
        RunAggregate::recover(&journal, "run-legacy-barrier"),
        Err(RunAggregateError::CancellationSettlementRequired)
    ));

    let mut ordinary = running_run(&mut journal, "run-legacy-replay-barrier");
    ordinary
        .request_cancellation_reconciliation(
            &mut journal,
            &["legacy-attempt-2".to_owned()],
            "legacy unknown outcome",
            metadata("legacy-replay-request"),
        )
        .unwrap();
    journal
        .append(
            NewRuntimeEvent {
                run_id: "run-legacy-replay-barrier".to_owned(),
                aggregate_type: "run".to_owned(),
                aggregate_id: "run-legacy-replay-barrier".to_owned(),
                message_id: "legacy-illegal-retry".to_owned(),
                idempotency_key: "legacy-illegal-retry".to_owned(),
                event_type: "run.retrying".to_owned(),
                event_version: 1,
                payload: json!({
                    "previousState": "waiting_for_reconciliation",
                    "currentState": "retrying",
                    "reason": null,
                }),
                created_at: "2026-07-13T00:00:05Z".to_owned(),
            },
            ordinary.last_run_sequence(),
            ordinary.last_sequence(),
        )
        .unwrap();
    assert!(matches!(
        RunAggregate::recover(&journal, "run-legacy-replay-barrier"),
        Err(RunAggregateError::CancellationSettlementRequired)
    ));
}

#[test]
fn intent_is_orthogonal_queryable_transport_idempotent_and_freezes_lifecycle() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut run = running_run(&mut journal, "run-intent");

    let intent = run
        .record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "cancel-message-1",
            "2026-07-13T00:00:03Z",
        )
        .unwrap();

    assert_eq!(run.state(), RunState::Running);
    assert_eq!(
        run.cancellation_state(),
        RunCancellationState::IntentRecorded
    );
    assert!(!run.permits_new_side_effects());
    assert_eq!(run.active_cancellation_intent(), Some(&intent));
    assert_eq!(intent.run_id(), "run-intent");
    assert_eq!(intent.workspace_id(), "workspace-1");
    assert_eq!(intent.cancel_idempotency_key(), INTENT_KEY);
    assert_eq!(intent.reason(), REASON);
    assert_eq!(intent.requested_at(), "2026-07-13T00:00:03Z");
    assert_eq!(intent.command_message_id(), "cancel-message-1");
    assert_eq!(
        intent.reason_sha256(),
        format!("{:x}", Sha256::digest(REASON.as_bytes()))
    );
    assert_eq!(
        intent.intent_id(),
        derive_run_cancellation_intent_id("workspace-1", "run-intent", INTENT_KEY, REASON).unwrap()
    );

    let retried = run
        .record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "cancel-message-transport-retry",
            "2026-07-13T00:01:00Z",
        )
        .unwrap();
    assert_eq!(retried, intent);
    assert_eq!(journal.read_run("run-intent", 0).unwrap().len(), 4);

    let start_message = "run-intent-start";
    run.start(
        &mut journal,
        EventMetadata {
            message_id: start_message,
            idempotency_key: start_message,
            created_at: "2026-07-13T00:00:02Z",
            reason: None,
        },
    )
    .unwrap();
    for result in [
        run.wait_for_approval(&mut journal, metadata("blocked-approval")),
        run.begin_commit(&mut journal, metadata("blocked-commit")),
        run.retry(&mut journal, metadata("blocked-retry")),
        run.block(&mut journal, metadata("blocked-block")),
        run.cancel(&mut journal, metadata("blocked-cancel")),
        run.fail(&mut journal, metadata("blocked-fail")),
        run.complete(&mut journal, metadata("blocked-complete")),
    ] {
        assert!(matches!(
            result,
            Err(RunAggregateError::CancellationSettlementRequired)
        ));
    }
    assert!(matches!(
        run.request_cancellation_reconciliation(
            &mut journal,
            &["attempt-legacy".to_owned()],
            "legacy cancellation",
            metadata("blocked-legacy"),
        ),
        Err(RunAggregateError::CancellationSettlementRequired)
    ));
    assert!(matches!(
        run.reconcile(
            &mut journal,
            "attempt-without-settlement",
            RunReconciliationDecision::CancelRun,
            false,
            metadata("blocked-direct-reconcile"),
        ),
        Err(RunAggregateError::CancellationSettlementRequired)
    ));
    assert_eq!(journal.read_run("run-intent", 0).unwrap().len(), 4);

    let event = journal
        .read_aggregate("run-intent", "run", "run-intent", 0)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(event.event_type, "run.cancellation_intent_recorded");
    assert_eq!(event.event_version, 1);
    assert_eq!(
        event.idempotency_key,
        format!("run:run-intent:cancel-intent:{}", intent.intent_id())
    );
    assert_eq!(event.payload.as_object().unwrap().len(), 11);

    drop(journal);
    let recovered = RunAggregate::recover(&fixture.open(), "run-intent").unwrap();
    assert_eq!(recovered.state(), RunState::Running);
    assert_eq!(
        recovered.cancellation_state(),
        RunCancellationState::IntentRecorded
    );
    assert_eq!(recovered.active_cancellation_intent(), Some(&intent));
}

#[test]
fn changed_semantics_and_concurrent_second_intent_fail_closed_without_writing() {
    let fixture = Fixture::new();
    let mut setup_journal = fixture.open();
    running_run(&mut setup_journal, "run-race");
    drop(setup_journal);

    let mut first_journal = fixture.open();
    let mut second_journal = fixture.open();
    let mut first = RunAggregate::recover(&first_journal, "run-race").unwrap();
    let mut stale_second = RunAggregate::recover(&second_journal, "run-race").unwrap();
    let first_intent = first
        .record_cancellation_intent(
            &mut first_journal,
            INTENT_KEY,
            REASON,
            "cancel-first",
            "2026-07-13T00:00:03Z",
        )
        .unwrap();
    assert!(matches!(
        first.record_cancellation_intent(
            &mut first_journal,
            INTENT_KEY,
            "Changed reason",
            "cancel-changed-reason",
            "2026-07-13T00:00:04Z",
        ),
        Err(RunAggregateError::CancellationIntentConflict { .. })
    ));
    assert!(matches!(
        first.record_cancellation_intent(
            &mut first_journal,
            "cancel-intent-2",
            REASON,
            "cancel-second-key",
            "2026-07-13T00:00:04Z",
        ),
        Err(RunAggregateError::CancellationIntentConflict { .. })
    ));
    assert!(matches!(
        stale_second.record_cancellation_intent(
            &mut second_journal,
            "cancel-concurrent",
            REASON,
            "cancel-concurrent-message",
            "2026-07-13T00:00:04Z",
        ),
        Err(RunAggregateError::CancellationIntentConflict { .. })
    ));

    let recovered = RunAggregate::recover(&first_journal, "run-race").unwrap();
    assert_eq!(recovered.cancellation_intent(), Some(&first_intent));
    assert_eq!(first_journal.read_run("run-race", 0).unwrap().len(), 4);
}

#[test]
fn intent_settlement_and_reconciliation_retries_are_history_stable_across_cas_and_cycles() {
    let fixture = Fixture::new();
    let mut setup = fixture.open();
    running_run(&mut setup, "run-history-cas");
    drop(setup);

    let mut first_journal = fixture.open();
    let mut retry_journal = fixture.open();
    let mut first = RunAggregate::recover(&first_journal, "run-history-cas").unwrap();
    let mut stale_retry = RunAggregate::recover(&retry_journal, "run-history-cas").unwrap();
    let intent = first
        .record_cancellation_intent(
            &mut first_journal,
            INTENT_KEY,
            REASON,
            "history-intent-first",
            "2026-07-13T01:00:00Z",
        )
        .unwrap();
    assert_eq!(
        stale_retry
            .record_cancellation_intent(
                &mut retry_journal,
                INTENT_KEY,
                REASON,
                "history-intent-transport-retry",
                "2026-07-13T01:00:01Z",
            )
            .unwrap(),
        intent
    );
    assert_eq!(
        stale_retry.cancellation_state(),
        RunCancellationState::IntentRecorded
    );
    assert_eq!(
        first_journal.read_run("run-history-cas", 0).unwrap().len(),
        4
    );

    let mut settlement_retry = RunAggregate::recover(&retry_journal, "run-history-cas").unwrap();
    let unknown_effects = "8".repeat(64);
    first
        .mark_cancellation_reconciliation_required(
            &mut first_journal,
            intent.intent_id(),
            &unknown_effects,
            metadata("history-settlement-first"),
        )
        .unwrap();
    settlement_retry
        .mark_cancellation_reconciliation_required(
            &mut retry_journal,
            intent.intent_id(),
            &unknown_effects,
            EventMetadata {
                message_id: "history-settlement-transport-retry",
                idempotency_key: "ignored-different-settlement-key",
                created_at: "2026-07-13T01:00:03Z",
                reason: Some("transport retry"),
            },
        )
        .unwrap();
    assert_eq!(
        settlement_retry.cancellation_state(),
        RunCancellationState::ReconciliationRequired
    );
    assert!(matches!(
        settlement_retry.mark_cancellation_reconciliation_required(
            &mut retry_journal,
            intent.intent_id(),
            &"9".repeat(64),
            metadata("history-settlement-conflict"),
        ),
        Err(RunAggregateError::CancellationSettlementConflict)
    ));

    let mut reconciliation_retry =
        RunAggregate::recover(&retry_journal, "run-history-cas").unwrap();
    first
        .reconcile(
            &mut first_journal,
            "history-attempt-1",
            RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate,
            true,
            EventMetadata {
                message_id: "history-reconcile-first",
                idempotency_key: "history-reconcile-key-first",
                created_at: "2026-07-13T01:00:04Z",
                reason: None,
            },
        )
        .unwrap();
    reconciliation_retry
        .reconcile(
            &mut retry_journal,
            "history-attempt-1",
            RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate,
            true,
            EventMetadata {
                message_id: "history-reconcile-transport-retry",
                idempotency_key: "history-reconcile-key-transport-retry",
                created_at: "2026-07-13T01:00:05Z",
                reason: Some("retry after lost response"),
            },
        )
        .unwrap();
    assert_eq!(reconciliation_retry.state(), RunState::Retrying);
    assert_eq!(
        reconciliation_retry.cancellation_state(),
        RunCancellationState::WithdrawnForRetry
    );
    assert!(matches!(
        reconciliation_retry.reconcile(
            &mut retry_journal,
            "history-attempt-1",
            RunReconciliationDecision::CancelRun,
            false,
            metadata("history-reconcile-conflict"),
        ),
        Err(RunAggregateError::Journal(
            EventJournalError::IdempotencyConflict { .. }
        ))
    ));

    let reconciled_event = first_journal
        .read_aggregate("run-history-cas", "run", "run-history-cas", 0)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(reconciled_event.event_type, "run.reconciled");
    assert_eq!(reconciled_event.event_version, 2);
    assert_eq!(reconciled_event.payload.as_object().unwrap().len(), 10);
    assert_eq!(
        reconciled_event.payload["intentId"],
        Value::String(intent.intent_id().to_owned())
    );
    assert_eq!(
        reconciled_event.payload["unknownEffectsSha256"],
        Value::String(unknown_effects.clone())
    );
    assert_eq!(
        reconciled_event.payload["cancellationDisposition"],
        "withdrawn_for_retry"
    );

    first
        .record_cancellation_intent(
            &mut first_journal,
            "history-intent-2",
            "Cancel the second cycle.",
            "history-intent-second-cycle",
            "2026-07-13T01:00:06Z",
        )
        .unwrap();
    assert!(matches!(
        first.record_cancellation_intent(
            &mut first_journal,
            INTENT_KEY,
            "Changed semantics for the historical key.",
            "history-reused-key-conflict",
            "2026-07-13T01:00:07Z",
        ),
        Err(RunAggregateError::CancellationIntentConflict { .. })
    ));
    let count_after_second_cycle = first_journal.read_run("run-history-cas", 0).unwrap().len();
    first
        .mark_cancellation_reconciliation_required(
            &mut first_journal,
            intent.intent_id(),
            &unknown_effects,
            metadata("history-old-settlement-retry"),
        )
        .unwrap();
    first
        .reconcile(
            &mut first_journal,
            "history-attempt-1",
            RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate,
            true,
            metadata("history-old-reconciliation-retry"),
        )
        .unwrap();
    assert_eq!(
        first_journal.read_run("run-history-cas", 0).unwrap().len(),
        count_after_second_cycle
    );

    drop(first_journal);
    let mut reopened_journal = fixture.open();
    let mut reopened = RunAggregate::recover(&reopened_journal, "run-history-cas").unwrap();
    reopened
        .reconcile(
            &mut reopened_journal,
            "history-attempt-1",
            RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate,
            true,
            metadata("history-restart-reconciliation-retry"),
        )
        .unwrap();
}

#[test]
fn safe_and_unknown_settlements_are_durable_semantically_idempotent_and_auditable() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();

    let mut safe_run = running_run(&mut journal, "run-safe");
    let safe_intent = safe_run
        .record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "safe-intent-message",
            "2026-07-13T00:00:03Z",
        )
        .unwrap();
    let manifest = "a".repeat(64);
    safe_run
        .mark_cancellation_safe(
            &mut journal,
            safe_intent.intent_id(),
            &manifest,
            metadata("safe-settlement"),
        )
        .unwrap();
    assert_eq!(safe_run.state(), RunState::Cancelled);
    assert_eq!(
        safe_run.cancellation_state(),
        RunCancellationState::CancelledSafe
    );
    assert_eq!(safe_run.active_cancellation_intent(), None);
    assert_eq!(
        safe_run.cancellation_evidence_sha256(),
        Some(manifest.as_str())
    );
    safe_run
        .mark_cancellation_safe(
            &mut journal,
            safe_intent.intent_id(),
            &manifest,
            metadata("safe-transport-retry"),
        )
        .unwrap();
    assert!(matches!(
        safe_run.mark_cancellation_safe(
            &mut journal,
            safe_intent.intent_id(),
            &"b".repeat(64),
            metadata("safe-conflict"),
        ),
        Err(RunAggregateError::CancellationSettlementConflict)
    ));

    let mut unknown_run = running_run(&mut journal, "run-unknown");
    let unknown_intent = unknown_run
        .record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "unknown-intent-message",
            "2026-07-13T00:00:03Z",
        )
        .unwrap();
    let unknown_effects = "c".repeat(64);
    unknown_run
        .mark_cancellation_reconciliation_required(
            &mut journal,
            unknown_intent.intent_id(),
            &unknown_effects,
            metadata("unknown-settlement"),
        )
        .unwrap();
    assert_eq!(unknown_run.state(), RunState::WaitingForReconciliation);
    assert_eq!(
        unknown_run.cancellation_state(),
        RunCancellationState::ReconciliationRequired
    );
    assert_eq!(
        unknown_run.active_cancellation_intent(),
        Some(&unknown_intent)
    );
    assert!(matches!(
        unknown_run.start(&mut journal, metadata("unknown-blocked-start")),
        Err(RunAggregateError::CancellationSettlementRequired)
    ));
    unknown_run
        .reconcile(
            &mut journal,
            "attempt-unknown",
            RunReconciliationDecision::CancelRun,
            false,
            metadata("unknown-abandon"),
        )
        .unwrap();
    assert_eq!(unknown_run.state(), RunState::Cancelled);
    assert_eq!(
        unknown_run.cancellation_state(),
        RunCancellationState::AbandonedAfterUnknown
    );

    let mut retry_run = running_run(&mut journal, "run-withdrawn");
    let retry_intent = retry_run
        .record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "retry-intent-message",
            "2026-07-13T00:00:03Z",
        )
        .unwrap();
    retry_run
        .mark_cancellation_reconciliation_required(
            &mut journal,
            retry_intent.intent_id(),
            &unknown_effects,
            metadata("retry-reconciliation"),
        )
        .unwrap();
    retry_run
        .reconcile(
            &mut journal,
            "attempt-retry",
            RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate,
            true,
            metadata("retry-withdraw"),
        )
        .unwrap();
    assert_eq!(retry_run.state(), RunState::Retrying);
    assert_eq!(
        retry_run.cancellation_state(),
        RunCancellationState::WithdrawnForRetry
    );
    assert!(retry_run.permits_new_side_effects());
    retry_run
        .start(&mut journal, metadata("retry-start"))
        .unwrap();
    let events_before_duplicate = journal.read_run("run-withdrawn", 0).unwrap().len();
    assert_eq!(
        retry_run
            .record_cancellation_intent(
                &mut journal,
                INTENT_KEY,
                REASON,
                "retry-old-intent-transport-retry",
                "2026-07-13T00:02:00Z",
            )
            .unwrap(),
        retry_intent
    );
    assert_eq!(
        journal.read_run("run-withdrawn", 0).unwrap().len(),
        events_before_duplicate
    );
    assert_eq!(
        retry_run.cancellation_state(),
        RunCancellationState::WithdrawnForRetry
    );
    let second_intent = retry_run
        .record_cancellation_intent(
            &mut journal,
            "cancel-intent-2",
            "Stop the retried provider request.",
            "retry-second-intent-message",
            "2026-07-13T00:02:01Z",
        )
        .unwrap();
    assert_eq!(retry_run.state(), RunState::Running);
    assert_eq!(
        retry_run.cancellation_state(),
        RunCancellationState::IntentRecorded
    );
    assert_eq!(retry_run.cancellation_intent_history().len(), 2);
    assert_eq!(retry_run.active_cancellation_intent(), Some(&second_intent));
    let event_count_before_old_retry = journal.read_run("run-withdrawn", 0).unwrap().len();
    assert_eq!(
        retry_run
            .record_cancellation_intent(
                &mut journal,
                INTENT_KEY,
                REASON,
                "retry-reused-old-intent",
                "2026-07-13T00:02:02Z",
            )
            .unwrap(),
        retry_intent
    );
    assert_eq!(
        journal.read_run("run-withdrawn", 0).unwrap().len(),
        event_count_before_old_retry
    );
    let second_manifest = "d".repeat(64);
    retry_run
        .mark_cancellation_safe(
            &mut journal,
            second_intent.intent_id(),
            &second_manifest,
            metadata("retry-second-safe"),
        )
        .unwrap();

    drop(journal);
    let reopened = fixture.open();
    assert_eq!(
        RunAggregate::recover(&reopened, "run-safe")
            .unwrap()
            .cancellation_state(),
        RunCancellationState::CancelledSafe
    );
    assert_eq!(
        RunAggregate::recover(&reopened, "run-unknown")
            .unwrap()
            .cancellation_state(),
        RunCancellationState::AbandonedAfterUnknown
    );
    let recovered_retry = RunAggregate::recover(&reopened, "run-withdrawn").unwrap();
    assert_eq!(recovered_retry.state(), RunState::Cancelled);
    assert_eq!(
        recovered_retry.cancellation_state(),
        RunCancellationState::CancelledSafe
    );
    assert_eq!(recovered_retry.cancellation_intent_history().len(), 2);
    assert_eq!(recovered_retry.cancellation_intent(), Some(&second_intent));
}

#[test]
fn replay_rejects_tampered_intent_event_payload_and_canonical_hashes() {
    for case in [
        "version",
        "intent_hash",
        "reason_hash",
        "idempotency",
        "extra",
    ] {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        let run = running_run(&mut journal, "run-tampered-intent");
        let reason_hash = format!("{:x}", Sha256::digest(REASON.as_bytes()));
        let correct_intent_id = derive_run_cancellation_intent_id(
            "workspace-1",
            "run-tampered-intent",
            INTENT_KEY,
            REASON,
        )
        .unwrap();
        let intent_id = if case == "intent_hash" {
            "f".repeat(64)
        } else {
            correct_intent_id
        };
        let mut payload = json!({
            "previousCancellationState": "none",
            "currentCancellationState": "intent_recorded",
            "runState": "running",
            "intentId": intent_id,
            "runId": "run-tampered-intent",
            "workspaceId": "workspace-1",
            "cancelIdempotencyKey": INTENT_KEY,
            "reason": REASON,
            "reasonSha256": if case == "reason_hash" { "e".repeat(64) } else { reason_hash },
            "requestedAt": "2026-07-13T00:00:03Z",
            "commandMessageId": "tampered-intent-message",
        });
        if case == "extra" {
            payload
                .as_object_mut()
                .unwrap()
                .insert("unexpected".to_owned(), Value::Bool(true));
        }
        journal
            .append(
                NewRuntimeEvent {
                    run_id: "run-tampered-intent".to_owned(),
                    aggregate_type: "run".to_owned(),
                    aggregate_id: "run-tampered-intent".to_owned(),
                    message_id: "tampered-intent-message".to_owned(),
                    idempotency_key: if case == "idempotency" {
                        "tampered-idempotency".to_owned()
                    } else {
                        format!("run:run-tampered-intent:cancel-intent:{intent_id}")
                    },
                    event_type: "run.cancellation_intent_recorded".to_owned(),
                    event_version: if case == "version" { 2 } else { 1 },
                    payload,
                    created_at: "2026-07-13T00:00:03Z".to_owned(),
                },
                run.last_run_sequence(),
                run.last_sequence(),
            )
            .unwrap();

        let error = RunAggregate::recover(&journal, "run-tampered-intent").unwrap_err();
        match case {
            "version" => assert!(matches!(
                error,
                RunAggregateError::UnknownEventVersion { .. }
            )),
            "idempotency" => assert!(matches!(
                error,
                RunAggregateError::CancellationStateMismatch
            )),
            _ => assert!(matches!(error, RunAggregateError::InvalidPayload)),
        }
    }
}

#[test]
fn reconciled_v2_replay_binds_intent_evidence_disposition_and_rejects_v1_new_path() {
    for case in [
        "intent",
        "evidence",
        "disposition",
        "idempotency",
        "extra",
        "legacy_v1",
    ] {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        let mut run = running_run(&mut journal, "run-reconciled-v2-tamper");
        let intent = run
            .record_cancellation_intent(
                &mut journal,
                INTENT_KEY,
                REASON,
                "v2-tamper-intent",
                "2026-07-13T02:00:00Z",
            )
            .unwrap();
        let original_evidence = "a".repeat(64);
        run.mark_cancellation_reconciliation_required(
            &mut journal,
            intent.intent_id(),
            &original_evidence,
            metadata("v2-tamper-settlement"),
        )
        .unwrap();

        let payload_intent = if case == "intent" {
            "b".repeat(64)
        } else {
            intent.intent_id().to_owned()
        };
        let payload_evidence = if case == "evidence" {
            "c".repeat(64)
        } else {
            original_evidence.clone()
        };
        let disposition = if case == "disposition" {
            "withdrawn_for_retry"
        } else {
            "abandoned_after_unknown"
        };
        let mut payload = if case == "legacy_v1" {
            json!({
                "previousState": "waiting_for_reconciliation",
                "currentState": "cancelled",
                "reason": null,
                "attemptId": "v2-tamper-attempt",
                "decision": "cancel_run",
                "duplicateExecutionAcknowledged": false,
            })
        } else {
            json!({
                "previousState": "waiting_for_reconciliation",
                "currentState": "cancelled",
                "reason": null,
                "reconciliationIdempotencyKey": "v2-tamper-reconcile-key",
                "attemptId": "v2-tamper-attempt",
                "decision": "cancel_run",
                "duplicateExecutionAcknowledged": false,
                "intentId": payload_intent,
                "unknownEffectsSha256": payload_evidence,
                "cancellationDisposition": disposition,
            })
        };
        if case == "extra" {
            payload
                .as_object_mut()
                .unwrap()
                .insert("unexpected".to_owned(), Value::Bool(true));
        }
        let semantic_idempotency = format!(
            "run:run-reconciled-v2-tamper:cancel-reconciled:{payload_intent}:v2-tamper-attempt:{disposition}:{payload_evidence}"
        );
        journal
            .append(
                NewRuntimeEvent {
                    run_id: "run-reconciled-v2-tamper".to_owned(),
                    aggregate_type: "run".to_owned(),
                    aggregate_id: "run-reconciled-v2-tamper".to_owned(),
                    message_id: "v2-tamper-reconcile-message".to_owned(),
                    idempotency_key: if case == "idempotency" || case == "legacy_v1" {
                        "tampered-reconciliation-idempotency".to_owned()
                    } else {
                        semantic_idempotency
                    },
                    event_type: "run.reconciled".to_owned(),
                    event_version: if case == "legacy_v1" { 1 } else { 2 },
                    payload,
                    created_at: "2026-07-13T02:00:02Z".to_owned(),
                },
                run.last_run_sequence(),
                run.last_sequence(),
            )
            .unwrap();
        let error = RunAggregate::recover(&journal, "run-reconciled-v2-tamper").unwrap_err();
        match case {
            "extra" => assert!(matches!(error, RunAggregateError::InvalidPayload)),
            _ => assert!(matches!(
                error,
                RunAggregateError::CancellationStateMismatch
            )),
        }
    }
}

#[test]
fn replay_rejects_tampered_settlement_and_legacy_events_remain_recoverable() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut run = running_run(&mut journal, "run-tampered-settlement");
    let intent = run
        .record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "settlement-intent-message",
            "2026-07-13T00:00:03Z",
        )
        .unwrap();
    let evidence = "a".repeat(64);
    journal
        .append(
            NewRuntimeEvent {
                run_id: "run-tampered-settlement".to_owned(),
                aggregate_type: "run".to_owned(),
                aggregate_id: "run-tampered-settlement".to_owned(),
                message_id: "tampered-settlement-message".to_owned(),
                idempotency_key: "tampered-settlement-idempotency".to_owned(),
                event_type: "run.cancelled_safe".to_owned(),
                event_version: 1,
                payload: json!({
                    "previousCancellationState": "intent_recorded",
                    "currentCancellationState": "cancelled_safe",
                    "previousState": "running",
                    "currentState": "cancelled",
                    "reason": null,
                    "intentId": intent.intent_id(),
                    "evidenceManifestSha256": evidence,
                }),
                created_at: "2026-07-13T00:00:04Z".to_owned(),
            },
            run.last_run_sequence(),
            run.last_sequence(),
        )
        .unwrap();
    assert!(matches!(
        RunAggregate::recover(&journal, "run-tampered-settlement"),
        Err(RunAggregateError::CancellationStateMismatch)
    ));

    let mut lifecycle = running_run(&mut journal, "run-tampered-lifecycle");
    lifecycle
        .record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "lifecycle-intent-message",
            "2026-07-13T00:00:03Z",
        )
        .unwrap();
    journal
        .append(
            NewRuntimeEvent {
                run_id: "run-tampered-lifecycle".to_owned(),
                aggregate_type: "run".to_owned(),
                aggregate_id: "run-tampered-lifecycle".to_owned(),
                message_id: "tampered-lifecycle-message".to_owned(),
                idempotency_key: "tampered-lifecycle-message".to_owned(),
                event_type: "run.waiting_for_approval".to_owned(),
                event_version: 1,
                payload: json!({
                    "previousState": "running",
                    "currentState": "waiting_for_approval",
                    "reason": null,
                }),
                created_at: "2026-07-13T00:00:04Z".to_owned(),
            },
            lifecycle.last_run_sequence(),
            lifecycle.last_sequence(),
        )
        .unwrap();
    assert!(matches!(
        RunAggregate::recover(&journal, "run-tampered-lifecycle"),
        Err(RunAggregateError::CancellationSettlementRequired)
    ));

    let mut legacy = running_run(&mut journal, "run-legacy-cancel");
    legacy
        .request_cancellation_reconciliation(
            &mut journal,
            &["legacy-attempt-1".to_owned()],
            "legacy unknown provider result",
            metadata("legacy-request"),
        )
        .unwrap();
    assert!(matches!(
        legacy.record_cancellation_intent(
            &mut journal,
            INTENT_KEY,
            REASON,
            "new-intent-during-legacy",
            "2026-07-13T00:00:05Z",
        ),
        Err(RunAggregateError::CancellationSettlementRequired)
    ));
    drop(journal);
    let mut reopened = fixture.open();
    let mut recovered = RunAggregate::recover(&reopened, "run-legacy-cancel").unwrap();
    assert_eq!(recovered.state(), RunState::WaitingForReconciliation);
    assert_eq!(recovered.cancellation_state(), RunCancellationState::None);
    assert_eq!(recovered.cancellation_intent(), None);
    recovered
        .reconcile(
            &mut reopened,
            "legacy-attempt-1",
            RunReconciliationDecision::CancelRun,
            false,
            metadata("legacy-reconcile"),
        )
        .unwrap();
    assert_eq!(recovered.state(), RunState::Cancelled);
    assert_eq!(recovered.cancellation_state(), RunCancellationState::None);
    let legacy_reconciled = reopened
        .read_aggregate("run-legacy-cancel", "run", "run-legacy-cancel", 0)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(legacy_reconciled.event_type, "run.reconciled");
    assert_eq!(legacy_reconciled.event_version, 1);
}

fn running_run(journal: &mut EventJournal, run_id: &str) -> RunAggregate {
    let create_message = format!("{run_id}-create");
    let prepare_message = format!("{run_id}-prepare");
    let start_message = format!("{run_id}-start");
    let mut run = RunAggregate::create(
        journal,
        run_id,
        pinned_identity(),
        EventMetadata {
            message_id: &create_message,
            idempotency_key: &create_message,
            created_at: "2026-07-13T00:00:00Z",
            reason: None,
        },
    )
    .unwrap();
    run.prepare(
        journal,
        EventMetadata {
            message_id: &prepare_message,
            idempotency_key: &prepare_message,
            created_at: "2026-07-13T00:00:01Z",
            reason: None,
        },
    )
    .unwrap();
    run.start(
        journal,
        EventMetadata {
            message_id: &start_message,
            idempotency_key: &start_message,
            created_at: "2026-07-13T00:00:02Z",
            reason: None,
        },
    )
    .unwrap();
    run
}

fn run_at_state(journal: &mut EventJournal, run_id: &str, target: RunState) -> RunAggregate {
    let create_message = format!("{run_id}-matrix-create");
    let mut run = RunAggregate::create(
        journal,
        run_id,
        pinned_identity(),
        EventMetadata {
            message_id: &create_message,
            idempotency_key: &create_message,
            created_at: "2026-07-13T00:09:00Z",
            reason: None,
        },
    )
    .unwrap();
    if target == RunState::Created {
        return run;
    }
    if target == RunState::Cancelled {
        run.cancel(journal, metadata("matrix-cancelled")).unwrap();
        return run;
    }
    if target == RunState::Failed {
        run.fail(journal, metadata("matrix-failed")).unwrap();
        return run;
    }
    run.prepare(journal, metadata("matrix-preparing")).unwrap();
    if target == RunState::Preparing {
        return run;
    }
    if target == RunState::Blocked {
        run.block(journal, metadata("matrix-blocked")).unwrap();
        return run;
    }
    run.start(journal, metadata("matrix-running")).unwrap();
    match target {
        RunState::Running => {}
        RunState::WaitingForApproval => run
            .wait_for_approval(journal, metadata("matrix-waiting-approval"))
            .unwrap(),
        RunState::WaitingForReconciliation => run
            .wait_for_reconciliation(journal, metadata("matrix-waiting-reconciliation"))
            .unwrap(),
        RunState::Committing => run
            .begin_commit(journal, metadata("matrix-committing"))
            .unwrap(),
        RunState::Retrying => run.retry(journal, metadata("matrix-retrying")).unwrap(),
        RunState::Completed => run.complete(journal, metadata("matrix-completed")).unwrap(),
        RunState::Created
        | RunState::Preparing
        | RunState::Blocked
        | RunState::Cancelled
        | RunState::Failed => unreachable!(),
    }
    run
}

fn metadata(message_id: &str) -> EventMetadata<'_> {
    EventMetadata {
        message_id,
        idempotency_key: message_id,
        created_at: "2026-07-13T00:00:04Z",
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
