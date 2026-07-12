use novelx_protocol::{ProviderInferenceToolCall, ProviderRunIdentity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent, RuntimeEvent};

const AGGREGATE_TYPE: &str = "provider_attempt";
const EVENT_VERSION: u32 = 1;
const MAX_INLINE_RESPONSE_TEXT_BYTES: usize = 1_048_576;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAttemptState {
    Requested,
    Sent,
    Responded,
    Failed,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderAttemptRecovery {
    SafeToSend,
    OutcomeUnknown,
    Completed,
    RetryEligible,
    TerminalFailure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderDeliveryCertainty {
    NotSent,
    ResponseReceived,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAttemptDefinition {
    pub run_id: String,
    pub inference_id: String,
    pub invocation_id: String,
    pub context_compilation_id: Uuid,
    pub canonical_context_sha256: String,
    pub transport_payload_sha256: String,
    pub provider: ProviderRunIdentity,
    pub request_number: u64,
    pub attempt_number: u16,
    pub output_reserve_tokens: u64,
    pub request_timeout_ms: u64,
    pub total_deadline_ms: u64,
    pub max_attempts: u16,
    pub max_total_delay_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderResponseReceipt {
    pub http_status: u16,
    pub actual_provider_id: String,
    pub actual_model_id: String,
    pub response_id_sha256: Option<String>,
    pub response_body_sha256: String,
    pub stop_reason: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAttemptFailure {
    pub code: String,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
    pub http_status: Option<u16>,
    pub delivery_certainty: ProviderDeliveryCertainty,
    pub diagnostic_id: Uuid,
}

#[derive(Clone, Copy)]
pub struct ProviderAttemptMetadata<'a> {
    pub message_id: &'a str,
    pub idempotency_key: &'a str,
    pub created_at: &'a str,
    pub reason: Option<&'a str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderAttemptAggregate {
    run_id: String,
    attempt_id: String,
    definition: ProviderAttemptDefinition,
    state: ProviderAttemptState,
    aggregate_sequence: u64,
    dispatch_id: Option<String>,
    response: Option<ProviderResponseReceipt>,
    response_text: Option<String>,
    response_text_sha256: Option<String>,
    tool_calls: Vec<ProviderInferenceToolCall>,
    failure: Option<ProviderAttemptFailure>,
}

impl ProviderAttemptAggregate {
    pub fn create(
        journal: &mut EventJournal,
        run_id: &str,
        attempt_id: &str,
        definition: ProviderAttemptDefinition,
        expected_run_sequence: u64,
        metadata: ProviderAttemptMetadata<'_>,
    ) -> Result<Self, ProviderAttemptError> {
        validate_definition(run_id, attempt_id, &definition)?;
        let existing = journal.read_aggregate(run_id, AGGREGATE_TYPE, attempt_id, 0)?;
        if !existing.is_empty() {
            let recovered = replay(run_id, attempt_id, &existing)?;
            if recovered.definition == definition
                && existing[0].idempotency_key == metadata.idempotency_key
            {
                return Ok(recovered);
            }
            return Err(ProviderAttemptError::IdentityConflict);
        }
        journal.append(
            event(
                run_id,
                attempt_id,
                metadata,
                "provider.requested",
                EventPayload::Requested {
                    definition: definition.clone(),
                },
            )?,
            expected_run_sequence,
            0,
        )?;
        Self::recover(journal, run_id, attempt_id)
    }

    pub fn recover(
        journal: &EventJournal,
        run_id: &str,
        attempt_id: &str,
    ) -> Result<Self, ProviderAttemptError> {
        replay(
            run_id,
            attempt_id,
            &journal.read_aggregate(run_id, AGGREGATE_TYPE, attempt_id, 0)?,
        )
    }

    pub const fn state(&self) -> ProviderAttemptState {
        self.state
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub const fn aggregate_sequence(&self) -> u64 {
        self.aggregate_sequence
    }

    pub const fn definition(&self) -> &ProviderAttemptDefinition {
        &self.definition
    }

    pub const fn recovery(&self) -> ProviderAttemptRecovery {
        match self.state {
            ProviderAttemptState::Requested => ProviderAttemptRecovery::SafeToSend,
            ProviderAttemptState::Sent | ProviderAttemptState::OutcomeUnknown => {
                ProviderAttemptRecovery::OutcomeUnknown
            }
            ProviderAttemptState::Responded => ProviderAttemptRecovery::Completed,
            ProviderAttemptState::Failed => match &self.failure {
                Some(failure) if failure.retryable => ProviderAttemptRecovery::RetryEligible,
                _ => ProviderAttemptRecovery::TerminalFailure,
            },
        }
    }

    pub fn mark_sent(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        dispatch_id: &str,
        metadata: ProviderAttemptMetadata<'_>,
    ) -> Result<(), ProviderAttemptError> {
        if self.state != ProviderAttemptState::Requested || dispatch_id.trim().is_empty() {
            return Err(self.transition_error());
        }
        let stored = journal.append(
            event(
                &self.run_id,
                &self.attempt_id,
                metadata,
                "provider.sent",
                EventPayload::Sent {
                    definition: self.definition.clone(),
                    dispatch_id: dispatch_id.to_owned(),
                },
            )?,
            expected_run_sequence,
            self.aggregate_sequence,
        )?;
        self.state = ProviderAttemptState::Sent;
        self.aggregate_sequence = stored.aggregate_sequence;
        self.dispatch_id = Some(dispatch_id.to_owned());
        Ok(())
    }

    pub fn respond_with_output(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        response: ProviderResponseReceipt,
        response_text: Option<String>,
        tool_calls: Vec<ProviderInferenceToolCall>,
        metadata: ProviderAttemptMetadata<'_>,
    ) -> Result<(), ProviderAttemptError> {
        if self.state != ProviderAttemptState::Sent {
            return Err(self.transition_error());
        }
        validate_response(&self.definition, &response)?;
        let response_text_sha256 = validate_response_output(response_text.as_deref(), &tool_calls)?;
        let stored = journal.append(
            event(
                &self.run_id,
                &self.attempt_id,
                metadata,
                "provider.responded",
                EventPayload::Responded {
                    definition: self.definition.clone(),
                    response: response.clone(),
                    response_text: response_text.clone(),
                    response_text_sha256: response_text_sha256.clone(),
                    tool_calls: tool_calls.clone(),
                },
            )?,
            expected_run_sequence,
            self.aggregate_sequence,
        )?;
        self.state = ProviderAttemptState::Responded;
        self.aggregate_sequence = stored.aggregate_sequence;
        self.response = Some(response);
        self.response_text = response_text;
        self.response_text_sha256 = response_text_sha256;
        self.tool_calls = tool_calls;
        Ok(())
    }

    pub fn response_text(&self) -> Option<&str> {
        self.response_text.as_deref()
    }

    pub fn response_text_sha256(&self) -> Option<&str> {
        self.response_text_sha256.as_deref()
    }

    pub const fn response_receipt(&self) -> Option<&ProviderResponseReceipt> {
        self.response.as_ref()
    }

    pub fn tool_calls(&self) -> &[ProviderInferenceToolCall] {
        &self.tool_calls
    }

    pub fn dispatch_id(&self) -> Option<&str> {
        self.dispatch_id.as_deref()
    }

    pub const fn failure(&self) -> Option<&ProviderAttemptFailure> {
        self.failure.as_ref()
    }

    pub fn fail(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        failure: ProviderAttemptFailure,
        metadata: ProviderAttemptMetadata<'_>,
    ) -> Result<(), ProviderAttemptError> {
        let allowed = match self.state {
            ProviderAttemptState::Requested => {
                failure.delivery_certainty == ProviderDeliveryCertainty::NotSent
            }
            ProviderAttemptState::Sent => {
                failure.delivery_certainty == ProviderDeliveryCertainty::ResponseReceived
            }
            _ => return Err(self.transition_error()),
        };
        if !allowed {
            return Err(ProviderAttemptError::DeliveryCertaintyInvalid);
        }
        validate_failure(&failure)?;
        let stored = journal.append(
            event(
                &self.run_id,
                &self.attempt_id,
                metadata,
                "provider.failed",
                EventPayload::Failed {
                    definition: self.definition.clone(),
                    failure: failure.clone(),
                },
            )?,
            expected_run_sequence,
            self.aggregate_sequence,
        )?;
        self.state = ProviderAttemptState::Failed;
        self.aggregate_sequence = stored.aggregate_sequence;
        self.failure = Some(failure);
        Ok(())
    }

    pub fn mark_outcome_unknown(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        diagnostic_id: Uuid,
        metadata: ProviderAttemptMetadata<'_>,
    ) -> Result<(), ProviderAttemptError> {
        if self.state != ProviderAttemptState::Sent {
            return Err(self.transition_error());
        }
        let stored = journal.append(
            event(
                &self.run_id,
                &self.attempt_id,
                metadata,
                "provider.outcome_unknown",
                EventPayload::OutcomeUnknown {
                    definition: self.definition.clone(),
                    diagnostic_id,
                },
            )?,
            expected_run_sequence,
            self.aggregate_sequence,
        )?;
        self.state = ProviderAttemptState::OutcomeUnknown;
        self.aggregate_sequence = stored.aggregate_sequence;
        Ok(())
    }

    fn transition_error(&self) -> ProviderAttemptError {
        if matches!(
            self.state,
            ProviderAttemptState::Responded
                | ProviderAttemptState::Failed
                | ProviderAttemptState::OutcomeUnknown
        ) {
            ProviderAttemptError::TerminalState { state: self.state }
        } else {
            ProviderAttemptError::TransitionInvalid { state: self.state }
        }
    }
}

#[derive(Debug, Error)]
pub enum ProviderAttemptError {
    #[error("provider attempt identity conflicts with its aggregate address")]
    IdentityConflict,
    #[error("provider attempt event sequence is not contiguous")]
    SequenceGap,
    #[error("provider attempt event version {0} is unsupported")]
    UnknownEventVersion(u32),
    #[error("provider attempt event history is invalid")]
    InvalidHistory,
    #[error("provider attempt transition is invalid from {state:?}")]
    TransitionInvalid { state: ProviderAttemptState },
    #[error("provider attempt is terminal in {state:?}")]
    TerminalState { state: ProviderAttemptState },
    #[error("provider failure delivery certainty is invalid for the current state")]
    DeliveryCertaintyInvalid,
    #[error("provider attempt definition is invalid")]
    DefinitionInvalid,
    #[error("provider response receipt is invalid")]
    ResponseInvalid,
    #[error("provider failure receipt is invalid")]
    FailureInvalid,
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum EventPayload {
    Requested {
        definition: ProviderAttemptDefinition,
    },
    Sent {
        definition: ProviderAttemptDefinition,
        dispatch_id: String,
    },
    Responded {
        definition: ProviderAttemptDefinition,
        response: ProviderResponseReceipt,
        response_text: Option<String>,
        response_text_sha256: Option<String>,
        #[serde(default)]
        tool_calls: Vec<ProviderInferenceToolCall>,
    },
    Failed {
        definition: ProviderAttemptDefinition,
        failure: ProviderAttemptFailure,
    },
    OutcomeUnknown {
        definition: ProviderAttemptDefinition,
        diagnostic_id: Uuid,
    },
}

impl EventPayload {
    fn definition(&self) -> &ProviderAttemptDefinition {
        match self {
            Self::Requested { definition }
            | Self::Sent { definition, .. }
            | Self::Responded { definition, .. }
            | Self::Failed { definition, .. }
            | Self::OutcomeUnknown { definition, .. } => definition,
        }
    }
}

fn replay(
    run_id: &str,
    attempt_id: &str,
    events: &[RuntimeEvent],
) -> Result<ProviderAttemptAggregate, ProviderAttemptError> {
    let first = events.first().ok_or(ProviderAttemptError::InvalidHistory)?;
    validate_event_address(first, run_id, attempt_id, 1)?;
    if first.event_version != EVENT_VERSION {
        return Err(ProviderAttemptError::UnknownEventVersion(
            first.event_version,
        ));
    }
    if first.event_type != "provider.requested" {
        return Err(ProviderAttemptError::InvalidHistory);
    }
    let first_payload: EventPayload = serde_json::from_value(first.payload.clone())?;
    let EventPayload::Requested { definition } = first_payload else {
        return Err(ProviderAttemptError::InvalidHistory);
    };
    validate_definition(run_id, attempt_id, &definition)?;
    let mut aggregate = ProviderAttemptAggregate {
        run_id: run_id.to_owned(),
        attempt_id: attempt_id.to_owned(),
        definition,
        state: ProviderAttemptState::Requested,
        aggregate_sequence: 1,
        dispatch_id: None,
        response: None,
        response_text: None,
        response_text_sha256: None,
        tool_calls: Vec::new(),
        failure: None,
    };
    for event in &events[1..] {
        validate_event_address(event, run_id, attempt_id, aggregate.aggregate_sequence + 1)?;
        if event.event_version != EVENT_VERSION {
            return Err(ProviderAttemptError::UnknownEventVersion(
                event.event_version,
            ));
        }
        let payload: EventPayload = serde_json::from_value(event.payload.clone())?;
        if payload.definition() != &aggregate.definition {
            return Err(ProviderAttemptError::IdentityConflict);
        }
        match (aggregate.state, event.event_type.as_str(), payload) {
            (
                ProviderAttemptState::Requested,
                "provider.sent",
                EventPayload::Sent { dispatch_id, .. },
            ) if !dispatch_id.trim().is_empty() => {
                aggregate.state = ProviderAttemptState::Sent;
                aggregate.dispatch_id = Some(dispatch_id);
            }
            (
                ProviderAttemptState::Requested,
                "provider.failed",
                EventPayload::Failed { failure, .. },
            ) if failure.delivery_certainty == ProviderDeliveryCertainty::NotSent => {
                validate_failure(&failure)?;
                aggregate.state = ProviderAttemptState::Failed;
                aggregate.failure = Some(failure);
            }
            (
                ProviderAttemptState::Sent,
                "provider.responded",
                EventPayload::Responded {
                    response,
                    response_text,
                    response_text_sha256,
                    tool_calls,
                    ..
                },
            ) => {
                validate_response(&aggregate.definition, &response)?;
                let expected_hash =
                    validate_response_output(response_text.as_deref(), &tool_calls)?;
                if expected_hash != response_text_sha256 {
                    return Err(ProviderAttemptError::ResponseInvalid);
                }
                aggregate.state = ProviderAttemptState::Responded;
                aggregate.response = Some(response);
                aggregate.response_text = response_text;
                aggregate.response_text_sha256 = response_text_sha256;
                aggregate.tool_calls = tool_calls;
            }
            (
                ProviderAttemptState::Sent,
                "provider.failed",
                EventPayload::Failed { failure, .. },
            ) if failure.delivery_certainty == ProviderDeliveryCertainty::ResponseReceived => {
                validate_failure(&failure)?;
                aggregate.state = ProviderAttemptState::Failed;
                aggregate.failure = Some(failure);
            }
            (
                ProviderAttemptState::Sent,
                "provider.outcome_unknown",
                EventPayload::OutcomeUnknown { .. },
            ) => aggregate.state = ProviderAttemptState::OutcomeUnknown,
            _ => return Err(ProviderAttemptError::InvalidHistory),
        }
        aggregate.aggregate_sequence = event.aggregate_sequence;
    }
    Ok(aggregate)
}

fn validate_definition(
    run_id: &str,
    attempt_id: &str,
    value: &ProviderAttemptDefinition,
) -> Result<(), ProviderAttemptError> {
    if attempt_id.trim().is_empty()
        || value.run_id != run_id
        || value.inference_id.trim().is_empty()
        || value.invocation_id.trim().is_empty()
        || !is_sha256(&value.canonical_context_sha256)
        || !is_sha256(&value.transport_payload_sha256)
        || value.request_number == 0
        || value.attempt_number == 0
        || value.output_reserve_tokens == 0
        || value.request_timeout_ms == 0
        || value.total_deadline_ms < value.request_timeout_ms
        || value.max_attempts == 0
        || value.attempt_number > value.max_attempts
    {
        return Err(ProviderAttemptError::IdentityConflict);
    }
    Ok(())
}

fn validate_response(
    definition: &ProviderAttemptDefinition,
    response: &ProviderResponseReceipt,
) -> Result<(), ProviderAttemptError> {
    if !(200..300).contains(&response.http_status)
        || response.actual_provider_id != definition.provider.provider_id
        || response.actual_model_id != definition.provider.model_id
        || !response
            .response_id_sha256
            .as_ref()
            .is_some_and(|value| is_sha256(value))
        || !is_sha256(&response.response_body_sha256)
        || response.stop_reason.trim().is_empty()
        || response.input_tokens.saturating_add(response.output_tokens) != response.total_tokens
    {
        return Err(ProviderAttemptError::ResponseInvalid);
    }
    Ok(())
}

fn validate_response_output(
    response_text: Option<&str>,
    tool_calls: &[ProviderInferenceToolCall],
) -> Result<Option<String>, ProviderAttemptError> {
    if response_text.is_none() && tool_calls.is_empty() {
        return Err(ProviderAttemptError::ResponseInvalid);
    }
    let text_hash = match response_text {
        Some(text) if !text.trim().is_empty() && text.len() <= MAX_INLINE_RESPONSE_TEXT_BYTES => {
            Some(sha256(text.as_bytes()))
        }
        Some(_) => return Err(ProviderAttemptError::ResponseInvalid),
        None => None,
    };
    let mut ids = std::collections::BTreeSet::new();
    for call in tool_calls {
        if call.id.trim().is_empty()
            || call.name.trim().is_empty()
            || !call.arguments.is_object()
            || !is_sha256(&call.arguments_sha256)
            || sha256(&serde_json::to_vec(&call.arguments)?) != call.arguments_sha256
            || !ids.insert(call.id.as_str())
        {
            return Err(ProviderAttemptError::ResponseInvalid);
        }
    }
    Ok(text_hash)
}

fn validate_failure(failure: &ProviderAttemptFailure) -> Result<(), ProviderAttemptError> {
    if failure.code.trim().is_empty()
        || failure.delivery_certainty == ProviderDeliveryCertainty::Unknown
        || (!failure.retryable && failure.retry_after_ms.is_some())
    {
        return Err(ProviderAttemptError::FailureInvalid);
    }
    Ok(())
}

fn validate_event_address(
    event: &RuntimeEvent,
    run_id: &str,
    attempt_id: &str,
    expected_sequence: u64,
) -> Result<(), ProviderAttemptError> {
    if event.aggregate_sequence != expected_sequence {
        return Err(ProviderAttemptError::SequenceGap);
    }
    if event.run_id != run_id
        || event.aggregate_type != AGGREGATE_TYPE
        || event.aggregate_id != attempt_id
    {
        return Err(ProviderAttemptError::IdentityConflict);
    }
    Ok(())
}

fn event(
    run_id: &str,
    attempt_id: &str,
    metadata: ProviderAttemptMetadata<'_>,
    event_type: &str,
    payload: EventPayload,
) -> Result<NewRuntimeEvent, serde_json::Error> {
    Ok(NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: AGGREGATE_TYPE.to_owned(),
        aggregate_id: attempt_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: metadata.idempotency_key.to_owned(),
        event_type: event_type.to_owned(),
        event_version: EVENT_VERSION,
        payload: serde_json::to_value(payload)?,
        created_at: metadata.created_at.to_owned(),
    })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
