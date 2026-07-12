use novelx_runtime::operational_recovery_aggregate::{
    OPERATIONAL_RECOVERY_POLICY_VERSION, OperationalRecoveryAggregateError,
    OperationalRecoveryDisposition, OperationalRecoveryEventMetadata,
    OperationalRecoveryObservation, OperationalRecoveryObservedGate, OperationalRecoveryRepository,
    OperationalRecoverySubject, OperationalRecoveryWaitingReason,
};
use rusqlite::Connection;
use tempfile::TempDir;

#[test]
fn identical_observation_and_wait_are_idempotent_across_reopen() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "a",
        OperationalRecoveryObservedGate::AwaitingProviderBinding,
        vec!["exact_provider_binding_missing"],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    let observed = repository
        .observe(subject.clone(), observation.clone(), metadata())
        .unwrap();
    assert_eq!(observed.revision, 1);
    let waited = repository
        .wait(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            OperationalRecoveryWaitingReason::ProviderBinding,
            observation.source_fingerprint.clone(),
            metadata(),
        )
        .unwrap();
    assert_eq!(waited.revision, 2);
    drop(repository);

    let mut reopened = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    assert_eq!(
        reopened
            .observe(subject.clone(), observation.clone(), metadata())
            .unwrap()
            .revision,
        2
    );
    assert_eq!(
        reopened
            .wait(
                &subject.workspace_id,
                &subject.run_id,
                &observation.operation_id,
                OperationalRecoveryWaitingReason::ProviderBinding,
                observation.source_fingerprint.clone(),
                metadata(),
            )
            .unwrap()
            .revision,
        2
    );
    let loaded = reopened
        .load(&subject.workspace_id, &subject.run_id)
        .unwrap();
    assert!(matches!(
        loaded.operations[&observation.operation_id].disposition,
        Some(OperationalRecoveryDisposition::Waiting {
            reason: OperationalRecoveryWaitingReason::ProviderBinding,
            ..
        })
    ));
}

#[test]
fn changed_evidence_creates_a_new_deterministic_operation() {
    let fixture = Fixture::new();
    let subject = subject();
    let first = observation(
        &subject,
        "a",
        OperationalRecoveryObservedGate::AwaitingProviderBinding,
        vec![],
    );
    let second = observation(
        &subject,
        "b",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    assert_ne!(first.operation_id, second.operation_id);
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), first.clone(), metadata())
        .unwrap();
    let aggregate = repository
        .observe(subject.clone(), second.clone(), metadata())
        .unwrap();
    assert_eq!(aggregate.revision, 2);
    assert_eq!(aggregate.operations.len(), 2);
    assert_eq!(
        OperationalRecoveryObservation::derive(
            &subject,
            second.source_fingerprint.clone(),
            second.gate,
            vec![],
        )
        .unwrap()
        .operation_id,
        second.operation_id
    );
}

#[test]
fn quarantine_is_terminal_for_one_operation_and_requires_codes() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "c",
        OperationalRecoveryObservedGate::Quarantined,
        vec!["multiple_active_agent_loops"],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), observation.clone(), metadata())
        .unwrap();
    assert!(matches!(
        repository.quarantine(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            vec![],
            observation.source_fingerprint.clone(),
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::InvariantCodesRequired)
    ));
    let quarantined = repository
        .quarantine(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            vec!["multiple_active_agent_loops".to_owned()],
            observation.source_fingerprint.clone(),
            metadata(),
        )
        .unwrap();
    assert_eq!(quarantined.revision, 2);
    assert!(matches!(
        repository.wait(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            OperationalRecoveryWaitingReason::Reconciliation,
            observation.source_fingerprint,
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::DispositionConflict)
    ));
}

#[test]
fn forged_operation_and_subject_conflicts_fail_closed() {
    let fixture = Fixture::new();
    let subject = subject();
    let mut forged = observation(
        &subject,
        "d",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    forged.operation_id = "0".repeat(64);
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    assert!(matches!(
        repository.observe(subject.clone(), forged, metadata()),
        Err(OperationalRecoveryAggregateError::OperationConflict)
    ));
    let valid = observation(
        &subject,
        "d",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    repository
        .observe(subject.clone(), valid, metadata())
        .unwrap();
    let mut changed = subject;
    changed.project_id = "other-project".to_owned();
    let changed_observation = observation(
        &changed,
        "e",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    assert!(matches!(
        repository.observe(changed, changed_observation, metadata()),
        Err(OperationalRecoveryAggregateError::SubjectConflict)
    ));
}

#[test]
fn tampered_payload_breaks_the_hash_chain() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "f",
        OperationalRecoveryObservedGate::WaitingForApproval,
        vec![],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), observation, metadata())
        .unwrap();
    let connection = Connection::open(&fixture.path).unwrap();
    connection
        .execute_batch("DROP TRIGGER workspace_events_no_update;")
        .unwrap();
    connection
        .execute(
            "UPDATE workspace_events SET payload_json = json_set(payload_json, '$.aggregate_revision', 9) WHERE stream_type = 'operational_recovery'",
            [],
        )
        .unwrap();
    assert!(matches!(
        repository.load(&subject.workspace_id, &subject.run_id),
        Err(OperationalRecoveryAggregateError::HashChainInvalid)
    ));
}

fn subject() -> OperationalRecoverySubject {
    OperationalRecoverySubject {
        workspace_id: "workspace-1".to_owned(),
        project_id: "project-1".to_owned(),
        run_id: "run-1".to_owned(),
        policy_version: OPERATIONAL_RECOVERY_POLICY_VERSION.to_owned(),
    }
}

fn observation(
    subject: &OperationalRecoverySubject,
    digit: &str,
    gate: OperationalRecoveryObservedGate,
    reasons: Vec<&str>,
) -> OperationalRecoveryObservation {
    OperationalRecoveryObservation::derive(
        subject,
        digit.repeat(64),
        gate,
        reasons.into_iter().map(str::to_owned).collect(),
    )
    .unwrap()
}

fn metadata() -> OperationalRecoveryEventMetadata {
    OperationalRecoveryEventMetadata {
        created_at: "2026-07-13T00:00:00Z".to_owned(),
    }
}

struct Fixture {
    _temp: TempDir,
    path: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        novelx_runtime::event_journal::EventJournal::open(&path).unwrap();
        Self { _temp: temp, path }
    }
}
