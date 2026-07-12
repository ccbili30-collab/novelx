use novelx_runtime::event_journal::{EventJournal, NewRuntimeEvent};
use novelx_runtime::provider_attempt::{
    ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptMetadata,
    ProviderAttemptRecovery, ProviderAttemptState,
};
use novelx_runtime::recovery::{RecoveryClassification, RecoveryCoordinator, RecoveryError};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate};
use novelx_runtime::run_state::RunState;
use serde_json::json;
use support::pinned_identity;
use tempfile::TempDir;

#[test]
fn reopens_the_database_and_returns_stably_sorted_mixed_classifications() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        create_run(&mut journal, "01-created", &[]);
        create_run(&mut journal, "02-preparing", &[Step::Prepare]);
        create_run(&mut journal, "03-running", &[Step::Prepare, Step::Start]);
        create_run(
            &mut journal,
            "04-retrying",
            &[Step::Prepare, Step::Start, Step::Retry],
        );
        create_run(
            &mut journal,
            "05-waiting",
            &[Step::Prepare, Step::Start, Step::Wait],
        );
        create_run(
            &mut journal,
            "06-committing",
            &[Step::Prepare, Step::Start, Step::Commit],
        );
        create_run(&mut journal, "07-blocked", &[Step::Prepare, Step::Block]);
        create_run(&mut journal, "08-cancelled", &[Step::Cancel]);
        create_run(&mut journal, "09-failed", &[Step::Fail]);
        create_run(
            &mut journal,
            "10-completed",
            &[Step::Prepare, Step::Start, Step::Complete],
        );
        create_run(
            &mut journal,
            "11-reconciliation",
            &[Step::Prepare, Step::Start, Step::Reconcile],
        );
    }

    let journal = fixture.open();
    let report = RecoveryCoordinator::recover(&journal).unwrap();
    assert_eq!(
        report
            .runs
            .iter()
            .map(|run| run.run_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "01-created",
            "02-preparing",
            "03-running",
            "04-retrying",
            "05-waiting",
            "06-committing",
            "07-blocked",
            "08-cancelled",
            "09-failed",
            "10-completed",
            "11-reconciliation",
        ]
    );
    assert_eq!(report.recovered_nonterminal_count, 7);
    assert_eq!(
        report.runs[0].classification,
        RecoveryClassification::Resumable(RunState::Created)
    );
    assert_eq!(
        report.runs[3].classification,
        RecoveryClassification::Resumable(RunState::Retrying)
    );
    assert_eq!(
        report.runs[4].classification,
        RecoveryClassification::WaitingForApproval
    );
    assert_eq!(
        report.runs[5].classification,
        RecoveryClassification::CommitUncertain
    );
    assert_eq!(
        report.runs[6].classification,
        RecoveryClassification::Terminal(RunState::Blocked)
    );
    assert_eq!(
        report.runs[7].classification,
        RecoveryClassification::Terminal(RunState::Cancelled)
    );
    assert_eq!(
        report.runs[8].classification,
        RecoveryClassification::Terminal(RunState::Failed)
    );
    assert_eq!(
        report.runs[9].classification,
        RecoveryClassification::Terminal(RunState::Completed)
    );
    assert_eq!(report.runs[10].state, RunState::WaitingForReconciliation);
    assert_eq!(
        report.runs[10].classification,
        RecoveryClassification::ReconciliationRequired
    );
}

#[test]
fn one_damaged_run_blocks_the_entire_report_without_writing() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    create_run(&mut journal, "healthy", &[Step::Prepare]);
    create_run(&mut journal, "damaged", &[]);
    journal
        .append(
            NewRuntimeEvent {
                run_id: "damaged".to_owned(),
                aggregate_type: "run".to_owned(),
                aggregate_id: "damaged".to_owned(),
                message_id: "damaged-unknown".to_owned(),
                idempotency_key: "damaged-unknown".to_owned(),
                event_type: "run.future".to_owned(),
                event_version: 1,
                payload: json!({
                    "previousState": "created",
                    "currentState": "running",
                    "reason": null,
                }),
                created_at: "2026-07-12T00:00:02Z".to_owned(),
            },
            1,
            1,
        )
        .unwrap();
    let event_count_before = journal.read_run("damaged", 0).unwrap().len();

    assert!(matches!(
        RecoveryCoordinator::recover(&journal),
        Err(RecoveryError::RunRecoveryFailed { run_id, .. }) if run_id == "damaged"
    ));
    assert_eq!(
        journal.read_run("damaged", 0).unwrap().len(),
        event_count_before
    );
}

#[test]
fn tool_only_aggregates_are_not_reported_as_runs() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    journal
        .append(
            NewRuntimeEvent {
                run_id: "tool-only-run".to_owned(),
                aggregate_type: "tool".to_owned(),
                aggregate_id: "tool-1".to_owned(),
                message_id: "tool-message".to_owned(),
                idempotency_key: "tool-key".to_owned(),
                event_type: "tool.requested".to_owned(),
                event_version: 1,
                payload: json!({ "tool": "read_project_file" }),
                created_at: "2026-07-12T00:00:00Z".to_owned(),
            },
            0,
            0,
        )
        .unwrap();
    create_run(&mut journal, "real-run", &[]);

    let report = RecoveryCoordinator::recover(&journal).unwrap();
    assert_eq!(report.runs.len(), 1);
    assert_eq!(report.runs[0].run_id, "real-run");
    assert_eq!(report.recovered_nonterminal_count, 1);
}

