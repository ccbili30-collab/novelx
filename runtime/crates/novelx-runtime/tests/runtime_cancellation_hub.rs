use std::{
    sync::{Arc, Barrier},
    thread,
};

use novelx_runtime::{
    provider_pre_send_gate::{PreSendGateError, PreSendGateState},
    runtime_cancellation_hub::{
        CancellationCause, RecoveryTaskIdentity, RuntimeCancellationHub,
        RuntimeCancellationHubError,
    },
};

#[test]
fn cancellation_before_reservation_proves_zero_sent_and_reservation_cannot_be_consumed() {
    let hub = RuntimeCancellationHub::new();
    let registration = hub.register(identity("run-a", "attempt-a")).unwrap();

    let receipt = hub
        .signal_global(CancellationCause::RuntimeShutdown)
        .unwrap();

    assert_eq!(receipt.matching_tasks(), 1);
    assert_eq!(receipt.cancelled_before_sent(), 1);
    assert_eq!(
        registration.snapshot().unwrap().state(),
        PreSendGateState::CancelledBeforeSent
    );
    assert_eq!(
        registration.snapshot().unwrap().cancellation_cause(),
        Some(CancellationCause::RuntimeShutdown)
    );
    assert!(matches!(
        registration.reserve_sent(),
        Err(RuntimeCancellationHubError::Gate(
            PreSendGateError::CancelledBeforeSent(CancellationCause::RuntimeShutdown)
        ))
    ));
}

#[tokio::test]
async fn sent_reservation_wins_but_later_cancellation_reaches_http_and_cannot_rewind_state() {
    let hub = RuntimeCancellationHub::new();
    let registration = hub.register(identity("run-a", "attempt-a")).unwrap();
    let mut http_cancellation = registration.http_cancellation_receiver();
    let reservation = registration.reserve_sent().unwrap();

    let receipt = hub
        .signal_global(CancellationCause::HostDisconnected)
        .unwrap();
    http_cancellation.changed().await.unwrap();

    assert_eq!(receipt.post_sent_signalled(), 1);
    assert!(*http_cancellation.borrow());
    assert_eq!(
        registration.snapshot().unwrap().state(),
        PreSendGateState::SentReserved
    );
    assert_eq!(
        reservation.commit().unwrap().cancellation_cause(),
        Some(CancellationCause::HostDisconnected)
    );
    assert_eq!(
        registration.snapshot().unwrap().state(),
        PreSendGateState::SentCommitted
    );
    assert_eq!(
        hub.signal_global(CancellationCause::RuntimeShutdown)
            .unwrap()
            .post_sent_signalled(),
        1
    );
    assert_eq!(
        registration.snapshot().unwrap().state(),
        PreSendGateState::SentCommitted
    );
}

#[test]
fn shutdown_and_host_disconnect_are_sticky_for_late_registrations() {
    for cause in [
        CancellationCause::RuntimeShutdown,
        CancellationCause::HostDisconnected,
    ] {
        let hub = RuntimeCancellationHub::new();
        assert_eq!(hub.signal_global(cause).unwrap().matching_tasks(), 0);

        let registration = hub.register(identity("late-run", "late-attempt")).unwrap();
        assert_eq!(
            registration.snapshot().unwrap().state(),
            PreSendGateState::CancelledBeforeSent
        );
        assert_eq!(
            registration.snapshot().unwrap().cancellation_cause(),
            Some(cause)
        );
        assert!(*registration.http_cancellation_receiver().borrow());
    }
}

