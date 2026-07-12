mod support;

use std::sync::{Arc, Barrier};

use novelx_protocol::ProviderRunIdentity;
use novelx_runtime::{
    agent_assignment_recovery::recover_agent_assignments,
    event_journal::EventJournal,
    operational_recovery_aggregate::OperationalRecoveryObservedGate,
    operational_recovery_claim_service::{
        OperationalRecoveryClaimError, OperationalRecoveryClaimRequest,
        OperationalRecoveryClaimService,
    },
    operational_recovery_recording_service::OperationalRecoveryRecordingService,
    operational_recovery_scanner::{OperationalRecoveryGate, OperationalRecoveryScanner},
    run_aggregate::{EventMetadata, RunAggregate},
};
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn claim_service_rescans_and_claims_the_recorded_ready_operation() {
    let fixture = Fixture::new();
    let (run_id, provider) = fixture.create_running_run();
    let operation_id = fixture.record_ready(&run_id, std::slice::from_ref(&provider));

    let aggregate = OperationalRecoveryClaimService::new(&fixture.path)
        .claim_ready(
            claim_request(&run_id, &operation_id, "runtime-instance-1"),
            std::slice::from_ref(&provider),
        )
        .unwrap();
    let operation = &aggregate.operations[&operation_id];
    let claim = operation.claim.as_ref().unwrap();
    assert_eq!(claim.owner_instance_id, "runtime-instance-1");
    assert_eq!(claim.fencing_token, 1);
    assert_eq!(
        claim.source_fingerprint,
        operation.observation.source_fingerprint
    );
}

#[test]
fn changed_provider_evidence_is_rejected_by_the_fresh_scan() {
    let fixture = Fixture::new();
    let (run_id, provider) = fixture.create_running_run();
    let operation_id = fixture.record_ready(&run_id, std::slice::from_ref(&provider));

    assert!(matches!(
        OperationalRecoveryClaimService::new(&fixture.path).claim_ready(
            claim_request(&run_id, &operation_id, "runtime-instance-1"),
            &[],
        ),
        Err(OperationalRecoveryClaimError::RunNotReady {
            gate: OperationalRecoveryGate::AwaitingProviderBinding
        })
    ));
}

#[test]
fn unrecorded_ready_observation_cannot_be_claimed() {
    let fixture = Fixture::new();
    let (run_id, provider) = fixture.create_running_run();
    let report = fixture.scan(std::slice::from_ref(&provider));
    let run = report.runs.iter().find(|run| run.run_id == run_id).unwrap();
    let operation_id = fixture.operation_id(run);

    assert!(matches!(
        OperationalRecoveryClaimService::new(&fixture.path).claim_ready(
            claim_request(&run_id, &operation_id, "runtime-instance-1"),
            std::slice::from_ref(&provider),
        ),
        Err(OperationalRecoveryClaimError::Aggregate(
            novelx_runtime::operational_recovery_aggregate::OperationalRecoveryAggregateError::NotFound
        ))
    ));
}

#[test]
fn concurrent_runtime_instances_cannot_both_acquire_the_claim() {
    let fixture = Fixture::new();
    let (run_id, provider) = fixture.create_running_run();
    let operation_id = fixture.record_ready(&run_id, std::slice::from_ref(&provider));
    let barrier = Arc::new(Barrier::new(3));
    let handles = (1..=2)
        .map(|index| {
            let path = fixture.path.clone();
            let run_id = run_id.clone();
            let operation_id = operation_id.clone();
            let provider = provider.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                OperationalRecoveryClaimService::new(path).claim_ready(
                    claim_request(&run_id, &operation_id, &format!("runtime-instance-{index}")),
                    &[provider],
                )
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
}

fn claim_request(run_id: &str, operation_id: &str, owner: &str) -> OperationalRecoveryClaimRequest {
    OperationalRecoveryClaimRequest {
        workspace_id: "workspace-1".to_owned(),
        project_id: "project-1".to_owned(),
        run_id: run_id.to_owned(),
        expected_operation_id: operation_id.to_owned(),
        owner_instance_id: owner.to_owned(),
        claimed_at: "2026-07-13T00:00:00Z".to_owned(),
        lease_expires_at: "2026-07-13T00:05:00Z".to_owned(),
        executor_version: "recovery-executor-v1".to_owned(),
        action_spec_sha256: "c".repeat(64),
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
        Self { _temp: temp, path }
    }

    fn create_running_run(&self) -> (String, ProviderRunIdentity) {
        let run_id = Uuid::new_v4().to_string();
        let identity = support::pinned_identity();
        let provider = identity.provider.clone();
        let mut journal = EventJournal::open(&self.path).unwrap();
        let mut run = RunAggregate::create(
            &mut journal,
            &run_id,
            identity,
            metadata("run-create", "run-create-key"),
        )
        .unwrap();
        run.prepare(&mut journal, metadata("run-prepare", "run-prepare-key"))
            .unwrap();
        run.start(&mut journal, metadata("run-start", "run-start-key"))
            .unwrap();
        (run_id, provider)
    }

    fn scan(
        &self,
        providers: &[ProviderRunIdentity],
    ) -> novelx_runtime::operational_recovery_scanner::OperationalRecoveryReport {
        let assignments =
            recover_agent_assignments(&self.path, "workspace-1", "project-1").unwrap();
        let mut journal = EventJournal::open(&self.path).unwrap();
        OperationalRecoveryScanner::new(&mut journal, &assignments, providers)
            .scan("workspace-1", "project-1")
            .unwrap()
    }

    fn record_ready(&self, run_id: &str, providers: &[ProviderRunIdentity]) -> String {
        let report = self.scan(providers);
        let run = report.runs.iter().find(|run| run.run_id == run_id).unwrap();
        assert_eq!(run.gate, OperationalRecoveryGate::RecoveryReady);
        let operation_id = self.operation_id(run);
        OperationalRecoveryRecordingService::new(&self.path)
            .record("workspace-1", "project-1", &report, "2026-07-13T00:00:00Z")
            .unwrap();
        operation_id
    }

    fn operation_id(
        &self,
        run: &novelx_runtime::operational_recovery_scanner::OperationalRecoveryRun,
    ) -> String {
        novelx_runtime::operational_recovery_aggregate::OperationalRecoveryObservation::derive(
            &novelx_runtime::operational_recovery_aggregate::OperationalRecoverySubject {
                workspace_id: "workspace-1".to_owned(),
                project_id: "project-1".to_owned(),
                run_id: run.run_id.clone(),
                policy_version: novelx_runtime::operational_recovery_aggregate::OPERATIONAL_RECOVERY_POLICY_VERSION.to_owned(),
            },
            run.source_fingerprint.clone(),
            OperationalRecoveryObservedGate::RecoveryReady,
            run.reasons.clone(),
        )
        .unwrap()
        .operation_id
    }
}

fn metadata<'a>(message_id: &'a str, idempotency_key: &'a str) -> EventMetadata<'a> {
    EventMetadata {
        message_id,
        idempotency_key,
        created_at: "2026-07-13T00:00:00Z",
        reason: None,
    }
}
