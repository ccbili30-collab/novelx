mod support;

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use novelx_protocol::{
    ContextCompilationReceipt, ContextDisclosure, ContextItem, ContextMessageRole,
    ProviderRunIdentity, ToolPermissionPolicy, ToolSourceScope,
};
use novelx_runtime::{
    agent_assignment_recovery::recover_agent_assignments,
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity,
    },
    context_compile_service::{ContextCompileService, recover_compilation_receipt},
    event_journal::EventJournal,
    operational_recovery_aggregate::{OperationalRecoveryOutcome, OperationalRecoveryRepository},
    operational_recovery_claim_service::{
        OperationalRecoveryClaimRequest, OperationalRecoveryClaimService,
        OperationalRecoveryStartRequest,
    },
    operational_recovery_recording_service::OperationalRecoveryRecordingService,
    operational_recovery_scanner::{OperationalRecoveryGate, OperationalRecoveryScanner},
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptMetadata,
        ProviderAttemptState, ProviderResponseReceipt,
    },
    provider_dispatch_recovery_service::ProviderDispatchRecoveryTerminal,
    provider_dispatch_recovery_supervisor::{
        ProviderDispatchRecoverySupervisor, ProviderDispatchRecoverySupervisorOutcome,
    },
    provider_gateway::{
        ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderGateway,
        ProviderInferenceMessage, ProviderInferenceRequest, ProviderInferenceRole,
        ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
    },
    provider_inference_service::{
        PreparedProviderAttempt, ProviderInferenceExecution, ProviderInferenceService,
    },
    run_aggregate::{EventMetadata, RunAggregate},
    runtime_cancellation_hub::{CancellationCause, RuntimeCancellationHub},
    workspace_runtime_lease::WorkspaceRuntimeLease,
};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use uuid::Uuid;

const API_KEY: &str = "provider-dispatch-supervisor-test-key";
const WORKSPACE_ID: &str = "workspace-1";
const PROJECT_ID: &str = "project-1";

#[tokio::test]
async fn requested_is_scanned_claimed_started_and_dispatched_over_real_http() {
    let fixture = Fixture::new();
    let (base_url, requests, server) = spawn_server("监督器完成真实派发").await;
    let (providers, provider) = bound_registry(base_url);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway);
    let lease = fixture.lease("runtime-owner-a");

    let report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
        .run_provider_dispatch_pass(
            WORKSPACE_ID,
            PROJECT_ID,
            &providers,
            &gateway,
            &fixture.cancellation_hub,
            &lease,
        )
        .await
        .unwrap();
    server.await.unwrap();

    let run = only_run(&report.runs);
    assert_eq!(
        run.outcome,
        ProviderDispatchRecoverySupervisorOutcome::Completed(
            ProviderDispatchRecoveryTerminal::Responded
        )
    );
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );
    let operation = fixture.operation(&seeded.run_id, &run.operation_id);
    assert!(operation.claim.is_some());
    assert!(operation.execution.is_some());
    assert!(matches!(
        operation.outcome,
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
}

#[tokio::test]
async fn sticky_shutdown_interrupts_a_late_requested_registration_before_sent_and_http() {
    let fixture = Fixture::new();
    let (base_url, requests, server) = spawn_server("must not be requested").await;
    let (providers, provider) = bound_registry(base_url);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway);
    let lease = fixture.lease("runtime-owner-a");
    fixture
        .cancellation_hub
        .signal_global(CancellationCause::RuntimeShutdown)
        .unwrap();

    let report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
        .run_provider_dispatch_pass(
            WORKSPACE_ID,
            PROJECT_ID,
            &providers,
            &gateway,
            &fixture.cancellation_hub,
            &lease,
        )
        .await
        .unwrap();

    let run = only_run(&report.runs);
    let ProviderDispatchRecoverySupervisorOutcome::InterruptedBeforeSent(interrupted) =
        &run.outcome
    else {
        panic!("expected pre-Sent interruption, got {:?}", run.outcome);
    };
    assert_eq!(interrupted.cause, CancellationCause::RuntimeShutdown);
    assert_eq!(interrupted.attempt_id, seeded.attempt_id);
    assert!(!interrupted.transport_boundary_crossed);
    assert!(interrupted.resumable);
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Requested
    );
    assert_eq!(fixture.attempt_event_types(&seeded), ["provider.requested"]);
    assert!(
        fixture
            .operation(&seeded.run_id, &run.operation_id)
            .outcome
            .is_none()
    );
    assert_eq!(fixture.cancellation_hub.registered_count().unwrap(), 0);
    server.abort();
}

