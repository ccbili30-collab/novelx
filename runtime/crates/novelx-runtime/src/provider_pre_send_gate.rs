use std::sync::{Arc, Mutex};

use thiserror::Error;
use tokio::sync::watch;
use uuid::Uuid;

use crate::runtime_cancellation_hub::CancellationCause;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PreSendGateState {
    Open,
    CancelledBeforeSent,
    SentReserved,
    SentCommitted,
    DispatchBoundaryUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PreSendGateSnapshot {
    state: PreSendGateState,
    cancellation_cause: Option<CancellationCause>,
}

impl PreSendGateSnapshot {
    pub const fn state(self) -> PreSendGateState {
        self.state
    }

    pub const fn cancellation_cause(self) -> Option<CancellationCause> {
        self.cancellation_cause
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancellationLinearization {
    CancelledBeforeSent,
    AlreadyCancelledBeforeSent,
    SignalledAfterSentReservation,
    SignalledAfterSentCommit,
}

#[derive(Clone)]
pub struct PreSendLinearizationGate {
    inner: Arc<GateInner>,
}

struct GateInner {
    state: Mutex<GateState>,
    http_cancellation: watch::Sender<bool>,
}

struct GateState {
    phase: PreSendGateState,
    cancellation_cause: Option<CancellationCause>,
    reservation_id: Option<Uuid>,
}

impl PreSendLinearizationGate {
    pub(crate) fn open() -> Self {
        Self::new(None)
    }

    pub(crate) fn cancelled(cause: CancellationCause) -> Self {
        Self::new(Some(cause))
    }

    fn new(initial_cancellation: Option<CancellationCause>) -> Self {
        let cancelled = initial_cancellation.is_some();
        let (http_cancellation, _) = watch::channel(cancelled);
        Self {
            inner: Arc::new(GateInner {
                state: Mutex::new(GateState {
                    phase: if cancelled {
                        PreSendGateState::CancelledBeforeSent
                    } else {
                        PreSendGateState::Open
                    },
                    cancellation_cause: initial_cancellation,
                    reservation_id: None,
                }),
                http_cancellation,
            }),
        }
    }

    pub fn snapshot(&self) -> Result<PreSendGateSnapshot, PreSendGateError> {
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| PreSendGateError::StatePoisoned)?;
        Ok(PreSendGateSnapshot {
            state: state.phase,
            cancellation_cause: state.cancellation_cause,
        })
    }

    pub fn http_cancellation_receiver(&self) -> watch::Receiver<bool> {
        self.inner.http_cancellation.subscribe()
    }

    pub fn reserve_sent(&self) -> Result<SentReservation, PreSendGateError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| PreSendGateError::StatePoisoned)?;
        match state.phase {
            PreSendGateState::Open => {
                let reservation_id = Uuid::new_v4();
                state.phase = PreSendGateState::SentReserved;
                state.reservation_id = Some(reservation_id);
                Ok(SentReservation {
                    gate: self.clone(),
                    reservation_id,
                    active: true,
                })
            }
            PreSendGateState::CancelledBeforeSent => Err(PreSendGateError::CancelledBeforeSent(
                state
                    .cancellation_cause
                    .ok_or(PreSendGateError::StateInvariant)?,
            )),
            PreSendGateState::SentReserved => Err(PreSendGateError::SentAlreadyReserved),
            PreSendGateState::SentCommitted => Err(PreSendGateError::SentAlreadyCommitted),
            PreSendGateState::DispatchBoundaryUnknown => {
                Err(PreSendGateError::DispatchBoundaryUnknown)
            }
        }
    }

    pub(crate) fn cancel(
        &self,
        cause: CancellationCause,
    ) -> Result<CancellationLinearization, PreSendGateError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| PreSendGateError::StatePoisoned)?;
        let result = match state.phase {
            PreSendGateState::Open => {
                state.phase = PreSendGateState::CancelledBeforeSent;
                state.cancellation_cause = Some(cause);
                CancellationLinearization::CancelledBeforeSent
            }
            PreSendGateState::CancelledBeforeSent => {
                CancellationLinearization::AlreadyCancelledBeforeSent
            }
            PreSendGateState::SentReserved => {
                state.cancellation_cause.get_or_insert(cause);
                CancellationLinearization::SignalledAfterSentReservation
            }
            PreSendGateState::SentCommitted => {
                state.cancellation_cause.get_or_insert(cause);
                CancellationLinearization::SignalledAfterSentCommit
            }
            PreSendGateState::DispatchBoundaryUnknown => {
                state.cancellation_cause.get_or_insert(cause);
                CancellationLinearization::SignalledAfterSentCommit
            }
        };
        self.inner.http_cancellation.send_replace(true);
        Ok(result)
    }

    fn commit(&self, reservation_id: Uuid) -> Result<SentCommitReceipt, PreSendGateError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| PreSendGateError::StatePoisoned)?;
        if state.phase != PreSendGateState::SentReserved
            || state.reservation_id != Some(reservation_id)
        {
            return Err(PreSendGateError::ReservationInvalid);
        }
        state.phase = PreSendGateState::SentCommitted;
        state.reservation_id = None;
        Ok(SentCommitReceipt {
            cancellation_cause: state.cancellation_cause,
            _private: (),
        })
    }

    #[allow(dead_code)] // Migration step 2 will call this after Provider arming fails.
    fn release_after_arm_failure(
        &self,
        reservation_id: Uuid,
    ) -> Result<ArmFailureReleaseReceipt, PreSendGateError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| PreSendGateError::StatePoisoned)?;
        if state.phase != PreSendGateState::SentReserved
            || state.reservation_id != Some(reservation_id)
        {
            return Err(PreSendGateError::ReservationInvalid);
        }
        state.reservation_id = None;
        state.phase = if state.cancellation_cause.is_some() {
            PreSendGateState::CancelledBeforeSent
        } else {
            PreSendGateState::Open
        };
        Ok(ArmFailureReleaseReceipt {
            state: state.phase,
            _private: (),
        })
    }

    fn fail_closed_after_unreadable_evidence(
        &self,
        reservation_id: Uuid,
    ) -> Result<(), PreSendGateError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| PreSendGateError::StatePoisoned)?;
        if state.phase != PreSendGateState::SentReserved
            || state.reservation_id != Some(reservation_id)
        {
            return Err(PreSendGateError::ReservationInvalid);
        }
        state.phase = PreSendGateState::DispatchBoundaryUnknown;
        state.reservation_id = None;
        self.inner.http_cancellation.send_replace(true);
        Ok(())
    }
}

