use novelx_protocol::{
    RunCancel, RunLifecycleState, RunPrepare, RunRecoveryClassification, RunSnapshot, RunStart,
    RuntimeError, RuntimeErrorClass,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::event_journal::{EventJournal, EventJournalError};
use crate::provider_gateway::{ProviderGatewayError, ProviderRegistry};
use crate::run_aggregate::{EventMetadata, RunAggregate, RunAggregateError};
use crate::run_pin_validator::{RunPinValidationError, RunPinValidator};
use crate::run_state::RunState;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceBinding {
    pub project_id: String,
    pub workspace_id: String,
}

pub struct RunCommandService<'a> {
    journal: &'a mut Option<EventJournal>,
    workspace_binding: Option<&'a WorkspaceBinding>,
    pin_validator: Option<&'a RunPinValidator>,
}

impl<'a> RunCommandService<'a> {
    pub fn new(
        journal: &'a mut Option<EventJournal>,
        workspace_binding: Option<&'a WorkspaceBinding>,
    ) -> Self {
        Self {
            journal,
            workspace_binding,
            pin_validator: None,
        }
    }

    pub fn with_pin_validator(mut self, validator: &'a RunPinValidator) -> Self {
        self.pin_validator = Some(validator);
        self
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

        let run_id_text = run_id.to_string();
        match RunAggregate::recover(journal, &run_id_text) {
            Ok(_) => {}
            Err(RunAggregateError::NotFound(_)) => {
                if start.pinned_identity.goal.is_some()
                    || start.pinned_identity.plan.is_some()
                    || start.pinned_identity.assignment.is_some()
                {
                    self.pin_validator
                        .ok_or_else(|| {
                            failure(
                                "RUN_PIN_VALIDATOR_REQUIRED",
                                RuntimeErrorClass::SourceConflict,
                                "任务引用了目标或计划，但当前运行时无法验证这些引用。",
                                "run.start.pin",
                                false,
                            )
                        })?
                        .validate(&run_id_text, &start.pinned_identity)
                        .map_err(pin_failure)?;
                }
            }
            Err(error) => return Err(aggregate_failure("run.start.recover", error)),
        }

        let created_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|error| internal_failure("run.start.timestamp", error.to_string()))?;
        let message_id = command_message_id.to_string();
        RunAggregate::create(
            journal,
            &run_id_text,
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

    pub fn cancel(
        &mut self,
        run_id: Uuid,
        command_message_id: Uuid,
        cancel: RunCancel,
    ) -> Result<RunSnapshot, RunCommandFailure> {
        let journal = self.journal.as_mut().ok_or_else(|| {
            failure(
                "RUNTIME_STORAGE_REQUIRED",
                RuntimeErrorClass::Storage,
                "当前运行时没有绑定项目存储，无法取消任务。",
                "run.cancel.storage",
                false,
            )
        })?;
        let mut run = match RunAggregate::recover(journal, &run_id.to_string()) {
            Ok(run) => run,
            Err(RunAggregateError::NotFound(_)) => {
                return Err(failure(
                    "RUN_NOT_FOUND",
                    RuntimeErrorClass::Validation,
                    "没有找到这个任务。",
                    "run.cancel.recover",
                    false,
                ));
            }
            Err(error) => return Err(aggregate_failure("run.cancel.recover", error)),
        };
        let cancelled_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|error| internal_failure("run.cancel.timestamp", error.to_string()))?;
        let message_id = command_message_id.to_string();
        run.cancel(
            journal,
            EventMetadata {
                message_id: &message_id,
                idempotency_key: &cancel.cancel_idempotency_key,
                created_at: &cancelled_at,
                reason: Some(&cancel.reason),
            },
        )
        .map_err(|error| aggregate_failure("run.cancel.persist", error))?;
        RunAggregate::recover(journal, &run_id.to_string())
            .map(|run| snapshot(&run))
            .map_err(|error| aggregate_failure("run.cancel.snapshot", error))
    }

