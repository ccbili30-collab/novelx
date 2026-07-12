use std::path::{Path, PathBuf};

use novelx_protocol::RunPinnedIdentity;
use thiserror::Error;

use crate::{
    agent_assignment_aggregate::{
        AgentAssignmentError, AgentAssignmentRepository, AgentAssignmentStatus,
    },
    event_journal::EventJournal,
    goal_aggregate::{GoalAggregateError, GoalAggregateRepository, GoalStatus},
    plan_aggregate::{PlanAggregate, PlanAggregateError},
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunPinValidationReceipt {
    pub goal_sha256: Option<String>,
    pub plan_sha256: Option<String>,
    pub assignment_sha256: Option<String>,
}

#[derive(Clone)]
pub struct RunPinValidator {
    database_path: PathBuf,
}

impl RunPinValidator {
    pub fn new(database_path: impl AsRef<Path>) -> Self {
        Self {
            database_path: database_path.as_ref().to_owned(),
        }
    }

    pub fn validate(
        &self,
        run_id: &str,
        identity: &RunPinnedIdentity,
    ) -> Result<RunPinValidationReceipt, RunPinValidationError> {
        let Some(goal_reference) = identity.goal.as_ref() else {
            if identity.plan.is_some() {
                return Err(RunPinValidationError::PlanWithoutGoal);
            }
            return Ok(RunPinValidationReceipt {
                goal_sha256: None,
                plan_sha256: None,
                assignment_sha256: None,
            });
        };
        goal_reference
            .validate()
            .map_err(|_| RunPinValidationError::GoalReferenceInvalid)?;
        let goals = GoalAggregateRepository::open(&self.database_path)
            .map_err(RunPinValidationError::GoalIntegrity)?;
        let goal = goals
            .load_revision(
                &identity.workspace_id,
                &goal_reference.id,
                goal_reference.revision,
            )
            .map_err(map_goal_error)?;
        let goal_sha256 = goal_reference
            .sha256
            .as_deref()
            .ok_or(RunPinValidationError::GoalReferenceInvalid)?;
        if goal.last_event_hash != goal_sha256 {
            return Err(RunPinValidationError::GoalHashMismatch);
        }
        if goal.identity.workspace_id != identity.workspace_id
            || goal.identity.project_id != identity.project_id
        {
            return Err(RunPinValidationError::GoalScopeConflict);
        }
        if !matches!(
            goal.status,
            GoalStatus::Active | GoalStatus::CompletionProposed
        ) {
            return Err(RunPinValidationError::GoalTerminal);
        }
        if identity.scope_resource_ids.iter().any(|resource| {
            goal.definition
                .scope
                .resource_ids
                .binary_search(resource)
                .is_err()
        }) {
            return Err(RunPinValidationError::GoalScopeConflict);
        }

        let Some(plan_reference) = identity.plan.as_ref() else {
            return Ok(RunPinValidationReceipt {
                goal_sha256: Some(goal.last_event_hash),
                plan_sha256: None,
                assignment_sha256: None,
            });
        };
        plan_reference
            .validate()
            .map_err(|_| RunPinValidationError::PlanReferenceInvalid)?;
        let journal = WorkspaceEventJournal::open(&self.database_path)?;
        let plan = PlanAggregate::recover(&journal, &identity.workspace_id, &plan_reference.id)
            .map_err(map_plan_error)?;
        let revision = plan
            .revision(plan_reference.revision)
            .ok_or(RunPinValidationError::PlanRevisionNotFound)?;
        let plan_sha256 = plan_reference
            .sha256
            .as_deref()
            .ok_or(RunPinValidationError::PlanReferenceInvalid)?;
        if revision.revision_sha256 != plan_sha256 {
            return Err(RunPinValidationError::PlanHashMismatch);
        }
        if plan.goal_id() != goal_reference.id {
            return Err(RunPinValidationError::PlanGoalBindingConflict);
        }
        if revision.goal_revision != goal_reference.revision {
            return Err(RunPinValidationError::PlanGoalRevisionConflict);
        }
        let assignment_sha256 =
            self.validate_assignment(run_id, identity, goal_reference, plan_reference)?;
        Ok(RunPinValidationReceipt {
            goal_sha256: Some(goal.last_event_hash),
            plan_sha256: Some(revision.revision_sha256.clone()),
            assignment_sha256,
        })
    }

    fn validate_assignment(
        &self,
        run_id: &str,
        identity: &RunPinnedIdentity,
        goal_reference: &novelx_protocol::RevisionReference,
        plan_reference: &novelx_protocol::RevisionReference,
    ) -> Result<Option<String>, RunPinValidationError> {
        let Some(reference) = identity.assignment.as_ref() else {
            if identity.parent_run_id.is_some() || identity.delegation_depth != 0 {
                return Err(RunPinValidationError::DelegationIdentityInvalid);
            }
            return Ok(None);
        };
        reference
            .validate()
            .map_err(|_| RunPinValidationError::AssignmentReferenceInvalid)?;
        if identity.delegation_depth != 1 {
            return Err(RunPinValidationError::DelegationDepthUnsupported);
        }
        let parent_run_id = identity
            .parent_run_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(RunPinValidationError::DelegationIdentityInvalid)?;
        if parent_run_id == run_id {
            return Err(RunPinValidationError::DelegationIdentityInvalid);
        }
        let assignments = AgentAssignmentRepository::open(&self.database_path)
            .map_err(RunPinValidationError::AssignmentIntegrity)?;
        let assignment = assignments
            .load_revision(&identity.workspace_id, &reference.id, reference.revision)
            .map_err(map_assignment_error)?;
        let reference_sha256 = reference
            .sha256
            .as_deref()
            .ok_or(RunPinValidationError::AssignmentReferenceInvalid)?;
        if assignment.last_event_hash != reference_sha256 {
            return Err(RunPinValidationError::AssignmentHashMismatch);
        }
        if assignment.status != AgentAssignmentStatus::Running
            || assignment.child_run_id.as_deref() != Some(run_id)
        {
            return Err(RunPinValidationError::AssignmentChildRunMismatch);
        }
        if assignment.identity.workspace_id != identity.workspace_id
            || assignment.identity.project_id != identity.project_id
            || assignment.identity.parent_run_id != parent_run_id
            || assignment.identity.goal.id != goal_reference.id
            || assignment.identity.goal.revision != goal_reference.revision
            || assignment.identity.goal.sha256 != goal_reference.sha256.as_deref().unwrap_or("")
            || assignment.identity.plan.id != plan_reference.id
            || assignment.identity.plan.revision != plan_reference.revision
            || assignment.identity.plan.sha256 != plan_reference.sha256.as_deref().unwrap_or("")
        {
            return Err(RunPinValidationError::AssignmentBindingConflict);
        }
        if assignment.scope.resource_ids != identity.scope_resource_ids
            || assignment.scope.scope_sha256 != identity.resource_scope_sha256
        {
            return Err(RunPinValidationError::AssignmentScopeConflict);
        }
        if assignment.identity.child_profile_id != identity.agent_profile.id
            || assignment.definition.source_checkpoint_id != identity.source_checkpoint_id
        {
            return Err(RunPinValidationError::AssignmentPolicyConflict);
        }
        let parent_journal = EventJournal::open(&self.database_path)?;
        let parent = crate::run_aggregate::RunAggregate::recover(&parent_journal, parent_run_id)
            .map_err(|_| RunPinValidationError::ParentRunNotFound)?;
        if !matches!(
            parent.state(),
            crate::run_state::RunState::Running | crate::run_state::RunState::Retrying
        ) || parent.pinned_identity().goal.as_ref() != Some(goal_reference)
            || parent.pinned_identity().plan.as_ref() != Some(plan_reference)
        {
            return Err(RunPinValidationError::ParentRunBindingConflict);
        }
        Ok(Some(assignment.last_event_hash))
    }
}

fn map_assignment_error(error: AgentAssignmentError) -> RunPinValidationError {
    match error {
        AgentAssignmentError::NotFound => RunPinValidationError::AssignmentNotFound,
        AgentAssignmentError::RevisionNotFound(_) => {
            RunPinValidationError::AssignmentRevisionNotFound
        }
        other => RunPinValidationError::AssignmentIntegrity(other),
    }
}

fn map_goal_error(error: GoalAggregateError) -> RunPinValidationError {
    match error {
        GoalAggregateError::NotFound => RunPinValidationError::GoalNotFound,
        GoalAggregateError::RevisionNotFound(_) => RunPinValidationError::GoalRevisionNotFound,
        other => RunPinValidationError::GoalIntegrity(other),
    }
}

fn map_plan_error(error: PlanAggregateError) -> RunPinValidationError {
    match error {
        PlanAggregateError::NotFound => RunPinValidationError::PlanNotFound,
        other => RunPinValidationError::PlanIntegrity(other),
    }
}

#[derive(Debug, Error)]
pub enum RunPinValidationError {
    #[error("Plan pin requires a Goal pin")]
    PlanWithoutGoal,
    #[error("Goal pin reference is invalid")]
    GoalReferenceInvalid,
    #[error("Goal pin was not found")]
    GoalNotFound,
    #[error("Goal pin revision was not found")]
    GoalRevisionNotFound,
    #[error("Goal pin hash does not match the stored revision")]
    GoalHashMismatch,
    #[error("Goal pin does not cover the Run project or resource scope")]
    GoalScopeConflict,
    #[error("Goal pin references a blocked or terminal Goal revision")]
    GoalTerminal,
    #[error("Plan pin reference is invalid")]
    PlanReferenceInvalid,
    #[error("Plan pin was not found")]
    PlanNotFound,
    #[error("Plan pin revision was not found")]
    PlanRevisionNotFound,
    #[error("Plan pin hash does not match the stored revision")]
    PlanHashMismatch,
    #[error("Plan pin belongs to another Goal")]
    PlanGoalBindingConflict,
    #[error("Plan pin targets another Goal revision")]
    PlanGoalRevisionConflict,
    #[error("Assignment pin reference is invalid")]
    AssignmentReferenceInvalid,
    #[error("Assignment pin was not found")]
    AssignmentNotFound,
    #[error("Assignment pin revision was not found")]
    AssignmentRevisionNotFound,
    #[error("Assignment pin hash does not match the stored revision")]
    AssignmentHashMismatch,
    #[error("Assignment pin does not bind this child Run")]
    AssignmentChildRunMismatch,
    #[error("Assignment pin conflicts with Goal, Plan, project, workspace, or parent Run")]
    AssignmentBindingConflict,
    #[error("Assignment pin scope differs from the child Run scope")]
    AssignmentScopeConflict,
    #[error("Assignment pin profile or source checkpoint differs from the child Run")]
    AssignmentPolicyConflict,
    #[error("Delegation identity is invalid")]
    DelegationIdentityInvalid,
    #[error("Recursive child Agent delegation is not supported")]
    DelegationDepthUnsupported,
    #[error("Assignment parent Run was not found")]
    ParentRunNotFound,
    #[error("Assignment parent Run is no longer delegatable or its pins differ")]
    ParentRunBindingConflict,
    #[error(transparent)]
    GoalIntegrity(GoalAggregateError),
    #[error(transparent)]
    PlanIntegrity(PlanAggregateError),
    #[error(transparent)]
    AssignmentIntegrity(AgentAssignmentError),
    #[error(transparent)]
    RuntimeJournal(#[from] crate::event_journal::EventJournalError),
    #[error(transparent)]
    WorkspaceJournal(#[from] WorkspaceEventJournalError),
}
