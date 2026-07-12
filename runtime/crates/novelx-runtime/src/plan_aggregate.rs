use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::workspace_event_journal::{
    NewWorkspaceEvent, WorkspaceEvent, WorkspaceEventJournal, WorkspaceEventJournalError,
};

const STREAM_TYPE: &str = "plan";
const EVENT_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Pending,
    InProgress,
    Completed,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanStep {
    pub step_id: String,
    pub purpose: String,
    pub dependencies: Vec<String>,
    pub assigned_agent: Option<String>,
    pub capabilities: Vec<String>,
    pub expected_artifact: String,
    pub required_evidence: Vec<String>,
    pub status: PlanStepStatus,
    #[serde(default)]
    pub completion_evidence: Vec<PlanEvidence>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanEvidence {
    pub evidence_type: String,
    pub reference_id: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRevision {
    pub revision: u64,
    pub goal_revision: u64,
    pub steps: Vec<PlanStep>,
    pub previous_revision_sha256: Option<String>,
    pub revision_sha256: String,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug)]
pub struct PlanEventMetadata<'a> {
    pub message_id: &'a str,
    pub idempotency_key: &'a str,
    pub created_at: &'a str,
}

#[derive(Clone, Copy)]
struct PlanStreamAddress<'a> {
    workspace_id: &'a str,
    plan_id: &'a str,
    goal_id: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanAggregate {
    workspace_id: String,
    plan_id: String,
    goal_id: String,
    revisions: Vec<PlanRevision>,
    last_stream_sequence: u64,
}

impl PlanAggregate {
    pub fn create(
        journal: &mut WorkspaceEventJournal,
        workspace_id: &str,
        plan_id: &str,
        goal_id: &str,
        goal_revision: u64,
        steps: Vec<PlanStep>,
        metadata: PlanEventMetadata<'_>,
    ) -> Result<Self, PlanAggregateError> {
        require("workspace_id", workspace_id)?;
        require("plan_id", plan_id)?;
        require("goal_id", goal_id)?;
        if goal_revision == 0 {
            return Err(PlanAggregateError::InvalidGoalRevision);
        }
        validate_steps(&steps, true)?;
        let revision = build_revision(1, goal_revision, steps, None, metadata.created_at)?;
        append_revision(
            journal,
            PlanStreamAddress {
                workspace_id,
                plan_id,
                goal_id,
            },
            "plan.created",
            &revision,
            0,
            metadata,
        )?;
        Self::recover(journal, workspace_id, plan_id)
    }

    pub fn recover(
        journal: &WorkspaceEventJournal,
        workspace_id: &str,
        plan_id: &str,
    ) -> Result<Self, PlanAggregateError> {
        require("workspace_id", workspace_id)?;
        require("plan_id", plan_id)?;
        let events = journal.read_stream(workspace_id, STREAM_TYPE, plan_id, 0)?;
        replay(workspace_id, plan_id, &events)
    }

