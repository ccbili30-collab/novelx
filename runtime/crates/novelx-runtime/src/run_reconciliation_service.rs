use novelx_protocol::{
    RunLifecycleState, RunReconcile, RunReconcileValidationError, RunReconciliationDecision,
    RunReconciliationReceipt,
};
use thiserror::Error;

use crate::event_journal::{EventJournal, EventJournalError};
use crate::provider_attempt::{
    ProviderAttemptAggregate, ProviderAttemptError, ProviderAttemptRecovery,
};
use crate::run_aggregate::{EventMetadata, RunAggregate, RunAggregateError};

pub struct RunReconciliationService<'a> {
    journal: &'a mut EventJournal,
}

impl<'a> RunReconciliationService<'a> {
    pub const fn new(journal: &'a mut EventJournal) -> Self {
        Self { journal }
    }

    pub fn reconcile(
        &mut self,
        run_id: &str,
        command: &RunReconcile,
        message_id: &str,
        created_at: &str,
    ) -> Result<RunReconciliationReceipt, RunReconciliationServiceError> {
        command.validate()?;
        if run_id.trim().is_empty() || message_id.trim().is_empty() || created_at.trim().is_empty()
        {
            return Err(RunReconciliationServiceError::InvalidIdentity);
        }
        let mut run = RunAggregate::recover(self.journal, run_id)?;
        let attempt_id = command.attempt_id.to_string();
        if self
            .journal
            .read_aggregate(run_id, "provider_attempt", &attempt_id, 0)?
            .is_empty()
        {
            return Err(RunReconciliationServiceError::AttemptNotFound);
        }
        let attempt = ProviderAttemptAggregate::recover(self.journal, run_id, &attempt_id)?;
        if attempt.definition().run_id != run_id {
            return Err(RunReconciliationServiceError::AttemptRunMismatch);
        }
        if attempt.recovery() != ProviderAttemptRecovery::OutcomeUnknown {
            return Err(RunReconciliationServiceError::AttemptOutcomeKnown);
        }
        run.reconcile(
            self.journal,
            &attempt_id,
            command.decision,
            command.duplicate_execution_acknowledged,
            EventMetadata {
                message_id,
                idempotency_key: &command.reconciliation_idempotency_key,
                created_at,
                reason: Some(match command.decision {
                    RunReconciliationDecision::CancelRun => "provider_outcome_unknown_cancelled",
                    RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate => {
                        "provider_outcome_unknown_duplicate_acknowledged"
                    }
                }),
            },
        )?;
        Ok(RunReconciliationReceipt {
            attempt_id: command.attempt_id,
            decision: command.decision,
            state: match command.decision {
                RunReconciliationDecision::CancelRun => RunLifecycleState::Cancelled,
                RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate => {
                    RunLifecycleState::Retrying
                }
            },
        })
    }
}

