use novelx_runtime::{
    operational_recovery_aggregate::{
        OperationalRecoveryDisposition, OperationalRecoveryRepository,
        OperationalRecoveryWaitingReason,
    },
    operational_recovery_recording_service::OperationalRecoveryRecordingService,
    operational_recovery_scanner::{
        OperationalRecoveryGate, OperationalRecoveryReport, OperationalRecoveryRun,
    },
    run_state::RunState,
};
use tempfile::TempDir;

#[test]
fn repeated_recording_of_identical_evidence_writes_no_new_events() {
    let fixture = Fixture::new();
    let service = OperationalRecoveryRecordingService::new(&fixture.path);
    let report = report("a", OperationalRecoveryGate::AwaitingProviderBinding);
    let first = service
        .record("workspace-1", "project-1", &report, "2026-07-13T00:00:00Z")
        .unwrap();
    let second = service
        .record("workspace-1", "project-1", &report, "2026-07-13T01:00:00Z")
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(first[0].aggregate_revision, 2);
    let aggregate = OperationalRecoveryRepository::open(&fixture.path)
        .unwrap()
        .load("workspace-1", "run-1")
        .unwrap();
    assert_eq!(aggregate.revision, 2);
    assert!(matches!(
        aggregate.operations[&first[0].operation_id].disposition,
        Some(OperationalRecoveryDisposition::Waiting {
            reason: OperationalRecoveryWaitingReason::ProviderBinding,
            ..
        })
    ));
}

#[test]
fn changed_evidence_records_a_new_operation_without_executing_it() {
    let fixture = Fixture::new();
    let service = OperationalRecoveryRecordingService::new(&fixture.path);
    let waiting = service
        .record(
            "workspace-1",
            "project-1",
            &report("a", OperationalRecoveryGate::AwaitingProviderBinding),
            "2026-07-13T00:00:00Z",
        )
        .unwrap();
    let ready = service
        .record(
            "workspace-1",
            "project-1",
            &report("b", OperationalRecoveryGate::RecoveryReady),
            "2026-07-13T00:01:00Z",
        )
        .unwrap();
    assert_ne!(waiting[0].operation_id, ready[0].operation_id);
    assert_eq!(ready[0].aggregate_revision, 3);
    let aggregate = OperationalRecoveryRepository::open(&fixture.path)
        .unwrap()
        .load("workspace-1", "run-1")
        .unwrap();
    assert_eq!(aggregate.operations.len(), 2);
    assert!(
        aggregate.operations[&ready[0].operation_id]
            .disposition
            .is_none()
    );
}

#[test]
fn quarantine_is_persisted_with_the_scanner_invariant_codes() {
    let fixture = Fixture::new();
    let service = OperationalRecoveryRecordingService::new(&fixture.path);
    let mut report = report("c", OperationalRecoveryGate::Quarantined);
    report.runs[0].reasons = vec!["multiple_active_agent_loops".to_owned()];
    let recorded = service
        .record("workspace-1", "project-1", &report, "2026-07-13T00:00:00Z")
        .unwrap();
    let aggregate = OperationalRecoveryRepository::open(&fixture.path)
        .unwrap()
        .load("workspace-1", "run-1")
        .unwrap();
    assert!(matches!(
        &aggregate.operations[&recorded[0].operation_id].disposition,
        Some(OperationalRecoveryDisposition::Quarantined {
            invariant_codes,
            ..
        }) if invariant_codes == &vec!["multiple_active_agent_loops".to_owned()]
    ));
}

fn report(digit: &str, gate: OperationalRecoveryGate) -> OperationalRecoveryReport {
    OperationalRecoveryReport {
        runs: vec![OperationalRecoveryRun {
            run_id: "run-1".to_owned(),
            run_state: RunState::Running,
            source_fingerprint: digit.repeat(64),
            gate,
            active_agent_loop_id: None,
            active_agent_loop_phase: None,
            provider_attempt_states: vec![],
            tool_states: vec![],
            reasons: if gate == OperationalRecoveryGate::AwaitingProviderBinding {
                vec!["exact_provider_binding_missing".to_owned()]
            } else {
                vec![]
            },
        }],
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
