use sha2::{Digest, Sha256};
use thiserror::Error;

use serde::{Deserialize, Serialize};

use crate::workspace_event_journal::{
    NewWorkspaceEvent, WorkspaceEvent, WorkspaceEventJournal, WorkspaceEventJournalError,
};

const STREAM_TYPE: &str = "goal";
const EVENT_VERSION: u32 = 1;
const GENESIS_HASH: &str = "GENESIS";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalPermissionMode {
    Free,
    Assist,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GoalIdentity {
    pub workspace_id: String,
    pub project_id: String,
    pub session_id: String,
    pub goal_id: String,
    pub owner_agent_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EvidenceRef {
    pub kind: String,
    pub reference: String,
    pub description: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AcceptanceCriterion {
    pub criterion_id: String,
    pub description: String,
    pub required: bool,
    pub satisfied: bool,
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalScope {
    pub resource_ids: Vec<String>,
    pub scope_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GoalDefinition {
    pub objective: String,
    pub scope: GoalScope,
    pub acceptance_criteria: Vec<AcceptanceCriterion>,
    pub constraints: Vec<String>,
    pub permission_mode: GoalPermissionMode,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GoalBlocker {
    pub blocker_id: String,
    pub description: String,
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    CompletionProposed,
    Completed,
    Blocked,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GoalAggregate {
    pub identity: GoalIdentity,
    pub definition: GoalDefinition,
    pub definition_revision: u64,
    pub revision: u64,
    pub status: GoalStatus,
    pub evidence_refs: Vec<EvidenceRef>,
    pub blockers: Vec<GoalBlocker>,
    pub last_event_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalActor {
    pub agent_id: String,
    pub is_child_agent: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GoalCheckpoint {
    pub aggregate: GoalAggregate,
    pub through_revision: u64,
    pub through_event_hash: String,
    pub checkpoint_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
enum GoalEventData {
    Created {
        identity: GoalIdentity,
        definition: GoalDefinition,
    },
    Revised {
        definition: GoalDefinition,
    },
    CompletionProposed {
        evidence_refs: Vec<EvidenceRef>,
    },
    Blocked {
        blocker: GoalBlocker,
    },
    Reactivated,
    Completed {
        evidence_refs: Vec<EvidenceRef>,
    },
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct StoredGoalEvent {
    aggregate_revision: u64,
    previous_hash: String,
    data: GoalEventData,
    event_hash: String,
}

#[derive(Serialize)]
struct HashMaterial<'a> {
    aggregate_revision: u64,
    previous_hash: &'a str,
    data: &'a GoalEventData,
}

#[derive(Serialize)]
struct CheckpointHashMaterial<'a> {
    aggregate: &'a GoalAggregate,
    through_revision: u64,
    through_event_hash: &'a str,
}

pub struct GoalAggregateRepository {
    journal: WorkspaceEventJournal,
}

impl GoalAggregateRepository {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, GoalAggregateError> {
        Ok(Self {
            journal: WorkspaceEventJournal::open(path)?,
        })
    }

    pub fn create(
        &mut self,
        identity: GoalIdentity,
        definition: GoalDefinition,
        message_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        created_at: impl Into<String>,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        validate_identity(&identity)?;
        validate_definition(&definition)?;
        if self.journal.current_stream_sequence(
            &identity.workspace_id,
            STREAM_TYPE,
            &identity.goal_id,
        )? != 0
        {
            return Err(GoalAggregateError::AlreadyExists);
        }
        let workspace_id = identity.workspace_id.clone();
        let goal_id = identity.goal_id.clone();
        self.append(
            &workspace_id,
            &goal_id,
            0,
            GoalEventData::Created {
                identity,
                definition,
            },
            message_id.into(),
            idempotency_key.into(),
            created_at.into(),
            GENESIS_HASH,
        )
    }

    pub fn load(
        &self,
        workspace_id: &str,
        goal_id: &str,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        let events = self
            .journal
            .read_stream(workspace_id, STREAM_TYPE, goal_id, 0)?;
        if events.is_empty() {
            return Err(GoalAggregateError::NotFound);
        }
        replay(None, &events)?.ok_or(GoalAggregateError::NotFound)
    }

    pub fn load_revision(
        &self,
        workspace_id: &str,
        goal_id: &str,
        revision: u64,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        if revision == 0 {
            return Err(GoalAggregateError::RevisionNotFound(revision));
        }
        let events = self
            .journal
            .read_stream(workspace_id, STREAM_TYPE, goal_id, 0)?;
        if events.is_empty() {
            return Err(GoalAggregateError::NotFound);
        }
        let length = usize::try_from(revision)
            .ok()
            .filter(|length| *length <= events.len())
            .ok_or(GoalAggregateError::RevisionNotFound(revision))?;
        let aggregate = replay(None, &events[..length])?.ok_or(GoalAggregateError::NotFound)?;
        if aggregate.revision != revision {
            return Err(GoalAggregateError::RevisionNotFound(revision));
        }
        Ok(aggregate)
    }

    pub fn revise(
        &mut self,
        workspace_id: &str,
        goal_id: &str,
        expected_revision: u64,
        definition: GoalDefinition,
        metadata: EventMetadata,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        validate_definition(&definition)?;
        let current = self.require_expected(workspace_id, goal_id, expected_revision)?;
        if matches!(
            current.status,
            GoalStatus::Completed | GoalStatus::Cancelled
        ) {
            return Err(GoalAggregateError::TerminalGoal);
        }
        self.append_from(&current, GoalEventData::Revised { definition }, metadata)
    }

    pub fn propose_completion(
        &mut self,
        workspace_id: &str,
        goal_id: &str,
        expected_revision: u64,
        evidence_refs: Vec<EvidenceRef>,
        metadata: EventMetadata,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        validate_evidence(&evidence_refs)?;
        let current = self.require_expected(workspace_id, goal_id, expected_revision)?;
        require_active_or_proposed(&current.status)?;
        self.append_from(
            &current,
            GoalEventData::CompletionProposed { evidence_refs },
            metadata,
        )
    }

    pub fn block(
        &mut self,
        workspace_id: &str,
        goal_id: &str,
        expected_revision: u64,
        blocker: GoalBlocker,
        metadata: EventMetadata,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        require_text("blocker_id", &blocker.blocker_id)?;
        require_text("blocker_description", &blocker.description)?;
        validate_evidence(&blocker.evidence_refs)?;
        let current = self.require_expected(workspace_id, goal_id, expected_revision)?;
        if matches!(
            current.status,
            GoalStatus::Completed | GoalStatus::Cancelled
        ) {
            return Err(GoalAggregateError::TerminalGoal);
        }
        self.append_from(&current, GoalEventData::Blocked { blocker }, metadata)
    }

    pub fn reactivate(
        &mut self,
        workspace_id: &str,
        goal_id: &str,
        expected_revision: u64,
        metadata: EventMetadata,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        let current = self.require_expected(workspace_id, goal_id, expected_revision)?;
        if current.status != GoalStatus::Blocked {
            return Err(GoalAggregateError::InvalidTransition);
        }
        self.append_from(&current, GoalEventData::Reactivated, metadata)
    }

    pub fn complete(
        &mut self,
        workspace_id: &str,
        goal_id: &str,
        expected_revision: u64,
        actor: &GoalActor,
        evidence_refs: Vec<EvidenceRef>,
        metadata: EventMetadata,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        validate_evidence(&evidence_refs)?;
        let current = self.require_expected(workspace_id, goal_id, expected_revision)?;
        if actor.is_child_agent || actor.agent_id != current.identity.owner_agent_id {
            return Err(GoalAggregateError::CompletionForbidden);
        }
        if current.status != GoalStatus::CompletionProposed {
            return Err(GoalAggregateError::InvalidTransition);
        }
        if !current.blockers.is_empty() {
            return Err(GoalAggregateError::UnresolvedBlockers);
        }
        if current
            .definition
            .acceptance_criteria
            .iter()
            .any(|criterion| {
                criterion.required && (!criterion.satisfied || criterion.evidence_refs.is_empty())
            })
        {
            return Err(GoalAggregateError::RequiredCriteriaUnsatisfied);
        }
        let mut all_evidence = current.evidence_refs.clone();
        all_evidence.extend(evidence_refs.iter().cloned());
        if all_evidence.is_empty() {
            return Err(GoalAggregateError::CompletionEvidenceRequired);
        }
        self.append_from(
            &current,
            GoalEventData::Completed { evidence_refs },
            metadata,
        )
    }

    pub fn cancel(
        &mut self,
        workspace_id: &str,
        goal_id: &str,
        expected_revision: u64,
        actor: &GoalActor,
        metadata: EventMetadata,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        let current = self.require_expected(workspace_id, goal_id, expected_revision)?;
        if actor.is_child_agent || actor.agent_id != current.identity.owner_agent_id {
            return Err(GoalAggregateError::OwnerRequired);
        }
        if matches!(
            current.status,
            GoalStatus::Completed | GoalStatus::Cancelled
        ) {
            return Err(GoalAggregateError::TerminalGoal);
        }
        self.append_from(&current, GoalEventData::Cancelled, metadata)
    }

    fn require_expected(
        &self,
        workspace_id: &str,
        goal_id: &str,
        expected_revision: u64,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        let current = self.load(workspace_id, goal_id)?;
        if current.revision != expected_revision {
            return Err(GoalAggregateError::RevisionConflict {
                expected: expected_revision,
                actual: current.revision,
            });
        }
        Ok(current)
    }

    fn append_from(
        &mut self,
        current: &GoalAggregate,
        data: GoalEventData,
        metadata: EventMetadata,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        self.append(
            &current.identity.workspace_id,
            &current.identity.goal_id,
            current.revision,
            data,
            metadata.message_id,
            metadata.idempotency_key,
            metadata.created_at,
            &current.last_event_hash,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn append(
        &mut self,
        workspace_id: &str,
        goal_id: &str,
        expected_revision: u64,
        data: GoalEventData,
        message_id: String,
        idempotency_key: String,
        created_at: String,
        previous_hash: &str,
    ) -> Result<GoalAggregate, GoalAggregateError> {
        let aggregate_revision = expected_revision
            .checked_add(1)
            .ok_or(GoalAggregateError::RevisionOutOfRange)?;
        let event_hash = event_hash(aggregate_revision, previous_hash, &data)?;
        let payload = serde_json::to_value(StoredGoalEvent {
            aggregate_revision,
            previous_hash: previous_hash.to_owned(),
            data,
            event_hash,
        })?;
        let expected_workspace_sequence = self.journal.current_workspace_sequence(workspace_id)?;
        match self.journal.append(
            NewWorkspaceEvent {
                workspace_id: workspace_id.to_owned(),
                stream_type: STREAM_TYPE.to_owned(),
                stream_id: goal_id.to_owned(),
                message_id,
                idempotency_key,
                event_type: "goal.event".to_owned(),
                event_version: EVENT_VERSION,
                payload,
                created_at,
            },
            expected_workspace_sequence,
            expected_revision,
        ) {
            Ok(_) => self.load(workspace_id, goal_id),
            Err(WorkspaceEventJournalError::StreamSequenceConflict { actual, .. }) => {
                Err(GoalAggregateError::RevisionConflict {
                    expected: expected_revision,
                    actual,
                })
            }
            Err(WorkspaceEventJournalError::WorkspaceSequenceConflict { .. }) => {
                let actual =
                    self.journal
                        .current_stream_sequence(workspace_id, STREAM_TYPE, goal_id)?;
                Err(GoalAggregateError::RevisionConflict {
                    expected: expected_revision,
                    actual,
                })
            }
            Err(error) => Err(error.into()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventMetadata {
    pub message_id: String,
    pub idempotency_key: String,
    pub created_at: String,
}

impl GoalCheckpoint {
    pub fn create(aggregate: GoalAggregate) -> Result<Self, GoalAggregateError> {
        let through_revision = aggregate.revision;
        let through_event_hash = aggregate.last_event_hash.clone();
        let checkpoint_hash = checkpoint_hash(&aggregate, through_revision, &through_event_hash)?;
        Ok(Self {
            aggregate,
            through_revision,
            through_event_hash,
            checkpoint_hash,
        })
    }
}

pub fn replay(
    checkpoint: Option<&GoalCheckpoint>,
    events: &[WorkspaceEvent],
) -> Result<Option<GoalAggregate>, GoalAggregateError> {
    let mut aggregate = match checkpoint {
        Some(checkpoint) => {
            let expected = checkpoint_hash(
                &checkpoint.aggregate,
                checkpoint.through_revision,
                &checkpoint.through_event_hash,
            )?;
            if expected != checkpoint.checkpoint_hash
                || checkpoint.aggregate.revision != checkpoint.through_revision
                || checkpoint.aggregate.last_event_hash != checkpoint.through_event_hash
            {
                return Err(GoalAggregateError::CheckpointIntegrityFailed);
            }
            Some(checkpoint.aggregate.clone())
        }
        None => None,
    };
    let mut previous_hash = checkpoint
        .map(|value| value.through_event_hash.as_str())
        .unwrap_or(GENESIS_HASH)
        .to_owned();
    let mut expected_revision = checkpoint.map_or(1, |value| value.through_revision + 1);
    for event in events {
        if event.stream_type != STREAM_TYPE || event.event_type != "goal.event" {
            return Err(GoalAggregateError::UnexpectedEventType);
        }
        if event.event_version != EVENT_VERSION {
            return Err(GoalAggregateError::UnsupportedEventVersion(
                event.event_version,
            ));
        }
        let stored: StoredGoalEvent = serde_json::from_value(event.payload.clone())
            .map_err(|_| GoalAggregateError::CorruptEventPayload)?;
        if stored.aggregate_revision != expected_revision
            || event.stream_sequence != expected_revision
            || stored.previous_hash != previous_hash
            || stored.event_hash
                != event_hash(
                    stored.aggregate_revision,
                    &stored.previous_hash,
                    &stored.data,
                )?
        {
            return Err(GoalAggregateError::EventIntegrityFailed {
                revision: stored.aggregate_revision,
            });
        }
        apply_event(
            &mut aggregate,
            stored.data,
            stored.aggregate_revision,
            &stored.event_hash,
        )?;
        previous_hash = stored.event_hash;
        expected_revision = expected_revision
            .checked_add(1)
            .ok_or(GoalAggregateError::RevisionOutOfRange)?;
    }
    Ok(aggregate)
}

fn apply_event(
    aggregate: &mut Option<GoalAggregate>,
    data: GoalEventData,
    revision: u64,
    event_hash: &str,
) -> Result<(), GoalAggregateError> {
    match data {
        GoalEventData::Created {
            identity,
            definition,
        } if aggregate.is_none() && revision == 1 => {
            validate_identity(&identity)?;
            validate_definition(&definition)?;
            *aggregate = Some(GoalAggregate {
                identity,
                definition,
                definition_revision: 1,
                revision,
                status: GoalStatus::Active,
                evidence_refs: Vec::new(),
                blockers: Vec::new(),
                last_event_hash: event_hash.to_owned(),
            });
        }
        GoalEventData::Created { .. } => return Err(GoalAggregateError::InvalidEventOrder),
        GoalEventData::Revised { definition } => {
            validate_definition(&definition)?;
            let aggregate = aggregate
                .as_mut()
                .ok_or(GoalAggregateError::InvalidEventOrder)?;
            aggregate.definition = definition;
            aggregate.definition_revision = aggregate
                .definition_revision
                .checked_add(1)
                .ok_or(GoalAggregateError::RevisionOutOfRange)?;
            aggregate.status = GoalStatus::Active;
        }
        GoalEventData::CompletionProposed { evidence_refs } => {
            let aggregate = aggregate
                .as_mut()
                .ok_or(GoalAggregateError::InvalidEventOrder)?;
            aggregate.evidence_refs.extend(evidence_refs);
            aggregate.status = GoalStatus::CompletionProposed;
        }
        GoalEventData::Blocked { blocker } => {
            let aggregate = aggregate
                .as_mut()
                .ok_or(GoalAggregateError::InvalidEventOrder)?;
            aggregate.blockers.push(blocker);
            aggregate.status = GoalStatus::Blocked;
        }
        GoalEventData::Reactivated => {
            let aggregate = aggregate
                .as_mut()
                .ok_or(GoalAggregateError::InvalidEventOrder)?;
            aggregate.blockers.clear();
            aggregate.status = GoalStatus::Active;
        }
        GoalEventData::Completed { evidence_refs } => {
            let aggregate = aggregate
                .as_mut()
                .ok_or(GoalAggregateError::InvalidEventOrder)?;
            aggregate.evidence_refs.extend(evidence_refs);
            aggregate.status = GoalStatus::Completed;
        }
        GoalEventData::Cancelled => {
            aggregate
                .as_mut()
                .ok_or(GoalAggregateError::InvalidEventOrder)?
                .status = GoalStatus::Cancelled;
        }
    }
    if let Some(aggregate) = aggregate {
        aggregate.revision = revision;
        aggregate.last_event_hash = event_hash.to_owned();
    }
    Ok(())
}

fn event_hash(
    aggregate_revision: u64,
    previous_hash: &str,
    data: &GoalEventData,
) -> Result<String, GoalAggregateError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&HashMaterial {
            aggregate_revision,
            previous_hash,
            data,
        })?)
    ))
}

fn checkpoint_hash(
    aggregate: &GoalAggregate,
    through_revision: u64,
    through_event_hash: &str,
) -> Result<String, GoalAggregateError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&CheckpointHashMaterial {
            aggregate,
            through_revision,
            through_event_hash,
        })?)
    ))
}

fn validate_identity(identity: &GoalIdentity) -> Result<(), GoalAggregateError> {
    for (field, value) in [
        ("workspace_id", &identity.workspace_id),
        ("project_id", &identity.project_id),
        ("session_id", &identity.session_id),
        ("goal_id", &identity.goal_id),
        ("owner_agent_id", &identity.owner_agent_id),
    ] {
        require_text(field, value)?;
    }
    Ok(())
}

fn validate_definition(definition: &GoalDefinition) -> Result<(), GoalAggregateError> {
    require_text("objective", &definition.objective)?;
    if definition.scope.resource_ids.is_empty()
        || definition.acceptance_criteria.is_empty()
        || definition
            .scope
            .resource_ids
            .iter()
            .any(|value| value.trim().is_empty())
        || definition
            .scope
            .resource_ids
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        || !is_sha256(&definition.scope.scope_sha256)
        || definition.scope.scope_sha256
            != format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(&definition.scope.resource_ids)
                        .map_err(|_| GoalAggregateError::CorruptEventPayload)?
                )
            )
    {
        return Err(GoalAggregateError::InvalidDefinition);
    }
    for value in &definition.constraints {
        require_text("definition_item", value)?;
    }
    for criterion in &definition.acceptance_criteria {
        require_text("criterion_id", &criterion.criterion_id)?;
        require_text("criterion_description", &criterion.description)?;
        if criterion.satisfied && criterion.evidence_refs.is_empty() {
            return Err(GoalAggregateError::SatisfiedCriterionNeedsEvidence);
        }
        validate_evidence(&criterion.evidence_refs)?;
    }
    Ok(())
}

fn validate_evidence(evidence_refs: &[EvidenceRef]) -> Result<(), GoalAggregateError> {
    for evidence in evidence_refs {
        require_text("evidence_kind", &evidence.kind)?;
        require_text("evidence_reference", &evidence.reference)?;
        require_text("evidence_description", &evidence.description)?;
    }
    Ok(())
}

fn require_text(field: &'static str, value: &str) -> Result<(), GoalAggregateError> {
    if value.trim().is_empty() {
        Err(GoalAggregateError::EmptyField(field))
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

fn require_active_or_proposed(status: &GoalStatus) -> Result<(), GoalAggregateError> {
    if matches!(status, GoalStatus::Active | GoalStatus::CompletionProposed) {
        Ok(())
    } else {
        Err(GoalAggregateError::InvalidTransition)
    }
}

#[derive(Debug, Error)]
pub enum GoalAggregateError {
    #[error("goal field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("goal definition must include scope and acceptance criteria")]
    InvalidDefinition,
    #[error("a satisfied acceptance criterion must include evidence")]
    SatisfiedCriterionNeedsEvidence,
    #[error("goal already exists")]
    AlreadyExists,
    #[error("goal was not found")]
    NotFound,
    #[error("goal revision {0} was not found")]
    RevisionNotFound(u64),
    #[error("goal revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("goal revision is outside the supported range")]
    RevisionOutOfRange,
    #[error("goal is terminal")]
    TerminalGoal,
    #[error("goal transition is invalid")]
    InvalidTransition,
    #[error("only the non-child owner agent may complete the goal")]
    CompletionForbidden,
    #[error("only the non-child owner agent may perform this operation")]
    OwnerRequired,
    #[error("required acceptance criteria are not satisfied with evidence")]
    RequiredCriteriaUnsatisfied,
    #[error("goal has unresolved blockers")]
    UnresolvedBlockers,
    #[error("completion evidence is required")]
    CompletionEvidenceRequired,
    #[error("unsupported goal event version {0}")]
    UnsupportedEventVersion(u32),
    #[error("unexpected event type in goal stream")]
    UnexpectedEventType,
    #[error("goal event payload is corrupt")]
    CorruptEventPayload,
    #[error("goal event order is invalid")]
    InvalidEventOrder,
    #[error("goal event integrity failed at revision {revision}")]
    EventIntegrityFailed { revision: u64 },
    #[error("goal checkpoint integrity failed")]
    CheckpointIntegrityFailed,
    #[error(transparent)]
    Journal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