    pub fn prepare(
        &mut self,
        run_id: Uuid,
        command_message_id: Uuid,
        prepare: RunPrepare,
        providers: &ProviderRegistry,
    ) -> Result<RunSnapshot, RunCommandFailure> {
        let journal = self.journal.as_mut().ok_or_else(|| {
            failure(
                "RUNTIME_STORAGE_REQUIRED",
                RuntimeErrorClass::Storage,
                "当前运行时没有绑定项目存储，无法准备任务。",
                "run.prepare.storage",
                false,
            )
        })?;
        let mut run = match RunAggregate::recover(journal, &run_id.to_string()) {
            Ok(run) => run,
            Err(RunAggregateError::NotFound(_)) => {
                return Err(failure(
                    "RUN_NOT_FOUND",
                    RuntimeErrorClass::Validation,
                    "没有找到这个任务。",
                    "run.prepare.recover",
                    false,
                ));
            }
            Err(error) => return Err(aggregate_failure("run.prepare.recover", error)),
        };
        if run.state().is_terminal() {
            return Ok(snapshot(&run));
        }
        let timestamp = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|error| internal_failure("run.prepare.timestamp", error.to_string()))?;
        let message_id = command_message_id.to_string();
        let metadata = EventMetadata {
            message_id: &message_id,
            idempotency_key: &prepare.prepare_idempotency_key,
            created_at: &timestamp,
            reason: None,
        };
        match providers.resolve(&run.pinned_identity().provider) {
            Ok(_) => run
                .prepare(journal, metadata)
                .map_err(|error| aggregate_failure("run.prepare.persist", error))?,
            Err(
                error @ (ProviderGatewayError::CredentialRequired
                | ProviderGatewayError::ProfileMismatch),
            ) => {
                let terminal_error = provider_precondition_error(&error);
                run.fail_with_error(journal, metadata, terminal_error)
                    .map_err(|error| aggregate_failure("run.prepare.fail", error))?;
            }
            Err(error) => {
                return Err(internal_failure("run.prepare.provider", error.to_string()));
            }
        }
        RunAggregate::recover(journal, &run_id.to_string())
            .map(|run| snapshot(&run))
            .map_err(|error| aggregate_failure("run.prepare.snapshot", error))
    }
}

