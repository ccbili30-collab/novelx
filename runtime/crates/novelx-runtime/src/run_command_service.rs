use novelx_protocol::{
    RunLifecycleState, RunRecoveryClassification, RunSnapshot, RunStart, RuntimeError,
    RuntimeErrorClass,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::event_journal::{EventJournal, EventJournalError};
use crate::run_aggregate::{EventMetadata, RunAggregate, RunAggregateError};
use crate::run_state::RunState;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceBinding {
    pub project_id: String,
    pub workspace_id: String,
}

pub struct RunCommandService<'a> {
    journal: &'a mut Option<EventJournal>,
    workspace_binding: Option<&'a WorkspaceBinding>,
}

impl<'a> RunCommandService<'a> {
    pub fn new(
        journal: &'a mut Option<EventJournal>,
        workspace_binding: Option<&'a WorkspaceBinding>,
    ) -> Self {
        Self {
            journal,
            workspace_binding,
        }
    }

    pub fn start(
        &mut self,
        run_id: Uuid,
        command_message_id: Uuid,
        start: RunStart,
    ) -> Result<RunSnapshot, RunCommandFailure> {
        let journal = self.journal.as_mut().ok_or_else(|| {
            failure(
                "RUNTIME_STORAGE_REQUIRED",
                RuntimeErrorClass::Storage,
                "当前运行时没有绑定项目存储，无法创建任务。",
                "run.start.storage",
                false,
            )
        })?;
        let binding = self.workspace_binding.ok_or_else(|| {
            failure(
                "RUNTIME_WORKSPACE_BINDING_REQUIRED",
                RuntimeErrorClass::Validation,
                "当前运行时缺少项目身份绑定，无法创建任务。",
                "run.start.binding",
                false,
            )
        })?;
        if start.pinned_identity.project_id != binding.project_id
            || start.pinned_identity.workspace_id != binding.workspace_id
        {
            return Err(failure(
                "RUN_WORKSPACE_BINDING_CONFLICT",
                RuntimeErrorClass::SourceConflict,
                "任务绑定的项目与当前运行时不一致，未写入任何数据。",
                "run.start.binding",
                false,
            ));
        }

        let created_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|error| internal_failure("run.start.timestamp", error.to_string()))?;
        let message_id = command_message_id.to_string();
        RunAggregate::create(
            journal,
            &run_id.to_string(),
            start.pinned_identity,
            EventMetadata {
                message_id: &message_id,
                idempotency_key: &start.start_idempotency_key,
                created_at: &created_at,
                reason: None,
            },
        )
        .map(|run| snapshot(&run))
        .map_err(|error| aggregate_failure("run.start.persist", error))
    }

    pub fn get(&mut self, run_id: Uuid) -> Result<RunSnapshot, RunCommandFailure> {
        let journal = self.journal.as_ref().ok_or_else(|| {
            failure(
                "RUNTIME_STORAGE_REQUIRED",
                RuntimeErrorClass::Storage,
                "当前运行时没有绑定项目存储，无法查询任务。",
                "run.get.storage",
                false,
            )
        })?;
        match RunAggregate::recover(journal, &run_id.to_string()) {
            Ok(run) => Ok(snapshot(&run)),
            Err(RunAggregateError::NotFound(_)) => Err(failure(
                "RUN_NOT_FOUND",
                RuntimeErrorClass::Validation,
                "没有找到这个任务。",
                "run.get.recover",
                false,
            )),
            Err(error) => Err(aggregate_failure("run.get.recover", error)),
        }
    }
}

#[derive(Debug)]
pub struct RunCommandFailure {
    pub error: Box<RuntimeError>,
    pub fatal: bool,
    pub internal_message: String,
}

fn snapshot(run: &RunAggregate) -> RunSnapshot {
    let run_id = Uuid::parse_str(run.run_id()).expect("Run IDs accepted by the protocol are UUIDs");
    RunSnapshot {
        run_id,
        pinned_identity: run.pinned_identity().clone(),
        state: lifecycle_state(run.state()),
        recovery_classification: recovery_classification(run.state()),
        run_sequence: run.last_run_sequence(),
        aggregate_sequence: run.last_sequence(),
        created_at: run.created_at().to_owned(),
        updated_at: run.updated_at().to_owned(),
    }
}

