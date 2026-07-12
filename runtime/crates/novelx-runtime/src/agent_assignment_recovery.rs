use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use thiserror::Error;

use novelx_protocol::AssignmentChildProvisionIntent;

use crate::{
    agent_assignment_aggregate::{
        AgentAssignmentAggregate, AgentAssignmentError, AgentAssignmentRepository,
        AgentAssignmentStatus,
    },
    event_journal::{EventJournal, EventJournalError},
    run_aggregate::{RunAggregate, RunAggregateError},
    run_state::RunState,
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AssignmentRecoveryClassification {
    AwaitingDispatch,
    ProvisionChildRun,
    RunningChild(RunState),
    ReadyToConfirmCancellation,
    CancellationPending,
    ReconciliationRequired,
    TerminalConfirmed,
    Quarantined,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveredAssignment {
    pub assignment_id: String,
    pub assignment_revision: u64,
    pub assignment_status: AgentAssignmentStatus,
    pub child_run_id: Option<String>,
    pub child_run_state: Option<RunState>,
    pub classification: AssignmentRecoveryClassification,
    pub provision_intent: Option<AssignmentChildProvisionIntent>,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct QuarantinedAssignmentRecovery {
    pub assignment_id: String,
    pub child_run_id: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssignmentRecoveryReport {
    pub assignments: Vec<RecoveredAssignment>,
    pub quarantined: Vec<QuarantinedAssignmentRecovery>,
}

pub fn recover_agent_assignments(
    database_path: impl AsRef<Path>,
    workspace_id: &str,
    project_id: &str,
) -> Result<AssignmentRecoveryReport, AgentAssignmentRecoveryError> {
    require_text("workspace_id", workspace_id)?;
    require_text("project_id", project_id)?;
    let database_path = database_path.as_ref();
    let workspace_journal = WorkspaceEventJournal::open(database_path)?;
    let assignment_streams =
        workspace_journal.list_streams(workspace_id, Some("agent_assignment"))?;
    let assignments = AgentAssignmentRepository::open(database_path)?;
    let run_journal = EventJournal::open(database_path)?;

    let mut scoped_assignments = BTreeMap::new();
    for stream in assignment_streams {
        let assignment = assignments.load(workspace_id, &stream.stream_id)?;
        if assignment.identity.project_id == project_id {
            scoped_assignments.insert(assignment.identity.assignment_id.clone(), assignment);
        }
    }

    let mut scoped_child_runs = BTreeMap::new();
    let mut quarantined = Vec::new();
    let mut quarantined_assignment_ids = BTreeSet::new();
    for address in run_journal.list_aggregates("run")? {
        let run = RunAggregate::recover(&run_journal, &address.run_id)?;
        let identity = run.pinned_identity();
        if identity.workspace_id != workspace_id || identity.project_id != project_id {
            continue;
        }
        let Some(reference) = identity.assignment.as_ref() else {
            continue;
        };
        if identity.delegation_depth != 1 {
            quarantined_assignment_ids.insert(reference.id.clone());
            quarantined.push(quarantine(
                &reference.id,
                Some(&address.run_id),
                format!("unsupported delegation depth {}", identity.delegation_depth),
            ));
            continue;
        }
        let Some(assignment) = scoped_assignments.get(&reference.id) else {
            quarantined.push(quarantine(
                &reference.id,
                Some(&address.run_id),
                "orphan child run references a missing assignment",
            ));
            continue;
        };
        if let Err(error) = validate_child_pin(database_path, assignment, &run) {
            quarantined_assignment_ids.insert(reference.id.clone());
            quarantined.push(quarantine(
                &reference.id,
                Some(&address.run_id),
                error.to_string(),
            ));
            continue;
        }
        let assignment_id = reference.id.clone();
        if let Some(existing) = scoped_child_runs.insert(assignment_id.clone(), run) {
            quarantined_assignment_ids.insert(assignment_id.clone());
            quarantined.push(quarantine(
                &assignment_id,
                Some(&address.run_id),
                format!(
                    "multiple child runs: {} and {}",
                    existing.run_id(),
                    address.run_id
                ),
            ));
        }
    }

    let mut recovered = Vec::with_capacity(scoped_assignments.len());
    for assignment in scoped_assignments.into_values() {
        let child = scoped_child_runs.remove(&assignment.identity.assignment_id);
        if quarantined_assignment_ids.contains(&assignment.identity.assignment_id) {
            recovered.push(RecoveredAssignment {
                assignment_id: assignment.identity.assignment_id,
                assignment_revision: assignment.revision,
                assignment_status: assignment.status,
                child_run_id: assignment.child_run_id,
                child_run_state: child.as_ref().map(RunAggregate::state),
                classification: AssignmentRecoveryClassification::Quarantined,
                provision_intent: None,
            });
            continue;
        }
        match classify(database_path, assignment.clone(), child.as_ref()) {
            Ok(value) => recovered.push(value),
            Err(error) => {
                quarantined.push(quarantine(
                    &assignment.identity.assignment_id,
                    assignment.child_run_id.as_deref(),
                    error.to_string(),
                ));
                recovered.push(RecoveredAssignment {
                    assignment_id: assignment.identity.assignment_id,
                    assignment_revision: assignment.revision,
                    assignment_status: assignment.status,
                    child_run_id: assignment.child_run_id,
                    child_run_state: child.as_ref().map(RunAggregate::state),
                    classification: AssignmentRecoveryClassification::Quarantined,
                    provision_intent: None,
                });
            }
        }
    }
    debug_assert!(scoped_child_runs.is_empty());
    quarantined.sort();
    Ok(AssignmentRecoveryReport {
        assignments: recovered,
        quarantined,
    })
}

fn quarantine(
    assignment_id: &str,
    child_run_id: Option<&str>,
    reason: impl Into<String>,
) -> QuarantinedAssignmentRecovery {
    QuarantinedAssignmentRecovery {
        assignment_id: assignment_id.to_owned(),
        child_run_id: child_run_id.map(str::to_owned),
        reason: reason.into(),
    }
}

fn classify(
    database_path: &Path,
    assignment: AgentAssignmentAggregate,
    child: Option<&RunAggregate>,
) -> Result<RecoveredAssignment, AgentAssignmentRecoveryError> {
    let child_run_state = child.map(RunAggregate::state);
    let mut provision_intent = None;
    let classification = match assignment.status {
        AgentAssignmentStatus::Allocated => {
            if child.is_some() || assignment.child_run_id.is_some() {
                return Err(inconsistent(
                    &assignment,
                    child,
                    "allocated assignment has a child run",
                ));
            }
            AssignmentRecoveryClassification::AwaitingDispatch
        }
        AgentAssignmentStatus::Running => match child {
            Some(child) => {
                let child = require_bound_child(&assignment, Some(child))?;
                AssignmentRecoveryClassification::RunningChild(child.state())
            }
            None if assignment.child_run_spec.is_some() => {
                let spec = assignment.child_run_spec.as_ref().expect("checked above");
                validate_provision_spec(database_path, &assignment, spec)?;
                let allocation = spec.pinned_identity.assignment.as_ref().ok_or_else(|| {
                    inconsistent(
                        &assignment,
                        None,
                        "child spec allocation reference is absent",
                    )
                })?;
                let allocation_hash = allocation.sha256.as_deref().ok_or_else(|| {
                    inconsistent(&assignment, None, "child spec allocation hash is absent")
                })?;
                provision_intent = Some(AssignmentChildProvisionIntent::derive(
                    &assignment.identity.workspace_id,
                    &assignment.identity.assignment_id,
                    allocation.revision,
                    allocation_hash,
                    spec,
                )?);
                AssignmentRecoveryClassification::ProvisionChildRun
            }
            None => {
                return Err(inconsistent(&assignment, None, "child_spec_missing"));
            }
        },
        AgentAssignmentStatus::CancelRequested => match child {
            None => {
                if assignment.child_run_id.is_some() {
                    return Err(inconsistent(
                        &assignment,
                        child,
                        "cancel-requested assignment references a missing child run",
                    ));
                }
                AssignmentRecoveryClassification::ReadyToConfirmCancellation
            }
            Some(child) => {
                require_bound_child(&assignment, Some(child))?;
                match child.state() {
                    RunState::Cancelled => {
                        AssignmentRecoveryClassification::ReadyToConfirmCancellation
                    }
                    RunState::Created
                    | RunState::Preparing
                    | RunState::Running
                    | RunState::WaitingForApproval
                    | RunState::Committing
                    | RunState::Retrying => AssignmentRecoveryClassification::CancellationPending,
                    RunState::WaitingForReconciliation
                    | RunState::Blocked
                    | RunState::Failed
                    | RunState::Completed => {
                        AssignmentRecoveryClassification::ReconciliationRequired
                    }
                }
            }
        },
        AgentAssignmentStatus::Completed => {
            require_terminal(&assignment, child, RunState::Completed)?;
            AssignmentRecoveryClassification::TerminalConfirmed
        }
        AgentAssignmentStatus::Failed => {
            require_terminal(&assignment, child, RunState::Failed)?;
            AssignmentRecoveryClassification::TerminalConfirmed
        }
        AgentAssignmentStatus::Cancelled => {
            if assignment.child_run_id.is_none() {
                if child.is_some() {
                    return Err(inconsistent(
                        &assignment,
                        child,
                        "cancelled assignment has an unbound child",
                    ));
                }
            } else {
                require_terminal(&assignment, child, RunState::Cancelled)?;
            }
            AssignmentRecoveryClassification::TerminalConfirmed
        }
    };
    Ok(RecoveredAssignment {
        assignment_id: assignment.identity.assignment_id,
        assignment_revision: assignment.revision,
        assignment_status: assignment.status,
        child_run_id: assignment.child_run_id,
        child_run_state,
        classification,
        provision_intent,
    })
}

fn validate_provision_spec(
    database_path: &Path,
    assignment: &AgentAssignmentAggregate,
    spec: &novelx_protocol::ChildRunSpec,
) -> Result<(), AgentAssignmentRecoveryError> {
    let identity = &spec.pinned_identity;
    let reference = identity
        .assignment
        .as_ref()
        .ok_or_else(|| provision_mismatch(assignment, spec, "assignment reference is absent"))?;
    let allocation = AgentAssignmentRepository::open(database_path)?.load_revision(
        &assignment.identity.workspace_id,
        &assignment.identity.assignment_id,
        reference.revision,
    )?;
    if reference.id != assignment.identity.assignment_id
        || reference.revision != 1
        || reference.sha256.as_deref() != Some(allocation.last_event_hash.as_str())
        || allocation.status != AgentAssignmentStatus::Allocated
        || spec.child_run_id != assignment.child_run_id.as_deref().unwrap_or_default()
        || spec.child_run_id == assignment.identity.parent_run_id
        || identity.workspace_id != assignment.identity.workspace_id
        || identity.project_id != assignment.identity.project_id
        || identity.delegation_depth != 1
        || identity.parent_run_id.as_deref() != Some(assignment.identity.parent_run_id.as_str())
        || identity
            .goal
            .as_ref()
            .is_none_or(|value| !binding_matches(value, &assignment.identity.goal))
        || identity
            .plan
            .as_ref()
            .is_none_or(|value| !binding_matches(value, &assignment.identity.plan))
        || identity.scope_resource_ids != assignment.scope.resource_ids
        || identity.resource_scope_sha256 != assignment.scope.scope_sha256
        || identity.agent_profile.id != assignment.identity.child_profile_id
        || identity.source_checkpoint_id != assignment.definition.source_checkpoint_id
    {
        return Err(provision_mismatch(
            assignment,
            spec,
            "child specification differs from the allocation",
        ));
    }
    Ok(())
}

fn provision_mismatch(
    assignment: &AgentAssignmentAggregate,
    spec: &novelx_protocol::ChildRunSpec,
    reason: &'static str,
) -> AgentAssignmentRecoveryError {
    AgentAssignmentRecoveryError::ChildPinMismatch {
        assignment_id: assignment.identity.assignment_id.clone(),
        run_id: spec.child_run_id.clone(),
        reason,
    }
}

fn require_bound_child<'a>(
    assignment: &AgentAssignmentAggregate,
    child: Option<&'a RunAggregate>,
) -> Result<&'a RunAggregate, AgentAssignmentRecoveryError> {
    let child =
        child.ok_or_else(|| inconsistent(assignment, None, "assignment child run is missing"))?;
    if assignment.child_run_id.as_deref() != Some(child.run_id()) {
        return Err(inconsistent(
            assignment,
            Some(child),
            "assignment child run id differs",
        ));
    }
    Ok(child)
}

fn require_terminal(
    assignment: &AgentAssignmentAggregate,
    child: Option<&RunAggregate>,
    expected: RunState,
) -> Result<(), AgentAssignmentRecoveryError> {
    let child = require_bound_child(assignment, child)?;
    if child.state() != expected {
        return Err(inconsistent(
            assignment,
            Some(child),
            "terminal assignment and child run states differ",
        ));
    }
    Ok(())
}

fn validate_child_pin(
    database_path: &Path,
    assignment: &AgentAssignmentAggregate,
    child: &RunAggregate,
) -> Result<(), AgentAssignmentRecoveryError> {
    let identity = child.pinned_identity();
    let reference = identity.assignment.as_ref().ok_or_else(|| {
        AgentAssignmentRecoveryError::ChildPinMismatch {
            assignment_id: assignment.identity.assignment_id.clone(),
            run_id: child.run_id().to_owned(),
            reason: "assignment reference is absent",
        }
    })?;
    let assignment_revision = AgentAssignmentRepository::open(database_path)?.load_revision(
        &assignment.identity.workspace_id,
        &assignment.identity.assignment_id,
        reference.revision,
    )?;
    let reference_hash = reference
        .sha256
        .as_deref()
        .ok_or_else(|| pin_mismatch(assignment, child, "assignment hash is absent"))?;
    if reference.id != assignment.identity.assignment_id
        || assignment_revision.last_event_hash != reference_hash
        || assignment_revision.status != AgentAssignmentStatus::Allocated
        || assignment_revision.revision != 1
        || assignment.child_run_id.as_deref() != Some(child.run_id())
        || assignment.child_run_spec.as_ref().is_none_or(|spec| {
            spec.child_run_id != child.run_id()
                || spec.pinned_identity != *identity
                || novelx_protocol::child_run_pinned_identity_sha256(identity)
                    .ok()
                    .as_deref()
                    != Some(spec.pinned_identity_sha256.as_str())
        })
        || identity.delegation_depth != 1
        || identity.parent_run_id.as_deref() != Some(assignment.identity.parent_run_id.as_str())
        || identity
            .goal
            .as_ref()
            .is_none_or(|value| !binding_matches(value, &assignment.identity.goal))
        || identity
            .plan
            .as_ref()
            .is_none_or(|value| !binding_matches(value, &assignment.identity.plan))
        || identity.scope_resource_ids != assignment.scope.resource_ids
        || identity.resource_scope_sha256 != assignment.scope.scope_sha256
        || identity.agent_profile.id != assignment.identity.child_profile_id
        || identity.source_checkpoint_id != assignment.definition.source_checkpoint_id
    {
        return Err(pin_mismatch(
            assignment,
            child,
            "child pinned identity differs from assignment",
        ));
    }
    let journal = EventJournal::open(database_path)?;
    let parent = RunAggregate::recover(&journal, &assignment.identity.parent_run_id)
        .map_err(|_| pin_mismatch(assignment, child, "parent run is absent or corrupt"))?;
    let parent_identity = parent.pinned_identity();
    if parent_identity.workspace_id != assignment.identity.workspace_id
        || parent_identity.project_id != assignment.identity.project_id
        || parent_identity
            .goal
            .as_ref()
            .is_none_or(|value| !binding_matches(value, &assignment.identity.goal))
        || parent_identity
            .plan
            .as_ref()
            .is_none_or(|value| !binding_matches(value, &assignment.identity.plan))
        || parent_identity.assignment.is_some()
        || parent_identity.parent_run_id.is_some()
        || parent_identity.delegation_depth != 0
        || assignment.scope.resource_ids.iter().any(|resource| {
            parent_identity
                .scope_resource_ids
                .binary_search(resource)
                .is_err()
        })
        || parent_identity.source_checkpoint_id != assignment.definition.source_checkpoint_id
    {
        return Err(pin_mismatch(
            assignment,
            child,
            "parent run pinned identity differs from assignment",
        ));
    }
    Ok(())
}

fn binding_matches(
    reference: &novelx_protocol::RevisionReference,
    binding: &crate::agent_assignment_aggregate::RevisionBinding,
) -> bool {
    reference.id == binding.id
        && reference.revision == binding.revision
        && reference.sha256.as_deref() == Some(binding.sha256.as_str())
}

fn pin_mismatch(
    assignment: &AgentAssignmentAggregate,
    child: &RunAggregate,
    reason: &'static str,
) -> AgentAssignmentRecoveryError {
    AgentAssignmentRecoveryError::ChildPinMismatch {
        assignment_id: assignment.identity.assignment_id.clone(),
        run_id: child.run_id().to_owned(),
        reason,
    }
}

fn inconsistent(
    assignment: &AgentAssignmentAggregate,
    child: Option<&RunAggregate>,
    reason: &'static str,
) -> AgentAssignmentRecoveryError {
    AgentAssignmentRecoveryError::InconsistentLifecycle {
        assignment_id: assignment.identity.assignment_id.clone(),
        child_run_id: child.map(|value| value.run_id().to_owned()),
        reason,
    }
}

fn require_text(field: &'static str, value: &str) -> Result<(), AgentAssignmentRecoveryError> {
    if value.trim().is_empty() {
        Err(AgentAssignmentRecoveryError::EmptyField(field))
    } else {
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum AgentAssignmentRecoveryError {
    #[error("assignment recovery field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("orphan child run `{run_id}` references assignment `{assignment_id}`")]
    OrphanChildRun {
        run_id: String,
        assignment_id: String,
    },
    #[error("child run `{run_id}` uses unsupported delegation depth {actual}")]
    UnsupportedDelegationDepth { run_id: String, actual: u32 },
    #[error(
        "assignment `{assignment_id}` has multiple child runs `{first_run_id}` and `{second_run_id}`"
    )]
    MultipleChildRuns {
        assignment_id: String,
        first_run_id: String,
        second_run_id: String,
    },
    #[error("child run `{run_id}` pin does not match assignment `{assignment_id}`: {reason}")]
    ChildPinMismatch {
        assignment_id: String,
        run_id: String,
        reason: &'static str,
    },
    #[error(
        "assignment `{assignment_id}` lifecycle is inconsistent with child {child_run_id:?}: {reason}"
    )]
    InconsistentLifecycle {
        assignment_id: String,
        child_run_id: Option<String>,
        reason: &'static str,
    },
    #[error(transparent)]
    Assignment(#[from] AgentAssignmentError),
    #[error(transparent)]
    Protocol(#[from] novelx_protocol::AgentAssignmentValidationError),
    #[error(transparent)]
    Run(#[from] RunAggregateError),
    #[error(transparent)]
    RuntimeJournal(#[from] EventJournalError),
    #[error(transparent)]
    WorkspaceJournal(#[from] WorkspaceEventJournalError),
}