#[derive(Debug, Error)]
pub enum RunReconciliationServiceError {
    #[error("run reconciliation identity is invalid")]
    InvalidIdentity,
    #[error("the Provider attempt does not exist in this Run")]
    AttemptNotFound,
    #[error("the Provider attempt belongs to another Run")]
    AttemptRunMismatch,
    #[error("the Provider attempt outcome is not unknown")]
    AttemptOutcomeKnown,
    #[error(transparent)]
    InvalidCommand(#[from] RunReconcileValidationError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    Attempt(#[from] ProviderAttemptError),
    #[error(transparent)]
    Run(#[from] RunAggregateError),
}

#[cfg(test)]
mod tests {
    use novelx_protocol::{
        ProviderRunIdentity, RunPermissionMode, RunPinnedIdentity, VersionedPolicyIdentity,
    };
    use tempfile::TempDir;
    use uuid::Uuid;

    use super::*;
    use crate::provider_attempt::{ProviderAttemptDefinition, ProviderAttemptMetadata};
    use crate::run_state::RunState;

    #[test]
    fn retries_idempotently_only_after_acknowledging_duplicate_execution() {
        let fixture = TempDir::new().unwrap();
        let mut journal = EventJournal::open(fixture.path().join("workspace.db")).unwrap();
        let (run_id, attempt_id) = waiting_run(&mut journal);
        let command = RunReconcile {
            reconciliation_idempotency_key: "reconcile-key-1".to_owned(),
            attempt_id,
            decision: RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate,
            duplicate_execution_acknowledged: true,
        };
        let mut service = RunReconciliationService::new(&mut journal);
        let first = service
            .reconcile(&run_id, &command, "message-1", "2026-07-12T00:00:04Z")
            .unwrap();
        let second = service
            .reconcile(&run_id, &command, "message-2", "2026-07-12T00:00:05Z")
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(
            RunAggregate::recover(&journal, &run_id).unwrap().state(),
            RunState::Retrying
        );
        assert_eq!(
            journal
                .read_aggregate(&run_id, "run", &run_id, 0)
                .unwrap()
                .iter()
                .filter(|event| event.event_type == "run.reconciled")
                .count(),
            1
        );
    }

    #[test]
    fn cancel_is_recoverable_and_rejects_a_known_or_foreign_attempt() {
        let fixture = TempDir::new().unwrap();
        let mut journal = EventJournal::open(fixture.path().join("workspace.db")).unwrap();
        let (run_id, attempt_id) = waiting_run(&mut journal);
        let command = RunReconcile {
            reconciliation_idempotency_key: "reconcile-cancel".to_owned(),
            attempt_id,
            decision: RunReconciliationDecision::CancelRun,
            duplicate_execution_acknowledged: false,
        };
        RunReconciliationService::new(&mut journal)
            .reconcile(&run_id, &command, "message-cancel", "2026-07-12T00:00:04Z")
            .unwrap();
        assert_eq!(
            RunAggregate::recover(&journal, &run_id).unwrap().state(),
            RunState::Cancelled
        );

        let missing = RunReconcile {
            attempt_id: Uuid::new_v4(),
            reconciliation_idempotency_key: "missing".to_owned(),
            ..command
        };
        assert!(matches!(
            RunReconciliationService::new(&mut journal).reconcile(
                &run_id,
                &missing,
                "missing-message",
                "2026-07-12T00:00:05Z"
            ),
            Err(RunReconciliationServiceError::AttemptNotFound)
        ));
    }

    fn waiting_run(journal: &mut EventJournal) -> (String, Uuid) {
        let run_id = Uuid::new_v4().to_string();
        let attempt_id = Uuid::new_v4();
        let mut run = RunAggregate::create(
            journal,
            &run_id,
            pinned_identity(),
            metadata("run-created", "run-created"),
        )
        .unwrap();
        run.prepare(journal, metadata("run-preparing", "run-preparing"))
            .unwrap();
        run.start(journal, metadata("run-running", "run-running"))
            .unwrap();
        let mut attempt = ProviderAttemptAggregate::create(
            journal,
            &run_id,
            &attempt_id.to_string(),
            definition(&run_id),
            run.last_run_sequence(),
            attempt_metadata("attempt-requested", "attempt-requested"),
        )
        .unwrap();
        let sequence = attempt_run_sequence(journal, &run_id);
        attempt
            .mark_sent(
                journal,
                sequence,
                "dispatch-1",
                attempt_metadata("attempt-sent", "attempt-sent"),
            )
            .unwrap();
        let sequence = attempt_run_sequence(journal, &run_id);
        attempt
            .mark_outcome_unknown(
                journal,
                sequence,
                Uuid::new_v4(),
                attempt_metadata("attempt-unknown", "attempt-unknown"),
            )
            .unwrap();
        run = RunAggregate::recover(journal, &run_id).unwrap();
        run.wait_for_reconciliation(journal, metadata("run-waiting", "run-waiting"))
            .unwrap();
        (run_id, attempt_id)
    }

    fn attempt_run_sequence(journal: &EventJournal, run_id: &str) -> u64 {
        journal
            .read_run(run_id, 0)
            .unwrap()
            .last()
            .unwrap()
            .run_sequence
    }

    fn definition(run_id: &str) -> ProviderAttemptDefinition {
        ProviderAttemptDefinition {
            run_id: run_id.to_owned(),
            inference_id: Uuid::new_v4().to_string(),
            invocation_id: "invocation-1".to_owned(),
            context_compilation_id: Uuid::new_v4(),
            canonical_context_sha256: "a".repeat(64),
            transport_payload_sha256: "b".repeat(64),
            provider: ProviderRunIdentity {
                profile_id: "profile-1".to_owned(),
                provider_id: "deepseek".to_owned(),
                model_id: "deepseek-chat".to_owned(),
                config_sha256: "c".repeat(64),
            },
            request_number: 1,
            attempt_number: 1,
            output_reserve_tokens: 100,
            request_timeout_ms: 1_000,
            total_deadline_ms: 2_000,
            max_attempts: 2,
            max_total_delay_ms: 500,
        }
    }

    fn metadata<'a>(message_id: &'a str, key: &'a str) -> EventMetadata<'a> {
        EventMetadata {
            message_id,
            idempotency_key: key,
            created_at: "2026-07-12T00:00:00Z",
            reason: None,
        }
    }

    fn attempt_metadata<'a>(message_id: &'a str, key: &'a str) -> ProviderAttemptMetadata<'a> {
        ProviderAttemptMetadata {
            message_id,
            idempotency_key: key,
            created_at: "2026-07-12T00:00:00Z",
            reason: None,
        }
    }

    fn pinned_identity() -> RunPinnedIdentity {
        let policy = |id: &str, hash: char| VersionedPolicyIdentity {
            id: id.to_owned(),
            version: "1.0.0".to_owned(),
            sha256: hash.to_string().repeat(64),
        };
        RunPinnedIdentity {
            project_id: "project".to_owned(),
            workspace_id: "workspace".to_owned(),
            session_id: "session".to_owned(),
            session_branch_id: "branch".to_owned(),
            user_message_id: "message".to_owned(),
            project_branch_id: "project-branch".to_owned(),
            goal: None,
            plan: None,
            provider: ProviderRunIdentity {
                profile_id: "profile-1".to_owned(),
                provider_id: "deepseek".to_owned(),
                model_id: "deepseek-chat".to_owned(),
                config_sha256: "c".repeat(64),
            },
            prompt_bundle: policy("prompt", 'd'),
            agent_profile: policy("agent", 'e'),
            tool_policy: policy("tool", 'f'),
            context_policy: policy("context", '1'),
            runtime_policy: policy("runtime", '2'),
            runtime_contract_version: "1.0.0".to_owned(),
            mode: RunPermissionMode::Assist,
            source_checkpoint_id: "checkpoint".to_owned(),
            scope_resource_ids: vec!["resource".to_owned()],
            resource_scope_sha256: "3".repeat(64),
            user_input_sha256: "4".repeat(64),
        }
    }
}
