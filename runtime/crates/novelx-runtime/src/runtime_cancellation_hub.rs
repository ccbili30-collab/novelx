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
    inner: Arc<Mutex<HubState>>,
}

#[derive(Default)]
struct HubState {
    registrations: HashMap<RecoveryTaskIdentity, RegistrationEntry>,
    attempt_owners: HashMap<AttemptOwnerKey, RecoveryTaskIdentity>,
    execution_owners: HashMap<ExecutionOwnerKey, RecoveryTaskIdentity>,
    global_cancellation: Option<StickyCancellation>,
    run_cancellations: HashMap<RunKey, StickyCancellation>,
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
            state.run_cancellations.get(&run_key).copied(),
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
        state.registrations.remove(identity);
        state.attempt_owners.remove(&attempt_key);
        state.execution_owners.remove(&execution_key);
        Ok(AbandonBeforeSentReceipt {
            was_registered: true,
            cancellation_cause: snapshot.cancellation_cause(),
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
        signal_matching(state.registrations.iter(), effective.cause, |_| true)
    }

    pub fn signal_run_cancel(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<CancellationSignalReceipt, RuntimeCancellationHubError> {
        require_identity_text("workspace_id", workspace_id)?;
        require_identity_text("run_id", run_id)?;
        let mut state = self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?;
        let run_key = RunKey {
            workspace_id: workspace_id.to_owned(),
            run_id: run_id.to_owned(),
        };
        let effective = match state.run_cancellations.get(&run_key).copied() {
            Some(signal) => signal,
            None => {
                let signal = next_sticky_signal(&mut state, CancellationCause::RunCancel)?;
                state.run_cancellations.insert(run_key, signal);
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AbandonBeforeSentReceipt {
    was_registered: bool,
    cancellation_cause: Option<CancellationCause>,
}

impl AbandonBeforeSentReceipt {
    pub(crate) const fn was_registered(self) -> bool {
        self.was_registered
    }

    pub(crate) const fn cancellation_cause(self) -> Option<CancellationCause> {
        self.cancellation_cause
    }
}

impl UnregisterReceipt {
    pub const fn was_registered(self) -> bool {
        self.was_registered
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
}
