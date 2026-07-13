use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::event_journal::{EventJournal, EventJournalError};
use crate::provider_attempt::{
    ProviderAttemptAggregate, ProviderAttemptError, ProviderAttemptRecovery, ProviderAttemptState,
};
use crate::run_aggregate::{EventMetadata, RunAggregate, RunAggregateError};
use crate::run_state::RunState;
use crate::workspace_runtime_lease::{BoundWorkspaceRuntimeLease, BoundWorkspaceRuntimeLeaseError};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryClassification {
    Resumable(RunState),
    ReconciliationRequired,
    WaitingForApproval,
    CommitUncertain,
    Terminal(RunState),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveredRun {
    pub run_id: String,
    pub state: RunState,
    pub classification: RecoveryClassification,
    pub last_run_sequence: u64,
    pub last_aggregate_sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryReport {
    pub runs: Vec<RecoveredRun>,
    pub provider_attempts: Vec<RecoveredProviderAttempt>,
    pub recovered_nonterminal_count: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveredProviderAttempt {
    pub run_id: String,
    pub attempt_id: String,
    pub state: ProviderAttemptState,
    pub recovery: ProviderAttemptRecovery,
    pub aggregate_sequence: u64,
}

pub struct RecoveryCoordinator;

impl RecoveryCoordinator {
    pub fn recover_and_reconcile(
        journal: &mut EventJournal,
        exclusive_lease: &BoundWorkspaceRuntimeLease,
    ) -> Result<RecoveryReport, RecoveryError> {
        let attempts = journal.list_aggregates("provider_attempt")?;
        for address in attempts {
            let attempt =
                ProviderAttemptAggregate::recover(journal, &address.run_id, &address.aggregate_id)
                    .map_err(|source| RecoveryError::ProviderAttemptRecoveryFailed {
                        run_id: address.run_id.clone(),
                        attempt_id: address.aggregate_id.clone(),
                        source: Box::new(source),
                    })?;
            if !matches!(attempt.recovery(), ProviderAttemptRecovery::OutcomeUnknown) {
                continue;
            }
            if attempt_was_reconciled(journal, &address.run_id, &address.aggregate_id)? {
                continue;
            }
            let mut run = RunAggregate::recover(journal, &address.run_id).map_err(|source| {
                RecoveryError::RunRecoveryFailed {
                    run_id: address.run_id.clone(),
                    source,
                }
            })?;
            if run.state() == RunState::WaitingForReconciliation {
                continue;
            }
            if !matches!(run.state(), RunState::Running | RunState::Retrying) {
                return Err(RecoveryError::TerminalRunHasUnknownProviderOutcome {
                    run_id: address.run_id,
                    attempt_id: address.aggregate_id,
                    state: run.state(),
                });
            }
            let message_id = Uuid::new_v4().to_string();
            let idempotency_key = format!("recovery:{}:run-reconciliation", address.aggregate_id);
            let created_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
            exclusive_lease.verify_database_authority(journal.database_path())?;
            run.wait_for_reconciliation(
                journal,
                EventMetadata {
                    message_id: &message_id,
                    idempotency_key: &idempotency_key,
                    created_at: &created_at,
                    reason: Some("recovered_provider_outcome_unknown"),
                },
            )?;
        }
        Self::recover(journal)
    }

    pub fn recover(journal: &EventJournal) -> Result<RecoveryReport, RecoveryError> {
        let addresses = journal.list_aggregates("run")?;
        let mut runs = Vec::with_capacity(addresses.len());
        for address in addresses {
            if address.aggregate_id != address.run_id {
                return Err(RecoveryError::RunAddressMismatch {
                    run_id: address.run_id,
                    aggregate_id: address.aggregate_id,
                });
            }
            let run_id = address.run_id;
            let aggregate = RunAggregate::recover(journal, &run_id).map_err(|source| {
                RecoveryError::RunRecoveryFailed {
                    run_id: run_id.clone(),
                    source,
                }
            })?;
            let state = aggregate.state();
            runs.push(RecoveredRun {
                run_id,
                state,
                classification: classify(state),
                last_run_sequence: aggregate.last_run_sequence(),
                last_aggregate_sequence: aggregate.last_sequence(),
            });
        }
        let mut provider_attempts = Vec::new();
        for address in journal.list_aggregates("provider_attempt")? {
            let attempt =
                ProviderAttemptAggregate::recover(journal, &address.run_id, &address.aggregate_id)
                    .map_err(|source| RecoveryError::ProviderAttemptRecoveryFailed {
                        run_id: address.run_id.clone(),
                        attempt_id: address.aggregate_id.clone(),
                        source: Box::new(source),
                    })?;
            provider_attempts.push(RecoveredProviderAttempt {
                run_id: address.run_id,
                attempt_id: address.aggregate_id,
                state: attempt.state(),
                recovery: attempt.recovery(),
                aggregate_sequence: attempt.aggregate_sequence(),
            });
        }
        provider_attempts.sort_by(|left, right| {
            left.run_id
                .cmp(&right.run_id)
                .then(left.attempt_id.cmp(&right.attempt_id))
        });
        for attempt in provider_attempts
            .iter()
            .filter(|attempt| matches!(attempt.recovery, ProviderAttemptRecovery::OutcomeUnknown))
        {
            if attempt_was_reconciled(journal, &attempt.run_id, &attempt.attempt_id)? {
                continue;
            }
            let run = runs
                .iter_mut()
                .find(|run| run.run_id == attempt.run_id)
                .ok_or_else(|| RecoveryError::ProviderAttemptRunMissing {
                    run_id: attempt.run_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                })?;
            if run.state.is_terminal() {
                return Err(RecoveryError::TerminalRunHasUnknownProviderOutcome {
                    run_id: run.run_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    state: run.state,
                });
            }
            run.classification = RecoveryClassification::ReconciliationRequired;
        }
        runs.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        let recovered_nonterminal_count = runs
            .iter()
            .filter(|run| !matches!(run.classification, RecoveryClassification::Terminal(_)))
            .count() as u64;
        Ok(RecoveryReport {
            runs,
            provider_attempts,
            recovered_nonterminal_count,
        })
    }
}

fn attempt_was_reconciled(
    journal: &EventJournal,
    run_id: &str,
    attempt_id: &str,
) -> Result<bool, EventJournalError> {
    Ok(journal
        .read_aggregate(run_id, "run", run_id, 0)?
        .into_iter()
        .any(|event| {
            event.event_type == "run.reconciled"
                && event.event_version == 1
                && event
                    .payload
                    .get("attemptId")
                    .and_then(serde_json::Value::as_str)
                    == Some(attempt_id)
        }))
}

#[derive(Debug, Error)]
pub enum RecoveryError {
    #[error(transparent)]
    WorkspaceLease(#[from] BoundWorkspaceRuntimeLeaseError),
    #[error("run aggregate address mismatch for run `{run_id}` and aggregate `{aggregate_id}`")]
    RunAddressMismatch {
        run_id: String,
        aggregate_id: String,
    },
    #[error("run `{run_id}` recovery failed: {source}")]
    RunRecoveryFailed {
        run_id: String,
        #[source]
        source: RunAggregateError,
    },
    #[error("provider attempt `{attempt_id}` in run `{run_id}` recovery failed: {source}")]
    ProviderAttemptRecoveryFailed {
        run_id: String,
        attempt_id: String,
        #[source]
        source: Box<ProviderAttemptError>,
    },
    #[error("provider attempt `{attempt_id}` references missing run `{run_id}`")]
    ProviderAttemptRunMissing { run_id: String, attempt_id: String },
    #[error(
        "terminal run `{run_id}` in state {state:?} has provider attempt `{attempt_id}` with an unknown outcome"
    )]
    TerminalRunHasUnknownProviderOutcome {
        run_id: String,
        attempt_id: String,
        state: RunState,
    },
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    Run(#[from] RunAggregateError),
    #[error(transparent)]
    Time(#[from] time::error::Format),
}

const fn classify(state: RunState) -> RecoveryClassification {
    match state {
        RunState::Created | RunState::Preparing | RunState::Running | RunState::Retrying => {
            RecoveryClassification::Resumable(state)
        }
        RunState::WaitingForApproval => RecoveryClassification::WaitingForApproval,
        RunState::WaitingForReconciliation => RecoveryClassification::ReconciliationRequired,
        RunState::Committing => RecoveryClassification::CommitUncertain,
        RunState::Blocked | RunState::Cancelled | RunState::Failed | RunState::Completed => {
            RecoveryClassification::Terminal(state)
        }
    }
}
