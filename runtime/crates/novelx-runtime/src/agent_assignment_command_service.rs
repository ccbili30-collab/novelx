use std::path::{Path, PathBuf};

use novelx_protocol as protocol;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    agent_assignment_aggregate as assignment,
    agent_loop_journal::{AgentLoopJournalError, AgentLoopJournalRepository},
    event_journal::EventJournal,
    goal_aggregate::{GoalAggregateError, GoalAggregateRepository, GoalStatus},
    plan_aggregate::{PlanAggregate, PlanAggregateError},
    run_aggregate::{RunAggregate, RunAggregateError},
    run_command_service::WorkspaceBinding,
    run_state::RunState,
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
};

pub struct AgentAssignmentCommandService<'a> {
    database_path: PathBuf,
    binding: &'a WorkspaceBinding,
}

#[derive(Debug)]
pub struct AgentAssignmentCommandFailure {
    pub error: Box<protocol::RuntimeError>,
    pub internal_message: String,
}

impl<'a> AgentAssignmentCommandService<'a> {
    pub fn new(database_path: impl AsRef<Path>, binding: &'a WorkspaceBinding) -> Self {
        Self {
            database_path: database_path.as_ref().to_owned(),
            binding,
        }
    }

    pub fn create(
        &self,
        message_id: Uuid,
        command: protocol::AgentAssignmentCreate,
    ) -> Result<protocol::AgentAssignmentSnapshot, AgentAssignmentCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("agent_assignment.create.validate", error))?;
        self.validate_create_bindings(&command)?;
        let goal_hash =
            required_hash(&command.goal, "agent_assignment.create.goal_hash")?.to_owned();
        let plan_hash =
            required_hash(&command.plan, "agent_assignment.create.plan_hash")?.to_owned();
        let mut repository = self.open_repository("agent_assignment.create.storage")?;
        repository
            .allocate(
                assignment::AgentAssignmentIdentity {
                    assignment_id: command.assignment_id,
                    workspace_id: self.binding.workspace_id.clone(),
                    project_id: self.binding.project_id.clone(),
                    goal: assignment::RevisionBinding {
                        id: command.goal.id,
                        revision: command.goal.revision,
                        sha256: goal_hash,
                    },
                    plan: assignment::RevisionBinding {
                        id: command.plan.id,
                        revision: command.plan.revision,
                        sha256: plan_hash,
                    },
                    plan_step_id: command.plan_step_id,
                    parent_run_id: command.parent_run_id,
                    parent_invocation_id: command.parent_invocation_id,
                    child_profile_id: command.child_profile_id,
                },
                assignment::AssignmentScope {
                    resource_ids: command.scope.resource_ids,
                    scope_sha256: command.scope.scope_sha256,
                },
                assignment::AssignmentDefinition {
                    bounded_objective: command.definition.bounded_objective,
                    source_checkpoint_id: command.definition.source_checkpoint_id,
                    expected_artifact: command.definition.expected_artifact,
                    capabilities: command.definition.capabilities,
                },
                to_permission(command.permission),
                metadata(
                    message_id,
                    command.create_idempotency_key,
                    "agent_assignment.create.timestamp",
                )?,
            )
            .map(snapshot)
            .map_err(|error| assignment_failure("agent_assignment.create.persist", error))
    }

    pub fn get(
        &self,
        command: protocol::AgentAssignmentGet,
    ) -> Result<protocol::AgentAssignmentSnapshot, AgentAssignmentCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("agent_assignment.get.validate", error))?;
        let repository = self.open_repository("agent_assignment.get.storage")?;
        let value = repository
            .load(&self.binding.workspace_id, &command.assignment_id)
            .map_err(|error| assignment_failure("agent_assignment.get.load", error))?;
        self.require_assignment_binding(&value, "agent_assignment.get.binding")?;
        Ok(snapshot(value))
    }

    pub fn start(
        &self,
        message_id: Uuid,
        command: protocol::AgentAssignmentStart,
    ) -> Result<protocol::AgentAssignmentSnapshot, AgentAssignmentCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("agent_assignment.start.validate", error))?;
        let allocation = self
            .open_repository("agent_assignment.start.storage")?
            .load_revision(
                &self.binding.workspace_id,
                &command.assignment_id,
                command.expected_revision,
            )
            .map_err(|error| assignment_failure("agent_assignment.start.load", error))?;
        self.require_assignment_binding(&allocation, "agent_assignment.start.binding")?;
        self.validate_child_run_spec(&allocation, &command.child_run_spec)?;
        self.mutate(
            &command.assignment_id,
            "agent_assignment.start",
            |repository| {
                repository
                    .start(
                        &self.binding.workspace_id,
                        &command.assignment_id,
                        command.expected_revision,
                        command.child_run_spec,
                        metadata(
                            message_id,
                            command.start_idempotency_key,
                            "agent_assignment.start.timestamp",
                        )?,
                    )
                    .map_err(|error| assignment_failure("agent_assignment.start.persist", error))
            },
        )
    }

    fn validate_child_run_spec(
        &self,
        allocation: &assignment::AgentAssignmentAggregate,
        spec: &protocol::ChildRunSpec,
    ) -> Result<(), AgentAssignmentCommandFailure> {
        let identity = &spec.pinned_identity;
        let allocation_reference_matches = identity.assignment.as_ref().is_some_and(|reference| {
            reference.id == allocation.identity.assignment_id
                && reference.revision == allocation.revision
                && reference.sha256.as_deref() == Some(allocation.last_event_hash.as_str())
        });
        if allocation.status != assignment::AgentAssignmentStatus::Allocated
            || allocation.revision != 1
            || spec.child_run_id == allocation.identity.parent_run_id
            || !allocation_reference_matches
            || identity.workspace_id != allocation.identity.workspace_id
            || identity.project_id != allocation.identity.project_id
            || identity.goal.as_ref()
                != Some(&protocol::RevisionReference {
                    id: allocation.identity.goal.id.clone(),
                    revision: allocation.identity.goal.revision,
                    sha256: Some(allocation.identity.goal.sha256.clone()),
                })
            || identity.plan.as_ref()
                != Some(&protocol::RevisionReference {
                    id: allocation.identity.plan.id.clone(),
                    revision: allocation.identity.plan.revision,
                    sha256: Some(allocation.identity.plan.sha256.clone()),
                })
            || identity.parent_run_id.as_deref() != Some(allocation.identity.parent_run_id.as_str())
            || identity.delegation_depth != 1
            || identity.scope_resource_ids != allocation.scope.resource_ids
            || identity.resource_scope_sha256 != allocation.scope.scope_sha256
            || identity.agent_profile.id != allocation.identity.child_profile_id
            || identity.source_checkpoint_id != allocation.definition.source_checkpoint_id
        {
            return Err(binding_failure(
                "ASSIGNMENT_CHILD_RUN_SPEC_MISMATCH",
                "agent_assignment.start.child_run_spec",
                "child run specification does not exactly bind the allocation revision",
            ));
        }
        Ok(())
    }

    pub fn request_cancel(
        &self,
        message_id: Uuid,
        command: protocol::AgentAssignmentRequestCancel,
    ) -> Result<protocol::AgentAssignmentSnapshot, AgentAssignmentCommandFailure> {
        command.validate().map_err(|error| {
            validation_failure("agent_assignment.request_cancel.validate", error)
        })?;
        self.mutate(
            &command.assignment_id,
            "agent_assignment.request_cancel",
            |repository| {
                repository
                    .request_cancel(
                        &self.binding.workspace_id,
                        &command.assignment_id,
                        command.expected_revision,
                        metadata(
                            message_id,
                            command.cancel_idempotency_key,
                            "agent_assignment.request_cancel.timestamp",
                        )?,
                    )
                    .map_err(|error| {
                        assignment_failure("agent_assignment.request_cancel.persist", error)
                    })
            },
        )
    }

    pub fn confirm_cancelled(
        &self,
        message_id: Uuid,
        command: protocol::AgentAssignmentConfirmCancelled,
    ) -> Result<protocol::AgentAssignmentSnapshot, AgentAssignmentCommandFailure> {
        command.validate().map_err(|error| {
            validation_failure("agent_assignment.confirm_cancelled.validate", error)
        })?;
        self.require_child_run_state(
            &command.assignment_id,
            RunState::Cancelled,
            "agent_assignment.confirm_cancelled.child_run",
        )?;
        self.mutate(
            &command.assignment_id,
            "agent_assignment.confirm_cancelled",
            |repository| {
                repository
                    .confirm_cancelled(
                        &self.binding.workspace_id,
                        &command.assignment_id,
                        command.expected_revision,
                        metadata(
                            message_id,
                            command.confirm_idempotency_key,
                            "agent_assignment.confirm_cancelled.timestamp",
                        )?,
                    )
                    .map_err(|error| {
                        assignment_failure("agent_assignment.confirm_cancelled.persist", error)
                    })
            },
        )
    }

    pub fn complete(
        &self,
        message_id: Uuid,
        command: protocol::AgentAssignmentComplete,
    ) -> Result<protocol::AgentAssignmentSnapshot, AgentAssignmentCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("agent_assignment.complete.validate", error))?;
        self.require_child_run_state(
            &command.assignment_id,
            RunState::Completed,
            "agent_assignment.complete.child_run",
        )?;
        self.mutate(
            &command.assignment_id,
            "agent_assignment.complete",
            |repository| {
                repository
                    .complete(
                        &self.binding.workspace_id,
                        &command.assignment_id,
                        command.expected_revision,
                        command
                            .evidence
                            .into_iter()
                            .map(|value| assignment::CompletionEvidence {
                                kind: value.kind,
                                reference: value.reference,
                                sha256: value.sha256,
                            })
                            .collect(),
                        metadata(
                            message_id,
                            command.complete_idempotency_key,
                            "agent_assignment.complete.timestamp",
                        )?,
                    )
                    .map_err(|error| assignment_failure("agent_assignment.complete.persist", error))
            },
        )
    }

    pub fn fail(
        &self,
        message_id: Uuid,
        command: protocol::AgentAssignmentFail,
    ) -> Result<protocol::AgentAssignmentSnapshot, AgentAssignmentCommandFailure> {
        command
            .validate()
            .map_err(|error| validation_failure("agent_assignment.fail.validate", error))?;
        self.require_child_run_state(
            &command.assignment_id,
            RunState::Failed,
            "agent_assignment.fail.child_run",
        )?;
        self.mutate(
            &command.assignment_id,
            "agent_assignment.fail",
            |repository| {
                repository
                    .fail(
                        &self.binding.workspace_id,
                        &command.assignment_id,
                        command.expected_revision,
                        command.failure_code,
                        metadata(
                            message_id,
                            command.fail_idempotency_key,
                            "agent_assignment.fail.timestamp",
                        )?,
                    )
                    .map_err(|error| assignment_failure("agent_assignment.fail.persist", error))
            },
        )
    }

    fn mutate(
        &self,
        assignment_id: &str,
        stage: &str,
        mutation: impl FnOnce(
            &mut assignment::AgentAssignmentRepository,
        ) -> Result<
            assignment::AgentAssignmentAggregate,
            AgentAssignmentCommandFailure,
        >,
    ) -> Result<protocol::AgentAssignmentSnapshot, AgentAssignmentCommandFailure> {
        let mut repository = self.open_repository(&format!("{stage}.storage"))?;
        let current = repository
            .load(&self.binding.workspace_id, assignment_id)
            .map_err(|error| assignment_failure(&format!("{stage}.load"), error))?;
        self.require_assignment_binding(&current, &format!("{stage}.binding"))?;
        mutation(&mut repository).map(snapshot)
    }

    fn validate_create_bindings(
        &self,
        command: &protocol::AgentAssignmentCreate,
    ) -> Result<(), AgentAssignmentCommandFailure> {
        let goals = GoalAggregateRepository::open(&self.database_path)
            .map_err(|error| goal_failure("agent_assignment.create.goal", error))?;
        let goal = goals
            .load_revision(
                &self.binding.workspace_id,
                &command.goal.id,
                command.goal.revision,
            )
            .map_err(|error| goal_failure("agent_assignment.create.goal", error))?;
        if goal.identity.workspace_id != self.binding.workspace_id
            || goal.identity.project_id != self.binding.project_id
        {
            return Err(binding_failure(
                "ASSIGNMENT_GOAL_BINDING_CONFLICT",
                "agent_assignment.create.goal",
                "goal does not belong to the bound workspace and project",
            ));
        }
        if required_hash(&command.goal, "agent_assignment.create.goal_hash")?
            != goal.last_event_hash
        {
            return Err(binding_failure(
                "ASSIGNMENT_GOAL_HASH_MISMATCH",
                "agent_assignment.create.goal",
                "goal revision hash does not match",
            ));
        }
        if !matches!(
            goal.status,
            GoalStatus::Active | GoalStatus::CompletionProposed
        ) {
            return Err(binding_failure(
                "ASSIGNMENT_GOAL_UNUSABLE",
                "agent_assignment.create.goal",
                "goal revision is blocked or terminal",
            ));
        }
        if command.scope.resource_ids.iter().any(|resource| {
            goal.definition
                .scope
                .resource_ids
                .binary_search(resource)
                .is_err()
        }) {
            return Err(binding_failure(
                "ASSIGNMENT_SCOPE_OUTSIDE_GOAL",
                "agent_assignment.create.scope",
                "assignment scope exceeds the pinned goal scope",
            ));
        }

        let journal = WorkspaceEventJournal::open(&self.database_path)
            .map_err(|error| workspace_failure("agent_assignment.create.plan", error))?;
        let plan = PlanAggregate::recover(&journal, &self.binding.workspace_id, &command.plan.id)
            .map_err(|error| plan_failure("agent_assignment.create.plan", error))?;
        let revision = plan.revision(command.plan.revision).ok_or_else(|| {
            binding_failure(
                "ASSIGNMENT_PLAN_REVISION_NOT_FOUND",
                "agent_assignment.create.plan",
                "plan revision was not found",
            )
        })?;
        if required_hash(&command.plan, "agent_assignment.create.plan_hash")?
            != revision.revision_sha256
        {
            return Err(binding_failure(
                "ASSIGNMENT_PLAN_HASH_MISMATCH",
                "agent_assignment.create.plan",
                "plan revision hash does not match",
            ));
        }
        if plan.goal_id() != command.goal.id || revision.goal_revision != command.goal.revision {
            return Err(binding_failure(
                "ASSIGNMENT_PLAN_GOAL_BINDING_CONFLICT",
                "agent_assignment.create.plan",
                "plan revision does not bind the pinned goal revision",
            ));
        }
        let step = revision
            .steps
            .iter()
            .find(|step| step.step_id == command.plan_step_id)
            .ok_or_else(|| {
                binding_failure(
                    "ASSIGNMENT_PLAN_STEP_NOT_FOUND",
                    "agent_assignment.create.plan_step",
                    "plan step was not found",
                )
            })?;
        if matches!(
            step.status,
            crate::plan_aggregate::PlanStepStatus::Completed
                | crate::plan_aggregate::PlanStepStatus::Blocked
        ) {
            return Err(binding_failure(
                "ASSIGNMENT_PLAN_STEP_UNUSABLE",
                "agent_assignment.create.plan_step",
                "completed or blocked plan steps cannot be delegated",
            ));
        }
        if step.assigned_agent.as_deref() != Some(command.child_profile_id.as_str()) {
            return Err(binding_failure(
                "ASSIGNMENT_PROFILE_MISMATCH",
                "agent_assignment.create.plan_step",
                "child profile does not match the plan step assigned agent",
            ));
        }
        if step.capabilities != command.definition.capabilities
            || step.expected_artifact != command.definition.expected_artifact
        {
            return Err(binding_failure(
                "ASSIGNMENT_STEP_CONTRACT_MISMATCH",
                "agent_assignment.create.plan_step",
                "assignment capabilities or expected artifact differ from the plan step",
            ));
        }

        let mut runtime_journal = EventJournal::open(&self.database_path)
            .map_err(|error| run_failure("agent_assignment.create.parent_run", error))?;
        let parent = RunAggregate::recover(&runtime_journal, &command.parent_run_id)
            .map_err(|error| parent_run_failure("agent_assignment.create.parent_run", error))?;
        if !matches!(parent.state(), RunState::Running | RunState::Retrying) {
            return Err(binding_failure(
                "ASSIGNMENT_PARENT_RUN_NOT_DELEGATABLE",
                "agent_assignment.create.parent_run",
                "parent run is not in a delegatable state",
            ));
        }
        let identity = parent.pinned_identity();
        if identity.workspace_id != self.binding.workspace_id
            || identity.project_id != self.binding.project_id
            || identity.goal.as_ref() != Some(&command.goal)
            || identity.plan.as_ref() != Some(&command.plan)
        {
            return Err(binding_failure(
                "ASSIGNMENT_PARENT_RUN_PIN_MISMATCH",
                "agent_assignment.create.parent_run",
                "parent run pins do not match assignment workspace, project, goal, and plan",
            ));
        }
        if identity.source_checkpoint_id != command.definition.source_checkpoint_id {
            return Err(binding_failure(
                "ASSIGNMENT_CHECKPOINT_MISMATCH",
                "agent_assignment.create.parent_run",
                "assignment source checkpoint differs from the parent run",
            ));
        }
        if command
            .scope
            .resource_ids
            .iter()
            .any(|resource| identity.scope_resource_ids.binary_search(resource).is_err())
        {
            return Err(binding_failure(
                "ASSIGNMENT_SCOPE_OUTSIDE_PARENT_RUN",
                "agent_assignment.create.scope",
                "assignment scope exceeds the parent run scope",
            ));
        }
        AgentLoopJournalRepository::new(&mut runtime_journal)
            .recover(&command.parent_run_id, &command.parent_invocation_id)
            .map_err(|error| {
                agent_loop_failure("agent_assignment.create.parent_invocation", error)
            })?;
        Ok(())
    }

    fn require_child_run_state(
        &self,
        assignment_id: &str,
        required: RunState,
        stage: &str,
    ) -> Result<(), AgentAssignmentCommandFailure> {
        let repository = self.open_repository(stage)?;
        let value = repository
            .load(&self.binding.workspace_id, assignment_id)
            .map_err(|error| assignment_failure(stage, error))?;
        self.require_assignment_binding(&value, stage)?;
        if required == RunState::Cancelled
            && value.status == assignment::AgentAssignmentStatus::CancelRequested
            && value.child_run_id.is_none()
        {
            return Ok(());
        }
        let child_run_id = value.child_run_id.as_deref().ok_or_else(|| {
            binding_failure(
                "ASSIGNMENT_CHILD_RUN_REQUIRED",
                stage,
                "assignment does not have a bound child run",
            )
        })?;
        let runtime =
            EventJournal::open(&self.database_path).map_err(|error| run_failure(stage, error))?;
        let child = RunAggregate::recover(&runtime, child_run_id)
            .map_err(|error| child_run_failure(stage, error))?;
        let allocation = repository
            .load_revision(&self.binding.workspace_id, assignment_id, 1)
            .map_err(|error| assignment_failure(stage, error))?;
        let spec = value.child_run_spec.as_ref().ok_or_else(|| {
            binding_failure(
                "ASSIGNMENT_CHILD_RUN_SPEC_REQUIRED",
                stage,
                "legacy assignment does not contain a recoverable child run specification",
            )
        })?;
        let child_identity = child.pinned_identity();
        let assignment_pin_matches = child_identity.assignment.as_ref().is_some_and(|reference| {
            reference.id == allocation.identity.assignment_id
                && reference.revision == allocation.revision
                && reference.sha256.as_deref() == Some(allocation.last_event_hash.as_str())
        });
        if allocation.status != assignment::AgentAssignmentStatus::Allocated
            || value.child_run_id.as_deref() != Some(child_run_id)
            || spec.child_run_id != child_run_id
            || spec.pinned_identity != *child_identity
            || protocol::child_run_pinned_identity_sha256(child_identity)
                .ok()
                .as_deref()
                != Some(spec.pinned_identity_sha256.as_str())
            || !assignment_pin_matches
            || child_identity.goal.as_ref()
                != Some(&protocol::RevisionReference {
                    id: allocation.identity.goal.id.clone(),
                    revision: allocation.identity.goal.revision,
                    sha256: Some(allocation.identity.goal.sha256.clone()),
                })
            || child_identity.plan.as_ref()
                != Some(&protocol::RevisionReference {
                    id: allocation.identity.plan.id.clone(),
                    revision: allocation.identity.plan.revision,
                    sha256: Some(allocation.identity.plan.sha256.clone()),
                })
            || child_identity.parent_run_id.as_deref()
                != Some(allocation.identity.parent_run_id.as_str())
            || child_identity.delegation_depth != 1
            || child_identity.scope_resource_ids != allocation.scope.resource_ids
            || child_identity.resource_scope_sha256 != allocation.scope.scope_sha256
            || child_identity.agent_profile.id != allocation.identity.child_profile_id
            || child_identity.source_checkpoint_id != allocation.definition.source_checkpoint_id
        {
            return Err(binding_failure(
                "ASSIGNMENT_CHILD_RUN_PIN_MISMATCH",
                stage,
                "child run pinned identity does not match the started assignment revision",
            ));
        }
        if child.state() != required {
            return Err(binding_failure(
                "ASSIGNMENT_CHILD_RUN_STATE_MISMATCH",
                stage,
                &format!(
                    "child run state {:?} does not match required state {required:?}",
                    child.state()
                ),
            ));
        }
        Ok(())
    }

    fn open_repository(
        &self,
        stage: &str,
    ) -> Result<assignment::AgentAssignmentRepository, AgentAssignmentCommandFailure> {
        assignment::AgentAssignmentRepository::open(&self.database_path)
            .map_err(|error| assignment_failure(stage, error))
    }

    fn require_assignment_binding(
        &self,
        value: &assignment::AgentAssignmentAggregate,
        stage: &str,
    ) -> Result<(), AgentAssignmentCommandFailure> {
        if value.identity.workspace_id != self.binding.workspace_id
            || value.identity.project_id != self.binding.project_id
        {
            return Err(binding_failure(
                "ASSIGNMENT_WORKSPACE_BINDING_CONFLICT",
                stage,
                "assignment does not belong to the bound workspace and project",
            ));
        }
        Ok(())
    }
}

