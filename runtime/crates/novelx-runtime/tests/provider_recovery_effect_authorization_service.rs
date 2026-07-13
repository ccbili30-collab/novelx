mod support;

use std::sync::Arc;

use novelx_protocol::{
    ContextCompile, ContextDisclosure, ContextItem, ProviderRunIdentity, RunPermissionMode,
    ToolPermissionPolicy, ToolSourceScope,
};
use novelx_runtime::{
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity,
        ProviderRetryBinding,
    },
    context_compile_service::ContextCompileService,
    event_journal::EventJournal,
    operational_recovery_action::OperationalRecoveryAction,
    operational_recovery_aggregate::{
        OPERATIONAL_RECOVERY_POLICY_VERSION, OperationalRecoveryClaim,
        OperationalRecoveryEffectClass, OperationalRecoveryEventMetadata,
        OperationalRecoveryExecution, OperationalRecoveryObservation,
        OperationalRecoveryObservedGate, OperationalRecoveryRepository,
    },
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptFailure,
        ProviderAttemptMetadata, ProviderAttemptState, ProviderDeliveryCertainty,
        provider_attempt_definition_sha256, provider_attempt_evidence_sha256,
    },
    provider_dispatch_resume_authorization_service::{
        ProviderDispatchResumeAuthorizationRequest, ProviderDispatchResumeAuthorizationService,
    },
    provider_effect_authorization_service::recovery::{
        ProviderRecoveryEffectAuthorizationError, ProviderRecoveryEffectAuthorizationRequest,
        ProviderRecoveryEffectAuthorizationService,
    },
    provider_gateway::{
        ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderGateway,
        ProviderInferenceMessage, ProviderInferenceRequest, ProviderInferenceRole,
        ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
    },
    provider_retry_aggregate::{
        ExponentialFullJitterPolicy, ProviderRetryAggregate, ProviderRetryDefinition,
        ProviderRetryFailureObservation, ProviderRetryMetadata, ProviderRetryPolicyAlgorithm,
        derive_retry_schedule, provider_retry_policy_sha256,
    },
    run_aggregate::{EventMetadata, RunAggregate},
    workspace_event_journal::WorkspaceEventJournal,
    workspace_runtime_lease::{BoundWorkspaceRuntimeLease, WorkspaceRuntimeLease},
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const WORKSPACE_ID: &str = "workspace-1";
const PROJECT_ID: &str = "project-1";
const INVOCATION_ID: &str = "recovery-invocation-1";
const API_KEY: &str = "recovery-provider-secret";

#[test]
fn authorizes_original_owner_without_network_or_sent_write() {
    let fixture = Fixture::new();
    let seeded = fixture.seed(SeedMutation::None);
    let before = fixture.attempt_events(&seeded.attempt_id);

    let authorization = fixture
        .authorize(&seeded, Arc::clone(&seeded.lease))
        .unwrap();

    assert_eq!(before, 1);
    assert_eq!(fixture.attempt_events(&seeded.attempt_id), 1);
    assert_eq!(
        authorization.expected_global_sequence(),
        WorkspaceEventJournal::open(&fixture.database)
            .unwrap()
            .current_global_sequence()
            .unwrap()
    );
    assert!(!fixture.journal_debug(&seeded.run_id).contains(API_KEY));
}

#[test]
fn authorizes_the_latest_persisted_resume_after_owner_loss() {
    let fixture = Fixture::new();
    let Seeded {
        run_id,
        attempt_id,
        mut request,
        providers,
        gateway,
        lease,
    } = fixture.seed(SeedMutation::None);
    drop(lease);
    let resumer = Arc::new(
        WorkspaceRuntimeLease::acquire(&fixture.database, "recovery-resumer")
            .unwrap()
            .bind_database(&fixture.database)
            .unwrap(),
    );
    let resume = ProviderDispatchResumeAuthorizationService::new(&fixture.database)
        .authorize(
            ProviderDispatchResumeAuthorizationRequest {
                workspace_id: WORKSPACE_ID.to_owned(),
                run_id,
                operation_id: request.operation_id.clone(),
                execution_id: request.execution_id.clone(),
            },
            &resumer,
        )
        .unwrap();
    request.resume_authorization_id = Some(resume.authorization_id);

    let authorization = ProviderRecoveryEffectAuthorizationService::new(
        &fixture.database,
        WORKSPACE_ID,
        PROJECT_ID,
    )
    .unwrap()
    .authorize_recovery(request, &providers, &gateway, Arc::clone(&resumer))
    .unwrap();

    drop(authorization);
    assert_eq!(fixture.attempt_events(&attempt_id), 1);
}

