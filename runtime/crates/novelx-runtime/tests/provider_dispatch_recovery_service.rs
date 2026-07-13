mod support;

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
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
        ProviderRetryBinding,
    },
    context_compile_service::ContextCompileService,
    event_journal::EventJournal,
    operational_recovery_aggregate::{OperationalRecoveryOutcome, OperationalRecoveryRepository},
    operational_recovery_claim_service::{
        OperationalRecoveryClaimRequest, OperationalRecoveryClaimService,
        OperationalRecoveryStartRequest,
    },
    operational_recovery_recording_service::OperationalRecoveryRecordingService,
    operational_recovery_scanner::{OperationalRecoveryGate, OperationalRecoveryScanner},
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptFailure,
        ProviderAttemptMetadata, ProviderAttemptState, ProviderDeliveryCertainty,
        ProviderResponseReceipt, provider_attempt_definition_sha256,
        provider_attempt_evidence_sha256,
    },
    provider_dispatch_recovery_service::{
        ProviderDispatchAuthorizedResumeRequest, ProviderDispatchRecoveryError,
        ProviderDispatchRecoveryRequest, ProviderDispatchRecoveryService,
        ProviderDispatchRecoveryTerminal,
    },
    provider_dispatch_recovery_supervisor::{
        ProviderDispatchRecoverySupervisor, ProviderDispatchRecoverySupervisorOutcome,
    },
    provider_dispatch_resume_authorization_service::{
        ProviderDispatchResumeAuthorizationRequest, ProviderDispatchResumeAuthorizationService,
    },
    provider_effect_capability::{
        OperationalRecoveryActorBinding, ProviderEffectAuthorityBinding, ProviderEffectGrantReceipt,
    },
    provider_gateway::{
        ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderGateway,
        ProviderInferenceMessage, ProviderInferenceRequest, ProviderInferenceRole,
        ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
    },
    provider_inference_service::{
        ProviderInferenceExecution, ProviderInferenceService, ProviderInferenceServiceError,
    },
    provider_retry_aggregate::{
        ExponentialFullJitterPolicy, ProviderRetryAggregate, ProviderRetryDefinition,
        ProviderRetryFailureObservation, ProviderRetryMetadata, ProviderRetryPolicyAlgorithm,
        derive_retry_schedule, provider_retry_policy_sha256,
    },
    run_aggregate::{EventMetadata, RunAggregate},
    workspace_runtime_lease::WorkspaceRuntimeLease,
};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use time::{Duration as TimeDuration, OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const API_KEY: &str = "provider-dispatch-recovery-test-key";
const WORKSPACE_ID: &str = "workspace-1";
const PROJECT_ID: &str = "project-1";

#[tokio::test]
async fn requested_dispatches_once_and_terminal_reentry_never_sends_again() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("潮汐记录已恢复。"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-requested");
    let service = ProviderDispatchRecoveryService::new(&fixture.path);

    let first = service
        .execute_requested(seeded.request.clone(), &providers, &gateway, &seeded.lease)
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(first.terminal, ProviderDispatchRecoveryTerminal::Responded);
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    fixture.assert_authorized_sent(&seeded, None);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );

    let second = service
        .execute_requested(
            seeded.request.clone(),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();
    assert_eq!(second, first);
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
}

#[tokio::test]
async fn retry_attempt_two_is_supervised_through_authorized_recovery_and_reentry_is_zero_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("retry recovery completed"),
    )))
    .await;
    let (providers, provider) = bound_retry_registry(base_url, 30_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_retry_requested(&providers, &provider, &gateway, "runtime-retry");

    let report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
        .run_provider_dispatch_pass(
            WORKSPACE_ID,
            PROJECT_ID,
            &providers,
            &gateway,
            &seeded.lease,
        )
        .await
        .unwrap();
    server.await.unwrap();

    assert_eq!(report.runs.len(), 1);
    assert_eq!(report.runs[0].run_id, seeded.run_id);
    assert_eq!(report.runs[0].operation_id, seeded.request.operation_id);
    assert_eq!(
        report.runs[0].outcome,
        ProviderDispatchRecoverySupervisorOutcome::Completed(
            ProviderDispatchRecoveryTerminal::Responded
        )
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );
    fixture.assert_authorized_retry_sent(&seeded);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));

    let repeated = ProviderDispatchRecoveryService::new(&fixture.path)
        .execute_requested(
            seeded.request.clone(),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();
    assert_eq!(
        repeated.terminal,
        ProviderDispatchRecoveryTerminal::Responded
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn retry_attempt_two_responded_before_outcome_is_projected_without_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("must not be requested"),
    )))
    .await;
    let (providers, provider) = bound_retry_registry(base_url, 30_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded =
        fixture.seed_retry_requested(&providers, &provider, &gateway, "runtime-retry-responded");
    fixture.mark_responded(&seeded);

    let scanned = fixture.scan_run(&seeded, std::slice::from_ref(&provider));
    assert_eq!(scanned.gate, OperationalRecoveryGate::RecoveryReady);
    assert!(matches!(
        scanned.action,
        novelx_runtime::operational_recovery_action::OperationalRecoveryAction::PersistedProviderResultProjection { .. }
    ));

    let report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
        .run_provider_dispatch_pass(
            WORKSPACE_ID,
            PROJECT_ID,
            &providers,
            &gateway,
            &seeded.lease,
        )
        .await
        .unwrap();
    assert_eq!(report.runs.len(), 1);
    assert_eq!(
        report.runs[0].outcome,
        ProviderDispatchRecoverySupervisorOutcome::Completed(
            ProviderDispatchRecoveryTerminal::Responded
        )
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
    server.abort();
}

#[tokio::test]
async fn retry_attempt_two_failed_before_outcome_is_projected_failed_safe_without_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("must not be requested"),
    )))
    .await;
    let (providers, provider) = bound_retry_registry(base_url, 30_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded =
        fixture.seed_retry_requested(&providers, &provider, &gateway, "runtime-retry-failed");
    fixture.mark_failed(&seeded);

    let scanned = fixture.scan_run(&seeded, std::slice::from_ref(&provider));
    assert_eq!(
        scanned.gate,
        OperationalRecoveryGate::WaitingForExplicitExecution
    );
    assert!(matches!(
        scanned.action,
        novelx_runtime::operational_recovery_action::OperationalRecoveryAction::NoExecutableProjection
    ));

    let report = ProviderDispatchRecoverySupervisor::new(&fixture.path)
        .run_provider_dispatch_pass(
            WORKSPACE_ID,
            PROJECT_ID,
            &providers,
            &gateway,
            &seeded.lease,
        )
        .await
        .unwrap();
    assert_eq!(report.runs.len(), 1);
    assert_eq!(
        report.runs[0].outcome,
        ProviderDispatchRecoverySupervisorOutcome::Completed(
            ProviderDispatchRecoveryTerminal::FailedSafe
        )
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::FailedSafe { .. })
    ));
    server.abort();
}

