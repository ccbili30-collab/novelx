use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use novelx_protocol::{MAX_SAFE_SEQUENCE, child_run_pinned_identity_sha256};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::event_journal::{EventJournal, EventJournalError, GlobalEventOrder, RuntimeEvent};
use crate::provider_effect_capability::{
    ProviderEffectCapabilityError, canonical_database_path_sha256,
};
use crate::run_aggregate::{
    RunAggregate, RunAggregateError, RunCancellationIntent, RunCancellationIntentRecord,
    RunCancellationState, derive_run_cancellation_intent_id,
    validate_cancellation_intent_runtime_event,
};
use crate::workspace_event_journal::WorkspaceEventJournalError;
use crate::workspace_runtime_lease::{BoundWorkspaceRuntimeLease, BoundWorkspaceRuntimeLeaseError};

const MAX_SNAPSHOT_ATTEMPTS: usize = 8;
const MAX_ID_BYTES: usize = 1_024;
const MAX_EVENT_TEXT_BYTES: usize = 16 * 1_024;
const MAX_EVENT_PAYLOAD_BYTES: usize = 64 * 1_024;
pub const RUN_CANCELLATION_INTENT_EVENT_HASH_SCHEME: &str = "novelx.runtime-event-hash/v1";

/// Process-local proof sealed to one live workspace lease and database file incarnation.
///
/// Its lease fields are revocation evidence, not durable database identifiers. Deliberately do not
/// add `Serialize` or `Deserialize`; durable recovery must reconstruct a new proof from journals
/// under the current bound lease.
///
/// ```compile_fail
/// use novelx_runtime::run_cancellation_service::RunCancellationIntentProof;
/// fn require_serialize<T: serde::Serialize>() {}
/// require_serialize::<RunCancellationIntentProof>();
/// ```
///
/// ```compile_fail
/// use novelx_runtime::run_cancellation_service::RunCancellationIntentProof;
/// fn require_deserialize<T: for<'de> serde::Deserialize<'de>>() {}
/// require_deserialize::<RunCancellationIntentProof>();
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunCancellationIntentProof {
    database_canonical_path_sha256: String,
    database_instance_id: String,
    lease_owner_id: String,
    lease_epoch: String,
    database_file_identity_sha256: String,
    workspace_id: String,
    project_id: String,
    run_id: String,
    intent: RunCancellationIntent,
    intent_event_run_sequence: u64,
    intent_event_aggregate_sequence: u64,
    intent_event_global_sequence: u64,
    intent_event_sha256: String,
    pinned_identity_sha256: String,
}

/// A process-local, move-only compare-and-swap fence.
///
/// This type deliberately does not implement `Clone`, `Serialize`, or `Deserialize`. Future write
/// APIs must take it by value. Multiple independently refreshed fences are still fail-closed:
/// the first global write invalidates every other fence through Global CAS.
///
/// ```compile_fail
/// use novelx_runtime::run_cancellation_service::RunCancellationWriteFence;
/// fn require_clone<T: Clone>() {}
/// require_clone::<RunCancellationWriteFence>();
/// ```
#[derive(Debug)]
pub struct RunCancellationWriteFence {
    proof: RunCancellationIntentProof,
    expected_run_sequence: u64,
    expected_run_aggregate_sequence: u64,
    expected_global_sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunCancellationRecordOutcome {
    Active(RunCancellationIntentProof),
    AlreadySettled {
        proof: RunCancellationIntentProof,
        settlement_state: RunCancellationState,
        evidence_sha256: String,
    },
}

impl RunCancellationIntentProof {
    /// SHA-256 of the canonical database path. This is a path binding, not an immutable file ID.
    pub fn database_canonical_path_sha256(&self) -> &str {
        &self.database_canonical_path_sha256
    }

    /// Stable logical identity stored by the runtime database itself.
    ///
    /// A byte-for-byte database copy deliberately retains this identity. The canonical-path hash
    /// prevents moving this proof to another path, while the current bound lease's OS file identity
    /// rejects same-lifetime replacement at that path. An offline new process acquires a new lease
    /// epoch and must reconstruct a new process-local proof from the journals.
    pub fn database_instance_id(&self) -> &str {
        &self.database_instance_id
    }

    /// Process-local lease owner that recovered this proof. This is not a durable database UUID.
    pub fn lease_owner_id(&self) -> &str {
        &self.lease_owner_id
    }

    /// Process-local lease epoch that recovered this proof.
    pub fn lease_epoch(&self) -> &str {
        &self.lease_epoch
    }

    /// Opaque lease-lifetime OS file-identity fingerprint, not a durable database UUID.
    pub fn database_file_identity_sha256(&self) -> &str {
        &self.database_file_identity_sha256
    }

    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn intent(&self) -> &RunCancellationIntent {
        &self.intent
    }

    pub const fn intent_event_run_sequence(&self) -> u64 {
        self.intent_event_run_sequence
    }

    pub const fn intent_event_aggregate_sequence(&self) -> u64 {
        self.intent_event_aggregate_sequence
    }

    pub const fn intent_event_global_sequence(&self) -> u64 {
        self.intent_event_global_sequence
    }

