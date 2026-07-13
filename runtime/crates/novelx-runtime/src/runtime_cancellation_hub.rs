use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use thiserror::Error;
use tokio::sync::watch;
use uuid::Uuid;

use crate::provider_pre_send_gate::{
    CancellationLinearization, PreSendGateError, PreSendGateSnapshot, PreSendGateState,
    PreSendLinearizationGate, SentReservation,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancellationCause {
    RuntimeShutdown,
    HostDisconnected,
    RunCancel,
}

impl CancellationCause {
    const fn is_global(self) -> bool {
        matches!(self, Self::RuntimeShutdown | Self::HostDisconnected)
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RecoveryTaskIdentity {
    workspace_id: String,
    run_id: String,
    operation_id: String,
    execution_id: String,
    attempt_id: String,
}

impl RecoveryTaskIdentity {
    pub fn new(
        workspace_id: impl Into<String>,
        run_id: impl Into<String>,
        operation_id: impl Into<String>,
        execution_id: impl Into<String>,
        attempt_id: impl Into<String>,
    ) -> Result<Self, RuntimeCancellationHubError> {
        let identity = Self {
            workspace_id: workspace_id.into(),
            run_id: run_id.into(),
            operation_id: operation_id.into(),
            execution_id: execution_id.into(),
            attempt_id: attempt_id.into(),
        };
        require_identity_text("workspace_id", &identity.workspace_id)?;
        require_identity_text("run_id", &identity.run_id)?;
        require_identity_text("operation_id", &identity.operation_id)?;
        require_identity_text("execution_id", &identity.execution_id)?;
        require_identity_text("attempt_id", &identity.attempt_id)?;
        Ok(identity)
    }

    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn execution_id(&self) -> &str {
        &self.execution_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }
}

#[derive(Clone)]
pub struct RuntimeCancellationHub {
    hub_instance_id: Uuid,
    inner: Arc<Mutex<HubState>>,
}

#[derive(Default)]
struct HubState {
    registrations: HashMap<RecoveryTaskIdentity, RegistrationEntry>,
    attempt_owners: HashMap<AttemptOwnerKey, RecoveryTaskIdentity>,
    execution_owners: HashMap<ExecutionOwnerKey, RecoveryTaskIdentity>,
    global_cancellation: Option<StickyCancellation>,
    run_cancellations: HashMap<RunKey, StickyRunCancellation>,
    next_signal_sequence: u64,
}

#[derive(Clone)]
struct RegistrationEntry {
    gate: PreSendLinearizationGate,
    registration_id: Uuid,
}

#[derive(Clone, Copy)]
struct StickyCancellation {
    cause: CancellationCause,
    sequence: u64,
}

#[derive(Clone)]
struct StickyRunCancellation {
    intent_id: String,
    signal: StickyCancellation,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct AttemptOwnerKey {
    workspace_id: String,
    run_id: String,
    attempt_id: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ExecutionOwnerKey {
    workspace_id: String,
    run_id: String,
    operation_id: String,
    execution_id: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RunKey {
    workspace_id: String,
    run_id: String,
}

impl RuntimeCancellationHub {
    pub fn new() -> Self {
        Self {
            hub_instance_id: Uuid::new_v4(),
            inner: Arc::new(Mutex::new(HubState::default())),
        }
    }

    pub fn register(
        &self,
        identity: RecoveryTaskIdentity,
    ) -> Result<RecoveryTaskRegistration, RuntimeCancellationHubError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?;
        if state.registrations.contains_key(&identity) {
            return Err(RuntimeCancellationHubError::RegistrationAlreadyActive);
        }
        let attempt_key = AttemptOwnerKey::from(&identity);
        let execution_key = ExecutionOwnerKey::from(&identity);
        reject_identity_conflict(state.attempt_owners.get(&attempt_key), &identity)?;
        reject_identity_conflict(state.execution_owners.get(&execution_key), &identity)?;

        let run_key = RunKey::from(&identity);
        let initial_cancellation = earliest_cancellation(
            state.global_cancellation,
            state
                .run_cancellations
                .get(&run_key)
                .map(|cancellation| cancellation.signal),
        )
        .map(|signal| signal.cause);
        let gate = initial_cancellation.map_or_else(
            PreSendLinearizationGate::open,
            PreSendLinearizationGate::cancelled,
        );
        let registration_id = Uuid::new_v4();
        state.attempt_owners.insert(attempt_key, identity.clone());
        state
            .execution_owners
            .insert(execution_key, identity.clone());
        state.registrations.insert(
            identity.clone(),
            RegistrationEntry {
                gate: gate.clone(),
                registration_id,
            },
        );
        Ok(RecoveryTaskRegistration {
            identity,
            gate,
            registration_id,
        })
    }

    pub fn unregister(
        &self,
        registration: &RecoveryTaskRegistration,
    ) -> Result<UnregisterReceipt, RuntimeCancellationHubError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?;
        let identity = registration.identity();
        let attempt_key = AttemptOwnerKey::from(identity);
        let execution_key = ExecutionOwnerKey::from(identity);
        let Some(entry) = state.registrations.get(identity) else {
            reject_identity_conflict(state.attempt_owners.get(&attempt_key), identity)?;
            reject_identity_conflict(state.execution_owners.get(&execution_key), identity)?;
            return Ok(UnregisterReceipt {
                was_registered: false,
            });
        };
        if entry.registration_id != registration.registration_id {
            return Err(RuntimeCancellationHubError::StaleRegistration);
        }
        let phase = entry.gate.snapshot()?.state();
        if !matches!(
            phase,
            PreSendGateState::CancelledBeforeSent
                | PreSendGateState::SentCommitted
                | PreSendGateState::DispatchBoundaryUnknown
        ) {
            return Err(RuntimeCancellationHubError::UnregisterBeforeTerminal(phase));
        }
        verify_owner(&state.attempt_owners, &attempt_key, identity)?;
        verify_owner(&state.execution_owners, &execution_key, identity)?;
        state.registrations.remove(identity);
        state.attempt_owners.remove(&attempt_key);
        state.execution_owners.remove(&execution_key);
        Ok(UnregisterReceipt {
            was_registered: true,
        })
    }

    pub(crate) fn abandon_before_sent(
        &self,
        registration: &RecoveryTaskRegistration,
    ) -> Result<AbandonBeforeSentReceipt, RuntimeCancellationHubError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?;
        let identity = registration.identity();
        let attempt_key = AttemptOwnerKey::from(identity);
        let execution_key = ExecutionOwnerKey::from(identity);
        let Some(entry) = state.registrations.get(identity) else {
            reject_identity_conflict(state.attempt_owners.get(&attempt_key), identity)?;
            reject_identity_conflict(state.execution_owners.get(&execution_key), identity)?;
            return Ok(AbandonBeforeSentReceipt {
                was_registered: false,
                cancellation_cause: None,
                cancellation_intent_id: None,
            });
        };
        if entry.registration_id != registration.registration_id {
            return Err(RuntimeCancellationHubError::StaleRegistration);
        }
        let snapshot = entry.gate.snapshot()?;
        let phase = snapshot.state();
        if !matches!(
            phase,
            PreSendGateState::Open | PreSendGateState::CancelledBeforeSent
        ) {
            return Err(RuntimeCancellationHubError::AbandonAfterSentBoundary(phase));
        }
        verify_owner(&state.attempt_owners, &attempt_key, identity)?;
        verify_owner(&state.execution_owners, &execution_key, identity)?;
        let cancellation_intent_id = match snapshot.cancellation_cause() {
            Some(CancellationCause::RunCancel) => {
                let run_key = RunKey::from(identity);
                let cancellation = state
                    .run_cancellations
                    .get(&run_key)
                    .filter(|cancellation| {
                        cancellation.signal.cause == CancellationCause::RunCancel
                    })
                    .ok_or(RuntimeCancellationHubError::StateInvariant)?;
                Some(cancellation.intent_id.clone())
            }
            _ => None,
        };
        state.registrations.remove(identity);
        state.attempt_owners.remove(&attempt_key);
        state.execution_owners.remove(&execution_key);
        Ok(AbandonBeforeSentReceipt {
            was_registered: true,
            cancellation_cause: snapshot.cancellation_cause(),
            cancellation_intent_id,
        })
    }

    pub fn signal_global(
        &self,
        cause: CancellationCause,
    ) -> Result<CancellationSignalReceipt, RuntimeCancellationHubError> {
        if !cause.is_global() {
            return Err(RuntimeCancellationHubError::GlobalCauseRequired);
        }
        let mut state = self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?;
        let effective = match state.global_cancellation {
            Some(signal) => signal,
            None => {
                let signal = next_sticky_signal(&mut state, cause)?;
                state.global_cancellation = Some(signal);
                signal
            }
        };
        let receipt = signal_matching(state.registrations.iter(), effective.cause, |_| true)?;
        drop(state);
        #[cfg(feature = "runtime-test-failpoints")]
        crate::runtime_test_failpoint::observe("runtime_cancellation.global_signalled");
        Ok(receipt)
    }

    pub fn signal_run_cancel(
        &self,
        workspace_id: &str,
        run_id: &str,
        intent_id: &str,
    ) -> Result<CancellationSignalReceipt, RuntimeCancellationHubError> {
        self.apply_run_cancel(workspace_id, run_id, intent_id)
    }

    pub fn hydrate_run_cancel(
        &self,
        workspace_id: &str,
        run_id: &str,
        intent_id: &str,
    ) -> Result<CancellationSignalReceipt, RuntimeCancellationHubError> {
        self.apply_run_cancel(workspace_id, run_id, intent_id)
    }

    pub fn active_run_cancellation(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<Option<ActiveRunCancellation>, RuntimeCancellationHubError> {
        require_identity_text("workspace_id", workspace_id)?;
        require_identity_text("run_id", run_id)?;
        let state = self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?;
        let run_key = RunKey {
            workspace_id: workspace_id.to_owned(),
            run_id: run_id.to_owned(),
        };
        Ok(state
            .run_cancellations
            .get(&run_key)
            .map(|cancellation| ActiveRunCancellation {
                intent_id: cancellation.intent_id.clone(),
                signal_sequence: cancellation.signal.sequence,
            }))
    }

    /// Test-only authority hook for exercising move-only settlement semantics.
    /// Production code intentionally has no raw-string capability constructor;
    /// the durable coordinator must later accept sealed Journal settlement proof.
    #[cfg(test)]
    pub(crate) fn authorize_run_cancellation_settled(
        &self,
        workspace_id: &str,
        run_id: &str,
        intent_id: &str,
    ) -> Result<RunCancellationSettledCapability, RuntimeCancellationHubError> {
        require_identity_text("workspace_id", workspace_id)?;
        require_identity_text("run_id", run_id)?;
        require_canonical_sha256("intent_id", intent_id)?;
        let state = self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?;
        let run_key = RunKey {
            workspace_id: workspace_id.to_owned(),
            run_id: run_id.to_owned(),
        };
        let cancellation = state
            .run_cancellations
            .get(&run_key)
            .ok_or(RuntimeCancellationHubError::RunCancelNotActive)?;
        require_matching_run_cancel_intent(&cancellation.intent_id, intent_id)?;
        Ok(RunCancellationSettledCapability {
            hub_instance_id: self.hub_instance_id,
            run_key,
            intent_id: intent_id.to_owned(),
            signal_sequence: cancellation.signal.sequence,
        })
    }

    pub fn clear_run_cancel(
        &self,
        settled: RunCancellationSettledCapability,
    ) -> Result<RunCancellationClearReceipt, RuntimeCancellationHubError> {
        if settled.hub_instance_id != self.hub_instance_id {
            return Err(RuntimeCancellationHubError::RunCancelCapabilityHubMismatch);
        }
        let mut state = self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?;
        let active_registrations = state
            .registrations
            .keys()
            .filter(|identity| {
                identity.workspace_id == settled.run_key.workspace_id
                    && identity.run_id == settled.run_key.run_id
            })
            .count();
        if active_registrations != 0 {
            return Err(RuntimeCancellationHubError::RunCancelRegistrationsActive {
                active_registrations,
            });
        }
        let cancellation = state
            .run_cancellations
            .get(&settled.run_key)
            .ok_or(RuntimeCancellationHubError::RunCancelNotActive)?;
        require_matching_run_cancel_intent(&cancellation.intent_id, &settled.intent_id)?;
        if cancellation.signal.sequence != settled.signal_sequence {
            return Err(RuntimeCancellationHubError::RunCancelCapabilityStale);
        }
        state.run_cancellations.remove(&settled.run_key);
        Ok(RunCancellationClearReceipt {
            workspace_id: settled.run_key.workspace_id,
            run_id: settled.run_key.run_id,
            intent_id: settled.intent_id,
            signal_sequence: settled.signal_sequence,
        })
    }

    fn apply_run_cancel(
        &self,
        workspace_id: &str,
        run_id: &str,
        intent_id: &str,
    ) -> Result<CancellationSignalReceipt, RuntimeCancellationHubError> {
        require_identity_text("workspace_id", workspace_id)?;
        require_identity_text("run_id", run_id)?;
        require_canonical_sha256("intent_id", intent_id)?;
        let mut state = self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?;
        let run_key = RunKey {
            workspace_id: workspace_id.to_owned(),
            run_id: run_id.to_owned(),
        };
        let effective = match state.run_cancellations.get(&run_key) {
            Some(cancellation) => {
                require_matching_run_cancel_intent(&cancellation.intent_id, intent_id)?;
                cancellation.signal
            }
            None => {
                let signal = next_sticky_signal(&mut state, CancellationCause::RunCancel)?;
                state.run_cancellations.insert(
                    run_key,
                    StickyRunCancellation {
                        intent_id: intent_id.to_owned(),
                        signal,
                    },
                );
                signal
            }
        };
        signal_matching(state.registrations.iter(), effective.cause, |identity| {
            identity.workspace_id == workspace_id && identity.run_id == run_id
        })
    }

    pub fn registered_count(&self) -> Result<usize, RuntimeCancellationHubError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?
            .registrations
            .len())
    }
}

impl Default for RuntimeCancellationHub {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct RecoveryTaskRegistration {
    identity: RecoveryTaskIdentity,
    gate: PreSendLinearizationGate,
    registration_id: Uuid,
}

impl RecoveryTaskRegistration {
    pub const fn identity(&self) -> &RecoveryTaskIdentity {
        &self.identity
    }

    pub fn snapshot(&self) -> Result<PreSendGateSnapshot, RuntimeCancellationHubError> {
        Ok(self.gate.snapshot()?)
    }

    pub fn reserve_sent(&self) -> Result<SentReservation, RuntimeCancellationHubError> {
        Ok(self.gate.reserve_sent()?)
    }

    pub fn http_cancellation_receiver(&self) -> watch::Receiver<bool> {
        self.gate.http_cancellation_receiver()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UnregisterReceipt {
    was_registered: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AbandonBeforeSentReceipt {
    was_registered: bool,
    cancellation_cause: Option<CancellationCause>,
    cancellation_intent_id: Option<String>,
}

impl AbandonBeforeSentReceipt {
    pub(crate) const fn was_registered(&self) -> bool {
        self.was_registered
    }

    pub(crate) const fn cancellation_cause(&self) -> Option<CancellationCause> {
        self.cancellation_cause
    }

    pub(crate) fn cancellation_intent_id(&self) -> Option<&str> {
        self.cancellation_intent_id.as_deref()
    }
}

impl UnregisterReceipt {
    pub const fn was_registered(self) -> bool {
        self.was_registered
    }
}

/// Process-local view of the sticky cancellation currently installed for one Run.
///
/// `signal_sequence` orders signals only within this Hub instance. Hydration after a
/// process restart assigns a new sequence, so durable identity and audit must use
/// `intent_id`, never `signal_sequence`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveRunCancellation {
    intent_id: String,
    signal_sequence: u64,
}

impl ActiveRunCancellation {
    pub fn intent_id(&self) -> &str {
        &self.intent_id
    }

    /// Returns the Hub-local signal ordering evidence.
    ///
    /// This value is not stable across Runtime restarts and must not be persisted as
    /// the cancellation identity. Use [`Self::intent_id`] for durable correlation.
    pub const fn signal_sequence(&self) -> u64 {
        self.signal_sequence
    }
}

#[must_use = "the settled capability must be consumed by clear_run_cancel"]
#[derive(Debug)]
pub struct RunCancellationSettledCapability {
    hub_instance_id: Uuid,
    run_key: RunKey,
    intent_id: String,
    signal_sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunCancellationClearReceipt {
    workspace_id: String,
    run_id: String,
    intent_id: String,
    signal_sequence: u64,
}

impl RunCancellationClearReceipt {
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn intent_id(&self) -> &str {
        &self.intent_id
    }

    /// Returns the sequence that identified this cancellation inside the clearing Hub.
    ///
    /// The sequence is process-local stale-capability evidence, not a durable identity.
    pub const fn signal_sequence(&self) -> u64 {
        self.signal_sequence
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CancellationSignalReceipt {
    matching_tasks: usize,
    cancelled_before_sent: usize,
    already_cancelled_before_sent: usize,
    post_sent_signalled: usize,
}

impl CancellationSignalReceipt {
    pub const fn matching_tasks(self) -> usize {
        self.matching_tasks
    }

    pub const fn cancelled_before_sent(self) -> usize {
        self.cancelled_before_sent
    }

    pub const fn already_cancelled_before_sent(self) -> usize {
        self.already_cancelled_before_sent
    }

    pub const fn post_sent_signalled(self) -> usize {
        self.post_sent_signalled
    }
}

fn signal_matching<'a>(
    entries: impl Iterator<Item = (&'a RecoveryTaskIdentity, &'a RegistrationEntry)>,
    cause: CancellationCause,
    matches: impl Fn(&RecoveryTaskIdentity) -> bool,
) -> Result<CancellationSignalReceipt, RuntimeCancellationHubError> {
    let mut receipt = CancellationSignalReceipt::default();
    for (_, entry) in entries.filter(|(identity, _)| matches(identity)) {
        receipt.matching_tasks += 1;
        match entry.gate.cancel(cause)? {
            CancellationLinearization::CancelledBeforeSent => receipt.cancelled_before_sent += 1,
            CancellationLinearization::AlreadyCancelledBeforeSent => {
                receipt.already_cancelled_before_sent += 1;
            }
            CancellationLinearization::SignalledAfterSentReservation
            | CancellationLinearization::SignalledAfterSentCommit => {
                receipt.post_sent_signalled += 1;
            }
        }
    }
    Ok(receipt)
}

fn earliest_cancellation(
    global: Option<StickyCancellation>,
    run: Option<StickyCancellation>,
) -> Option<StickyCancellation> {
    match (global, run) {
        (Some(global), Some(run)) => Some(if global.sequence <= run.sequence {
            global
        } else {
            run
        }),
        (Some(global), None) => Some(global),
        (None, Some(run)) => Some(run),
        (None, None) => None,
    }
}

fn next_sticky_signal(
    state: &mut HubState,
    cause: CancellationCause,
) -> Result<StickyCancellation, RuntimeCancellationHubError> {
    state.next_signal_sequence = state
        .next_signal_sequence
        .checked_add(1)
        .ok_or(RuntimeCancellationHubError::SignalSequenceExhausted)?;
    Ok(StickyCancellation {
        cause,
        sequence: state.next_signal_sequence,
    })
}

fn verify_owner<K: Eq + std::hash::Hash>(
    owners: &HashMap<K, RecoveryTaskIdentity>,
    key: &K,
    identity: &RecoveryTaskIdentity,
) -> Result<(), RuntimeCancellationHubError> {
    if owners.get(key) != Some(identity) {
        return Err(RuntimeCancellationHubError::StateInvariant);
    }
    Ok(())
}

fn reject_identity_conflict(
    existing: Option<&RecoveryTaskIdentity>,
    requested: &RecoveryTaskIdentity,
) -> Result<(), RuntimeCancellationHubError> {
    if existing.is_some_and(|identity| identity != requested) {
        return Err(RuntimeCancellationHubError::IdentityConflict);
    }
    Ok(())
}

fn require_identity_text(
    field: &'static str,
    value: &str,
) -> Result<(), RuntimeCancellationHubError> {
    if value.is_empty()
        || value.trim() != value
        || value.chars().any(char::is_control)
        || value.len() > 1_024
    {
        return Err(RuntimeCancellationHubError::IdentityInvalid { field });
    }
    Ok(())
}

fn require_matching_run_cancel_intent(
    existing_intent_id: &str,
    requested_intent_id: &str,
) -> Result<(), RuntimeCancellationHubError> {
    if existing_intent_id != requested_intent_id {
        return Err(RuntimeCancellationHubError::RunCancelIntentConflict {
            existing_intent_id: existing_intent_id.to_owned(),
            requested_intent_id: requested_intent_id.to_owned(),
        });
    }
    Ok(())
}

fn require_canonical_sha256(
    field: &'static str,
    value: &str,
) -> Result<(), RuntimeCancellationHubError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(RuntimeCancellationHubError::IdentityInvalid { field });
    }
    Ok(())
}

impl From<&RecoveryTaskIdentity> for AttemptOwnerKey {
    fn from(identity: &RecoveryTaskIdentity) -> Self {
        Self {
            workspace_id: identity.workspace_id.clone(),
            run_id: identity.run_id.clone(),
            attempt_id: identity.attempt_id.clone(),
        }
    }
}

impl From<&RecoveryTaskIdentity> for ExecutionOwnerKey {
    fn from(identity: &RecoveryTaskIdentity) -> Self {
        Self {
            workspace_id: identity.workspace_id.clone(),
            run_id: identity.run_id.clone(),
            operation_id: identity.operation_id.clone(),
            execution_id: identity.execution_id.clone(),
        }
    }
}

impl From<&RecoveryTaskIdentity> for RunKey {
    fn from(identity: &RecoveryTaskIdentity) -> Self {
        Self {
            workspace_id: identity.workspace_id.clone(),
            run_id: identity.run_id.clone(),
        }
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum RuntimeCancellationHubError {
    #[error("Runtime cancellation Hub state is poisoned")]
    StatePoisoned,
    #[error("Recovery task identity field `{field}` is invalid")]
    IdentityInvalid { field: &'static str },
    #[error("Recovery task identity conflicts with an existing Attempt or Execution owner")]
    IdentityConflict,
    #[error("Runtime cancellation Hub state invariant failed")]
    StateInvariant,
    #[error("Recovery task registration handle is stale")]
    StaleRegistration,
    #[error("Recovery task registration is already active")]
    RegistrationAlreadyActive,
    #[error("Runtime cancellation Hub signal sequence is exhausted")]
    SignalSequenceExhausted,
    #[error("Recovery task cannot unregister before a terminal pre-send gate state: {0:?}")]
    UnregisterBeforeTerminal(PreSendGateState),
    #[error("Recovery task cannot be abandoned after entering the Sent boundary: {0:?}")]
    AbandonAfterSentBoundary(PreSendGateState),
    #[error("global cancellation requires RuntimeShutdown or HostDisconnected")]
    GlobalCauseRequired,
    #[error(
        "run cancellation intent conflicts with unresolved intent `{existing_intent_id}`: requested `{requested_intent_id}`"
    )]
    RunCancelIntentConflict {
        existing_intent_id: String,
        requested_intent_id: String,
    },
    #[error("run cancellation is not active")]
    RunCancelNotActive,
    #[error("run cancellation settlement capability belongs to another Hub instance")]
    RunCancelCapabilityHubMismatch,
    #[error("run cancellation settlement capability is stale")]
    RunCancelCapabilityStale,
    #[error(
        "run cancellation cannot be cleared while {active_registrations} task registration(s) remain active"
    )]
    RunCancelRegistrationsActive { active_registrations: usize },
    #[error(transparent)]
    Gate(#[from] PreSendGateError),
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Barrier},
        thread,
    };

    use super::*;

    const INTENT_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const INTENT_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn abandon_receipt_atomically_retains_run_cancel_intent_after_sticky_clear() {
        let hub = RuntimeCancellationHub::new();
        hub.signal_run_cancel("workspace-a", "run-a", INTENT_A)
            .unwrap();
        let registration = hub
            .register(
                RecoveryTaskIdentity::new(
                    "workspace-a",
                    "run-a",
                    "operation-a",
                    "execution-a",
                    "attempt-a",
                )
                .unwrap(),
            )
            .unwrap();
        let receipt = hub.abandon_before_sent(&registration).unwrap();
        assert_eq!(
            receipt.cancellation_cause(),
            Some(CancellationCause::RunCancel)
        );
        assert_eq!(receipt.cancellation_intent_id(), Some(INTENT_A));

        let settled = hub
            .authorize_run_cancellation_settled("workspace-a", "run-a", INTENT_A)
            .unwrap();
        hub.clear_run_cancel(settled).unwrap();
        assert_eq!(receipt.cancellation_intent_id(), Some(INTENT_A));
    }

    #[test]
    fn abandon_fails_closed_if_run_cancel_gate_lost_its_sticky_identity() {
        let hub = RuntimeCancellationHub::new();
        hub.signal_run_cancel("workspace-a", "run-a", INTENT_A)
            .unwrap();
        let registration = hub
            .register(
                RecoveryTaskIdentity::new(
                    "workspace-a",
                    "run-a",
                    "operation-a",
                    "execution-a",
                    "attempt-a",
                )
                .unwrap(),
            )
            .unwrap();
        hub.inner
            .lock()
            .unwrap()
            .run_cancellations
            .remove(&RunKey::from(registration.identity()));

        assert_eq!(
            hub.abandon_before_sent(&registration),
            Err(RuntimeCancellationHubError::StateInvariant)
        );
        assert_eq!(hub.registered_count().unwrap(), 1);
    }

    #[test]
    fn unreadable_dispatch_boundary_is_terminal_and_token_owned_cleanup_is_bounded() {
        let hub = RuntimeCancellationHub::new();
        let identity = RecoveryTaskIdentity::new(
            "workspace-a",
            "run-a",
            "operation-a",
            "execution-a",
            "attempt-a",
        )
        .unwrap();
        let registration = hub.register(identity.clone()).unwrap();
        registration
            .reserve_sent()
            .unwrap()
            .fail_closed_after_unreadable_evidence()
            .unwrap();
        assert_eq!(
            registration.snapshot().unwrap().state(),
            PreSendGateState::DispatchBoundaryUnknown
        );
        assert!(hub.unregister(&registration).unwrap().was_registered());
        assert_eq!(hub.registered_count().unwrap(), 0);

        let replacement = hub.register(identity).unwrap();
        assert_eq!(
            hub.unregister(&registration),
            Err(RuntimeCancellationHubError::StaleRegistration)
        );
        assert_eq!(hub.registered_count().unwrap(), 1);
        hub.signal_global(CancellationCause::RuntimeShutdown)
            .unwrap();
        hub.unregister(&replacement).unwrap();
        assert_eq!(hub.registered_count().unwrap(), 0);
    }

    #[test]
    fn abandon_and_cancel_race_reports_the_winning_linearization() {
        for iteration in 0..256 {
            let hub = RuntimeCancellationHub::new();
            let registration = hub
                .register(
                    RecoveryTaskIdentity::new(
                        "workspace-a",
                        format!("run-{iteration}"),
                        format!("operation-{iteration}"),
                        format!("execution-{iteration}"),
                        format!("attempt-{iteration}"),
                    )
                    .unwrap(),
                )
                .unwrap();
            let barrier = Arc::new(Barrier::new(3));

            let abandon_hub = hub.clone();
            let abandon_registration = registration.clone();
            let abandon_barrier = Arc::clone(&barrier);
            let abandon = thread::spawn(move || {
                abandon_barrier.wait();
                abandon_hub.abandon_before_sent(&abandon_registration)
            });

            let cancel_hub = hub.clone();
            let cancel_barrier = Arc::clone(&barrier);
            let cancel = thread::spawn(move || {
                cancel_barrier.wait();
                cancel_hub.signal_global(CancellationCause::RuntimeShutdown)
            });

            barrier.wait();
            let abandoned = abandon.join().unwrap().unwrap();
            let signalled = cancel.join().unwrap().unwrap();
            assert!(abandoned.was_registered());
            match abandoned.cancellation_cause() {
                Some(CancellationCause::RuntimeShutdown) => {
                    assert_eq!(signalled.matching_tasks(), 1);
                    assert_eq!(signalled.cancelled_before_sent(), 1);
                }
                None => assert_eq!(signalled.matching_tasks(), 0),
                Some(other) => panic!("unexpected cancellation cause: {other:?}"),
            }
            assert_eq!(hub.registered_count().unwrap(), 0);
        }
    }

    #[test]
    fn settled_capability_cannot_clear_an_active_registration() {
        let hub = RuntimeCancellationHub::new();
        hub.signal_run_cancel("workspace-a", "run-a", INTENT_A)
            .unwrap();
        let identity = RecoveryTaskIdentity::new(
            "workspace-a",
            "run-a",
            "operation-a",
            "execution-a",
            "attempt-a",
        )
        .unwrap();
        let registration = hub.register(identity.clone()).unwrap();

        let capability = hub
            .authorize_run_cancellation_settled("workspace-a", "run-a", INTENT_A)
            .unwrap();
        assert_eq!(
            hub.clear_run_cancel(capability),
            Err(RuntimeCancellationHubError::RunCancelRegistrationsActive {
                active_registrations: 1,
            })
        );
        assert!(hub.unregister(&registration).unwrap().was_registered());

        let capability = hub
            .authorize_run_cancellation_settled("workspace-a", "run-a", INTENT_A)
            .unwrap();
        let receipt = hub.clear_run_cancel(capability).unwrap();
        assert_eq!(receipt.workspace_id(), "workspace-a");
        assert_eq!(receipt.run_id(), "run-a");
        assert_eq!(receipt.intent_id(), INTENT_A);
        assert!(receipt.signal_sequence() > 0);
        assert!(
            hub.active_run_cancellation("workspace-a", "run-a")
                .unwrap()
                .is_none()
        );

        let replacement = hub.register(identity).unwrap();
        assert_eq!(
            replacement.snapshot().unwrap().state(),
            PreSendGateState::Open
        );
    }

    #[test]
    fn clear_rejects_wrong_intent_and_capability_from_another_hub() {
        let hub = RuntimeCancellationHub::new();
        hub.signal_run_cancel("workspace-a", "run-a", INTENT_A)
            .unwrap();
        let signal_sequence = hub
            .active_run_cancellation("workspace-a", "run-a")
            .unwrap()
            .unwrap()
            .signal_sequence();
        let wrong_intent = RunCancellationSettledCapability {
            hub_instance_id: hub.hub_instance_id,
            run_key: RunKey {
                workspace_id: "workspace-a".to_owned(),
                run_id: "run-a".to_owned(),
            },
            intent_id: INTENT_B.to_owned(),
            signal_sequence,
        };
        assert_eq!(
            hub.clear_run_cancel(wrong_intent),
            Err(RuntimeCancellationHubError::RunCancelIntentConflict {
                existing_intent_id: INTENT_A.to_owned(),
                requested_intent_id: INTENT_B.to_owned(),
            })
        );

        let other_hub = RuntimeCancellationHub::new();
        other_hub
            .signal_run_cancel("workspace-a", "run-a", INTENT_A)
            .unwrap();
        let foreign_capability = hub
            .authorize_run_cancellation_settled("workspace-a", "run-a", INTENT_A)
            .unwrap();
        assert_eq!(
            other_hub.clear_run_cancel(foreign_capability),
            Err(RuntimeCancellationHubError::RunCancelCapabilityHubMismatch)
        );
        assert_eq!(
            other_hub
                .active_run_cancellation("workspace-a", "run-a")
                .unwrap()
                .unwrap()
                .intent_id(),
            INTENT_A
        );
    }

    #[test]
    fn capability_from_a_cleared_generation_cannot_clear_a_reactivated_same_intent() {
        let hub = RuntimeCancellationHub::new();
        hub.signal_run_cancel("workspace-a", "run-a", INTENT_A)
            .unwrap();
        let first_generation = hub
            .active_run_cancellation("workspace-a", "run-a")
            .unwrap()
            .unwrap();
        let clear_capability = hub
            .authorize_run_cancellation_settled("workspace-a", "run-a", INTENT_A)
            .unwrap();
        let stale_capability = hub
            .authorize_run_cancellation_settled("workspace-a", "run-a", INTENT_A)
            .unwrap();

        hub.clear_run_cancel(clear_capability).unwrap();
        hub.signal_run_cancel("workspace-a", "run-a", INTENT_A)
            .unwrap();
        let second_generation = hub
            .active_run_cancellation("workspace-a", "run-a")
            .unwrap()
            .unwrap();
        assert!(second_generation.signal_sequence() > first_generation.signal_sequence());
        assert_eq!(
            hub.clear_run_cancel(stale_capability),
            Err(RuntimeCancellationHubError::RunCancelCapabilityStale)
        );

        let current_capability = hub
            .authorize_run_cancellation_settled("workspace-a", "run-a", INTENT_A)
            .unwrap();
        hub.clear_run_cancel(current_capability).unwrap();
    }

    #[test]
    fn clear_vs_register_is_linearizable_without_escaping_sticky_cancellation() {
        for iteration in 0..256 {
            let hub = RuntimeCancellationHub::new();
            hub.signal_run_cancel("workspace-a", "run-a", INTENT_A)
                .unwrap();
            let capability = hub
                .authorize_run_cancellation_settled("workspace-a", "run-a", INTENT_A)
                .unwrap();
            let identity = RecoveryTaskIdentity::new(
                "workspace-a",
                "run-a",
                format!("operation-{iteration}"),
                format!("execution-{iteration}"),
                format!("attempt-{iteration}"),
            )
            .unwrap();
            let barrier = Arc::new(Barrier::new(3));

            let clear_hub = hub.clone();
            let clear_barrier = Arc::clone(&barrier);
            let clear = thread::spawn(move || {
                clear_barrier.wait();
                clear_hub.clear_run_cancel(capability)
            });
            let register_hub = hub.clone();
            let register_barrier = Arc::clone(&barrier);
            let register = thread::spawn(move || {
                register_barrier.wait();
                register_hub.register(identity)
            });

            barrier.wait();
            let cleared = clear.join().unwrap();
            let registration = register.join().unwrap().unwrap();
            match cleared {
                Ok(_) => {
                    assert_eq!(
                        registration.snapshot().unwrap().state(),
                        PreSendGateState::Open
                    );
                    hub.signal_global(CancellationCause::RuntimeShutdown)
                        .unwrap();
                    assert!(hub.unregister(&registration).unwrap().was_registered());
                }
                Err(RuntimeCancellationHubError::RunCancelRegistrationsActive {
                    active_registrations: 1,
                }) => {
                    assert_eq!(
                        registration.snapshot().unwrap().state(),
                        PreSendGateState::CancelledBeforeSent
                    );
                    assert_eq!(
                        registration.snapshot().unwrap().cancellation_cause(),
                        Some(CancellationCause::RunCancel)
                    );
                    assert!(hub.unregister(&registration).unwrap().was_registered());
                    let replacement_capability = hub
                        .authorize_run_cancellation_settled("workspace-a", "run-a", INTENT_A)
                        .unwrap();
                    hub.clear_run_cancel(replacement_capability).unwrap();
                }
                other => panic!("unexpected clear/register race result: {other:?}"),
            }
        }
    }
}