#[test]
fn rejects_tampered_action_non_requested_attempt_and_wrong_lease() {
    let fixture = Fixture::new();
    let tampered = fixture.seed(SeedMutation::WrongActionAttempt);
    assert!(matches!(
        fixture.authorize(&tampered, Arc::clone(&tampered.lease)),
        Err(ProviderRecoveryEffectAuthorizationError::Attempt(_))
            | Err(ProviderRecoveryEffectAuthorizationError::AttemptIdentityMismatch)
    ));

    let fixture = Fixture::new();
    let sent = fixture.seed(SeedMutation::SentAfterRecoveryStarted);
    assert!(matches!(
        fixture.authorize(&sent, Arc::clone(&sent.lease)),
        Err(
            ProviderRecoveryEffectAuthorizationError::AttemptNotRequested(
                ProviderAttemptState::Sent
            )
        )
    ));

    let fixture = Fixture::new();
    let seeded = fixture.seed(SeedMutation::None);
    let other = fixture._temp.path().join("other.db");
    EventJournal::open(&other).unwrap();
    let wrong = Arc::new(
        WorkspaceRuntimeLease::acquire(&other, "wrong-owner")
            .unwrap()
            .bind_database(&other)
            .unwrap(),
    );
    assert!(matches!(
        fixture.authorize(&seeded, wrong),
        Err(ProviderRecoveryEffectAuthorizationError::WorkspaceLease(_))
    ));
}

#[test]
fn rejects_expired_requested_deadline_without_extending_it_from_recovery_time() {
    let fixture = Fixture::new();
    let expired = fixture.seed(SeedMutation::ExpiredAttempt);
    assert!(matches!(
        fixture.authorize(&expired, Arc::clone(&expired.lease)),
        Err(ProviderRecoveryEffectAuthorizationError::DeadlineExpired)
    ));
}

#[test]
fn authorizes_persisted_retry_after_not_before_without_network_or_sent_write() {
    let fixture = Fixture::new();
    let seeded = fixture.seed_retry();
    let before = fixture.attempt_events(&seeded.attempt_id);

    let authorization = fixture
        .authorize(&seeded, Arc::clone(&seeded.lease))
        .unwrap();

    assert_eq!(before, 1);
    assert_eq!(fixture.attempt_events(&seeded.attempt_id), 1);
    drop(authorization);
}

#[test]
fn missing_or_tampered_persisted_action_fails_closed() {
    let fixture = Fixture::new();
    let seeded = fixture.seed(SeedMutation::None);
    let connection = Connection::open(&fixture.database).unwrap();
    connection
        .execute_batch("DROP TRIGGER workspace_events_no_update;")
        .unwrap();
    let changed = connection
        .execute(
            "UPDATE workspace_events SET payload_json = json_remove(payload_json, \
             '$.data.data.claim.actionSpec') WHERE workspace_id = ?1 AND stream_type = \
             'operational_recovery' AND payload_json LIKE '%\"kind\":\"claimed\"%'",
            [WORKSPACE_ID],
        )
        .unwrap();
    assert_eq!(changed, 1);
    connection
        .execute_batch(
            "CREATE TRIGGER workspace_events_no_update BEFORE UPDATE ON workspace_events BEGIN \
             SELECT RAISE(ABORT, 'workspace_events is append-only'); END;",
        )
        .unwrap();

    let error = match fixture.authorize(&seeded, Arc::clone(&seeded.lease)) {
        Ok(_) => panic!("missing persisted action was accepted"),
        Err(error) => error,
    };
    assert!(
        matches!(error, ProviderRecoveryEffectAuthorizationError::Recovery(_)),
        "unexpected fail-closed error: {error:?}"
    );
}

