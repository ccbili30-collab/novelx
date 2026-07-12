use std::path::{Path, PathBuf};

use novelx_protocol as protocol;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::goal_aggregate as goal;
use crate::plan_aggregate as plan;
use crate::run_command_service::WorkspaceBinding;
use crate::workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError};

pub struct GoalPlanCommandService<'a> {
    database_path: PathBuf,
    binding: &'a WorkspaceBinding,
}

#[derive(Debug)]
pub struct GoalPlanCommandFailure {
    pub error: Box<protocol::RuntimeError>,
    pub internal_message: String,
}

impl<'a> GoalPlanCommandService<'a> {
    pub fn new(database_path: impl AsRef<Path>, binding: &'a WorkspaceBinding) -> Self {
        Self {
            database_path: database_path.as_ref().to_owned(),
            binding,
        }
    }

    pub fn create_goal(
        &self,
        message_id: Uuid,
        command: protocol::GoalCreate,
    ) -> Result<protocol::GoalSnapshot, GoalPlanCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("goal.create.validate", error))?;
        let mut repository = self.open_goal_repository("goal.create.storage")?;
        repository
            .create(
                goal::GoalIdentity {
                    workspace_id: self.binding.workspace_id.clone(),
                    project_id: self.binding.project_id.clone(),
                    session_id: command.session_id,
                    goal_id: command.goal_id,
                    owner_agent_id: command.owner_agent_id,
                },
                to_goal_definition(command.definition),
                message_id.to_string(),
                command.create_idempotency_key,
                timestamp("goal.create.timestamp")?,
            )
            .map(goal_snapshot)
            .map_err(|error| goal_failure("goal.create.persist", error))
    }

    pub fn get_goal(
        &self,
        command: protocol::GoalGet,
    ) -> Result<protocol::GoalSnapshot, GoalPlanCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("goal.get.validate", error))?;
        let repository = self.open_goal_repository("goal.get.storage")?;
        let aggregate = match command.revision {
            Some(revision) => {
                repository.load_revision(&self.binding.workspace_id, &command.goal_id, revision)
            }
            None => repository.load(&self.binding.workspace_id, &command.goal_id),
        }
        .map_err(|error| goal_failure("goal.get.load", error))?;
        self.require_goal_binding(&aggregate, "goal.get.binding")?;
        Ok(goal_snapshot(aggregate))
    }

    pub fn revise_goal(
        &self,
        message_id: Uuid,
        command: protocol::GoalRevise,
    ) -> Result<protocol::GoalSnapshot, GoalPlanCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("goal.revise.validate", error))?;
        let mut repository = self.open_goal_repository("goal.revise.storage")?;
        let current = repository
            .load(&self.binding.workspace_id, &command.goal_id)
            .map_err(|error| goal_failure("goal.revise.load", error))?;
        self.require_goal_binding(&current, "goal.revise.binding")?;
        repository
            .revise(
                &self.binding.workspace_id,
                &command.goal_id,
                command.expected_revision,
                to_goal_definition(command.definition),
                goal_metadata(
                    message_id,
                    command.revise_idempotency_key,
                    "goal.revise.timestamp",
                )?,
            )
            .map(goal_snapshot)
            .map_err(|error| goal_failure("goal.revise.persist", error))
    }

    pub fn propose_goal_completion(
        &self,
        message_id: Uuid,
        command: protocol::GoalCompletionPropose,
    ) -> Result<protocol::GoalSnapshot, GoalPlanCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("goal.completion.propose.validate", error))?;
        let mut repository = self.open_goal_repository("goal.completion.propose.storage")?;
        let current = repository
            .load(&self.binding.workspace_id, &command.goal_id)
            .map_err(|error| goal_failure("goal.completion.propose.load", error))?;
        self.require_goal_binding(&current, "goal.completion.propose.binding")?;
        repository
            .propose_completion(
                &self.binding.workspace_id,
                &command.goal_id,
                command.expected_revision,
                to_goal_evidence(command.evidence_refs),
                goal_metadata(
                    message_id,
                    command.propose_idempotency_key,
                    "goal.completion.propose.timestamp",
                )?,
            )
            .map(goal_snapshot)
            .map_err(|error| goal_failure("goal.completion.propose.persist", error))
    }

    pub fn complete_goal(
        &self,
        message_id: Uuid,
        command: protocol::GoalComplete,
    ) -> Result<protocol::GoalSnapshot, GoalPlanCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("goal.complete.validate", error))?;
        let mut repository = self.open_goal_repository("goal.complete.storage")?;
        let current = repository
            .load(&self.binding.workspace_id, &command.goal_id)
            .map_err(|error| goal_failure("goal.complete.load", error))?;
        self.require_goal_binding(&current, "goal.complete.binding")?;
        repository
            .complete(
                &self.binding.workspace_id,
                &command.goal_id,
                command.expected_revision,
                &goal::GoalActor {
                    agent_id: current.identity.owner_agent_id.clone(),
                    is_child_agent: false,
                },
                to_goal_evidence(command.evidence_refs),
                goal_metadata(
                    message_id,
                    command.complete_idempotency_key,
                    "goal.complete.timestamp",
                )?,
            )
            .map(goal_snapshot)
            .map_err(|error| goal_failure("goal.complete.persist", error))
    }

    pub fn create_plan(
        &self,
        message_id: Uuid,
        command: protocol::PlanCreate,
    ) -> Result<protocol::PlanSnapshot, GoalPlanCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("plan.create.validate", error))?;
        self.require_usable_goal_revision(
            &command.goal_id,
            command.goal_revision,
            "plan.create.goal",
        )?;
        let mut journal = self.open_workspace_journal("plan.create.storage")?;
        let created_at = timestamp("plan.create.timestamp")?;
        let message_id = message_id.to_string();
        let aggregate = plan::PlanAggregate::create(
            &mut journal,
            &self.binding.workspace_id,
            &command.plan_id,
            &command.goal_id,
            command.goal_revision,
            to_plan_steps(command.steps),
            plan::PlanEventMetadata {
                message_id: &message_id,
                idempotency_key: &command.create_idempotency_key,
                created_at: &created_at,
            },
        )
        .map_err(|error| plan_failure("plan.create.persist", error))?;
        Ok(plan_snapshot(&aggregate, aggregate.current_revision()))
    }

    pub fn get_plan(
        &self,
        command: protocol::PlanGet,
    ) -> Result<protocol::PlanSnapshot, GoalPlanCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("plan.get.validate", error))?;
        let journal = self.open_workspace_journal("plan.get.storage")?;
        let aggregate =
            plan::PlanAggregate::recover(&journal, &self.binding.workspace_id, &command.plan_id)
                .map_err(|error| plan_failure("plan.get.load", error))?;
        let revision = match command.revision {
            Some(revision) => aggregate.revision(revision).ok_or_else(|| {
                failure(
                    "PLAN_REVISION_NOT_FOUND",
                    protocol::RuntimeErrorClass::StaleVersion,
                    false,
                    "没有找到指定的计划版本。",
                    "plan.get.revision",
                    format!("plan revision {revision} was not found"),
                )
            })?,
            None => aggregate.current_revision(),
        };
        self.require_goal_binding_only(
            aggregate.goal_id(),
            revision.goal_revision,
            "plan.get.binding",
        )?;
        Ok(plan_snapshot(&aggregate, revision))
    }

    pub fn revise_plan(
        &self,
        message_id: Uuid,
        command: protocol::PlanRevise,
    ) -> Result<protocol::PlanSnapshot, GoalPlanCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("plan.revise.validate", error))?;
        let mut journal = self.open_workspace_journal("plan.revise.storage")?;
        let mut aggregate =
            plan::PlanAggregate::recover(&journal, &self.binding.workspace_id, &command.plan_id)
                .map_err(|error| plan_failure("plan.revise.load", error))?;
        self.require_usable_goal_revision(
            aggregate.goal_id(),
            command.goal_revision,
            "plan.revise.goal",
        )?;
        let created_at = timestamp("plan.revise.timestamp")?;
        let message_id = message_id.to_string();
        aggregate
            .revise(
                &mut journal,
                command.expected_revision,
                command.goal_revision,
                to_plan_steps(command.steps),
                plan::PlanEventMetadata {
                    message_id: &message_id,
                    idempotency_key: &command.revise_idempotency_key,
                    created_at: &created_at,
                },
            )
            .map_err(|error| plan_failure("plan.revise.persist", error))?;
        Ok(plan_snapshot(&aggregate, aggregate.current_revision()))
    }

    pub fn start_plan_step(
        &self,
        message_id: Uuid,
        command: protocol::PlanStepStart,
    ) -> Result<protocol::PlanSnapshot, GoalPlanCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("plan.step.start.validate", error))?;
        let mut journal = self.open_workspace_journal("plan.step.start.storage")?;
        let mut aggregate =
            plan::PlanAggregate::recover(&journal, &self.binding.workspace_id, &command.plan_id)
                .map_err(|error| plan_failure("plan.step.start.load", error))?;
        self.require_usable_goal_revision(
            aggregate.goal_id(),
            aggregate.current_revision().goal_revision,
            "plan.step.start.goal",
        )?;
        let created_at = timestamp("plan.step.start.timestamp")?;
        let message_id = message_id.to_string();
        aggregate
            .start_step(
                &mut journal,
                command.expected_revision,
                &command.step_id,
                plan::PlanEventMetadata {
                    message_id: &message_id,
                    idempotency_key: &command.start_idempotency_key,
                    created_at: &created_at,
                },
            )
            .map_err(|error| plan_failure("plan.step.start.persist", error))?;
        Ok(plan_snapshot(&aggregate, aggregate.current_revision()))
    }

    pub fn complete_plan_step(
        &self,
        message_id: Uuid,
        command: protocol::PlanStepComplete,
    ) -> Result<protocol::PlanSnapshot, GoalPlanCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("plan.step.complete.validate", error))?;
        let mut journal = self.open_workspace_journal("plan.step.complete.storage")?;
        let mut aggregate =
            plan::PlanAggregate::recover(&journal, &self.binding.workspace_id, &command.plan_id)
                .map_err(|error| plan_failure("plan.step.complete.load", error))?;
        self.require_usable_goal_revision(
            aggregate.goal_id(),
            aggregate.current_revision().goal_revision,
            "plan.step.complete.goal",
        )?;
        let created_at = timestamp("plan.step.complete.timestamp")?;
        let message_id = message_id.to_string();
        aggregate
            .complete_step(
                &mut journal,
                command.expected_revision,
                &command.step_id,
                to_plan_evidence(command.evidence),
                plan::PlanEventMetadata {
                    message_id: &message_id,
                    idempotency_key: &command.complete_idempotency_key,
                    created_at: &created_at,
                },
            )
            .map_err(|error| plan_failure("plan.step.complete.persist", error))?;
        Ok(plan_snapshot(&aggregate, aggregate.current_revision()))
    }

    fn open_goal_repository(
        &self,
        stage: &str,
    ) -> Result<goal::GoalAggregateRepository, GoalPlanCommandFailure> {
        goal::GoalAggregateRepository::open(&self.database_path)
            .map_err(|error| goal_failure(stage, error))
    }

    fn open_workspace_journal(
        &self,
        stage: &str,
    ) -> Result<WorkspaceEventJournal, GoalPlanCommandFailure> {
        WorkspaceEventJournal::open(&self.database_path)
            .map_err(|error| workspace_failure(stage, error))
    }

    fn require_goal_binding(
        &self,
        aggregate: &goal::GoalAggregate,
        stage: &str,
    ) -> Result<(), GoalPlanCommandFailure> {
        if aggregate.identity.workspace_id != self.binding.workspace_id
            || aggregate.identity.project_id != self.binding.project_id
        {
            return Err(failure(
                "GOAL_WORKSPACE_BINDING_CONFLICT",
                protocol::RuntimeErrorClass::SourceConflict,
                false,
                "目标不属于当前项目工作区。",
                stage,
                "goal identity does not match runtime workspace binding".to_owned(),
            ));
        }
        Ok(())
    }

    fn require_goal_binding_only(
        &self,
        goal_id: &str,
        goal_revision: u64,
        stage: &str,
    ) -> Result<(), GoalPlanCommandFailure> {
        let repository = self.open_goal_repository(stage)?;
        let aggregate = repository
            .load_revision(&self.binding.workspace_id, goal_id, goal_revision)
            .map_err(|error| goal_failure(stage, error))?;
        self.require_goal_binding(&aggregate, stage)
    }

    fn require_usable_goal_revision(
        &self,
        goal_id: &str,
        goal_revision: u64,
        stage: &str,
    ) -> Result<(), GoalPlanCommandFailure> {
        let repository = self.open_goal_repository(stage)?;
        let aggregate = repository
            .load_revision(&self.binding.workspace_id, goal_id, goal_revision)
            .map_err(|error| goal_failure(stage, error))?;
        self.require_goal_binding(&aggregate, stage)?;
        if matches!(
            aggregate.status,
            goal::GoalStatus::Blocked | goal::GoalStatus::Completed | goal::GoalStatus::Cancelled
        ) {
            return Err(failure(
                "PLAN_GOAL_REVISION_UNUSABLE",
                protocol::RuntimeErrorClass::SourceConflict,
                false,
                "计划引用的目标版本已阻塞或终止，不能继续执行。",
                stage,
                format!("goal status {:?} is not usable by a plan", aggregate.status),
            ));
        }
        Ok(())
    }
}