#[must_use = "a Sent reservation must be committed or explicitly released"]
pub struct SentReservation {
    gate: PreSendLinearizationGate,
    reservation_id: Uuid,
    active: bool,
}

impl SentReservation {
    pub(crate) fn commit(mut self) -> Result<SentCommitReceipt, PreSendGateError> {
        match self.gate.commit(self.reservation_id) {
            Ok(receipt) => {
                self.active = false;
                Ok(receipt)
            }
            Err(error) => {
                let _ = self
                    .gate
                    .fail_closed_after_unreadable_evidence(self.reservation_id);
                self.active = false;
                Err(error)
            }
        }
    }

    #[allow(dead_code)] // Migration step 2 will call this after Provider arming fails.
    pub(crate) fn release_after_arm_failure(
        mut self,
    ) -> Result<ArmFailureReleaseReceipt, PreSendGateError> {
        let receipt = self.gate.release_after_arm_failure(self.reservation_id)?;
        self.active = false;
        Ok(receipt)
    }

    pub(crate) fn fail_closed_after_unreadable_evidence(mut self) -> Result<(), PreSendGateError> {
        self.gate
            .fail_closed_after_unreadable_evidence(self.reservation_id)?;
        self.active = false;
        Ok(())
    }
}

impl Drop for SentReservation {
    fn drop(&mut self) {
        if self.active {
            let _ = self.gate.release_after_arm_failure(self.reservation_id);
            self.active = false;
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SentCommitReceipt {
    cancellation_cause: Option<CancellationCause>,
    _private: (),
}

impl SentCommitReceipt {
    pub const fn cancellation_cause(self) -> Option<CancellationCause> {
        self.cancellation_cause
    }
}

#[allow(dead_code)] // Migration step 2 will consume this receipt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ArmFailureReleaseReceipt {
    state: PreSendGateState,
    _private: (),
}

impl ArmFailureReleaseReceipt {
    #[allow(dead_code)] // Migration step 2 will consume this receipt.
    pub(crate) const fn state(self) -> PreSendGateState {
        self.state
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum PreSendGateError {
    #[error("pre-send gate state is poisoned")]
    StatePoisoned,
    #[error("pre-send gate state invariant failed")]
    StateInvariant,
    #[error("Provider dispatch was cancelled before Sent reservation: {0:?}")]
    CancelledBeforeSent(CancellationCause),
    #[error("Provider Sent is already reserved")]
    SentAlreadyReserved,
    #[error("Provider Sent is already committed")]
    SentAlreadyCommitted,
    #[error("Provider dispatch boundary is unknown and cannot be reopened")]
    DispatchBoundaryUnknown,
    #[error("Provider Sent reservation is invalid")]
    ReservationInvalid,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arm_failure_release_reopens_only_without_a_pending_cancellation() {
        let gate = PreSendLinearizationGate::open();
        let released = gate
            .reserve_sent()
            .unwrap()
            .release_after_arm_failure()
            .unwrap();
        assert_eq!(released.state(), PreSendGateState::Open);
        assert_eq!(gate.snapshot().unwrap().state(), PreSendGateState::Open);
        assert!(gate.reserve_sent().is_ok());
    }

    #[test]
    fn arm_failure_release_turns_a_post_reservation_signal_into_pre_sent_cancellation() {
        let gate = PreSendLinearizationGate::open();
        let reservation = gate.reserve_sent().unwrap();
        assert_eq!(
            gate.cancel(CancellationCause::RuntimeShutdown).unwrap(),
            CancellationLinearization::SignalledAfterSentReservation
        );
        let released = reservation.release_after_arm_failure().unwrap();
        assert_eq!(released.state(), PreSendGateState::CancelledBeforeSent);
        assert!(matches!(
            gate.reserve_sent(),
            Err(PreSendGateError::CancelledBeforeSent(
                CancellationCause::RuntimeShutdown
            ))
        ));
    }

    #[test]
    fn dropping_an_unconsumed_reservation_never_leaves_the_gate_stuck() {
        let gate = PreSendLinearizationGate::open();
        drop(gate.reserve_sent().unwrap());

        assert_eq!(gate.snapshot().unwrap().state(), PreSendGateState::Open);
        assert!(gate.reserve_sent().is_ok());
    }
}