    pub fn plan_id(&self) -> &str {
        &self.plan_id
    }
    pub fn goal_id(&self) -> &str {
        &self.goal_id
    }
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }
    pub fn current_revision(&self) -> &PlanRevision {
        self.revisions
            .last()
            .expect("recovered plan has a revision")
    }
    pub fn revision(&self, revision: u64) -> Option<&PlanRevision> {
        self.revisions.iter().find(|item| item.revision == revision)
    }
    pub fn revisions(&self) -> &[PlanRevision] {
        &self.revisions
    }
    pub fn last_stream_sequence(&self) -> u64 {
        self.last_stream_sequence
    }

    pub fn revise(
        &mut self,
        journal: &mut WorkspaceEventJournal,
        expected_revision: u64,
        goal_revision: u64,
        steps: Vec<PlanStep>,
        metadata: PlanEventMetadata<'_>,
    ) -> Result<&PlanRevision, PlanAggregateError> {
        self.require_expected_revision(expected_revision)?;
        if goal_revision == 0 {
            return Err(PlanAggregateError::InvalidGoalRevision);
        }
        validate_steps(&steps, true)?;
        self.append_snapshot(journal, "plan.revised", goal_revision, steps, metadata)
    }

    pub fn start_step(
        &mut self,
        journal: &mut WorkspaceEventJournal,
        expected_revision: u64,
        step_id: &str,
        metadata: PlanEventMetadata<'_>,
    ) -> Result<&PlanRevision, PlanAggregateError> {
        self.require_expected_revision(expected_revision)?;
        let mut steps = self.current_revision().steps.clone();
        let index = step_index(&steps, step_id)?;
        if steps[index].status != PlanStepStatus::Pending
            && steps[index].status != PlanStepStatus::Blocked
        {
            return Err(PlanAggregateError::InvalidStepTransition {
                step_id: step_id.to_owned(),
            });
        }
        for dependency in &steps[index].dependencies {
            let dependency_step = steps
                .iter()
                .find(|step| &step.step_id == dependency)
                .ok_or_else(|| PlanAggregateError::UnknownDependency(dependency.clone()))?;
            if dependency_step.status != PlanStepStatus::Completed {
                return Err(PlanAggregateError::DependencyIncomplete {
                    step_id: step_id.to_owned(),
                    dependency_id: dependency.clone(),
                });
            }
        }
        steps[index].status = PlanStepStatus::InProgress;
        self.append_snapshot(
            journal,
            "plan.step_started",
            self.current_revision().goal_revision,
            steps,
            metadata,
        )
    }

    pub fn complete_step(
        &mut self,
        journal: &mut WorkspaceEventJournal,
        expected_revision: u64,
        step_id: &str,
        evidence: Vec<PlanEvidence>,
        metadata: PlanEventMetadata<'_>,
    ) -> Result<&PlanRevision, PlanAggregateError> {
        self.require_expected_revision(expected_revision)?;
        let mut steps = self.current_revision().steps.clone();
        let index = step_index(&steps, step_id)?;
        if steps[index].status != PlanStepStatus::InProgress {
            return Err(PlanAggregateError::InvalidStepTransition {
                step_id: step_id.to_owned(),
            });
        }
        validate_evidence(&steps[index], &evidence)?;
        for dependency in &steps[index].dependencies {
            if steps
                .iter()
                .find(|step| &step.step_id == dependency)
                .is_none_or(|step| step.status != PlanStepStatus::Completed)
            {
                return Err(PlanAggregateError::DependencyIncomplete {
                    step_id: step_id.to_owned(),
                    dependency_id: dependency.clone(),
                });
            }
        }
        steps[index].status = PlanStepStatus::Completed;
        steps[index].completion_evidence = evidence;
        self.append_snapshot(
            journal,
            "plan.step_completed",
            self.current_revision().goal_revision,
            steps,
            metadata,
        )
    }

    fn append_snapshot(
        &mut self,
        journal: &mut WorkspaceEventJournal,
        event_type: &str,
        goal_revision: u64,
        steps: Vec<PlanStep>,
        metadata: PlanEventMetadata<'_>,
    ) -> Result<&PlanRevision, PlanAggregateError> {
        let current = self.current_revision();
        let revision = build_revision(
            current
                .revision
                .checked_add(1)
                .ok_or(PlanAggregateError::RevisionOutOfRange)?,
            goal_revision,
            steps,
            Some(current.revision_sha256.clone()),
            metadata.created_at,
        )?;
        let stored = append_revision(
            journal,
            PlanStreamAddress {
                workspace_id: &self.workspace_id,
                plan_id: &self.plan_id,
                goal_id: &self.goal_id,
            },
            event_type,
            &revision,
            self.last_stream_sequence,
            metadata,
        )?;
        self.last_stream_sequence = stored.stream_sequence;
        self.revisions.push(revision);
        Ok(self.current_revision())
    }

    fn require_expected_revision(&self, expected: u64) -> Result<(), PlanAggregateError> {
        let actual = self.current_revision().revision;
        if expected != actual {
            Err(PlanAggregateError::RevisionConflict { expected, actual })
        } else {
            Ok(())
        }
    }
}

fn append_revision(
    journal: &mut WorkspaceEventJournal,
    address: PlanStreamAddress<'_>,
    event_type: &str,
    revision: &PlanRevision,
    expected_stream_sequence: u64,
    metadata: PlanEventMetadata<'_>,
) -> Result<WorkspaceEvent, PlanAggregateError> {
    let workspace_sequence = journal.current_workspace_sequence(address.workspace_id)?;
    Ok(journal.append(
        NewWorkspaceEvent {
            workspace_id: address.workspace_id.to_owned(),
            stream_type: STREAM_TYPE.to_owned(),
            stream_id: address.plan_id.to_owned(),
            message_id: metadata.message_id.to_owned(),
            idempotency_key: metadata.idempotency_key.to_owned(),
            event_type: event_type.to_owned(),
            event_version: EVENT_VERSION,
            payload: json!({ "goalId": address.goal_id, "checkpoint": revision }),
            created_at: metadata.created_at.to_owned(),
        },
        workspace_sequence,
        expected_stream_sequence,
    )?)
}