#[test]
fn sent_provider_attempt_is_reported_as_outcome_unknown_without_writing() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    create_run(&mut journal, "provider-run", &[]);
    let mut attempt = ProviderAttemptAggregate::create(
        &mut journal,
        "provider-run",
        "attempt-1",
        ProviderAttemptDefinition {
            run_id: "provider-run".to_owned(),
            inference_id: "inference-1".to_owned(),
            invocation_id: "invocation-1".to_owned(),
            context_compilation_id: uuid::Uuid::new_v4(),
            canonical_context_sha256: "a".repeat(64),
            transport_payload_sha256: "b".repeat(64),
            provider: pinned_identity().provider,
            request_number: 1,
            attempt_number: 1,
            output_reserve_tokens: 1_024,
            request_timeout_ms: 30_000,
            total_deadline_ms: 120_000,
            max_attempts: 3,
            max_total_delay_ms: 30_000,
        },
        1,
        provider_metadata("provider-requested", "provider-requested-key"),
    )
    .unwrap();
    attempt
        .mark_sent(
            &mut journal,
            2,
            "dispatch-1",
            provider_metadata("provider-sent", "provider-sent-key"),
        )
        .unwrap();
    let count_before = journal.read_run("provider-run", 0).unwrap().len();

    let report = RecoveryCoordinator::recover(&journal).unwrap();

    assert_eq!(report.provider_attempts.len(), 1);
    assert_eq!(
        report.provider_attempts[0].state,
        ProviderAttemptState::Sent
    );
    assert_eq!(
        report.provider_attempts[0].recovery,
        ProviderAttemptRecovery::OutcomeUnknown
    );
    assert_eq!(
        report.runs[0].classification,
        RecoveryClassification::ReconciliationRequired
    );
    assert_eq!(
        journal.read_run("provider-run", 0).unwrap().len(),
        count_before
    );
}

#[test]
fn terminal_run_with_unknown_provider_outcome_rejects_recovery() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    create_run(&mut journal, "terminal-provider-run", &[Step::Cancel]);
    let mut attempt = ProviderAttemptAggregate::create(
        &mut journal,
        "terminal-provider-run",
        "attempt-terminal",
        ProviderAttemptDefinition {
            run_id: "terminal-provider-run".to_owned(),
            inference_id: "inference-terminal".to_owned(),
            invocation_id: "invocation-terminal".to_owned(),
            context_compilation_id: uuid::Uuid::new_v4(),
            canonical_context_sha256: "a".repeat(64),
            transport_payload_sha256: "b".repeat(64),
            provider: pinned_identity().provider,
            request_number: 1,
            attempt_number: 1,
            output_reserve_tokens: 1_024,
            request_timeout_ms: 30_000,
            total_deadline_ms: 120_000,
            max_attempts: 3,
            max_total_delay_ms: 30_000,
        },
        2,
        provider_metadata("terminal-requested", "terminal-requested-key"),
    )
    .unwrap();
    attempt
        .mark_sent(
            &mut journal,
            3,
            "terminal-dispatch",
            provider_metadata("terminal-sent", "terminal-sent-key"),
        )
        .unwrap();

    assert!(matches!(
        RecoveryCoordinator::recover(&journal),
        Err(RecoveryError::TerminalRunHasUnknownProviderOutcome {
            run_id,
            attempt_id,
            state: RunState::Cancelled,
        }) if run_id == "terminal-provider-run" && attempt_id == "attempt-terminal"
    ));
}

fn provider_metadata<'a>(message_id: &'a str, key: &'a str) -> ProviderAttemptMetadata<'a> {
    ProviderAttemptMetadata {
        message_id,
        idempotency_key: key,
        created_at: "2026-07-12T00:00:00Z",
        reason: None,
    }
}

#[derive(Clone, Copy)]
enum Step {
    Prepare,
    Start,
    Wait,
    Commit,
    Retry,
    Block,
    Cancel,
    Fail,
    Complete,
    Reconcile,
}

fn create_run(journal: &mut EventJournal, run_id: &str, steps: &[Step]) {
    let created_message = format!("{run_id}-message-0");
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
    for (index, step) in steps.iter().enumerate() {
        let message_id = format!("{run_id}-message-{}", index + 1);
        let metadata = EventMetadata {
            message_id: &message_id,
            idempotency_key: &message_id,
            created_at: "2026-07-12T00:00:00Z",
            reason: None,
        };
        match step {
            Step::Prepare => run.prepare(journal, metadata),
            Step::Start => run.start(journal, metadata),
            Step::Wait => run.wait_for_approval(journal, metadata),
            Step::Commit => run.begin_commit(journal, metadata),
            Step::Retry => run.retry(journal, metadata),
            Step::Block => run.block(journal, metadata),
            Step::Cancel => run.cancel(journal, metadata),
            Step::Fail => run.fail(journal, metadata),
            Step::Complete => run.complete(journal, metadata),
            Step::Reconcile => run.wait_for_reconciliation(journal, metadata),
        }
        .unwrap();
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
mod support;