    pub fn intent_event_sha256(&self) -> &str {
        &self.intent_event_sha256
    }

    pub fn pinned_identity_sha256(&self) -> &str {
        &self.pinned_identity_sha256
    }
}

impl RunCancellationRecordOutcome {
    pub const fn proof(&self) -> &RunCancellationIntentProof {
        match self {
            Self::Active(proof) | Self::AlreadySettled { proof, .. } => proof,
        }
    }

    pub const fn is_active(&self) -> bool {
        matches!(self, Self::Active(_))
    }
}

impl RunCancellationWriteFence {
    pub const fn proof(&self) -> &RunCancellationIntentProof {
        &self.proof
    }

    pub const fn expected_run_sequence(&self) -> u64 {
        self.expected_run_sequence
    }

    pub const fn expected_run_aggregate_sequence(&self) -> u64 {
        self.expected_run_aggregate_sequence
    }

    pub const fn expected_global_sequence(&self) -> u64 {
        self.expected_global_sequence
    }

    pub const fn intent_event_global_sequence(&self) -> u64 {
        self.proof.intent_event_global_sequence()
    }

    pub fn lease_owner_id(&self) -> &str {
        self.proof.lease_owner_id()
    }

    pub fn lease_epoch(&self) -> &str {
        self.proof.lease_epoch()
    }