#[derive(Clone, Copy)]
enum SeedMutation {
    None,
    WrongActionAttempt,
    SentAfterRecoveryStarted,
    ExpiredAttempt,
}

struct Seeded {
    run_id: String,
    attempt_id: String,
    request: ProviderRecoveryEffectAuthorizationRequest,
    providers: ProviderRegistry,
    gateway: ProviderGateway,
    lease: Arc<BoundWorkspaceRuntimeLease>,
}

struct Fixture {
    _temp: TempDir,
    database: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("runtime.db");
        EventJournal::open(&database).unwrap();
        WorkspaceEventJournal::open(&database).unwrap();
        Self {
            _temp: temp,
            database,
        }
    }

    fn authorize(
        &self,
        seeded: &Seeded,
        lease: Arc<BoundWorkspaceRuntimeLease>,
    ) -> Result<
        novelx_runtime::provider_effect_authorization_service::ProviderLiveEffectAuthorization,
        ProviderRecoveryEffectAuthorizationError,
    > {
        ProviderRecoveryEffectAuthorizationService::new(&self.database, WORKSPACE_ID, PROJECT_ID)
            .unwrap()
            .authorize_recovery(
                seeded.request.clone(),
                &seeded.providers,
                &seeded.gateway,
                lease,
            )
    }

    fn seed(&self, mutation: SeedMutation) -> Seeded {
        let (providers, provider) = registry();
        let gateway = ProviderGateway::new().unwrap();
        let lease = Arc::new(
            WorkspaceRuntimeLease::acquire(&self.database, "original-recovery-owner")
                .unwrap()
                .bind_database(&self.database)
                .unwrap(),
        );
        let run_id = Uuid::new_v4();
        let mut journal = EventJournal::open(&self.database).unwrap();
        let mut pin = pinned_identity();
        pin.provider = provider.clone();
        pin.mode = RunPermissionMode::Free;
        let mut run = RunAggregate::create(
            &mut journal,
            &run_id.to_string(),
            pin.clone(),
            run_metadata("run-created"),
        )
        .unwrap();
        run.prepare(&mut journal, run_metadata("run-prepared"))
            .unwrap();
        run.start(&mut journal, run_metadata("run-started"))
            .unwrap();
        let receipt = ContextCompileService::new(&mut journal, &providers)
            .compile(
                run_id,
                Uuid::new_v4(),
                context_command(provider.clone(), pin.context_policy.clone()),
            )
            .unwrap();
        let dispatch = InferenceDispatchIdentity {
            inference_id: Uuid::new_v4(),
            attempt_id: Uuid::new_v4(),
            request_number: 1,
            context_compilation_id: receipt.compilation_id,
            attempt_number: 1,
            inference_idempotency_key: "recovery-inference:1:1".to_owned(),
        };
        let loop_identity = AgentLoopIdentity {
            run_id,
            project_id: PROJECT_ID.to_owned(),
            invocation_id: INVOCATION_ID.to_owned(),
            initial_context_compilation_id: receipt.compilation_id,
            source_scope: ToolSourceScope {
                source_checkpoint_id: pin.source_checkpoint_id.clone(),
                resource_ids: pin.scope_resource_ids.clone(),
                scope_sha256: pin.resource_scope_sha256.clone(),
            },
            permission: ToolPermissionPolicy {
                mode: pin.mode,
                policy_id: pin.tool_policy.id.clone(),
                policy_version: pin.tool_policy.version.clone(),
                policy_sha256: pin.tool_policy.sha256.clone(),
            },
        };
        let loop_service =
            AgentLoopService::new(loop_identity, loop_policy(), dispatch.clone()).unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .create(&loop_service, "loop-created", loop_metadata("loop-created"))
            .unwrap();
        let request = ProviderInferenceRequest {
            compilation: receipt.clone(),
            messages: vec![ProviderInferenceMessage {
                role: ProviderInferenceRole::System,
                content: "reliable novel steward".to_owned(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            }],
            tools: Vec::new(),
        };
        let prepared = gateway
            .prepare_inference(providers.resolve(&provider).unwrap(), request)
            .unwrap();
        let requested_at = if matches!(mutation, SeedMutation::ExpiredAttempt) {
            format_time(OffsetDateTime::now_utc() - Duration::minutes(10))
        } else {
            now()
        };
        let definition = ProviderAttemptDefinition {
            run_id: run_id.to_string(),
            inference_id: dispatch.inference_id.to_string(),
            invocation_id: INVOCATION_ID.to_owned(),
            context_compilation_id: receipt.compilation_id,
            canonical_context_sha256: receipt.canonical_context_sha256.clone(),
            transport_payload_sha256: prepared.transport_payload_sha256().to_owned(),
            provider: provider.clone(),
            request_number: 1,
            attempt_number: 1,
            output_reserve_tokens: receipt.output_reserve_tokens,
            request_timeout_ms: 30_000,
            total_deadline_ms: 300_000,
            max_attempts: 2,
            max_total_delay_ms: 1_000,
        };
        let sequence = current_run_sequence(&journal, &run_id.to_string());
        let mut attempt = ProviderAttemptAggregate::create(
            &mut journal,
            &run_id.to_string(),
            &dispatch.attempt_id.to_string(),
            definition,
            sequence,
            attempt_metadata(
                "attempt-requested",
                &dispatch.inference_idempotency_key,
                &requested_at,
            ),
        )
        .unwrap();
        let action_attempt_id = if matches!(mutation, SeedMutation::WrongActionAttempt) {
            Uuid::new_v4().to_string()
        } else {
            dispatch.attempt_id.to_string()
        };
        let action = OperationalRecoveryAction::PersistedProviderAttemptDispatch {
            invocation_id: INVOCATION_ID.to_owned(),
            attempt_id: action_attempt_id,
            inference_id: dispatch.inference_id.to_string(),
            context_compilation_id: receipt.compilation_id.to_string(),
            attempt_number: 1,
            provider,
            canonical_context_sha256: receipt.canonical_context_sha256,
            expected_loop_checkpoint_sha256: loop_service.checkpoint_sha256().unwrap(),
            expected_attempt_sequence: attempt.aggregate_sequence(),
            transport_payload_sha256: prepared.transport_payload_sha256().to_owned(),
        };
        let execution = self.seed_recovery(&run_id.to_string(), &action, &lease);
        if matches!(mutation, SeedMutation::SentAfterRecoveryStarted) {
            let sequence = current_run_sequence(&journal, &run_id.to_string());
            attempt
                .mark_sent(
                    &mut journal,
                    sequence,
                    "legacy-dispatch",
                    attempt_metadata("attempt-sent", "attempt-sent", &now()),
                )
                .unwrap();
        }
        Seeded {
            run_id: run_id.to_string(),
            attempt_id: dispatch.attempt_id.to_string(),
            request: ProviderRecoveryEffectAuthorizationRequest {
                run_id,
                operation_id: execution.0,
                execution_id: execution.1,
                resume_authorization_id: None,
            },
            providers,
            gateway,
            lease,
        }
    }

    fn seed_retry(&self) -> Seeded {
        let (providers, provider) = registry();
        let gateway = ProviderGateway::new().unwrap();
        let lease = Arc::new(
            WorkspaceRuntimeLease::acquire(&self.database, "original-retry-owner")
                .unwrap()
                .bind_database(&self.database)
                .unwrap(),
        );
        let run_id = Uuid::new_v4();
        let mut journal = EventJournal::open(&self.database).unwrap();
        let mut pin = pinned_identity();
        pin.provider = provider.clone();
        pin.mode = RunPermissionMode::Free;
        let mut run = RunAggregate::create(
            &mut journal,
            &run_id.to_string(),
            pin.clone(),
            run_metadata("retry-run-created"),
        )
        .unwrap();
        run.prepare(&mut journal, run_metadata("retry-run-prepared"))
            .unwrap();
        run.start(&mut journal, run_metadata("retry-run-started"))
            .unwrap();
        let receipt = ContextCompileService::new(&mut journal, &providers)
            .compile(
                run_id,
                Uuid::new_v4(),
                context_command(provider.clone(), pin.context_policy.clone()),
            )
            .unwrap();
        let initial_dispatch = InferenceDispatchIdentity {
            inference_id: Uuid::new_v4(),
            attempt_id: Uuid::new_v4(),
            request_number: 1,
            context_compilation_id: receipt.compilation_id,
            attempt_number: 1,
            inference_idempotency_key: "recovery-retry:1:1".to_owned(),
        };
        let identity = AgentLoopIdentity {
            run_id,
            project_id: PROJECT_ID.to_owned(),
            invocation_id: INVOCATION_ID.to_owned(),
            initial_context_compilation_id: receipt.compilation_id,
            source_scope: ToolSourceScope {
                source_checkpoint_id: pin.source_checkpoint_id.clone(),
                resource_ids: pin.scope_resource_ids.clone(),
                scope_sha256: pin.resource_scope_sha256.clone(),
            },
            permission: ToolPermissionPolicy {
                mode: pin.mode,
                policy_id: pin.tool_policy.id.clone(),
                policy_version: pin.tool_policy.version.clone(),
                policy_sha256: pin.tool_policy.sha256.clone(),
            },
        };
        let mut loop_service =
            AgentLoopService::new(identity, loop_policy(), initial_dispatch.clone()).unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &loop_service,
                "retry-loop-created",
                loop_metadata("retry-loop-created"),
            )
            .unwrap();
        let prepared = gateway
            .prepare_inference(
                providers.resolve(&provider).unwrap(),
                ProviderInferenceRequest {
                    compilation: receipt.clone(),
                    messages: vec![ProviderInferenceMessage {
                        role: ProviderInferenceRole::System,
                        content: "reliable novel steward".to_owned(),
                        tool_calls: Vec::new(),
                        tool_call_id: None,
                    }],
                    tools: Vec::new(),
                },
            )
            .unwrap();
        let parent_requested = OffsetDateTime::now_utc() - Duration::seconds(4);
        let parent_sent = parent_requested + Duration::milliseconds(100);
        let parent_failed = parent_requested + Duration::milliseconds(200);
        let parent_definition = attempt_definition(
            &run_id,
            initial_dispatch.inference_id,
            &provider,
            &receipt,
            prepared.transport_payload_sha256(),
            1,
        );
        let sequence = current_run_sequence(&journal, &run_id.to_string());
        let mut parent = ProviderAttemptAggregate::create(
            &mut journal,
            &run_id.to_string(),
            &initial_dispatch.attempt_id.to_string(),
            parent_definition,
            sequence,
            attempt_metadata(
                "retry-parent-requested",
                &initial_dispatch.inference_idempotency_key,
                &format_time(parent_requested),
            ),
        )
        .unwrap();
        let sequence = current_run_sequence(&journal, &run_id.to_string());
        parent
            .mark_sent(
                &mut journal,
                sequence,
                "retry-parent-dispatch",
                attempt_metadata(
                    "retry-parent-sent",
                    "retry-parent-sent",
                    &format_time(parent_sent),
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
        let sequence = current_run_sequence(&journal, &run_id.to_string());
        parent
            .fail(
                &mut journal,
                sequence,
                failure.clone(),
                attempt_metadata(
                    "retry-parent-failed",
                    "retry-parent-failed",
                    &format_time(parent_failed),
                ),
            )
            .unwrap();
        let observation = ProviderRetryFailureObservation {
            attempt_id: initial_dispatch.attempt_id,
            attempt_number: 1,
            attempt_aggregate_sequence: parent.aggregate_sequence(),
            attempt_definition_sha256: provider_attempt_definition_sha256(&parent).unwrap(),
            evidence_sha256: provider_attempt_evidence_sha256(&parent).unwrap(),
            failure,
            observed_at: format_time(parent_failed),
        };
        let policy = ExponentialFullJitterPolicy {
            algorithm: ProviderRetryPolicyAlgorithm::ExponentialFullJitterV1,
            initial_delay_ms: 1,
            max_delay_ms: 1,
            max_attempts: 2,
            max_total_delay_ms: 1_000,
        };
        let retry_started = parent_requested - Duration::seconds(1);
        let retry_definition = ProviderRetryDefinition {
            run_id: run_id.to_string(),
            invocation_id: INVOCATION_ID.to_owned(),
            inference_id: initial_dispatch.inference_id.to_string(),
            request_number: 1,
            context_compilation_id: receipt.compilation_id,
            provider: provider.clone(),
            canonical_context_sha256: receipt.canonical_context_sha256.clone(),
            transport_payload_sha256: prepared.transport_payload_sha256().to_owned(),
            first_attempt_id: initial_dispatch.attempt_id,
            first_attempt_number: 1,
            started_at: format_time(retry_started),
            deadline_at: format_time(retry_started + Duration::milliseconds(300_000)),
            request_timeout_ms: 30_000,
            total_deadline_ms: 300_000,
            policy_sha256: provider_retry_policy_sha256(&policy).unwrap(),
            policy,
        };
        let sequence = current_run_sequence(&journal, &run_id.to_string());
        let mut retry = ProviderRetryAggregate::create(
            &mut journal,
            retry_definition.clone(),
            observation.clone(),
            sequence,
            retry_metadata("retry-created", &observation.observed_at),
        )
        .unwrap();
        let scheduled_at = format_time(OffsetDateTime::now_utc() - Duration::seconds(2));
        let schedule =
            derive_retry_schedule(&retry_definition, &observation, 0, &scheduled_at).unwrap();
        let sequence = current_run_sequence(&journal, &run_id.to_string());
        retry
            .schedule_retry(
                &mut journal,
                schedule.clone(),
                sequence,
                retry_metadata("retry-scheduled", &schedule.not_before),
            )
            .unwrap();
        let sequence = current_run_sequence(&journal, &run_id.to_string());
        retry
            .begin_materializing(
                &mut journal,
                &schedule.not_before,
                sequence,
                retry_metadata("retry-materializing", &schedule.not_before),
            )
            .unwrap();
        let sequence = current_run_sequence(&journal, &run_id.to_string());
        retry
            .mark_awaiting_attempt(
                &mut journal,
                &schedule.not_before,
                sequence,
                retry_metadata("retry-awaiting", &schedule.not_before),
            )
            .unwrap();
        let next = InferenceDispatchIdentity {
            inference_id: initial_dispatch.inference_id,
            attempt_id: schedule.next_attempt_id,
            request_number: 1,
            context_compilation_id: receipt.compilation_id,
            attempt_number: schedule.next_attempt_number,
            inference_idempotency_key: "recovery-retry:1:2".to_owned(),
        };
        let binding = ProviderRetryBinding {
            schedule_id: schedule.schedule_id.to_string(),
            schedule_sha256: schedule.schedule_sha256.clone(),
            parent_attempt_evidence_sha256: schedule.parent_failure_evidence_sha256.clone(),
            previous_attempt_id: initial_dispatch.attempt_id,
            previous_attempt_number: 1,
            next: next.clone(),
        };
        let previous = loop_service.clone();
        loop_service.acknowledge_inference_retry(&binding).unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .append_inference_retried(
                &previous,
                &loop_service,
                &binding,
                "retry-loop-retried",
                loop_metadata("retry-loop-retried"),
            )
            .unwrap();
        let definition = attempt_definition(
            &run_id,
            next.inference_id,
            &provider,
            &receipt,
            prepared.transport_payload_sha256(),
            next.attempt_number,
        );
        let sequence = current_run_sequence(&journal, &run_id.to_string());
        let attempt = ProviderAttemptAggregate::create(
            &mut journal,
            &run_id.to_string(),
            &next.attempt_id.to_string(),
            definition,
            sequence,
            attempt_metadata(
                "retry-attempt-requested",
                &next.inference_idempotency_key,
                &schedule.not_before,
            ),
        )
        .unwrap();
        let action = OperationalRecoveryAction::PersistedProviderAttemptDispatch {
            invocation_id: INVOCATION_ID.to_owned(),
            attempt_id: next.attempt_id.to_string(),
            inference_id: next.inference_id.to_string(),
            context_compilation_id: next.context_compilation_id.to_string(),
            attempt_number: next.attempt_number,
            provider,
            canonical_context_sha256: receipt.canonical_context_sha256,
            expected_loop_checkpoint_sha256: loop_service.checkpoint_sha256().unwrap(),
            expected_attempt_sequence: attempt.aggregate_sequence(),
            transport_payload_sha256: prepared.transport_payload_sha256().to_owned(),
        };
        let recovery = self.seed_recovery(&run_id.to_string(), &action, &lease);
        Seeded {
            run_id: run_id.to_string(),
            attempt_id: next.attempt_id.to_string(),
            request: ProviderRecoveryEffectAuthorizationRequest {
                run_id,
                operation_id: recovery.0,
                execution_id: recovery.1,
                resume_authorization_id: None,
            },
            providers,
            gateway,
            lease,
        }
    }

    fn seed_recovery(
        &self,
        run_id: &str,
        action: &OperationalRecoveryAction,
        lease: &BoundWorkspaceRuntimeLease,
    ) -> (String, String) {
        let subject = novelx_runtime::operational_recovery_aggregate::OperationalRecoverySubject {
            workspace_id: WORKSPACE_ID.to_owned(),
            project_id: PROJECT_ID.to_owned(),
            run_id: run_id.to_owned(),
            policy_version: OPERATIONAL_RECOVERY_POLICY_VERSION.to_owned(),
        };
        let source = sha256(b"provider-recovery-source");
        let observation = OperationalRecoveryObservation::derive(
            &subject,
            source.clone(),
            OperationalRecoveryObservedGate::ProviderDispatchReady,
            Vec::new(),
        )
        .unwrap();
        let mut repository = OperationalRecoveryRepository::open(&self.database).unwrap();
        repository
            .observe(
                subject,
                observation.clone(),
                lease,
                OperationalRecoveryEventMetadata { created_at: now() },
            )
            .unwrap();
        let claimed_at = now();
        let claim = OperationalRecoveryClaim::derive(
            observation.operation_id.clone(),
            lease.owner_id().to_owned(),
            1,
            source,
            claimed_at.clone(),
            format_time(OffsetDateTime::now_utc() + Duration::minutes(2)),
            "recovery-effect-test-v1".to_owned(),
            Some(action.clone()),
            action.action_spec_sha256().unwrap(),
        )
        .unwrap();
        let global = WorkspaceEventJournal::open(&self.database)
            .unwrap()
            .current_global_sequence()
            .unwrap();
        repository
            .claim(
                WORKSPACE_ID,
                run_id,
                claim.clone(),
                lease,
                global,
                OperationalRecoveryEventMetadata {
                    created_at: claimed_at,
                },
            )
            .unwrap();
        let started_at = now();
        let execution = OperationalRecoveryExecution::derive(
            &claim,
            OperationalRecoveryEffectClass::ProviderDispatch,
            started_at.clone(),
        )
        .unwrap();
        let global = WorkspaceEventJournal::open(&self.database)
            .unwrap()
            .current_global_sequence()
            .unwrap();
        repository
            .start_execution(
                WORKSPACE_ID,
                run_id,
                &observation.operation_id,
                execution.clone(),
                lease,
                global,
                OperationalRecoveryEventMetadata {
                    created_at: started_at,
                },
            )
            .unwrap();
        (observation.operation_id, execution.execution_id)
    }

    fn attempt_events(&self, attempt_id: &str) -> usize {
        let run_id: String = Connection::open(&self.database)
            .unwrap()
            .query_row(
                "SELECT run_id FROM runtime_events WHERE aggregate_type = 'provider_attempt' \
                 AND aggregate_id = ?1 LIMIT 1",
                [attempt_id],
                |row| row.get(0),
            )
            .unwrap();
        EventJournal::open(&self.database)
            .unwrap()
            .read_aggregate(&run_id, "provider_attempt", attempt_id, 0)
            .unwrap()
            .len()
    }

    fn journal_debug(&self, run_id: &str) -> String {
        format!(
            "{:?}",
            EventJournal::open(&self.database)
                .unwrap()
                .read_run(run_id, 0)
                .unwrap()
        )
    }
}

fn context_command(
    provider: ProviderRunIdentity,
    context_policy: novelx_protocol::VersionedPolicyIdentity,
) -> ContextCompile {
    let system = "reliable novel steward";
    ContextCompile {
        compile_idempotency_key: "recovery-context:1".to_owned(),
        invocation_id: INVOCATION_ID.to_owned(),
        request_number: 1,
        provider,
        context_policy,
        compiler_version: "1.0.0".to_owned(),
        context_window: 64_000,
        configured_max_output_tokens: Some(2_000),
        safety_reserve_tokens: 1_000,
        items: vec![
            ContextItem::SystemPrompt {
                item_id: "system".to_owned(),
                content: system.to_owned(),
                content_sha256: sha256(system.as_bytes()),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            ContextItem::OutputReserve {
                item_id: "reserve".to_owned(),
                requested_tokens: 2_000,
                policy_id: "auto".to_owned(),
                disclosure: ContextDisclosure::AgentInternal,
            },
        ],
    }
}

fn registry() -> (ProviderRegistry, ProviderRunIdentity) {
    let config = ProviderConfig {
        schema_version: 1,
        profile_id: "profile-1".to_owned(),
        provider_id: "deepseek".to_owned(),
        display_name: "DeepSeek".to_owned(),
        base_url: "http://127.0.0.1:1/v1".to_owned(),
        model_id: "deepseek-chat".to_owned(),
        api_flavor: ProviderApiFlavor::OpenAiChatCompletions,
        auth_scheme: ProviderAuthScheme::Bearer,
        context_window: 64_000,
        max_tokens: Some(2_000),
        reasoning: false,
        input: vec![ProviderInputCapability::Text],
        request_timeout_ms: 30_000,
        total_deadline_ms: 300_000,
        retry_policy: ProviderRetryPolicy {
            max_attempts: 2,
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
    let mut providers = ProviderRegistry::default();
    providers.bind(config, &hash, API_KEY.to_owned()).unwrap();
    (providers, identity)
}

fn loop_policy() -> AgentLoopPolicy {
    AgentLoopPolicy {
        maximum_tool_rounds: 4,
        tool_schema_version: 1,
    }
}

fn run_metadata(id: &str) -> EventMetadata<'_> {
    EventMetadata {
        message_id: id,
        idempotency_key: id,
        created_at: "2026-07-13T00:00:00Z",
        reason: None,
    }
}

fn loop_metadata(id: &str) -> AgentLoopEventMetadata<'_> {
    AgentLoopEventMetadata {
        message_id: id,
        created_at: "2026-07-13T00:00:01Z",
    }
}

fn attempt_metadata<'a>(
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

fn attempt_definition(
    run_id: &Uuid,
    inference_id: Uuid,
    provider: &ProviderRunIdentity,
    receipt: &novelx_protocol::ContextCompilationReceipt,
    transport_payload_sha256: &str,
    attempt_number: u16,
) -> ProviderAttemptDefinition {
    ProviderAttemptDefinition {
        run_id: run_id.to_string(),
        inference_id: inference_id.to_string(),
        invocation_id: INVOCATION_ID.to_owned(),
        context_compilation_id: receipt.compilation_id,
        canonical_context_sha256: receipt.canonical_context_sha256.clone(),
        transport_payload_sha256: transport_payload_sha256.to_owned(),
        provider: provider.clone(),
        request_number: receipt.request_number,
        attempt_number,
        output_reserve_tokens: receipt.output_reserve_tokens,
        request_timeout_ms: 30_000,
        total_deadline_ms: 300_000,
        max_attempts: 2,
        max_total_delay_ms: 1_000,
    }
}

fn current_run_sequence(journal: &EventJournal, run_id: &str) -> u64 {
    journal
        .read_run(run_id, 0)
        .unwrap()
        .last()
        .map_or(0, |event| event.run_sequence)
}

fn now() -> String {
    format_time(OffsetDateTime::now_utc())
}

fn format_time(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).unwrap()
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