fn required_hash<'a>(
    reference: &'a protocol::RevisionReference,
    stage: &str,
) -> Result<&'a str, AgentAssignmentCommandFailure> {
    reference.sha256.as_deref().ok_or_else(|| {
        validation_failure(
            stage,
            protocol::AgentAssignmentValidationError::EmptyField { field: "sha256" },
        )
    })
}

fn metadata(
    message_id: Uuid,
    idempotency_key: String,
    stage: &str,
) -> Result<assignment::AssignmentEventMetadata, AgentAssignmentCommandFailure> {
    Ok(assignment::AssignmentEventMetadata {
        message_id: message_id.to_string(),
        idempotency_key,
        created_at: timestamp(stage)?,
    })
}

fn timestamp(stage: &str) -> Result<String, AgentAssignmentCommandFailure> {
    OffsetDateTime::now_utc().format(&Rfc3339).map_err(|error| {
        failure(
            "ASSIGNMENT_TIMESTAMP_FAILED",
            protocol::RuntimeErrorClass::RuntimeCrash,
            false,
            "Unable to create a reliable assignment timestamp.",
            stage,
            error.to_string(),
        )
    })
}

fn to_permission(value: protocol::ChildAgentPermission) -> assignment::ChildAgentPermission {
    match value {
        protocol::ChildAgentPermission::ReadOnly => assignment::ChildAgentPermission::ReadOnly,
        protocol::ChildAgentPermission::ProposeChangeSet => {
            assignment::ChildAgentPermission::ProposeChangeSet
        }
    }
}

