mod support;

use novelx_protocol::{ProviderRunIdentity, ToolPermissionPolicy, ToolSourceScope};
use novelx_runtime::{
    agent_assignment_recovery::recover_agent_assignments,
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity,
    },
    event_journal::EventJournal,
    operational_recovery_aggregate::OperationalRecoveryObservedGate,
    operational_recovery_claim_service::{
        OperationalRecoveryClaimError, OperationalRecoveryClaimRequest,
        OperationalRecoveryClaimService, OperationalRecoveryStartRequest,
        OperationalRecoveryTransferRequest,
    },
    operational_recovery_projection_service::{
        OperationalRecoveryProjectionService, PersistedProviderProjectionDirective,
        PersistedProviderProjectionRequest,
    },
    operational_recovery_recording_service::OperationalRecoveryRecordingService,
    operational_recovery_scanner::{OperationalRecoveryGate, OperationalRecoveryScanner},
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptMetadata,
        ProviderResponseReceipt,
    },
    run_aggregate::{EventMetadata, RunAggregate},
};
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn claim_service_rescans_and_claims_the_recorded_ready_operation() {
    let fixture = Fixture::new();
    let (run_id, provider) = fixture.create_projectable_run();
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
    let (run_id, provider) = fixture.create_projectable_run();
    let operation_id = fixture.record_ready(&run_id, std::slice::from_ref(&provider));
    let lease = fixture.lease("runtime-instance-1");

    fixture.move_run_to_waiting_approval(&run_id);
    assert!(matches!(
        OperationalRecoveryClaimService::new(&fixture.path).claim_ready(
            claim_request(&run_id, &operation_id),
            std::slice::from_ref(&provider),
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
        Err(OperationalRecoveryClaimError::OperationMarkedStale { .. })
    ));
}

#[test]
fn unrecorded_ready_observation_cannot_be_claimed() {
    let fixture = Fixture::new();
    let (run_id, provider) = fixture.create_projectable_run();
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
    let (run_id, provider) = fixture.create_projectable_run();
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
            },
            std::slice::from_ref(&provider),
            &lease,
        )
        .unwrap();
    assert!(started.operations[&operation_id].execution.is_some());
    assert_eq!(
        started.operations[&operation_id]
            .execution
            .as_ref()
            .unwrap()
            .effect_class,
        novelx_runtime::operational_recovery_aggregate::OperationalRecoveryEffectClass::PersistedProviderResultProjection
    );
    assert!(matches!(
        service.start_claimed(
            OperationalRecoveryStartRequest {
                workspace_id: "workspace-1".to_owned(),
                project_id: "project-1".to_owned(),
                run_id: run_id.clone(),
                operation_id: operation_id.clone(),
                claim_id: claim.claim_id.clone(),
                owner_instance_id: "old-owner".to_owned(),
                fencing_token: claim.fencing_token,
            },
            std::slice::from_ref(&provider),
            &lease,
        ),
        Err(OperationalRecoveryClaimError::FenceMismatch)
    ));
    let execution_id = started.operations[&operation_id]
        .execution
        .as_ref()
        .unwrap()
        .execution_id
        .clone();
    let action = fixture
        .scan(std::slice::from_ref(&provider))
        .runs
        .into_iter()
        .find(|run| run.run_id == run_id)
        .unwrap()
        .action;
    let projection = OperationalRecoveryProjectionService::new(&fixture.path);
    let request = PersistedProviderProjectionRequest {
        run_id: run_id.clone(),
        execution_id,
        action,
    };
    let first = projection
        .project_persisted_provider_result(request.clone())
        .unwrap();
    let repeated = projection
        .project_persisted_provider_result(request)
        .unwrap();
    assert_eq!(first, repeated);
    assert_eq!(
        first.directive,
        PersistedProviderProjectionDirective::Completed
    );
}