fn timestamp(stage: &str) -> Result<String, GoalPlanCommandFailure> {
    OffsetDateTime::now_utc().format(&Rfc3339).map_err(|error| {
        failure(
            "GOAL_PLAN_TIMESTAMP_FAILED",
            protocol::RuntimeErrorClass::RuntimeCrash,
            false,
            "运行时无法生成可靠时间戳。",
            stage,
            error.to_string(),
        )
    })
}

fn goal_metadata(
    message_id: Uuid,
    idempotency_key: String,
    timestamp_stage: &str,
) -> Result<goal::EventMetadata, GoalPlanCommandFailure> {
    Ok(goal::EventMetadata {
        message_id: message_id.to_string(),
        idempotency_key,
        created_at: timestamp(timestamp_stage)?,
    })
}

fn to_goal_definition(value: protocol::GoalDefinition) -> goal::GoalDefinition {
    goal::GoalDefinition {
        objective: value.objective,
        scope: goal::GoalScope {
            resource_ids: value.scope.resource_ids,
            scope_sha256: value.scope.scope_sha256,
        },
        acceptance_criteria: value
            .acceptance_criteria
            .into_iter()
            .map(|criterion| goal::AcceptanceCriterion {
                criterion_id: criterion.criterion_id,
                description: criterion.description,
                required: criterion.required,
                satisfied: criterion.satisfied,
                evidence_refs: to_goal_evidence(criterion.evidence_refs),
            })
            .collect(),
        constraints: value.constraints,
        permission_mode: match value.permission_mode {
            protocol::GoalPermissionMode::Free => goal::GoalPermissionMode::Free,
            protocol::GoalPermissionMode::Assist => goal::GoalPermissionMode::Assist,
        },
    }
}

