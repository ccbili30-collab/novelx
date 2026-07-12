use novelx_protocol::{RunPinnedIdentity, RunReconciliationDecision, RuntimeError};
use serde_json::{Value, json};
use thiserror::Error;

use crate::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent, RuntimeEvent};
use crate::run_state::{RunState, RunStateMachine, TransitionError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunAggregate {
    run_id: String,
    pinned_identity: RunPinnedIdentity,
    machine: RunStateMachine,
    last_run_sequence: u64,
    last_aggregate_sequence: u64,
    created_at: String,
    updated_at: String,
    terminal_error: Option<RuntimeError>,
}

pub struct EventMetadata<'a> {
    pub message_id: &'a str,
    pub idempotency_key: &'a str,
    pub created_at: &'a str,
    pub reason: Option<&'a str>,
}

impl RunAggregate {
    pub fn create(
        journal: &mut EventJournal,
        run_id: &str,
        pinned_identity: RunPinnedIdentity,
        metadata: EventMetadata<'_>,
    ) -> Result<Self, RunAggregateError> {
        validate_pinned_identity(&pinned_identity)?;
        let event = creation_event(run_id, &pinned_identity, metadata)?;
        journal.append(event, 0, 0)?;
        Self::recover(journal, run_id)
    }

    pub fn recover(journal: &EventJournal, run_id: &str) -> Result<Self, RunAggregateError> {
        let events = journal.read_aggregate(run_id, "run", run_id, 0)?;
        let last_run_sequence = journal
            .read_run(run_id, 0)?
            .last()
            .map_or(0, |event| event.run_sequence);
        replay(run_id, &events, last_run_sequence)
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn state(&self) -> RunState {
        self.machine.state()
    }

    pub const fn pinned_identity(&self) -> &RunPinnedIdentity {
        &self.pinned_identity
    }

    pub const fn last_sequence(&self) -> u64 {
        self.last_aggregate_sequence
    }

    pub const fn last_run_sequence(&self) -> u64 {
        self.last_run_sequence
    }

    pub fn created_at(&self) -> &str {
        &self.created_at
    }

    pub fn updated_at(&self) -> &str {
        &self.updated_at
    }

    pub const fn terminal_error(&self) -> Option<&RuntimeError> {
        self.terminal_error.as_ref()
    }

    pub fn prepare(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        if self.machine.state() == RunState::Preparing
            && self.is_idempotent_transition(
                journal,
                &metadata,
                "run.preparing",
                RunState::Preparing,
            )?
        {
            return Ok(());
        }
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

    pub fn wait_for_reconciliation(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        self.apply(journal, metadata, RunState::WaitingForReconciliation)
    }

    pub fn request_cancellation_reconciliation(
        &mut self,
        journal: &mut EventJournal,
        attempt_ids: &[String],
        cancellation_reason: &str,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        if attempt_ids.is_empty() || cancellation_reason.trim().is_empty() {
            return Err(RunAggregateError::InvalidPayload);
        }
        let events = journal.read_aggregate(&self.run_id, "run", &self.run_id, 0)?;
        if let Some(existing) = events
            .iter()
            .find(|event| event.idempotency_key == metadata.idempotency_key)
        {
            if existing.event_type == "run.cancellation_requested"
                && existing.payload.get("cancellationReason")
                    == Some(&Value::String(cancellation_reason.to_owned()))
                && existing.payload.get("attemptIds") == Some(&json!(attempt_ids))
            {
                return Ok(());
            }
            return Err(EventJournalError::IdempotencyConflict {
                idempotency_key: metadata.idempotency_key.to_owned(),
            }
            .into());
        }
        let previous = self.machine.state();
        let mut candidate = self.machine;
        transition_machine(&mut candidate, RunState::WaitingForReconciliation)?;
        let stored = journal.append(
            cancellation_requested_event(
                &self.run_id,
                attempt_ids,
                cancellation_reason,
                metadata,
                previous,
            ),
            self.last_run_sequence,
            self.last_aggregate_sequence,
        )?;
        self.machine = candidate;
        self.last_run_sequence = stored.run_sequence;
        self.last_aggregate_sequence = stored.aggregate_sequence;
        self.updated_at = stored.created_at;
        Ok(())
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

    pub fn reconcile(
        &mut self,
        journal: &mut EventJournal,
        attempt_id: &str,
        decision: RunReconciliationDecision,
        duplicate_execution_acknowledged: bool,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        if attempt_id.trim().is_empty() {
            return Err(RunAggregateError::InvalidPayload);
        }
        let target = match decision {
            RunReconciliationDecision::CancelRun => RunState::Cancelled,
            RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate => {
                RunState::Retrying
            }
        };
        let existing = journal
            .read_aggregate(&self.run_id, "run", &self.run_id, 0)?
            .into_iter()
            .find(|event| event.idempotency_key == metadata.idempotency_key);
        if let Some(existing) = existing {
            let payload = parse_reconciliation_payload(&existing.payload)?;
            if existing.event_type == "run.reconciled"
                && existing.event_version == 1
                && payload.transition.current == target
                && payload.attempt_id == attempt_id
                && payload.decision == decision
                && payload.duplicate_execution_acknowledged == duplicate_execution_acknowledged
            {
                return Ok(());
            }
            return Err(EventJournalError::IdempotencyConflict {
                idempotency_key: metadata.idempotency_key.to_owned(),
            }
            .into());
        }
        if self.machine.state() != RunState::WaitingForReconciliation {
            return Err(RunAggregateError::ReconciliationStateRequired);
        }
        let required_ack = matches!(
            decision,
            RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate
        );
        if duplicate_execution_acknowledged != required_ack {
            return Err(RunAggregateError::InvalidPayload);
        }
        let previous = self.machine.state();
        let mut candidate = self.machine;
        transition_machine(&mut candidate, target)?;
        let stored = journal.append(
            reconciliation_event(
                &self.run_id,
                attempt_id,
                decision,
                duplicate_execution_acknowledged,
                metadata,
                previous,
                target,
            ),
            self.last_run_sequence,
            self.last_aggregate_sequence,
        )?;
        self.machine = candidate;
        self.last_run_sequence = stored.run_sequence;
        self.last_aggregate_sequence = stored.aggregate_sequence;
        self.updated_at = stored.created_at;
        Ok(())
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
        if self.machine.state() == RunState::Cancelled {
            let events = journal.read_aggregate(&self.run_id, "run", &self.run_id, 0)?;
            if let Some(existing) = events
                .iter()
                .find(|event| event.idempotency_key == metadata.idempotency_key)
            {
                if existing.event_type == "run.cancelled"
                    && existing.payload.get("reason")
                        == Some(
                            &metadata
                                .reason
                                .map_or(Value::Null, |value| Value::String(value.to_owned())),
                        )
                {
                    return Ok(());
                }
                return Err(EventJournalError::IdempotencyConflict {
                    idempotency_key: metadata.idempotency_key.to_owned(),
                }
                .into());
            }
        }
        self.apply(journal, metadata, RunState::Cancelled)
    }

    pub fn fail(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        self.apply(journal, metadata, RunState::Failed)
    }

    pub fn fail_with_error(
        &mut self,
        journal: &mut EventJournal,
        metadata: EventMetadata<'_>,
        terminal_error: RuntimeError,
    ) -> Result<(), RunAggregateError> {
        let previous = self.machine.state();
        let mut candidate = self.machine;
        transition_machine(&mut candidate, RunState::Failed)?;
        let stored = journal.append(
            failure_event(&self.run_id, metadata, previous, &terminal_error)?,
            self.last_run_sequence,
            self.last_aggregate_sequence,
        )?;
        self.machine = candidate;
        self.last_run_sequence = stored.run_sequence;
        self.last_aggregate_sequence = stored.aggregate_sequence;
        self.updated_at = stored.created_at;
        self.terminal_error = Some(terminal_error);
        Ok(())
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
        let stored = journal.append(
            transition_event(
                &self.run_id,
                metadata,
                event_type(target),
                Some(previous),
                target,
            ),
            self.last_run_sequence,
            self.last_aggregate_sequence,
        )?;
        self.machine = candidate;
        self.last_run_sequence = stored.run_sequence;
        self.last_aggregate_sequence = stored.aggregate_sequence;
        self.updated_at = stored.created_at;
        Ok(())
    }

    fn is_idempotent_transition(
        &self,
        journal: &EventJournal,
        metadata: &EventMetadata<'_>,
        event_type: &str,
        current: RunState,
    ) -> Result<bool, RunAggregateError> {
        let events = journal.read_aggregate(&self.run_id, "run", &self.run_id, 0)?;
        let Some(existing) = events
            .iter()
            .find(|event| event.idempotency_key == metadata.idempotency_key)
        else {
            return Ok(false);
        };
        let payload = parse_payload(&existing.payload)?;
        if existing.event_type == event_type
            && existing.event_version == 1
            && payload.current == current
            && existing.payload.get("reason")
                == Some(
                    &metadata
                        .reason
                        .map_or(Value::Null, |value| Value::String(value.to_owned())),
                )
        {
            return Ok(true);
        }
        Err(EventJournalError::IdempotencyConflict {
            idempotency_key: metadata.idempotency_key.to_owned(),
        }
        .into())
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
    #[error("unknown run event version {version} for `{event_type}`")]
    UnknownEventVersion { event_type: String, version: u32 },
    #[error("run.created must be the first and only creation event")]
    DuplicateCreated,
    #[error("run event payload is invalid")]
    InvalidPayload,
    #[error("run pinned identity field `{0}` is invalid")]
    InvalidPinnedIdentity(&'static str),
    #[error("run event state does not match aggregate state")]
    StateMismatch,
    #[error("run reconciliation requires waiting_for_reconciliation")]
    ReconciliationStateRequired,
    #[error(transparent)]
    Transition(#[from] TransitionError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
}

fn replay(
    run_id: &str,
    events: &[RuntimeEvent],
    last_run_sequence: u64,
) -> Result<RunAggregate, RunAggregateError> {
    let first = events
        .first()
        .ok_or_else(|| RunAggregateError::NotFound(run_id.to_owned()))?;
    if first.aggregate_sequence != 1 {
        return Err(RunAggregateError::SequenceGap {
            expected: 1,
            actual: first.aggregate_sequence,
        });
    }
    if first.event_version != 2 {
        return Err(RunAggregateError::InvalidPayload);
    }
    let creation = parse_creation_payload(&first.payload)?;
    if first.event_type != "run.created"
        || creation.transition.previous.is_some()
        || creation.transition.current != RunState::Created
    {
        return Err(RunAggregateError::InvalidPayload);
    }
    validate_pinned_identity(&creation.pinned_identity)?;
    let mut aggregate = RunAggregate {
        run_id: run_id.to_owned(),
        pinned_identity: creation.pinned_identity,
        machine: RunStateMachine::new(),
        last_run_sequence,
        last_aggregate_sequence: 1,
        created_at: first.created_at.clone(),
        updated_at: first.created_at.clone(),
        terminal_error: None,
    };
    for event in &events[1..] {
        let expected = aggregate.last_aggregate_sequence + 1;
        if event.aggregate_sequence != expected {
            return Err(RunAggregateError::SequenceGap {
                expected,
                actual: event.aggregate_sequence,
            });
        }
        if event.event_type == "run.created" {
            return Err(RunAggregateError::DuplicateCreated);
        }
        if event.event_type == "run.failed" && event.event_version == 2 {
            let failure = parse_failure_payload(&event.payload)?;
            if failure.transition.previous != Some(aggregate.machine.state())
                || failure.transition.current != RunState::Failed
            {
                return Err(RunAggregateError::StateMismatch);
            }
            transition_machine(&mut aggregate.machine, RunState::Failed)?;
            aggregate.terminal_error = Some(failure.terminal_error);
            aggregate.last_aggregate_sequence = event.aggregate_sequence;
            aggregate.updated_at = event.created_at.clone();
            continue;
        }
        if event.event_type == "run.reconciled" && event.event_version == 1 {
            let payload = parse_reconciliation_payload(&event.payload)?;
            if payload.transition.previous != Some(aggregate.machine.state())
                || aggregate.machine.state() != RunState::WaitingForReconciliation
            {
                return Err(RunAggregateError::StateMismatch);
            }
            transition_machine(&mut aggregate.machine, payload.transition.current)?;
            aggregate.last_aggregate_sequence = event.aggregate_sequence;
            aggregate.updated_at = event.created_at.clone();
            continue;
        }
        if event.event_type == "run.cancellation_requested" && event.event_version == 1 {
            let payload = parse_cancellation_requested_payload(&event.payload)?;
            if payload.transition.previous != Some(aggregate.machine.state())
                || payload.transition.current != RunState::WaitingForReconciliation
            {
                return Err(RunAggregateError::StateMismatch);
            }
            transition_machine(&mut aggregate.machine, RunState::WaitingForReconciliation)?;
            aggregate.last_aggregate_sequence = event.aggregate_sequence;
            aggregate.updated_at = event.created_at.clone();
            continue;
        }
        if event.event_version != 1 {
            return Err(RunAggregateError::UnknownEventVersion {
                event_type: event.event_type.clone(),
                version: event.event_version,
            });
        }
        let target = state_for_event(&event.event_type)?;
        let payload = parse_payload(&event.payload)?;
        if payload.previous != Some(aggregate.machine.state()) || payload.current != target {
            return Err(RunAggregateError::StateMismatch);
        }
        transition_machine(&mut aggregate.machine, target)?;
        aggregate.last_aggregate_sequence = event.aggregate_sequence;
        aggregate.updated_at = event.created_at.clone();
    }
    Ok(aggregate)
}

struct TransitionPayload {
    previous: Option<RunState>,
    current: RunState,
}

struct CreationPayload {
    transition: TransitionPayload,
    pinned_identity: RunPinnedIdentity,
}

struct FailurePayload {
    transition: TransitionPayload,
    terminal_error: RuntimeError,
}

struct ReconciliationPayload {
    transition: TransitionPayload,
    attempt_id: String,
    decision: RunReconciliationDecision,
    duplicate_execution_acknowledged: bool,
}

struct CancellationRequestedPayload {
    transition: TransitionPayload,
}

fn parse_cancellation_requested_payload(
    value: &Value,
) -> Result<CancellationRequestedPayload, RunAggregateError> {
    let object = value.as_object().ok_or(RunAggregateError::InvalidPayload)?;
    if object.len() != 5 {
        return Err(RunAggregateError::InvalidPayload);
    }
    let transition = parse_transition_fields(object)?;
    if transition.current != RunState::WaitingForReconciliation {
        return Err(RunAggregateError::InvalidPayload);
    }
    object
        .get("cancellationReason")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(RunAggregateError::InvalidPayload)?;
    let attempt_ids = object
        .get("attemptIds")
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or(RunAggregateError::InvalidPayload)?;
    if attempt_ids
        .iter()
        .any(|value| value.as_str().is_none_or(|value| value.trim().is_empty()))
    {
        return Err(RunAggregateError::InvalidPayload);
    }
    Ok(CancellationRequestedPayload { transition })
}

fn parse_reconciliation_payload(value: &Value) -> Result<ReconciliationPayload, RunAggregateError> {
    let object = value.as_object().ok_or(RunAggregateError::InvalidPayload)?;
    if object.len() != 6 {
        return Err(RunAggregateError::InvalidPayload);
    }
    let transition = parse_transition_fields(object)?;
    let attempt_id = object
        .get("attemptId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(RunAggregateError::InvalidPayload)?
        .to_owned();
    let decision = serde_json::from_value(
        object
            .get("decision")
            .cloned()
            .ok_or(RunAggregateError::InvalidPayload)?,
    )
    .map_err(|_| RunAggregateError::InvalidPayload)?;
    let duplicate_execution_acknowledged = object
        .get("duplicateExecutionAcknowledged")
        .and_then(Value::as_bool)
        .ok_or(RunAggregateError::InvalidPayload)?;
    let expected = match decision {
        RunReconciliationDecision::CancelRun if !duplicate_execution_acknowledged => {
            RunState::Cancelled
        }
        RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate
            if duplicate_execution_acknowledged =>
        {
            RunState::Retrying
        }
        _ => return Err(RunAggregateError::InvalidPayload),
    };
    if transition.current != expected {
        return Err(RunAggregateError::InvalidPayload);
    }
    Ok(ReconciliationPayload {
        transition,
        attempt_id,
        decision,
        duplicate_execution_acknowledged,
    })
}

fn parse_creation_payload(value: &Value) -> Result<CreationPayload, RunAggregateError> {
    let object = value.as_object().ok_or(RunAggregateError::InvalidPayload)?;
    if object.len() != 4 || !object.contains_key("pinnedIdentity") {
        return Err(RunAggregateError::InvalidPayload);
    }
    let transition = parse_transition_fields(object)?;
    let pinned_identity = serde_json::from_value(object["pinnedIdentity"].clone())
        .map_err(|_| RunAggregateError::InvalidPayload)?;
    Ok(CreationPayload {
        transition,
        pinned_identity,
    })
}

fn parse_failure_payload(value: &Value) -> Result<FailurePayload, RunAggregateError> {
    let object = value.as_object().ok_or(RunAggregateError::InvalidPayload)?;
    if object.len() != 4 || !object.contains_key("terminalError") {
        return Err(RunAggregateError::InvalidPayload);
    }
    let transition = parse_transition_fields(object)?;
    let terminal_error = serde_json::from_value(object["terminalError"].clone())
        .map_err(|_| RunAggregateError::InvalidPayload)?;
    Ok(FailurePayload {
        transition,
        terminal_error,
    })
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
    parse_transition_fields(object)
}

fn parse_transition_fields(
    object: &serde_json::Map<String, Value>,
) -> Result<TransitionPayload, RunAggregateError> {
    let reason = object
        .get("reason")
        .ok_or(RunAggregateError::InvalidPayload)?;
    if !reason.is_null() && !reason.is_string() {
        return Err(RunAggregateError::InvalidPayload);
    }
    let previous = match object
        .get("previousState")
        .ok_or(RunAggregateError::InvalidPayload)?
    {
        Value::Null => None,
        Value::String(value) => Some(parse_state(value)?),
        _ => return Err(RunAggregateError::InvalidPayload),
    };
    let current = object
        .get("currentState")
        .ok_or(RunAggregateError::InvalidPayload)?
        .as_str()
        .ok_or(RunAggregateError::InvalidPayload)
        .and_then(parse_state)?;
    Ok(TransitionPayload { previous, current })
}

fn creation_event(
    run_id: &str,
    pinned_identity: &RunPinnedIdentity,
    metadata: EventMetadata<'_>,
) -> Result<NewRuntimeEvent, RunAggregateError> {
    Ok(NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: "run".to_owned(),
        aggregate_id: run_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: metadata.idempotency_key.to_owned(),
        event_type: "run.created".to_owned(),
        event_version: 2,
        payload: json!({
            "previousState": null,
            "currentState": "created",
            "reason": metadata.reason,
            "pinnedIdentity": pinned_identity,
        }),
        created_at: metadata.created_at.to_owned(),
    })
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
        aggregate_type: "run".to_owned(),
        aggregate_id: run_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: metadata.idempotency_key.to_owned(),
        event_type: event_type.to_owned(),
        event_version: 1,
        payload: json!({
            "previousState": previous.map(state_name),
            "currentState": state_name(current),
            "reason": metadata.reason,
        }),
        created_at: metadata.created_at.to_owned(),
    }
}

fn cancellation_requested_event(
    run_id: &str,
    attempt_ids: &[String],
    cancellation_reason: &str,
    metadata: EventMetadata<'_>,
    previous: RunState,
) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: "run".to_owned(),
        aggregate_id: run_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: metadata.idempotency_key.to_owned(),
        event_type: "run.cancellation_requested".to_owned(),
        event_version: 1,
        payload: json!({
            "previousState": state_name(previous),
            "currentState": "waiting_for_reconciliation",
            "reason": metadata.reason,
            "cancellationReason": cancellation_reason,
            "attemptIds": attempt_ids,
        }),
        created_at: metadata.created_at.to_owned(),
    }
}

fn reconciliation_event(
    run_id: &str,
    attempt_id: &str,
    decision: RunReconciliationDecision,
    duplicate_execution_acknowledged: bool,
    metadata: EventMetadata<'_>,
    previous: RunState,
    current: RunState,
) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: "run".to_owned(),
        aggregate_id: run_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: metadata.idempotency_key.to_owned(),
        event_type: "run.reconciled".to_owned(),
        event_version: 1,
        payload: json!({ "previousState": state_name(previous), "currentState": state_name(current), "reason": metadata.reason,
            "attemptId": attempt_id, "decision": decision, "duplicateExecutionAcknowledged": duplicate_execution_acknowledged }),
        created_at: metadata.created_at.to_owned(),
    }
}

fn failure_event(
    run_id: &str,
    metadata: EventMetadata<'_>,
    previous: RunState,
    terminal_error: &RuntimeError,
) -> Result<NewRuntimeEvent, RunAggregateError> {
    Ok(NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: "run".to_owned(),
        aggregate_id: run_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: metadata.idempotency_key.to_owned(),
        event_type: "run.failed".to_owned(),
        event_version: 2,
        payload: json!({
            "previousState": state_name(previous),
            "currentState": "failed",
            "reason": metadata.reason,
            "terminalError": terminal_error,
        }),
        created_at: metadata.created_at.to_owned(),
    })
}

