use std::path::{Path, PathBuf};

use novelx_protocol::RunPinnedIdentity;
use thiserror::Error;

use crate::{
    goal_aggregate::{GoalAggregateError, GoalAggregateRepository, GoalStatus},
    plan_aggregate::{PlanAggregate, PlanAggregateError},
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunPinValidationReceipt {
    pub goal_sha256: Option<String>,
    pub plan_sha256: Option<String>,
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
        identity: &RunPinnedIdentity,
    ) -> Result<RunPinValidationReceipt, RunPinValidationError> {
        let Some(goal_reference) = identity.goal.as_ref() else {
            if identity.plan.is_some() {
                return Err(RunPinValidationError::PlanWithoutGoal);
            }
            return Ok(RunPinValidationReceipt {
                goal_sha256: None,
                plan_sha256: None,
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
        Ok(RunPinValidationReceipt {
            goal_sha256: Some(goal.last_event_hash),
            plan_sha256: Some(revision.revision_sha256.clone()),
        })
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
    #[error(transparent)]
    GoalIntegrity(GoalAggregateError),
    #[error(transparent)]
    PlanIntegrity(PlanAggregateError),
    #[error(transparent)]
    WorkspaceJournal(#[from] WorkspaceEventJournalError),
}
