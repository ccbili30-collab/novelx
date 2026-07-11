use serde_json::{Value, json};
use thiserror::Error;

use crate::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent, RuntimeEvent};
use crate::run_state::{RunState, RunStateMachine, TransitionError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunAggregate {
    run_id: String,
    machine: RunStateMachine,
    last_sequence: u64,
}

pub struct EventMetadata<'a> {
    pub message_id: &'a str,
    pub created_at: &'a str,
    pub reason: Option<&'a str>,
}

impl RunAggregate {
    pub fn create(
        journal: &mut EventJournal,
        run_id: &str,
        metadata: EventMetadata<'_>,
    ) -> Result<Self, RunAggregateError> {
        let event = transition_event(run_id, metadata, "run.created", None, RunState::Created);
        let stored = journal.append_after(event, 0)?;
        Ok(Self {
            run_id: run_id.to_owned(),
            machine: RunStateMachine::new(),
            last_sequence: stored.sequence,
        })
    }

    pub fn recover(journal: &EventJournal, run_id: &str) -> Result<Self, RunAggregateError> {
        let events = journal.read_run(run_id)?;
        replay(run_id, &events)
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn state(&self) -> RunState {
        self.machine.state()
    }

    pub const fn last_sequence(&self) -> u64 {
        self.last_sequence
    }

    pub fn prepare(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        self.apply(journal, metadata, RunState::Preparing)
    }

    pub fn start(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        self.apply(journal, metadata, RunState::Running)
    }

    pub fn wait_for_approval(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        self.apply(journal, metadata, RunState::WaitingForApproval)
    }

    pub fn begin_commit(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        self.apply(journal, metadata, RunState::Committing)
    }

    pub fn retry(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        self.apply(journal, metadata, RunState::Retrying)
    }

    pub fn block(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        self.apply(journal, metadata, RunState::Blocked)
    }

    pub fn cancel(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        self.apply(journal, metadata, RunState::Cancelled)
    }

    pub fn fail(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        self.apply(journal, metadata, RunState::Failed)
    }

    pub fn complete(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        self.apply(journal, metadata, RunState::Completed)
    }

    fn apply(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
        target: RunState,
    ) -> Result<(), RunAggregateError> {
        let previous = self.machine.state();
        let mut candidate = self.machine;
        transition_machine(&mut candidate, target)?;
        let stored = journal.append_after(
            transition_event(
                &self.run_id,
                metadata,
                event_type(target),
                Some(previous),
                target,
            ),
            self.last_sequence,
        )?;
        self.machine = candidate;
        self.last_sequence = stored.sequence;
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum RunAggregateError {
    #[error("run `{0}` has no run.created event")]
    NotFound(String),
    #[error("run event sequence is not contiguous: expected {expected}, actual {actual}")]
    SequenceGap { expected: u64, actual: u64 },
    #[error("unknown run event type `{0}`")]
    UnknownEvent(String),
    #[error("run.created must be the first and only creation event")]
    DuplicateCreated,
    #[error("run event payload is invalid")]
    InvalidPayload,
    #[error("run event state does not match aggregate state")]
    StateMismatch,
    #[error(transparent)]
    Transition(#[from] TransitionError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
}

fn replay(run_id: &str, events: &[RuntimeEvent]) -> Result<RunAggregate, RunAggregateError> {
    let first = events
        .first()
        .ok_or_else(|| RunAggregateError::NotFound(run_id.to_owned()))?;
    if first.sequence != 1 {
        return Err(RunAggregateError::SequenceGap {
            expected: 1,
            actual: first.sequence,
        });
    }
    let payload = parse_payload(&first.payload)?;
    if first.event_type != "run.created"
        || payload.previous.is_some()
        || payload.current != RunState::Created
    {
        return Err(RunAggregateError::InvalidPayload);
    }
    let mut aggregate = RunAggregate {
        run_id: run_id.to_owned(),
        machine: RunStateMachine::new(),
        last_sequence: 1,
    };
    for event in &events[1..] {
        let expected = aggregate.last_sequence + 1;
        if event.sequence != expected {
            return Err(RunAggregateError::SequenceGap {
                expected,
                actual: event.sequence,
            });
        }
        if event.event_type == "run.created" {
            return Err(RunAggregateError::DuplicateCreated);
        }
        let target = state_for_event(&event.event_type)?;
        let payload = parse_payload(&event.payload)?;
        if payload.previous != Some(aggregate.machine.state()) || payload.current != target {
            return Err(RunAggregateError::StateMismatch);
        }
        transition_machine(&mut aggregate.machine, target)?;
        aggregate.last_sequence = event.sequence;
    }
    Ok(aggregate)
}

struct TransitionPayload {
    previous: Option<RunState>,
    current: RunState,
}

fn parse_payload(value: &Value) -> Result<TransitionPayload, RunAggregateError> {
    let object = value.as_object().ok_or(RunAggregateError::InvalidPayload)?;
    if object.len() != 3
        || !object.contains_key("previousState")
        || !object.contains_key("currentState")
        || !object.contains_key("reason")
    {
        return Err(RunAggregateError::InvalidPayload);
    }
    let reason = &object["reason"];
    if !reason.is_null() && !reason.is_string() {
        return Err(RunAggregateError::InvalidPayload);
    }
    let previous = match &object["previousState"] {
        Value::Null => None,
        Value::String(value) => Some(parse_state(value)?),
        _ => return Err(RunAggregateError::InvalidPayload),
    };
    let current = object["currentState"]
        .as_str()
        .ok_or(RunAggregateError::InvalidPayload)
        .and_then(parse_state)?;
    Ok(TransitionPayload { previous, current })
}

fn transition_event(
    run_id: &str,
    metadata: EventMetadata<'_>,
    event_type: &str,
    previous: Option<RunState>,
    current: RunState,
) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: run_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        event_type: event_type.to_owned(),
        payload: json!({
            "previousState": previous.map(state_name),
            "currentState": state_name(current),
            "reason": metadata.reason,
        }),
        created_at: metadata.created_at.to_owned(),
    }
}

fn transition_machine(
    machine: &mut RunStateMachine,
    target: RunState,
) -> Result<(), TransitionError> {
    match target {
        RunState::Created => unreachable!("creation is handled separately"),
        RunState::Preparing => machine.prepare(),
        RunState::Running => machine.start(),
        RunState::WaitingForApproval => machine.wait_for_approval(),
        RunState::Committing => machine.begin_commit(),
        RunState::Retrying => machine.retry(),
        RunState::Blocked => machine.block(),
        RunState::Cancelled => machine.cancel(),
        RunState::Failed => machine.fail(),
        RunState::Completed => machine.complete(),
    }
}

fn event_type(state: RunState) -> &'static str {
    match state {
        RunState::Created => "run.created",
        RunState::Preparing => "run.preparing",
        RunState::Running => "run.running",
        RunState::WaitingForApproval => "run.waiting_for_approval",
        RunState::Committing => "run.committing",
        RunState::Retrying => "run.retrying",
        RunState::Blocked => "run.blocked",
        RunState::Cancelled => "run.cancelled",
        RunState::Failed => "run.failed",
        RunState::Completed => "run.completed",
    }
}

fn state_for_event(value: &str) -> Result<RunState, RunAggregateError> {
    match value {
        "run.preparing" => Ok(RunState::Preparing),
        "run.running" => Ok(RunState::Running),
        "run.waiting_for_approval" => Ok(RunState::WaitingForApproval),
        "run.committing" => Ok(RunState::Committing),
        "run.retrying" => Ok(RunState::Retrying),
        "run.blocked" => Ok(RunState::Blocked),
        "run.cancelled" => Ok(RunState::Cancelled),
        "run.failed" => Ok(RunState::Failed),
        "run.completed" => Ok(RunState::Completed),
        other => Err(RunAggregateError::UnknownEvent(other.to_owned())),
    }
}

fn state_name(state: RunState) -> &'static str {
    match state {
        RunState::Created => "created",
        RunState::Preparing => "preparing",
        RunState::Running => "running",
        RunState::WaitingForApproval => "waiting_for_approval",
        RunState::Committing => "committing",
        RunState::Retrying => "retrying",
        RunState::Blocked => "blocked",
        RunState::Cancelled => "cancelled",
        RunState::Failed => "failed",
        RunState::Completed => "completed",
    }
}

fn parse_state(value: &str) -> Result<RunState, RunAggregateError> {
    match value {
        "created" => Ok(RunState::Created),
        "preparing" => Ok(RunState::Preparing),
        "running" => Ok(RunState::Running),
        "waiting_for_approval" => Ok(RunState::WaitingForApproval),
        "committing" => Ok(RunState::Committing),
        "retrying" => Ok(RunState::Retrying),
        "blocked" => Ok(RunState::Blocked),
        "cancelled" => Ok(RunState::Cancelled),
        "failed" => Ok(RunState::Failed),
        "completed" => Ok(RunState::Completed),
        _ => Err(RunAggregateError::InvalidPayload),
    }
}