#[tokio::test]
async fn old_owner_requested_execution_is_authorized_and_dispatched_by_new_runtime() {
    let fixture = Fixture::new();
    let (base_url, requests, server) = spawn_server("跨进程 Requested 恢复").await;
    let (providers, provider) = bound_registry(base_url);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway);
    let started = fixture.start_provider_dispatch(&seeded, "runtime-owner-a");
    drop(started.lease);
    let new_lease = fixture.lease("runtime-owner-b");

    let report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
        .run_provider_dispatch_pass(
            WORKSPACE_ID,
            PROJECT_ID,
            &providers,
            &gateway,
            &fixture.cancellation_hub,
            &new_lease,
        )
        .await
        .unwrap();
    server.await.unwrap();

    let run = only_run(&report.runs);
    assert_eq!(run.operation_id, started.operation_id);
    assert_eq!(
        run.outcome,
        ProviderDispatchRecoverySupervisorOutcome::Completed(
            ProviderDispatchRecoveryTerminal::Responded
        )
    );
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let operation = fixture.operation(&seeded.run_id, &started.operation_id);
    assert_eq!(operation.provider_dispatch_resumes.len(), 1);
    assert!(matches!(
        operation.outcome,
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
}

#[tokio::test]
async fn direct_split_dispatch_fences_the_supervisor_until_the_direct_response_is_persisted() {
    let fixture = Fixture::new();
    let (base_url, requests, request_received, release_response, server) =
        spawn_paused_server("直接路径完成真实派发").await;
    let (providers, provider) = bound_registry(base_url);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway);
    let started = fixture.start_provider_dispatch(&seeded, "runtime-owner-a");
    let direct_execution = fixture.provider_execution(&seeded);
    let prepared = {
        let mut journal = EventJournal::open(&fixture.path).unwrap();
        ProviderInferenceService::new(&mut journal, &providers, &gateway)
            .prepare_attempt(direct_execution)
            .unwrap()
    };
    let PreparedProviderAttempt::Dispatch(prepared) = prepared else {
        panic!("Requested attempt must require a direct Provider dispatch");
    };

    let direct_dispatch = ProviderInferenceService::dispatch_attempt(
        &gateway,
        providers.resolve(&provider).unwrap(),
        *prepared,
    );
    let supervise_while_in_flight = async {
        tokio::time::timeout(std::time::Duration::from_secs(2), request_received)
            .await
            .expect("direct Provider request did not reach the HTTP server")
            .expect("direct Provider request signal was dropped");
        let report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
            .run_provider_dispatch_pass(
                WORKSPACE_ID,
                PROJECT_ID,
                &providers,
                &gateway,
                &fixture.cancellation_hub,
                &started.lease,
            )
            .await
            .unwrap();
        release_response
            .send(())
            .expect("paused Provider response receiver was dropped");
        report
    };
    let (dispatched, first_report) = tokio::join!(direct_dispatch, supervise_while_in_flight);

    let first_run = only_run(&first_report.runs);
    assert_eq!(first_run.operation_id, started.operation_id);
    assert_eq!(
        first_run.outcome,
        ProviderDispatchRecoverySupervisorOutcome::AwaitingAttemptOwner
    );
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.attempt_state(&seeded), ProviderAttemptState::Sent);
    assert_eq!(
        fixture.attempt_event_types(&seeded),
        ["provider.requested", "provider.sent"]
    );
    assert!(
        fixture
            .operation(&seeded.run_id, &started.operation_id)
            .outcome
            .is_none()
    );

    let direct_outcome = {
        let mut journal = EventJournal::open(&fixture.path).unwrap();
        ProviderInferenceService::new(&mut journal, &providers, &gateway)
            .finalize_attempt(dispatched)
            .unwrap()
    };
    server.await.unwrap();
    assert_eq!(direct_outcome.text.as_deref(), Some("直接路径完成真实派发"));
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );

    let second_report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
        .run_provider_dispatch_pass(
            WORKSPACE_ID,
            PROJECT_ID,
            &providers,
            &gateway,
            &fixture.cancellation_hub,
            &started.lease,
        )
        .await
        .unwrap();
    let second_run = only_run(&second_report.runs);
    assert_eq!(second_run.operation_id, started.operation_id);
    assert_eq!(
        second_run.outcome,
        ProviderDispatchRecoverySupervisorOutcome::Completed(
            ProviderDispatchRecoveryTerminal::Responded
        )
    );
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.attempt_event_types(&seeded),
        ["provider.requested", "provider.sent", "provider.responded"]
    );
    assert!(matches!(
        fixture
            .operation(&seeded.run_id, &started.operation_id)
            .outcome,
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
}

#[tokio::test]
async fn old_owner_sent_execution_is_closed_unknown_without_network() {
    let fixture = Fixture::new();
    let (base_url, requests, server) = spawn_server("绝不应被请求").await;
    let (providers, provider) = bound_registry(base_url);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway);
    let started = fixture.start_provider_dispatch(&seeded, "runtime-owner-a");
    fixture.mark_sent(&seeded);
    drop(started.lease);
    let new_lease = fixture.lease("runtime-owner-b");

    let report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
        .run_provider_dispatch_pass(
            WORKSPACE_ID,
            PROJECT_ID,
            &providers,
            &gateway,
            &fixture.cancellation_hub,
            &new_lease,
        )
        .await
        .unwrap();

    let run = only_run(&report.runs);
    assert_eq!(run.operation_id, started.operation_id);
    assert_eq!(
        run.outcome,
        ProviderDispatchRecoverySupervisorOutcome::Completed(
            ProviderDispatchRecoveryTerminal::OutcomeUnknown
        )
    );
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.attempt_state(&seeded), ProviderAttemptState::Sent);
    assert!(matches!(
        fixture
            .operation(&seeded.run_id, &started.operation_id)
            .outcome,
        Some(OperationalRecoveryOutcome::OutcomeUnknown { .. })
    ));
    server.abort();
}