fn to_goal_evidence(values: Vec<protocol::GoalEvidenceReference>) -> Vec<goal::EvidenceRef> {
    values
        .into_iter()
        .map(|value| goal::EvidenceRef {
            kind: value.kind,
            reference: value.reference,
            description: value.description,
        })
        .collect()
}

fn goal_snapshot(value: goal::GoalAggregate) -> protocol::GoalSnapshot {
    protocol::GoalSnapshot {
        identity: protocol::GoalIdentity {
            workspace_id: value.identity.workspace_id,
            project_id: value.identity.project_id,
            session_id: value.identity.session_id,
            goal_id: value.identity.goal_id,
            owner_agent_id: value.identity.owner_agent_id,
        },
        definition: protocol::GoalDefinition {
            objective: value.definition.objective,
            scope: protocol::GoalScope {
                resource_ids: value.definition.scope.resource_ids,
                scope_sha256: value.definition.scope.scope_sha256,
            },
            acceptance_criteria: value
                .definition
                .acceptance_criteria
                .into_iter()
                .map(|criterion| protocol::GoalAcceptanceCriterion {
                    criterion_id: criterion.criterion_id,
                    description: criterion.description,
                    required: criterion.required,
                    satisfied: criterion.satisfied,
                    evidence_refs: from_goal_evidence(criterion.evidence_refs),
                })
                .collect(),
            constraints: value.definition.constraints,
            permission_mode: match value.definition.permission_mode {
                goal::GoalPermissionMode::Free => protocol::GoalPermissionMode::Free,
                goal::GoalPermissionMode::Assist => protocol::GoalPermissionMode::Assist,
            },
        },
        definition_revision: value.definition_revision,
        revision: value.revision,
        status: match value.status {
            goal::GoalStatus::Active => protocol::GoalStatus::Active,
            goal::GoalStatus::CompletionProposed => protocol::GoalStatus::CompletionProposed,
            goal::GoalStatus::Completed => protocol::GoalStatus::Completed,
            goal::GoalStatus::Blocked => protocol::GoalStatus::Blocked,
            goal::GoalStatus::Cancelled => protocol::GoalStatus::Cancelled,
        },
        evidence_refs: from_goal_evidence(value.evidence_refs),
        blockers: value
            .blockers
            .into_iter()
            .map(|blocker| protocol::GoalBlocker {
                blocker_id: blocker.blocker_id,
                description: blocker.description,
                evidence_refs: from_goal_evidence(blocker.evidence_refs),
            })
            .collect(),
        last_event_hash: value.last_event_hash,
    }
}