fn replay(
    workspace_id: &str,
    plan_id: &str,
    events: &[WorkspaceEvent],
) -> Result<PlanAggregate, PlanAggregateError> {
    if events.is_empty() {
        return Err(PlanAggregateError::NotFound);
    }
    let mut aggregate: Option<PlanAggregate> = None;
    for (index, event) in events.iter().enumerate() {
        if event.stream_sequence != (index as u64 + 1) {
            return Err(PlanAggregateError::SequenceGap);
        }
        if event.event_version != EVENT_VERSION {
            return Err(PlanAggregateError::UnknownEventVersion {
                event_type: event.event_type.clone(),
                version: event.event_version,
            });
        }
        if !matches!(
            event.event_type.as_str(),
            "plan.created" | "plan.revised" | "plan.step_started" | "plan.step_completed"
        ) {
            return Err(PlanAggregateError::UnknownEvent(event.event_type.clone()));
        }
        let payload: PlanCheckpointPayload = serde_json::from_value(event.payload.clone())
            .map_err(|_| PlanAggregateError::CorruptCheckpoint)?;
        validate_revision_hash(&payload.checkpoint)?;
        validate_steps(&payload.checkpoint.steps, false)?;
        match aggregate.as_mut() {
            None => {
                if event.event_type != "plan.created"
                    || payload.checkpoint.revision != 1
                    || payload.checkpoint.previous_revision_sha256.is_some()
                {
                    return Err(PlanAggregateError::CorruptCheckpoint);
                }
                aggregate = Some(PlanAggregate {
                    workspace_id: workspace_id.to_owned(),
                    plan_id: plan_id.to_owned(),
                    goal_id: payload.goal_id,
                    revisions: vec![payload.checkpoint],
                    last_stream_sequence: event.stream_sequence,
                });
            }
            Some(current) => {
                if event.event_type == "plan.created" || payload.goal_id != current.goal_id {
                    return Err(PlanAggregateError::GoalBindingMismatch);
                }
                let previous = current.current_revision();
                if payload.checkpoint.revision != previous.revision + 1
                    || payload.checkpoint.previous_revision_sha256.as_deref()
                        != Some(previous.revision_sha256.as_str())
                {
                    return Err(PlanAggregateError::CorruptCheckpoint);
                }
                current.revisions.push(payload.checkpoint);
                current.last_stream_sequence = event.stream_sequence;
            }
        }
    }
    aggregate.ok_or(PlanAggregateError::NotFound)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanCheckpointPayload {
    goal_id: String,
    checkpoint: PlanRevision,
}

fn build_revision(
    revision: u64,
    goal_revision: u64,
    steps: Vec<PlanStep>,
    previous_revision_sha256: Option<String>,
    created_at: &str,
) -> Result<PlanRevision, PlanAggregateError> {
    require("created_at", created_at)?;
    let revision_sha256 = revision_hash(
        revision,
        goal_revision,
        &steps,
        previous_revision_sha256.as_deref(),
        created_at,
    )?;
    Ok(PlanRevision {
        revision,
        goal_revision,
        steps,
        previous_revision_sha256,
        revision_sha256,
        created_at: created_at.to_owned(),
    })
}

fn validate_revision_hash(revision: &PlanRevision) -> Result<(), PlanAggregateError> {
    if revision.revision == 0 || revision.goal_revision == 0 {
        return Err(PlanAggregateError::CorruptCheckpoint);
    }
    if revision
        .previous_revision_sha256
        .as_ref()
        .is_some_and(|hash| !is_sha256(hash))
        || !is_sha256(&revision.revision_sha256)
    {
        return Err(PlanAggregateError::CorruptCheckpoint);
    }
    let actual = revision_hash(
        revision.revision,
        revision.goal_revision,
        &revision.steps,
        revision.previous_revision_sha256.as_deref(),
        &revision.created_at,
    )?;
    if actual != revision.revision_sha256 {
        return Err(PlanAggregateError::CheckpointHashMismatch);
    }
    Ok(())
}

fn revision_hash(
    revision: u64,
    goal_revision: u64,
    steps: &[PlanStep],
    previous: Option<&str>,
    created_at: &str,
) -> Result<String, PlanAggregateError> {
    let canonical = json!({ "revision": revision, "goalRevision": goal_revision, "steps": steps,
        "previousRevisionSha256": previous, "createdAt": created_at });
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical)?)
    ))
}