#[tokio::test]
async fn requested_started_execution_waits_when_exact_provider_binding_is_missing() {
    let fixture = Fixture::new();
    let (base_url, requests, server) = spawn_server("绝不应被请求").await;
    let (providers, provider) = bound_registry(base_url);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway);
    let started = fixture.start_provider_dispatch(&seeded, "runtime-owner-a");
    drop(started.lease);
    let new_lease = fixture.lease("runtime-owner-b");

    let report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
        .run_provider_dispatch_pass(
            WORKSPACE_ID,
            PROJECT_ID,
            &ProviderRegistry::default(),
            &gateway,
            &fixture.cancellation_hub,
            &new_lease,
        )
        .await
        .unwrap();

    let run = only_run(&report.runs);
    assert_eq!(
        run.outcome,
        ProviderDispatchRecoverySupervisorOutcome::Waiting(
            OperationalRecoveryGate::AwaitingProviderBinding
        )
    );
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    let operation = fixture.operation(&seeded.run_id, &started.operation_id);
    assert!(operation.outcome.is_none());
    assert!(operation.provider_dispatch_resumes.is_empty());
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Requested
    );
    server.abort();
}

#[tokio::test]
async fn unstarted_requested_claim_is_not_marked_stale_while_provider_is_unbound() {
    let fixture = Fixture::new();
    let (base_url, requests, server) = spawn_server("绝不应被请求").await;
    let (providers, provider) = bound_registry(base_url);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway);
    let lease = fixture.lease("runtime-owner-a");
    let operation_id = fixture.claim_provider_dispatch(&seeded, &lease);

    let report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
        .run_provider_dispatch_pass(
            WORKSPACE_ID,
            PROJECT_ID,
            &ProviderRegistry::default(),
            &gateway,
            &fixture.cancellation_hub,
            &lease,
        )
        .await
        .unwrap();

    let run = only_run(&report.runs);
    assert_eq!(run.operation_id, operation_id);
    assert_eq!(
        run.outcome,
        ProviderDispatchRecoverySupervisorOutcome::Waiting(
            OperationalRecoveryGate::AwaitingProviderBinding
        )
    );
    let operation = fixture.operation(&seeded.run_id, &operation_id);
    assert!(operation.stale.is_none());
    assert!(operation.execution.is_none());
    assert!(operation.outcome.is_none());
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn active_unstarted_local_projection_is_left_for_the_local_supervisor() {
    let fixture = Fixture::new();
    let (base_url, requests, server) = spawn_server("绝不应被请求").await;
    let (providers, provider) = bound_registry(base_url);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway);
    fixture.mark_responded(&seeded);
    let lease = fixture.lease("runtime-owner-a");
    let operation_id = fixture.claim_local_projection(&seeded, &lease);

    let report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
        .run_provider_dispatch_pass(
            WORKSPACE_ID,
            PROJECT_ID,
            &providers,
            &gateway,
            &fixture.cancellation_hub,
            &lease,
        )
        .await
        .unwrap();

    let run = only_run(&report.runs);
    assert_eq!(run.operation_id, operation_id);
    assert_eq!(
        run.outcome,
        ProviderDispatchRecoverySupervisorOutcome::Waiting(OperationalRecoveryGate::RecoveryReady)
    );
    let operation = fixture.operation(&seeded.run_id, &operation_id);
    assert!(operation.execution.is_none());
    assert!(operation.outcome.is_none());
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    server.abort();
}

