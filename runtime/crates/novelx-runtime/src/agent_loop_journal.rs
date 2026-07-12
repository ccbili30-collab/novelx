use novelx_protocol::ToolRequest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    agent_loop_service::{
        AgentLoopDirective, AgentLoopError, AgentLoopService, InferenceDispatchIdentity, LoopPhase,
        ProviderRetryBinding, validate_inference_retry_transition,
    },
    event_journal::{EventJournal, EventJournalError, NewRuntimeEvent, RuntimeEvent},
};

const AGGREGATE_TYPE: &str = "agent_loop";
const EVENT_VERSION: u32 = 1;

#[derive(Clone, Copy)]
pub struct AgentLoopEventMetadata<'a> {
    pub message_id: &'a str,
    pub created_at: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectiveKind {
    Created,
    ExecuteTools,
    AwaitApproval,
    CompileContext,
    StartInference,
    Completed,
    Cancelled,
    InferenceStarted,
    InferenceRetried,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StateTransitionKind {
    InferenceStarted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingInferenceOrigin {
    Created,
    InferenceStarted,
    InferenceRetried,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentLoopRecord {
    pub service: AgentLoopService,
    pub aggregate_sequence: u64,
    pub last_run_sequence: u64,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoopProviderAuthorizationSnapshot {
    run_id: Uuid,
    invocation_id: String,
    aggregate_sequence: u64,
    checkpoint_sha256: String,
    pending_inference: InferenceDispatchIdentity,
    pending_inference_sha256: String,
    pending_inference_persisted_at: String,
    pending_inference_origin: PendingInferenceOrigin,
    last_retry_binding: Option<ProviderRetryBinding>,
    last_retry_binding_sha256: Option<String>,
}

impl AgentLoopProviderAuthorizationSnapshot {
    pub const fn run_id(&self) -> Uuid {
        self.run_id
    }

    pub fn invocation_id(&self) -> &str {
        &self.invocation_id
    }

    pub const fn aggregate_sequence(&self) -> u64 {
        self.aggregate_sequence
    }

    pub fn checkpoint_sha256(&self) -> &str {
        &self.checkpoint_sha256
    }

    pub const fn pending_inference(&self) -> &InferenceDispatchIdentity {
        &self.pending_inference
    }

    pub fn pending_inference_sha256(&self) -> &str {
        &self.pending_inference_sha256
    }

    pub fn pending_inference_persisted_at(&self) -> &str {
        &self.pending_inference_persisted_at
    }

    pub const fn pending_inference_origin(&self) -> PendingInferenceOrigin {
        self.pending_inference_origin
    }

    pub const fn last_retry_binding(&self) -> Option<&ProviderRetryBinding> {
        self.last_retry_binding.as_ref()
    }

    pub fn last_retry_binding_sha256(&self) -> Option<&str> {
        self.last_retry_binding_sha256.as_deref()
    }
}

struct AuthoritativeReplay {
    record: AgentLoopRecord,
    checkpoint_sha256: String,
    pending_inference_persisted_at: Option<String>,
    pending_inference_origin: Option<PendingInferenceOrigin>,
    last_retry_binding: Option<ProviderRetryBinding>,
    last_retry_binding_sha256: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAgentLoopRequest {
    pub invocation_id: String,
    pub request: ToolRequest,
}

pub struct AgentLoopJournalRepository<'a> {
    journal: &'a mut EventJournal,
}

impl<'a> AgentLoopJournalRepository<'a> {
    pub const fn new(journal: &'a mut EventJournal) -> Self {
        Self { journal }
    }

    pub fn create(
        &mut self,
        service: &AgentLoopService,
        command_key: &str,
        metadata: AgentLoopEventMetadata<'_>,
    ) -> Result<AgentLoopRecord, AgentLoopJournalError> {
        require_metadata(command_key, metadata)?;
        let identity = service.identity();
        let run_id = identity.run_id.to_string();
        let invocation_id = identity.invocation_id.as_str();
        let checkpoint = service.checkpoint()?;
        let existing = self
            .journal
            .read_aggregate(&run_id, AGGREGATE_TYPE, invocation_id, 0)?;
        if !existing.is_empty() {
            let recovered = replay(&run_id, invocation_id, &existing)?;
            if existing[0].idempotency_key == command_key && recovered.service == *service {
                return Ok(recovered);
            }
            return Err(AgentLoopJournalError::IdentityConflict);
        }
        let payload = payload(
            None,
            service.phase(),
            checkpoint,
            DirectiveKind::Created,
            service,
        )?;
        let stored = self.journal.append(
            event(
                &run_id,
                invocation_id,
                command_key,
                metadata,
                "agent_loop.created",
                payload,
            ),
            current_run_sequence(self.journal, &run_id)?,
            0,
        )?;
        record_from_event(service.clone(), &stored)
    }

    pub fn append_transition(
        &mut self,
        previous: &AgentLoopService,
        current: &AgentLoopService,
        directive: &AgentLoopDirective,
        command_key: &str,
        metadata: AgentLoopEventMetadata<'_>,
    ) -> Result<AgentLoopRecord, AgentLoopJournalError> {
        self.append_with_kind(
            previous,
            current,
            directive_kind(directive),
            command_key,
            metadata,
        )
    }

    pub fn append_state_transition(
        &mut self,
        previous: &AgentLoopService,
        current: &AgentLoopService,
        transition: StateTransitionKind,
        command_key: &str,
        metadata: AgentLoopEventMetadata<'_>,
    ) -> Result<AgentLoopRecord, AgentLoopJournalError> {
        self.append_with_kind(
            previous,
            current,
            match transition {
                StateTransitionKind::InferenceStarted => DirectiveKind::InferenceStarted,
            },
            command_key,
            metadata,
        )
    }

    pub fn append_inference_started(
        &mut self,
        previous: &AgentLoopService,
        current: &AgentLoopService,
        command_key: &str,
        metadata: AgentLoopEventMetadata<'_>,
    ) -> Result<AgentLoopRecord, AgentLoopJournalError> {
        if previous.phase() != LoopPhase::AwaitingInferenceStart
            || current.phase() != LoopPhase::AwaitingProvider
        {
            return Err(AgentLoopJournalError::TransitionInvalid);
        }
        self.append_state_transition(
            previous,
            current,
            StateTransitionKind::InferenceStarted,
            command_key,
            metadata,
        )
    }

    pub fn append_inference_retried(
        &mut self,
        previous: &AgentLoopService,
        current: &AgentLoopService,
        binding: &ProviderRetryBinding,
        command_key: &str,
        metadata: AgentLoopEventMetadata<'_>,
    ) -> Result<AgentLoopRecord, AgentLoopJournalError> {
        require_metadata(command_key, metadata)?;
        if previous.identity() != current.identity()
            || previous.phase() != LoopPhase::AwaitingProvider
            || current.phase() != LoopPhase::AwaitingProvider
        {
            return Err(AgentLoopJournalError::TransitionInvalid);
        }
        validate_inference_retry_transition(previous, binding)?;
        let mut expected = previous.clone();
        expected.acknowledge_inference_retry(binding)?;
        if expected != *current {
            return Err(AgentLoopJournalError::TransitionInvalid);
        }

        let identity = current.identity();
        let run_id = identity.run_id.to_string();
        let invocation_id = identity.invocation_id.as_str();
        let events = self
            .journal
            .read_aggregate(&run_id, AGGREGATE_TYPE, invocation_id, 0)?;
        let recovered = replay(&run_id, invocation_id, &events)?;
        if let Some(existing) = events
            .iter()
            .find(|event| event.idempotency_key == command_key)
        {
            let existing_payload: EventPayload = serde_json::from_value(existing.payload.clone())?;
            if existing_payload.checkpoint == current.checkpoint()?
                && existing_payload.directive_kind == DirectiveKind::InferenceRetried
                && existing_payload.retry_binding.as_ref() == Some(binding)
            {
                return Ok(recovered);
            }
            return Err(AgentLoopJournalError::Journal(
                EventJournalError::IdempotencyConflict {
                    idempotency_key: command_key.to_owned(),
                },
            ));
        }
        if recovered.service != *previous {
            return Err(AgentLoopJournalError::StaleCheckpoint);
        }
        let checkpoint = current.checkpoint()?;
        let payload = payload_with_retry_binding(
            Some(previous.phase()),
            current.phase(),
            checkpoint,
            DirectiveKind::InferenceRetried,
            current,
            Some(binding.clone()),
        )?;
        let stored = self.journal.append(
            event(
                &run_id,
                invocation_id,
                command_key,
                metadata,
                "agent_loop.inference_retried",
                payload,
            ),
            current_run_sequence(self.journal, &run_id)?,
            recovered.aggregate_sequence,
        )?;
        record_from_event(current.clone(), &stored)
    }

    fn append_with_kind(
        &mut self,
        previous: &AgentLoopService,
        current: &AgentLoopService,
        kind: DirectiveKind,
        command_key: &str,
        metadata: AgentLoopEventMetadata<'_>,
    ) -> Result<AgentLoopRecord, AgentLoopJournalError> {
        require_metadata(command_key, metadata)?;
        if previous.identity() != current.identity() || previous.phase() == current.phase() {
            return Err(AgentLoopJournalError::TransitionInvalid);
        }
        let identity = current.identity();
        let run_id = identity.run_id.to_string();
        let invocation_id = identity.invocation_id.as_str();
        let events = self
            .journal
            .read_aggregate(&run_id, AGGREGATE_TYPE, invocation_id, 0)?;
        let recovered = replay(&run_id, invocation_id, &events)?;
        if let Some(existing) = events
            .iter()
            .find(|event| event.idempotency_key == command_key)
        {
            let existing_payload: EventPayload = serde_json::from_value(existing.payload.clone())?;
            if existing_payload.checkpoint == current.checkpoint()?
                && existing_payload.directive_kind == kind
            {
                return Ok(recovered);
            }
            return Err(AgentLoopJournalError::Journal(
                EventJournalError::IdempotencyConflict {
                    idempotency_key: command_key.to_owned(),
                },
            ));
        }
        if recovered.service != *previous {
            return Err(AgentLoopJournalError::StaleCheckpoint);
        }
        let checkpoint = current.checkpoint()?;
        let payload = payload(
            Some(previous.phase()),
            current.phase(),
            checkpoint,
            kind,
            current,
        )?;
        let stored = self.journal.append(
            event(
                &run_id,
                invocation_id,
                command_key,
                metadata,
                "agent_loop.transitioned",
                payload,
            ),
            current_run_sequence(self.journal, &run_id)?,
            recovered.aggregate_sequence,
        )?;
        record_from_event(current.clone(), &stored)
    }

    pub fn recover(
        &self,
        run_id: &str,
        invocation_id: &str,
    ) -> Result<AgentLoopRecord, AgentLoopJournalError> {
        replay(
            run_id,
            invocation_id,
            &self
                .journal
                .read_aggregate(run_id, AGGREGATE_TYPE, invocation_id, 0)?,
        )
    }

    pub fn recover_provider_authorization_snapshot(
        &self,
        run_id: &str,
        invocation_id: &str,
    ) -> Result<AgentLoopProviderAuthorizationSnapshot, AgentLoopJournalError> {
        let replayed = replay_authoritative(
            run_id,
            invocation_id,
            &self
                .journal
                .read_aggregate(run_id, AGGREGATE_TYPE, invocation_id, 0)?,
        )?;
        let service = &replayed.record.service;
        if service.phase() != LoopPhase::AwaitingProvider {
            return Err(AgentLoopJournalError::ProviderAuthorizationUnavailable);
        }
        let pending_inference = service
            .pending_inference()
            .cloned()
            .ok_or(AgentLoopJournalError::ProviderAuthorizationUnavailable)?;
        validate_authorization_lineage(&pending_inference, replayed.last_retry_binding.as_ref())?;
        let pending_inference_sha256 = hash_pending_inference(&pending_inference)?;
        Ok(AgentLoopProviderAuthorizationSnapshot {
            run_id: service.identity().run_id,
            invocation_id: service.identity().invocation_id.clone(),
            aggregate_sequence: replayed.record.aggregate_sequence,
            checkpoint_sha256: replayed.checkpoint_sha256,
            pending_inference,
            pending_inference_sha256,
            pending_inference_persisted_at: replayed
                .pending_inference_persisted_at
                .ok_or(AgentLoopJournalError::InvalidHistory)?,
            pending_inference_origin: replayed
                .pending_inference_origin
                .ok_or(AgentLoopJournalError::InvalidHistory)?,
            last_retry_binding: replayed.last_retry_binding,
            last_retry_binding_sha256: replayed.last_retry_binding_sha256,
        })
    }

    pub fn recover_if_last_command(
        &self,
        run_id: &str,
        invocation_id: &str,
        command_key: &str,
    ) -> Result<Option<AgentLoopRecord>, AgentLoopJournalError> {
        if command_key.trim().is_empty() {
            return Err(AgentLoopJournalError::MetadataInvalid);
        }
        let events = self
            .journal
            .read_aggregate(run_id, AGGREGATE_TYPE, invocation_id, 0)?;
        if events
            .last()
            .is_some_and(|event| event.idempotency_key == command_key)
        {
            replay(run_id, invocation_id, &events).map(Some)
        } else {
            Ok(None)
        }
    }

    pub fn find_active_for_run(
        &self,
        run_id: &str,
    ) -> Result<Option<AgentLoopRecord>, AgentLoopJournalError> {
        let mut active = None;
        for address in self.journal.list_aggregates(AGGREGATE_TYPE)? {
            if address.run_id != run_id {
                continue;
            }
            let record = self.recover(run_id, &address.aggregate_id)?;
            if record.service.is_active() {
                if active.is_some() {
                    return Err(AgentLoopJournalError::MultipleActiveLoops);
                }
                active = Some(record);
            }
        }
        Ok(active)
    }

    pub fn find_pending_request(
        &self,
        run_id: &str,
        tool_call_id: Uuid,
    ) -> Result<Option<PendingAgentLoopRequest>, AgentLoopJournalError> {
        let mut found = None;
        for address in self.journal.list_aggregates(AGGREGATE_TYPE)? {
            if address.run_id != run_id {
                continue;
            }
            let record = self.recover(run_id, &address.aggregate_id)?;
            if !record.service.is_active() {
                continue;
            }
            if let Some(request) = record.service.pending_request(tool_call_id) {
                if found.is_some() {
                    return Err(AgentLoopJournalError::DuplicatePendingToolCall);
                }
                found = Some(PendingAgentLoopRequest {
                    invocation_id: address.aggregate_id,
                    request: request.clone(),
                });
            }
        }
        Ok(found)
    }
}

#[derive(Debug, Error)]
pub enum AgentLoopJournalError {
    #[error("agent loop event metadata is invalid")]
    MetadataInvalid,
    #[error("agent loop identity conflicts with its aggregate address")]
    IdentityConflict,
    #[error("agent loop event sequence is not contiguous")]
    SequenceGap,
    #[error("agent loop event version {0} is unsupported")]
    UnknownEventVersion(u32),
    #[error("agent loop event history is invalid")]
    InvalidHistory,
    #[error("agent loop event timestamp is not valid RFC 3339")]
    EventTimestampInvalid,
    #[error("agent loop checkpoint hash does not match")]
    CheckpointHashMismatch,
    #[error("agent loop transition is invalid")]
    TransitionInvalid,
    #[error("agent loop transition was based on a stale checkpoint")]
    StaleCheckpoint,
    #[error("more than one active agent loop exists for the run")]
    MultipleActiveLoops,
    #[error("the pending internal tool call id is duplicated")]
    DuplicatePendingToolCall,
    #[error("the agent loop is not awaiting an authorizable Provider inference")]
    ProviderAuthorizationUnavailable,
    #[error(transparent)]
    Loop(#[from] AgentLoopError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventPayload {
    previous_phase: Option<LoopPhase>,
    current_phase: LoopPhase,
    checkpoint: Value,
    checkpoint_sha256: String,
    directive_kind: DirectiveKind,
    pending_tool_call_ids: Vec<Uuid>,
    #[serde(default)]
    retry_binding: Option<ProviderRetryBinding>,
    #[serde(default)]
    retry_binding_sha256: Option<String>,
}

fn payload(
    previous_phase: Option<LoopPhase>,
    current_phase: LoopPhase,
    checkpoint: Value,
    directive_kind: DirectiveKind,
    service: &AgentLoopService,
) -> Result<EventPayload, AgentLoopJournalError> {
    payload_with_retry_binding(
        previous_phase,
        current_phase,
        checkpoint,
        directive_kind,
        service,
        None,
    )
}

fn payload_with_retry_binding(
    previous_phase: Option<LoopPhase>,
    current_phase: LoopPhase,
    checkpoint: Value,
    directive_kind: DirectiveKind,
    service: &AgentLoopService,
    retry_binding: Option<ProviderRetryBinding>,
) -> Result<EventPayload, AgentLoopJournalError> {
    let retry_binding_sha256 = retry_binding.as_ref().map(hash_retry_binding).transpose()?;
    Ok(EventPayload {
        previous_phase,
        current_phase,
        checkpoint_sha256: hash_checkpoint(&checkpoint)?,
        checkpoint,
        directive_kind,
        pending_tool_call_ids: service
            .pending_requests()
            .iter()
            .map(|request| request.tool_call_id)
            .collect(),
        retry_binding,
        retry_binding_sha256,
    })
}

fn replay(
    run_id: &str,
    invocation_id: &str,
    events: &[RuntimeEvent],
) -> Result<AgentLoopRecord, AgentLoopJournalError> {
    replay_authoritative(run_id, invocation_id, events).map(|replayed| replayed.record)
}

fn replay_authoritative(
    run_id: &str,
    invocation_id: &str,
    events: &[RuntimeEvent],
) -> Result<AuthoritativeReplay, AgentLoopJournalError> {
    if events.is_empty() {
        return Err(AgentLoopJournalError::InvalidHistory);
    }
    let mut previous_service: Option<AgentLoopService> = None;
    let mut last_checkpoint_sha256 = None;
    let mut pending_inference_persisted_at = None;
    let mut pending_inference_origin = None;
    let mut last_retry_binding = None;
    let mut last_retry_binding_sha256 = None;
    for (index, event) in events.iter().enumerate() {
        validate_timestamp(&event.created_at)?;
        if event.run_id != run_id
            || event.aggregate_type != AGGREGATE_TYPE
            || event.aggregate_id != invocation_id
        {
            return Err(AgentLoopJournalError::IdentityConflict);
        }
        let expected_sequence =
            u64::try_from(index).map_err(|_| AgentLoopJournalError::SequenceGap)? + 1;
        if event.aggregate_sequence != expected_sequence {
            return Err(AgentLoopJournalError::SequenceGap);
        }
        if event.event_version != EVENT_VERSION {
            return Err(AgentLoopJournalError::UnknownEventVersion(
                event.event_version,
            ));
        }
        let payload: EventPayload = serde_json::from_value(event.payload.clone())?;
        if hash_checkpoint(&payload.checkpoint)? != payload.checkpoint_sha256 {
            return Err(AgentLoopJournalError::CheckpointHashMismatch);
        }
        let service = AgentLoopService::restore(payload.checkpoint.clone())?;
        if service.identity().run_id.to_string() != run_id
            || service.identity().invocation_id != invocation_id
            || service.phase() != payload.current_phase
            || pending_ids(&service) != payload.pending_tool_call_ids
        {
            return Err(AgentLoopJournalError::IdentityConflict);
        }
        if !directive_matches_phase(payload.directive_kind, service.phase()) {
            return Err(AgentLoopJournalError::TransitionInvalid);
        }
        if index == 0 {
            if event.event_type != "agent_loop.created"
                || payload.previous_phase.is_some()
                || payload.directive_kind != DirectiveKind::Created
                || payload.retry_binding.is_some()
                || payload.retry_binding_sha256.is_some()
                || service.phase() != LoopPhase::AwaitingProvider
            {
                return Err(AgentLoopJournalError::InvalidHistory);
            }
            pending_inference_persisted_at = Some(event.created_at.clone());
            pending_inference_origin = Some(PendingInferenceOrigin::Created);
            last_retry_binding = None;
            last_retry_binding_sha256 = None;
        } else {
            let previous = previous_service
                .as_ref()
                .ok_or(AgentLoopJournalError::InvalidHistory)?;
            if payload.directive_kind == DirectiveKind::InferenceRetried {
                let binding = payload
                    .retry_binding
                    .as_ref()
                    .ok_or(AgentLoopJournalError::TransitionInvalid)?;
                if payload.retry_binding_sha256.as_deref()
                    != Some(hash_retry_binding(binding)?.as_str())
                {
                    return Err(AgentLoopJournalError::CheckpointHashMismatch);
                }
                if event.event_type != "agent_loop.inference_retried"
                    || payload.previous_phase != Some(LoopPhase::AwaitingProvider)
                    || previous.phase() != LoopPhase::AwaitingProvider
                    || service.phase() != LoopPhase::AwaitingProvider
                {
                    return Err(AgentLoopJournalError::TransitionInvalid);
                }
                validate_inference_retry_transition(previous, binding)?;
                let mut expected = previous.clone();
                expected.acknowledge_inference_retry(binding)?;
                if expected != service {
                    return Err(AgentLoopJournalError::TransitionInvalid);
                }
                pending_inference_persisted_at = Some(event.created_at.clone());
                pending_inference_origin = Some(PendingInferenceOrigin::InferenceRetried);
                last_retry_binding = Some(binding.clone());
                last_retry_binding_sha256 = payload.retry_binding_sha256.clone();
            } else if event.event_type != "agent_loop.transitioned"
                || payload.retry_binding.is_some()
                || payload.retry_binding_sha256.is_some()
                || payload.previous_phase != Some(previous.phase())
                || previous.phase() == service.phase()
            {
                return Err(AgentLoopJournalError::TransitionInvalid);
            } else {
                pending_inference_persisted_at =
                    if payload.directive_kind == DirectiveKind::InferenceStarted {
                        Some(event.created_at.clone())
                    } else {
                        None
                    };
                pending_inference_origin =
                    if payload.directive_kind == DirectiveKind::InferenceStarted {
                        Some(PendingInferenceOrigin::InferenceStarted)
                    } else {
                        None
                    };
                last_retry_binding = None;
                last_retry_binding_sha256 = None;
            }
        }
        last_checkpoint_sha256 = Some(payload.checkpoint_sha256);
        previous_service = Some(service);
    }
    let last = events.last().ok_or(AgentLoopJournalError::InvalidHistory)?;
    let service = previous_service.ok_or(AgentLoopJournalError::InvalidHistory)?;
    if service.phase() == LoopPhase::AwaitingProvider {
        let pending = service
            .pending_inference()
            .ok_or(AgentLoopJournalError::InvalidHistory)?;
        validate_authorization_lineage(pending, last_retry_binding.as_ref())?;
    }
    Ok(AuthoritativeReplay {
        record: AgentLoopRecord {
            service,
            aggregate_sequence: last.aggregate_sequence,
            last_run_sequence: last.run_sequence,
            updated_at: last.created_at.clone(),
        },
        checkpoint_sha256: last_checkpoint_sha256.ok_or(AgentLoopJournalError::InvalidHistory)?,
        pending_inference_persisted_at,
        pending_inference_origin,
        last_retry_binding,
        last_retry_binding_sha256,
    })
}

fn directive_kind(directive: &AgentLoopDirective) -> DirectiveKind {
    match directive {
        AgentLoopDirective::ExecuteTools(_) => DirectiveKind::ExecuteTools,
        AgentLoopDirective::AwaitApproval(_) => DirectiveKind::AwaitApproval,
        AgentLoopDirective::CompileContext(_) => DirectiveKind::CompileContext,
        AgentLoopDirective::StartInference(_) => DirectiveKind::StartInference,
        AgentLoopDirective::Completed { .. } => DirectiveKind::Completed,
        AgentLoopDirective::Cancelled { .. } => DirectiveKind::Cancelled,
    }
}

fn directive_matches_phase(kind: DirectiveKind, phase: LoopPhase) -> bool {
    matches!(
        (kind, phase),
        (DirectiveKind::Created, LoopPhase::AwaitingProvider)
            | (DirectiveKind::ExecuteTools, LoopPhase::AwaitingToolResults)
            | (DirectiveKind::AwaitApproval, LoopPhase::AwaitingApproval)
            | (
                DirectiveKind::CompileContext,
                LoopPhase::AwaitingContextCompilation
            )
            | (
                DirectiveKind::StartInference,
                LoopPhase::AwaitingInferenceStart
            )
            | (DirectiveKind::Completed, LoopPhase::Completed)
            | (DirectiveKind::Cancelled, LoopPhase::Cancelled)
            | (DirectiveKind::InferenceStarted, LoopPhase::AwaitingProvider)
            | (DirectiveKind::InferenceRetried, LoopPhase::AwaitingProvider)
    )
}

fn pending_ids(service: &AgentLoopService) -> Vec<Uuid> {
    service
        .pending_requests()
        .iter()
        .map(|request| request.tool_call_id)
        .collect()
}

fn hash_checkpoint(checkpoint: &Value) -> Result<String, serde_json::Error> {
    serde_json::to_vec(checkpoint).map(|bytes| format!("{:x}", Sha256::digest(bytes)))
}

fn hash_retry_binding(binding: &ProviderRetryBinding) -> Result<String, serde_json::Error> {
    serde_json::to_vec(binding).map(|bytes| format!("{:x}", Sha256::digest(bytes)))
}

fn hash_pending_inference(
    pending: &InferenceDispatchIdentity,
) -> Result<String, serde_json::Error> {
    canonical_serialized_sha256(pending)
}

fn canonical_serialized_sha256<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    canonical_value_sha256(&serde_json::to_value(value)?)
}

fn canonical_value_sha256(value: &Value) -> Result<String, serde_json::Error> {
    fn canonicalize(value: Value) -> Value {
        match value {
            Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
            Value::Object(values) => {
                let mut entries = values.into_iter().collect::<Vec<_>>();
                entries.sort_by(|left, right| left.0.cmp(&right.0));
                Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key, canonicalize(value)))
                        .collect(),
                )
            }
            scalar => scalar,
        }
    }
    serde_json::to_vec(&canonicalize(value.clone()))
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
}

fn validate_authorization_lineage(
    pending: &InferenceDispatchIdentity,
    last_retry_binding: Option<&ProviderRetryBinding>,
) -> Result<(), AgentLoopJournalError> {
    match (pending.attempt_number, last_retry_binding) {
        (1, None) => Ok(()),
        (attempt, Some(binding)) if attempt > 1 && binding.next == *pending => Ok(()),
        _ => Err(AgentLoopJournalError::InvalidHistory),
    }
}

fn current_run_sequence(journal: &EventJournal, run_id: &str) -> Result<u64, EventJournalError> {
    Ok(journal
        .read_run(run_id, 0)?
        .last()
        .map_or(0, |event| event.run_sequence))
}

fn record_from_event(
    service: AgentLoopService,
    event: &RuntimeEvent,
) -> Result<AgentLoopRecord, AgentLoopJournalError> {
    Ok(AgentLoopRecord {
        service,
        aggregate_sequence: event.aggregate_sequence,
        last_run_sequence: event.run_sequence,
        updated_at: event.created_at.clone(),
    })
}

fn event(
    run_id: &str,
    invocation_id: &str,
    command_key: &str,
    metadata: AgentLoopEventMetadata<'_>,
    event_type: &str,
    payload: EventPayload,
) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: AGGREGATE_TYPE.to_owned(),
        aggregate_id: invocation_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: command_key.to_owned(),
        event_type: event_type.to_owned(),
        event_version: EVENT_VERSION,
        payload: serde_json::to_value(payload).unwrap_or_else(|_| unreachable!()),
        created_at: metadata.created_at.to_owned(),
    }
}

fn require_metadata(
    command_key: &str,
    metadata: AgentLoopEventMetadata<'_>,
) -> Result<(), AgentLoopJournalError> {
    if command_key.trim().is_empty()
        || metadata.message_id.trim().is_empty()
        || metadata.created_at.trim().is_empty()
    {
        return Err(AgentLoopJournalError::MetadataInvalid);
    }
    validate_timestamp(metadata.created_at)?;
    Ok(())
}

fn validate_timestamp(value: &str) -> Result<(), AgentLoopJournalError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map(|_| ())
        .map_err(|_| AgentLoopJournalError::EventTimestampInvalid)
}