fn from_goal_evidence(values: Vec<goal::EvidenceRef>) -> Vec<protocol::GoalEvidenceReference> {
    values
        .into_iter()
        .map(|value| protocol::GoalEvidenceReference {
            kind: value.kind,
            reference: value.reference,
            description: value.description,
        })
        .collect()
}

fn to_plan_steps(values: Vec<protocol::PlanStep>) -> Vec<plan::PlanStep> {
    values
        .into_iter()
        .map(|value| plan::PlanStep {
            step_id: value.step_id,
            purpose: value.purpose,
            dependencies: value.dependencies,
            assigned_agent: value.assigned_agent,
            capabilities: value.capabilities,
            expected_artifact: value.expected_artifact,
            required_evidence: value.required_evidence,
            status: to_plan_status(value.status),
            completion_evidence: to_plan_evidence(value.completion_evidence),
        })
        .collect()
}

fn to_plan_evidence(values: Vec<protocol::PlanEvidence>) -> Vec<plan::PlanEvidence> {
    values
        .into_iter()
        .map(|value| plan::PlanEvidence {
            evidence_type: value.evidence_type,
            reference_id: value.reference_id,
            sha256: value.sha256,
        })
        .collect()
}

fn to_plan_status(value: protocol::PlanStepStatus) -> plan::PlanStepStatus {
    match value {
        protocol::PlanStepStatus::Pending => plan::PlanStepStatus::Pending,
        protocol::PlanStepStatus::InProgress => plan::PlanStepStatus::InProgress,
        protocol::PlanStepStatus::Completed => plan::PlanStepStatus::Completed,
        protocol::PlanStepStatus::Blocked => plan::PlanStepStatus::Blocked,
    }
}