    pub fn database_file_identity_sha256(&self) -> &str {
        self.proof.database_file_identity_sha256()
    }
}

pub struct RunCancellationService {
    database_path: PathBuf,
    database_canonical_path_sha256: String,
    database_instance_id: String,
    bound_lease: Arc<BoundWorkspaceRuntimeLease>,
}

impl RunCancellationService {
    pub fn new(
        database_path: impl AsRef<Path>,
        bound_lease: Arc<BoundWorkspaceRuntimeLease>,
    ) -> Result<Self, RunCancellationServiceError> {
        let database_path = database_path.as_ref();
        verify_bound_database_path(database_path, &bound_lease)?;
        let journal = EventJournal::open(database_path)?;
        verify_bound_database_path(database_path, &bound_lease)?;
        let database_instance_id = journal.database_instance_id().to_owned();
        validate_database_instance_id(&database_instance_id)?;
        let canonical = std::fs::canonicalize(database_path)?;
        if !canonical.is_file() {
            return Err(RunCancellationServiceError::DatabasePathInvalid);
        }
        let database_canonical_path_sha256 = canonical_database_path_sha256(&canonical)?;
        Ok(Self {
            database_path: canonical,
            database_canonical_path_sha256,
            database_instance_id,
            bound_lease,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_intent(
        &self,
        workspace_id: &str,
        project_id: &str,
        run_id: &str,
        cancel_idempotency_key: &str,
        reason: &str,
        command_message_id: &str,
        requested_at: &str,
    ) -> Result<RunCancellationRecordOutcome, RunCancellationServiceError> {
        validate_identifier(workspace_id)?;
        validate_identifier(project_id)?;
        validate_identifier(run_id)?;
        validate_identifier(cancel_idempotency_key)?;
        validate_identifier(command_message_id)?;
        validate_reason(reason)?;
        validate_timestamp(requested_at)?;
        let mut last_global_conflict = None;
        for _ in 0..MAX_SNAPSHOT_ATTEMPTS {
            let mut journal = self.open_verified_journal()?;
            let expected_global_sequence = journal.current_global_sequence()?;
            validate_global_sequence(expected_global_sequence, true)?;
            let mut run = RunAggregate::recover(&journal, run_id)?;
            self.validate_run_scope(&run, workspace_id, project_id)?;
            if run.has_legacy_cancellation_pending() {
                return Err(RunCancellationServiceError::LegacyCancellationPending);
            }

            let record = match run.record_cancellation_intent_at_global_sequence(
                &mut journal,
                self.bound_lease.as_ref(),
                cancel_idempotency_key,
                reason,
                command_message_id,
                requested_at,
                expected_global_sequence,
            ) {
                Ok(record) => record,
                Err(error) if is_retryable_cas_conflict(&error) => {
                    last_global_conflict = Some(error);
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            let outcome = self.recover_record_outcome(run_id, record.intent())?;
            validate_record_matches_proof(&record, outcome.proof())?;
            return Ok(outcome);
        }
        Err(RunCancellationServiceError::ConcurrencyRetryExhausted {
            last_error: last_global_conflict.map(|error| error.to_string()),
        })
    }

    pub fn recover_active_intent(
        &self,
        run_id: &str,
    ) -> Result<Option<RunCancellationIntentProof>, RunCancellationServiceError> {
        validate_identifier(run_id)?;
        for _ in 0..MAX_SNAPSHOT_ATTEMPTS {
            match self.recover_active_intent_once(run_id) {
                Err(RunCancellationServiceError::SnapshotChanged { .. }) => continue,
                result => return result,
            }
        }
        Err(RunCancellationServiceError::SnapshotRetryExhausted)
    }

    pub fn scan_active_intents(
        &self,
        workspace_id: &str,
        project_id: &str,
    ) -> Result<Vec<RunCancellationIntentProof>, RunCancellationServiceError> {
        validate_identifier(workspace_id)?;
        validate_identifier(project_id)?;
        for _ in 0..MAX_SNAPSHOT_ATTEMPTS {
            match self.scan_active_intents_once(workspace_id, project_id) {
                Err(RunCancellationServiceError::SnapshotChanged { .. }) => continue,
                result => return result,
            }
        }
        Err(RunCancellationServiceError::SnapshotRetryExhausted)
    }

    pub fn refresh_write_fence(
        &self,
        proof: &RunCancellationIntentProof,
    ) -> Result<RunCancellationWriteFence, RunCancellationServiceError> {
        // Verify the service is still attached to its original logical database before evaluating
        // even a malformed or foreign proof.
        drop(self.open_verified_journal()?);
        validate_proof_shape(proof)?;
        if proof.database_canonical_path_sha256 != self.database_canonical_path_sha256 {
            return Err(RunCancellationServiceError::DatabaseCanonicalPathMismatch);
        }
        if proof.database_instance_id != self.database_instance_id {
            return Err(RunCancellationServiceError::DatabaseInstanceMismatch {
                expected: self.database_instance_id.clone(),
                actual: proof.database_instance_id.clone(),
            });
        }
        if proof.lease_epoch != self.bound_lease.lease_epoch() {
            return Err(RunCancellationServiceError::LeaseEpochMismatch {
                expected: proof.lease_epoch.clone(),
                actual: self.bound_lease.lease_epoch().to_owned(),
            });
        }
        if proof.lease_owner_id != self.bound_lease.owner_id() {
            return Err(RunCancellationServiceError::LeaseOwnerMismatch {
                expected: proof.lease_owner_id.clone(),
                actual: self.bound_lease.owner_id().to_owned(),
            });
        }
        if proof.database_file_identity_sha256 != self.bound_lease.database_file_identity_sha256() {
            return Err(RunCancellationServiceError::DatabaseFileIdentityMismatch {
                expected: proof.database_file_identity_sha256.clone(),
                actual: self.bound_lease.database_file_identity_sha256().to_owned(),
            });
        }
        for _ in 0..MAX_SNAPSHOT_ATTEMPTS {
            let journal = self.open_verified_journal()?;
            let before = journal.current_global_sequence()?;
            validate_global_sequence(before, true)?;
            let run = match RunAggregate::recover(&journal, proof.run_id()) {
                Ok(run) => run,
                Err(RunAggregateError::NotFound(_)) => {
                    // Migration 0006's ledger foreign key and schema-integrity check normally make
                    // this unreachable. Keep it fail-closed for catastrophic history loss or a
                    // separately initialized database that somehow escaped the identity barrier.
                    return Err(RunCancellationServiceError::RunEvidenceMissing);
                }
                Err(error) => return Err(error.into()),
            };
            if run.cancellation_state() != RunCancellationState::IntentRecorded {
                return Err(RunCancellationServiceError::IntentNotActive);
            }
            let recovered = self.proof_from_active_run(&journal, &run)?;
            if recovered != *proof {
                return Err(RunCancellationServiceError::ProofMismatch);
            }
            let after = journal.current_global_sequence()?;
            validate_global_sequence(after, true)?;
            if before != after {
                continue;
            }
            return Ok(RunCancellationWriteFence {
                proof: proof.clone(),
                expected_run_sequence: run.last_run_sequence(),
                expected_run_aggregate_sequence: run.last_sequence(),
                expected_global_sequence: before,
            });
        }
        Err(RunCancellationServiceError::SnapshotRetryExhausted)
    }

    fn recover_active_intent_once(
        &self,
        run_id: &str,
    ) -> Result<Option<RunCancellationIntentProof>, RunCancellationServiceError> {
        let journal = self.open_verified_journal()?;
        let before = journal.current_global_sequence()?;
        validate_global_sequence(before, true)?;
        let run = RunAggregate::recover(&journal, run_id)?;
        if run.has_legacy_cancellation_pending() {
            return Err(RunCancellationServiceError::LegacyCancellationPending);
        }
        let proof = if run.cancellation_state() == RunCancellationState::IntentRecorded {
            Some(self.proof_from_active_run(&journal, &run)?)
        } else {
            None
        };
        let after = journal.current_global_sequence()?;
        validate_global_sequence(after, true)?;
        if before != after {
            return Err(RunCancellationServiceError::SnapshotChanged { before, after });
        }
        Ok(proof)
    }

    fn recover_record_outcome(
        &self,
        run_id: &str,
        intent: &RunCancellationIntent,
    ) -> Result<RunCancellationRecordOutcome, RunCancellationServiceError> {
        for _ in 0..MAX_SNAPSHOT_ATTEMPTS {
            let journal = self.open_verified_journal()?;
            let before = journal.current_global_sequence()?;
            validate_global_sequence(before, true)?;
            let run = RunAggregate::recover(&journal, run_id)?;
            let proof = self.proof_from_intent(&journal, &run, intent)?;
            let outcome = if run.cancellation_state() == RunCancellationState::IntentRecorded
                && run.active_cancellation_intent() == Some(intent)
            {
                RunCancellationRecordOutcome::Active(proof)
            } else if let Some((settlement_state, evidence_sha256)) =
                run.cancellation_outcome_for_intent(intent.intent_id())
            {
                RunCancellationRecordOutcome::AlreadySettled {
                    proof,
                    settlement_state,
                    evidence_sha256: evidence_sha256.to_owned(),
                }
            } else {
                return Err(RunCancellationServiceError::IntentHistoryInconsistent);
            };
            let after = journal.current_global_sequence()?;
            validate_global_sequence(after, true)?;
            if before == after {
                return Ok(outcome);
            }
        }
        Err(RunCancellationServiceError::SnapshotRetryExhausted)
    }

    fn scan_active_intents_once(
        &self,
        workspace_id: &str,
        project_id: &str,
    ) -> Result<Vec<RunCancellationIntentProof>, RunCancellationServiceError> {
        let journal = self.open_verified_journal()?;
        let before = journal.current_global_sequence()?;
        validate_global_sequence(before, true)?;
        let mut proofs = Vec::new();
        for address in journal.list_aggregates("run")? {
            let run = RunAggregate::recover(&journal, &address.run_id)?;
            if run.has_legacy_cancellation_pending() {
                return Err(RunCancellationServiceError::LegacyCancellationPending);
            }
            if run.cancellation_state() != RunCancellationState::IntentRecorded {
                continue;
            }
            if run.pinned_identity().workspace_id != workspace_id {
                return Err(RunCancellationServiceError::WorkspaceMismatch {
                    expected: run.pinned_identity().workspace_id.clone(),
                    actual: workspace_id.to_owned(),
                });
            }
            if run.pinned_identity().project_id != project_id {
                return Err(RunCancellationServiceError::ProjectMismatch {
                    expected: run.pinned_identity().project_id.clone(),
                    actual: project_id.to_owned(),
                });
            }
            proofs.push(self.proof_from_active_run(&journal, &run)?);
        }
        proofs.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        let after = journal.current_global_sequence()?;
        validate_global_sequence(after, true)?;
        if before != after {
            return Err(RunCancellationServiceError::SnapshotChanged { before, after });
        }
        Ok(proofs)
    }

    fn proof_from_active_run(
        &self,
        journal: &EventJournal,
        run: &RunAggregate,
    ) -> Result<RunCancellationIntentProof, RunCancellationServiceError> {
        if run.cancellation_state() != RunCancellationState::IntentRecorded {
            return Err(RunCancellationServiceError::IntentNotActive);
        }
        let intent = run
            .active_cancellation_intent()
            .ok_or(RunCancellationServiceError::IntentNotActive)?;
        self.proof_from_intent(journal, run, intent)
    }

    fn proof_from_intent(
        &self,
        journal: &EventJournal,
        run: &RunAggregate,
        intent: &RunCancellationIntent,
    ) -> Result<RunCancellationIntentProof, RunCancellationServiceError> {
        self.validate_journal_identity(journal)?;
        let exact_event = exact_intent_event(journal, intent)?;
        let proof = RunCancellationIntentProof {
            database_canonical_path_sha256: self.database_canonical_path_sha256.clone(),
            database_instance_id: self.database_instance_id.clone(),
            lease_owner_id: self.bound_lease.owner_id().to_owned(),
            lease_epoch: self.bound_lease.lease_epoch().to_owned(),
            database_file_identity_sha256: self
                .bound_lease
                .database_file_identity_sha256()
                .to_owned(),
            workspace_id: run.pinned_identity().workspace_id.clone(),
            project_id: run.pinned_identity().project_id.clone(),
            run_id: run.run_id().to_owned(),
            intent: intent.clone(),
            intent_event_run_sequence: exact_event.event.run_sequence,
            intent_event_aggregate_sequence: exact_event.event.aggregate_sequence,
            intent_event_global_sequence: exact_event.global_sequence,
            intent_event_sha256: run_cancellation_intent_event_sha256(&exact_event.event)?,
            pinned_identity_sha256: child_run_pinned_identity_sha256(run.pinned_identity())?,
        };
        validate_proof_against_run(&proof, run, &exact_event)?;
        Ok(proof)
    }

    fn validate_run_scope(
        &self,
        run: &RunAggregate,
        asserted_workspace_id: &str,
        asserted_project_id: &str,
    ) -> Result<(), RunCancellationServiceError> {
        if run.pinned_identity().workspace_id != asserted_workspace_id {
            return Err(RunCancellationServiceError::WorkspaceMismatch {
                expected: run.pinned_identity().workspace_id.clone(),
                actual: asserted_workspace_id.to_owned(),
            });
        }
        if run.pinned_identity().project_id != asserted_project_id {
            return Err(RunCancellationServiceError::ProjectMismatch {
                expected: run.pinned_identity().project_id.clone(),
                actual: asserted_project_id.to_owned(),
            });
        }
        Ok(())
    }

    fn open_verified_journal(&self) -> Result<EventJournal, RunCancellationServiceError> {
        self.verify_bound_database()?;
        let actual = canonical_database_path_sha256(&self.database_path)?;
        if actual != self.database_canonical_path_sha256 {
            return Err(RunCancellationServiceError::DatabaseCanonicalPathMismatch);
        }
        let journal = EventJournal::open(&self.database_path)?;
        self.verify_bound_database()?;
        self.validate_journal_identity(&journal)?;
        Ok(journal)
    }

    fn verify_bound_database(&self) -> Result<(), RunCancellationServiceError> {
        verify_bound_database_path(&self.database_path, &self.bound_lease)
    }

    fn validate_journal_identity(
        &self,
        journal: &EventJournal,
    ) -> Result<(), RunCancellationServiceError> {
        let actual = journal.database_instance_id();
        if actual != self.database_instance_id {
            return Err(RunCancellationServiceError::DatabaseInstanceMismatch {
                expected: self.database_instance_id.clone(),
                actual: actual.to_owned(),
            });
        }
        Ok(())
    }
}

pub fn run_cancellation_intent_event_sha256(
    event: &RuntimeEvent,
) -> Result<String, RunCancellationServiceError> {
    validate_event_hash_fields(event)?;
    let material = json!({
        "scheme": RUN_CANCELLATION_INTENT_EVENT_HASH_SCHEME,
        "runId": event.run_id,
        "runSequence": event.run_sequence,
        "aggregateType": event.aggregate_type,
        "aggregateId": event.aggregate_id,
        "aggregateSequence": event.aggregate_sequence,
        "messageId": event.message_id,
        "idempotencyKey": event.idempotency_key,
        "eventType": event.event_type,
        "eventVersion": event.event_version,
        "payload": event.payload,
        "createdAt": event.created_at,
    });
    let canonical = canonical_json_bytes_for_javascript(&material)?;
    Ok(format!("{:x}", Sha256::digest(canonical)))
}

struct ExactIntentEvent {
    event: RuntimeEvent,
    global_sequence: u64,
}

fn exact_intent_event(
    journal: &EventJournal,
    intent: &RunCancellationIntent,
) -> Result<ExactIntentEvent, RunCancellationServiceError> {
    let matches = journal
        .read_aggregate(intent.run_id(), "run", intent.run_id(), 0)?
        .into_iter()
        .filter(|event| {
            event.event_type == "run.cancellation_intent_recorded"
                && event.payload.get("intentId").and_then(Value::as_str) == Some(intent.intent_id())
        })
        .collect::<Vec<_>>();
    let [event] = matches.as_slice() else {
        return Err(RunCancellationServiceError::IntentEventMissingOrDuplicated);
    };
    validate_cancellation_intent_runtime_event(event, intent)
        .map_err(|_| RunCancellationServiceError::EventEvidenceMismatch)?;
    let global_sequence = match journal.global_order_for_message(&event.message_id) {
        Ok(Some(GlobalEventOrder::Ordered(sequence))) => sequence,
        Ok(Some(GlobalEventOrder::LegacyUnordered)) => {
            return Err(RunCancellationServiceError::IntentEventLegacyUnordered);
        }
        Ok(None) | Err(EventJournalError::GlobalEventOrderMissing { .. }) => {
            return Err(RunCancellationServiceError::IntentEventGlobalOrderMissing);
        }
        Err(error) => return Err(error.into()),
    };
    validate_global_sequence(global_sequence, false)?;
    Ok(ExactIntentEvent {
        event: event.clone(),
        global_sequence,
    })
}

fn validate_record_matches_proof(
    record: &RunCancellationIntentRecord,
    proof: &RunCancellationIntentProof,
) -> Result<(), RunCancellationServiceError> {
    if record.intent() != proof.intent()
        || record.event().run_sequence != proof.intent_event_run_sequence
        || record.event().aggregate_sequence != proof.intent_event_aggregate_sequence
        || run_cancellation_intent_event_sha256(record.event())? != proof.intent_event_sha256
    {
        return Err(RunCancellationServiceError::ProofMismatch);
    }
    Ok(())
}

fn validate_proof_against_run(
    proof: &RunCancellationIntentProof,
    run: &RunAggregate,
    exact_event: &ExactIntentEvent,
) -> Result<(), RunCancellationServiceError> {
    validate_proof_shape(proof)?;
    let event = &exact_event.event;
    validate_cancellation_intent_runtime_event(event, proof.intent())
        .map_err(|_| RunCancellationServiceError::EventEvidenceMismatch)?;
    if proof.workspace_id != run.pinned_identity().workspace_id
        || proof.project_id != run.pinned_identity().project_id
        || proof.run_id != run.run_id()
        || proof.intent.workspace_id() != proof.workspace_id
        || proof.intent.run_id() != proof.run_id
        || proof.intent_event_run_sequence != event.run_sequence
        || proof.intent_event_aggregate_sequence != event.aggregate_sequence
        // The event hash binds the exact message ID while the immutable global ledger binds that
        // same message ID to this sequence; both halves must match the recovered evidence.
        || proof.intent_event_global_sequence != exact_event.global_sequence
        || proof.intent_event_sha256 != run_cancellation_intent_event_sha256(event)?
        || proof.pinned_identity_sha256 != child_run_pinned_identity_sha256(run.pinned_identity())?
    {
        return Err(RunCancellationServiceError::ProofMismatch);
    }
    Ok(())
}

fn validate_proof_shape(
    proof: &RunCancellationIntentProof,
) -> Result<(), RunCancellationServiceError> {
    validate_sha256(&proof.database_canonical_path_sha256)?;
    validate_database_instance_id(&proof.database_instance_id)?;
    validate_database_instance_id(&proof.lease_owner_id)?;
    validate_database_instance_id(&proof.lease_epoch)?;
    validate_sha256(&proof.database_file_identity_sha256)?;
    validate_identifier(&proof.workspace_id)?;
    validate_identifier(&proof.project_id)?;
    validate_identifier(&proof.run_id)?;
    validate_sha256(proof.intent.intent_id())?;
    validate_sha256(proof.intent.reason_sha256())?;
    validate_sha256(&proof.intent_event_sha256)?;
    validate_sha256(&proof.pinned_identity_sha256)?;
    if proof.intent_event_run_sequence == 0
        || proof.intent_event_aggregate_sequence == 0
        || proof.intent_event_global_sequence == 0
        || proof.intent_event_run_sequence > MAX_SAFE_SEQUENCE
        || proof.intent_event_aggregate_sequence > MAX_SAFE_SEQUENCE
        || proof.intent_event_global_sequence > MAX_SAFE_SEQUENCE
    {
        return Err(RunCancellationServiceError::ProofInvalid);
    }
    let derived = derive_run_cancellation_intent_id(
        proof.intent.workspace_id(),
        proof.intent.run_id(),
        proof.intent.cancel_idempotency_key(),
        proof.intent.reason(),
    )?;
    if derived != proof.intent.intent_id()
        || format!("{:x}", Sha256::digest(proof.intent.reason().as_bytes()))
            != proof.intent.reason_sha256()
    {
        return Err(RunCancellationServiceError::ProofInvalid);
    }
    validate_timestamp(proof.intent.requested_at())?;
    validate_identifier(proof.intent.command_message_id())?;
    Ok(())
}

fn validate_database_instance_id(value: &str) -> Result<(), RunCancellationServiceError> {
    let parsed =
        uuid::Uuid::parse_str(value).map_err(|_| RunCancellationServiceError::ProofInvalid)?;
    if parsed.to_string() == value {
        Ok(())
    } else {
        Err(RunCancellationServiceError::ProofInvalid)
    }
}

fn verify_bound_database_path(
    database_path: &Path,
    bound_lease: &BoundWorkspaceRuntimeLease,
) -> Result<(), RunCancellationServiceError> {
    bound_lease
        .verify_database_file_current()
        .map_err(map_bound_lease_error)?;
    let canonical = std::fs::canonicalize(database_path).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            RunCancellationServiceError::DatabaseFileMissing {
                path: database_path.to_owned(),
            }
        } else {
            RunCancellationServiceError::DatabaseFileIdentityUnavailable {
                path: database_path.to_owned(),
                source,
            }
        }
    })?;
    if canonical != bound_lease.database_path() {
        return Err(RunCancellationServiceError::DatabaseLeasePathMismatch {
            expected: bound_lease.database_path().to_owned(),
            actual: canonical,
        });
    }
    Ok(())
}

fn map_bound_lease_error(error: BoundWorkspaceRuntimeLeaseError) -> RunCancellationServiceError {
    match error {
        BoundWorkspaceRuntimeLeaseError::WorkspaceLeasePathMismatch {
            lock_path,
            database_path,
        } => RunCancellationServiceError::WorkspaceLeasePathMismatch {
            lock_path,
            database_path,
        },
        BoundWorkspaceRuntimeLeaseError::DatabaseFileMissing { path } => {
            RunCancellationServiceError::DatabaseFileMissing { path }
        }
        BoundWorkspaceRuntimeLeaseError::DatabasePathNotRegularFile { path } => {
            RunCancellationServiceError::DatabasePathNotRegularFile { path }
        }
        BoundWorkspaceRuntimeLeaseError::DatabaseFileIdentityUnavailable { path, source } => {
            RunCancellationServiceError::DatabaseFileIdentityUnavailable { path, source }
        }
        BoundWorkspaceRuntimeLeaseError::DatabaseFileReplaced {
            bound_path,
            actual_path,
        } => RunCancellationServiceError::DatabaseFileReplaced {
            bound_path,
            actual_path,
        },
        BoundWorkspaceRuntimeLeaseError::DatabaseIdentityHashInvalid => {
            RunCancellationServiceError::DatabaseIdentityHashInvalid
        }
        BoundWorkspaceRuntimeLeaseError::DatabaseIdentityAlreadyBound {
            database_file_identity_sha256,
            lock_path,
        } => RunCancellationServiceError::DatabaseIdentityAlreadyBound {
            database_file_identity_sha256,
            lock_path,
        },
        BoundWorkspaceRuntimeLeaseError::DatabaseIdentityLockUnavailable { path, source } => {
            RunCancellationServiceError::DatabaseIdentityLockUnavailable { path, source }
        }
        BoundWorkspaceRuntimeLeaseError::DatabaseIdentityLockUnsafe { path } => {
            RunCancellationServiceError::DatabaseIdentityLockUnsafe { path }
        }
        BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockBaseUnavailable { variable } => {
            RunCancellationServiceError::GlobalIdentityLockBaseUnavailable { variable }
        }
        BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnavailable {
            path,
            source,
        } => RunCancellationServiceError::GlobalIdentityLockDirectoryUnavailable { path, source },
        BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnsafe { path } => {
            RunCancellationServiceError::GlobalIdentityLockDirectoryUnsafe { path }
        }
        BoundWorkspaceRuntimeLeaseError::LeaseOwnerMismatch { expected, actual } => {
            RunCancellationServiceError::LeaseOwnerMismatch { expected, actual }
        }
        BoundWorkspaceRuntimeLeaseError::LeaseEpochMismatch { expected, actual } => {
            RunCancellationServiceError::LeaseEpochMismatch { expected, actual }
        }
    }
}

fn validate_global_sequence(
    value: u64,
    allow_zero: bool,
) -> Result<(), RunCancellationServiceError> {
    if value > MAX_SAFE_SEQUENCE || (!allow_zero && value == 0) {
        return Err(RunCancellationServiceError::GlobalSequenceOutOfRange { actual: value });
    }
    Ok(())
}

fn validate_event_hash_fields(event: &RuntimeEvent) -> Result<(), RunCancellationServiceError> {
    for value in [
        event.run_id.as_str(),
        event.aggregate_type.as_str(),
        event.aggregate_id.as_str(),
        event.message_id.as_str(),
        event.idempotency_key.as_str(),
        event.event_type.as_str(),
    ] {
        validate_event_text(value)?;
    }
    validate_timestamp(&event.created_at)?;
    if event.run_sequence == 0
        || event.run_sequence > MAX_SAFE_SEQUENCE
        || event.aggregate_sequence == 0
        || event.aggregate_sequence > MAX_SAFE_SEQUENCE
        || event.event_version == 0
    {
        return Err(RunCancellationServiceError::EventEvidenceMismatch);
    }
    let payload = serde_json::to_vec(&event.payload)?;
    if payload.len() > MAX_EVENT_PAYLOAD_BYTES {
        return Err(RunCancellationServiceError::InputTooLarge);
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), RunCancellationServiceError> {
    if value.is_empty() || value.trim() != value {
        return Err(RunCancellationServiceError::InputInvalid);
    }
    if value.len() > MAX_ID_BYTES {
        return Err(RunCancellationServiceError::InputTooLarge);
    }
    Ok(())
}

fn validate_reason(value: &str) -> Result<(), RunCancellationServiceError> {
    if value.trim().is_empty() {
        return Err(RunCancellationServiceError::InputInvalid);
    }
    if value.len() > MAX_EVENT_TEXT_BYTES {
        return Err(RunCancellationServiceError::InputTooLarge);
    }
    Ok(())
}

fn validate_event_text(value: &str) -> Result<(), RunCancellationServiceError> {
    if value.trim().is_empty() {
        return Err(RunCancellationServiceError::EventEvidenceMismatch);
    }
    if value.len() > MAX_EVENT_TEXT_BYTES {
        return Err(RunCancellationServiceError::InputTooLarge);
    }
    Ok(())
}

fn validate_timestamp(value: &str) -> Result<(), RunCancellationServiceError> {
    if value.len() > 128 || OffsetDateTime::parse(value, &Rfc3339).is_err() {
        return Err(RunCancellationServiceError::TimestampInvalid);
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), RunCancellationServiceError> {
    if value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        Ok(())
    } else {
        Err(RunCancellationServiceError::ProofInvalid)
    }
}

fn is_retryable_cas_conflict(error: &RunAggregateError) -> bool {
    matches!(
        error,
        RunAggregateError::Journal(
            EventJournalError::GlobalSequenceConflict { .. }
                | EventJournalError::RunSequenceConflict { .. }
                | EventJournalError::AggregateSequenceConflict { .. }
        )
    )
}

fn canonical_json_bytes_for_javascript(value: &Value) -> Result<Vec<u8>, serde_json::Error> {
    let mut output = Vec::new();
    write_canonical_json_for_javascript(value, &mut output)?;
    Ok(output)
}

fn write_canonical_json_for_javascript(
    value: &Value,
    output: &mut Vec<u8>,
) -> Result<(), serde_json::Error> {
    match value {
        Value::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_canonical_json_for_javascript(value, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            // JavaScript's default Array#sort compares UTF-16 code units. Rust String ordering
            // compares Unicode scalar UTF-8 bytes, which differs for non-BMP keys versus BMP
            // keys above the surrogate range. The event hash is consumed by TypeScript, so its
            // canonical key order is explicitly the JavaScript order.
            entries.sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
            output.push(b'{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                serde_json::to_writer(&mut *output, key)?;
                output.push(b':');
                write_canonical_json_for_javascript(value, output)?;
            }
            output.push(b'}');
        }
        scalar => serde_json::to_writer(output, scalar)?,
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum RunCancellationServiceError {
    #[error("Run cancellation database path is invalid")]
    DatabasePathInvalid,
    #[error("Run cancellation proof belongs to another canonical database path")]
    DatabaseCanonicalPathMismatch,
    #[error("Run cancellation database identity differs: expected {expected}, actual {actual}")]
    DatabaseInstanceMismatch { expected: String, actual: String },
    #[error(
        "Run cancellation service database path differs from the bound lease: expected {expected}, actual {actual}",
        expected = .expected.display(),
        actual = .actual.display()
    )]
    DatabaseLeasePathMismatch { expected: PathBuf, actual: PathBuf },
    #[error(
        "Workspace runtime lease path does not protect the cancellation database: lock={lock}, database={database}",
        lock = .lock_path.display(),
        database = .database_path.display()
    )]
    WorkspaceLeasePathMismatch {
        lock_path: PathBuf,
        database_path: PathBuf,
    },
    #[error("Run cancellation database file does not exist: {path}", path = .path.display())]
    DatabaseFileMissing { path: PathBuf },
    #[error("Run cancellation database path is not a regular file: {path}", path = .path.display())]
    DatabasePathNotRegularFile { path: PathBuf },
    #[error(
        "Run cancellation database file identity is unavailable: {path}",
        path = .path.display()
    )]
    DatabaseFileIdentityUnavailable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "Run cancellation database file was replaced: bound={bound}, actual={actual}",
        bound = .bound_path.display(),
        actual = .actual_path.display()
    )]
    DatabaseFileReplaced {
        bound_path: PathBuf,
        actual_path: PathBuf,
    },
    #[error("Run cancellation database file identity hash is invalid")]
    DatabaseIdentityHashInvalid,
    #[error("Run cancellation database identity is already bound by another runtime")]
    DatabaseIdentityAlreadyBound {
        database_file_identity_sha256: String,
        lock_path: PathBuf,
    },
    #[error(
        "Run cancellation database identity lock is unavailable: {path}",
        path = .path.display()
    )]
    DatabaseIdentityLockUnavailable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "Run cancellation database identity lock path is unsafe: {path}",
        path = .path.display()
    )]
    DatabaseIdentityLockUnsafe { path: PathBuf },
    #[error("Run cancellation global identity lock base is unavailable: {variable}")]
    GlobalIdentityLockBaseUnavailable { variable: &'static str },
    #[error(
        "Run cancellation global identity lock directory is unavailable: {path}",
        path = .path.display()
    )]
    GlobalIdentityLockDirectoryUnavailable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "Run cancellation global identity lock directory is unsafe: {path}",
        path = .path.display()
    )]
    GlobalIdentityLockDirectoryUnsafe { path: PathBuf },
    #[error("Run cancellation proof lease owner differs: expected {expected}, actual {actual}")]
    LeaseOwnerMismatch { expected: String, actual: String },
    #[error("Run cancellation proof lease epoch differs: expected {expected}, actual {actual}")]
    LeaseEpochMismatch { expected: String, actual: String },
    #[error("Run cancellation proof database file identity differs")]
    DatabaseFileIdentityMismatch { expected: String, actual: String },
    #[error("Run cancellation input is invalid")]
    InputInvalid,
    #[error("Run cancellation input exceeds its supported size")]
    InputTooLarge,
    #[error("Run cancellation timestamp is not bounded RFC 3339")]
    TimestampInvalid,
    #[error("Run cancellation workspace differs: expected {expected}, actual {actual}")]
    WorkspaceMismatch { expected: String, actual: String },
    #[error("Run cancellation project differs: expected {expected}, actual {actual}")]
    ProjectMismatch { expected: String, actual: String },
    #[error("Run has a pending legacy cancellation and cannot enter the durable cancellation Saga")]
    LegacyCancellationPending,
    #[error("Run cancellation intent is not active")]
    IntentNotActive,
    #[error("Run cancellation proof references Run evidence that is no longer present")]
    RunEvidenceMissing,
    #[error("Run cancellation exact intent event is missing or duplicated")]
    IntentEventMissingOrDuplicated,
    #[error("Run cancellation exact intent event has no durable global-order row")]
    IntentEventGlobalOrderMissing,
    #[error("Run cancellation exact intent event predates durable global ordering")]
    IntentEventLegacyUnordered,
    #[error("Run cancellation intent history has neither an active intent nor a settlement")]
    IntentHistoryInconsistent,
    #[error("Run cancellation exact event evidence does not match the persisted intent")]
    EventEvidenceMismatch,
    #[error("Run cancellation proof is malformed")]
    ProofInvalid,
    #[error("Run cancellation proof does not match current durable evidence")]
    ProofMismatch,
    #[error("Run cancellation global sequence is outside the cross-language safe range: {actual}")]
    GlobalSequenceOutOfRange { actual: u64 },
    #[error("Run cancellation snapshot changed during verification: {before} -> {after}")]
    SnapshotChanged { before: u64, after: u64 },
    #[error("Run cancellation could not obtain a stable bounded snapshot")]
    SnapshotRetryExhausted,
    #[error("Run cancellation CAS retries were exhausted: {last_error:?}")]
    ConcurrencyRetryExhausted { last_error: Option<String> },
    #[error(transparent)]
    Run(#[from] RunAggregateError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    WorkspaceJournal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Capability(#[from] ProviderEffectCapabilityError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