#[test]
fn multiple_attempts_without_authoritative_retry_lineage_remain_quarantined() {
    let fixture = Fixture::new();
    let (providers, provider) = bound_retry_registry("http://127.0.0.1:1/v1".to_owned(), 30_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-conflict");
    fixture.add_unbound_duplicate_requested(&seeded);

    let assignments = recover_agent_assignments(&fixture.path, WORKSPACE_ID, PROJECT_ID).unwrap();
    let report = OperationalRecoveryScanner::new(
        &mut EventJournal::open(&fixture.path).unwrap(),
        &assignments,
        std::slice::from_ref(&provider),
    )
    .scan(WORKSPACE_ID, PROJECT_ID)
    .unwrap();
    let scanned = report
        .runs
        .iter()
        .find(|run| run.run_id == seeded.run_id)
        .unwrap();
    assert_eq!(scanned.gate, OperationalRecoveryGate::Quarantined);
    assert!(matches!(
        scanned.action,
        novelx_runtime::operational_recovery_action::OperationalRecoveryAction::PersistedEvidenceConflict { .. }
    ));
    assert!(
        scanned
            .reasons
            .iter()
            .any(|reason| reason == "persisted_provider_evidence_conflict")
    );
}

#[test]
fn retry_attempt_three_fails_closed_until_full_lineage_snapshot_is_available() {
    let fixture = Fixture::new();
    let (providers, provider) =
        bound_retry_registry_with_max_attempts("http://127.0.0.1:1/v1".to_owned(), 30_000, 3);
    let gateway = ProviderGateway::new().unwrap();
    let seeded =
        fixture.seed_retry_requested(&providers, &provider, &gateway, "runtime-retry-three");
    let seeded = fixture.advance_to_retry_attempt_three(seeded);

    let scanned = fixture.scan_run(&seeded, std::slice::from_ref(&provider));
    assert_eq!(scanned.gate, OperationalRecoveryGate::Quarantined);
    assert!(matches!(
        scanned.action,
        novelx_runtime::operational_recovery_action::OperationalRecoveryAction::PersistedEvidenceConflict { .. }
    ));
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Requested
    );
}

#[tokio::test]
async fn sent_attempt_is_evidence_first_and_never_requires_provider_binding_or_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-sent");
    fixture.mark_sent(&seeded);

    let receipt = ProviderDispatchRecoveryService::new(&fixture.path)
        .execute_requested(
            seeded.request.clone(),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();

    assert_eq!(
        receipt.terminal,
        ProviderDispatchRecoveryTerminal::OutcomeUnknown
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.attempt_state(&seeded), ProviderAttemptState::Sent);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::OutcomeUnknown { .. })
    ));
    server.abort();
}

#[tokio::test]
async fn responded_attempt_is_evidence_first_and_never_requires_provider_binding_or_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-responded");
    fixture.mark_responded(&seeded);

    let receipt = ProviderDispatchRecoveryService::new(&fixture.path)
        .execute_requested(
            seeded.request.clone(),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();

    assert_eq!(
        receipt.terminal,
        ProviderDispatchRecoveryTerminal::Responded
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
    server.abort();
}

#[tokio::test]
async fn authentication_rejection_finishes_failed_safe_after_one_real_http_request() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        401,
        r#"{"error":"invalid key"}"#,
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-401");

    let receipt = ProviderDispatchRecoveryService::new(&fixture.path)
        .execute_requested(seeded.request.clone(), &providers, &gateway, &seeded.lease)
        .await
        .unwrap();

    server.await.unwrap();
    assert_eq!(
        receipt.terminal,
        ProviderDispatchRecoveryTerminal::FailedSafe
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.attempt_state(&seeded), ProviderAttemptState::Failed);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::FailedSafe { .. })
    ));
}

#[tokio::test]
async fn missing_provider_binding_blocks_before_dispatch_without_terminalizing_requested_attempt() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-unbound");

    let error = ProviderDispatchRecoveryService::new(&fixture.path)
        .execute_requested(
            seeded.request.clone(),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .expect_err("missing Provider binding must remain a resumable pre-dispatch block");

    let diagnostic = error.to_string().to_ascii_lowercase();
    assert!(
        diagnostic.contains("provider")
            && (diagnostic.contains("bound") || diagnostic.contains("binding")),
        "the block must identify the missing Provider binding: {error}"
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Requested
    );
    assert_eq!(fixture.outcome(&seeded), None);
    server.abort();
}

#[tokio::test]
async fn wrong_database_lease_and_wrong_execution_fence_fail_before_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-fence");
    let unrelated = Fixture::new();
    let wrong_lease = unrelated.lease("runtime-other-database");
    let service = ProviderDispatchRecoveryService::new(&fixture.path);

    let wrong_database = service
        .execute_requested(seeded.request.clone(), &providers, &gateway, &wrong_lease)
        .await
        .unwrap_err();
    assert!(matches!(
        wrong_database,
        ProviderDispatchRecoveryError::WorkspaceLeaseMismatch
    ));

    let mut wrong_fence_request = seeded.request.clone();
    wrong_fence_request.execution_id = Uuid::new_v4().to_string();
    let wrong_fence = service
        .execute_requested(wrong_fence_request, &providers, &gateway, &seeded.lease)
        .await
        .unwrap_err();
    assert!(matches!(
        wrong_fence,
        ProviderDispatchRecoveryError::RecoveryFenceMismatch
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Requested
    );
    assert_eq!(fixture.outcome(&seeded), None);
    server.abort();
}

