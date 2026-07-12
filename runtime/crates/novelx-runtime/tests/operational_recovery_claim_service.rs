mod support;

use novelx_protocol::ProviderRunIdentity;
use novelx_runtime::{
    agent_assignment_recovery::recover_agent_assignments,
    event_journal::EventJournal,
    operational_recovery_aggregate::OperationalRecoveryObservedGate,
    operational_recovery_claim_service::{
        OperationalRecoveryClaimError, OperationalRecoveryClaimRequest,
        OperationalRecoveryClaimService, OperationalRecoveryStartRequest,
        OperationalRecoveryTransferRequest,
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
    let lease = fixture.lease("runtime-instance-1");

    let aggregate = OperationalRecoveryClaimService::new(&fixture.path)
        .claim_ready(
            claim_request(&run_id, &operation_id),
            std::slice::from_ref(&provider),
            &lease,
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
    let lease = fixture.lease("runtime-instance-1");

    assert!(matches!(
        OperationalRecoveryClaimService::new(&fixture.path).claim_ready(
            claim_request(&run_id, &operation_id),
            &[],
            &lease,
        ),
        Err(OperationalRecoveryClaimError::OperationMarkedStale { .. })
    ));
    let persisted =
        novelx_runtime::operational_recovery_aggregate::OperationalRecoveryRepository::open(
            &fixture.path,
        )
        .unwrap()
        .load("workspace-1", &run_id)
        .unwrap();
    assert!(persisted.operations[&operation_id].stale.is_some());
    assert!(matches!(
        OperationalRecoveryClaimService::new(&fixture.path).claim_ready(
            claim_request(&run_id, &operation_id),
            &[provider],
            &lease,
        ),
        Err(OperationalRecoveryClaimError::Aggregate(
            novelx_runtime::operational_recovery_aggregate::OperationalRecoveryAggregateError::OperationNotClaimable
        ))
    ));
}

#[test]
fn unrecorded_ready_observation_cannot_be_claimed() {
    let fixture = Fixture::new();
    let (run_id, provider) = fixture.create_running_run();
    let report = fixture.scan(std::slice::from_ref(&provider));
    let run = report.runs.iter().find(|run| run.run_id == run_id).unwrap();
    let operation_id = fixture.operation_id(run);
    let lease = fixture.lease("runtime-instance-1");

    assert!(matches!(
        OperationalRecoveryClaimService::new(&fixture.path).claim_ready(
            claim_request(&run_id, &operation_id),
            std::slice::from_ref(&provider),
            &lease,
        ),
        Err(OperationalRecoveryClaimError::Aggregate(
            novelx_runtime::operational_recovery_aggregate::OperationalRecoveryAggregateError::NotFound
        ))
    ));
}

#[test]
fn execution_start_uses_fresh_scan_and_exact_fence() {
    let fixture = Fixture::new();
    let (run_id, provider) = fixture.create_running_run();
    let operation_id = fixture.record_ready(&run_id, std::slice::from_ref(&provider));
    let service = OperationalRecoveryClaimService::new(&fixture.path);
    let lease = fixture.lease("runtime-instance-1");
    let claimed = service
        .claim_ready(
            claim_request(&run_id, &operation_id),
            std::slice::from_ref(&provider),
            &lease,
        )
        .unwrap();
    let claim = claimed.operations[&operation_id].claim.as_ref().unwrap();
    let started = service
        .start_claimed(
            OperationalRecoveryStartRequest {
                workspace_id: "workspace-1".to_owned(),
                project_id: "project-1".to_owned(),
                run_id: run_id.clone(),
                operation_id: operation_id.clone(),
                claim_id: claim.claim_id.clone(),
                owner_instance_id: claim.owner_instance_id.clone(),
                fencing_token: claim.fencing_token,
                effect_class: novelx_runtime::operational_recovery_aggregate::OperationalRecoveryEffectClass::LocalDeterministic,
            },
            std::slice::from_ref(&provider),
            &lease,
        )
        .unwrap();
    assert!(started.operations[&operation_id].execution.is_some());

    assert!(matches!(
        service.start_claimed(
            OperationalRecoveryStartRequest {
                workspace_id: "workspace-1".to_owned(),
                project_id: "project-1".to_owned(),
                run_id,
                operation_id,
                claim_id: claim.claim_id.clone(),
                owner_instance_id: "old-owner".to_owned(),
                fencing_token: claim.fencing_token,
                effect_class: novelx_runtime::operational_recovery_aggregate::OperationalRecoveryEffectClass::LocalDeterministic,
            },
            &[provider],
            &lease,
        ),
        Err(OperationalRecoveryClaimError::FenceMismatch)
    ));
}

#[test]
fn claim_lease_duration_is_enforced_by_runtime_policy() {
    let fixture = Fixture::new();
    let (run_id, provider) = fixture.create_running_run();
    let operation_id = fixture.record_ready(&run_id, std::slice::from_ref(&provider));
    let lease = fixture.lease("runtime-instance-1");
    let mut request = claim_request(&run_id, &operation_id);
    request.lease_duration_seconds = 301;
    assert!(matches!(
        OperationalRecoveryClaimService::new(&fixture.path).claim_ready(
            request,
            &[provider],
            &lease
        ),
        Err(OperationalRecoveryClaimError::LeaseDurationInvalid)
    ));
}

#[test]
fn expired_unstarted_claim_transfers_only_to_exclusive_runtime_owner() {
    let fixture = Fixture::new();
    let (run_id, provider) = fixture.create_running_run();
    let operation_id = fixture.record_ready(&run_id, std::slice::from_ref(&provider));
    let service = OperationalRecoveryClaimService::new(&fixture.path);
    let old_lease = fixture.lease("old-runtime");
    let mut initial = claim_request(&run_id, &operation_id);
    initial.lease_duration_seconds = 1;
    let claimed = service
        .claim_ready(initial, std::slice::from_ref(&provider), &old_lease)
        .unwrap();
    let previous_claim_id = claimed.operations[&operation_id]
        .claim
        .as_ref()
        .unwrap()
        .claim_id
        .clone();
    drop(old_lease);
    std::thread::sleep(std::time::Duration::from_millis(1_100));
    let exclusive = novelx_runtime::workspace_runtime_lease::WorkspaceRuntimeLease::acquire(
        &fixture.path,
        "new-runtime",
    )
    .unwrap();
    let transferred = service
        .transfer_expired_unstarted_claim(
            OperationalRecoveryTransferRequest {
                workspace_id: "workspace-1".to_owned(),
                project_id: "project-1".to_owned(),
                run_id,
                operation_id: operation_id.clone(),
                previous_claim_id,
                lease_duration_seconds: 30,
            },
            &[provider],
            &exclusive,
        )
        .unwrap();
    let current = transferred.operations[&operation_id]
        .claim
        .as_ref()
        .unwrap();
    assert_eq!(current.owner_instance_id, "new-runtime");
    assert_eq!(current.fencing_token, 2);
}

fn claim_request(run_id: &str, operation_id: &str) -> OperationalRecoveryClaimRequest {
    OperationalRecoveryClaimRequest {
        workspace_id: "workspace-1".to_owned(),
        project_id: "project-1".to_owned(),
        run_id: run_id.to_owned(),
        expected_operation_id: operation_id.to_owned(),
        lease_duration_seconds: 30,
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

    fn lease(
        &self,
        instance_id: &str,
    ) -> novelx_runtime::workspace_runtime_lease::WorkspaceRuntimeLease {
        novelx_runtime::workspace_runtime_lease::WorkspaceRuntimeLease::acquire(
            &self.path,
            instance_id,
        )
        .unwrap()
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