fn pin_failure(error: RunPinValidationError) -> RunCommandFailure {
    let (code, class, message) = match error {
        RunPinValidationError::PlanWithoutGoal => (
            "RUN_PLAN_WITHOUT_GOAL",
            RuntimeErrorClass::SourceConflict,
            "计划引用必须同时固定其所属目标。",
        ),
        RunPinValidationError::GoalReferenceInvalid => (
            "RUN_GOAL_PIN_INVALID",
            RuntimeErrorClass::Validation,
            "目标引用格式无效。",
        ),
        RunPinValidationError::GoalNotFound => (
            "RUN_GOAL_PIN_NOT_FOUND",
            RuntimeErrorClass::SourceConflict,
            "没有找到任务固定的目标。",
        ),
        RunPinValidationError::GoalRevisionNotFound => (
            "RUN_GOAL_PIN_REVISION_NOT_FOUND",
            RuntimeErrorClass::StaleVersion,
            "没有找到任务固定的目标修订。",
        ),
        RunPinValidationError::GoalHashMismatch => (
            "RUN_GOAL_PIN_HASH_MISMATCH",
            RuntimeErrorClass::SourceConflict,
            "目标修订哈希与持久记录不一致。",
        ),
        RunPinValidationError::GoalScopeConflict => (
            "RUN_GOAL_PIN_SCOPE_CONFLICT",
            RuntimeErrorClass::SourceConflict,
            "目标没有覆盖任务需要的项目或资源范围。",
        ),
        RunPinValidationError::GoalTerminal => (
            "RUN_GOAL_PIN_TERMINAL",
            RuntimeErrorClass::SourceConflict,
            "目标修订处于阻塞或终态，不能启动新的创作任务。",
        ),
        RunPinValidationError::PlanReferenceInvalid => (
            "RUN_PLAN_PIN_INVALID",
            RuntimeErrorClass::Validation,
            "计划引用格式无效。",
        ),
        RunPinValidationError::PlanNotFound => (
            "RUN_PLAN_PIN_NOT_FOUND",
            RuntimeErrorClass::SourceConflict,
            "没有找到任务固定的计划。",
        ),
        RunPinValidationError::PlanRevisionNotFound => (
            "RUN_PLAN_PIN_REVISION_NOT_FOUND",
            RuntimeErrorClass::StaleVersion,
            "没有找到任务固定的计划修订。",
        ),
        RunPinValidationError::PlanHashMismatch => (
            "RUN_PLAN_PIN_HASH_MISMATCH",
            RuntimeErrorClass::SourceConflict,
            "计划修订哈希与持久记录不一致。",
        ),
        RunPinValidationError::PlanGoalBindingConflict => (
            "RUN_PLAN_GOAL_BINDING_CONFLICT",
            RuntimeErrorClass::SourceConflict,
            "计划不属于任务固定的目标。",
        ),
        RunPinValidationError::PlanGoalRevisionConflict => (
            "RUN_PLAN_GOAL_REVISION_CONFLICT",
            RuntimeErrorClass::StaleVersion,
            "计划与任务固定的目标修订不一致。",
        ),
        RunPinValidationError::AssignmentReferenceInvalid => (
            "RUN_ASSIGNMENT_PIN_INVALID",
            RuntimeErrorClass::Validation,
            "子智能体分配引用无效。",
        ),
        RunPinValidationError::AssignmentNotFound => (
            "RUN_ASSIGNMENT_PIN_NOT_FOUND",
            RuntimeErrorClass::SourceConflict,
            "没有找到子智能体分配。",
        ),
        RunPinValidationError::AssignmentRevisionNotFound => (
            "RUN_ASSIGNMENT_PIN_REVISION_NOT_FOUND",
            RuntimeErrorClass::StaleVersion,
            "没有找到固定的子智能体分配修订。",
        ),
        RunPinValidationError::AssignmentHashMismatch => (
            "RUN_ASSIGNMENT_PIN_HASH_MISMATCH",
            RuntimeErrorClass::SourceConflict,
            "子智能体分配哈希与持久化修订不一致。",
        ),
        RunPinValidationError::AssignmentChildRunMismatch => (
            "RUN_ASSIGNMENT_CHILD_RUN_MISMATCH",
            RuntimeErrorClass::SourceConflict,
            "分配没有绑定当前子运行。",
        ),
        RunPinValidationError::AssignmentBindingConflict
        | RunPinValidationError::ParentRunBindingConflict => (
            "RUN_ASSIGNMENT_BINDING_CONFLICT",
            RuntimeErrorClass::SourceConflict,
            "子运行与分配或父运行的固定身份冲突。",
        ),
        RunPinValidationError::AssignmentScopeConflict => (
            "RUN_ASSIGNMENT_SCOPE_CONFLICT",
            RuntimeErrorClass::SourceConflict,
            "子运行资源范围与分配范围不一致。",
        ),
        RunPinValidationError::AssignmentPolicyConflict => (
            "RUN_ASSIGNMENT_POLICY_CONFLICT",
            RuntimeErrorClass::SourceConflict,
            "子运行的智能体配置或来源检查点与分配不一致。",
        ),
        RunPinValidationError::DelegationIdentityInvalid => (
            "RUN_DELEGATION_IDENTITY_INVALID",
            RuntimeErrorClass::Validation,
            "子运行的委派身份不完整。",
        ),
        RunPinValidationError::DelegationDepthUnsupported => (
            "RUN_DELEGATION_DEPTH_UNSUPPORTED",
            RuntimeErrorClass::Validation,
            "第一版不允许子智能体递归分配其他智能体。",
        ),
        RunPinValidationError::ParentRunNotFound => (
            "RUN_ASSIGNMENT_PARENT_RUN_NOT_FOUND",
            RuntimeErrorClass::SourceConflict,
            "没有找到分配绑定的父运行。",
        ),
        RunPinValidationError::GoalIntegrity(_)
        | RunPinValidationError::PlanIntegrity(_)
        | RunPinValidationError::AssignmentIntegrity(_)
        | RunPinValidationError::WorkspaceJournal(_)
        | RunPinValidationError::RuntimeJournal(_) => (
            "RUN_PIN_JOURNAL_INTEGRITY_FAILED",
            RuntimeErrorClass::Storage,
            "目标或计划记录无法通过完整性校验。",
        ),
    };
    failure(code, class, message, "run.start.pin", false)
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
        terminal_error: run.terminal_error().cloned(),
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

fn provider_precondition_error(error: &ProviderGatewayError) -> RuntimeError {
    let (code, class, message) = match error {
        ProviderGatewayError::CredentialRequired => (
            "REAL_GM_PROVIDER_REQUIRED",
            RuntimeErrorClass::ProviderAuth,
            "需要先配置可用的模型服务。",
        ),
        ProviderGatewayError::ProfileMismatch => (
            "PROVIDER_PROFILE_MISMATCH",
            RuntimeErrorClass::Validation,
            "模型服务配置与任务记录不一致。",
        ),
        _ => unreachable!("only Provider precondition errors are persisted"),
    };
    RuntimeError {
        code: code.to_owned(),
        class,
        retryable: false,
        public_message: message.to_owned(),
        stage: "run.prepare.provider".to_owned(),
        attempt: 0,
        diagnostic_id: Uuid::new_v4(),
    }
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
        RunState::WaitingForReconciliation => RunLifecycleState::WaitingForReconciliation,
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
        RunState::WaitingForReconciliation => RunRecoveryClassification::WaitingForReconciliation,
        RunState::Committing => RunRecoveryClassification::CommitUncertain,
        RunState::Blocked | RunState::Cancelled | RunState::Failed | RunState::Completed => {
            RunRecoveryClassification::Terminal
        }
    }
}