#[tokio::test]
async fn concurrent_execute_is_single_flight_and_never_marks_the_live_request_outcome_unknown() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Delayed {
        delay: Duration::from_millis(500),
        response: json_response(200, successful_body("唯一响应")),
    })
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-single-flight");
    let first_service = ProviderDispatchRecoveryService::new(&fixture.path);
    let second_service = ProviderDispatchRecoveryService::new(&fixture.path);
    let first_request = seeded.request.clone();
    let second_request = seeded.request.clone();

    let first = first_service.execute_requested(first_request, &providers, &gateway, &seeded.lease);
    let second = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        second_service
            .execute_requested(second_request, &providers, &gateway, &seeded.lease)
            .await
    };
    let (first, second) = tokio::join!(first, second);

    server.await.unwrap();
    assert_eq!(
        first.unwrap().terminal,
        ProviderDispatchRecoveryTerminal::Responded
    );
    assert!(matches!(
        second.unwrap_err(),
        ProviderDispatchRecoveryError::Provider(
            ProviderInferenceServiceError::AttemptInFlight { .. }
        )
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
}

#[tokio::test]
async fn recovery_cannot_terminalize_an_attempt_owned_by_the_live_provider_path() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Delayed {
        delay: Duration::from_millis(500),
        response: json_response(200, successful_body("直接路径唯一响应")),
    })
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "runtime-shared-guard");
    let mut direct_journal = EventJournal::open(&fixture.path).unwrap();
    let mut direct = ProviderInferenceService::new(&mut direct_journal, &providers, &gateway);
    let recovery = ProviderDispatchRecoveryService::new(&fixture.path);

    let direct_call = direct.execute(seeded.execution.clone());
    let recovery_call = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        recovery
            .execute_requested(seeded.request.clone(), &providers, &gateway, &seeded.lease)
            .await
    };
    let (direct_result, recovery_result) = tokio::join!(direct_call, recovery_call);

    server.await.unwrap();
    assert_eq!(
        direct_result.unwrap().text.as_deref(),
        Some("直接路径唯一响应")
    );
    assert!(matches!(
        recovery_result.unwrap_err(),
        ProviderDispatchRecoveryError::Provider(
            ProviderInferenceServiceError::AttemptInFlight { .. }
        )
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.attempt_state(&seeded),
        ProviderAttemptState::Responded
    );
    assert_eq!(fixture.outcome(&seeded), None);

    let recovered = recovery
        .execute_requested(
            seeded.request.clone(),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();
    assert_eq!(
        recovered.terminal,
        ProviderDispatchRecoveryTerminal::Responded
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
}

#[tokio::test]
async fn requested_attempt_requires_new_owner_authorization_and_dispatches_exactly_once() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("跨进程恢复成功"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture
        .seed_requested(&providers, &provider, &gateway, "runtime-owner-a")
        .transfer_owner(&fixture, "runtime-owner-b");
    let recovery = ProviderDispatchRecoveryService::new(&fixture.path);

    let unauthorized = recovery
        .execute_requested(seeded.request.clone(), &providers, &gateway, &seeded.lease)
        .await
        .unwrap_err();
    assert!(matches!(
        unauthorized,
        ProviderDispatchRecoveryError::ResumeAuthorizationMissing
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);

    let authorization = fixture.authorize_resume(&seeded);
    let authorization_id = authorization.authorization_id.clone();
    let resume_request = ProviderDispatchAuthorizedResumeRequest {
        recovery: seeded.request.clone(),
        authorization_id: authorization.authorization_id,
    };
    let first = recovery
        .resume_authorized(resume_request.clone(), &providers, &gateway, &seeded.lease)
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(first.terminal, ProviderDispatchRecoveryTerminal::Responded);
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    fixture.assert_authorized_sent(&seeded, Some(&authorization_id));

    let repeated = recovery
        .resume_authorized(
            resume_request,
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();
    assert_eq!(repeated, first);
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn sent_attempt_new_owner_authorization_finalizes_unknown_without_provider_or_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "sent-owner-a");
    fixture.mark_sent(&seeded);
    let seeded = seeded.transfer_owner(&fixture, "sent-owner-b");
    let authorization = fixture.authorize_resume(&seeded);

    let receipt = ProviderDispatchRecoveryService::new(&fixture.path)
        .resume_authorized(
            authorized_request(&seeded, authorization.authorization_id),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();

    assert_eq!(
        receipt.terminal,
        ProviderDispatchRecoveryTerminal::OutcomeUnknown
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::OutcomeUnknown { .. })
    ));
    server.abort();
}

#[tokio::test]
async fn responded_attempt_new_owner_authorization_finalizes_without_provider_or_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "responded-owner-a");
    fixture.mark_responded(&seeded);
    let seeded = seeded.transfer_owner(&fixture, "responded-owner-b");
    let authorization = fixture.authorize_resume(&seeded);

    let receipt = ProviderDispatchRecoveryService::new(&fixture.path)
        .resume_authorized(
            authorized_request(&seeded, authorization.authorization_id),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();

    assert_eq!(
        receipt.terminal,
        ProviderDispatchRecoveryTerminal::Responded
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::Succeeded { .. })
    ));
    server.abort();
}

#[tokio::test]
async fn failed_attempt_new_owner_authorization_finalizes_without_provider_or_network() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "failed-owner-a");
    fixture.mark_failed(&seeded);
    let seeded = seeded.transfer_owner(&fixture, "failed-owner-b");
    let authorization = fixture.authorize_resume(&seeded);

    let receipt = ProviderDispatchRecoveryService::new(&fixture.path)
        .resume_authorized(
            authorized_request(&seeded, authorization.authorization_id),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();

    assert_eq!(
        receipt.terminal,
        ProviderDispatchRecoveryTerminal::FailedSafe
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert!(matches!(
        fixture.outcome(&seeded),
        Some(OperationalRecoveryOutcome::FailedSafe { .. })
    ));
    server.abort();
}

#[tokio::test]
async fn authorization_is_rejected_when_attempt_evidence_changes_before_resume() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("不应被请求"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture
        .seed_requested(&providers, &provider, &gateway, "changed-owner-a")
        .transfer_owner(&fixture, "changed-owner-b");
    let authorization = fixture.authorize_resume(&seeded);
    fixture.mark_sent(&seeded);

    let error = ProviderDispatchRecoveryService::new(&fixture.path)
        .resume_authorized(
            authorized_request(&seeded, authorization.authorization_id),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        ProviderDispatchRecoveryError::ResumeEvidenceChanged
    ));
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.outcome(&seeded), None);
    server.abort();
}

#[tokio::test]
async fn terminal_outcome_is_readable_by_new_owner_without_resume_authorization() {
    let fixture = Fixture::new();
    let (base_url, request_count, _, server) = spawn_server(ServerReply::Immediate(json_response(
        200,
        successful_body("已持久化终态"),
    )))
    .await;
    let (providers, provider) = bound_registry(base_url, 2_000);
    let gateway = ProviderGateway::new().unwrap();
    let seeded = fixture.seed_requested(&providers, &provider, &gateway, "terminal-owner-a");
    let original = ProviderDispatchRecoveryService::new(&fixture.path)
        .execute_requested(seeded.request.clone(), &providers, &gateway, &seeded.lease)
        .await
        .unwrap();
    server.await.unwrap();
    let seeded = seeded.transfer_owner(&fixture, "terminal-owner-b");

    let recovered = ProviderDispatchRecoveryService::new(&fixture.path)
        .execute_requested(
            seeded.request.clone(),
            &ProviderRegistry::default(),
            &ProviderGateway::new().unwrap(),
            &seeded.lease,
        )
        .await
        .unwrap();

    assert_eq!(recovered, original);
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    let recovery = OperationalRecoveryRepository::open(&fixture.path)
        .unwrap()
        .load(WORKSPACE_ID, &seeded.run_id)
        .unwrap();
    assert!(
        recovery.operations[&seeded.request.operation_id]
            .provider_dispatch_resumes
            .is_empty()
    );
}

struct Fixture {
    _temp: TempDir,
    path: std::path::PathBuf,
}

