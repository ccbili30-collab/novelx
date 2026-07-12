use std::collections::BTreeMap;

use novelx_protocol::ProviderRunIdentity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    event_journal::{EventJournal, EventJournalError, NewRuntimeEvent, RuntimeEvent},
    provider_attempt::{ProviderAttemptFailure, ProviderDeliveryCertainty},
};

const AGGREGATE_TYPE: &str = "provider_retry";
const EVENT_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRetryPolicyAlgorithm {
    ExponentialFullJitterV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExponentialFullJitterPolicy {
    pub algorithm: ProviderRetryPolicyAlgorithm,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
    pub max_attempts: u16,
    pub max_total_delay_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRetryDefinition {
    pub run_id: String,
    pub invocation_id: String,
    pub inference_id: String,
    pub request_number: u64,
    pub context_compilation_id: Uuid,
    pub provider: ProviderRunIdentity,
    pub canonical_context_sha256: String,
    pub transport_payload_sha256: String,
    pub first_attempt_id: Uuid,
    pub first_attempt_number: u16,
    pub started_at: String,
    pub deadline_at: String,
    pub request_timeout_ms: u64,
    pub total_deadline_ms: u64,
    pub policy: ExponentialFullJitterPolicy,
    pub policy_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRetryFailureObservation {
    pub attempt_id: Uuid,
    pub attempt_number: u16,
    pub attempt_aggregate_sequence: u64,
    pub attempt_definition_sha256: String,
    pub evidence_sha256: String,
    pub failure: ProviderAttemptFailure,
    pub observed_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRetrySchedule {
    pub schedule_id: Uuid,
    pub schedule_sha256: String,
    pub parent_failure_evidence_sha256: String,
    pub parent_failure_observation_sha256: String,
    pub next_attempt_id: Uuid,
    pub next_attempt_number: u16,
    pub delay_cap_ms: u64,
    pub jitter_delay_ms: u64,
    pub retry_after_ms: Option<u64>,
    pub selected_delay_ms: u64,
    pub cumulative_delay_ms: u64,
    pub scheduled_at: String,
    pub not_before: String,
    pub attempt_deadline_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRetryAttemptEvidence {
    pub attempt_id: Uuid,
    pub attempt_number: u16,
    pub attempt_aggregate_sequence: u64,
    pub attempt_definition_sha256: String,
    pub evidence_sha256: String,
    pub observed_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRetryExhaustionReason {
    MaxAttempts,
    MaxTotalDelay,
    DeadlineExceeded,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRetryExhaustion {
    pub reason: ProviderRetryExhaustionReason,
    pub evidence_sha256: String,
    pub exhausted_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRetryState {
    FailureObserved,
    Scheduled,
    Materializing,
    AwaitingAttempt,
    Succeeded,
    FailedTerminal,
    OutcomeUnknown,
    Cancelled,
    Exhausted,
}

#[derive(Clone, Copy)]
pub struct ProviderRetryMetadata<'a> {
    pub message_id: &'a str,
    pub idempotency_key: &'a str,
    pub created_at: &'a str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderRetryAggregate {
    run_id: String,
    inference_id: String,
    definition: ProviderRetryDefinition,
    definition_sha256: String,
    state: ProviderRetryState,
    aggregate_sequence: u64,
    failure_observation: Option<ProviderRetryFailureObservation>,
    schedule: Option<ProviderRetrySchedule>,
    materializing_at: Option<String>,
    awaiting_at: Option<String>,
    terminal_evidence: Option<ProviderRetryAttemptEvidence>,
    terminal_failure: Option<ProviderRetryFailureObservation>,
    exhaustion: Option<ProviderRetryExhaustion>,
    cumulative_delay_ms: u64,
    idempotent_events: BTreeMap<String, (String, Value)>,
}

impl ProviderRetryAggregate {
    pub fn create(
        journal: &mut EventJournal,
        definition: ProviderRetryDefinition,
        failure: ProviderRetryFailureObservation,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<Self, ProviderRetryError> {
        validate_definition(&definition)?;
        validate_failure_observation(&failure)?;
        if failure.attempt_id != definition.first_attempt_id
            || failure.attempt_number != definition.first_attempt_number
        {
            return Err(ProviderRetryError::AttemptIdentityInvalid);
        }
        validate_observation_time(&definition, &failure.observed_at, None)?;
        validate_metadata(metadata)?;
        let definition_sha256 = provider_retry_definition_sha256(&definition)?;
        let payload = EventPayload::FailureObserved {
            definition: definition.clone(),
            definition_sha256,
            failure: failure.clone(),
            cumulative_delay_ms: 0,
        };
        let payload_value = serde_json::to_value(&payload)?;
        let existing = journal.read_aggregate(
            &definition.run_id,
            AGGREGATE_TYPE,
            &definition.inference_id,
            0,
        )?;
        if !existing.is_empty() {
            let recovered = replay(&definition.run_id, &definition.inference_id, &existing)?;
            if recovered.definition == definition
                && existing[0].idempotency_key == metadata.idempotency_key
                && existing[0].event_type == "provider.retry.failure_observed"
                && existing[0].payload == payload_value
            {
                return Ok(recovered);
            }
            return Err(ProviderRetryError::IdentityConflict);
        }
        journal.append(
            new_event(
                &definition.run_id,
                &definition.inference_id,
                "provider.retry.failure_observed",
                payload_value,
                metadata,
            ),
            expected_run_sequence,
            0,
        )?;
        Self::recover(journal, &definition.run_id, &definition.inference_id)
    }

    pub fn recover(
        journal: &EventJournal,
        run_id: &str,
        inference_id: &str,
    ) -> Result<Self, ProviderRetryError> {
        replay(
            run_id,
            inference_id,
            &journal.read_aggregate(run_id, AGGREGATE_TYPE, inference_id, 0)?,
        )
    }

    pub const fn state(&self) -> ProviderRetryState {
        self.state
    }

    pub const fn definition(&self) -> &ProviderRetryDefinition {
        &self.definition
    }

    pub fn definition_sha256(&self) -> &str {
        &self.definition_sha256
    }

    pub const fn aggregate_sequence(&self) -> u64 {
        self.aggregate_sequence
    }

    pub const fn failure_observation(&self) -> Option<&ProviderRetryFailureObservation> {
        self.failure_observation.as_ref()
    }

    pub const fn cumulative_delay_ms(&self) -> u64 {
        self.cumulative_delay_ms
    }

    pub const fn schedule(&self) -> Option<&ProviderRetrySchedule> {
        self.schedule.as_ref()
    }

    pub fn materializing_at(&self) -> Option<&str> {
        self.materializing_at.as_deref()
    }

    pub fn awaiting_at(&self) -> Option<&str> {
        self.awaiting_at.as_deref()
    }

    pub const fn terminal_evidence(&self) -> Option<&ProviderRetryAttemptEvidence> {
        self.terminal_evidence.as_ref()
    }

    pub const fn terminal_failure(&self) -> Option<&ProviderRetryFailureObservation> {
        self.terminal_failure.as_ref()
    }

    pub const fn exhaustion(&self) -> Option<&ProviderRetryExhaustion> {
        self.exhaustion.as_ref()
    }

    pub fn schedule_retry(
        &mut self,
        journal: &mut EventJournal,
        schedule: ProviderRetrySchedule,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        let payload = EventPayload::Scheduled {
            definition: self.definition.clone(),
            definition_sha256: self.definition_sha256.clone(),
            schedule: schedule.clone(),
        };
        if self.is_idempotent_candidate("provider.retry.scheduled", &payload, metadata)? {
            return Ok(());
        }
        let failure = self
            .failure_observation
            .as_ref()
            .ok_or(ProviderRetryError::InvalidHistory)?;
        let expected = derive_retry_schedule(
            &self.definition,
            failure,
            self.cumulative_delay_ms,
            &schedule.scheduled_at,
        )?;
        if schedule != expected {
            return Err(ProviderRetryError::ScheduleInvalid);
        }
        self.append_transition(
            journal,
            ProviderRetryState::FailureObserved,
            "provider.retry.scheduled",
            payload,
            expected_run_sequence,
            metadata,
        )
    }

    pub fn begin_materializing(
        &mut self,
        journal: &mut EventJournal,
        materializing_at: &str,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        let schedule = self
            .schedule
            .as_ref()
            .ok_or(ProviderRetryError::InvalidHistory)?;
        validate_between(
            materializing_at,
            &schedule.not_before,
            &schedule.attempt_deadline_at,
        )?;
        let payload = EventPayload::Materializing {
            definition: self.definition.clone(),
            definition_sha256: self.definition_sha256.clone(),
            schedule: schedule.clone(),
            materializing_at: materializing_at.to_owned(),
        };
        self.append_transition(
            journal,
            ProviderRetryState::Scheduled,
            "provider.retry.materializing",
            payload,
            expected_run_sequence,
            metadata,
        )
    }

    pub fn mark_awaiting_attempt(
        &mut self,
        journal: &mut EventJournal,
        awaiting_at: &str,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        let schedule = self
            .schedule
            .as_ref()
            .ok_or(ProviderRetryError::InvalidHistory)?;
        let lower = self
            .materializing_at
            .as_deref()
            .ok_or(ProviderRetryError::InvalidHistory)?;
        validate_between(awaiting_at, lower, &schedule.attempt_deadline_at)?;
        let payload = EventPayload::AwaitingAttempt {
            definition: self.definition.clone(),
            definition_sha256: self.definition_sha256.clone(),
            schedule: schedule.clone(),
            awaiting_at: awaiting_at.to_owned(),
        };
        self.append_transition(
            journal,
            ProviderRetryState::Materializing,
            "provider.retry.awaiting_attempt",
            payload,
            expected_run_sequence,
            metadata,
        )
    }

    pub fn observe_retryable_failure(
        &mut self,
        journal: &mut EventJournal,
        failure: ProviderRetryFailureObservation,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        validate_failure_observation(&failure)?;
        let payload = EventPayload::FailureObserved {
            definition: self.definition.clone(),
            definition_sha256: self.definition_sha256.clone(),
            failure: failure.clone(),
            cumulative_delay_ms: self.cumulative_delay_ms,
        };
        if self.is_idempotent_candidate("provider.retry.failure_observed", &payload, metadata)? {
            return Ok(());
        }
        self.validate_awaited_failure(&failure)?;
        self.append_transition(
            journal,
            ProviderRetryState::AwaitingAttempt,
            "provider.retry.failure_observed",
            payload,
            expected_run_sequence,
            metadata,
        )
    }

    pub fn mark_succeeded(
        &mut self,
        journal: &mut EventJournal,
        evidence: ProviderRetryAttemptEvidence,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        self.record_attempt_terminal(
            journal,
            ProviderRetryState::Succeeded,
            "provider.retry.succeeded",
            evidence,
            expected_run_sequence,
            metadata,
        )
    }

    pub fn mark_outcome_unknown(
        &mut self,
        journal: &mut EventJournal,
        evidence: ProviderRetryAttemptEvidence,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        self.record_attempt_terminal(
            journal,
            ProviderRetryState::OutcomeUnknown,
            "provider.retry.outcome_unknown",
            evidence,
            expected_run_sequence,
            metadata,
        )
    }

    pub fn mark_cancelled(
        &mut self,
        journal: &mut EventJournal,
        evidence: ProviderRetryAttemptEvidence,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        self.record_attempt_terminal(
            journal,
            ProviderRetryState::Cancelled,
            "provider.retry.cancelled",
            evidence,
            expected_run_sequence,
            metadata,
        )
    }

    pub fn mark_failed_terminal(
        &mut self,
        journal: &mut EventJournal,
        failure: ProviderRetryFailureObservation,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        validate_terminal_failure(&failure)?;
        self.validate_awaited_attempt(
            failure.attempt_id,
            failure.attempt_number,
            failure.attempt_aggregate_sequence,
            &failure.attempt_definition_sha256,
            &failure.evidence_sha256,
            &failure.observed_at,
        )?;
        let payload = EventPayload::FailedTerminal {
            definition: self.definition.clone(),
            definition_sha256: self.definition_sha256.clone(),
            failure,
        };
        self.append_transition(
            journal,
            ProviderRetryState::AwaitingAttempt,
            "provider.retry.failed_terminal",
            payload,
            expected_run_sequence,
            metadata,
        )
    }

    pub fn mark_exhausted(
        &mut self,
        journal: &mut EventJournal,
        exhaustion: ProviderRetryExhaustion,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        validate_exhaustion(&exhaustion)?;
        let payload = EventPayload::Exhausted {
            definition: self.definition.clone(),
            definition_sha256: self.definition_sha256.clone(),
            exhaustion: exhaustion.clone(),
        };
        if self.is_idempotent_candidate("provider.retry.exhausted", &payload, metadata)? {
            return Ok(());
        }
        match self.state {
            ProviderRetryState::FailureObserved => {
                let failure = self
                    .failure_observation
                    .as_ref()
                    .ok_or(ProviderRetryError::InvalidHistory)?;
                if exhaustion.evidence_sha256 != provider_retry_failure_observation_sha256(failure)?
                {
                    return Err(ProviderRetryError::ExhaustionInvalid);
                }
                let actual = derive_retry_schedule(
                    &self.definition,
                    failure,
                    self.cumulative_delay_ms,
                    &exhaustion.exhausted_at,
                );
                match actual {
                    Err(ProviderRetryError::RetryBudgetExhausted(reason))
                        if reason == exhaustion.reason => {}
                    _ => return Err(ProviderRetryError::ExhaustionInvalid),
                }
            }
            ProviderRetryState::Scheduled => {
                let schedule = self
                    .schedule
                    .as_ref()
                    .ok_or(ProviderRetryError::InvalidHistory)?;
                if exhaustion.reason != ProviderRetryExhaustionReason::DeadlineExceeded
                    || exhaustion.evidence_sha256 != schedule.schedule_sha256
                    || parse_time(&exhaustion.exhausted_at)?
                        < parse_time(&schedule.attempt_deadline_at)?
                {
                    return Err(ProviderRetryError::ExhaustionInvalid);
                }
            }
            _ => return Err(self.transition_error()),
        }
        self.append_transition_from(
            journal,
            &[
                ProviderRetryState::FailureObserved,
                ProviderRetryState::Scheduled,
            ],
            "provider.retry.exhausted",
            payload,
            expected_run_sequence,
            metadata,
        )
    }

    fn record_attempt_terminal(
        &mut self,
        journal: &mut EventJournal,
        state: ProviderRetryState,
        event_type: &str,
        evidence: ProviderRetryAttemptEvidence,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        validate_attempt_evidence(&evidence)?;
        self.validate_awaited_attempt(
            evidence.attempt_id,
            evidence.attempt_number,
            evidence.attempt_aggregate_sequence,
            &evidence.attempt_definition_sha256,
            &evidence.evidence_sha256,
            &evidence.observed_at,
        )?;
        let payload = match state {
            ProviderRetryState::Succeeded => EventPayload::Succeeded {
                definition: self.definition.clone(),
                definition_sha256: self.definition_sha256.clone(),
                evidence,
            },
            ProviderRetryState::OutcomeUnknown => EventPayload::OutcomeUnknown {
                definition: self.definition.clone(),
                definition_sha256: self.definition_sha256.clone(),
                evidence,
            },
            ProviderRetryState::Cancelled => EventPayload::Cancelled {
                definition: self.definition.clone(),
                definition_sha256: self.definition_sha256.clone(),
                evidence,
            },
            _ => return Err(ProviderRetryError::InvalidHistory),
        };
        self.append_transition(
            journal,
            ProviderRetryState::AwaitingAttempt,
            event_type,
            payload,
            expected_run_sequence,
            metadata,
        )
    }

    fn validate_awaited_failure(
        &self,
        failure: &ProviderRetryFailureObservation,
    ) -> Result<(), ProviderRetryError> {
        self.validate_awaited_attempt(
            failure.attempt_id,
            failure.attempt_number,
            failure.attempt_aggregate_sequence,
            &failure.attempt_definition_sha256,
            &failure.evidence_sha256,
            &failure.observed_at,
        )
    }

    fn validate_awaited_attempt(
        &self,
        attempt_id: Uuid,
        attempt_number: u16,
        aggregate_sequence: u64,
        definition_sha256: &str,
        evidence_sha256: &str,
        observed_at: &str,
    ) -> Result<(), ProviderRetryError> {
        let schedule = self
            .schedule
            .as_ref()
            .ok_or(ProviderRetryError::InvalidHistory)?;
        let awaiting_at = self
            .awaiting_at
            .as_deref()
            .ok_or(ProviderRetryError::InvalidHistory)?;
        if attempt_id != schedule.next_attempt_id
            || attempt_number != schedule.next_attempt_number
            || aggregate_sequence == 0
            || !is_sha256(definition_sha256)
            || !is_sha256(evidence_sha256)
        {
            return Err(ProviderRetryError::AttemptIdentityInvalid);
        }
        validate_between(observed_at, awaiting_at, &self.definition.deadline_at)
    }

    fn append_transition(
        &mut self,
        journal: &mut EventJournal,
        from: ProviderRetryState,
        event_type: &str,
        payload: EventPayload,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        self.append_transition_from(
            journal,
            &[from],
            event_type,
            payload,
            expected_run_sequence,
            metadata,
        )
    }

    fn is_idempotent_candidate(
        &self,
        event_type: &str,
        payload: &EventPayload,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<bool, ProviderRetryError> {
        validate_metadata(metadata)?;
        let Some((stored_type, stored_payload)) =
            self.idempotent_events.get(metadata.idempotency_key)
        else {
            return Ok(false);
        };
        if stored_type == event_type && stored_payload == &serde_json::to_value(payload)? {
            Ok(true)
        } else {
            Err(ProviderRetryError::IdempotencyConflict)
        }
    }

    fn append_transition_from(
        &mut self,
        journal: &mut EventJournal,
        from: &[ProviderRetryState],
        event_type: &str,
        payload: EventPayload,
        expected_run_sequence: u64,
        metadata: ProviderRetryMetadata<'_>,
    ) -> Result<(), ProviderRetryError> {
        validate_metadata(metadata)?;
        let value = serde_json::to_value(payload)?;
        if let Some((stored_type, stored_payload)) =
            self.idempotent_events.get(metadata.idempotency_key)
        {
            return if stored_type == event_type && stored_payload == &value {
                Ok(())
            } else {
                Err(ProviderRetryError::IdempotencyConflict)
            };
        }
        if !from.contains(&self.state) {
            return Err(self.transition_error());
        }
        journal.append(
            new_event(
                &self.run_id,
                &self.inference_id,
                event_type,
                value,
                metadata,
            ),
            expected_run_sequence,
            self.aggregate_sequence,
        )?;
        let run_id = self.run_id.clone();
        let inference_id = self.inference_id.clone();
        *self = Self::recover(journal, &run_id, &inference_id)?;
        Ok(())
    }

    fn transition_error(&self) -> ProviderRetryError {
        if matches!(
            self.state,
            ProviderRetryState::Succeeded
                | ProviderRetryState::FailedTerminal
                | ProviderRetryState::OutcomeUnknown
                | ProviderRetryState::Cancelled
                | ProviderRetryState::Exhausted
        ) {
            ProviderRetryError::TerminalState { state: self.state }
        } else {
            ProviderRetryError::TransitionInvalid { state: self.state }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum EventPayload {
    FailureObserved {
        definition: ProviderRetryDefinition,
        definition_sha256: String,
        failure: ProviderRetryFailureObservation,
        cumulative_delay_ms: u64,
    },
    Scheduled {
        definition: ProviderRetryDefinition,
        definition_sha256: String,
        schedule: ProviderRetrySchedule,
    },
    Materializing {
        definition: ProviderRetryDefinition,
        definition_sha256: String,
        schedule: ProviderRetrySchedule,
        materializing_at: String,
    },
    AwaitingAttempt {
        definition: ProviderRetryDefinition,
        definition_sha256: String,
        schedule: ProviderRetrySchedule,
        awaiting_at: String,
    },
    Succeeded {
        definition: ProviderRetryDefinition,
        definition_sha256: String,
        evidence: ProviderRetryAttemptEvidence,
    },
    FailedTerminal {
        definition: ProviderRetryDefinition,
        definition_sha256: String,
        failure: ProviderRetryFailureObservation,
    },
    OutcomeUnknown {
        definition: ProviderRetryDefinition,
        definition_sha256: String,
        evidence: ProviderRetryAttemptEvidence,
    },
    Cancelled {
        definition: ProviderRetryDefinition,
        definition_sha256: String,
        evidence: ProviderRetryAttemptEvidence,
    },
    Exhausted {
        definition: ProviderRetryDefinition,
        definition_sha256: String,
        exhaustion: ProviderRetryExhaustion,
    },
}

impl EventPayload {
    fn definition(&self) -> (&ProviderRetryDefinition, &str) {
        match self {
            Self::FailureObserved {
                definition,
                definition_sha256,
                ..
            }
            | Self::Scheduled {
                definition,
                definition_sha256,
                ..
            }
            | Self::Materializing {
                definition,
                definition_sha256,
                ..
            }
            | Self::AwaitingAttempt {
                definition,
                definition_sha256,
                ..
            }
            | Self::Succeeded {
                definition,
                definition_sha256,
                ..
            }
            | Self::FailedTerminal {
                definition,
                definition_sha256,
                ..
            }
            | Self::OutcomeUnknown {
                definition,
                definition_sha256,
                ..
            }
            | Self::Cancelled {
                definition,
                definition_sha256,
                ..
            }
            | Self::Exhausted {
                definition,
                definition_sha256,
                ..
            } => (definition, definition_sha256),
        }
    }
}

#[derive(Debug, Error)]
pub enum ProviderRetryError {
    #[error("provider retry aggregate identity conflicts with its address or immutable definition")]
    IdentityConflict,
    #[error("provider retry event sequence is not contiguous")]
    SequenceGap,
    #[error("provider retry event version {0} is unsupported")]
    UnknownEventVersion(u32),
    #[error("provider retry event history is invalid")]
    InvalidHistory,
    #[error("provider retry definition is invalid")]
    DefinitionInvalid,
    #[error("provider retry policy is invalid")]
    PolicyInvalid,
    #[error("provider retry failure is not a definite retryable response")]
    FailureNotRetryable,
    #[error("provider retry attempt identity is invalid")]
    AttemptIdentityInvalid,
    #[error("provider retry schedule does not match the deterministic policy")]
    ScheduleInvalid,
    #[error("provider retry budget is exhausted: {0:?}")]
    RetryBudgetExhausted(ProviderRetryExhaustionReason),
    #[error("provider retry exhaustion evidence is invalid")]
    ExhaustionInvalid,
    #[error("provider retry transition is invalid from {state:?}")]
    TransitionInvalid { state: ProviderRetryState },
    #[error("provider retry aggregate is terminal in {state:?}")]
    TerminalState { state: ProviderRetryState },
    #[error("provider retry idempotency key conflicts with a different semantic operation")]
    IdempotencyConflict,
    #[error("provider retry time value or ordering is invalid")]
    TimeInvalid,
    #[error("provider retry SHA-256 evidence is invalid")]
    Sha256Invalid,
    #[error("provider retry metadata is invalid")]
    MetadataInvalid,
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub fn provider_retry_policy_sha256(
    policy: &ExponentialFullJitterPolicy,
) -> Result<String, ProviderRetryError> {
    validate_policy(policy)?;
    hash_json(policy)
}

pub fn provider_retry_definition_sha256(
    definition: &ProviderRetryDefinition,
) -> Result<String, ProviderRetryError> {
    validate_definition(definition)?;
    hash_json(definition)
}

pub fn provider_retry_failure_observation_sha256(
    observation: &ProviderRetryFailureObservation,
) -> Result<String, ProviderRetryError> {
    validate_failure_observation(observation)?;
    hash_json(observation)
}

pub fn derive_retry_schedule(
    definition: &ProviderRetryDefinition,
    failure: &ProviderRetryFailureObservation,
    cumulative_delay_before_ms: u64,
    scheduled_at: &str,
) -> Result<ProviderRetrySchedule, ProviderRetryError> {
    validate_definition(definition)?;
    validate_failure_observation(failure)?;
    let scheduled = parse_time(scheduled_at)?;
    let observed = parse_time(&failure.observed_at)?;
    let deadline = parse_time(&definition.deadline_at)?;
    if scheduled < observed {
        return Err(ProviderRetryError::TimeInvalid);
    }
    let next_attempt_number =
        failure
            .attempt_number
            .checked_add(1)
            .ok_or(ProviderRetryError::RetryBudgetExhausted(
                ProviderRetryExhaustionReason::MaxAttempts,
            ))?;
    if next_attempt_number > definition.policy.max_attempts {
        return Err(ProviderRetryError::RetryBudgetExhausted(
            ProviderRetryExhaustionReason::MaxAttempts,
        ));
    }
    if failure.attempt_number < definition.first_attempt_number {
        return Err(ProviderRetryError::AttemptIdentityInvalid);
    }
    let retry_ordinal = u32::from(failure.attempt_number - definition.first_attempt_number);
    let multiplier = 1_u64.checked_shl(retry_ordinal).unwrap_or(u64::MAX);
    let delay_cap_ms = definition
        .policy
        .initial_delay_ms
        .saturating_mul(multiplier)
        .min(definition.policy.max_delay_ms);
    let parent_failure_observation_sha256 = provider_retry_failure_observation_sha256(failure)?;
    let seed = RetryDerivationSeed {
        inference_id: &definition.inference_id,
        first_attempt_id: definition.first_attempt_id,
        parent_attempt_id: failure.attempt_id,
        parent_attempt_number: failure.attempt_number,
        parent_failure_evidence_sha256: &failure.evidence_sha256,
        parent_failure_observation_sha256: &parent_failure_observation_sha256,
        policy_sha256: &definition.policy_sha256,
        next_attempt_number,
    };
    let seed_bytes = serde_json::to_vec(&seed)?;
    let seed_digest = Sha256::digest(&seed_bytes);
    let jitter_seed = u64::from_be_bytes(seed_digest[..8].try_into().expect("fixed digest"));
    let jitter_delay_ms = if delay_cap_ms == u64::MAX {
        jitter_seed
    } else {
        jitter_seed % (delay_cap_ms + 1)
    };
    let retry_after_ms = failure.failure.retry_after_ms;
    let selected_delay_ms = jitter_delay_ms.max(retry_after_ms.unwrap_or(0));
    let cumulative_delay_ms = cumulative_delay_before_ms
        .checked_add(selected_delay_ms)
        .ok_or(ProviderRetryError::RetryBudgetExhausted(
            ProviderRetryExhaustionReason::MaxTotalDelay,
        ))?;
    if cumulative_delay_ms > definition.policy.max_total_delay_ms {
        return Err(ProviderRetryError::RetryBudgetExhausted(
            ProviderRetryExhaustionReason::MaxTotalDelay,
        ));
    }
    let not_before = checked_add_ms(scheduled, selected_delay_ms)?;
    let attempt_deadline = checked_add_ms(not_before, definition.request_timeout_ms)?;
    if attempt_deadline > deadline {
        return Err(ProviderRetryError::RetryBudgetExhausted(
            ProviderRetryExhaustionReason::DeadlineExceeded,
        ));
    }
    let schedule_id = derive_schedule_id(&seed_bytes);
    let next_attempt_id = derive_next_attempt_id(&seed_bytes);
    let mut schedule = ProviderRetrySchedule {
        schedule_id,
        schedule_sha256: String::new(),
        parent_failure_evidence_sha256: failure.evidence_sha256.clone(),
        parent_failure_observation_sha256,
        next_attempt_id,
        next_attempt_number,
        delay_cap_ms,
        jitter_delay_ms,
        retry_after_ms,
        selected_delay_ms,
        cumulative_delay_ms,
        scheduled_at: format_time(scheduled)?,
        not_before: format_time(not_before)?,
        attempt_deadline_at: format_time(attempt_deadline)?,
    };
    schedule.schedule_sha256 = provider_retry_schedule_sha256(&schedule)?;
    Ok(schedule)
}

pub fn derive_next_attempt_id_for_failure(
    definition: &ProviderRetryDefinition,
    failure: &ProviderRetryFailureObservation,
) -> Result<Uuid, ProviderRetryError> {
    let schedule = derive_retry_schedule(definition, failure, 0, &failure.observed_at)?;
    Ok(schedule.next_attempt_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RetryDerivationSeed<'a> {
    inference_id: &'a str,
    first_attempt_id: Uuid,
    parent_attempt_id: Uuid,
    parent_attempt_number: u16,
    parent_failure_evidence_sha256: &'a str,
    parent_failure_observation_sha256: &'a str,
    policy_sha256: &'a str,
    next_attempt_number: u16,
}

fn derive_next_attempt_id(seed_bytes: &[u8]) -> Uuid {
    const NAMESPACE: Uuid = Uuid::from_u128(0xa36f3c55_00cb_4f66_9fe2_e73dc16ef8cc);
    Uuid::new_v5(&NAMESPACE, seed_bytes)
}

fn derive_schedule_id(seed_bytes: &[u8]) -> Uuid {
    const NAMESPACE: Uuid = Uuid::from_u128(0xc88d25c8_33b1_44a7_957f_5f04c41fb65e);
    Uuid::new_v5(&NAMESPACE, seed_bytes)
}

pub fn provider_retry_schedule_sha256(
    schedule: &ProviderRetrySchedule,
) -> Result<String, ProviderRetryError> {
    let material = ProviderRetryScheduleHashMaterial {
        schedule_id: schedule.schedule_id,
        parent_failure_evidence_sha256: &schedule.parent_failure_evidence_sha256,
        parent_failure_observation_sha256: &schedule.parent_failure_observation_sha256,
        next_attempt_id: schedule.next_attempt_id,
        next_attempt_number: schedule.next_attempt_number,
        delay_cap_ms: schedule.delay_cap_ms,
        jitter_delay_ms: schedule.jitter_delay_ms,
        retry_after_ms: schedule.retry_after_ms,
        selected_delay_ms: schedule.selected_delay_ms,
        cumulative_delay_ms: schedule.cumulative_delay_ms,
        scheduled_at: &schedule.scheduled_at,
        not_before: &schedule.not_before,
        attempt_deadline_at: &schedule.attempt_deadline_at,
    };
    hash_json(&material)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRetryScheduleHashMaterial<'a> {
    schedule_id: Uuid,
    parent_failure_evidence_sha256: &'a str,
    parent_failure_observation_sha256: &'a str,
    next_attempt_id: Uuid,
    next_attempt_number: u16,
    delay_cap_ms: u64,
    jitter_delay_ms: u64,
    retry_after_ms: Option<u64>,
    selected_delay_ms: u64,
    cumulative_delay_ms: u64,
    scheduled_at: &'a str,
    not_before: &'a str,
    attempt_deadline_at: &'a str,
}

fn replay(
    run_id: &str,
    inference_id: &str,
    events: &[RuntimeEvent],
) -> Result<ProviderRetryAggregate, ProviderRetryError> {
    let first = events.first().ok_or(ProviderRetryError::InvalidHistory)?;
    validate_event_address(first, run_id, inference_id, 1)?;
    validate_event_version(first)?;
    if first.event_type != "provider.retry.failure_observed" {
        return Err(ProviderRetryError::InvalidHistory);
    }
    let payload: EventPayload = serde_json::from_value(first.payload.clone())?;
    let EventPayload::FailureObserved {
        definition,
        definition_sha256,
        failure,
        cumulative_delay_ms,
    } = payload
    else {
        return Err(ProviderRetryError::InvalidHistory);
    };
    validate_definition(&definition)?;
    if definition.run_id != run_id
        || definition.inference_id != inference_id
        || definition_sha256 != provider_retry_definition_sha256(&definition)?
        || failure.attempt_id != definition.first_attempt_id
        || failure.attempt_number != definition.first_attempt_number
        || cumulative_delay_ms != 0
    {
        return Err(ProviderRetryError::IdentityConflict);
    }
    validate_failure_observation(&failure)?;
    validate_observation_time(&definition, &failure.observed_at, None)?;
    let mut aggregate = ProviderRetryAggregate {
        run_id: run_id.to_owned(),
        inference_id: inference_id.to_owned(),
        definition,
        definition_sha256,
        state: ProviderRetryState::FailureObserved,
        aggregate_sequence: 1,
        failure_observation: Some(failure),
        schedule: None,
        materializing_at: None,
        awaiting_at: None,
        terminal_evidence: None,
        terminal_failure: None,
        exhaustion: None,
        cumulative_delay_ms,
        idempotent_events: BTreeMap::new(),
    };
    aggregate.idempotent_events.insert(
        first.idempotency_key.clone(),
        (first.event_type.clone(), first.payload.clone()),
    );
    for event in &events[1..] {
        validate_event_address(
            event,
            run_id,
            inference_id,
            aggregate.aggregate_sequence + 1,
        )?;
        validate_event_version(event)?;
        let payload: EventPayload = serde_json::from_value(event.payload.clone())?;
        let (event_definition, event_definition_sha256) = payload.definition();
        if event_definition != &aggregate.definition
            || event_definition_sha256 != aggregate.definition_sha256
            || event_definition_sha256 != provider_retry_definition_sha256(event_definition)?
        {
            return Err(ProviderRetryError::IdentityConflict);
        }
        apply_replayed_event(&mut aggregate, event, payload)?;
        if aggregate
            .idempotent_events
            .insert(
                event.idempotency_key.clone(),
                (event.event_type.clone(), event.payload.clone()),
            )
            .is_some()
        {
            return Err(ProviderRetryError::InvalidHistory);
        }
        aggregate.aggregate_sequence = event.aggregate_sequence;
    }
    Ok(aggregate)
}

fn apply_replayed_event(
    aggregate: &mut ProviderRetryAggregate,
    event: &RuntimeEvent,
    payload: EventPayload,
) -> Result<(), ProviderRetryError> {
    match (aggregate.state, event.event_type.as_str(), payload) {
        (
            ProviderRetryState::FailureObserved,
            "provider.retry.scheduled",
            EventPayload::Scheduled { schedule, .. },
        ) => {
            let failure = aggregate
                .failure_observation
                .as_ref()
                .ok_or(ProviderRetryError::InvalidHistory)?;
            if schedule
                != derive_retry_schedule(
                    &aggregate.definition,
                    failure,
                    aggregate.cumulative_delay_ms,
                    &schedule.scheduled_at,
                )?
            {
                return Err(ProviderRetryError::ScheduleInvalid);
            }
            aggregate.cumulative_delay_ms = schedule.cumulative_delay_ms;
            aggregate.schedule = Some(schedule);
            aggregate.state = ProviderRetryState::Scheduled;
        }
        (
            ProviderRetryState::Scheduled,
            "provider.retry.materializing",
            EventPayload::Materializing {
                schedule,
                materializing_at,
                ..
            },
        ) if aggregate.schedule.as_ref() == Some(&schedule) => {
            validate_between(
                &materializing_at,
                &schedule.not_before,
                &schedule.attempt_deadline_at,
            )?;
            aggregate.materializing_at = Some(materializing_at);
            aggregate.state = ProviderRetryState::Materializing;
        }
        (
            ProviderRetryState::Materializing,
            "provider.retry.awaiting_attempt",
            EventPayload::AwaitingAttempt {
                schedule,
                awaiting_at,
                ..
            },
        ) if aggregate.schedule.as_ref() == Some(&schedule) => {
            let lower = aggregate
                .materializing_at
                .as_deref()
                .ok_or(ProviderRetryError::InvalidHistory)?;
            validate_between(&awaiting_at, lower, &schedule.attempt_deadline_at)?;
            aggregate.awaiting_at = Some(awaiting_at);
            aggregate.state = ProviderRetryState::AwaitingAttempt;
        }
        (
            ProviderRetryState::AwaitingAttempt,
            "provider.retry.failure_observed",
            EventPayload::FailureObserved {
                failure,
                cumulative_delay_ms,
                ..
            },
        ) => {
            if cumulative_delay_ms != aggregate.cumulative_delay_ms {
                return Err(ProviderRetryError::InvalidHistory);
            }
            validate_failure_observation(&failure)?;
            validate_replayed_awaited_failure(aggregate, &failure)?;
            aggregate.failure_observation = Some(failure);
            aggregate.schedule = None;
            aggregate.materializing_at = None;
            aggregate.awaiting_at = None;
            aggregate.state = ProviderRetryState::FailureObserved;
        }
        (
            ProviderRetryState::AwaitingAttempt,
            "provider.retry.succeeded",
            EventPayload::Succeeded { evidence, .. },
        ) => {
            validate_replayed_awaited_evidence(aggregate, &evidence)?;
            aggregate.terminal_evidence = Some(evidence);
            aggregate.state = ProviderRetryState::Succeeded;
        }
        (
            ProviderRetryState::AwaitingAttempt,
            "provider.retry.outcome_unknown",
            EventPayload::OutcomeUnknown { evidence, .. },
        ) => {
            validate_replayed_awaited_evidence(aggregate, &evidence)?;
            aggregate.terminal_evidence = Some(evidence);
            aggregate.state = ProviderRetryState::OutcomeUnknown;
        }
        (
            ProviderRetryState::AwaitingAttempt,
            "provider.retry.cancelled",
            EventPayload::Cancelled { evidence, .. },
        ) => {
            validate_replayed_awaited_evidence(aggregate, &evidence)?;
            aggregate.terminal_evidence = Some(evidence);
            aggregate.state = ProviderRetryState::Cancelled;
        }
        (
            ProviderRetryState::AwaitingAttempt,
            "provider.retry.failed_terminal",
            EventPayload::FailedTerminal { failure, .. },
        ) => {
            validate_terminal_failure(&failure)?;
            validate_replayed_awaited_failure_identity(aggregate, &failure)?;
            aggregate.terminal_failure = Some(failure);
            aggregate.state = ProviderRetryState::FailedTerminal;
        }
        (
            ProviderRetryState::FailureObserved | ProviderRetryState::Scheduled,
            "provider.retry.exhausted",
            EventPayload::Exhausted { exhaustion, .. },
        ) => {
            validate_replayed_exhaustion(aggregate, &exhaustion)?;
            aggregate.exhaustion = Some(exhaustion);
            aggregate.state = ProviderRetryState::Exhausted;
        }
        _ => return Err(ProviderRetryError::InvalidHistory),
    }
    Ok(())
}

fn validate_definition(value: &ProviderRetryDefinition) -> Result<(), ProviderRetryError> {
    validate_policy(&value.policy)?;
    let started_at = parse_time(&value.started_at)?;
    let deadline_at = parse_time(&value.deadline_at)?;
    let actual_deadline_ms = (deadline_at - started_at).whole_milliseconds();
    if value.run_id.trim().is_empty()
        || value.invocation_id.trim().is_empty()
        || value.inference_id.trim().is_empty()
        || value.request_number == 0
        || value.provider.profile_id.trim().is_empty()
        || value.provider.provider_id.trim().is_empty()
        || value.provider.model_id.trim().is_empty()
        || !is_sha256(&value.provider.config_sha256)
        || !is_sha256(&value.canonical_context_sha256)
        || !is_sha256(&value.transport_payload_sha256)
        || value.first_attempt_number == 0
        || value.request_timeout_ms == 0
        || value.total_deadline_ms < value.request_timeout_ms
        || actual_deadline_ms <= 0
        || u128::try_from(actual_deadline_ms).ok() != Some(u128::from(value.total_deadline_ms))
        || value.first_attempt_number > value.policy.max_attempts
        || value.policy_sha256 != provider_retry_policy_sha256(&value.policy)?
    {
        return Err(ProviderRetryError::DefinitionInvalid);
    }
    Ok(())
}

fn validate_policy(value: &ExponentialFullJitterPolicy) -> Result<(), ProviderRetryError> {
    if value.algorithm != ProviderRetryPolicyAlgorithm::ExponentialFullJitterV1
        || value.initial_delay_ms == 0
        || value.max_delay_ms < value.initial_delay_ms
        || value.max_attempts == 0
        || value.max_total_delay_ms == 0
        || value.max_delay_ms > i64::MAX as u64
        || value.max_total_delay_ms > i64::MAX as u64
    {
        return Err(ProviderRetryError::PolicyInvalid);
    }
    Ok(())
}

fn validate_failure_observation(
    value: &ProviderRetryFailureObservation,
) -> Result<(), ProviderRetryError> {
    if value.attempt_number == 0
        || value.attempt_aggregate_sequence == 0
        || !is_sha256(&value.attempt_definition_sha256)
        || !is_sha256(&value.evidence_sha256)
        || value.failure.code.trim().is_empty()
        || !value.failure.retryable
        || value.failure.delivery_certainty != ProviderDeliveryCertainty::ResponseReceived
    {
        return Err(ProviderRetryError::FailureNotRetryable);
    }
    match value.failure.http_status {
        Some(429) if retry_after_receipt_valid(&value.failure, true) => {}
        Some(500 | 502 | 503 | 504) if retry_after_receipt_valid(&value.failure, false) => {}
        _ => return Err(ProviderRetryError::FailureNotRetryable),
    }
    parse_time(&value.observed_at)?;
    Ok(())
}

fn validate_terminal_failure(
    value: &ProviderRetryFailureObservation,
) -> Result<(), ProviderRetryError> {
    if value.attempt_number == 0
        || value.attempt_aggregate_sequence == 0
        || !is_sha256(&value.attempt_definition_sha256)
        || !is_sha256(&value.evidence_sha256)
        || value.failure.code.trim().is_empty()
        || value.failure.delivery_certainty == ProviderDeliveryCertainty::Unknown
        || !retry_after_receipt_valid(&value.failure, false)
        || (!value.failure.retryable
            && (value.failure.retry_after_ms.is_some() || value.failure.retry_after.is_some()))
        || is_definite_retryable_failure(&value.failure)
    {
        return Err(ProviderRetryError::FailureNotRetryable);
    }
    parse_time(&value.observed_at)?;
    Ok(())
}

fn is_definite_retryable_failure(failure: &ProviderAttemptFailure) -> bool {
    failure.retryable
        && failure.delivery_certainty == ProviderDeliveryCertainty::ResponseReceived
        && match failure.http_status {
            Some(429) => retry_after_receipt_valid(failure, true),
            Some(500 | 502 | 503 | 504) => retry_after_receipt_valid(failure, false),
            _ => false,
        }
}

fn retry_after_receipt_valid(failure: &ProviderAttemptFailure, required: bool) -> bool {
    match (&failure.retry_after, failure.retry_after_ms) {
        (Some(receipt), Some(delay_ms)) => {
            receipt.delay_ms == delay_ms && is_sha256(&receipt.value_sha256)
        }
        (None, None) => !required,
        _ => false,
    }
}

fn validate_attempt_evidence(
    value: &ProviderRetryAttemptEvidence,
) -> Result<(), ProviderRetryError> {
    if value.attempt_number == 0
        || value.attempt_aggregate_sequence == 0
        || !is_sha256(&value.attempt_definition_sha256)
        || !is_sha256(&value.evidence_sha256)
    {
        return Err(ProviderRetryError::AttemptIdentityInvalid);
    }
    parse_time(&value.observed_at)?;
    Ok(())
}

fn validate_exhaustion(value: &ProviderRetryExhaustion) -> Result<(), ProviderRetryError> {
    if !is_sha256(&value.evidence_sha256) {
        return Err(ProviderRetryError::ExhaustionInvalid);
    }
    parse_time(&value.exhausted_at)?;
    Ok(())
}

fn validate_replayed_awaited_failure(
    aggregate: &ProviderRetryAggregate,
    value: &ProviderRetryFailureObservation,
) -> Result<(), ProviderRetryError> {
    validate_replayed_awaited_attempt(
        aggregate,
        value.attempt_id,
        value.attempt_number,
        value.attempt_aggregate_sequence,
        &value.attempt_definition_sha256,
        &value.evidence_sha256,
        &value.observed_at,
    )
}

fn validate_replayed_awaited_failure_identity(
    aggregate: &ProviderRetryAggregate,
    value: &ProviderRetryFailureObservation,
) -> Result<(), ProviderRetryError> {
    validate_replayed_awaited_attempt(
        aggregate,
        value.attempt_id,
        value.attempt_number,
        value.attempt_aggregate_sequence,
        &value.attempt_definition_sha256,
        &value.evidence_sha256,
        &value.observed_at,
    )
}

fn validate_replayed_awaited_evidence(
    aggregate: &ProviderRetryAggregate,
    value: &ProviderRetryAttemptEvidence,
) -> Result<(), ProviderRetryError> {
    validate_attempt_evidence(value)?;
    validate_replayed_awaited_attempt(
        aggregate,
        value.attempt_id,
        value.attempt_number,
        value.attempt_aggregate_sequence,
        &value.attempt_definition_sha256,
        &value.evidence_sha256,
        &value.observed_at,
    )
}

fn validate_replayed_awaited_attempt(
    aggregate: &ProviderRetryAggregate,
    attempt_id: Uuid,
    attempt_number: u16,
    aggregate_sequence: u64,
    definition_sha256: &str,
    evidence_sha256: &str,
    observed_at: &str,
) -> Result<(), ProviderRetryError> {
    let schedule = aggregate
        .schedule
        .as_ref()
        .ok_or(ProviderRetryError::InvalidHistory)?;
    let awaiting_at = aggregate
        .awaiting_at
        .as_deref()
        .ok_or(ProviderRetryError::InvalidHistory)?;
    if attempt_id != schedule.next_attempt_id
        || attempt_number != schedule.next_attempt_number
        || aggregate_sequence == 0
        || !is_sha256(definition_sha256)
        || !is_sha256(evidence_sha256)
    {
        return Err(ProviderRetryError::AttemptIdentityInvalid);
    }
    validate_between(observed_at, awaiting_at, &aggregate.definition.deadline_at)
}

fn validate_replayed_exhaustion(
    aggregate: &ProviderRetryAggregate,
    exhaustion: &ProviderRetryExhaustion,
) -> Result<(), ProviderRetryError> {
    validate_exhaustion(exhaustion)?;
    match aggregate.state {
        ProviderRetryState::FailureObserved => {
            let failure = aggregate
                .failure_observation
                .as_ref()
                .ok_or(ProviderRetryError::InvalidHistory)?;
            if exhaustion.evidence_sha256 != provider_retry_failure_observation_sha256(failure)? {
                return Err(ProviderRetryError::ExhaustionInvalid);
            }
            match derive_retry_schedule(
                &aggregate.definition,
                failure,
                aggregate.cumulative_delay_ms,
                &exhaustion.exhausted_at,
            ) {
                Err(ProviderRetryError::RetryBudgetExhausted(reason))
                    if reason == exhaustion.reason =>
                {
                    Ok(())
                }
                _ => Err(ProviderRetryError::ExhaustionInvalid),
            }
        }
        ProviderRetryState::Scheduled => {
            let schedule = aggregate
                .schedule
                .as_ref()
                .ok_or(ProviderRetryError::InvalidHistory)?;
            if exhaustion.reason == ProviderRetryExhaustionReason::DeadlineExceeded
                && exhaustion.evidence_sha256 == schedule.schedule_sha256
                && parse_time(&exhaustion.exhausted_at)?
                    >= parse_time(&schedule.attempt_deadline_at)?
            {
                Ok(())
            } else {
                Err(ProviderRetryError::ExhaustionInvalid)
            }
        }
        _ => Err(ProviderRetryError::InvalidHistory),
    }
}

fn validate_observation_time(
    definition: &ProviderRetryDefinition,
    observed_at: &str,
    lower_bound: Option<OffsetDateTime>,
) -> Result<(), ProviderRetryError> {
    let observed = parse_time(observed_at)?;
    let started = parse_time(&definition.started_at)?;
    let deadline = parse_time(&definition.deadline_at)?;
    if observed < lower_bound.unwrap_or(started) || observed > deadline {
        return Err(ProviderRetryError::TimeInvalid);
    }
    Ok(())
}

fn validate_between(value: &str, lower: &str, upper: &str) -> Result<(), ProviderRetryError> {
    let value = parse_time(value)?;
    if value < parse_time(lower)? || value > parse_time(upper)? {
        return Err(ProviderRetryError::TimeInvalid);
    }
    Ok(())
}

fn validate_metadata(metadata: ProviderRetryMetadata<'_>) -> Result<(), ProviderRetryError> {
    if metadata.message_id.trim().is_empty() || metadata.idempotency_key.trim().is_empty() {
        return Err(ProviderRetryError::MetadataInvalid);
    }
    parse_time(metadata.created_at)?;
    Ok(())
}

fn validate_event_address(
    event: &RuntimeEvent,
    run_id: &str,
    inference_id: &str,
    expected_sequence: u64,
) -> Result<(), ProviderRetryError> {
    if event.aggregate_sequence != expected_sequence {
        return Err(ProviderRetryError::SequenceGap);
    }
    if event.run_id != run_id
        || event.aggregate_type != AGGREGATE_TYPE
        || event.aggregate_id != inference_id
    {
        return Err(ProviderRetryError::IdentityConflict);
    }
    Ok(())
}

fn validate_event_version(event: &RuntimeEvent) -> Result<(), ProviderRetryError> {
    if event.event_version != EVENT_VERSION {
        return Err(ProviderRetryError::UnknownEventVersion(event.event_version));
    }
    Ok(())
}

fn new_event(
    run_id: &str,
    inference_id: &str,
    event_type: &str,
    payload: Value,
    metadata: ProviderRetryMetadata<'_>,
) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: AGGREGATE_TYPE.to_owned(),
        aggregate_id: inference_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: metadata.idempotency_key.to_owned(),
        event_type: event_type.to_owned(),
        event_version: EVENT_VERSION,
        payload,
        created_at: metadata.created_at.to_owned(),
    }
}

fn parse_time(value: &str) -> Result<OffsetDateTime, ProviderRetryError> {
    OffsetDateTime::parse(value, &Rfc3339).map_err(|_| ProviderRetryError::TimeInvalid)
}

fn format_time(value: OffsetDateTime) -> Result<String, ProviderRetryError> {
    value
        .format(&Rfc3339)
        .map_err(|_| ProviderRetryError::TimeInvalid)
}

fn checked_add_ms(
    value: OffsetDateTime,
    milliseconds: u64,
) -> Result<OffsetDateTime, ProviderRetryError> {
    let milliseconds = i64::try_from(milliseconds).map_err(|_| ProviderRetryError::TimeInvalid)?;
    value
        .checked_add(Duration::milliseconds(milliseconds))
        .ok_or(ProviderRetryError::TimeInvalid)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hash_json<T: Serialize>(value: &T) -> Result<String, ProviderRetryError> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