struct Fixture {
    _temp: TempDir,
    path: std::path::PathBuf,
    cancellation_hub: RuntimeCancellationHub,
}

struct SeededRun {
    run_id: String,
    attempt_id: String,
    provider: ProviderRunIdentity,
}

struct StartedDispatch {
    operation_id: String,
    lease: Arc<WorkspaceRuntimeLease>,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        Self {
            _temp: temp,
            path,
            cancellation_hub: RuntimeCancellationHub::new(),
        }
    }

    fn lease(&self, owner: &str) -> Arc<WorkspaceRuntimeLease> {
        Arc::new(WorkspaceRuntimeLease::acquire(&self.path, owner).unwrap())
    }

    fn seed_requested(
        &self,
        providers: &ProviderRegistry,
        provider: &ProviderRunIdentity,
        gateway: &ProviderGateway,
    ) -> SeededRun {
        let run_uuid = Uuid::new_v4();
        let run_id = run_uuid.to_string();
        let invocation_id = format!("{run_id}:steward");
        let inference_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();
        let bound = providers.resolve(provider).unwrap();
        let mut identity = pinned_identity();
        identity.provider = provider.clone();
        let context_policy = identity.context_policy.clone();
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
        let receipt = ContextCompileService::new(&mut journal, providers)
            .compile(
                run_uuid,
                Uuid::new_v4(),
                context_command(
                    &invocation_id,
                    provider.clone(),
                    context_policy,
                    bound.config(),
                ),
            )
            .unwrap();
        let compilation_id = receipt.compilation_id;
        let prepared = gateway
            .prepare_inference(bound, authoritative_request(receipt.clone()))
            .unwrap();
        let loop_service = AgentLoopService::new(
            AgentLoopIdentity {
                run_id: run_uuid,
                project_id: PROJECT_ID.to_owned(),
                invocation_id: invocation_id.clone(),
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
                inference_idempotency_key: format!("{run_id}:inference:1"),
            },
        )
        .unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &loop_service,
                "agent-loop:create",
                AgentLoopEventMetadata {
                    message_id: "agent-loop-create",
                    created_at: "2026-07-13T00:00:02Z",
                },
            )
            .unwrap();
        let attempt_id = attempt_id.to_string();
        let definition = ProviderAttemptDefinition {
            run_id: run_id.clone(),
            inference_id: inference_id.to_string(),
            invocation_id,
            context_compilation_id: compilation_id,
            canonical_context_sha256: prepared.compilation().canonical_context_sha256.clone(),
            transport_payload_sha256: prepared.transport_payload_sha256().to_owned(),
            provider: provider.clone(),
            request_number: 1,
            attempt_number: 1,
            output_reserve_tokens: prepared.compilation().output_reserve_tokens,
            request_timeout_ms: bound.config().request_timeout_ms,
            total_deadline_ms: bound.config().total_deadline_ms,
            max_attempts: bound.config().retry_policy.max_attempts,
            max_total_delay_ms: bound.config().retry_policy.max_total_delay_ms,
        };
        let sequence = current_run_sequence(&journal, &run_id);
        let requested_at = OffsetDateTime::now_utc().format(&Rfc3339).unwrap();
        ProviderAttemptAggregate::create(
            &mut journal,
            &run_id,
            &attempt_id,
            definition,
            sequence,
            ProviderAttemptMetadata {
                message_id: "provider-requested",
                idempotency_key: &format!("{run_id}:inference:1"),
                created_at: &requested_at,
                reason: None,
            },
        )
        .unwrap();
        SeededRun {
            run_id,
            attempt_id,
            provider: provider.clone(),
        }
    }

    fn scan_record(&self, seeded: &SeededRun, expected_gate: OperationalRecoveryGate) -> String {
        let assignments = recover_agent_assignments(&self.path, WORKSPACE_ID, PROJECT_ID).unwrap();
        let report = {
            let mut journal = EventJournal::open(&self.path).unwrap();
            OperationalRecoveryScanner::new(
                &mut journal,
                &assignments,
                std::slice::from_ref(&seeded.provider),
            )
            .scan(WORKSPACE_ID, PROJECT_ID)
            .unwrap()
        };
        let run = report
            .runs
            .iter()
            .find(|run| run.run_id == seeded.run_id)
            .unwrap();
        assert_eq!(run.gate, expected_gate);
        OperationalRecoveryRecordingService::new(&self.path)
            .record(WORKSPACE_ID, PROJECT_ID, &report, "2026-07-13T00:00:03Z")
            .unwrap()
            .into_iter()
            .find(|record| record.run_id == seeded.run_id)
            .unwrap()
            .operation_id
    }

    fn claim_provider_dispatch(&self, seeded: &SeededRun, lease: &WorkspaceRuntimeLease) -> String {
        let operation_id = self.scan_record(seeded, OperationalRecoveryGate::ProviderDispatchReady);
        OperationalRecoveryClaimService::new(&self.path)
            .claim_provider_dispatch_ready(
                claim_request(&seeded.run_id, &operation_id),
                std::slice::from_ref(&seeded.provider),
                lease,
            )
            .unwrap();
        operation_id
    }

    fn start_provider_dispatch(&self, seeded: &SeededRun, owner: &str) -> StartedDispatch {
        let lease = self.lease(owner);
        let operation_id = self.claim_provider_dispatch(seeded, &lease);
        let aggregate = OperationalRecoveryRepository::open(&self.path)
            .unwrap()
            .load(WORKSPACE_ID, &seeded.run_id)
            .unwrap();
        let claim = aggregate.operations[&operation_id].claim.as_ref().unwrap();
        OperationalRecoveryClaimService::new(&self.path)
            .start_claimed(
                OperationalRecoveryStartRequest {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    project_id: PROJECT_ID.to_owned(),
                    run_id: seeded.run_id.clone(),
                    operation_id: operation_id.clone(),
                    claim_id: claim.claim_id.clone(),
                    owner_instance_id: claim.owner_instance_id.clone(),
                    fencing_token: claim.fencing_token,
                },
                std::slice::from_ref(&seeded.provider),
                &lease,
            )
            .unwrap();
        StartedDispatch {
            operation_id,
            lease,
        }
    }

    fn claim_local_projection(&self, seeded: &SeededRun, lease: &WorkspaceRuntimeLease) -> String {
        let operation_id = self.scan_record(seeded, OperationalRecoveryGate::RecoveryReady);
        OperationalRecoveryClaimService::new(&self.path)
            .claim_ready(
                claim_request(&seeded.run_id, &operation_id),
                std::slice::from_ref(&seeded.provider),
                lease,
            )
            .unwrap();
        operation_id
    }

    fn mark_sent(&self, seeded: &SeededRun) {
        let mut journal = EventJournal::open(&self.path).unwrap();
        let mut attempt =
            ProviderAttemptAggregate::recover(&journal, &seeded.run_id, &seeded.attempt_id)
                .unwrap();
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        attempt
            .mark_sent(
                &mut journal,
                sequence,
                "persisted-dispatch-id",
                provider_metadata("provider-sent", "provider-sent-key"),
            )
            .unwrap();
    }

    fn mark_responded(&self, seeded: &SeededRun) {
        self.mark_sent(seeded);
        let mut journal = EventJournal::open(&self.path).unwrap();
        let mut attempt =
            ProviderAttemptAggregate::recover(&journal, &seeded.run_id, &seeded.attempt_id)
                .unwrap();
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        attempt
            .respond_with_output(
                &mut journal,
                sequence,
                ProviderResponseReceipt {
                    http_status: 200,
                    actual_provider_id: seeded.provider.provider_id.clone(),
                    actual_model_id: seeded.provider.model_id.clone(),
                    response_id_sha256: Some("c".repeat(64)),
                    response_body_sha256: "d".repeat(64),
                    stop_reason: "stop".to_owned(),
                    input_tokens: 10,
                    output_tokens: 2,
                    total_tokens: 12,
                },
                Some("持久化响应".to_owned()),
                vec![],
                provider_metadata("provider-responded", "provider-responded-key"),
            )
            .unwrap();
    }

    fn attempt_state(&self, seeded: &SeededRun) -> ProviderAttemptState {
        ProviderAttemptAggregate::recover(
            &EventJournal::open(&self.path).unwrap(),
            &seeded.run_id,
            &seeded.attempt_id,
        )
        .unwrap()
        .state()
    }

    fn attempt_event_types(&self, seeded: &SeededRun) -> Vec<String> {
        EventJournal::open(&self.path)
            .unwrap()
            .read_aggregate(&seeded.run_id, "provider_attempt", &seeded.attempt_id, 0)
            .unwrap()
            .into_iter()
            .map(|event| event.event_type)
            .collect()
    }

    fn provider_execution(&self, seeded: &SeededRun) -> ProviderInferenceExecution {
        let journal = EventJournal::open(&self.path).unwrap();
        let attempt =
            ProviderAttemptAggregate::recover(&journal, &seeded.run_id, &seeded.attempt_id)
                .unwrap();
        let definition = attempt.definition();
        ProviderInferenceExecution {
            run_id: seeded.run_id.clone(),
            attempt_id: seeded.attempt_id.clone(),
            inference_id: definition.inference_id.clone(),
            invocation_id: definition.invocation_id.clone(),
            inference_idempotency_key: format!("{}:inference:1", seeded.run_id),
            attempt_number: definition.attempt_number,
            provider: seeded.provider.clone(),
            request: authoritative_request(
                recover_compilation_receipt(
                    &journal,
                    &seeded.run_id,
                    definition.context_compilation_id,
                )
                .unwrap(),
            ),
        }
    }

    fn operation(
        &self,
        run_id: &str,
        operation_id: &str,
    ) -> novelx_runtime::operational_recovery_aggregate::OperationalRecoveryOperation {
        OperationalRecoveryRepository::open(&self.path)
            .unwrap()
            .load(WORKSPACE_ID, run_id)
            .unwrap()
            .operations[operation_id]
            .clone()
    }
}