#[test]
fn run_cancel_is_sticky_only_for_the_exact_workspace_and_run() {
    let hub = RuntimeCancellationHub::new();
    let target = hub
        .register(identity_in("workspace-a", "run-a", "attempt-a"))
        .unwrap();
    let other_run = hub
        .register(identity_in("workspace-a", "run-b", "attempt-b"))
        .unwrap();
    let same_run_other_workspace = hub
        .register(identity_in("workspace-b", "run-a", "attempt-c"))
        .unwrap();

    let receipt = hub.signal_run_cancel("workspace-a", "run-a").unwrap();

    assert_eq!(receipt.matching_tasks(), 1);
    assert_eq!(
        target.snapshot().unwrap().state(),
        PreSendGateState::CancelledBeforeSent
    );
    assert_eq!(
        other_run.snapshot().unwrap().state(),
        PreSendGateState::Open
    );
    assert_eq!(
        same_run_other_workspace.snapshot().unwrap().state(),
        PreSendGateState::Open
    );
    let late_target = hub
        .register(
            RecoveryTaskIdentity::new(
                "workspace-a",
                "run-a",
                "operation-late",
                "execution-late",
                "attempt-late",
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        late_target.snapshot().unwrap().state(),
        PreSendGateState::CancelledBeforeSent
    );
    assert_eq!(
        late_target.snapshot().unwrap().cancellation_cause(),
        Some(CancellationCause::RunCancel)
    );
}

#[test]
fn registration_and_unregistration_are_idempotent_but_identity_aliases_fail_closed() {
    let hub = RuntimeCancellationHub::new();
    let exact = identity("run-a", "attempt-a");
    let first = hub.register(exact.clone()).unwrap();
    let replay = hub.register(exact.clone()).unwrap();
    let reservation = first.reserve_sent().unwrap();
    assert_eq!(
        replay.snapshot().unwrap().state(),
        PreSendGateState::SentReserved
    );
    assert_eq!(hub.registered_count().unwrap(), 1);

    let conflicting_attempt_owner = RecoveryTaskIdentity::new(
        "workspace-a",
        "run-a",
        "other-operation",
        "other-execution",
        "attempt-a",
    )
    .unwrap();
    assert!(matches!(
        hub.register(conflicting_attempt_owner),
        Err(RuntimeCancellationHubError::IdentityConflict)
    ));
    let conflicting_execution_owner = RecoveryTaskIdentity::new(
        "workspace-a",
        "run-a",
        exact.operation_id(),
        exact.execution_id(),
        "other-attempt",
    )
    .unwrap();
    assert!(matches!(
        hub.register(conflicting_execution_owner),
        Err(RuntimeCancellationHubError::IdentityConflict)
    ));

    assert!(matches!(
        hub.unregister(&exact),
        Err(RuntimeCancellationHubError::UnregisterBeforeTerminal(
            PreSendGateState::SentReserved
        ))
    ));
    reservation.commit().unwrap();
    assert!(hub.unregister(&exact).unwrap().was_registered());
    assert!(!hub.unregister(&exact).unwrap().was_registered());
    assert_eq!(hub.registered_count().unwrap(), 0);
    assert_eq!(
        hub.register(exact).unwrap().snapshot().unwrap().state(),
        PreSendGateState::SentCommitted
    );
}

#[test]
fn cancel_vs_reserve_is_linearizable_under_real_thread_races() {
    for iteration in 0..256 {
        let hub = RuntimeCancellationHub::new();
        let registration = hub
            .register(identity(
                &format!("run-{iteration}"),
                &format!("attempt-{iteration}"),
            ))
            .unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let reserve_barrier = Arc::clone(&barrier);
        let reserve_registration = registration.clone();
        let reserve = thread::spawn(move || {
            reserve_barrier.wait();
            reserve_registration.reserve_sent()
        });
        let cancel_barrier = Arc::clone(&barrier);
        let cancel_hub = hub.clone();
        let cancel = thread::spawn(move || {
            cancel_barrier.wait();
            cancel_hub.signal_global(CancellationCause::RuntimeShutdown)
        });
        barrier.wait();
        let reservation = reserve.join().unwrap();
        cancel.join().unwrap().unwrap();

        match reservation {
            Ok(reservation) => {
                assert_eq!(
                    registration.snapshot().unwrap().state(),
                    PreSendGateState::SentReserved
                );
                assert!(*registration.http_cancellation_receiver().borrow());
                reservation.commit().unwrap();
                assert_eq!(
                    registration.snapshot().unwrap().state(),
                    PreSendGateState::SentCommitted
                );
            }
            Err(RuntimeCancellationHubError::Gate(PreSendGateError::CancelledBeforeSent(
                CancellationCause::RuntimeShutdown,
            ))) => {
                assert_eq!(
                    registration.snapshot().unwrap().state(),
                    PreSendGateState::CancelledBeforeSent
                );
            }
            Err(error) => panic!("unexpected reserve result: {error}"),
        }
    }
}

#[test]
fn invalid_identity_and_invalid_global_cause_are_rejected() {
    assert!(matches!(
        RecoveryTaskIdentity::new(" workspace", "run", "operation", "execution", "attempt"),
        Err(RuntimeCancellationHubError::IdentityInvalid {
            field: "workspace_id"
        })
    ));
    assert!(matches!(
        RuntimeCancellationHub::new().signal_global(CancellationCause::RunCancel),
        Err(RuntimeCancellationHubError::GlobalCauseRequired)
    ));
}

fn identity(run_id: &str, attempt_id: &str) -> RecoveryTaskIdentity {
    identity_in("workspace-a", run_id, attempt_id)
}

fn identity_in(workspace_id: &str, run_id: &str, attempt_id: &str) -> RecoveryTaskIdentity {
    RecoveryTaskIdentity::new(
        workspace_id,
        run_id,
        format!("operation-{attempt_id}"),
        format!("execution-{attempt_id}"),
        attempt_id,
    )
    .unwrap()
}
