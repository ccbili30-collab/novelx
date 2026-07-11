use thiserror::Error;

use crate::event_journal::{EventJournal, EventJournalError};
use crate::run_aggregate::{RunAggregate, RunAggregateError};
use crate::run_state::RunState;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryClassification {
    Resumable(RunState),
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
    pub recovered_nonterminal_count: u64,
}

pub struct RecoveryCoordinator;

impl RecoveryCoordinator {
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
        runs.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        let recovered_nonterminal_count = runs
            .iter()
            .filter(|run| !matches!(run.classification, RecoveryClassification::Terminal(_)))
            .count() as u64;
        Ok(RecoveryReport {
            runs,
            recovered_nonterminal_count,
        })
    }
}

#[derive(Debug, Error)]
pub enum RecoveryError {
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
    #[error(transparent)]
    Journal(#[from] EventJournalError),
}

const fn classify(state: RunState) -> RecoveryClassification {
    match state {
        RunState::Created | RunState::Preparing | RunState::Running | RunState::Retrying => {
            RecoveryClassification::Resumable(state)
        }
        RunState::WaitingForApproval => RecoveryClassification::WaitingForApproval,
        RunState::Committing => RecoveryClassification::CommitUncertain,
        RunState::Blocked | RunState::Cancelled | RunState::Failed | RunState::Completed => {
            RecoveryClassification::Terminal(state)
        }
    }
}