fn validate_pinned_identity(identity: &RunPinnedIdentity) -> Result<(), RunAggregateError> {
    for (name, value) in [
        ("projectId", identity.project_id.as_str()),
        ("workspaceId", identity.workspace_id.as_str()),
        ("sessionId", identity.session_id.as_str()),
        ("sessionBranchId", identity.session_branch_id.as_str()),
        ("userMessageId", identity.user_message_id.as_str()),
        ("projectBranchId", identity.project_branch_id.as_str()),
        ("provider.profileId", identity.provider.profile_id.as_str()),
        (
            "provider.providerId",
            identity.provider.provider_id.as_str(),
        ),
        ("provider.modelId", identity.provider.model_id.as_str()),
        ("promptBundle.id", identity.prompt_bundle.id.as_str()),
        (
            "promptBundle.version",
            identity.prompt_bundle.version.as_str(),
        ),
        ("agentProfile.id", identity.agent_profile.id.as_str()),
        (
            "agentProfile.version",
            identity.agent_profile.version.as_str(),
        ),
        ("toolPolicy.id", identity.tool_policy.id.as_str()),
        ("toolPolicy.version", identity.tool_policy.version.as_str()),
        ("contextPolicy.id", identity.context_policy.id.as_str()),
        (
            "contextPolicy.version",
            identity.context_policy.version.as_str(),
        ),
        ("runtimePolicy.id", identity.runtime_policy.id.as_str()),
        (
            "runtimePolicy.version",
            identity.runtime_policy.version.as_str(),
        ),
        (
            "runtimeContractVersion",
            identity.runtime_contract_version.as_str(),
        ),
        ("sourceCheckpointId", identity.source_checkpoint_id.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(RunAggregateError::InvalidPinnedIdentity(name));
        }
    }
    for (name, value) in [
        (
            "provider.configSha256",
            identity.provider.config_sha256.as_str(),
        ),
        (
            "promptBundle.sha256",
            identity.prompt_bundle.sha256.as_str(),
        ),
        (
            "agentProfile.sha256",
            identity.agent_profile.sha256.as_str(),
        ),
        ("toolPolicy.sha256", identity.tool_policy.sha256.as_str()),
        (
            "contextPolicy.sha256",
            identity.context_policy.sha256.as_str(),
        ),
        (
            "runtimePolicy.sha256",
            identity.runtime_policy.sha256.as_str(),
        ),
        (
            "resourceScopeSha256",
            identity.resource_scope_sha256.as_str(),
        ),
        ("userInputSha256", identity.user_input_sha256.as_str()),
    ] {
        if !is_lowercase_sha256(value) {
            return Err(RunAggregateError::InvalidPinnedIdentity(name));
        }
    }
    if identity
        .goal
        .as_ref()
        .is_some_and(invalid_revision_reference)
    {
        return Err(RunAggregateError::InvalidPinnedIdentity("goal"));
    }
    if identity
        .plan
        .as_ref()
        .is_some_and(invalid_revision_reference)
    {
        return Err(RunAggregateError::InvalidPinnedIdentity("plan"));
    }
    if identity.scope_resource_ids.is_empty()
        || identity
            .scope_resource_ids
            .iter()
            .any(|value| value.trim().is_empty())
        || identity
            .scope_resource_ids
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return Err(RunAggregateError::InvalidPinnedIdentity("scopeResourceIds"));
    }
    Ok(())
}

fn invalid_revision_reference(reference: &novelx_protocol::RevisionReference) -> bool {
    reference.id.trim().is_empty() || reference.revision == 0
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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
        RunState::WaitingForReconciliation => machine.wait_for_reconciliation(),
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
        RunState::WaitingForReconciliation => "run.waiting_for_reconciliation",
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
        "run.waiting_for_reconciliation" => Ok(RunState::WaitingForReconciliation),
        "run.cancellation_requested" => Ok(RunState::WaitingForReconciliation),
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
        RunState::WaitingForReconciliation => "waiting_for_reconciliation",
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
        "waiting_for_reconciliation" => Ok(RunState::WaitingForReconciliation),
        "committing" => Ok(RunState::Committing),
        "retrying" => Ok(RunState::Retrying),
        "blocked" => Ok(RunState::Blocked),
        "cancelled" => Ok(RunState::Cancelled),
        "failed" => Ok(RunState::Failed),
        "completed" => Ok(RunState::Completed),
        _ => Err(RunAggregateError::InvalidPayload),
    }
}