fn plan_snapshot(
    aggregate: &plan::PlanAggregate,
    revision: &plan::PlanRevision,
) -> protocol::PlanSnapshot {
    protocol::PlanSnapshot {
        workspace_id: aggregate.workspace_id().to_owned(),
        plan_id: aggregate.plan_id().to_owned(),
        goal_id: aggregate.goal_id().to_owned(),
        current_revision: protocol::PlanRevision {
            revision: revision.revision,
            goal_revision: revision.goal_revision,
            steps: revision
                .steps
                .iter()
                .cloned()
                .map(|step| protocol::PlanStep {
                    step_id: step.step_id,
                    purpose: step.purpose,
                    dependencies: step.dependencies,
                    assigned_agent: step.assigned_agent,
                    capabilities: step.capabilities,
                    expected_artifact: step.expected_artifact,
                    required_evidence: step.required_evidence,
                    status: match step.status {
                        plan::PlanStepStatus::Pending => protocol::PlanStepStatus::Pending,
                        plan::PlanStepStatus::InProgress => protocol::PlanStepStatus::InProgress,
                        plan::PlanStepStatus::Completed => protocol::PlanStepStatus::Completed,
                        plan::PlanStepStatus::Blocked => protocol::PlanStepStatus::Blocked,
                    },
                    completion_evidence: step
                        .completion_evidence
                        .into_iter()
                        .map(|evidence| protocol::PlanEvidence {
                            evidence_type: evidence.evidence_type,
                            reference_id: evidence.reference_id,
                            sha256: evidence.sha256,
                        })
                        .collect(),
                })
                .collect(),
            previous_revision_sha256: revision.previous_revision_sha256.clone(),
            revision_sha256: revision.revision_sha256.clone(),
            created_at: revision.created_at.clone(),
        },
        last_stream_sequence: revision.revision,
    }
}

fn validation_failure(stage: &str, error: impl std::fmt::Display) -> GoalPlanCommandFailure {
    failure(
        "GOAL_PLAN_COMMAND_INVALID",
        protocol::RuntimeErrorClass::Validation,
        false,
        "目标或计划命令格式无效。",
        stage,
        error.to_string(),
    )
}