struct SeededRecovery {
    run_id: String,
    attempt_id: String,
    provider: ProviderRunIdentity,
    execution: ProviderInferenceExecution,
    request: ProviderDispatchRecoveryRequest,
    lease: Arc<WorkspaceRuntimeLease>,
    expected_retry: Option<ExpectedRetryGrant>,
}

struct ExpectedRetryGrant {
    retry_definition_sha256: String,
    retry_aggregate_sequence: u64,
    schedule_id: Uuid,
    schedule_sha256: String,
    parent_failure_evidence_sha256: String,
    parent_failure_observation_sha256: String,
    next_attempt_id: Uuid,
    next_attempt_number: u16,
    not_before: String,
    attempt_deadline_at: String,
}

impl SeededRecovery {
    fn transfer_owner(self, fixture: &Fixture, new_owner_instance_id: &str) -> Self {
        let Self {
            run_id,
            attempt_id,
            provider,
            execution,
            request,
            lease,
            expected_retry,
        } = self;
        drop(lease);
        Self {
            run_id,
            attempt_id,
            provider,
            execution,
            request,
            lease: fixture.lease(new_owner_instance_id),
            expected_retry,
        }
    }
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        Self { _temp: temp, path }
    }

    fn lease(&self, instance_id: &str) -> Arc<WorkspaceRuntimeLease> {
        Arc::new(WorkspaceRuntimeLease::acquire(&self.path, instance_id).unwrap())
    }

    fn seed_requested(
        &self,
        providers: &ProviderRegistry,
        provider: &ProviderRunIdentity,
        gateway: &ProviderGateway,
        owner_instance_id: &str,
    ) -> SeededRecovery {
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
        let execution = ProviderInferenceExecution {
            run_id: run_id.clone(),
            attempt_id: attempt_id.to_string(),
            inference_id: inference_id.to_string(),
            invocation_id: invocation_id.clone(),
            inference_idempotency_key: format!("{run_id}:inference:1"),
            attempt_number: 1,
            provider: provider.clone(),
            request: authoritative_request(receipt.clone()),
        };
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
        let attempt_id_string = attempt_id.to_string();
        let attempt_definition = ProviderAttemptDefinition {
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
            &attempt_id_string,
            attempt_definition,
            sequence,
            ProviderAttemptMetadata {
                message_id: "provider-requested",
                idempotency_key: &format!("{run_id}:inference:1"),
                created_at: &requested_at,
                reason: None,
            },
        )
        .unwrap();
        drop(journal);

        let assignments = recover_agent_assignments(&self.path, WORKSPACE_ID, PROJECT_ID).unwrap();
        let report = {
            let mut journal = EventJournal::open(&self.path).unwrap();
            OperationalRecoveryScanner::new(
                &mut journal,
                &assignments,
                std::slice::from_ref(provider),
            )
            .scan(WORKSPACE_ID, PROJECT_ID)
            .unwrap()
        };
        let scanned = report.runs.iter().find(|run| run.run_id == run_id).unwrap();
        assert_eq!(scanned.gate, OperationalRecoveryGate::ProviderDispatchReady);
        let operation_id = OperationalRecoveryRecordingService::new(&self.path)
            .record(WORKSPACE_ID, PROJECT_ID, &report, "2026-07-13T00:00:03Z")
            .unwrap()
            .into_iter()
            .find(|record| record.run_id == run_id)
            .unwrap()
            .operation_id;
        let lease = self.lease(owner_instance_id);
        let claim_service = OperationalRecoveryClaimService::new(&self.path);
        let claimed = claim_service
            .claim_provider_dispatch_ready(
                claim_request(&run_id, &operation_id),
                std::slice::from_ref(provider),
                &lease,
            )
            .unwrap();
        let claim = claimed.operations[&operation_id]
            .claim
            .as_ref()
            .unwrap()
            .clone();
        let started = claim_service
            .start_claimed(
                OperationalRecoveryStartRequest {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    project_id: PROJECT_ID.to_owned(),
                    run_id: run_id.clone(),
                    operation_id: operation_id.clone(),
                    claim_id: claim.claim_id,
                    owner_instance_id: claim.owner_instance_id,
                    fencing_token: claim.fencing_token,
                },
                std::slice::from_ref(provider),
                &lease,
            )
            .unwrap();
        let execution_id = started.operations[&operation_id]
            .execution
            .as_ref()
            .unwrap()
            .execution_id
            .clone();
        SeededRecovery {
            run_id: run_id.clone(),
            attempt_id: attempt_id_string,
            provider: provider.clone(),
            execution,
            request: ProviderDispatchRecoveryRequest {
                workspace_id: WORKSPACE_ID.to_owned(),
                run_id,
                operation_id,
                execution_id,
            },
            lease,
            expected_retry: None,
        }
    }

    fn add_unbound_duplicate_requested(&self, seeded: &SeededRecovery) {
        let mut journal = EventJournal::open(&self.path).unwrap();
        let original =
            ProviderAttemptAggregate::recover(&journal, &seeded.run_id, &seeded.attempt_id)
                .unwrap();
        let mut definition = original.definition().clone();
        definition.attempt_number = 2;
        let duplicate_id = Uuid::new_v4().to_string();
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        ProviderAttemptAggregate::create(
            &mut journal,
            &seeded.run_id,
            &duplicate_id,
            definition,
            sequence,
            provider_metadata_at(
                "unbound-duplicate-requested",
                "unbound-duplicate-requested-key",
                &format_time(OffsetDateTime::now_utc()),
            ),
        )
        .unwrap();
    }

    fn advance_to_retry_attempt_three(&self, mut seeded: SeededRecovery) -> SeededRecovery {
        let mut journal = EventJournal::open(&self.path).unwrap();
        let mut second =
            ProviderAttemptAggregate::recover(&journal, &seeded.run_id, &seeded.attempt_id)
                .unwrap();
        let second_definition = second.definition().clone();
        let sent_at = OffsetDateTime::now_utc() - TimeDuration::milliseconds(900);
        let failed_at = OffsetDateTime::now_utc() - TimeDuration::milliseconds(800);
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        second
            .mark_sent(
                &mut journal,
                sequence,
                "retry-second-dispatch",
                provider_metadata_at(
                    "retry-second-sent",
                    "retry-second-sent-key",
                    &format_time(sent_at),
                ),
            )
            .unwrap();
        let failure = ProviderAttemptFailure {
            code: "PROVIDER_HTTP_RETRYABLE".to_owned(),
            retryable: true,
            retry_after_ms: None,
            retry_after: None,
            http_status: Some(500),
            delivery_certainty: ProviderDeliveryCertainty::ResponseReceived,
            diagnostic_id: Uuid::new_v4(),
        };
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        second
            .fail(
                &mut journal,
                sequence,
                failure.clone(),
                provider_metadata_at(
                    "retry-second-failed",
                    "retry-second-failed-key",
                    &format_time(failed_at),
                ),
            )
            .unwrap();
        let inference_id = Uuid::parse_str(&second_definition.inference_id).unwrap();
        let observation = ProviderRetryFailureObservation {
            attempt_id: Uuid::parse_str(&seeded.attempt_id).unwrap(),
            attempt_number: second_definition.attempt_number,
            attempt_aggregate_sequence: second.aggregate_sequence(),
            attempt_definition_sha256: provider_attempt_definition_sha256(&second).unwrap(),
            evidence_sha256: provider_attempt_evidence_sha256(&second).unwrap(),
            failure,
            observed_at: format_time(failed_at),
        };
        let mut retry =
            ProviderRetryAggregate::recover(&journal, &seeded.run_id, &inference_id.to_string())
                .unwrap();
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        retry
            .observe_retryable_failure(
                &mut journal,
                observation.clone(),
                sequence,
                retry_metadata("retry-second-observed", &observation.observed_at),
            )
            .unwrap();
        let scheduled_at = format_time(OffsetDateTime::now_utc() - TimeDuration::milliseconds(500));
        let schedule = derive_retry_schedule(
            retry.definition(),
            &observation,
            retry.cumulative_delay_ms(),
            &scheduled_at,
        )
        .unwrap();
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        retry
            .schedule_retry(
                &mut journal,
                schedule.clone(),
                sequence,
                retry_metadata("retry-third-scheduled", &schedule.not_before),
            )
            .unwrap();
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        retry
            .begin_materializing(
                &mut journal,
                &schedule.not_before,
                sequence,
                retry_metadata("retry-third-materializing", &schedule.not_before),
            )
            .unwrap();
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        retry
            .mark_awaiting_attempt(
                &mut journal,
                &schedule.not_before,
                sequence,
                retry_metadata("retry-third-awaiting", &schedule.not_before),
            )
            .unwrap();

        let record = AgentLoopJournalRepository::new(&mut journal)
            .recover(&seeded.run_id, &second_definition.invocation_id)
            .unwrap();
        let mut loop_service = record.service;
        let next = InferenceDispatchIdentity {
            inference_id,
            attempt_id: schedule.next_attempt_id,
            request_number: second_definition.request_number,
            context_compilation_id: second_definition.context_compilation_id,
            attempt_number: schedule.next_attempt_number,
            inference_idempotency_key: format!("{}:inference:1:retry:3", seeded.run_id),
        };
        let binding = ProviderRetryBinding {
            schedule_id: schedule.schedule_id.to_string(),
            schedule_sha256: schedule.schedule_sha256.clone(),
            parent_attempt_evidence_sha256: schedule.parent_failure_evidence_sha256.clone(),
            previous_attempt_id: observation.attempt_id,
            previous_attempt_number: observation.attempt_number,
            next: next.clone(),
        };
        let previous = loop_service.clone();
        loop_service.acknowledge_inference_retry(&binding).unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .append_inference_retried(
                &previous,
                &loop_service,
                &binding,
                "retry-agent-loop:retried:3",
                AgentLoopEventMetadata {
                    message_id: "retry-agent-loop-retried-3",
                    created_at: &schedule.not_before,
                },
            )
            .unwrap();
        let mut third_definition = second_definition;
        third_definition.attempt_number = schedule.next_attempt_number;
        let third_attempt_id = schedule.next_attempt_id.to_string();
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        ProviderAttemptAggregate::create(
            &mut journal,
            &seeded.run_id,
            &third_attempt_id,
            third_definition,
            sequence,
            provider_metadata_at(
                "retry-third-requested",
                &next.inference_idempotency_key,
                &schedule.not_before,
            ),
        )
        .unwrap();
        drop(journal);
        seeded.attempt_id = third_attempt_id;
        seeded
    }

    fn seed_retry_requested(
        &self,
        providers: &ProviderRegistry,
        provider: &ProviderRunIdentity,
        gateway: &ProviderGateway,
        owner_instance_id: &str,
    ) -> SeededRecovery {
        let run_uuid = Uuid::new_v4();
        let run_id = run_uuid.to_string();
        let invocation_id = format!("{run_id}:steward");
        let inference_id = Uuid::new_v4();
        let parent_attempt_id = Uuid::new_v4();
        let bound = providers.resolve(provider).unwrap();
        let config = bound.config();
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
            metadata("retry-run-create", "retry-run-create-key"),
        )
        .unwrap();
        run.prepare(
            &mut journal,
            metadata("retry-run-prepare", "retry-run-prepare-key"),
        )
        .unwrap();
        run.start(
            &mut journal,
            metadata("retry-run-start", "retry-run-start-key"),
        )
        .unwrap();
        let receipt = ContextCompileService::new(&mut journal, providers)
            .compile(
                run_uuid,
                Uuid::new_v4(),
                context_command(&invocation_id, provider.clone(), context_policy, config),
            )
            .unwrap();
        let prepared = gateway
            .prepare_inference(bound, authoritative_request(receipt.clone()))
            .unwrap();
        let initial = InferenceDispatchIdentity {
            inference_id,
            attempt_id: parent_attempt_id,
            request_number: 1,
            context_compilation_id: receipt.compilation_id,
            attempt_number: 1,
            inference_idempotency_key: format!("{run_id}:inference:1"),
        };
        let mut loop_service = AgentLoopService::new(
            AgentLoopIdentity {
                run_id: run_uuid,
                project_id: PROJECT_ID.to_owned(),
                invocation_id: invocation_id.clone(),
                initial_context_compilation_id: receipt.compilation_id,
                source_scope,
                permission,
            },
            AgentLoopPolicy {
                maximum_tool_rounds: 4,
                tool_schema_version: 1,
            },
            initial.clone(),
        )
        .unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &loop_service,
                "retry-agent-loop:create",
                AgentLoopEventMetadata {
                    message_id: "retry-agent-loop-create",
                    created_at: "2026-07-13T00:00:02Z",
                },
            )
            .unwrap();

        let parent_requested_at = OffsetDateTime::now_utc() - TimeDuration::seconds(4);
        let parent_sent_at = parent_requested_at + TimeDuration::milliseconds(100);
        let parent_failed_at = parent_requested_at + TimeDuration::milliseconds(200);
        let parent_definition = ProviderAttemptDefinition {
            run_id: run_id.clone(),
            inference_id: inference_id.to_string(),
            invocation_id: invocation_id.clone(),
            context_compilation_id: receipt.compilation_id,
            canonical_context_sha256: receipt.canonical_context_sha256.clone(),
            transport_payload_sha256: prepared.transport_payload_sha256().to_owned(),
            provider: provider.clone(),
            request_number: 1,
            attempt_number: 1,
            output_reserve_tokens: receipt.output_reserve_tokens,
            request_timeout_ms: config.request_timeout_ms,
            total_deadline_ms: config.total_deadline_ms,
            max_attempts: config.retry_policy.max_attempts,
            max_total_delay_ms: config.retry_policy.max_total_delay_ms,
        };
        let sequence = current_run_sequence(&journal, &run_id);
        let mut parent = ProviderAttemptAggregate::create(
            &mut journal,
            &run_id,
            &parent_attempt_id.to_string(),
            parent_definition,
            sequence,
            provider_metadata_at(
                "retry-parent-requested",
                &initial.inference_idempotency_key,
                &format_time(parent_requested_at),
            ),
        )
        .unwrap();
        let sequence = current_run_sequence(&journal, &run_id);
        parent
            .mark_sent(
                &mut journal,
                sequence,
                "retry-parent-dispatch",
                provider_metadata_at(
                    "retry-parent-sent",
                    "retry-parent-sent-key",
                    &format_time(parent_sent_at),
                ),
            )
            .unwrap();
        let failure = ProviderAttemptFailure {
            code: "PROVIDER_HTTP_RETRYABLE".to_owned(),
            retryable: true,
            retry_after_ms: None,
            retry_after: None,
            http_status: Some(500),
            delivery_certainty: ProviderDeliveryCertainty::ResponseReceived,
            diagnostic_id: Uuid::new_v4(),
        };
        let sequence = current_run_sequence(&journal, &run_id);
        parent
            .fail(
                &mut journal,
                sequence,
                failure.clone(),
                provider_metadata_at(
                    "retry-parent-failed",
                    "retry-parent-failed-key",
                    &format_time(parent_failed_at),
                ),
            )
            .unwrap();
        let observation = ProviderRetryFailureObservation {
            attempt_id: parent_attempt_id,
            attempt_number: 1,
            attempt_aggregate_sequence: parent.aggregate_sequence(),
            attempt_definition_sha256: provider_attempt_definition_sha256(&parent).unwrap(),
            evidence_sha256: provider_attempt_evidence_sha256(&parent).unwrap(),
            failure,
            observed_at: format_time(parent_failed_at),
        };
        let policy = ExponentialFullJitterPolicy {
            algorithm: ProviderRetryPolicyAlgorithm::ExponentialFullJitterV1,
            initial_delay_ms: 1,
            max_delay_ms: 1,
            max_attempts: config.retry_policy.max_attempts,
            max_total_delay_ms: config.retry_policy.max_total_delay_ms,
        };
        let retry_started_at = parent_requested_at - TimeDuration::seconds(1);
        let retry_definition = ProviderRetryDefinition {
            run_id: run_id.clone(),
            invocation_id: invocation_id.clone(),
            inference_id: inference_id.to_string(),
            request_number: 1,
            context_compilation_id: receipt.compilation_id,
            provider: provider.clone(),
            canonical_context_sha256: receipt.canonical_context_sha256.clone(),
            transport_payload_sha256: prepared.transport_payload_sha256().to_owned(),
            first_attempt_id: parent_attempt_id,
            first_attempt_number: 1,
            started_at: format_time(retry_started_at),
            deadline_at: format_time(
                retry_started_at
                    + TimeDuration::milliseconds(i64::try_from(config.total_deadline_ms).unwrap()),
            ),
            request_timeout_ms: config.request_timeout_ms,
            total_deadline_ms: config.total_deadline_ms,
            policy_sha256: provider_retry_policy_sha256(&policy).unwrap(),
            policy,
        };
        let sequence = current_run_sequence(&journal, &run_id);
        let mut retry = ProviderRetryAggregate::create(
            &mut journal,
            retry_definition.clone(),
            observation.clone(),
            sequence,
            retry_metadata("retry-created", &observation.observed_at),
        )
        .unwrap();
        let scheduled_at = format_time(OffsetDateTime::now_utc() - TimeDuration::seconds(2));
        let schedule =
            derive_retry_schedule(&retry_definition, &observation, 0, &scheduled_at).unwrap();
        let sequence = current_run_sequence(&journal, &run_id);
        retry
            .schedule_retry(
                &mut journal,
                schedule.clone(),
                sequence,
                retry_metadata("retry-scheduled", &schedule.not_before),
            )
            .unwrap();
        let sequence = current_run_sequence(&journal, &run_id);
        retry
            .begin_materializing(
                &mut journal,
                &schedule.not_before,
                sequence,
                retry_metadata("retry-materializing", &schedule.not_before),
            )
            .unwrap();
        let sequence = current_run_sequence(&journal, &run_id);
        retry
            .mark_awaiting_attempt(
                &mut journal,
                &schedule.not_before,
                sequence,
                retry_metadata("retry-awaiting", &schedule.not_before),
            )
            .unwrap();
        let next = InferenceDispatchIdentity {
            inference_id,
            attempt_id: schedule.next_attempt_id,
            request_number: 1,
            context_compilation_id: receipt.compilation_id,
            attempt_number: schedule.next_attempt_number,
            inference_idempotency_key: format!("{run_id}:inference:1:retry:2"),
        };
        let retry_binding = ProviderRetryBinding {
            schedule_id: schedule.schedule_id.to_string(),
            schedule_sha256: schedule.schedule_sha256.clone(),
            parent_attempt_evidence_sha256: schedule.parent_failure_evidence_sha256.clone(),
            previous_attempt_id: parent_attempt_id,
            previous_attempt_number: 1,
            next: next.clone(),
        };
        let previous = loop_service.clone();
        loop_service
            .acknowledge_inference_retry(&retry_binding)
            .unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .append_inference_retried(
                &previous,
                &loop_service,
                &retry_binding,
                "retry-agent-loop:retried",
                AgentLoopEventMetadata {
                    message_id: "retry-agent-loop-retried",
                    created_at: &schedule.not_before,
                },
            )
            .unwrap();
        let child_definition = ProviderAttemptDefinition {
            run_id: run_id.clone(),
            inference_id: inference_id.to_string(),
            invocation_id: invocation_id.clone(),
            context_compilation_id: receipt.compilation_id,
            canonical_context_sha256: receipt.canonical_context_sha256.clone(),
            transport_payload_sha256: prepared.transport_payload_sha256().to_owned(),
            provider: provider.clone(),
            request_number: 1,
            attempt_number: next.attempt_number,
            output_reserve_tokens: receipt.output_reserve_tokens,
            request_timeout_ms: config.request_timeout_ms,
            total_deadline_ms: config.total_deadline_ms,
            max_attempts: config.retry_policy.max_attempts,
            max_total_delay_ms: config.retry_policy.max_total_delay_ms,
        };
        let sequence = current_run_sequence(&journal, &run_id);
        let child_attempt_id = next.attempt_id.to_string();
        ProviderAttemptAggregate::create(
            &mut journal,
            &run_id,
            &child_attempt_id,
            child_definition,
            sequence,
            provider_metadata_at(
                "retry-child-requested",
                &next.inference_idempotency_key,
                &schedule.not_before,
            ),
        )
        .unwrap();
        let execution = ProviderInferenceExecution {
            run_id: run_id.clone(),
            attempt_id: child_attempt_id.clone(),
            inference_id: inference_id.to_string(),
            invocation_id,
            inference_idempotency_key: next.inference_idempotency_key,
            attempt_number: next.attempt_number,
            provider: provider.clone(),
            request: authoritative_request(receipt),
        };
        let expected_retry = ExpectedRetryGrant {
            retry_definition_sha256: retry.definition_sha256().to_owned(),
            retry_aggregate_sequence: retry.aggregate_sequence(),
            schedule_id: schedule.schedule_id,
            schedule_sha256: schedule.schedule_sha256,
            parent_failure_evidence_sha256: schedule.parent_failure_evidence_sha256,
            parent_failure_observation_sha256: schedule.parent_failure_observation_sha256,
            next_attempt_id: schedule.next_attempt_id,
            next_attempt_number: schedule.next_attempt_number,
            not_before: schedule.not_before,
            attempt_deadline_at: schedule.attempt_deadline_at,
        };
        drop(journal);

        self.seed_recovery(
            run_id,
            child_attempt_id,
            provider.clone(),
            execution,
            owner_instance_id,
            Some(expected_retry),
        )
    }

    fn seed_recovery(
        &self,
        run_id: String,
        attempt_id: String,
        provider: ProviderRunIdentity,
        execution: ProviderInferenceExecution,
        owner_instance_id: &str,
        expected_retry: Option<ExpectedRetryGrant>,
    ) -> SeededRecovery {
        let assignments = recover_agent_assignments(&self.path, WORKSPACE_ID, PROJECT_ID).unwrap();
        let report = {
            let mut journal = EventJournal::open(&self.path).unwrap();
            OperationalRecoveryScanner::new(
                &mut journal,
                &assignments,
                std::slice::from_ref(&provider),
            )
            .scan(WORKSPACE_ID, PROJECT_ID)
            .unwrap()
        };
        let scanned = report.runs.iter().find(|run| run.run_id == run_id).unwrap();
        assert_eq!(
            scanned.gate,
            OperationalRecoveryGate::ProviderDispatchReady,
            "unexpected retry recovery scan: {scanned:#?}"
        );
        let operation_id = OperationalRecoveryRecordingService::new(&self.path)
            .record(WORKSPACE_ID, PROJECT_ID, &report, "2026-07-13T00:00:03Z")
            .unwrap()
            .into_iter()
            .find(|record| record.run_id == run_id)
            .unwrap()
            .operation_id;
        let lease = self.lease(owner_instance_id);
        let claim_service = OperationalRecoveryClaimService::new(&self.path);
        let claimed = claim_service
            .claim_provider_dispatch_ready(
                claim_request(&run_id, &operation_id),
                std::slice::from_ref(&provider),
                &lease,
            )
            .unwrap();
        let claim = claimed.operations[&operation_id]
            .claim
            .as_ref()
            .unwrap()
            .clone();
        let started = claim_service
            .start_claimed(
                OperationalRecoveryStartRequest {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    project_id: PROJECT_ID.to_owned(),
                    run_id: run_id.clone(),
                    operation_id: operation_id.clone(),
                    claim_id: claim.claim_id,
                    owner_instance_id: claim.owner_instance_id,
                    fencing_token: claim.fencing_token,
                },
                std::slice::from_ref(&provider),
                &lease,
            )
            .unwrap();
        let execution_id = started.operations[&operation_id]
            .execution
            .as_ref()
            .unwrap()
            .execution_id
            .clone();
        SeededRecovery {
            run_id: run_id.clone(),
            attempt_id,
            provider,
            execution,
            request: ProviderDispatchRecoveryRequest {
                workspace_id: WORKSPACE_ID.to_owned(),
                run_id,
                operation_id,
                execution_id,
            },
            lease,
            expected_retry,
        }
    }

    fn scan_run(
        &self,
        seeded: &SeededRecovery,
        bound_providers: &[ProviderRunIdentity],
    ) -> novelx_runtime::operational_recovery_scanner::OperationalRecoveryRun {
        let assignments = recover_agent_assignments(&self.path, WORKSPACE_ID, PROJECT_ID).unwrap();
        OperationalRecoveryScanner::new(
            &mut EventJournal::open(&self.path).unwrap(),
            &assignments,
            bound_providers,
        )
        .scan(WORKSPACE_ID, PROJECT_ID)
        .unwrap()
        .runs
        .into_iter()
        .find(|run| run.run_id == seeded.run_id)
        .unwrap()
    }

    fn mark_sent(&self, seeded: &SeededRecovery) {
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

    fn mark_responded(&self, seeded: &SeededRecovery) {
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

    fn mark_failed(&self, seeded: &SeededRecovery) {
        self.mark_sent(seeded);
        let mut journal = EventJournal::open(&self.path).unwrap();
        let mut attempt =
            ProviderAttemptAggregate::recover(&journal, &seeded.run_id, &seeded.attempt_id)
                .unwrap();
        let sequence = current_run_sequence(&journal, &seeded.run_id);
        attempt
            .fail(
                &mut journal,
                sequence,
                ProviderAttemptFailure {
                    code: "PROVIDER_AUTH_REJECTED".to_owned(),
                    retryable: false,
                    retry_after_ms: None,
                    retry_after: None,
                    http_status: Some(401),
                    delivery_certainty: ProviderDeliveryCertainty::ResponseReceived,
                    diagnostic_id: Uuid::new_v4(),
                },
                provider_metadata("provider-failed", "provider-failed-key"),
            )
            .unwrap();
    }

    fn authorize_resume(
        &self,
        seeded: &SeededRecovery,
    ) -> novelx_runtime::operational_recovery_aggregate::ProviderDispatchResumeAuthorization {
        ProviderDispatchResumeAuthorizationService::new(&self.path)
            .authorize(
                ProviderDispatchResumeAuthorizationRequest {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    run_id: seeded.run_id.clone(),
                    operation_id: seeded.request.operation_id.clone(),
                    execution_id: seeded.request.execution_id.clone(),
                },
                &seeded.lease,
            )
            .unwrap()
    }

    fn attempt_state(&self, seeded: &SeededRecovery) -> ProviderAttemptState {
        ProviderAttemptAggregate::recover(
            &EventJournal::open(&self.path).unwrap(),
            &seeded.run_id,
            &seeded.attempt_id,
        )
        .unwrap()
        .state()
    }

    fn assert_authorized_sent(
        &self,
        seeded: &SeededRecovery,
        expected_resume_authorization_id: Option<&str>,
    ) {
        let sent = EventJournal::open(&self.path)
            .unwrap()
            .read_aggregate(&seeded.run_id, "provider_attempt", &seeded.attempt_id, 0)
            .unwrap()
            .into_iter()
            .find(|event| event.event_type == "provider.sent")
            .expect("authorized recovery must persist provider.sent");
        assert_eq!(sent.event_version, 2);
        let grant: ProviderEffectGrantReceipt =
            serde_json::from_value(sent.payload["grant"].clone()).unwrap();
        grant.validate().unwrap();
        assert_eq!(grant.material().workspace_id, WORKSPACE_ID);
        assert_eq!(grant.material().project_id, PROJECT_ID);
        assert_eq!(grant.material().run_id.to_string(), seeded.run_id);
        assert_eq!(grant.material().attempt_id.to_string(), seeded.attempt_id);
        let ProviderEffectAuthorityBinding::OperationalRecovery(authority) =
            &grant.material().authority
        else {
            panic!("recovery dispatch used a non-recovery Provider effect grant");
        };
        assert_eq!(authority.operation_id, seeded.request.operation_id);
        assert_eq!(authority.execution_id, seeded.request.execution_id);
        match (&authority.actor, expected_resume_authorization_id) {
            (OperationalRecoveryActorBinding::OriginalOwner { .. }, None) => {}
            (
                OperationalRecoveryActorBinding::ResumeAuthorized {
                    authorization_id, ..
                },
                Some(expected),
            ) => assert_eq!(authorization_id, expected),
            (actual, expected) => panic!(
                "recovery actor mismatch: actor={actual:?}, expected resume authorization={expected:?}"
            ),
        }
    }

    fn assert_authorized_retry_sent(&self, seeded: &SeededRecovery) {
        self.assert_authorized_sent(seeded, None);
        let expected = seeded
            .expected_retry
            .as_ref()
            .expect("retry seed must retain the authoritative schedule");
        let sent = EventJournal::open(&self.path)
            .unwrap()
            .read_aggregate(&seeded.run_id, "provider_attempt", &seeded.attempt_id, 0)
            .unwrap()
            .into_iter()
            .find(|event| event.event_type == "provider.sent")
            .expect("authorized retry recovery must persist provider.sent");
        assert_eq!(sent.event_version, 2);
        let grant: ProviderEffectGrantReceipt =
            serde_json::from_value(sent.payload["grant"].clone()).unwrap();
        grant.validate().unwrap();
        assert_eq!(grant.material().attempt_number, 2);
        let schedule = grant
            .material()
            .retry_schedule
            .as_ref()
            .expect("attempt two must carry a retry schedule binding");
        assert_eq!(
            schedule.retry_definition_sha256,
            expected.retry_definition_sha256
        );
        assert_eq!(
            schedule.retry_aggregate_sequence,
            expected.retry_aggregate_sequence
        );
        assert_eq!(schedule.schedule_id, expected.schedule_id);
        assert_eq!(schedule.schedule_sha256, expected.schedule_sha256);
        assert_eq!(
            schedule.parent_failure_evidence_sha256,
            expected.parent_failure_evidence_sha256
        );
        assert_eq!(
            schedule.parent_failure_observation_sha256,
            expected.parent_failure_observation_sha256
        );
        assert_eq!(schedule.next_attempt_id, expected.next_attempt_id);
        assert_eq!(schedule.next_attempt_number, expected.next_attempt_number);
        assert_eq!(schedule.not_before, expected.not_before);
        assert_eq!(schedule.attempt_deadline_at, expected.attempt_deadline_at);
    }

    fn outcome(&self, seeded: &SeededRecovery) -> Option<OperationalRecoveryOutcome> {
        OperationalRecoveryRepository::open(&self.path)
            .unwrap()
            .load(WORKSPACE_ID, &seeded.run_id)
            .unwrap()
            .operations[&seeded.request.operation_id]
            .outcome
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

fn authorized_request(
    seeded: &SeededRecovery,
    authorization_id: String,
) -> ProviderDispatchAuthorizedResumeRequest {
    ProviderDispatchAuthorizedResumeRequest {
        recovery: seeded.request.clone(),
        authorization_id,
    }
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

fn bound_registry(
    base_url: String,
    request_timeout_ms: u64,
) -> (ProviderRegistry, ProviderRunIdentity) {
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
        request_timeout_ms,
        total_deadline_ms: request_timeout_ms + 60_000,
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

fn bound_retry_registry(
    base_url: String,
    request_timeout_ms: u64,
) -> (ProviderRegistry, ProviderRunIdentity) {
    bound_retry_registry_with_max_attempts(base_url, request_timeout_ms, 2)
}

fn bound_retry_registry_with_max_attempts(
    base_url: String,
    request_timeout_ms: u64,
    max_attempts: u16,
) -> (ProviderRegistry, ProviderRunIdentity) {
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
        request_timeout_ms,
        total_deadline_ms: request_timeout_ms + 60_000,
        retry_policy: ProviderRetryPolicy {
            max_attempts,
            max_total_delay_ms: 1_000,
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

enum ServerReply {
    Immediate(String),
    Delayed { delay: Duration, response: String },
}

async fn spawn_server(
    reply: ServerReply,
) -> (
    String,
    Arc<AtomicUsize>,
    Arc<Mutex<String>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&count);
    let request_body = Arc::new(Mutex::new(String::new()));
    let observed_body = Arc::clone(&request_body);
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        observed.fetch_add(1, Ordering::SeqCst);
        let mut request = vec![0_u8; 65_536];
        let length = socket.read(&mut request).await.unwrap();
        *observed_body.lock().unwrap() = String::from_utf8_lossy(&request[..length]).into_owned();
        let response = match reply {
            ServerReply::Immediate(response) => response,
            ServerReply::Delayed { delay, response } => {
                tokio::time::sleep(delay).await;
                response
            }
        };
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
    });
    (format!("http://{address}/v1"), count, request_body, server)
}

fn successful_body(text: &str) -> String {
    format!(
        r#"{{"id":"response-1","model":"deepseek-chat","choices":[{{"finish_reason":"stop","message":{{"role":"assistant","content":"{text}"}}}}],"usage":{{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}}}"#
    )
}

fn json_response(status: u16, body: impl AsRef<str>) -> String {
    let body = body.as_ref();
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        _ => "Error",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
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

fn provider_metadata_at<'a>(
    message_id: &'a str,
    idempotency_key: &'a str,
    created_at: &'a str,
) -> ProviderAttemptMetadata<'a> {
    ProviderAttemptMetadata {
        message_id,
        idempotency_key,
        created_at,
        reason: None,
    }
}

fn retry_metadata<'a>(message_id: &'a str, created_at: &'a str) -> ProviderRetryMetadata<'a> {
    ProviderRetryMetadata {
        message_id,
        idempotency_key: message_id,
        created_at,
    }
}

fn format_time(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).unwrap()
}

fn current_run_sequence(journal: &EventJournal, run_id: &str) -> u64 {
    journal
        .read_run(run_id, 0)
        .unwrap()
        .last()
        .map_or(0, |event| event.run_sequence)
}
