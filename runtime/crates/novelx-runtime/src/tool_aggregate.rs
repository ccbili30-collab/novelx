use serde_json::{Map, Value, json};
use thiserror::Error;

use crate::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent, RuntimeEvent};
use crate::tool_state::{
    ToolAuthorization, ToolCallStateMachine, ToolOutcomeKnowledge, ToolRetryError, ToolSideEffect,
    ToolState, ToolTransitionError,
};

const AGGREGATE_TYPE: &str = "tool";
const EVENT_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolCallDefinition {
    pub provider_tool_call_id: String,
    pub tool_name: String,
    pub schema_version: u32,
    pub arguments_hash: String,
    pub attempt: u32,
    pub side_effect: ToolSideEffect,
    pub parallel: bool,
}

pub struct ToolEventMetadata<'a> {
    pub message_id: &'a str,
    pub idempotency_key: &'a str,
    pub created_at: &'a str,
    pub reason: Option<&'a str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolCallAggregate {
    run_id: String,
    tool_call_id: String,
    definition: ToolCallDefinition,
    machine: ToolCallStateMachine,
    aggregate_sequence: u64,
    outcome_knowledge: Option<ToolOutcomeKnowledge>,
}

impl ToolCallAggregate {
    pub fn create(
        journal: &mut EventJournal,
        run_id: &str,
        tool_call_id: &str,
        definition: ToolCallDefinition,
        expected_run_sequence: u64,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<Self, ToolAggregateError> {
        validate_definition(&definition)?;
        let machine = configured_machine(&definition);
        let event = tool_event(
            run_id,
            tool_call_id,
            &definition,
            metadata,
            ToolEventDraft {
                event_type: "tool.requested",
                previous: None,
                machine: &machine,
                outcome: None,
            },
        );
        let stored = journal.append(event, expected_run_sequence, 0)?;
        Ok(Self {
            run_id: run_id.to_owned(),
            tool_call_id: tool_call_id.to_owned(),
            definition,
            machine,
            aggregate_sequence: stored.aggregate_sequence,
            outcome_knowledge: None,
        })
    }

    pub fn recover(
        journal: &EventJournal,
        run_id: &str,
        tool_call_id: &str,
    ) -> Result<Self, ToolAggregateError> {
        let events = journal.read_aggregate(run_id, AGGREGATE_TYPE, tool_call_id, 0)?;
        replay(run_id, tool_call_id, &events)
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn tool_call_id(&self) -> &str {
        &self.tool_call_id
    }

    pub fn definition(&self) -> &ToolCallDefinition {
        &self.definition
    }

    pub const fn state(&self) -> ToolState {
        self.machine.state()
    }

    pub const fn authorization(&self) -> ToolAuthorization {
        self.machine.authorization()
    }

    pub const fn aggregate_sequence(&self) -> u64 {
        self.aggregate_sequence
    }

    pub const fn outcome_knowledge(&self) -> Option<ToolOutcomeKnowledge> {
        self.outcome_knowledge
    }

    pub fn require_authorization(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<(), ToolAggregateError> {
        self.apply(
            journal,
            expected_run_sequence,
            metadata,
            "tool.authorization_required",
            None,
            |machine| machine.require_approval(),
        )
    }

    pub fn authorize(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<(), ToolAggregateError> {
        let approval_required = self.machine.authorization() == ToolAuthorization::ApprovalRequired;
        self.apply(
            journal,
            expected_run_sequence,
            metadata,
            "tool.authorized",
            None,
            move |machine| {
                if approval_required {
                    machine.approve()
                } else {
                    machine.allow()
                }
            },
        )
    }

    pub fn start(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<(), ToolAggregateError> {
        self.apply(
            journal,
            expected_run_sequence,
            metadata,
            "tool.started",
            None,
            |machine| machine.start(),
        )
    }

    pub fn complete(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<(), ToolAggregateError> {
        self.apply(
            journal,
            expected_run_sequence,
            metadata,
            "tool.completed",
            Some(ToolOutcomeKnowledge::Known),
            |machine| machine.complete(),
        )
    }

    pub fn fail(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        outcome: ToolOutcomeKnowledge,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<(), ToolAggregateError> {
        self.apply(
            journal,
            expected_run_sequence,
            metadata,
            "tool.failed",
            Some(outcome),
            |machine| machine.fail(),
        )
    }

    pub fn deny(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<(), ToolAggregateError> {
        self.apply(
            journal,
            expected_run_sequence,
            metadata,
            "tool.denied",
            None,
            |machine| machine.deny(),
        )
    }

    pub fn cancel(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<(), ToolAggregateError> {
        self.apply(
            journal,
            expected_run_sequence,
            metadata,
            "tool.cancelled",
            None,
            |machine| machine.cancel(),
        )
    }

    pub fn time_out(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        outcome: ToolOutcomeKnowledge,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<(), ToolAggregateError> {
        self.apply(
            journal,
            expected_run_sequence,
            metadata,
            "tool.timed_out",
            Some(outcome),
            |machine| machine.time_out(),
        )
    }

    pub fn ensure_auto_retry_allowed(&self) -> Result<(), ToolRetryError> {
        self.machine.ensure_auto_retry_allowed(
            self.outcome_knowledge
                .unwrap_or(ToolOutcomeKnowledge::Unknown),
        )
    }

    fn apply<F>(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        metadata: ToolEventMetadata<'_>,
        event_type: &str,
        outcome: Option<ToolOutcomeKnowledge>,
        transition: F,
    ) -> Result<(), ToolAggregateError>
    where
        F: FnOnce(&mut ToolCallStateMachine) -> Result<(), ToolTransitionError>,
    {
        let previous = self.machine.state();
        let mut candidate = self.machine;
        transition(&mut candidate)?;
        let stored = journal.append(
            tool_event(
                &self.run_id,
                &self.tool_call_id,
                &self.definition,
                metadata,
                ToolEventDraft {
                    event_type,
                    previous: Some(previous),
                    machine: &candidate,
                    outcome,
                },
            ),
            expected_run_sequence,
            self.aggregate_sequence,
        )?;
        self.machine = candidate;
        self.aggregate_sequence = stored.aggregate_sequence;
        self.outcome_knowledge = outcome;
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum ToolAggregateError {
    #[error("tool call `{0}` has no tool.requested event")]
    NotFound(String),
    #[error("tool event sequence is not contiguous: expected {expected}, actual {actual}")]
    SequenceGap { expected: u64, actual: u64 },
    #[error("unsupported tool event version {0}")]
    UnknownEventVersion(u32),
    #[error("unknown tool event type `{0}`")]
    UnknownEvent(String),
    #[error("tool.requested must be the first and only creation event")]
    DuplicateRequested,
    #[error("tool event payload is invalid")]
    InvalidPayload,
    #[error("tool event payload does not match aggregate identity or state")]
    StateMismatch,
    #[error(transparent)]
    Transition(#[from] ToolTransitionError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
}

fn replay(
    run_id: &str,
    tool_call_id: &str,
    events: &[RuntimeEvent],
) -> Result<ToolCallAggregate, ToolAggregateError> {
    let first = events
        .first()
        .ok_or_else(|| ToolAggregateError::NotFound(tool_call_id.to_owned()))?;
    validate_event_address(first, run_id, tool_call_id, 1)?;
    if first.event_version != EVENT_VERSION {
        return Err(ToolAggregateError::UnknownEventVersion(first.event_version));
    }
    if first.event_type != "tool.requested" {
        return Err(ToolAggregateError::InvalidPayload);
    }
    let payload = parse_payload(&first.payload)?;
    let definition = payload.definition();
    validate_definition(&definition)?;
    let machine = configured_machine(&definition);
    if payload.previous.is_some()
        || payload.current != ToolState::Requested
        || payload.authorization != ToolAuthorization::Pending
        || payload.outcome_knowledge.is_some()
    {
        return Err(ToolAggregateError::StateMismatch);
    }
    let mut aggregate = ToolCallAggregate {
        run_id: run_id.to_owned(),
        tool_call_id: tool_call_id.to_owned(),
        definition,
        machine,
        aggregate_sequence: 1,
        outcome_knowledge: None,
    };

    for event in &events[1..] {
        let expected = aggregate.aggregate_sequence + 1;
        validate_event_address(event, run_id, tool_call_id, expected)?;
        if event.event_version != EVENT_VERSION {
            return Err(ToolAggregateError::UnknownEventVersion(event.event_version));
        }
        if event.event_type == "tool.requested" {
            return Err(ToolAggregateError::DuplicateRequested);
        }
        let payload = parse_payload(&event.payload)?;
        if payload.definition() != aggregate.definition
            || payload.previous != Some(aggregate.machine.state())
        {
            return Err(ToolAggregateError::StateMismatch);
        }
        let mut candidate = aggregate.machine;
        replay_transition(&mut candidate, &event.event_type)?;
        if payload.current != candidate.state()
            || payload.authorization != candidate.authorization()
            || !outcome_is_valid(candidate.state(), payload.outcome_knowledge)
        {
            return Err(ToolAggregateError::StateMismatch);
        }
        aggregate.machine = candidate;
        aggregate.aggregate_sequence = event.aggregate_sequence;
        aggregate.outcome_knowledge = payload.outcome_knowledge;
    }
    Ok(aggregate)
}

fn replay_transition(
    machine: &mut ToolCallStateMachine,
    event_type: &str,
) -> Result<(), ToolAggregateError> {
    match event_type {
        "tool.authorization_required" => machine.require_approval()?,
        "tool.authorized" => {
            if machine.authorization() == ToolAuthorization::ApprovalRequired {
                machine.approve()?;
            } else {
                machine.allow()?;
            }
        }
        "tool.started" => machine.start()?,
        "tool.completed" => machine.complete()?,
        "tool.failed" => machine.fail()?,
        "tool.denied" => machine.deny()?,
        "tool.cancelled" => machine.cancel()?,
        "tool.timed_out" => machine.time_out()?,
        other => return Err(ToolAggregateError::UnknownEvent(other.to_owned())),
    }
    Ok(())
}

fn validate_event_address(
    event: &RuntimeEvent,
    run_id: &str,
    tool_call_id: &str,
    expected_sequence: u64,
) -> Result<(), ToolAggregateError> {
    if event.aggregate_sequence != expected_sequence {
        return Err(ToolAggregateError::SequenceGap {
            expected: expected_sequence,
            actual: event.aggregate_sequence,
        });
    }
    if event.run_id != run_id
        || event.aggregate_type != AGGREGATE_TYPE
        || event.aggregate_id != tool_call_id
    {
        return Err(ToolAggregateError::StateMismatch);
    }
    Ok(())
}

fn validate_definition(definition: &ToolCallDefinition) -> Result<(), ToolAggregateError> {
    if definition.provider_tool_call_id.trim().is_empty()
        || definition.tool_name.trim().is_empty()
        || !is_sha256(&definition.arguments_hash)
        || definition.schema_version == 0
        || definition.attempt == 0
    {
        return Err(ToolAggregateError::InvalidPayload);
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn configured_machine(definition: &ToolCallDefinition) -> ToolCallStateMachine {
    let machine = ToolCallStateMachine::new(definition.side_effect);
    if definition.parallel {
        machine.with_parallel_execution()
    } else {
        machine
    }
}

fn tool_event(
    run_id: &str,
    tool_call_id: &str,
    definition: &ToolCallDefinition,
    metadata: ToolEventMetadata<'_>,
    draft: ToolEventDraft<'_>,
) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: AGGREGATE_TYPE.to_owned(),
        aggregate_id: tool_call_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: metadata.idempotency_key.to_owned(),
        event_type: draft.event_type.to_owned(),
        event_version: EVENT_VERSION,
        payload: json!({
            "previousState": draft.previous.map(state_name),
            "currentState": state_name(draft.machine.state()),
            "authorization": authorization_name(draft.machine.authorization()),
            "sideEffect": side_effect_name(draft.machine.side_effect()),
            "outcomeKnowledge": draft.outcome.map(outcome_name),
            "reason": metadata.reason,
            "providerToolCallId": definition.provider_tool_call_id,
            "toolName": definition.tool_name,
            "schemaVersion": definition.schema_version,
            "argumentsHash": definition.arguments_hash,
            "attempt": definition.attempt,
            "parallel": draft.machine.parallel_execution_allowed(),
        }),
        created_at: metadata.created_at.to_owned(),
    }
}

struct ToolEventDraft<'a> {
    event_type: &'a str,
    previous: Option<ToolState>,
    machine: &'a ToolCallStateMachine,
    outcome: Option<ToolOutcomeKnowledge>,
}

struct ToolPayload {
    previous: Option<ToolState>,
    current: ToolState,
    authorization: ToolAuthorization,
    side_effect: ToolSideEffect,
    outcome_knowledge: Option<ToolOutcomeKnowledge>,
    provider_tool_call_id: String,
    tool_name: String,
    schema_version: u32,
    arguments_hash: String,
    attempt: u32,
    parallel: bool,
}

impl ToolPayload {
    fn definition(&self) -> ToolCallDefinition {
        ToolCallDefinition {
            provider_tool_call_id: self.provider_tool_call_id.clone(),
            tool_name: self.tool_name.clone(),
            schema_version: self.schema_version,
            arguments_hash: self.arguments_hash.clone(),
            attempt: self.attempt,
            side_effect: self.side_effect,
            parallel: self.parallel,
        }
    }
}

fn parse_payload(value: &Value) -> Result<ToolPayload, ToolAggregateError> {
    let object = value
        .as_object()
        .ok_or(ToolAggregateError::InvalidPayload)?;
    const KEYS: [&str; 12] = [
        "previousState",
        "currentState",
        "authorization",
        "sideEffect",
        "outcomeKnowledge",
        "reason",
        "providerToolCallId",
        "toolName",
        "schemaVersion",
        "argumentsHash",
        "attempt",
        "parallel",
    ];
    if object.len() != KEYS.len() || KEYS.iter().any(|key| !object.contains_key(*key)) {
        return Err(ToolAggregateError::InvalidPayload);
    }
    validate_reason(object)?;
    Ok(ToolPayload {
        previous: parse_optional_state(&object["previousState"])?,
        current: parse_state(required_string(object, "currentState")?)?,
        authorization: parse_authorization(required_string(object, "authorization")?)?,
        side_effect: parse_side_effect(required_string(object, "sideEffect")?)?,
        outcome_knowledge: parse_optional_outcome(&object["outcomeKnowledge"])?,
        provider_tool_call_id: required_string(object, "providerToolCallId")?.to_owned(),
        tool_name: required_string(object, "toolName")?.to_owned(),
        schema_version: required_u32(object, "schemaVersion")?,
        arguments_hash: required_string(object, "argumentsHash")?.to_owned(),
        attempt: required_u32(object, "attempt")?,
        parallel: object["parallel"]
            .as_bool()
            .ok_or(ToolAggregateError::InvalidPayload)?,
    })
}

fn validate_reason(object: &Map<String, Value>) -> Result<(), ToolAggregateError> {
    if !object["reason"].is_null() && !object["reason"].is_string() {
        return Err(ToolAggregateError::InvalidPayload);
    }
    Ok(())
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, ToolAggregateError> {
    object[key]
        .as_str()
        .ok_or(ToolAggregateError::InvalidPayload)
}

fn required_u32(object: &Map<String, Value>, key: &str) -> Result<u32, ToolAggregateError> {
    object[key]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(ToolAggregateError::InvalidPayload)
}

fn parse_optional_state(value: &Value) -> Result<Option<ToolState>, ToolAggregateError> {
    match value {
        Value::Null => Ok(None),
        Value::String(value) => parse_state(value).map(Some),
        _ => Err(ToolAggregateError::InvalidPayload),
    }
}

fn parse_optional_outcome(
    value: &Value,
) -> Result<Option<ToolOutcomeKnowledge>, ToolAggregateError> {
    match value {
        Value::Null => Ok(None),
        Value::String(value) => parse_outcome(value).map(Some),
        _ => Err(ToolAggregateError::InvalidPayload),
    }
}

fn outcome_is_valid(state: ToolState, outcome: Option<ToolOutcomeKnowledge>) -> bool {
    match state {
        ToolState::Completed => outcome == Some(ToolOutcomeKnowledge::Known),
        ToolState::Failed | ToolState::TimedOut => outcome.is_some(),
        _ => outcome.is_none(),
    }
}

fn state_name(value: ToolState) -> &'static str {
    match value {
        ToolState::Requested => "requested",
        ToolState::Authorized => "authorized",
        ToolState::Running => "running",
        ToolState::Completed => "completed",
        ToolState::Failed => "failed",
        ToolState::Denied => "denied",
        ToolState::Cancelled => "cancelled",
        ToolState::TimedOut => "timed_out",
    }
}
fn authorization_name(value: ToolAuthorization) -> &'static str {
    match value {
        ToolAuthorization::Pending => "pending",
        ToolAuthorization::Allowed => "allowed",
        ToolAuthorization::ApprovalRequired => "approval_required",
        ToolAuthorization::Denied => "denied",
    }
}
fn side_effect_name(value: ToolSideEffect) -> &'static str {
    match value {
        ToolSideEffect::None => "none",
        ToolSideEffect::StagedWrite => "staged_write",
        ToolSideEffect::ExternalEffect => "external_effect",
    }
}
fn outcome_name(value: ToolOutcomeKnowledge) -> &'static str {
    match value {
        ToolOutcomeKnowledge::Known => "known",
        ToolOutcomeKnowledge::Unknown => "unknown",
    }
}

fn parse_state(value: &str) -> Result<ToolState, ToolAggregateError> {
    match value {
        "requested" => Ok(ToolState::Requested),
        "authorized" => Ok(ToolState::Authorized),
        "running" => Ok(ToolState::Running),
        "completed" => Ok(ToolState::Completed),
        "failed" => Ok(ToolState::Failed),
        "denied" => Ok(ToolState::Denied),
        "cancelled" => Ok(ToolState::Cancelled),
        "timed_out" => Ok(ToolState::TimedOut),
        _ => Err(ToolAggregateError::InvalidPayload),
    }
}
fn parse_authorization(value: &str) -> Result<ToolAuthorization, ToolAggregateError> {
    match value {
        "pending" => Ok(ToolAuthorization::Pending),
        "allowed" => Ok(ToolAuthorization::Allowed),
        "approval_required" => Ok(ToolAuthorization::ApprovalRequired),
        "denied" => Ok(ToolAuthorization::Denied),
        _ => Err(ToolAggregateError::InvalidPayload),
    }
}
fn parse_side_effect(value: &str) -> Result<ToolSideEffect, ToolAggregateError> {
    match value {
        "none" => Ok(ToolSideEffect::None),
        "staged_write" => Ok(ToolSideEffect::StagedWrite),
        "external_effect" => Ok(ToolSideEffect::ExternalEffect),
        _ => Err(ToolAggregateError::InvalidPayload),
    }
}
fn parse_outcome(value: &str) -> Result<ToolOutcomeKnowledge, ToolAggregateError> {
    match value {
        "known" => Ok(ToolOutcomeKnowledge::Known),
        "unknown" => Ok(ToolOutcomeKnowledge::Unknown),
        _ => Err(ToolAggregateError::InvalidPayload),
    }
}