fn snapshot(value: assignment::AgentAssignmentAggregate) -> protocol::AgentAssignmentSnapshot {
    protocol::AgentAssignmentSnapshot {
        assignment_id: value.identity.assignment_id,
        workspace_id: value.identity.workspace_id,
        project_id: value.identity.project_id,
        goal: protocol::RevisionReference {
            id: value.identity.goal.id,
            revision: value.identity.goal.revision,
            sha256: Some(value.identity.goal.sha256),
        },
        plan: protocol::RevisionReference {
            id: value.identity.plan.id,
            revision: value.identity.plan.revision,
            sha256: Some(value.identity.plan.sha256),
        },
        plan_step_id: value.identity.plan_step_id,
        parent_run_id: value.identity.parent_run_id,
        parent_invocation_id: value.identity.parent_invocation_id,
        child_profile_id: value.identity.child_profile_id,
        scope: protocol::AssignmentScope {
            resource_ids: value.scope.resource_ids,
            scope_sha256: value.scope.scope_sha256,
        },
        definition: protocol::AssignmentDefinition {
            bounded_objective: value.definition.bounded_objective,
            source_checkpoint_id: value.definition.source_checkpoint_id,
            expected_artifact: value.definition.expected_artifact,
            capabilities: value.definition.capabilities,
        },
        permission: match value.permission {
            assignment::ChildAgentPermission::ReadOnly => protocol::ChildAgentPermission::ReadOnly,
            assignment::ChildAgentPermission::ProposeChangeSet => {
                protocol::ChildAgentPermission::ProposeChangeSet
            }
        },
        status: match value.status {
            assignment::AgentAssignmentStatus::Allocated => {
                protocol::AgentAssignmentStatus::Allocated
            }
            assignment::AgentAssignmentStatus::Running => protocol::AgentAssignmentStatus::Running,
            assignment::AgentAssignmentStatus::CancelRequested => {
                protocol::AgentAssignmentStatus::CancelRequested
            }
            assignment::AgentAssignmentStatus::Cancelled => {
                protocol::AgentAssignmentStatus::Cancelled
            }
            assignment::AgentAssignmentStatus::Completed => {
                protocol::AgentAssignmentStatus::Completed
            }
            assignment::AgentAssignmentStatus::Failed => protocol::AgentAssignmentStatus::Failed,
        },
        child_run_id: value.child_run_id,
        child_run_spec: value.child_run_spec,
        completion_evidence: value
            .completion_evidence
            .into_iter()
            .map(|evidence| protocol::AssignmentCompletionEvidence {
                kind: evidence.kind,
                reference: evidence.reference,
                sha256: evidence.sha256,
            })
            .collect(),
        failure_code: value.failure_code,
        revision: value.revision,
        last_event_hash: value.last_event_hash,
    }
}