fn claim_request(run_id: &str, operation_id: &str) -> OperationalRecoveryClaimRequest {
    OperationalRecoveryClaimRequest {
        workspace_id: WORKSPACE_ID.to_owned(),
        project_id: PROJECT_ID.to_owned(),
        run_id: run_id.to_owned(),
        expected_operation_id: operation_id.to_owned(),
        lease_duration_seconds: 30,
    }
}

fn only_run(
    runs: &[novelx_runtime::provider_dispatch_recovery_supervisor::ProviderDispatchRecoverySupervisorRun],
) -> &novelx_runtime::provider_dispatch_recovery_supervisor::ProviderDispatchRecoverySupervisorRun {
    assert_eq!(runs.len(), 1);
    &runs[0]
}

fn context_command(
    invocation_id: &str,
    provider: ProviderRunIdentity,
    context_policy: novelx_protocol::VersionedPolicyIdentity,
    config: &ProviderConfig,
) -> novelx_protocol::ContextCompile {
    let content = "权威正文";
    novelx_protocol::ContextCompile {
        compile_idempotency_key: "context-key-1".to_owned(),
        invocation_id: invocation_id.to_owned(),
        request_number: 1,
        provider,
        context_policy,
        compiler_version: "1.0.0".to_owned(),
        context_window: config.context_window,
        configured_max_output_tokens: config.max_tokens,
        safety_reserve_tokens: 6_400,
        items: vec![
            ContextItem::SessionMessage {
                item_id: "current-user-turn".to_owned(),
                message_id: "current-user-message".to_owned(),
                role: ContextMessageRole::User,
                content: content.to_owned(),
                content_sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
                created_at: "2026-07-13T00:00:00Z".to_owned(),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            ContextItem::OutputReserve {
                item_id: "output-reserve".to_owned(),
                requested_tokens: config.max_tokens.unwrap_or(8_000),
                policy_id: "auto".to_owned(),
                disclosure: ContextDisclosure::AgentInternal,
            },
        ],
    }
}

fn authoritative_request(receipt: ContextCompilationReceipt) -> ProviderInferenceRequest {
    ProviderInferenceRequest {
        compilation: receipt,
        messages: vec![ProviderInferenceMessage {
            role: ProviderInferenceRole::User,
            content: "权威正文".to_owned(),
            tool_calls: vec![],
            tool_call_id: None,
        }],
        tools: vec![],
    }
}

fn bound_registry(base_url: String) -> (ProviderRegistry, ProviderRunIdentity) {
    let config = ProviderConfig {
        schema_version: 1,
        profile_id: "profile-1".to_owned(),
        provider_id: "deepseek".to_owned(),
        display_name: "DeepSeek".to_owned(),
        base_url,
        model_id: "deepseek-chat".to_owned(),
        api_flavor: ProviderApiFlavor::OpenAiChatCompletions,
        auth_scheme: ProviderAuthScheme::Bearer,
        context_window: 64_000,
        max_tokens: Some(8_000),
        reasoning: false,
        input: vec![ProviderInputCapability::Text],
        request_timeout_ms: 2_000,
        total_deadline_ms: 62_000,
        retry_policy: ProviderRetryPolicy {
            max_attempts: 1,
            max_total_delay_ms: 0,
        },
    };
    let hash = provider_config_sha256(&config).unwrap();
    let identity = ProviderRunIdentity {
        profile_id: config.profile_id.clone(),
        provider_id: config.provider_id.clone(),
        model_id: config.model_id.clone(),
        config_sha256: hash.clone(),
    };
    let mut registry = ProviderRegistry::default();
    registry.bind(config, &hash, API_KEY.to_owned()).unwrap();
    (registry, identity)
}

async fn spawn_server(
    text: &'static str,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&count);
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        observed.fetch_add(1, Ordering::SeqCst);
        let mut request = vec![0_u8; 65_536];
        let _ = socket.read(&mut request).await.unwrap();
        let body = format!(
            r#"{{"id":"response-1","model":"deepseek-chat","choices":[{{"finish_reason":"stop","message":{{"role":"assistant","content":"{text}"}}}}],"usage":{{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}}}"#
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
    });
    (format!("http://{address}/v1"), count, server)
}

async fn spawn_paused_server(
    text: &'static str,
) -> (
    String,
    Arc<AtomicUsize>,
    oneshot::Receiver<()>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&count);
    let (request_received_sender, request_received) = oneshot::channel();
    let (release_response, release_response_receiver) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        observed.fetch_add(1, Ordering::SeqCst);
        let mut request = vec![0_u8; 65_536];
        let _ = socket.read(&mut request).await.unwrap();
        let _ = request_received_sender.send(());
        let _ = release_response_receiver.await;
        let body = format!(
            r#"{{"id":"response-1","model":"deepseek-chat","choices":[{{"finish_reason":"stop","message":{{"role":"assistant","content":"{text}"}}}}],"usage":{{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}}}"#
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
    });
    (
        format!("http://{address}/v1"),
        count,
        request_received,
        release_response,
        server,
    )
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
