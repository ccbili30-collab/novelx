use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use thiserror::Error;
use tokio::sync::watch;

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
    global_cancellation: Option<CancellationCause>,
    run_cancellations: HashMap<RunKey, CancellationCause>,
}

#[derive(Clone)]
struct RegistrationEntry {
    gate: PreSendLinearizationGate,
    registered: bool,
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
        if let Some(existing) = state.registrations.get_mut(&identity) {
            existing.registered = true;
            return Ok(RecoveryTaskRegistration {
                identity,
                gate: existing.gate.clone(),
            });
        }
        let attempt_key = AttemptOwnerKey::from(&identity);
        let execution_key = ExecutionOwnerKey::from(&identity);
        reject_identity_conflict(state.attempt_owners.get(&attempt_key), &identity)?;
        reject_identity_conflict(state.execution_owners.get(&execution_key), &identity)?;

        let run_key = RunKey::from(&identity);
        let initial_cancellation = state
            .global_cancellation
            .or_else(|| state.run_cancellations.get(&run_key).copied());
        let gate = initial_cancellation.map_or_else(
            PreSendLinearizationGate::open,
            PreSendLinearizationGate::cancelled,
        );
        state.attempt_owners.insert(attempt_key, identity.clone());
        state
            .execution_owners
            .insert(execution_key, identity.clone());
        state.registrations.insert(
            identity.clone(),
            RegistrationEntry {
                gate: gate.clone(),
                registered: true,
            },
        );
        Ok(RecoveryTaskRegistration { identity, gate })
    }

    pub fn unregister(
        &self,
        identity: &RecoveryTaskIdentity,
    ) -> Result<UnregisterReceipt, RuntimeCancellationHubError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?;
        let attempt_key = AttemptOwnerKey::from(identity);
        let execution_key = ExecutionOwnerKey::from(identity);
        if !state.registrations.contains_key(identity) {
            reject_identity_conflict(state.attempt_owners.get(&attempt_key), identity)?;
            reject_identity_conflict(state.execution_owners.get(&execution_key), identity)?;
            return Ok(UnregisterReceipt {
                was_registered: false,
            });
        }
        let entry = state
            .registrations
            .get_mut(identity)
            .ok_or(RuntimeCancellationHubError::StateInvariant)?;
        if !entry.registered {
            return Ok(UnregisterReceipt {
                was_registered: false,
            });
        }
        let phase = entry.gate.snapshot()?.state();
        if !matches!(
            phase,
            PreSendGateState::CancelledBeforeSent | PreSendGateState::SentCommitted
        ) {
            return Err(RuntimeCancellationHubError::UnregisterBeforeTerminal(phase));
        }
        entry.registered = false;
        Ok(UnregisterReceipt {
            was_registered: true,
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
        let effective_cause = *state.global_cancellation.get_or_insert(cause);
        signal_matching(state.registrations.iter(), effective_cause, |_| true)
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
        state
            .run_cancellations
            .entry(run_key)
            .or_insert(CancellationCause::RunCancel);
        signal_matching(
            state.registrations.iter(),
            CancellationCause::RunCancel,
            |identity| identity.workspace_id == workspace_id && identity.run_id == run_id,
        )
    }

    pub fn registered_count(&self) -> Result<usize, RuntimeCancellationHubError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| RuntimeCancellationHubError::StatePoisoned)?
            .registrations
            .values()
            .filter(|entry| entry.registered)
            .count())
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
    for (_, entry) in entries.filter(|(identity, entry)| entry.registered && matches(identity)) {
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
    #[error("Recovery task cannot unregister before a terminal pre-send gate state: {0:?}")]
    UnregisterBeforeTerminal(PreSendGateState),
    #[error("global cancellation requires RuntimeShutdown or HostDisconnected")]
    GlobalCauseRequired,
    #[error(transparent)]
    Gate(#[from] PreSendGateError),
}