fn validation_failure(stage: &str, error: impl std::fmt::Display) -> AgentAssignmentCommandFailure {
    failure(
        "ASSIGNMENT_COMMAND_INVALID",
        protocol::RuntimeErrorClass::Validation,
        false,
        "The child agent assignment command is invalid.",
        stage,
        error.to_string(),
    )
}

fn assignment_failure(
    stage: &str,
    error: assignment::AgentAssignmentError,
) -> AgentAssignmentCommandFailure {
    let (code, class, retryable) = match &error {
        assignment::AgentAssignmentError::NotFound => (
            "ASSIGNMENT_NOT_FOUND",
            protocol::RuntimeErrorClass::Validation,
            false,
        ),
        assignment::AgentAssignmentError::AlreadyExists => (
            "ASSIGNMENT_ALREADY_EXISTS",
            protocol::RuntimeErrorClass::SourceConflict,
            false,
        ),
        assignment::AgentAssignmentError::RevisionConflict { .. } => (
            "ASSIGNMENT_REVISION_CONFLICT",
            protocol::RuntimeErrorClass::StaleVersion,
            true,
        ),
        assignment::AgentAssignmentError::InvalidTransition
        | assignment::AgentAssignmentError::TerminalAssignment => (
            "ASSIGNMENT_TRANSITION_INVALID",
            protocol::RuntimeErrorClass::Validation,
            false,
        ),
        assignment::AgentAssignmentError::IdempotencyIntentConflict
        | assignment::AgentAssignmentError::Journal(
            WorkspaceEventJournalError::IdempotencyConflict { .. },
        ) => (
            "ASSIGNMENT_IDEMPOTENCY_CONFLICT",
            protocol::RuntimeErrorClass::Protocol,
            false,
        ),
        assignment::AgentAssignmentError::Journal(
            WorkspaceEventJournalError::MessageIdConflict { .. },
        ) => (
            "MESSAGE_ID_CONFLICT",
            protocol::RuntimeErrorClass::Protocol,
            false,
        ),
        assignment::AgentAssignmentError::EmptyField(_)
        | assignment::AgentAssignmentError::InvalidRevisionBinding(_)
        | assignment::AgentAssignmentError::InvalidScope
        | assignment::AgentAssignmentError::NonCanonicalScope
        | assignment::AgentAssignmentError::ScopeHashMismatch
        | assignment::AgentAssignmentError::InvalidCapabilities
        | assignment::AgentAssignmentError::NonCanonicalCapabilities
        | assignment::AgentAssignmentError::CompletionEvidenceRequired
        | assignment::AgentAssignmentError::InvalidEvidenceHash => (
            "ASSIGNMENT_DEFINITION_INVALID",
            protocol::RuntimeErrorClass::Validation,
            false,
        ),
        _ => (
            "ASSIGNMENT_STORAGE_INTEGRITY_FAILED",
            protocol::RuntimeErrorClass::Storage,
            false,
        ),
    };
    failure(
        code,
        class,
        retryable,
        "The child agent assignment could not be applied.",
        stage,
        error.to_string(),
    )
}