fn aggregate_failure(stage: &str, error: RunAggregateError) -> RunCommandFailure {
    let fatal = is_fatal_run_error(&error);
    let (code, class) = match &error {
        RunAggregateError::InvalidPinnedIdentity(_) => {
            ("RUN_PINNED_IDENTITY_INVALID", RuntimeErrorClass::Validation)
        }
        RunAggregateError::Journal(EventJournalError::IdempotencyConflict { .. }) => (
            "RUN_START_IDEMPOTENCY_CONFLICT",
            RuntimeErrorClass::Protocol,
        ),
        RunAggregateError::Journal(EventJournalError::MessageIdConflict { .. }) => {
            ("MESSAGE_ID_CONFLICT", RuntimeErrorClass::Protocol)
        }
        RunAggregateError::UnknownEvent(_)
        | RunAggregateError::UnknownEventVersion { .. }
        | RunAggregateError::InvalidPayload
        | RunAggregateError::StateMismatch
        | RunAggregateError::SequenceGap { .. }
        | RunAggregateError::DuplicateCreated => (
            "RUN_JOURNAL_INTEGRITY_FAILED",
            RuntimeErrorClass::Validation,
        ),
        _ => ("RUN_PERSISTENCE_FAILED", RuntimeErrorClass::Storage),
    };
    let internal_message = format!("{stage}: {error}");
    let mut result = failure(
        code,
        class,
        "任务状态无法安全处理，项目数据未被覆盖。",
        stage,
        fatal,
    );
    result.internal_message = internal_message;
    result
}

fn internal_failure(stage: &str, internal_message: String) -> RunCommandFailure {
    let mut result = failure(
        "RUN_RUNTIME_INTERNAL_FAILED",
        RuntimeErrorClass::RuntimeCrash,
        "运行时无法安全处理这个任务。",
        stage,
        true,
    );
    result.internal_message = internal_message;
    result
}

fn failure(
    code: &str,
    class: RuntimeErrorClass,
    public_message: &str,
    stage: &str,
    fatal: bool,
) -> RunCommandFailure {
    RunCommandFailure {
        error: Box::new(RuntimeError {
            code: code.to_owned(),
            class,
            retryable: false,
            public_message: public_message.to_owned(),
            stage: stage.to_owned(),
            attempt: 0,
            diagnostic_id: Uuid::new_v4(),
        }),
        fatal,
        internal_message: code.to_owned(),
    }
}

fn is_fatal_run_error(error: &RunAggregateError) -> bool {
    matches!(
        error,
        RunAggregateError::SequenceGap { .. }
            | RunAggregateError::UnknownEvent(_)
            | RunAggregateError::UnknownEventVersion { .. }
            | RunAggregateError::DuplicateCreated
            | RunAggregateError::InvalidPayload
            | RunAggregateError::StateMismatch
            | RunAggregateError::Journal(
                EventJournalError::MigrationChecksumMismatch { .. }
                    | EventJournalError::MigrationVerificationFailed
                    | EventJournalError::SchemaIntegrityFailed
                    | EventJournalError::Storage(_)
            )
    )
}

fn lifecycle_state(state: RunState) -> RunLifecycleState {
    match state {
        RunState::Created => RunLifecycleState::Created,
        RunState::Preparing => RunLifecycleState::Preparing,
        RunState::Running => RunLifecycleState::Running,
        RunState::WaitingForApproval => RunLifecycleState::WaitingForApproval,
        RunState::Committing => RunLifecycleState::Committing,
        RunState::Retrying => RunLifecycleState::Retrying,
        RunState::Blocked => RunLifecycleState::Blocked,
        RunState::Cancelled => RunLifecycleState::Cancelled,
        RunState::Failed => RunLifecycleState::Failed,
        RunState::Completed => RunLifecycleState::Completed,
    }
}

fn recovery_classification(state: RunState) -> RunRecoveryClassification {
    match state {
        RunState::Created | RunState::Preparing | RunState::Running | RunState::Retrying => {
            RunRecoveryClassification::Resumable
        }
        RunState::WaitingForApproval => RunRecoveryClassification::WaitingForApproval,
        RunState::Committing => RunRecoveryClassification::CommitUncertain,
        RunState::Blocked | RunState::Cancelled | RunState::Failed | RunState::Completed => {
            RunRecoveryClassification::Terminal
        }
    }
}
