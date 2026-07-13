use novelx_protocol::{ProviderInferenceToolCall, ProviderRunIdentity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent, RuntimeEvent};
use crate::provider_effect_capability::{
    ArmedProviderEffect, ConsumedProviderEffect, ProviderEffectAuthorityBinding,
    ProviderEffectCapabilityError, ProviderEffectGrantReceipt,
};
use crate::provider_retry_after::ProviderRetryAfterReceipt;

const AGGREGATE_TYPE: &str = "provider_attempt";
const LEGACY_EVENT_VERSION: u32 = 1;
const AUTHORIZED_SENT_EVENT_VERSION: u32 = 2;
const CANCELLED_BEFORE_SENT_EVENT_VERSION: u32 = 3;
const AUTHORIZED_EVIDENCE_SCHEMA_VERSION: u16 = 2;
const CANCELLED_BEFORE_SENT_EVIDENCE_SCHEMA_VERSION: u16 = 3;
const MAX_INLINE_RESPONSE_TEXT_BYTES: usize = 1_048_576;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAttemptState {
    Requested,
    CancelledBeforeSent,
    Sent,
    Responded,
    Failed,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderAttemptRecovery {
    SafeToSend,
    CancelledSafe,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<ProviderRetryAfterReceipt>,
    pub http_status: Option<u16>,
    pub delivery_certainty: ProviderDeliveryCertainty,
    pub diagnostic_id: Uuid,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAttemptCancelledBeforeSent {
    pub cancellation_intent_id: String,
    pub cancellation_expected_run_sequence: u64,
    pub requested_aggregate_sequence: u64,
    pub requested_definition_sha256: String,
    pub requested_evidence_sha256: String,
}

impl ProviderAttemptCancelledBeforeSent {
    pub fn derive(
        attempt: &ProviderAttemptAggregate,
        cancellation_intent_id: String,
        cancellation_expected_run_sequence: u64,
    ) -> Result<Self, ProviderAttemptError> {
        if attempt.state != ProviderAttemptState::Requested {
            return Err(attempt.transition_error());
        }
        if !is_sha256(&cancellation_intent_id) {
            return Err(ProviderAttemptError::CancellationEvidenceInvalid);
        }
        Ok(Self {
            cancellation_intent_id,
            cancellation_expected_run_sequence,
            requested_aggregate_sequence: attempt.aggregate_sequence,
            requested_definition_sha256: provider_attempt_definition_sha256(attempt)?,
            requested_evidence_sha256: provider_attempt_evidence_sha256(attempt)?,
        })
    }
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
    requested_message_id: String,
    requested_idempotency_key: String,
    requested_at: String,
    definition: ProviderAttemptDefinition,
    state: ProviderAttemptState,
    aggregate_sequence: u64,
    dispatch_id: Option<String>,
    provider_effect_grant: Option<ProviderEffectGrantReceipt>,
    response: Option<ProviderResponseReceipt>,
    response_text: Option<String>,
    response_text_sha256: Option<String>,
    tool_calls: Vec<ProviderInferenceToolCall>,
    failure: Option<ProviderAttemptFailure>,
    cancelled_before_sent: Option<ProviderAttemptCancelledBeforeSent>,
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

    pub fn requested_message_id(&self) -> &str {
        &self.requested_message_id
    }

    pub fn requested_idempotency_key_sha256(&self) -> String {
        sha256(self.requested_idempotency_key.as_bytes())
    }

    pub fn requested_at(&self) -> &str {
        &self.requested_at
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
            ProviderAttemptState::CancelledBeforeSent => ProviderAttemptRecovery::CancelledSafe,
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

    pub const fn cancelled_before_sent(&self) -> Option<&ProviderAttemptCancelledBeforeSent> {
        self.cancelled_before_sent.as_ref()
    }

    pub fn cancel_before_sent(
        &mut self,
        journal: &mut EventJournal,
        expected_run_sequence: u64,
        expected_global_sequence: u64,
        cancellation: ProviderAttemptCancelledBeforeSent,
        metadata: ProviderAttemptMetadata<'_>,
    ) -> Result<(), ProviderAttemptError> {
        match self.state {
            ProviderAttemptState::Requested => {
                validate_cancelled_before_sent(self, &cancellation, Some(expected_run_sequence))?;
            }
            ProviderAttemptState::CancelledBeforeSent
                if self.cancelled_before_sent.as_ref() == Some(&cancellation)
                    && cancellation.requested_aggregate_sequence.checked_add(1)
                        == Some(self.aggregate_sequence)
                    && cancellation.cancellation_expected_run_sequence == expected_run_sequence => {
            }
            _ => return Err(self.transition_error()),
        }
        if metadata.idempotency_key
            != cancelled_before_sent_idempotency_key(&self.attempt_id, &cancellation)
        {
            return Err(ProviderAttemptError::CancellationEvidenceInvalid);
        }
        let outcome = journal.append_at_global_sequence(
            event_with_version(
                &self.run_id,
                &self.attempt_id,
                metadata,
                "provider.cancelled_before_sent",
                CANCELLED_BEFORE_SENT_EVENT_VERSION,
                CancelledBeforeSentEventPayload::CancelledBeforeSent {
                    definition: self.definition.clone(),
                    cancellation: cancellation.clone(),
                },
            )?,
            expected_run_sequence,
            cancellation.requested_aggregate_sequence,
            expected_global_sequence,
        )?;
        let recovered = Self::recover(journal, &self.run_id, &self.attempt_id)?;
        if recovered.state != ProviderAttemptState::CancelledBeforeSent
            || recovered.cancelled_before_sent.as_ref() != Some(&cancellation)
            || recovered.aggregate_sequence != outcome.event.aggregate_sequence
            || outcome.event.run_sequence
                != cancellation
                    .cancellation_expected_run_sequence
                    .checked_add(1)
                    .ok_or(ProviderAttemptError::CancellationEvidenceInvalid)?
            || outcome.event.event_type != "provider.cancelled_before_sent"
            || outcome.event.event_version != CANCELLED_BEFORE_SENT_EVENT_VERSION
        {
            return Err(ProviderAttemptError::CancellationEvidenceInvalid);
        }
        *self = recovered;
        Ok(())
    }

    /// Writes the legacy v1 send boundary for existing callers and fixtures.
    /// New Provider dispatch code must use [`Self::mark_sent_authorized`].
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

    pub fn mark_sent_authorized(
        &mut self,
        journal: &mut EventJournal,
        consumed: ConsumedProviderEffect,
        expected_run_sequence: u64,
        expected_global_sequence: u64,
        metadata: ProviderAttemptMetadata<'_>,
    ) -> Result<ArmedProviderEffect, ProviderAttemptError> {
        if self.state != ProviderAttemptState::Requested {
            return Err(self.transition_error());
        }
        let receipt = consumed.receipt().clone();
        validate_authorized_sent(self, &receipt, receipt.dispatch_id())?;
        let outcome = journal.append_at_global_sequence(
            event_with_version(
                &self.run_id,
                &self.attempt_id,
                metadata,
                "provider.sent",
                AUTHORIZED_SENT_EVENT_VERSION,
                AuthorizedSentEventPayload::Sent {
                    definition: self.definition.clone(),
                    dispatch_id: receipt.dispatch_id().to_string(),
                    grant: receipt,
                },
            )?,
            expected_run_sequence,
            self.aggregate_sequence,
            expected_global_sequence,
        )?;
        if !outcome.inserted {
            return Err(ProviderAttemptError::DispatchAlreadyCrossed);
        }
        let AuthorizedSentEventPayload::Sent {
            dispatch_id, grant, ..
        } = serde_json::from_value(outcome.event.payload.clone())?;
        validate_authorized_sent(self, &grant, grant.dispatch_id())?;
        if dispatch_id != grant.dispatch_id().to_string() {
            return Err(ProviderAttemptError::ProviderEffectGrantMismatch);
        }
        let armed = consumed
            .arm(grant.clone())
            .map_err(ProviderAttemptError::ProviderEffectArmFailed)?;
        self.state = ProviderAttemptState::Sent;
        self.aggregate_sequence = outcome.event.aggregate_sequence;
        self.dispatch_id = Some(dispatch_id);
        self.provider_effect_grant = Some(grant);
        Ok(armed)
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

    pub const fn provider_effect_grant(&self) -> Option<&ProviderEffectGrantReceipt> {
        self.provider_effect_grant.as_ref()
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
                | ProviderAttemptState::CancelledBeforeSent
        ) {
            ProviderAttemptError::TerminalState { state: self.state }
        } else {
            ProviderAttemptError::TransitionInvalid { state: self.state }
        }
    }
}

pub fn provider_attempt_definition_sha256(
    attempt: &ProviderAttemptAggregate,
) -> Result<String, serde_json::Error> {
    canonical_sha256(&serde_json::to_value(attempt.definition())?)
}

pub fn provider_attempt_evidence_sha256(
    attempt: &ProviderAttemptAggregate,
) -> Result<String, serde_json::Error> {
    let legacy = serde_json::json!({
        "attemptId": attempt.attempt_id(),
        "aggregateSequence": attempt.aggregate_sequence(),
        "state": attempt.state(),
        "definition": attempt.definition(),
        "dispatchId": attempt.dispatch_id(),
        "response": attempt.response_receipt(),
        "responseTextSha256": attempt.response_text_sha256(),
        "toolCalls": attempt.tool_calls(),
        "failure": attempt.failure(),
    });
    let grant = attempt.provider_effect_grant();
    let cancellation = attempt.cancelled_before_sent();
    if grant.is_none() && cancellation.is_none() {
        return canonical_sha256(&legacy);
    }
    let mut versioned = legacy
        .as_object()
        .cloned()
        .unwrap_or_else(|| unreachable!("legacy attempt evidence is always an object"));
    let schema_version = if cancellation.is_some() {
        CANCELLED_BEFORE_SENT_EVIDENCE_SCHEMA_VERSION
    } else {
        AUTHORIZED_EVIDENCE_SCHEMA_VERSION
    };
    versioned.insert(
        "schemaVersion".to_owned(),
        serde_json::json!(schema_version),
    );
    if let Some(grant) = grant {
        versioned.insert("grant".to_owned(), serde_json::to_value(grant)?);
    }
    if let Some(cancellation) = cancellation {
        versioned.insert(
            "cancelledBeforeSent".to_owned(),
            serde_json::to_value(cancellation)?,
        );
    }
    canonical_sha256(&serde_json::Value::Object(versioned))
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
    #[error("provider cancellation-before-send evidence is invalid")]
    CancellationEvidenceInvalid,
    #[error("provider effect grant receipt is invalid: {0}")]
    ProviderEffectGrantInvalid(#[source] ProviderEffectCapabilityError),
    #[error("provider effect grant does not match the Requested Provider attempt evidence")]
    ProviderEffectGrantMismatch,
    #[error(
        "provider dispatch durable boundary was already crossed; the effect cannot be re-armed"
    )]
    DispatchAlreadyCrossed,
    #[error("provider effect could not be armed from the exact persisted grant receipt: {0}")]
    ProviderEffectArmFailed(#[source] ProviderEffectCapabilityError),
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum AuthorizedSentEventPayload {
    Sent {
        definition: ProviderAttemptDefinition,
        dispatch_id: String,
        grant: ProviderEffectGrantReceipt,
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum CancelledBeforeSentEventPayload {
    CancelledBeforeSent {
        definition: ProviderAttemptDefinition,
        cancellation: ProviderAttemptCancelledBeforeSent,
    },
}

fn replay(
    run_id: &str,
    attempt_id: &str,
    events: &[RuntimeEvent],
) -> Result<ProviderAttemptAggregate, ProviderAttemptError> {
    let first = events.first().ok_or(ProviderAttemptError::InvalidHistory)?;
    validate_event_address(first, run_id, attempt_id, 1)?;
    if first.event_version != LEGACY_EVENT_VERSION {
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
        requested_message_id: first.message_id.clone(),
        requested_idempotency_key: first.idempotency_key.clone(),
        requested_at: first.created_at.clone(),
        definition,
        state: ProviderAttemptState::Requested,
        aggregate_sequence: 1,
        dispatch_id: None,
        provider_effect_grant: None,
        response: None,
        response_text: None,
        response_text_sha256: None,
        tool_calls: Vec::new(),
        failure: None,
        cancelled_before_sent: None,
    };
    for event in &events[1..] {
        validate_event_address(event, run_id, attempt_id, aggregate.aggregate_sequence + 1)?;
        match event.event_version {
            LEGACY_EVENT_VERSION => replay_legacy_event(&mut aggregate, event)?,
            AUTHORIZED_SENT_EVENT_VERSION => replay_authorized_sent(&mut aggregate, event)?,
            CANCELLED_BEFORE_SENT_EVENT_VERSION => {
                replay_cancelled_before_sent(&mut aggregate, event)?
            }
            version => return Err(ProviderAttemptError::UnknownEventVersion(version)),
        }
        aggregate.aggregate_sequence = event.aggregate_sequence;
    }
    Ok(aggregate)
}

fn replay_legacy_event(
    aggregate: &mut ProviderAttemptAggregate,
    event: &RuntimeEvent,
) -> Result<(), ProviderAttemptError> {
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
            let expected_hash = validate_response_output(response_text.as_deref(), &tool_calls)?;
            if expected_hash != response_text_sha256 {
                return Err(ProviderAttemptError::ResponseInvalid);
            }
            aggregate.state = ProviderAttemptState::Responded;
            aggregate.response = Some(response);
            aggregate.response_text = response_text;
            aggregate.response_text_sha256 = response_text_sha256;
            aggregate.tool_calls = tool_calls;
        }
        (ProviderAttemptState::Sent, "provider.failed", EventPayload::Failed { failure, .. })
            if failure.delivery_certainty == ProviderDeliveryCertainty::ResponseReceived =>
        {
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
    Ok(())
}

fn replay_cancelled_before_sent(
    aggregate: &mut ProviderAttemptAggregate,
    event: &RuntimeEvent,
) -> Result<(), ProviderAttemptError> {
    if aggregate.state != ProviderAttemptState::Requested
        || event.event_type != "provider.cancelled_before_sent"
    {
        return Err(ProviderAttemptError::InvalidHistory);
    }
    let CancelledBeforeSentEventPayload::CancelledBeforeSent {
        definition,
        cancellation,
    } = serde_json::from_value(event.payload.clone())?;
    if definition != aggregate.definition {
        return Err(ProviderAttemptError::IdentityConflict);
    }
    if event.idempotency_key
        != cancelled_before_sent_idempotency_key(&aggregate.attempt_id, &cancellation)
        || cancellation
            .cancellation_expected_run_sequence
            .checked_add(1)
            != Some(event.run_sequence)
    {
        return Err(ProviderAttemptError::CancellationEvidenceInvalid);
    }
    validate_cancelled_before_sent(aggregate, &cancellation, None)?;
    aggregate.state = ProviderAttemptState::CancelledBeforeSent;
    aggregate.cancelled_before_sent = Some(cancellation);
    Ok(())
}

fn replay_authorized_sent(
    aggregate: &mut ProviderAttemptAggregate,
    event: &RuntimeEvent,
) -> Result<(), ProviderAttemptError> {
    if aggregate.state != ProviderAttemptState::Requested || event.event_type != "provider.sent" {
        return Err(ProviderAttemptError::InvalidHistory);
    }
    let AuthorizedSentEventPayload::Sent {
        definition,
        dispatch_id,
        grant,
    } = serde_json::from_value(event.payload.clone())?;
    if definition != aggregate.definition {
        return Err(ProviderAttemptError::IdentityConflict);
    }
    let dispatch_uuid = Uuid::parse_str(&dispatch_id)
        .map_err(|_| ProviderAttemptError::ProviderEffectGrantMismatch)?;
    validate_authorized_sent(aggregate, &grant, dispatch_uuid)?;
    aggregate.state = ProviderAttemptState::Sent;
    aggregate.dispatch_id = Some(dispatch_id);
    aggregate.provider_effect_grant = Some(grant);
    Ok(())
}

fn validate_cancelled_before_sent(
    attempt: &ProviderAttemptAggregate,
    cancellation: &ProviderAttemptCancelledBeforeSent,
    expected_run_sequence: Option<u64>,
) -> Result<(), ProviderAttemptError> {
    if attempt.state != ProviderAttemptState::Requested
        || !is_sha256(&cancellation.cancellation_intent_id)
        || expected_run_sequence
            .is_some_and(|expected| expected != cancellation.cancellation_expected_run_sequence)
        || cancellation.requested_aggregate_sequence != attempt.aggregate_sequence
        || cancellation.requested_definition_sha256 != provider_attempt_definition_sha256(attempt)?
        || cancellation.requested_evidence_sha256 != provider_attempt_evidence_sha256(attempt)?
    {
        return Err(ProviderAttemptError::CancellationEvidenceInvalid);
    }
    Ok(())
}

fn cancelled_before_sent_idempotency_key(
    attempt_id: &str,
    cancellation: &ProviderAttemptCancelledBeforeSent,
) -> String {
    format!(
        "provider:{attempt_id}:cancel-before-sent:{}:{}",
        cancellation.cancellation_intent_id, cancellation.requested_evidence_sha256
    )
}

fn validate_authorized_sent(
    attempt: &ProviderAttemptAggregate,
    receipt: &ProviderEffectGrantReceipt,
    dispatch_id: Uuid,
) -> Result<(), ProviderAttemptError> {
    receipt
        .validate()
        .map_err(ProviderAttemptError::ProviderEffectGrantInvalid)?;
    let material = receipt.material();
    let run_id = Uuid::parse_str(&attempt.run_id)
        .map_err(|_| ProviderAttemptError::ProviderEffectGrantMismatch)?;
    let inference_id = Uuid::parse_str(&attempt.definition.inference_id)
        .map_err(|_| ProviderAttemptError::ProviderEffectGrantMismatch)?;
    let attempt_id = Uuid::parse_str(&attempt.attempt_id)
        .map_err(|_| ProviderAttemptError::ProviderEffectGrantMismatch)?;
    if dispatch_id != receipt.dispatch_id()
        || material.run_id != run_id
        || material.inference_id != inference_id
        || material.attempt_id != attempt_id
        || material.invocation_id != attempt.definition.invocation_id
        || material.request_number != attempt.definition.request_number
        || material.attempt_number != attempt.definition.attempt_number
        || material.attempt_aggregate_sequence != attempt.aggregate_sequence
        || material.attempt_definition_sha256 != provider_attempt_definition_sha256(attempt)?
        || material.attempt_evidence_sha256 != provider_attempt_evidence_sha256(attempt)?
        || material.context_compilation_id != attempt.definition.context_compilation_id
        || material.canonical_context_sha256 != attempt.definition.canonical_context_sha256
        || material.transport_payload_sha256 != attempt.definition.transport_payload_sha256
        || material.provider != attempt.definition.provider
    {
        return Err(ProviderAttemptError::ProviderEffectGrantMismatch);
    }
    if let ProviderEffectAuthorityBinding::InitialAgentLoop(binding) = &material.authority
        && (binding.requested_message_id != attempt.requested_message_id
            || binding.requested_idempotency_key_sha256
                != attempt.requested_idempotency_key_sha256()
            || binding.requested_at != attempt.requested_at)
    {
        return Err(ProviderAttemptError::ProviderEffectGrantMismatch);
    }
    Ok(())
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
    let retry_after_matches = match (&failure.retry_after, failure.retry_after_ms) {
        (Some(receipt), Some(delay_ms)) => {
            receipt.delay_ms == delay_ms && is_sha256(&receipt.value_sha256)
        }
        (None, None) => true,
        _ => false,
    };
    if failure.code.trim().is_empty()
        || failure.delivery_certainty == ProviderDeliveryCertainty::Unknown
        || !retry_after_matches
        || (!failure.retryable
            && (failure.retry_after_ms.is_some() || failure.retry_after.is_some()))
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
    event_with_version(
        run_id,
        attempt_id,
        metadata,
        event_type,
        LEGACY_EVENT_VERSION,
        payload,
    )
}

fn event_with_version<T: Serialize>(
    run_id: &str,
    attempt_id: &str,
    metadata: ProviderAttemptMetadata<'_>,
    event_type: &str,
    event_version: u32,
    payload: T,
) -> Result<NewRuntimeEvent, serde_json::Error> {
    Ok(NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: AGGREGATE_TYPE.to_owned(),
        aggregate_id: attempt_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: metadata.idempotency_key.to_owned(),
        event_type: event_type.to_owned(),
        event_version,
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

fn canonical_sha256(value: &serde_json::Value) -> Result<String, serde_json::Error> {
    fn canonicalize(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(canonicalize).collect())
            }
            serde_json::Value::Object(values) => {
                let mut entries = values.into_iter().collect::<Vec<_>>();
                entries.sort_by(|left, right| left.0.cmp(&right.0));
                serde_json::Value::Object(
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

#[cfg(test)]
mod authorized_sent_tests {
    use std::sync::Arc;

    use tempfile::TempDir;
    use time::{OffsetDateTime, format_description::well_known::Rfc3339};

    use super::*;
    use crate::{
        provider_effect_capability::{
            InitialAgentLoopAuthorityBinding, ProviderEffectAuthorityBinding,
            ProviderEffectCapability, ProviderEffectGrantMaterial, ProviderEffectGrantReceipt,
            canonical_database_path_sha256,
        },
        workspace_event_journal::WorkspaceEventJournal,
        workspace_runtime_lease::WorkspaceRuntimeLease,
    };

    const RUN_ID: &str = "11111111-1111-4111-8111-111111111111";
    const INFERENCE_ID: &str = "22222222-2222-4222-8222-222222222222";
    const ATTEMPT_ID: &str = "33333333-3333-4333-8333-333333333333";
    const CONTEXT_ID: &str = "44444444-4444-4444-8444-444444444444";
    const CONTEXT_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const PAYLOAD_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ISSUED_AT: &str = "2026-07-12T00:00:00Z";

    #[test]
    fn authorized_sent_v2_persists_exact_grant_and_replays_through_v1_terminal() {
        let fixture = AuthorizedFixture::new();
        let mut journal = fixture.open();
        let mut attempt = create_attempt(&mut journal);
        let legacy_evidence = provider_attempt_evidence_sha256(&attempt).unwrap();
        let material = grant_material(&fixture, &attempt);
        let consumed = consume(&fixture, material);

        let armed = attempt
            .mark_sent_authorized(
                &mut journal,
                consumed,
                1,
                1,
                metadata("sent-v2-message", "sent-v2-key"),
            )
            .unwrap();
        assert_eq!(attempt.state(), ProviderAttemptState::Sent);
        assert_eq!(
            attempt.dispatch_id(),
            Some(armed.receipt().dispatch_id().to_string().as_str())
        );
        assert_eq!(attempt.provider_effect_grant(), Some(armed.receipt()));
        assert_ne!(
            provider_attempt_evidence_sha256(&attempt).unwrap(),
            legacy_evidence
        );
        let events = journal
            .read_aggregate(RUN_ID, AGGREGATE_TYPE, ATTEMPT_ID, 0)
            .unwrap();
        assert_eq!(events[0].event_version, LEGACY_EVENT_VERSION);
        assert_eq!(events[1].event_version, AUTHORIZED_SENT_EVENT_VERSION);
        assert_eq!(
            events[1].payload["grant"],
            serde_json::to_value(armed.receipt()).unwrap()
        );

        attempt
            .respond_with_output(
                &mut journal,
                2,
                response_receipt(),
                Some("done".to_owned()),
                vec![],
                metadata("responded-message", "responded-key"),
            )
            .unwrap();
        drop(journal);

        let journal = fixture.open();
        let recovered = ProviderAttemptAggregate::recover(&journal, RUN_ID, ATTEMPT_ID).unwrap();
        assert_eq!(recovered.state(), ProviderAttemptState::Responded);
        assert_eq!(recovered.provider_effect_grant(), Some(armed.receipt()));
        assert_eq!(
            journal
                .read_aggregate(RUN_ID, AGGREGATE_TYPE, ATTEMPT_ID, 0)
                .unwrap()
                .iter()
                .map(|event| event.event_version)
                .collect::<Vec<_>>(),
            vec![1, 2, 1]
        );
    }

    #[test]
    fn authorized_sent_never_rearms_an_idempotently_existing_boundary() {
        let fixture = AuthorizedFixture::new();
        let mut journal = fixture.open();
        let mut attempt = create_attempt(&mut journal);
        let mut stale = attempt.clone();
        let material = grant_material(&fixture, &attempt);
        let first = consume(&fixture, material.clone());
        let second = consume(&fixture, material);
        let sent_metadata = metadata("sent-v2-message", "sent-v2-key");

        attempt
            .mark_sent_authorized(&mut journal, first, 1, 1, sent_metadata)
            .unwrap();
        let error = stale
            .mark_sent_authorized(&mut journal, second, 1, 1, sent_metadata)
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderAttemptError::DispatchAlreadyCrossed
        ));
        assert_eq!(stale.state(), ProviderAttemptState::Requested);
        assert_eq!(
            journal
                .read_aggregate(RUN_ID, AGGREGATE_TYPE, ATTEMPT_ID, 0)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn authorized_sent_requires_current_run_and_global_fences_after_other_run_event() {
        let fixture = AuthorizedFixture::new();
        let mut journal = fixture.open();
        let mut attempt = create_attempt(&mut journal);
        journal
            .append(
                NewRuntimeEvent {
                    run_id: RUN_ID.to_owned(),
                    aggregate_type: "provider_retry".to_owned(),
                    aggregate_id: INFERENCE_ID.to_owned(),
                    message_id: "retry-message".to_owned(),
                    idempotency_key: "retry-key".to_owned(),
                    event_type: "provider.retry.attempt_requested".to_owned(),
                    event_version: 1,
                    payload: serde_json::json!({"evidence": "persisted"}),
                    created_at: ISSUED_AT.to_owned(),
                },
                1,
                0,
            )
            .unwrap();
        let material = grant_material(&fixture, &attempt);
        let stale_global_fence = consume(&fixture, material.clone());
        let error = attempt
            .mark_sent_authorized(
                &mut journal,
                stale_global_fence,
                2,
                1,
                metadata("sent-v2-global-message", "sent-v2-global-key"),
            )
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderAttemptError::Journal(EventJournalError::GlobalSequenceConflict { .. })
        ));
        assert_eq!(attempt.state(), ProviderAttemptState::Requested);

        let stale_fence = consume(&fixture, material.clone());
        let error = attempt
            .mark_sent_authorized(
                &mut journal,
                stale_fence,
                1,
                2,
                metadata("sent-v2-message", "sent-v2-key"),
            )
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderAttemptError::Journal(EventJournalError::RunSequenceConflict { .. })
        ));
        assert_eq!(attempt.state(), ProviderAttemptState::Requested);

        let current_fences = consume(&fixture, material);
        attempt
            .mark_sent_authorized(
                &mut journal,
                current_fences,
                2,
                2,
                metadata("sent-v2-message-2", "sent-v2-key-2"),
            )
            .unwrap();
        assert_eq!(attempt.state(), ProviderAttemptState::Sent);
    }

    #[test]
    fn authorized_sent_rejects_valid_receipt_for_different_attempt_evidence_without_append() {
        let fixture = AuthorizedFixture::new();
        let mut journal = fixture.open();
        let mut attempt = create_attempt(&mut journal);
        let mut material = grant_material(&fixture, &attempt);
        material.attempt_evidence_sha256 = "9".repeat(64);
        let consumed = consume(&fixture, material);

        let error = attempt
            .mark_sent_authorized(
                &mut journal,
                consumed,
                1,
                1,
                metadata("sent-v2-message", "sent-v2-key"),
            )
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderAttemptError::ProviderEffectGrantMismatch
        ));
        assert_eq!(attempt.state(), ProviderAttemptState::Requested);
        assert_eq!(
            journal
                .read_aggregate(RUN_ID, AGGREGATE_TYPE, ATTEMPT_ID, 0)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn replay_rejects_v2_tampering_and_missing_grant() {
        for case in ["invalid_receipt", "mismatched_evidence", "missing_grant"] {
            let fixture = AuthorizedFixture::new();
            let mut journal = fixture.open();
            let attempt = create_attempt(&mut journal);
            let mut material = grant_material(&fixture, &attempt);
            if case == "mismatched_evidence" {
                material.attempt_evidence_sha256 = "9".repeat(64);
            }
            let receipt = ProviderEffectGrantReceipt::derive(material).unwrap();
            let mut payload = serde_json::json!({
                "kind": "sent",
                "definition": attempt.definition(),
                "dispatch_id": receipt.dispatch_id().to_string(),
                "grant": receipt,
            });
            if case == "invalid_receipt" {
                payload["grant"]["grantSha256"] = serde_json::json!("0".repeat(64));
            } else if case == "missing_grant" {
                payload.as_object_mut().unwrap().remove("grant");
            }
            journal
                .append(
                    NewRuntimeEvent {
                        run_id: RUN_ID.to_owned(),
                        aggregate_type: AGGREGATE_TYPE.to_owned(),
                        aggregate_id: ATTEMPT_ID.to_owned(),
                        message_id: "sent-v2-message".to_owned(),
                        idempotency_key: "sent-v2-key".to_owned(),
                        event_type: "provider.sent".to_owned(),
                        event_version: AUTHORIZED_SENT_EVENT_VERSION,
                        payload,
                        created_at: ISSUED_AT.to_owned(),
                    },
                    1,
                    1,
                )
                .unwrap();
            drop(journal);

            let journal = fixture.open();
            assert!(
                ProviderAttemptAggregate::recover(&journal, RUN_ID, ATTEMPT_ID).is_err(),
                "{case} must fail closed"
            );
        }
    }

    #[test]
    fn legacy_evidence_hashes_remain_golden_without_grant() {
        let fixture = AuthorizedFixture::new();
        let mut journal = fixture.open();
        let mut attempt = create_attempt(&mut journal);
        assert_eq!(
            provider_attempt_evidence_sha256(&attempt).unwrap(),
            "b1c0171158aec899a9a0805ac9411978c2d0788dc86f78d3aba78f498ade8989"
        );
        attempt
            .mark_sent(
                &mut journal,
                1,
                "legacy-dispatch",
                metadata("legacy-sent-message", "legacy-sent-key"),
            )
            .unwrap();
        assert_eq!(attempt.provider_effect_grant(), None);
        assert_eq!(
            provider_attempt_evidence_sha256(&attempt).unwrap(),
            "bfda511a0718f42dae7f622734deaa7e4bbbb5162ea05c056f5476729007949b"
        );
    }

    fn create_attempt(journal: &mut EventJournal) -> ProviderAttemptAggregate {
        ProviderAttemptAggregate::create(
            journal,
            RUN_ID,
            ATTEMPT_ID,
            definition(),
            0,
            metadata("requested-message", "requested-key"),
        )
        .unwrap()
    }

    fn definition() -> ProviderAttemptDefinition {
        ProviderAttemptDefinition {
            run_id: RUN_ID.to_owned(),
            inference_id: INFERENCE_ID.to_owned(),
            invocation_id: "invocation-1".to_owned(),
            context_compilation_id: Uuid::parse_str(CONTEXT_ID).unwrap(),
            canonical_context_sha256: CONTEXT_HASH.to_owned(),
            transport_payload_sha256: PAYLOAD_HASH.to_owned(),
            provider: ProviderRunIdentity {
                profile_id: "profile-1".to_owned(),
                provider_id: "deepseek".to_owned(),
                model_id: "deepseek-chat".to_owned(),
                config_sha256: "c".repeat(64),
            },
            request_number: 1,
            attempt_number: 1,
            output_reserve_tokens: 8_192,
            request_timeout_ms: 30_000,
            total_deadline_ms: 120_000,
            max_attempts: 3,
            max_total_delay_ms: 30_000,
        }
    }

    fn grant_material(
        fixture: &AuthorizedFixture,
        attempt: &ProviderAttemptAggregate,
    ) -> ProviderEffectGrantMaterial {
        ProviderEffectGrantMaterial {
            schema_version: ProviderEffectGrantMaterial::schema_version(),
            workspace_id: "workspace-1".to_owned(),
            project_id: "project-1".to_owned(),
            database_canonical_path_sha256: canonical_database_path_sha256(&fixture.path).unwrap(),
            lease_epoch: fixture.lease.lease_epoch().to_owned(),
            run_id: Uuid::parse_str(RUN_ID).unwrap(),
            invocation_id: attempt.definition.invocation_id.clone(),
            inference_id: Uuid::parse_str(INFERENCE_ID).unwrap(),
            attempt_id: Uuid::parse_str(ATTEMPT_ID).unwrap(),
            request_number: attempt.definition.request_number,
            attempt_number: attempt.definition.attempt_number,
            attempt_aggregate_sequence: attempt.aggregate_sequence,
            attempt_definition_sha256: provider_attempt_definition_sha256(attempt).unwrap(),
            attempt_evidence_sha256: provider_attempt_evidence_sha256(attempt).unwrap(),
            context_compilation_id: attempt.definition.context_compilation_id,
            canonical_context_sha256: attempt.definition.canonical_context_sha256.clone(),
            transport_payload_sha256: attempt.definition.transport_payload_sha256.clone(),
            provider: attempt.definition.provider.clone(),
            inference_deadline_at: "2026-07-12T00:02:00Z".to_owned(),
            attempt_deadline_at: "2026-07-12T00:01:00Z".to_owned(),
            retry_schedule: None,
            authority: ProviderEffectAuthorityBinding::InitialAgentLoop(
                InitialAgentLoopAuthorityBinding {
                    requested_message_id: attempt.requested_message_id.clone(),
                    requested_idempotency_key_sha256: attempt.requested_idempotency_key_sha256(),
                    requested_at: attempt.requested_at.clone(),
                    agent_loop_aggregate_sequence: 1,
                    agent_loop_checkpoint_sha256: "d".repeat(64),
                    pending_inference_sha256: "e".repeat(64),
                },
            ),
            issued_at: ISSUED_AT.to_owned(),
        }
    }

    fn consume(
        fixture: &AuthorizedFixture,
        material: ProviderEffectGrantMaterial,
    ) -> ConsumedProviderEffect {
        let now = OffsetDateTime::parse(ISSUED_AT, &Rfc3339).unwrap();
        let receipt = ProviderEffectGrantReceipt::derive(material.clone()).unwrap();
        ProviderEffectCapability::activate_at(
            receipt,
            &material,
            &fixture.path,
            Arc::clone(&fixture.lease),
            now,
        )
        .unwrap()
        .consume_at(&material, &fixture.path, now)
        .unwrap()
    }

    fn response_receipt() -> ProviderResponseReceipt {
        ProviderResponseReceipt {
            http_status: 200,
            actual_provider_id: "deepseek".to_owned(),
            actual_model_id: "deepseek-chat".to_owned(),
            response_id_sha256: Some("f".repeat(64)),
            response_body_sha256: "1".repeat(64),
            stop_reason: "stop".to_owned(),
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
        }
    }

    fn metadata<'a>(message_id: &'a str, idempotency_key: &'a str) -> ProviderAttemptMetadata<'a> {
        ProviderAttemptMetadata {
            message_id,
            idempotency_key,
            created_at: ISSUED_AT,
            reason: None,
        }
    }

    struct AuthorizedFixture {
        _temp: TempDir,
        path: std::path::PathBuf,
        lease: Arc<WorkspaceRuntimeLease>,
    }

    impl AuthorizedFixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("runtime.db");
            drop(WorkspaceEventJournal::open(&path).unwrap());
            let lease =
                Arc::new(WorkspaceRuntimeLease::acquire(&path, "provider-attempt-test").unwrap());
            Self {
                _temp: temp,
                path,
                lease,
            }
        }

        fn open(&self) -> EventJournal {
            EventJournal::open(&self.path).unwrap()
        }
    }
}