fn goal_failure(stage: &str, error: GoalAggregateError) -> AgentAssignmentCommandFailure {
    let code = match error {
        GoalAggregateError::NotFound => "ASSIGNMENT_GOAL_NOT_FOUND",
        GoalAggregateError::RevisionNotFound(_) => "ASSIGNMENT_GOAL_REVISION_NOT_FOUND",
        _ => "ASSIGNMENT_GOAL_INTEGRITY_FAILED",
    };
    failure(
        code,
        protocol::RuntimeErrorClass::SourceConflict,
        false,
        "The assignment goal reference could not be verified.",
        stage,
        error.to_string(),
    )
}

fn plan_failure(stage: &str, error: PlanAggregateError) -> AgentAssignmentCommandFailure {
    let code = match error {
        PlanAggregateError::NotFound => "ASSIGNMENT_PLAN_NOT_FOUND",
        _ => "ASSIGNMENT_PLAN_INTEGRITY_FAILED",
    };
    failure(
        code,
        protocol::RuntimeErrorClass::SourceConflict,
        false,
        "The assignment plan reference could not be verified.",
        stage,
        error.to_string(),
    )
}

fn workspace_failure(
    stage: &str,
    error: WorkspaceEventJournalError,
) -> AgentAssignmentCommandFailure {
    failure(
        "ASSIGNMENT_STORAGE_FAILED",
        protocol::RuntimeErrorClass::Storage,
        false,
        "Assignment storage is unavailable.",
        stage,
        error.to_string(),
    )
}

