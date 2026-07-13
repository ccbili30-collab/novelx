use novelx_protocol::{RunPinnedIdentity, RunReconciliationDecision, RuntimeError};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::event_journal::{EventJournal, EventJournalError, NewRuntimeEvent, RuntimeEvent};
use crate::run_state::{RunState, RunStateMachine, TransitionError};
use crate::workspace_runtime_lease::{BoundWorkspaceRuntimeLease, BoundWorkspaceRuntimeLeaseError};

const MAX_CANCELLATION_ID_BYTES: usize = 1_024;
const MAX_CANCEL_IDEMPOTENCY_KEY_BYTES: usize = 1_024;
const MAX_CANCELLATION_REASON_BYTES: usize = 16 * 1_024;
const MAX_CANCELLATION_REQUESTED_AT_BYTES: usize = 128;
/// Per-Run safety ceiling. A Run is one execution, not a project; 4,096 cancellation cycles
/// preserves pathological long-running sessions while preventing unbounded replay memory.
pub const MAX_RUN_CANCELLATION_CYCLES: usize = 4_096;

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
    cancellation_state: RunCancellationState,
    cancellation_intent: Option<RunCancellationIntent>,
    cancellation_intent_history: Vec<RunCancellationIntent>,
    cancellation_settlement_history: Vec<RunCancellationSettlementRecord>,
    reconciliation_history: Vec<RunReconciliationRecord>,
    cancellation_cycle_count: usize,
    cancellation_evidence_sha256: Option<String>,
    legacy_cancellation_requested: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum RunCancellationState {
    #[default]
    None,
    IntentRecorded,
    CancelledSafe,
    ReconciliationRequired,
    AbandonedAfterUnknown,
    WithdrawnForRetry,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunCancellationIntent {
    intent_id: String,
    run_id: String,
    workspace_id: String,
    cancel_idempotency_key: String,
    reason: String,
    reason_sha256: String,
    requested_at: String,
    command_message_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RunCancellationIntentRecord {
    intent: RunCancellationIntent,
    event: RuntimeEvent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RunCancellationSettlementRecord {
    intent_id: String,
    state: RunCancellationState,
    evidence_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RunReconciliationRecord {
    event_version: u32,
    reconciliation_idempotency_key: String,
    attempt_id: String,
    decision: RunReconciliationDecision,
    duplicate_execution_acknowledged: bool,
    intent_id: Option<String>,
    unknown_effects_sha256: Option<String>,
    cancellation_disposition: Option<RunCancellationDisposition>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RunCancellationDisposition {
    AbandonedAfterUnknown,
    WithdrawnForRetry,
}

impl RunCancellationIntent {
    pub fn intent_id(&self) -> &str {
        &self.intent_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn cancel_idempotency_key(&self) -> &str {
        &self.cancel_idempotency_key
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn reason_sha256(&self) -> &str {
        &self.reason_sha256
    }

    pub fn requested_at(&self) -> &str {
        &self.requested_at
    }

    pub fn command_message_id(&self) -> &str {
        &self.command_message_id
    }
}

impl RunCancellationIntentRecord {
    pub(crate) const fn intent(&self) -> &RunCancellationIntent {
        &self.intent
    }

    pub(crate) const fn event(&self) -> &RuntimeEvent {
        &self.event
    }
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

    pub const fn cancellation_state(&self) -> RunCancellationState {
        self.cancellation_state
    }

    pub const fn cancellation_intent(&self) -> Option<&RunCancellationIntent> {
        self.cancellation_intent.as_ref()
    }

    pub fn cancellation_intent_history(&self) -> &[RunCancellationIntent] {
        &self.cancellation_intent_history
    }

    pub fn active_cancellation_intent(&self) -> Option<&RunCancellationIntent> {
        if self.has_unsettled_cancellation_intent() {
            self.cancellation_intent.as_ref()
        } else {
            None
        }
    }

    pub fn cancellation_evidence_sha256(&self) -> Option<&str> {
        self.cancellation_evidence_sha256.as_deref()
    }

    pub(crate) fn cancellation_outcome_for_intent(
        &self,
        intent_id: &str,
    ) -> Option<(RunCancellationState, &str)> {
        if let Some(reconciliation) = self
            .reconciliation_history
            .iter()
            .find(|record| record.intent_id.as_deref() == Some(intent_id))
        {
            let state = match reconciliation.cancellation_disposition? {
                RunCancellationDisposition::AbandonedAfterUnknown => {
                    RunCancellationState::AbandonedAfterUnknown
                }
                RunCancellationDisposition::WithdrawnForRetry => {
                    RunCancellationState::WithdrawnForRetry
                }
            };
            return Some((state, reconciliation.unknown_effects_sha256.as_deref()?));
        }
        self.cancellation_settlement_history
            .iter()
            .find(|settlement| settlement.intent_id == intent_id)
            .map(|settlement| (settlement.state, settlement.evidence_sha256.as_str()))
    }

    pub const fn permits_new_side_effects(&self) -> bool {
        !self.legacy_cancellation_requested
            && matches!(
                self.cancellation_state,
                RunCancellationState::None | RunCancellationState::WithdrawnForRetry
            )
    }

    pub const fn has_legacy_cancellation_pending(&self) -> bool {
        self.legacy_cancellation_requested
    }

    const fn has_unsettled_cancellation_intent(&self) -> bool {
        matches!(
            self.cancellation_state,
            RunCancellationState::IntentRecorded | RunCancellationState::ReconciliationRequired
        )
    }

    const fn has_pending_cancellation_barrier(&self) -> bool {
        self.legacy_cancellation_requested || self.has_unsettled_cancellation_intent()
    }

    pub fn record_cancellation_intent(
        &mut self,
        journal: &mut EventJournal,
        exclusive_lease: &BoundWorkspaceRuntimeLease,
        cancel_idempotency_key: &str,
        reason: &str,
        command_message_id: &str,
        requested_at: &str,
    ) -> Result<RunCancellationIntent, RunAggregateError> {
        self.record_cancellation_intent_inner(
            journal,
            exclusive_lease,
            cancel_idempotency_key,
            reason,
            command_message_id,
            requested_at,
            None,
            CancellationIntentEntryPolicy::LegacyA1,
        )
        .map(|record| record.intent)
    }

    /// Records the authoritative A2 cancellation intent behind Run, aggregate, and Global CAS.
    ///
    /// This is the only production entry used by `RunCancellationService`. The broader state
    /// matrix intentionally does not change the legacy A1 API above.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_cancellation_intent_at_global_sequence(
        &mut self,
        journal: &mut EventJournal,
        exclusive_lease: &BoundWorkspaceRuntimeLease,
        cancel_idempotency_key: &str,
        reason: &str,
        command_message_id: &str,
        requested_at: &str,
        expected_global_sequence: u64,
    ) -> Result<RunCancellationIntentRecord, RunAggregateError> {
        self.record_cancellation_intent_inner(
            journal,
            exclusive_lease,
            cancel_idempotency_key,
            reason,
            command_message_id,
            requested_at,
            Some(expected_global_sequence),
            CancellationIntentEntryPolicy::DurableA2,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn record_cancellation_intent_inner(
        &mut self,
        journal: &mut EventJournal,
        exclusive_lease: &BoundWorkspaceRuntimeLease,
        cancel_idempotency_key: &str,
        reason: &str,
        command_message_id: &str,
        requested_at: &str,
        expected_global_sequence: Option<u64>,
        entry_policy: CancellationIntentEntryPolicy,
    ) -> Result<RunCancellationIntentRecord, RunAggregateError> {
        let intent = build_cancellation_intent(
            self.pinned_identity.workspace_id.as_str(),
            &self.run_id,
            cancel_idempotency_key,
            reason,
            command_message_id,
            requested_at,
        )?;
        if let Some(existing) = self
            .cancellation_intent_history
            .iter()
            .find(|existing| existing.cancel_idempotency_key == intent.cancel_idempotency_key)
        {
            if cancellation_intents_match(existing, &intent) {
                return cancellation_intent_record_from_history(journal, existing);
            }
            return Err(RunAggregateError::CancellationIntentConflict {
                existing_intent_id: existing.intent_id.clone(),
                requested_intent_id: intent.intent_id,
            });
        }
        if let Some(existing) = self
            .cancellation_intent_history
            .iter()
            .find(|existing| existing.intent_id == intent.intent_id)
        {
            return Err(RunAggregateError::CancellationIntentConflict {
                existing_intent_id: existing.intent_id.clone(),
                requested_intent_id: intent.intent_id,
            });
        }
        if self.legacy_cancellation_requested {
            return Err(RunAggregateError::CancellationSettlementRequired);
        }
        if let Some(existing) = self.cancellation_intent.as_ref()
            && self.cancellation_state != RunCancellationState::WithdrawnForRetry
        {
            return Err(RunAggregateError::CancellationIntentConflict {
                existing_intent_id: existing.intent_id.clone(),
                requested_intent_id: intent.intent_id,
            });
        }
        if !matches!(
            self.cancellation_state,
            RunCancellationState::None | RunCancellationState::WithdrawnForRetry
        ) {
            return Err(RunAggregateError::CancellationStateMismatch);
        }
        require_cancellation_intent_run_state(self.machine.state(), entry_policy)?;
        if self.cancellation_cycle_count >= MAX_RUN_CANCELLATION_CYCLES {
            return Err(RunAggregateError::CancellationCycleLimitReached(
                MAX_RUN_CANCELLATION_CYCLES,
            ));
        }
        let previous_cancellation_state = self.cancellation_state;
        let event = cancellation_intent_recorded_event(
            &intent,
            self.machine.state(),
            previous_cancellation_state,
            cancellation_intent_event_idempotency_key(&self.run_id, &intent.intent_id),
        );
        exclusive_lease.verify_database_authority(journal.database_path())?;
        let outcome = match expected_global_sequence {
            Some(expected_global_sequence) => journal.append_at_global_sequence(
                event,
                self.last_run_sequence,
                self.last_aggregate_sequence,
                expected_global_sequence,
            ),
            None => journal.append_with_outcome(
                event,
                self.last_run_sequence,
                self.last_aggregate_sequence,
            ),
        };
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) if is_event_concurrency_conflict(&error) => {
                return self.resolve_cancellation_intent_append_conflict(journal, &intent, error);
            }
            Err(error) => return Err(error.into()),
        };
        self.cancellation_state = RunCancellationState::IntentRecorded;
        self.cancellation_intent = Some(intent.clone());
        self.cancellation_intent_history.push(intent.clone());
        self.cancellation_cycle_count += 1;
        self.cancellation_evidence_sha256 = None;
        self.last_run_sequence = outcome.event.run_sequence;
        self.last_aggregate_sequence = outcome.event.aggregate_sequence;
        self.updated_at = outcome.event.created_at.clone();
        Ok(RunCancellationIntentRecord {
            intent,
            event: outcome.event,
        })
    }

    fn resolve_cancellation_intent_append_conflict(
        &mut self,
        journal: &EventJournal,
        requested: &RunCancellationIntent,
        original_error: EventJournalError,
    ) -> Result<RunCancellationIntentRecord, RunAggregateError> {
        let recovered = Self::recover(journal, &self.run_id)?;
        let resolution = if let Some(existing) = recovered
            .cancellation_intent_history
            .iter()
            .find(|existing| existing.cancel_idempotency_key == requested.cancel_idempotency_key)
        {
            if cancellation_intents_match(existing, requested) {
                cancellation_intent_record_from_history(journal, existing)
            } else {
                Err(RunAggregateError::CancellationIntentConflict {
                    existing_intent_id: existing.intent_id.clone(),
                    requested_intent_id: requested.intent_id.clone(),
                })
            }
        } else if let Some(existing) = recovered.active_cancellation_intent() {
            Err(RunAggregateError::CancellationIntentConflict {
                existing_intent_id: existing.intent_id.clone(),
                requested_intent_id: requested.intent_id.clone(),
            })
        } else {
            Err(original_error.into())
        };
        *self = recovered;
        resolution
    }

    pub fn mark_cancellation_safe(
        &mut self,
        journal: &mut EventJournal,
        intent_id: &str,
        evidence_manifest_sha256: &str,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        require_sha256(evidence_manifest_sha256)?;
        if let Some(result) = self.historical_settlement_result(
            intent_id,
            evidence_manifest_sha256,
            CancellationSettlementKind::CancelledSafe,
        ) {
            return result;
        }
        self.require_cancellation_intent(intent_id)?;
        if self.cancellation_state != RunCancellationState::IntentRecorded {
            return Err(RunAggregateError::CancellationTransitionInvalid {
                from: self.cancellation_state,
                to: RunCancellationState::CancelledSafe,
            });
        }
        let previous = self.machine.state();
        let mut candidate = self.machine;
        transition_machine(&mut candidate, RunState::Cancelled)?;
        let event = cancellation_settlement_event(
            &self.run_id,
            intent_id,
            evidence_manifest_sha256,
            metadata,
            previous,
            RunState::Cancelled,
            RunCancellationState::IntentRecorded,
            RunCancellationState::CancelledSafe,
            CancellationSettlementKind::CancelledSafe,
        );
        let stored =
            match journal.append(event, self.last_run_sequence, self.last_aggregate_sequence) {
                Ok(stored) => stored,
                Err(error) if is_event_concurrency_conflict(&error) => {
                    return self.resolve_cancellation_settlement_append_conflict(
                        journal,
                        intent_id,
                        evidence_manifest_sha256,
                        CancellationSettlementKind::CancelledSafe,
                        error,
                    );
                }
                Err(error) => return Err(error.into()),
            };
        self.machine = candidate;
        self.cancellation_state = RunCancellationState::CancelledSafe;
        self.cancellation_settlement_history
            .push(RunCancellationSettlementRecord {
                intent_id: intent_id.to_owned(),
                state: RunCancellationState::CancelledSafe,
                evidence_sha256: evidence_manifest_sha256.to_owned(),
            });
        self.cancellation_evidence_sha256 = Some(evidence_manifest_sha256.to_owned());
        self.last_run_sequence = stored.run_sequence;
        self.last_aggregate_sequence = stored.aggregate_sequence;
        self.updated_at = stored.created_at;
        Ok(())
    }

    pub fn mark_cancellation_reconciliation_required(
        &mut self,
        journal: &mut EventJournal,
        intent_id: &str,
        unknown_effects_sha256: &str,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        require_sha256(unknown_effects_sha256)?;
        if let Some(result) = self.historical_settlement_result(
            intent_id,
            unknown_effects_sha256,
            CancellationSettlementKind::ReconciliationRequired,
        ) {
            return result;
        }
        self.require_cancellation_intent(intent_id)?;
        if self.cancellation_state != RunCancellationState::IntentRecorded {
            return Err(RunAggregateError::CancellationTransitionInvalid {
                from: self.cancellation_state,
                to: RunCancellationState::ReconciliationRequired,
            });
        }
        let previous = self.machine.state();
        let mut candidate = self.machine;
        if previous != RunState::WaitingForReconciliation {
            transition_machine(&mut candidate, RunState::WaitingForReconciliation)?;
        }
        let event = cancellation_settlement_event(
            &self.run_id,
            intent_id,
            unknown_effects_sha256,
            metadata,
            previous,
            RunState::WaitingForReconciliation,
            RunCancellationState::IntentRecorded,
            RunCancellationState::ReconciliationRequired,
            CancellationSettlementKind::ReconciliationRequired,
        );
        let stored =
            match journal.append(event, self.last_run_sequence, self.last_aggregate_sequence) {
                Ok(stored) => stored,
                Err(error) if is_event_concurrency_conflict(&error) => {
                    return self.resolve_cancellation_settlement_append_conflict(
                        journal,
                        intent_id,
                        unknown_effects_sha256,
                        CancellationSettlementKind::ReconciliationRequired,
                        error,
                    );
                }
                Err(error) => return Err(error.into()),
            };
        self.machine = candidate;
        self.cancellation_state = RunCancellationState::ReconciliationRequired;
        self.cancellation_settlement_history
            .push(RunCancellationSettlementRecord {
                intent_id: intent_id.to_owned(),
                state: RunCancellationState::ReconciliationRequired,
                evidence_sha256: unknown_effects_sha256.to_owned(),
            });
        self.cancellation_evidence_sha256 = Some(unknown_effects_sha256.to_owned());
        self.last_run_sequence = stored.run_sequence;
        self.last_aggregate_sequence = stored.aggregate_sequence;
        self.updated_at = stored.created_at;
        Ok(())
    }

    fn require_cancellation_intent(&self, intent_id: &str) -> Result<(), RunAggregateError> {
        require_sha256(intent_id)?;
        match self.cancellation_intent.as_ref() {
            Some(intent) if intent.intent_id == intent_id => Ok(()),
            Some(intent) => Err(RunAggregateError::CancellationIntentConflict {
                existing_intent_id: intent.intent_id.clone(),
                requested_intent_id: intent_id.to_owned(),
            }),
            None => Err(RunAggregateError::CancellationIntentRequired),
        }
    }

    fn historical_settlement_result(
        &self,
        intent_id: &str,
        evidence_sha256: &str,
        kind: CancellationSettlementKind,
    ) -> Option<Result<(), RunAggregateError>> {
        let existing = self
            .cancellation_settlement_history
            .iter()
            .find(|settlement| settlement.intent_id == intent_id)?;
        if existing.state == kind.target_cancellation_state()
            && existing.evidence_sha256 == evidence_sha256
        {
            Some(Ok(()))
        } else {
            Some(Err(RunAggregateError::CancellationSettlementConflict))
        }
    }

    fn resolve_cancellation_settlement_append_conflict(
        &mut self,
        journal: &EventJournal,
        intent_id: &str,
        evidence_sha256: &str,
        kind: CancellationSettlementKind,
        original_error: EventJournalError,
    ) -> Result<(), RunAggregateError> {
        let recovered = Self::recover(journal, &self.run_id)?;
        let resolution = recovered
            .historical_settlement_result(intent_id, evidence_sha256, kind)
            .unwrap_or_else(|| Err(original_error.into()));
        *self = recovered;
        resolution
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
        exclusive_lease: &BoundWorkspaceRuntimeLease,
        attempt_ids: &[String],
        cancellation_reason: &str,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        if self.cancellation_state != RunCancellationState::None {
            return Err(RunAggregateError::CancellationSettlementRequired);
        }
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
        if self.legacy_cancellation_requested {
            return Err(RunAggregateError::CancellationSettlementRequired);
        }
        if self.cancellation_cycle_count >= MAX_RUN_CANCELLATION_CYCLES {
            return Err(RunAggregateError::CancellationCycleLimitReached(
                MAX_RUN_CANCELLATION_CYCLES,
            ));
        }
        let previous = self.machine.state();
        let mut candidate = self.machine;
        transition_machine(&mut candidate, RunState::WaitingForReconciliation)?;
        exclusive_lease.verify_database_authority(journal.database_path())?;
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
        self.legacy_cancellation_requested = true;
        self.cancellation_cycle_count += 1;
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
        require_bounded_text(attempt_id, MAX_CANCELLATION_ID_BYTES)?;
        require_bounded_text(metadata.idempotency_key, MAX_CANCEL_IDEMPOTENCY_KEY_BYTES)?;
        let target = reconciliation_target(decision, duplicate_execution_acknowledged)?;
        if let Some(result) = self.historical_reconciliation_result(
            metadata.idempotency_key,
            attempt_id,
            decision,
            duplicate_execution_acknowledged,
        ) {
            return result;
        }
        if self.cancellation_state == RunCancellationState::IntentRecorded {
            return Err(RunAggregateError::CancellationSettlementRequired);
        }
        if self.machine.state() != RunState::WaitingForReconciliation {
            return Err(RunAggregateError::ReconciliationStateRequired);
        }
        let previous = self.machine.state();
        let mut candidate = self.machine;
        transition_machine(&mut candidate, target)?;
        let reconciliation_idempotency_key = metadata.idempotency_key.to_owned();
        let (event, record) = if self.cancellation_state
            == RunCancellationState::ReconciliationRequired
            && !self.legacy_cancellation_requested
        {
            let intent_id = self
                .cancellation_intent
                .as_ref()
                .ok_or(RunAggregateError::CancellationIntentRequired)?
                .intent_id
                .clone();
            let unknown_effects_sha256 = self
                .cancellation_evidence_sha256
                .clone()
                .ok_or(RunAggregateError::CancellationStateMismatch)?;
            let disposition = cancellation_disposition(decision);
            (
                cancellation_reconciliation_event_v2(
                    &self.run_id,
                    attempt_id,
                    decision,
                    duplicate_execution_acknowledged,
                    &intent_id,
                    &unknown_effects_sha256,
                    disposition,
                    metadata,
                    previous,
                    target,
                ),
                RunReconciliationRecord {
                    event_version: 2,
                    reconciliation_idempotency_key: reconciliation_idempotency_key.clone(),
                    attempt_id: attempt_id.to_owned(),
                    decision,
                    duplicate_execution_acknowledged,
                    intent_id: Some(intent_id),
                    unknown_effects_sha256: Some(unknown_effects_sha256),
                    cancellation_disposition: Some(disposition),
                },
            )
        } else if self.cancellation_state == RunCancellationState::None {
            (
                reconciliation_event(
                    &self.run_id,
                    attempt_id,
                    decision,
                    duplicate_execution_acknowledged,
                    metadata,
                    previous,
                    target,
                ),
                RunReconciliationRecord {
                    event_version: 1,
                    reconciliation_idempotency_key: reconciliation_idempotency_key.clone(),
                    attempt_id: attempt_id.to_owned(),
                    decision,
                    duplicate_execution_acknowledged,
                    intent_id: None,
                    unknown_effects_sha256: None,
                    cancellation_disposition: None,
                },
            )
        } else {
            return Err(RunAggregateError::ReconciliationStateRequired);
        };
        let stored =
            match journal.append(event, self.last_run_sequence, self.last_aggregate_sequence) {
                Ok(stored) => stored,
                Err(error) if is_event_concurrency_conflict(&error) => {
                    return self.resolve_reconciliation_append_conflict(
                        journal,
                        &reconciliation_idempotency_key,
                        attempt_id,
                        decision,
                        duplicate_execution_acknowledged,
                        error,
                    );
                }
                Err(error) => return Err(error.into()),
            };
        self.machine = candidate;
        if record.event_version == 2 {
            self.cancellation_state = cancellation_state_after_reconciliation(decision);
        }
        self.legacy_cancellation_requested = false;
        self.reconciliation_history.push(record);
        self.last_run_sequence = stored.run_sequence;
        self.last_aggregate_sequence = stored.aggregate_sequence;
        self.updated_at = stored.created_at;
        Ok(())
    }

    fn historical_reconciliation_result(
        &self,
        reconciliation_idempotency_key: &str,
        attempt_id: &str,
        decision: RunReconciliationDecision,
        duplicate_execution_acknowledged: bool,
    ) -> Option<Result<(), RunAggregateError>> {
        let existing = self.reconciliation_history.iter().find(|record| {
            record.reconciliation_idempotency_key == reconciliation_idempotency_key
                || record.attempt_id == attempt_id
        })?;
        if !reconciliation_record_is_well_formed(existing) {
            return Some(Err(RunAggregateError::CancellationStateMismatch));
        }
        if existing.attempt_id == attempt_id
            && existing.decision == decision
            && existing.duplicate_execution_acknowledged == duplicate_execution_acknowledged
        {
            Some(Ok(()))
        } else {
            Some(Err(EventJournalError::IdempotencyConflict {
                idempotency_key: reconciliation_idempotency_key.to_owned(),
            }
            .into()))
        }
    }

    fn resolve_reconciliation_append_conflict(
        &mut self,
        journal: &EventJournal,
        reconciliation_idempotency_key: &str,
        attempt_id: &str,
        decision: RunReconciliationDecision,
        duplicate_execution_acknowledged: bool,
        original_error: EventJournalError,
    ) -> Result<(), RunAggregateError> {
        let recovered = Self::recover(journal, &self.run_id)?;
        let resolution = recovered
            .historical_reconciliation_result(
                reconciliation_idempotency_key,
                attempt_id,
                decision,
                duplicate_execution_acknowledged,
            )
            .unwrap_or_else(|| Err(original_error.into()));
        *self = recovered;
        resolution
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
        exclusive_lease: &BoundWorkspaceRuntimeLease,
        metadata: EventMetadata<'_>,
    ) -> Result<(), RunAggregateError> {
        if self.cancellation_state != RunCancellationState::None {
            return Err(RunAggregateError::CancellationSettlementRequired);
        }
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
        exclusive_lease.verify_database_authority(journal.database_path())?;
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
        if self.has_pending_cancellation_barrier() {
            return Err(RunAggregateError::CancellationSettlementRequired);
        }
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
        if self.has_pending_cancellation_barrier() {
            if self.is_idempotent_transition(journal, &metadata, event_type(target), target)? {
                return Ok(());
            }
            return Err(RunAggregateError::CancellationSettlementRequired);
        }
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
    #[error(
        "run cancellation intent conflicts: existing {existing_intent_id}, requested {requested_intent_id}"
    )]
    CancellationIntentConflict {
        existing_intent_id: String,
        requested_intent_id: String,
    },
    #[error("run cancellation settlement requires a recorded intent")]
    CancellationIntentRequired,
    #[error("run cancellation state is inconsistent with its persisted intent")]
    CancellationStateMismatch,
    #[error("run cancellation transition is invalid: {from:?} -> {to:?}")]
    CancellationTransitionInvalid {
        from: RunCancellationState,
        to: RunCancellationState,
    },
    #[error("run cancellation evidence conflicts with the persisted settlement")]
    CancellationSettlementConflict,
    #[error("run cancellation requires settlement before another lifecycle operation")]
    CancellationSettlementRequired,
    #[error("run state {0:?} cannot record a cancellation intent")]
    CancellationRunStateInvalid(RunState),
    #[error("run reached the maximum of {0} persisted cancellation cycles")]
    CancellationCycleLimitReached(usize),
    #[error("terminal run state {0:?} cannot accept a new cancellation intent")]
    CancellationRunTerminal(RunState),
    #[error(transparent)]
    Transition(#[from] TransitionError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    WorkspaceLease(#[from] BoundWorkspaceRuntimeLeaseError),
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
    validate_replayed_pinned_identity(&creation.pinned_identity)?;
    let mut aggregate = RunAggregate {
        run_id: run_id.to_owned(),
        pinned_identity: creation.pinned_identity,
        machine: RunStateMachine::new(),
        last_run_sequence,
        last_aggregate_sequence: 1,
        created_at: first.created_at.clone(),
        updated_at: first.created_at.clone(),
        terminal_error: None,
        cancellation_state: RunCancellationState::None,
        cancellation_intent: None,
        cancellation_intent_history: Vec::new(),
        cancellation_settlement_history: Vec::new(),
        reconciliation_history: Vec::new(),
        cancellation_cycle_count: 0,
        cancellation_evidence_sha256: None,
        legacy_cancellation_requested: false,
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
        if event.event_type == "run.cancellation_intent_recorded" {
            replay_cancellation_intent_recorded(&mut aggregate, event)?;
            continue;
        }
        if event.event_type == "run.cancelled_safe" {
            replay_cancellation_settlement(
                &mut aggregate,
                event,
                CancellationSettlementKind::CancelledSafe,
            )?;
            continue;
        }
        if event.event_type == "run.cancellation_reconciliation_required" {
            replay_cancellation_settlement(
                &mut aggregate,
                event,
                CancellationSettlementKind::ReconciliationRequired,
            )?;
            continue;
        }
        if aggregate.has_pending_cancellation_barrier()
            && !(event.event_type == "run.reconciled"
                && (aggregate.legacy_cancellation_requested
                    || aggregate.cancellation_state
                        == RunCancellationState::ReconciliationRequired))
        {
            return Err(RunAggregateError::CancellationSettlementRequired);
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
        if event.event_type == "run.reconciled" {
            match event.event_version {
                1 => replay_legacy_reconciliation(&mut aggregate, event)?,
                2 => replay_cancellation_reconciliation(&mut aggregate, event)?,
                version => {
                    return Err(RunAggregateError::UnknownEventVersion {
                        event_type: event.event_type.clone(),
                        version,
                    });
                }
            }
            continue;
        }
        if event.event_type == "run.cancellation_requested" && event.event_version == 1 {
            if aggregate.cancellation_state != RunCancellationState::None {
                return Err(RunAggregateError::CancellationSettlementRequired);
            }
            let payload = parse_cancellation_requested_payload(&event.payload)?;
            if aggregate.cancellation_cycle_count >= MAX_RUN_CANCELLATION_CYCLES {
                return Err(RunAggregateError::CancellationCycleLimitReached(
                    MAX_RUN_CANCELLATION_CYCLES,
                ));
            }
            if payload.transition.previous != Some(aggregate.machine.state())
                || payload.transition.current != RunState::WaitingForReconciliation
            {
                return Err(RunAggregateError::StateMismatch);
            }
            transition_machine(&mut aggregate.machine, RunState::WaitingForReconciliation)?;
            aggregate.legacy_cancellation_requested = true;
            aggregate.cancellation_cycle_count += 1;
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
        if target == RunState::Cancelled
            && aggregate.cancellation_state != RunCancellationState::None
        {
            return Err(RunAggregateError::CancellationSettlementRequired);
        }
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

struct CancellationReconciliationPayload {
    transition: TransitionPayload,
    reconciliation_idempotency_key: String,
    attempt_id: String,
    decision: RunReconciliationDecision,
    duplicate_execution_acknowledged: bool,
    intent_id: String,
    unknown_effects_sha256: String,
    cancellation_disposition: RunCancellationDisposition,
}

struct CancellationRequestedPayload {
    transition: TransitionPayload,
}

struct CancellationIntentPayload {
    previous_cancellation_state: RunCancellationState,
    current_cancellation_state: RunCancellationState,
    run_state: RunState,
    intent: RunCancellationIntent,
}

#[derive(Clone, Copy)]
enum CancellationSettlementKind {
    CancelledSafe,
    ReconciliationRequired,
}

impl CancellationSettlementKind {
    const fn event_type(self) -> &'static str {
        match self {
            Self::CancelledSafe => "run.cancelled_safe",
            Self::ReconciliationRequired => "run.cancellation_reconciliation_required",
        }
    }

    const fn target_cancellation_state(self) -> RunCancellationState {
        match self {
            Self::CancelledSafe => RunCancellationState::CancelledSafe,
            Self::ReconciliationRequired => RunCancellationState::ReconciliationRequired,
        }
    }

    const fn target_run_state(self) -> RunState {
        match self {
            Self::CancelledSafe => RunState::Cancelled,
            Self::ReconciliationRequired => RunState::WaitingForReconciliation,
        }
    }

    const fn evidence_field(self) -> &'static str {
        match self {
            Self::CancelledSafe => "evidenceManifestSha256",
            Self::ReconciliationRequired => "unknownEffectsSha256",
        }
    }
}

struct CancellationSettlementPayload {
    previous_cancellation_state: RunCancellationState,
    current_cancellation_state: RunCancellationState,
    transition: TransitionPayload,
    intent_id: String,
    evidence_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunCancellationIntentHashMaterial<'a> {
    scheme: &'static str,
    workspace_id: &'a str,
    run_id: &'a str,
    cancel_idempotency_key: &'a str,
    reason_sha256: &'a str,
}

pub fn derive_run_cancellation_intent_id(
    workspace_id: &str,
    run_id: &str,
    cancel_idempotency_key: &str,
    reason: &str,
) -> Result<String, RunAggregateError> {
    require_bounded_text(workspace_id, MAX_CANCELLATION_ID_BYTES)?;
    require_bounded_text(run_id, MAX_CANCELLATION_ID_BYTES)?;
    require_bounded_text(cancel_idempotency_key, MAX_CANCEL_IDEMPOTENCY_KEY_BYTES)?;
    require_bounded_text(reason, MAX_CANCELLATION_REASON_BYTES)?;
    let reason_sha256 = hash_text(reason);
    let material = RunCancellationIntentHashMaterial {
        scheme: "run-cancel-intent/v1",
        workspace_id,
        run_id,
        cancel_idempotency_key,
        reason_sha256: &reason_sha256,
    };
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&material).map_err(|_| RunAggregateError::InvalidPayload)?
        )
    ))
}

fn build_cancellation_intent(
    workspace_id: &str,
    run_id: &str,
    cancel_idempotency_key: &str,
    reason: &str,
    command_message_id: &str,
    requested_at: &str,
) -> Result<RunCancellationIntent, RunAggregateError> {
    require_bounded_text(command_message_id, MAX_CANCELLATION_ID_BYTES)?;
    require_bounded_text(requested_at, MAX_CANCELLATION_REQUESTED_AT_BYTES)?;
    validate_rfc3339(requested_at)?;
    let reason_sha256 = hash_text(reason);
    Ok(RunCancellationIntent {
        intent_id: derive_run_cancellation_intent_id(
            workspace_id,
            run_id,
            cancel_idempotency_key,
            reason,
        )?,
        run_id: run_id.to_owned(),
        workspace_id: workspace_id.to_owned(),
        cancel_idempotency_key: cancel_idempotency_key.to_owned(),
        reason: reason.to_owned(),
        reason_sha256,
        requested_at: requested_at.to_owned(),
        command_message_id: command_message_id.to_owned(),
    })
}

fn require_text(value: &str) -> Result<(), RunAggregateError> {
    if value.trim().is_empty() {
        Err(RunAggregateError::InvalidPayload)
    } else {
        Ok(())
    }
}

fn require_bounded_text(value: &str, max_bytes: usize) -> Result<(), RunAggregateError> {
    require_text(value)?;
    if value.len() > max_bytes {
        Err(RunAggregateError::InvalidPayload)
    } else {
        Ok(())
    }
}

fn validate_cancellation_intent_fields(
    intent: &RunCancellationIntent,
) -> Result<(), RunAggregateError> {
    require_bounded_text(&intent.workspace_id, MAX_CANCELLATION_ID_BYTES)?;
    require_bounded_text(&intent.run_id, MAX_CANCELLATION_ID_BYTES)?;
    require_bounded_text(
        &intent.cancel_idempotency_key,
        MAX_CANCEL_IDEMPOTENCY_KEY_BYTES,
    )?;
    require_bounded_text(&intent.reason, MAX_CANCELLATION_REASON_BYTES)?;
    require_bounded_text(&intent.command_message_id, MAX_CANCELLATION_ID_BYTES)?;
    require_bounded_text(&intent.requested_at, MAX_CANCELLATION_REQUESTED_AT_BYTES)?;
    validate_rfc3339(&intent.requested_at)?;
    require_sha256(&intent.intent_id)?;
    require_sha256(&intent.reason_sha256)
}

fn validate_rfc3339(value: &str) -> Result<(), RunAggregateError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map(|_| ())
        .map_err(|_| RunAggregateError::InvalidPayload)
}

fn cancellation_intents_match(
    existing: &RunCancellationIntent,
    requested: &RunCancellationIntent,
) -> bool {
    existing.intent_id == requested.intent_id
        && existing.run_id == requested.run_id
        && existing.workspace_id == requested.workspace_id
        && existing.cancel_idempotency_key == requested.cancel_idempotency_key
        && existing.reason == requested.reason
        && existing.reason_sha256 == requested.reason_sha256
}

fn cancellation_intent_record_from_history(
    journal: &EventJournal,
    intent: &RunCancellationIntent,
) -> Result<RunCancellationIntentRecord, RunAggregateError> {
    let matches = journal
        .read_aggregate(&intent.run_id, "run", &intent.run_id, 0)?
        .into_iter()
        .filter(|event| {
            event.event_type == "run.cancellation_intent_recorded"
                && event.payload.get("intentId").and_then(Value::as_str)
                    == Some(intent.intent_id.as_str())
        })
        .collect::<Vec<_>>();
    let [event] = matches.as_slice() else {
        return Err(RunAggregateError::CancellationStateMismatch);
    };
    validate_cancellation_intent_runtime_event(event, intent)?;
    Ok(RunCancellationIntentRecord {
        intent: intent.clone(),
        event: event.clone(),
    })
}

pub(crate) fn validate_cancellation_intent_runtime_event(
    event: &RuntimeEvent,
    intent: &RunCancellationIntent,
) -> Result<(), RunAggregateError> {
    let payload = parse_cancellation_intent_payload(&event.payload)?;
    if event.run_sequence == 0
        || event.aggregate_sequence == 0
        || event.run_id != intent.run_id
        || event.aggregate_type != "run"
        || event.aggregate_id != intent.run_id
        || event.message_id != intent.command_message_id
        || event.idempotency_key
            != cancellation_intent_event_idempotency_key(&intent.run_id, &intent.intent_id)
        || event.event_type != "run.cancellation_intent_recorded"
        || event.event_version != 1
        || event.created_at != intent.requested_at
        || payload.current_cancellation_state != RunCancellationState::IntentRecorded
        || payload.intent != *intent
        || !matches!(
            payload.previous_cancellation_state,
            RunCancellationState::None | RunCancellationState::WithdrawnForRetry
        )
    {
        return Err(RunAggregateError::CancellationStateMismatch);
    }
    require_cancellation_intent_run_state(
        payload.run_state,
        CancellationIntentEntryPolicy::DurableA2,
    )?;
    let derived = derive_run_cancellation_intent_id(
        &intent.workspace_id,
        &intent.run_id,
        &intent.cancel_idempotency_key,
        &intent.reason,
    )?;
    if derived != intent.intent_id || hash_text(&intent.reason) != intent.reason_sha256 {
        return Err(RunAggregateError::InvalidPayload);
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum CancellationIntentEntryPolicy {
    LegacyA1,
    DurableA2,
}

fn require_cancellation_intent_run_state(
    state: RunState,
    policy: CancellationIntentEntryPolicy,
) -> Result<(), RunAggregateError> {
    let allowed = match policy {
        CancellationIntentEntryPolicy::LegacyA1 => {
            matches!(state, RunState::Running | RunState::Retrying)
        }
        CancellationIntentEntryPolicy::DurableA2 => matches!(
            state,
            RunState::Created
                | RunState::Preparing
                | RunState::Running
                | RunState::WaitingForApproval
                | RunState::Retrying
                | RunState::Committing
        ),
    };
    if allowed {
        Ok(())
    } else if matches!(policy, CancellationIntentEntryPolicy::DurableA2) && state.is_terminal() {
        Err(RunAggregateError::CancellationRunTerminal(state))
    } else {
        Err(RunAggregateError::CancellationRunStateInvalid(state))
    }
}

fn is_event_concurrency_conflict(error: &EventJournalError) -> bool {
    matches!(
        error,
        EventJournalError::MessageIdConflict { .. }
            | EventJournalError::IdempotencyConflict { .. }
            | EventJournalError::RunSequenceConflict { .. }
            | EventJournalError::AggregateSequenceConflict { .. }
            | EventJournalError::GlobalSequenceConflict { .. }
    )
}

fn reconciliation_record_is_well_formed(record: &RunReconciliationRecord) -> bool {
    match record.event_version {
        1 => {
            record.intent_id.is_none()
                && record.unknown_effects_sha256.is_none()
                && record.cancellation_disposition.is_none()
        }
        2 => {
            record.intent_id.as_deref().is_some_and(is_lowercase_sha256)
                && record
                    .unknown_effects_sha256
                    .as_deref()
                    .is_some_and(is_lowercase_sha256)
                && record.cancellation_disposition
                    == Some(cancellation_disposition(record.decision))
        }
        _ => false,
    }
}

fn hash_text(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn require_sha256(value: &str) -> Result<(), RunAggregateError> {
    if is_lowercase_sha256(value) {
        Ok(())
    } else {
        Err(RunAggregateError::InvalidPayload)
    }
}

fn required_text_field(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<String, RunAggregateError> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .ok_or(RunAggregateError::InvalidPayload)?;
    require_text(value)?;
    Ok(value.to_owned())
}

fn required_sha256_field(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<String, RunAggregateError> {
    let value = required_text_field(object, field)?;
    require_sha256(&value)?;
    Ok(value)
}

fn cancellation_state_name(state: RunCancellationState) -> &'static str {
    match state {
        RunCancellationState::None => "none",
        RunCancellationState::IntentRecorded => "intent_recorded",
        RunCancellationState::CancelledSafe => "cancelled_safe",
        RunCancellationState::ReconciliationRequired => "reconciliation_required",
        RunCancellationState::AbandonedAfterUnknown => "abandoned_after_unknown",
        RunCancellationState::WithdrawnForRetry => "withdrawn_for_retry",
    }
}

fn parse_cancellation_state(value: &str) -> Result<RunCancellationState, RunAggregateError> {
    match value {
        "none" => Ok(RunCancellationState::None),
        "intent_recorded" => Ok(RunCancellationState::IntentRecorded),
        "cancelled_safe" => Ok(RunCancellationState::CancelledSafe),
        "reconciliation_required" => Ok(RunCancellationState::ReconciliationRequired),
        "abandoned_after_unknown" => Ok(RunCancellationState::AbandonedAfterUnknown),
        "withdrawn_for_retry" => Ok(RunCancellationState::WithdrawnForRetry),
        _ => Err(RunAggregateError::InvalidPayload),
    }
}

fn parse_cancellation_state_field(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<RunCancellationState, RunAggregateError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or(RunAggregateError::InvalidPayload)
        .and_then(parse_cancellation_state)
}

const fn cancellation_state_after_reconciliation(
    decision: RunReconciliationDecision,
) -> RunCancellationState {
    match decision {
        RunReconciliationDecision::CancelRun => RunCancellationState::AbandonedAfterUnknown,
        RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate => {
            RunCancellationState::WithdrawnForRetry
        }
    }
}

fn reconciliation_target(
    decision: RunReconciliationDecision,
    duplicate_execution_acknowledged: bool,
) -> Result<RunState, RunAggregateError> {
    match decision {
        RunReconciliationDecision::CancelRun if !duplicate_execution_acknowledged => {
            Ok(RunState::Cancelled)
        }
        RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate
            if duplicate_execution_acknowledged =>
        {
            Ok(RunState::Retrying)
        }
        _ => Err(RunAggregateError::InvalidPayload),
    }
}

const fn cancellation_disposition(
    decision: RunReconciliationDecision,
) -> RunCancellationDisposition {
    match decision {
        RunReconciliationDecision::CancelRun => RunCancellationDisposition::AbandonedAfterUnknown,
        RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate => {
            RunCancellationDisposition::WithdrawnForRetry
        }
    }
}

const fn cancellation_disposition_name(disposition: RunCancellationDisposition) -> &'static str {
    match disposition {
        RunCancellationDisposition::AbandonedAfterUnknown => "abandoned_after_unknown",
        RunCancellationDisposition::WithdrawnForRetry => "withdrawn_for_retry",
    }
}

fn parse_cancellation_disposition(
    value: &str,
) -> Result<RunCancellationDisposition, RunAggregateError> {
    match value {
        "abandoned_after_unknown" => Ok(RunCancellationDisposition::AbandonedAfterUnknown),
        "withdrawn_for_retry" => Ok(RunCancellationDisposition::WithdrawnForRetry),
        _ => Err(RunAggregateError::InvalidPayload),
    }
}

fn cancellation_intent_event_idempotency_key(run_id: &str, intent_id: &str) -> String {
    format!("run:{run_id}:cancel-intent:{intent_id}")
}

fn cancellation_settlement_event_idempotency_key(
    run_id: &str,
    intent_id: &str,
    evidence_sha256: &str,
    kind: CancellationSettlementKind,
) -> String {
    match kind {
        CancellationSettlementKind::CancelledSafe => {
            format!("run:{run_id}:cancel-safe:{intent_id}:{evidence_sha256}")
        }
        CancellationSettlementKind::ReconciliationRequired => {
            format!("run:{run_id}:cancel-reconciliation:{intent_id}:{evidence_sha256}")
        }
    }
}

fn cancellation_reconciliation_event_idempotency_key(
    run_id: &str,
    intent_id: &str,
    attempt_id: &str,
    unknown_effects_sha256: &str,
    disposition: RunCancellationDisposition,
) -> String {
    format!(
        "run:{run_id}:cancel-reconciled:{intent_id}:{attempt_id}:{}:{unknown_effects_sha256}",
        cancellation_disposition_name(disposition)
    )
}

fn replay_cancellation_intent_recorded(
    aggregate: &mut RunAggregate,
    event: &RuntimeEvent,
) -> Result<(), RunAggregateError> {
    if event.event_version != 1 {
        return Err(RunAggregateError::UnknownEventVersion {
            event_type: event.event_type.clone(),
            version: event.event_version,
        });
    }
    let payload = parse_cancellation_intent_payload(&event.payload)?;
    if aggregate.legacy_cancellation_requested {
        return Err(RunAggregateError::CancellationSettlementRequired);
    }
    // Replay validates the persisted event contract, not the narrower legacy API caller policy.
    require_cancellation_intent_run_state(
        payload.run_state,
        CancellationIntentEntryPolicy::DurableA2,
    )?;
    if aggregate.cancellation_cycle_count >= MAX_RUN_CANCELLATION_CYCLES {
        return Err(RunAggregateError::CancellationCycleLimitReached(
            MAX_RUN_CANCELLATION_CYCLES,
        ));
    }
    let may_start_cycle = matches!(
        aggregate.cancellation_state,
        RunCancellationState::None | RunCancellationState::WithdrawnForRetry
    );
    if payload.previous_cancellation_state != aggregate.cancellation_state
        || payload.current_cancellation_state != RunCancellationState::IntentRecorded
        || !may_start_cycle
        || (aggregate.cancellation_state == RunCancellationState::None
            && aggregate.cancellation_intent.is_some())
        || (aggregate.cancellation_state == RunCancellationState::WithdrawnForRetry
            && aggregate.cancellation_intent.is_none())
        || aggregate.machine.state().is_terminal()
        || payload.run_state != aggregate.machine.state()
        || payload.intent.run_id != aggregate.run_id
        || payload.intent.workspace_id != aggregate.pinned_identity.workspace_id
        || event.message_id != payload.intent.command_message_id
        || event.created_at != payload.intent.requested_at
        || event.idempotency_key
            != cancellation_intent_event_idempotency_key(
                &aggregate.run_id,
                &payload.intent.intent_id,
            )
    {
        return Err(RunAggregateError::CancellationStateMismatch);
    }
    let derived = derive_run_cancellation_intent_id(
        &payload.intent.workspace_id,
        &payload.intent.run_id,
        &payload.intent.cancel_idempotency_key,
        &payload.intent.reason,
    )?;
    if derived != payload.intent.intent_id
        || hash_text(&payload.intent.reason) != payload.intent.reason_sha256
        || aggregate.cancellation_intent_history.iter().any(|intent| {
            intent.intent_id == payload.intent.intent_id
                || intent.cancel_idempotency_key == payload.intent.cancel_idempotency_key
        })
    {
        return Err(RunAggregateError::InvalidPayload);
    }
    aggregate.cancellation_state = RunCancellationState::IntentRecorded;
    aggregate.cancellation_intent = Some(payload.intent.clone());
    aggregate.cancellation_intent_history.push(payload.intent);
    aggregate.cancellation_cycle_count += 1;
    aggregate.cancellation_evidence_sha256 = None;
    aggregate.last_aggregate_sequence = event.aggregate_sequence;
    aggregate.updated_at = event.created_at.clone();
    Ok(())
}

fn replay_cancellation_settlement(
    aggregate: &mut RunAggregate,
    event: &RuntimeEvent,
    kind: CancellationSettlementKind,
) -> Result<(), RunAggregateError> {
    if event.event_type != kind.event_type() || event.event_version != 1 {
        return Err(RunAggregateError::UnknownEventVersion {
            event_type: event.event_type.clone(),
            version: event.event_version,
        });
    }
    let payload = parse_cancellation_settlement_payload(&event.payload, kind)?;
    let intent = aggregate
        .cancellation_intent
        .as_ref()
        .ok_or(RunAggregateError::CancellationIntentRequired)?;
    if aggregate.cancellation_state != RunCancellationState::IntentRecorded
        || payload.previous_cancellation_state != RunCancellationState::IntentRecorded
        || payload.current_cancellation_state != kind.target_cancellation_state()
        || payload.intent_id != intent.intent_id
        || payload.transition.previous != Some(aggregate.machine.state())
        || payload.transition.current != kind.target_run_state()
        || event.idempotency_key
            != cancellation_settlement_event_idempotency_key(
                &aggregate.run_id,
                &payload.intent_id,
                &payload.evidence_sha256,
                kind,
            )
    {
        return Err(RunAggregateError::CancellationStateMismatch);
    }
    if kind.target_run_state() != aggregate.machine.state() {
        transition_machine(&mut aggregate.machine, kind.target_run_state())?;
    } else if matches!(kind, CancellationSettlementKind::CancelledSafe) {
        return Err(RunAggregateError::StateMismatch);
    }
    aggregate.cancellation_state = kind.target_cancellation_state();
    aggregate
        .cancellation_settlement_history
        .push(RunCancellationSettlementRecord {
            intent_id: payload.intent_id,
            state: kind.target_cancellation_state(),
            evidence_sha256: payload.evidence_sha256.clone(),
        });
    aggregate.cancellation_evidence_sha256 = Some(payload.evidence_sha256);
    aggregate.last_aggregate_sequence = event.aggregate_sequence;
    aggregate.updated_at = event.created_at.clone();
    Ok(())
}

fn replay_legacy_reconciliation(
    aggregate: &mut RunAggregate,
    event: &RuntimeEvent,
) -> Result<(), RunAggregateError> {
    if aggregate.cancellation_state != RunCancellationState::None
        || aggregate.machine.state() != RunState::WaitingForReconciliation
    {
        return Err(RunAggregateError::CancellationStateMismatch);
    }
    let payload = parse_reconciliation_payload(&event.payload)?;
    if payload.transition.previous != Some(aggregate.machine.state())
        || aggregate.reconciliation_history.iter().any(|record| {
            record.reconciliation_idempotency_key == event.idempotency_key
                || record.attempt_id == payload.attempt_id
        })
    {
        return Err(RunAggregateError::StateMismatch);
    }
    transition_machine(&mut aggregate.machine, payload.transition.current)?;
    aggregate
        .reconciliation_history
        .push(RunReconciliationRecord {
            event_version: 1,
            reconciliation_idempotency_key: event.idempotency_key.clone(),
            attempt_id: payload.attempt_id,
            decision: payload.decision,
            duplicate_execution_acknowledged: payload.duplicate_execution_acknowledged,
            intent_id: None,
            unknown_effects_sha256: None,
            cancellation_disposition: None,
        });
    aggregate.legacy_cancellation_requested = false;
    aggregate.last_aggregate_sequence = event.aggregate_sequence;
    aggregate.updated_at = event.created_at.clone();
    Ok(())
}

fn replay_cancellation_reconciliation(
    aggregate: &mut RunAggregate,
    event: &RuntimeEvent,
) -> Result<(), RunAggregateError> {
    if aggregate.legacy_cancellation_requested
        || aggregate.cancellation_state != RunCancellationState::ReconciliationRequired
        || aggregate.machine.state() != RunState::WaitingForReconciliation
    {
        return Err(RunAggregateError::CancellationStateMismatch);
    }
    let payload = parse_cancellation_reconciliation_payload(&event.payload)?;
    let intent = aggregate
        .cancellation_intent
        .as_ref()
        .ok_or(RunAggregateError::CancellationIntentRequired)?;
    let settlement = aggregate
        .cancellation_settlement_history
        .iter()
        .find(|settlement| settlement.intent_id == intent.intent_id)
        .ok_or(RunAggregateError::CancellationStateMismatch)?;
    if payload.transition.previous != Some(aggregate.machine.state())
        || payload.intent_id != intent.intent_id
        || settlement.state != RunCancellationState::ReconciliationRequired
        || payload.unknown_effects_sha256 != settlement.evidence_sha256
        || aggregate.cancellation_evidence_sha256.as_deref()
            != Some(payload.unknown_effects_sha256.as_str())
        || payload.cancellation_disposition != cancellation_disposition(payload.decision)
        || event.idempotency_key
            != cancellation_reconciliation_event_idempotency_key(
                &aggregate.run_id,
                &payload.intent_id,
                &payload.attempt_id,
                &payload.unknown_effects_sha256,
                payload.cancellation_disposition,
            )
        || aggregate.reconciliation_history.iter().any(|record| {
            record.reconciliation_idempotency_key == payload.reconciliation_idempotency_key
                || record.attempt_id == payload.attempt_id
        })
    {
        return Err(RunAggregateError::CancellationStateMismatch);
    }
    transition_machine(&mut aggregate.machine, payload.transition.current)?;
    aggregate.cancellation_state = cancellation_state_after_reconciliation(payload.decision);
    aggregate
        .reconciliation_history
        .push(RunReconciliationRecord {
            event_version: 2,
            reconciliation_idempotency_key: payload.reconciliation_idempotency_key,
            attempt_id: payload.attempt_id,
            decision: payload.decision,
            duplicate_execution_acknowledged: payload.duplicate_execution_acknowledged,
            intent_id: Some(payload.intent_id),
            unknown_effects_sha256: Some(payload.unknown_effects_sha256),
            cancellation_disposition: Some(payload.cancellation_disposition),
        });
    aggregate.last_aggregate_sequence = event.aggregate_sequence;
    aggregate.updated_at = event.created_at.clone();
    Ok(())
}

fn parse_cancellation_intent_payload(
    value: &Value,
) -> Result<CancellationIntentPayload, RunAggregateError> {
    let object = value.as_object().ok_or(RunAggregateError::InvalidPayload)?;
    if object.len() != 11 {
        return Err(RunAggregateError::InvalidPayload);
    }
    let previous_cancellation_state =
        parse_cancellation_state_field(object, "previousCancellationState")?;
    let current_cancellation_state =
        parse_cancellation_state_field(object, "currentCancellationState")?;
    let run_state = object
        .get("runState")
        .and_then(Value::as_str)
        .ok_or(RunAggregateError::InvalidPayload)
        .and_then(parse_state)?;
    let intent = RunCancellationIntent {
        intent_id: required_text_field(object, "intentId")?,
        run_id: required_text_field(object, "runId")?,
        workspace_id: required_text_field(object, "workspaceId")?,
        cancel_idempotency_key: required_text_field(object, "cancelIdempotencyKey")?,
        reason: required_text_field(object, "reason")?,
        reason_sha256: required_sha256_field(object, "reasonSha256")?,
        requested_at: required_text_field(object, "requestedAt")?,
        command_message_id: required_text_field(object, "commandMessageId")?,
    };
    validate_cancellation_intent_fields(&intent)?;
    Ok(CancellationIntentPayload {
        previous_cancellation_state,
        current_cancellation_state,
        run_state,
        intent,
    })
}

fn parse_cancellation_settlement_payload(
    value: &Value,
    kind: CancellationSettlementKind,
) -> Result<CancellationSettlementPayload, RunAggregateError> {
    let object = value.as_object().ok_or(RunAggregateError::InvalidPayload)?;
    if object.len() != 7 {
        return Err(RunAggregateError::InvalidPayload);
    }
    let previous_cancellation_state =
        parse_cancellation_state_field(object, "previousCancellationState")?;
    let current_cancellation_state =
        parse_cancellation_state_field(object, "currentCancellationState")?;
    let transition = parse_transition_fields(object)?;
    let intent_id = required_sha256_field(object, "intentId")?;
    let evidence_sha256 = required_sha256_field(object, kind.evidence_field())?;
    Ok(CancellationSettlementPayload {
        previous_cancellation_state,
        current_cancellation_state,
        transition,
        intent_id,
        evidence_sha256,
    })
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

fn parse_cancellation_reconciliation_payload(
    value: &Value,
) -> Result<CancellationReconciliationPayload, RunAggregateError> {
    let object = value.as_object().ok_or(RunAggregateError::InvalidPayload)?;
    if object.len() != 10 {
        return Err(RunAggregateError::InvalidPayload);
    }
    let transition = parse_transition_fields(object)?;
    let reconciliation_idempotency_key =
        required_text_field(object, "reconciliationIdempotencyKey")?;
    let attempt_id = required_text_field(object, "attemptId")?;
    require_bounded_text(
        &reconciliation_idempotency_key,
        MAX_CANCEL_IDEMPOTENCY_KEY_BYTES,
    )?;
    require_bounded_text(&attempt_id, MAX_CANCELLATION_ID_BYTES)?;
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
    let expected = reconciliation_target(decision, duplicate_execution_acknowledged)?;
    if transition.current != expected {
        return Err(RunAggregateError::InvalidPayload);
    }
    let intent_id = required_sha256_field(object, "intentId")?;
    let unknown_effects_sha256 = required_sha256_field(object, "unknownEffectsSha256")?;
    let cancellation_disposition = object
        .get("cancellationDisposition")
        .and_then(Value::as_str)
        .ok_or(RunAggregateError::InvalidPayload)
        .and_then(parse_cancellation_disposition)?;
    Ok(CancellationReconciliationPayload {
        transition,
        reconciliation_idempotency_key,
        attempt_id,
        decision,
        duplicate_execution_acknowledged,
        intent_id,
        unknown_effects_sha256,
        cancellation_disposition,
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

fn cancellation_intent_recorded_event(
    intent: &RunCancellationIntent,
    run_state: RunState,
    previous_cancellation_state: RunCancellationState,
    idempotency_key: String,
) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: intent.run_id.clone(),
        aggregate_type: "run".to_owned(),
        aggregate_id: intent.run_id.clone(),
        message_id: intent.command_message_id.clone(),
        idempotency_key,
        event_type: "run.cancellation_intent_recorded".to_owned(),
        event_version: 1,
        payload: json!({
            "previousCancellationState": cancellation_state_name(previous_cancellation_state),
            "currentCancellationState": "intent_recorded",
            "runState": state_name(run_state),
            "intentId": intent.intent_id,
            "runId": intent.run_id,
            "workspaceId": intent.workspace_id,
            "cancelIdempotencyKey": intent.cancel_idempotency_key,
            "reason": intent.reason,
            "reasonSha256": intent.reason_sha256,
            "requestedAt": intent.requested_at,
            "commandMessageId": intent.command_message_id,
        }),
        created_at: intent.requested_at.clone(),
    }
}

#[allow(clippy::too_many_arguments)]
fn cancellation_settlement_event(
    run_id: &str,
    intent_id: &str,
    evidence_sha256: &str,
    metadata: EventMetadata<'_>,
    previous_run_state: RunState,
    current_run_state: RunState,
    previous_cancellation_state: RunCancellationState,
    current_cancellation_state: RunCancellationState,
    kind: CancellationSettlementKind,
) -> NewRuntimeEvent {
    let mut payload = serde_json::Map::new();
    payload.insert(
        "previousCancellationState".to_owned(),
        Value::String(cancellation_state_name(previous_cancellation_state).to_owned()),
    );
    payload.insert(
        "currentCancellationState".to_owned(),
        Value::String(cancellation_state_name(current_cancellation_state).to_owned()),
    );
    payload.insert(
        "previousState".to_owned(),
        Value::String(state_name(previous_run_state).to_owned()),
    );
    payload.insert(
        "currentState".to_owned(),
        Value::String(state_name(current_run_state).to_owned()),
    );
    payload.insert(
        "reason".to_owned(),
        metadata
            .reason
            .map_or(Value::Null, |value| Value::String(value.to_owned())),
    );
    payload.insert("intentId".to_owned(), Value::String(intent_id.to_owned()));
    payload.insert(
        kind.evidence_field().to_owned(),
        Value::String(evidence_sha256.to_owned()),
    );
    NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: "run".to_owned(),
        aggregate_id: run_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: cancellation_settlement_event_idempotency_key(
            run_id,
            intent_id,
            evidence_sha256,
            kind,
        ),
        event_type: kind.event_type().to_owned(),
        event_version: 1,
        payload: Value::Object(payload),
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

#[allow(clippy::too_many_arguments)]
fn cancellation_reconciliation_event_v2(
    run_id: &str,
    attempt_id: &str,
    decision: RunReconciliationDecision,
    duplicate_execution_acknowledged: bool,
    intent_id: &str,
    unknown_effects_sha256: &str,
    disposition: RunCancellationDisposition,
    metadata: EventMetadata<'_>,
    previous: RunState,
    current: RunState,
) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: run_id.to_owned(),
        aggregate_type: "run".to_owned(),
        aggregate_id: run_id.to_owned(),
        message_id: metadata.message_id.to_owned(),
        idempotency_key: cancellation_reconciliation_event_idempotency_key(
            run_id,
            intent_id,
            attempt_id,
            unknown_effects_sha256,
            disposition,
        ),
        event_type: "run.reconciled".to_owned(),
        event_version: 2,
        payload: json!({
            "previousState": state_name(previous),
            "currentState": state_name(current),
            "reason": metadata.reason,
            "reconciliationIdempotencyKey": metadata.idempotency_key,
            "attemptId": attempt_id,
            "decision": decision,
            "duplicateExecutionAcknowledged": duplicate_execution_acknowledged,
            "intentId": intent_id,
            "unknownEffectsSha256": unknown_effects_sha256,
            "cancellationDisposition": cancellation_disposition_name(disposition),
        }),
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
    validate_pinned_identity_common(identity, true)
}

fn validate_pinned_identity_common(
    identity: &RunPinnedIdentity,
    require_revision_hashes: bool,
) -> Result<(), RunAggregateError> {
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
        .is_some_and(|reference| invalid_revision_reference(reference, require_revision_hashes))
    {
        return Err(RunAggregateError::InvalidPinnedIdentity("goal"));
    }
    if identity
        .plan
        .as_ref()
        .is_some_and(|reference| invalid_revision_reference(reference, require_revision_hashes))
    {
        return Err(RunAggregateError::InvalidPinnedIdentity("plan"));
    }
    if identity
        .assignment
        .as_ref()
        .is_some_and(|reference| invalid_revision_reference(reference, require_revision_hashes))
    {
        return Err(RunAggregateError::InvalidPinnedIdentity("assignment"));
    }
    match identity.assignment.as_ref() {
        Some(_) => {
            if identity.goal.is_none()
                || identity.plan.is_none()
                || identity
                    .parent_run_id
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                || identity.delegation_depth != 1
            {
                return Err(RunAggregateError::InvalidPinnedIdentity("delegation"));
            }
        }
        None => {
            if identity.parent_run_id.is_some() || identity.delegation_depth != 0 {
                return Err(RunAggregateError::InvalidPinnedIdentity("delegation"));
            }
        }
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
    let canonical_scope = serde_json::to_vec(&identity.scope_resource_ids)
        .map_err(|_| RunAggregateError::InvalidPinnedIdentity("scopeResourceIds"))?;
    if identity.resource_scope_sha256 != format!("{:x}", Sha256::digest(canonical_scope)) {
        return Err(RunAggregateError::InvalidPinnedIdentity(
            "resourceScopeSha256",
        ));
    }
    Ok(())
}

fn invalid_revision_reference(
    reference: &novelx_protocol::RevisionReference,
    require_hash: bool,
) -> bool {
    if require_hash {
        reference.validate().is_err()
    } else {
        reference.validate_legacy_replay().is_err()
    }
}

fn validate_replayed_pinned_identity(
    identity: &RunPinnedIdentity,
) -> Result<(), RunAggregateError> {
    validate_pinned_identity_common(identity, false)
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
