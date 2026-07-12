use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::workspace_event_journal::{
    NewWorkspaceEvent, WorkspaceEvent, WorkspaceEventJournal, WorkspaceEventJournalError,
};

const STREAM_TYPE: &str = "agent_assignment";
const EVENT_VERSION: u32 = 1;
const GENESIS_HASH: &str = "GENESIS";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildAgentPermission {
    ReadOnly,
    ProposeChangeSet,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RevisionBinding {
    pub id: String,
    pub revision: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AgentAssignmentIdentity {
    pub assignment_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub goal: RevisionBinding,
    pub plan: RevisionBinding,
    pub plan_step_id: String,
    pub parent_run_id: String,
    pub parent_invocation_id: String,
    pub child_profile_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentScope {
    pub resource_ids: Vec<String>,
    pub scope_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentDefinition {
    pub bounded_objective: String,
    pub source_checkpoint_id: String,
    pub expected_artifact: String,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CompletionEvidence {
    pub kind: String,
    pub reference: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentAssignmentStatus {
    Allocated,
    Running,
    CancelRequested,
    Cancelled,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AgentAssignmentAggregate {
    pub identity: AgentAssignmentIdentity,
    pub scope: AssignmentScope,
    pub definition: AssignmentDefinition,
    pub permission: ChildAgentPermission,
    pub status: AgentAssignmentStatus,
    pub child_run_id: Option<String>,
    pub completion_evidence: Vec<CompletionEvidence>,
    pub failure_code: Option<String>,
    pub revision: u64,
    pub last_event_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssignmentEventMetadata {
    pub message_id: String,
    pub idempotency_key: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
enum AssignmentEventData {
    Allocated {
        identity: Box<AgentAssignmentIdentity>,
        scope: Box<AssignmentScope>,
        definition: Box<AssignmentDefinition>,
        permission: ChildAgentPermission,
    },
    Started {
        child_run_id: String,
    },
    CancellationRequested,
    Cancelled,
    Completed {
        evidence: Vec<CompletionEvidence>,
    },
    Failed {
        failure_code: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct StoredAssignmentEvent {
    aggregate_revision: u64,
    previous_hash: String,
    data: AssignmentEventData,
    event_hash: String,
}

#[derive(Serialize)]
struct HashMaterial<'a> {
    aggregate_revision: u64,
    previous_hash: &'a str,
    data: &'a AssignmentEventData,
}

pub struct AgentAssignmentRepository {
    journal: WorkspaceEventJournal,
}

impl AgentAssignmentRepository {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, AgentAssignmentError> {
        Ok(Self {
            journal: WorkspaceEventJournal::open(path)?,
        })
    }

    pub fn allocate(
        &mut self,
        identity: AgentAssignmentIdentity,
        scope: AssignmentScope,
        definition: AssignmentDefinition,
        permission: ChildAgentPermission,
        metadata: AssignmentEventMetadata,
    ) -> Result<AgentAssignmentAggregate, AgentAssignmentError> {
        validate_identity(&identity)?;
        validate_scope(&scope)?;
        validate_definition(&definition)?;
        let workspace_id = identity.workspace_id.clone();
        let assignment_id = identity.assignment_id.clone();
        let data = AssignmentEventData::Allocated {
            identity: Box::new(identity),
            scope: Box::new(scope),
            definition: Box::new(definition),
            permission,
        };
        let existing = self
            .journal
            .read_stream(&workspace_id, STREAM_TYPE, &assignment_id, 0)?;
        if let Some(first) = existing.first() {
            let stored = StoredAssignmentEvent {
                aggregate_revision: 1,
                previous_hash: GENESIS_HASH.into(),
                event_hash: event_hash(1, GENESIS_HASH, &data)?,
                data,
            };
            if first.idempotency_key == metadata.idempotency_key
                && first.event_type == event_type(&stored.data)
                && first.event_version == EVENT_VERSION
                && first.payload == serde_json::to_value(stored)?
            {
                return replay(&existing)?.ok_or(AgentAssignmentError::NotFound);
            }
            if first.idempotency_key == metadata.idempotency_key {
                return Err(AgentAssignmentError::IdempotencyIntentConflict);
            }
            return Err(AgentAssignmentError::AlreadyExists);
        }
        self.append(
            &workspace_id,
            &assignment_id,
            0,
            GENESIS_HASH,
            data,
            metadata,
        )
    }

    pub fn load(
        &self,
        workspace_id: &str,
        assignment_id: &str,
    ) -> Result<AgentAssignmentAggregate, AgentAssignmentError> {
        let events = self
            .journal
            .read_stream(workspace_id, STREAM_TYPE, assignment_id, 0)?;
        replay(&events)?.ok_or(AgentAssignmentError::NotFound)
    }

    pub fn load_revision(
        &self,
        workspace_id: &str,
        assignment_id: &str,
        revision: u64,
    ) -> Result<AgentAssignmentAggregate, AgentAssignmentError> {
        if revision == 0 {
            return Err(AgentAssignmentError::RevisionNotFound(revision));
        }
        let events = self
            .journal
            .read_stream(workspace_id, STREAM_TYPE, assignment_id, 0)?;
        if revision > events.len() as u64 {
            return Err(AgentAssignmentError::RevisionNotFound(revision));
        }
        replay(&events[..revision as usize])?.ok_or(AgentAssignmentError::NotFound)
    }

    pub fn start(
        &mut self,
        workspace_id: &str,
        assignment_id: &str,
        expected_revision: u64,
        child_run_id: String,
        metadata: AssignmentEventMetadata,
    ) -> Result<AgentAssignmentAggregate, AgentAssignmentError> {
        require_text("child_run_id", &child_run_id)?;
        let current = self.require_expected(workspace_id, assignment_id, expected_revision)?;
        if current.status != AgentAssignmentStatus::Allocated {
            return Err(AgentAssignmentError::InvalidTransition);
        }
        self.append_from(
            &current,
            AssignmentEventData::Started { child_run_id },
            metadata,
        )
    }

    pub fn request_cancel(
        &mut self,
        workspace_id: &str,
        assignment_id: &str,
        expected_revision: u64,
        metadata: AssignmentEventMetadata,
    ) -> Result<AgentAssignmentAggregate, AgentAssignmentError> {
        let current = self.require_expected(workspace_id, assignment_id, expected_revision)?;
        match current.status {
            AgentAssignmentStatus::CancelRequested | AgentAssignmentStatus::Cancelled => {
                Ok(current)
            }
            AgentAssignmentStatus::Allocated | AgentAssignmentStatus::Running => self.append_from(
                &current,
                AssignmentEventData::CancellationRequested,
                metadata,
            ),
            AgentAssignmentStatus::Completed | AgentAssignmentStatus::Failed => {
                Err(AgentAssignmentError::TerminalAssignment)
            }
        }
    }

    pub fn confirm_cancelled(
        &mut self,
        workspace_id: &str,
        assignment_id: &str,
        expected_revision: u64,
        metadata: AssignmentEventMetadata,
    ) -> Result<AgentAssignmentAggregate, AgentAssignmentError> {
        let current = self.require_expected(workspace_id, assignment_id, expected_revision)?;
        if current.status == AgentAssignmentStatus::Cancelled {
            return Ok(current);
        }
        if current.status != AgentAssignmentStatus::CancelRequested {
            return Err(if is_terminal(&current.status) {
                AgentAssignmentError::TerminalAssignment
            } else {
                AgentAssignmentError::InvalidTransition
            });
        }
        self.append_from(&current, AssignmentEventData::Cancelled, metadata)
    }

    pub fn complete(
        &mut self,
        workspace_id: &str,
        assignment_id: &str,
        expected_revision: u64,
        evidence: Vec<CompletionEvidence>,
        metadata: AssignmentEventMetadata,
    ) -> Result<AgentAssignmentAggregate, AgentAssignmentError> {
        validate_evidence(&evidence)?;
        let current = self.require_expected(workspace_id, assignment_id, expected_revision)?;
        if !matches!(
            current.status,
            AgentAssignmentStatus::Running | AgentAssignmentStatus::CancelRequested
        ) {
            return Err(if is_terminal(&current.status) {
                AgentAssignmentError::TerminalAssignment
            } else {
                AgentAssignmentError::InvalidTransition
            });
        }
        self.append_from(
            &current,
            AssignmentEventData::Completed { evidence },
            metadata,
        )
    }

    pub fn fail(
        &mut self,
        workspace_id: &str,
        assignment_id: &str,
        expected_revision: u64,
        failure_code: String,
        metadata: AssignmentEventMetadata,
    ) -> Result<AgentAssignmentAggregate, AgentAssignmentError> {
        require_text("failure_code", &failure_code)?;
        let current = self.require_expected(workspace_id, assignment_id, expected_revision)?;
        if !matches!(
            current.status,
            AgentAssignmentStatus::Running | AgentAssignmentStatus::CancelRequested
        ) {
            return Err(if is_terminal(&current.status) {
                AgentAssignmentError::TerminalAssignment
            } else {
                AgentAssignmentError::InvalidTransition
            });
        }
        self.append_from(
            &current,
            AssignmentEventData::Failed { failure_code },
            metadata,
        )
    }

    fn require_expected(
        &self,
        workspace_id: &str,
        assignment_id: &str,
        expected_revision: u64,
    ) -> Result<AgentAssignmentAggregate, AgentAssignmentError> {
        let current = self.load(workspace_id, assignment_id)?;
        if current.revision != expected_revision {
            return Err(AgentAssignmentError::RevisionConflict {
                expected: expected_revision,
                actual: current.revision,
            });
        }
        Ok(current)
    }

    fn append_from(
        &mut self,
        current: &AgentAssignmentAggregate,
        data: AssignmentEventData,
        metadata: AssignmentEventMetadata,
    ) -> Result<AgentAssignmentAggregate, AgentAssignmentError> {
        self.append(
            &current.identity.workspace_id,
            &current.identity.assignment_id,
            current.revision,
            &current.last_event_hash,
            data,
            metadata,
        )
    }

    fn append(
        &mut self,
        workspace_id: &str,
        assignment_id: &str,
        expected_revision: u64,
        previous_hash: &str,
        data: AssignmentEventData,
        metadata: AssignmentEventMetadata,
    ) -> Result<AgentAssignmentAggregate, AgentAssignmentError> {
        let aggregate_revision = expected_revision
            .checked_add(1)
            .ok_or(AgentAssignmentError::RevisionOutOfRange)?;
        let event_hash = event_hash(aggregate_revision, previous_hash, &data)?;
        let stored = StoredAssignmentEvent {
            aggregate_revision,
            previous_hash: previous_hash.into(),
            data,
            event_hash,
        };
        let workspace_sequence = self.journal.current_workspace_sequence(workspace_id)?;
        self.journal.append(
            NewWorkspaceEvent {
                workspace_id: workspace_id.into(),
                stream_type: STREAM_TYPE.into(),
                stream_id: assignment_id.into(),
                message_id: metadata.message_id,
                idempotency_key: metadata.idempotency_key,
                event_type: event_type(&stored.data).into(),
                event_version: EVENT_VERSION,
                payload: serde_json::to_value(stored)?,
                created_at: metadata.created_at,
            },
            workspace_sequence,
            expected_revision,
        )?;
        self.load(workspace_id, assignment_id)
    }
}

pub fn replay(
    events: &[WorkspaceEvent],
) -> Result<Option<AgentAssignmentAggregate>, AgentAssignmentError> {
    let mut aggregate: Option<AgentAssignmentAggregate> = None;
    for event in events {
        if event.stream_type != STREAM_TYPE {
            return Err(AgentAssignmentError::EventEnvelopeMismatch);
        }
        if event.event_version != EVENT_VERSION {
            return Err(AgentAssignmentError::UnknownEventVersion {
                event_type: event.event_type.clone(),
                version: event.event_version,
            });
        }
        let stored: StoredAssignmentEvent = serde_json::from_value(event.payload.clone())
            .map_err(|_| AgentAssignmentError::CorruptEventPayload)?;
        let expected_event_type = event_type(&stored.data);
        if event.event_type != expected_event_type {
            return Err(AgentAssignmentError::EventTypeMismatch {
                expected: expected_event_type,
                actual: event.event_type.clone(),
            });
        }
        let expected_revision = aggregate.as_ref().map_or(Ok(1), |value| {
            value
                .revision
                .checked_add(1)
                .ok_or(AgentAssignmentError::RevisionOutOfRange)
        })?;
        if event.stream_sequence != expected_revision
            || stored.aggregate_revision != expected_revision
        {
            return Err(AgentAssignmentError::SequenceGap);
        }
        let previous_hash = aggregate
            .as_ref()
            .map_or(GENESIS_HASH, |value| value.last_event_hash.as_str());
        if stored.previous_hash != previous_hash
            || stored.event_hash
                != event_hash(
                    stored.aggregate_revision,
                    &stored.previous_hash,
                    &stored.data,
                )?
        {
            return Err(AgentAssignmentError::EventIntegrityFailed {
                revision: stored.aggregate_revision,
            });
        }
        apply_event(&mut aggregate, event, stored)?;
    }
    Ok(aggregate)
}

fn apply_event(
    aggregate: &mut Option<AgentAssignmentAggregate>,
    envelope: &WorkspaceEvent,
    event: StoredAssignmentEvent,
) -> Result<(), AgentAssignmentError> {
    match event.data {
        AssignmentEventData::Allocated {
            identity,
            scope,
            definition,
            permission,
        } => {
            if aggregate.is_some() {
                return Err(AgentAssignmentError::IdentityMutation);
            }
            validate_identity(&identity)?;
            validate_scope(&scope)?;
            validate_definition(&definition)?;
            if envelope.workspace_id != identity.workspace_id
                || envelope.stream_id != identity.assignment_id
            {
                return Err(AgentAssignmentError::EventEnvelopeMismatch);
            }
            *aggregate = Some(AgentAssignmentAggregate {
                identity: *identity,
                scope: *scope,
                definition: *definition,
                permission,
                status: AgentAssignmentStatus::Allocated,
                child_run_id: None,
                completion_evidence: vec![],
                failure_code: None,
                revision: event.aggregate_revision,
                last_event_hash: event.event_hash,
            });
            return Ok(());
        }
        _ if aggregate.is_none() => return Err(AgentAssignmentError::MissingAllocation),
        _ => {}
    }
    let value = aggregate
        .as_mut()
        .ok_or(AgentAssignmentError::MissingAllocation)?;
    if envelope.workspace_id != value.identity.workspace_id
        || envelope.stream_id != value.identity.assignment_id
    {
        return Err(AgentAssignmentError::EventEnvelopeMismatch);
    }
    match event.data {
        AssignmentEventData::Started { child_run_id } => {
            require_text("child_run_id", &child_run_id)?;
            if value.status != AgentAssignmentStatus::Allocated || value.child_run_id.is_some() {
                return Err(AgentAssignmentError::InvalidTransition);
            }
            value.status = AgentAssignmentStatus::Running;
            value.child_run_id = Some(child_run_id);
        }
        AssignmentEventData::CancellationRequested => {
            if !matches!(
                value.status,
                AgentAssignmentStatus::Allocated | AgentAssignmentStatus::Running
            ) {
                return Err(AgentAssignmentError::InvalidTransition);
            }
            value.status = AgentAssignmentStatus::CancelRequested;
        }
        AssignmentEventData::Cancelled => {
            if value.status != AgentAssignmentStatus::CancelRequested {
                return Err(AgentAssignmentError::InvalidTransition);
            }
            value.status = AgentAssignmentStatus::Cancelled;
        }
        AssignmentEventData::Completed { evidence } => {
            validate_evidence(&evidence)?;
            if !matches!(
                value.status,
                AgentAssignmentStatus::Running | AgentAssignmentStatus::CancelRequested
            ) {
                return Err(AgentAssignmentError::InvalidTransition);
            }
            value.status = AgentAssignmentStatus::Completed;
            value.completion_evidence = evidence;
        }
        AssignmentEventData::Failed { failure_code } => {
            require_text("failure_code", &failure_code)?;
            if !matches!(
                value.status,
                AgentAssignmentStatus::Running | AgentAssignmentStatus::CancelRequested
            ) {
                return Err(AgentAssignmentError::InvalidTransition);
            }
            value.status = AgentAssignmentStatus::Failed;
            value.failure_code = Some(failure_code);
        }
        AssignmentEventData::Allocated { .. } => {
            return Err(AgentAssignmentError::IdentityMutation);
        }
    }
    value.revision = event.aggregate_revision;
    value.last_event_hash = event.event_hash;
    Ok(())
}

fn validate_identity(identity: &AgentAssignmentIdentity) -> Result<(), AgentAssignmentError> {
    for (field, value) in [
        ("assignment_id", identity.assignment_id.as_str()),
        ("workspace_id", identity.workspace_id.as_str()),
        ("project_id", identity.project_id.as_str()),
        ("plan_step_id", identity.plan_step_id.as_str()),
        ("parent_run_id", identity.parent_run_id.as_str()),
        (
            "parent_invocation_id",
            identity.parent_invocation_id.as_str(),
        ),
        ("child_profile_id", identity.child_profile_id.as_str()),
    ] {
        require_text(field, value)?;
    }
    validate_binding("goal", &identity.goal)?;
    validate_binding("plan", &identity.plan)?;
    Ok(())
}

fn validate_binding(
    field: &'static str,
    binding: &RevisionBinding,
) -> Result<(), AgentAssignmentError> {
    require_text(field, &binding.id)?;
    if binding.revision == 0 || !is_sha256(&binding.sha256) {
        return Err(AgentAssignmentError::InvalidRevisionBinding(field));
    }
    Ok(())
}

fn validate_scope(scope: &AssignmentScope) -> Result<(), AgentAssignmentError> {
    if scope.resource_ids.is_empty()
        || scope
            .resource_ids
            .iter()
            .any(|value| value.trim().is_empty())
    {
        return Err(AgentAssignmentError::InvalidScope);
    }
    let mut canonical = scope.resource_ids.clone();
    canonical.sort();
    canonical.dedup();
    if canonical != scope.resource_ids {
        return Err(AgentAssignmentError::NonCanonicalScope);
    }
    let expected = format!("{:x}", Sha256::digest(serde_json::to_vec(&canonical)?));
    if scope.scope_sha256 != expected {
        return Err(AgentAssignmentError::ScopeHashMismatch);
    }
    Ok(())
}

fn validate_definition(definition: &AssignmentDefinition) -> Result<(), AgentAssignmentError> {
    require_text("bounded_objective", &definition.bounded_objective)?;
    require_text("source_checkpoint_id", &definition.source_checkpoint_id)?;
    require_text("expected_artifact", &definition.expected_artifact)?;
    if definition.capabilities.is_empty()
        || definition
            .capabilities
            .iter()
            .any(|capability| capability.trim().is_empty())
    {
        return Err(AgentAssignmentError::InvalidCapabilities);
    }
    let mut canonical = definition.capabilities.clone();
    canonical.sort();
    canonical.dedup();
    if canonical != definition.capabilities {
        return Err(AgentAssignmentError::NonCanonicalCapabilities);
    }
    Ok(())
}

fn validate_evidence(evidence: &[CompletionEvidence]) -> Result<(), AgentAssignmentError> {
    if evidence.is_empty() {
        return Err(AgentAssignmentError::CompletionEvidenceRequired);
    }
    for value in evidence {
        require_text("evidence_kind", &value.kind)?;
        require_text("evidence_reference", &value.reference)?;
        if !is_sha256(&value.sha256) {
            return Err(AgentAssignmentError::InvalidEvidenceHash);
        }
    }
    Ok(())
}

fn require_text(field: &'static str, value: &str) -> Result<(), AgentAssignmentError> {
    if value.trim().is_empty() {
        Err(AgentAssignmentError::EmptyField(field))
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

fn is_terminal(status: &AgentAssignmentStatus) -> bool {
    matches!(
        status,
        AgentAssignmentStatus::Cancelled
            | AgentAssignmentStatus::Completed
            | AgentAssignmentStatus::Failed
    )
}

fn event_hash(
    aggregate_revision: u64,
    previous_hash: &str,
    data: &AssignmentEventData,
) -> Result<String, AgentAssignmentError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&HashMaterial {
            aggregate_revision,
            previous_hash,
            data,
        })?)
    ))
}

fn event_type(data: &AssignmentEventData) -> &'static str {
    match data {
        AssignmentEventData::Allocated { .. } => "agent_assignment.allocated",
        AssignmentEventData::Started { .. } => "agent_assignment.started",
        AssignmentEventData::CancellationRequested => "agent_assignment.cancellation_requested",
        AssignmentEventData::Cancelled => "agent_assignment.cancelled",
        AssignmentEventData::Completed { .. } => "agent_assignment.completed",
        AssignmentEventData::Failed { .. } => "agent_assignment.failed",
    }
}

#[derive(Debug, Error)]
pub enum AgentAssignmentError {
    #[error("agent assignment field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("agent assignment already exists")]
    AlreadyExists,
    #[error("agent assignment idempotency key was reused with a different canonical intent")]
    IdempotencyIntentConflict,
    #[error("agent assignment was not found")]
    NotFound,
    #[error("agent assignment revision binding `{0}` is invalid")]
    InvalidRevisionBinding(&'static str),
    #[error("agent assignment scope is invalid")]
    InvalidScope,
    #[error("agent assignment scope resource ids must be sorted and unique")]
    NonCanonicalScope,
    #[error("agent assignment scope hash does not match")]
    ScopeHashMismatch,
    #[error("agent assignment capabilities are invalid")]
    InvalidCapabilities,
    #[error("agent assignment capabilities must be sorted and unique")]
    NonCanonicalCapabilities,
    #[error("agent assignment completion evidence is required")]
    CompletionEvidenceRequired,
    #[error("agent assignment evidence hash is invalid")]
    InvalidEvidenceHash,
    #[error("agent assignment revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("agent assignment revision {0} was not found")]
    RevisionNotFound(u64),
    #[error("agent assignment revision is outside the supported range")]
    RevisionOutOfRange,
    #[error("agent assignment transition is invalid")]
    InvalidTransition,
    #[error("agent assignment is terminal")]
    TerminalAssignment,
    #[error("agent assignment event sequence contains a gap")]
    SequenceGap,
    #[error("agent assignment allocation event is missing")]
    MissingAllocation,
    #[error("agent assignment immutable identity changed")]
    IdentityMutation,
    #[error("agent assignment event envelope does not match its immutable identity")]
    EventEnvelopeMismatch,
    #[error("agent assignment event type mismatch: expected `{expected}`, actual `{actual}`")]
    EventTypeMismatch {
        expected: &'static str,
        actual: String,
    },
    #[error("agent assignment event `{event_type}` version {version} is unsupported")]
    UnknownEventVersion { event_type: String, version: u32 },
    #[error("agent assignment event payload is corrupt")]
    CorruptEventPayload,
    #[error("agent assignment event hash failed at revision {revision}")]
    EventIntegrityFailed { revision: u64 },
    #[error(transparent)]
    Journal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