fn goal_failure(stage: &str, error: goal::GoalAggregateError) -> GoalPlanCommandFailure {
    let (code, class, retryable, public_message) = match &error {
        goal::GoalAggregateError::AlreadyExists => (
            "GOAL_ALREADY_EXISTS",
            protocol::RuntimeErrorClass::SourceConflict,
            false,
            "目标已经存在。",
        ),
        goal::GoalAggregateError::NotFound => (
            "GOAL_NOT_FOUND",
            protocol::RuntimeErrorClass::Validation,
            false,
            "没有找到目标。",
        ),
        goal::GoalAggregateError::RevisionNotFound(_) => (
            "GOAL_REVISION_NOT_FOUND",
            protocol::RuntimeErrorClass::StaleVersion,
            false,
            "没有找到指定的目标版本。",
        ),
        goal::GoalAggregateError::RevisionConflict { .. } => (
            "GOAL_REVISION_CONFLICT",
            protocol::RuntimeErrorClass::StaleVersion,
            true,
            "目标已被其他操作更新，请刷新后重试。",
        ),
        goal::GoalAggregateError::TerminalGoal => (
            "GOAL_TERMINAL",
            protocol::RuntimeErrorClass::Validation,
            false,
            "目标已经终止，不能继续修改。",
        ),
        goal::GoalAggregateError::CompletionForbidden | goal::GoalAggregateError::OwnerRequired => {
            (
                "GOAL_OPERATION_FORBIDDEN",
                protocol::RuntimeErrorClass::Validation,
                false,
                "当前 Agent 没有执行此目标操作的权限。",
            )
        }
        goal::GoalAggregateError::InvalidTransition => (
            "GOAL_INVALID_TRANSITION",
            protocol::RuntimeErrorClass::Validation,
            false,
            "目标当前状态不允许执行此操作。",
        ),
        goal::GoalAggregateError::RequiredCriteriaUnsatisfied => (
            "GOAL_REQUIRED_CRITERIA_UNSATISFIED",
            protocol::RuntimeErrorClass::Validation,
            false,
            "目标仍有未满足或缺少证据的验收标准。",
        ),
        goal::GoalAggregateError::UnresolvedBlockers => (
            "GOAL_UNRESOLVED_BLOCKERS",
            protocol::RuntimeErrorClass::SourceConflict,
            false,
            "目标仍有未解决的阻塞项。",
        ),
        goal::GoalAggregateError::CompletionEvidenceRequired => (
            "GOAL_COMPLETION_EVIDENCE_REQUIRED",
            protocol::RuntimeErrorClass::Validation,
            false,
            "完成目标必须提供证据。",
        ),
        goal::GoalAggregateError::Journal(WorkspaceEventJournalError::IdempotencyConflict {
            ..
        }) => (
            "GOAL_IDEMPOTENCY_CONFLICT",
            protocol::RuntimeErrorClass::Protocol,
            false,
            "目标命令的幂等键与已有操作冲突。",
        ),
        goal::GoalAggregateError::Journal(WorkspaceEventJournalError::MessageIdConflict {
            ..
        }) => (
            "MESSAGE_ID_CONFLICT",
            protocol::RuntimeErrorClass::Protocol,
            false,
            "消息标识与已有操作冲突。",
        ),
        goal::GoalAggregateError::EmptyField(_)
        | goal::GoalAggregateError::InvalidDefinition
        | goal::GoalAggregateError::SatisfiedCriterionNeedsEvidence => (
            "GOAL_DEFINITION_INVALID",
            protocol::RuntimeErrorClass::Validation,
            false,
            "目标定义无效。",
        ),
        goal::GoalAggregateError::RevisionOutOfRange => (
            "GOAL_REVISION_OUT_OF_RANGE",
            protocol::RuntimeErrorClass::Validation,
            false,
            "目标版本超出支持范围。",
        ),
        _ => (
            "GOAL_STORAGE_INTEGRITY_FAILED",
            protocol::RuntimeErrorClass::Storage,
            false,
            "目标记录无法通过完整性校验。",
        ),
    };
    failure(
        code,
        class,
        retryable,
        public_message,
        stage,
        error.to_string(),
    )
}