fn validate_steps(steps: &[PlanStep], authoring: bool) -> Result<(), PlanAggregateError> {
    if steps.is_empty() {
        return Err(PlanAggregateError::EmptyPlan);
    }
    let mut ids = HashSet::new();
    for step in steps {
        require("step_id", &step.step_id)?;
        require("purpose", &step.purpose)?;
        require("expected_artifact", &step.expected_artifact)?;
        if !ids.insert(step.step_id.as_str()) {
            return Err(PlanAggregateError::DuplicateStep(step.step_id.clone()));
        }
        if step.capabilities.is_empty()
            || step
                .capabilities
                .iter()
                .any(|value| value.trim().is_empty())
            || step.required_evidence.is_empty()
            || step
                .required_evidence
                .iter()
                .any(|value| value.trim().is_empty())
        {
            return Err(PlanAggregateError::InvalidStep(step.step_id.clone()));
        }
        if authoring
            && (step.status != PlanStepStatus::Pending || !step.completion_evidence.is_empty())
        {
            return Err(PlanAggregateError::InvalidStep(step.step_id.clone()));
        }
    }
    let positions: HashMap<&str, usize> = steps
        .iter()
        .enumerate()
        .map(|(i, step)| (step.step_id.as_str(), i))
        .collect();
    for (index, step) in steps.iter().enumerate() {
        let mut dependencies = BTreeSet::new();
        for dependency in &step.dependencies {
            if !dependencies.insert(dependency) {
                return Err(PlanAggregateError::DuplicateDependency(dependency.clone()));
            }
            let position = positions
                .get(dependency.as_str())
                .ok_or_else(|| PlanAggregateError::UnknownDependency(dependency.clone()))?;
            if *position >= index {
                return Err(PlanAggregateError::InvalidDependencyOrder {
                    step_id: step.step_id.clone(),
                    dependency_id: dependency.clone(),
                });
            }
        }
    }
    Ok(())
}

fn validate_evidence(step: &PlanStep, evidence: &[PlanEvidence]) -> Result<(), PlanAggregateError> {
    if evidence.is_empty() {
        return Err(PlanAggregateError::EvidenceRequired(step.step_id.clone()));
    }
    let mut types = HashSet::new();
    for item in evidence {
        require("evidence_type", &item.evidence_type)?;
        require("reference_id", &item.reference_id)?;
        if !is_sha256(&item.sha256) {
            return Err(PlanAggregateError::InvalidEvidence);
        }
        types.insert(item.evidence_type.as_str());
    }
    if step
        .required_evidence
        .iter()
        .any(|required| !types.contains(required.as_str()))
    {
        return Err(PlanAggregateError::EvidenceRequired(step.step_id.clone()));
    }
    Ok(())
}

fn step_index(steps: &[PlanStep], step_id: &str) -> Result<usize, PlanAggregateError> {
    steps
        .iter()
        .position(|step| step.step_id == step_id)
        .ok_or_else(|| PlanAggregateError::StepNotFound(step_id.to_owned()))
}

fn require(field: &'static str, value: &str) -> Result<(), PlanAggregateError> {
    if value.trim().is_empty() {
        Err(PlanAggregateError::EmptyField(field))
    } else {
        Ok(())
    }
}
fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Error)]
pub enum PlanAggregateError {
    #[error("plan field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("plan was not found")]
    NotFound,
    #[error("plan must contain at least one step")]
    EmptyPlan,
    #[error("goal revision must be positive")]
    InvalidGoalRevision,
    #[error("plan revision is outside the supported range")]
    RevisionOutOfRange,
    #[error("plan revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("duplicate plan step `{0}`")]
    DuplicateStep(String),
    #[error("invalid plan step `{0}`")]
    InvalidStep(String),
    #[error("duplicate dependency `{0}`")]
    DuplicateDependency(String),
    #[error("unknown dependency `{0}`")]
    UnknownDependency(String),
    #[error("dependency `{dependency_id}` of step `{step_id}` is not complete")]
    DependencyIncomplete {
        step_id: String,
        dependency_id: String,
    },
    #[error("dependency `{dependency_id}` must precede step `{step_id}`")]
    InvalidDependencyOrder {
        step_id: String,
        dependency_id: String,
    },
    #[error("plan step `{0}` was not found")]
    StepNotFound(String),
    #[error("invalid transition for plan step `{step_id}`")]
    InvalidStepTransition { step_id: String },
    #[error("completion evidence is required for step `{0}`")]
    EvidenceRequired(String),
    #[error("plan evidence is invalid")]
    InvalidEvidence,
    #[error("plan checkpoint is corrupt")]
    CorruptCheckpoint,
    #[error("plan checkpoint hash does not match")]
    CheckpointHashMismatch,
    #[error("plan event sequence contains a gap")]
    SequenceGap,
    #[error("plan event `{0}` is unknown")]
    UnknownEvent(String),
    #[error("plan event `{event_type}` version {version} is unsupported")]
    UnknownEventVersion { event_type: String, version: u32 },
    #[error("plan goal binding changed during replay")]
    GoalBindingMismatch,
    #[error(transparent)]
    Journal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