fn run_failure(
    stage: &str,
    error: crate::event_journal::EventJournalError,
) -> AgentAssignmentCommandFailure {
    failure(
        "ASSIGNMENT_PARENT_RUN_STORAGE_FAILED",
        protocol::RuntimeErrorClass::Storage,
        false,
        "The parent run could not be loaded.",
        stage,
        error.to_string(),
    )
}

fn parent_run_failure(stage: &str, error: RunAggregateError) -> AgentAssignmentCommandFailure {
    let code = if matches!(error, RunAggregateError::NotFound(_)) {
        "ASSIGNMENT_PARENT_RUN_NOT_FOUND"
    } else {
        "ASSIGNMENT_PARENT_RUN_INTEGRITY_FAILED"
    };
    failure(
        code,
        protocol::RuntimeErrorClass::SourceConflict,
        false,
        "The parent run could not be verified.",
        stage,
        error.to_string(),
    )
}

fn child_run_failure(stage: &str, error: RunAggregateError) -> AgentAssignmentCommandFailure {
    let code = if matches!(error, RunAggregateError::NotFound(_)) {
        "ASSIGNMENT_CHILD_RUN_NOT_FOUND"
    } else {
        "ASSIGNMENT_CHILD_RUN_INTEGRITY_FAILED"
    };
    failure(
        code,
        protocol::RuntimeErrorClass::SourceConflict,
        false,
        "The child run could not be verified.",
        stage,
        error.to_string(),
    )
}

fn agent_loop_failure(stage: &str, error: AgentLoopJournalError) -> AgentAssignmentCommandFailure {
    failure(
        "ASSIGNMENT_PARENT_INVOCATION_NOT_FOUND",
        protocol::RuntimeErrorClass::SourceConflict,
        false,
        "The parent agent invocation could not be verified.",
        stage,
        error.to_string(),
    )
}

fn binding_failure(code: &str, stage: &str, internal: &str) -> AgentAssignmentCommandFailure {
    failure(
        code,
        protocol::RuntimeErrorClass::SourceConflict,
        false,
        "The child agent assignment conflicts with its pinned sources.",
        stage,
        internal.to_owned(),
    )
}

fn failure(
    code: &str,
    class: protocol::RuntimeErrorClass,
    retryable: bool,
    public_message: &str,
    stage: &str,
    internal_message: String,
) -> AgentAssignmentCommandFailure {
    AgentAssignmentCommandFailure {
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