fn plan_failure(stage: &str, error: plan::PlanAggregateError) -> GoalPlanCommandFailure {
    let (code, class, retryable, public_message) = match &error {
        plan::PlanAggregateError::NotFound => (
            "PLAN_NOT_FOUND",
            protocol::RuntimeErrorClass::Validation,
            false,
            "没有找到计划。",
        ),
        plan::PlanAggregateError::RevisionConflict { .. } => (
            "PLAN_REVISION_CONFLICT",
            protocol::RuntimeErrorClass::StaleVersion,
            true,
            "计划已被其他操作更新，请刷新后重试。",
        ),
        plan::PlanAggregateError::DependencyIncomplete { .. } => (
            "PLAN_DEPENDENCY_INCOMPLETE",
            protocol::RuntimeErrorClass::SourceConflict,
            false,
            "计划步骤的前置步骤尚未完成。",
        ),
        plan::PlanAggregateError::StepNotFound(_) => (
            "PLAN_STEP_NOT_FOUND",
            protocol::RuntimeErrorClass::Validation,
            false,
            "没有找到计划步骤。",
        ),
        plan::PlanAggregateError::InvalidStepTransition { .. } => (
            "PLAN_STEP_TRANSITION_INVALID",
            protocol::RuntimeErrorClass::Validation,
            false,
            "计划步骤当前状态不允许执行此操作。",
        ),
        plan::PlanAggregateError::EvidenceRequired(_)
        | plan::PlanAggregateError::InvalidEvidence => (
            "PLAN_EVIDENCE_INVALID",
            protocol::RuntimeErrorClass::Validation,
            false,
            "计划步骤的完成证据无效或不完整。",
        ),
        plan::PlanAggregateError::Journal(WorkspaceEventJournalError::IdempotencyConflict {
            ..
        }) => (
            "PLAN_IDEMPOTENCY_CONFLICT",
            protocol::RuntimeErrorClass::Protocol,
            false,
            "计划命令的幂等键与已有操作冲突。",
        ),
        plan::PlanAggregateError::Journal(WorkspaceEventJournalError::MessageIdConflict {
            ..
        }) => (
            "MESSAGE_ID_CONFLICT",
            protocol::RuntimeErrorClass::Protocol,
            false,
            "消息标识与已有操作冲突。",
        ),
        plan::PlanAggregateError::EmptyField(_)
        | plan::PlanAggregateError::EmptyPlan
        | plan::PlanAggregateError::InvalidGoalRevision
        | plan::PlanAggregateError::DuplicateStep(_)
        | plan::PlanAggregateError::InvalidStep(_)
        | plan::PlanAggregateError::DuplicateDependency(_)
        | plan::PlanAggregateError::UnknownDependency(_)
        | plan::PlanAggregateError::InvalidDependencyOrder { .. } => (
            "PLAN_DEFINITION_INVALID",
            protocol::RuntimeErrorClass::Validation,
            false,
            "计划定义无效。",
        ),
        plan::PlanAggregateError::RevisionOutOfRange => (
            "PLAN_REVISION_OUT_OF_RANGE",
            protocol::RuntimeErrorClass::Validation,
            false,
            "计划版本超出支持范围。",
        ),
        _ => (
            "PLAN_STORAGE_INTEGRITY_FAILED",
            protocol::RuntimeErrorClass::Storage,
            false,
            "计划记录无法通过完整性校验。",
        ),
    };
    failure(
        code,
        class,
        retryable,
        public_message,
        stage,
        error.to_string(),
    )
}

fn workspace_failure(stage: &str, error: WorkspaceEventJournalError) -> GoalPlanCommandFailure {
    failure(
        "GOAL_PLAN_STORAGE_FAILED",
        protocol::RuntimeErrorClass::Storage,
        false,
        "目标或计划存储暂时不可用。",
        stage,
        error.to_string(),
    )
}

fn failure(
    code: &str,
    class: protocol::RuntimeErrorClass,
    retryable: bool,
    public_message: &str,
    stage: &str,
    internal_message: String,
) -> GoalPlanCommandFailure {
    GoalPlanCommandFailure {
        error: Box::new(protocol::RuntimeError {
            code: code.to_owned(),
            class,
            retryable,
            public_message: public_message.to_owned(),
            stage: stage.to_owned(),
            attempt: 0,
            diagnostic_id: Uuid::new_v4(),
        }),
        internal_message,
    }
}