#[test]
fn claim_lease_duration_is_enforced_by_runtime_policy() {
    let fixture = Fixture::new();
    let (run_id, provider) = fixture.create_projectable_run();
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
    let (run_id, provider) = fixture.create_projectable_run();
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

    fn create_projectable_run(&self) -> (String, ProviderRunIdentity) {
        let run_uuid = Uuid::new_v4();
        let run_id = run_uuid.to_string();
        let identity = support::pinned_identity();
        let provider = identity.provider.clone();
        let source_scope = ToolSourceScope {
            source_checkpoint_id: identity.source_checkpoint_id.clone(),
            resource_ids: identity.scope_resource_ids.clone(),
            scope_sha256: identity.resource_scope_sha256.clone(),
        };
        let permission = ToolPermissionPolicy {
            mode: identity.mode,
            policy_id: identity.tool_policy.id.clone(),
            policy_version: identity.tool_policy.version.clone(),
            policy_sha256: identity.tool_policy.sha256.clone(),
        };
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
        let compilation_id = Uuid::new_v4();
        let inference_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();
        let loop_service = AgentLoopService::new(
            AgentLoopIdentity {
                run_id: run_uuid,
                project_id: "project-1".to_owned(),
                invocation_id: "invocation-1".to_owned(),
                initial_context_compilation_id: compilation_id,
                source_scope,
                permission,
            },
            AgentLoopPolicy {
                maximum_tool_rounds: 4,
                tool_schema_version: 1,
            },
            InferenceDispatchIdentity {
                inference_id,
                attempt_id,
                request_number: 1,
                context_compilation_id: compilation_id,
                attempt_number: 1,
                inference_idempotency_key: "inference-1".to_owned(),
            },
        )
        .unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &loop_service,
                "agent-loop:create",
                AgentLoopEventMetadata {
                    message_id: "agent-loop-create",
                    created_at: "2026-07-13T00:00:01Z",
                },
            )
            .unwrap();
        let requested_sequence = current_run_sequence(&journal, &run_id);
        let mut attempt = ProviderAttemptAggregate::create(
            &mut journal,
            &run_id,
            &attempt_id.to_string(),
            ProviderAttemptDefinition {
                run_id: run_id.clone(),
                inference_id: inference_id.to_string(),
                invocation_id: "invocation-1".to_owned(),
                context_compilation_id: compilation_id,
                canonical_context_sha256: "a".repeat(64),
                transport_payload_sha256: "b".repeat(64),
                provider: provider.clone(),
                request_number: 1,
                attempt_number: 1,
                output_reserve_tokens: 1024,
                request_timeout_ms: 30_000,
                total_deadline_ms: 60_000,
                max_attempts: 1,
                max_total_delay_ms: 0,
            },
            requested_sequence,
            provider_metadata("provider-requested", "provider-requested-key"),
        )
        .unwrap();
        let sent_sequence = current_run_sequence(&journal, &run_id);
        attempt
            .mark_sent(
                &mut journal,
                sent_sequence,
                "dispatch-1",
                provider_metadata("provider-sent", "provider-sent-key"),
            )
            .unwrap();
        let responded_sequence = current_run_sequence(&journal, &run_id);
        attempt
            .respond_with_output(
                &mut journal,
                responded_sequence,
                ProviderResponseReceipt {
                    http_status: 200,
                    actual_provider_id: provider.provider_id.clone(),
                    actual_model_id: provider.model_id.clone(),
                    response_id_sha256: Some("c".repeat(64)),
                    response_body_sha256: "d".repeat(64),
                    stop_reason: "stop".to_owned(),
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
                Some("persisted output".to_owned()),
                vec![],
                provider_metadata("provider-responded", "provider-responded-key"),
            )
            .unwrap();
        (run_id, provider)
    }

    fn move_run_to_waiting_approval(&self, run_id: &str) {
        let mut journal = EventJournal::open(&self.path).unwrap();
        let mut run = RunAggregate::recover(&journal, run_id).unwrap();
        run.wait_for_approval(
            &mut journal,
            metadata("run-waiting-approval", "run-waiting-approval-key"),
        )
        .unwrap();
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

fn provider_metadata<'a>(
    message_id: &'a str,
    idempotency_key: &'a str,
) -> ProviderAttemptMetadata<'a> {
    ProviderAttemptMetadata {
        message_id,
        idempotency_key,
        created_at: "2026-07-13T00:00:02Z",
        reason: None,
    }
}

fn current_run_sequence(journal: &EventJournal, run_id: &str) -> u64 {
    journal
        .read_run(run_id, 0)
        .unwrap()
        .last()
        .map_or(0, |event| event.run_sequence)
}
