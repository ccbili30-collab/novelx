mod support;

use std::{fs::File, sync::Arc};

use novelx_protocol::{
    ContextCompile, ContextDisclosure, ContextItem, ProviderInferenceCompleted,
    ProviderInferenceIdentity, ProviderInferenceToolCall, ProviderInferenceUsage,
    ProviderRunIdentity, RunPermissionMode, ToolArtifactReceipt, ToolPermissionPolicy,
    ToolSourceScope,
};
use novelx_runtime::{
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, FinalizedToolResult,
        InferenceDispatchIdentity, ProviderRetryBinding,
    },
    context_compile_service::ContextCompileService,
    event_journal::EventJournal,
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptFailure,
        ProviderAttemptMetadata, ProviderDeliveryCertainty, provider_attempt_definition_sha256,
        provider_attempt_evidence_sha256,
    },
    provider_effect_authorization_service::{
        ProviderEffectAuthorizationError, ProviderEffectAuthorizationService,
        ProviderLiveEffectAuthorizationRequest,
    },
    provider_gateway::{
        ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderGateway,
        ProviderInferenceRequest, ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy,
        provider_config_sha256,
    },
    provider_retry_aggregate::{
        ExponentialFullJitterPolicy, ProviderRetryAggregate, ProviderRetryDefinition,
        ProviderRetryFailureObservation, ProviderRetryMetadata, ProviderRetryPolicyAlgorithm,
        derive_retry_schedule, provider_retry_policy_sha256,
    },
    provider_tool_materializer::MaterializedProviderToolCall,
    run_aggregate::{EventMetadata, RunAggregate},
    workspace_event_journal::{NewWorkspaceEvent, WorkspaceEventJournal},
    workspace_runtime_lease::WorkspaceRuntimeLease,
};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const WORKSPACE_ID: &str = "workspace-1";
const PROJECT_ID: &str = "project-1";
const INVOCATION_ID: &str = "steward-live-1";
const API_KEY: &str = "provider-secret-must-not-enter-journal";

#[test]
fn authorizes_initial_continuation_and_retry_without_network_or_caller_hashes() {
    for kind in [
        SeedKind::Initial,
        SeedKind::Continuation,
        SeedKind::RetryReady,
    ] {
        let fixture = Fixture::new();
        let seeded = fixture.seed(kind, SeedMutation::None);
        let authorization = fixture.authorize(&seeded).unwrap();
        drop(authorization);
        assert_eq!(
            EventJournal::open(&fixture.database)
                .unwrap()
                .read_aggregate(
                    &seeded.request.run_id.to_string(),
                    "provider_attempt",
                    &seeded.request.attempt_id.to_string(),
                    0,
                )
                .unwrap()
                .len(),
            1,
            "authorization must not cross provider.sent or make a network request"
        );
        let request = ProviderLiveEffectAuthorizationRequest {
            run_id: seeded.request.run_id,
            invocation_id: seeded.request.invocation_id.clone(),
            attempt_id: seeded.request.attempt_id,
        };
        assert_eq!(request, seeded.request);
    }
}

#[test]
fn rejects_forged_continuation_origin_and_loop_authority_drift() {
    let fixture = Fixture::new();
    let forged = fixture.seed(
        SeedKind::Continuation,
        SeedMutation::ForgedContinuationOrigin,
    );
    assert!(matches!(
        fixture.authorize(&forged),
        Err(ProviderEffectAuthorizationError::PendingInferenceOriginMismatch { .. })
    ));

    for mutation in [
        SeedMutation::LoopProjectMismatch,
        SeedMutation::LoopSourceScopeMismatch,
        SeedMutation::LoopPermissionMismatch,
    ] {
        let fixture = Fixture::new();
        let seeded = fixture.seed(SeedKind::Initial, mutation);
        assert!(matches!(
            fixture.authorize(&seeded),
            Err(ProviderEffectAuthorizationError::AgentLoopAuthorityMismatch)
        ));
    }
}

#[test]
fn rejects_current_and_initial_contexts_from_another_invocation() {
    for mutation in [
        SeedMutation::CurrentContextInvocationMismatch,
        SeedMutation::InitialContextInvocationMismatch,
    ] {
        let fixture = Fixture::new();
        let seeded = fixture.seed(SeedKind::Continuation, mutation);
        assert!(matches!(
            fixture.authorize(&seeded),
            Err(ProviderEffectAuthorizationError::ContextSourceCommandMismatch)
        ));
    }
}

#[test]
fn rejects_missing_loop_non_requested_and_identity_mismatch() {
    let fixture = Fixture::new();
    let missing = fixture.seed(SeedKind::Initial, SeedMutation::NoLoop);
    assert!(matches!(
        fixture.authorize(&missing),
        Err(ProviderEffectAuthorizationError::AgentLoop(_))
    ));

    let fixture = Fixture::new();
    let sent = fixture.seed(SeedKind::Initial, SeedMutation::LegacySent);
    assert!(matches!(
        fixture.authorize(&sent),
        Err(ProviderEffectAuthorizationError::AttemptNotRequested(_))
    ));

    let fixture = Fixture::new();
    let mut identity = fixture.seed(SeedKind::Initial, SeedMutation::None);
    identity.request.invocation_id = "another-invocation".to_owned();
    assert!(matches!(
        fixture.authorize(&identity),
        Err(ProviderEffectAuthorizationError::AgentLoop(_))
            | Err(ProviderEffectAuthorizationError::AgentLoopIdentityMismatch)
    ));
}

#[test]
fn rejects_context_payload_provider_and_workspace_lease_mismatches() {
    let fixture = Fixture::new();
    let context = fixture.seed(SeedKind::Initial, SeedMutation::TamperedContextHash);
    assert!(matches!(
        fixture.authorize(&context),
        Err(ProviderEffectAuthorizationError::ContextOrPayloadMismatch)
    ));

    let fixture = Fixture::new();
    let payload = fixture.seed(SeedKind::Initial, SeedMutation::TamperedPayloadHash);
    assert!(matches!(
        fixture.authorize(&payload),
        Err(ProviderEffectAuthorizationError::ContextOrPayloadMismatch)
    ));

    let fixture = Fixture::new();
    let mut provider = fixture.seed(SeedKind::Initial, SeedMutation::None);
    provider.providers.clear();
    assert!(matches!(
        fixture.authorize(&provider),
        Err(ProviderEffectAuthorizationError::Provider(_))
    ));

    let fixture = Fixture::new();
    let mut lease = fixture.seed(SeedKind::Initial, SeedMutation::None);
    let other = fixture._temp.path().join("other.db");
    File::create(&other).unwrap();
    lease.lease = Arc::new(WorkspaceRuntimeLease::acquire(&other, "other-owner").unwrap());
    assert!(matches!(
        fixture.authorize(&lease),
        Err(ProviderEffectAuthorizationError::WorkspaceLeaseMismatch)
    ));
}

#[test]
fn rejects_retry_before_not_before_and_expired_attempt_deadline() {
    let fixture = Fixture::new();
    let future = fixture.seed(SeedKind::RetryFuture, SeedMutation::None);
    assert!(matches!(
        fixture.authorize(&future),
        Err(ProviderEffectAuthorizationError::RetryNotBefore)
    ));

    let fixture = Fixture::new();
    let expired = fixture.seed(SeedKind::RetryExpired, SeedMutation::None);
    assert!(matches!(
        fixture.authorize(&expired),
        Err(ProviderEffectAuthorizationError::DeadlineExpired)
    ));
}

#[test]
fn rejects_retry_without_a_real_matching_failed_parent_attempt() {
    let fixture = Fixture::new();
    let missing = fixture.seed(SeedKind::RetryReady, SeedMutation::RetryMissingParent);
    assert!(matches!(
        fixture.authorize(&missing),
        Err(ProviderEffectAuthorizationError::RetryParentAttemptMissing)
    ));

    let fixture = Fixture::new();
    let mismatched = fixture.seed(SeedKind::RetryReady, SeedMutation::RetryObservationMismatch);
    assert!(matches!(
        fixture.authorize(&mismatched),
        Err(ProviderEffectAuthorizationError::RetryParentAttemptMismatch)
    ));
}

#[test]
fn returns_the_current_run_stream_and_global_fences_without_using_run_aggregate_tail() {
    let fixture = Fixture::new();
    let seeded = fixture.seed(SeedKind::Initial, SeedMutation::None);
    let authorization = fixture.authorize(&seeded).unwrap();
    let run_id = seeded.request.run_id.to_string();
    let journal = EventJournal::open(&fixture.database).unwrap();
    let current_run_stream_sequence = journal
        .read_run(&run_id, 0)
        .unwrap()
        .last()
        .unwrap()
        .run_sequence;
    let run_aggregate_sequence = journal
        .read_aggregate(&run_id, "run", &run_id, 0)
        .unwrap()
        .last()
        .unwrap()
        .run_sequence;
    let current_global_sequence = WorkspaceEventJournal::open(&fixture.database)
        .unwrap()
        .current_global_sequence()
        .unwrap();
    assert!(run_aggregate_sequence < current_run_stream_sequence);
    assert_eq!(
        authorization.expected_run_sequence(),
        current_run_stream_sequence
    );
    assert_eq!(
        authorization.expected_global_sequence(),
        current_global_sequence
    );
    drop(authorization);

    let mut workspace = WorkspaceEventJournal::open(&fixture.database).unwrap();
    workspace
        .append(
            NewWorkspaceEvent {
                workspace_id: "concurrent-noise".to_owned(),
                stream_type: "test".to_owned(),
                stream_id: "global-change".to_owned(),
                message_id: "noise-1".to_owned(),
                idempotency_key: "noise-1".to_owned(),
                event_type: "test.changed".to_owned(),
                event_version: 1,
                payload: serde_json::json!({"sequence": 1}),
                created_at: now_string(),
            },
            0,
            current_global_sequence,
        )
        .unwrap();
    assert!(workspace.current_global_sequence().unwrap() > current_global_sequence);
}

#[test]
fn authorization_never_persists_provider_credentials() {
    let fixture = Fixture::new();
    let seeded = fixture.seed(SeedKind::Initial, SeedMutation::None);
    fixture.authorize(&seeded).unwrap();
    let serialized = format!(
        "{:?}",
        EventJournal::open(&fixture.database)
            .unwrap()
            .read_run(&seeded.request.run_id.to_string(), 0)
            .unwrap()
    );
    assert!(!serialized.contains(API_KEY));
}

#[derive(Clone, Copy)]
enum SeedKind {
    Initial,
    Continuation,
    RetryReady,
    RetryFuture,
    RetryExpired,
}

#[derive(Clone, Copy)]
enum SeedMutation {
    None,
    NoLoop,
    LegacySent,
    TamperedContextHash,
    TamperedPayloadHash,
    ForgedContinuationOrigin,
    LoopProjectMismatch,
    LoopSourceScopeMismatch,
    LoopPermissionMismatch,
    CurrentContextInvocationMismatch,
    InitialContextInvocationMismatch,
    RetryMissingParent,
    RetryObservationMismatch,
}

struct Seeded {
    request: ProviderLiveEffectAuthorizationRequest,
    providers: ProviderRegistry,
    gateway: ProviderGateway,
    lease: Arc<WorkspaceRuntimeLease>,
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
        Self {
            _temp: temp,
            database,
        }
    }

    fn authorize(
        &self,
        seeded: &Seeded,
    ) -> Result<
        novelx_runtime::provider_effect_authorization_service::ProviderLiveEffectAuthorization,
        ProviderEffectAuthorizationError,
    > {
        ProviderEffectAuthorizationService::new(&self.database, WORKSPACE_ID, PROJECT_ID)
            .unwrap()
            .authorize_live(
                seeded.request.clone(),
                &seeded.providers,
                &seeded.gateway,
                Arc::clone(&seeded.lease),
            )
    }

    fn seed(&self, kind: SeedKind, mutation: SeedMutation) -> Seeded {
        let request_number = if matches!(kind, SeedKind::Continuation) {
            2
        } else {
            1
        };
        let (providers, provider) = registry();
        let gateway = ProviderGateway::new().unwrap();
        let run_id = Uuid::new_v4();
        let invocation_id = INVOCATION_ID.to_owned();
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
        let initial_context_invocation = if matches!(
            mutation,
            SeedMutation::InitialContextInvocationMismatch
                | SeedMutation::CurrentContextInvocationMismatch
        ) && !matches!(kind, SeedKind::Continuation)
        {
            "other-context-invocation"
        } else if matches!(mutation, SeedMutation::InitialContextInvocationMismatch) {
            "other-initial-invocation"
        } else {
            INVOCATION_ID
        };
        let initial_receipt = ContextCompileService::new(&mut journal, &providers)
            .compile(
                run_id,
                Uuid::new_v4(),
                context_command(
                    1,
                    initial_context_invocation,
                    provider.clone(),
                    pin.context_policy.clone(),
                ),
            )
            .unwrap();
        let current_receipt = if matches!(kind, SeedKind::Continuation) {
            let current_context_invocation =
                if matches!(mutation, SeedMutation::CurrentContextInvocationMismatch) {
                    "other-current-invocation"
                } else {
                    INVOCATION_ID
                };
            ContextCompileService::new(&mut journal, &providers)
                .compile(
                    run_id,
                    Uuid::new_v4(),
                    context_command(
                        2,
                        current_context_invocation,
                        provider.clone(),
                        pin.context_policy.clone(),
                    ),
                )
                .unwrap()
        } else {
            initial_receipt.clone()
        };
        let initial_dispatch = InferenceDispatchIdentity {
            inference_id: Uuid::new_v4(),
            attempt_id: Uuid::new_v4(),
            request_number: 1,
            context_compilation_id: initial_receipt.compilation_id,
            attempt_number: 1,
            inference_idempotency_key: "inference:1:1".to_owned(),
        };
        let mut current_dispatch = initial_dispatch.clone();
        if matches!(kind, SeedKind::Continuation) {
            current_dispatch = InferenceDispatchIdentity {
                inference_id: Uuid::new_v4(),
                attempt_id: Uuid::new_v4(),
                request_number: 2,
                context_compilation_id: current_receipt.compilation_id,
                attempt_number: 1,
                inference_idempotency_key: "inference:2:1".to_owned(),
            };
        }
        let mut source_scope = ToolSourceScope {
            source_checkpoint_id: pin.source_checkpoint_id.clone(),
            resource_ids: pin.scope_resource_ids.clone(),
            scope_sha256: pin.resource_scope_sha256.clone(),
        };
        if matches!(mutation, SeedMutation::LoopSourceScopeMismatch) {
            source_scope.source_checkpoint_id = "other-checkpoint".to_owned();
            source_scope.resource_ids = vec!["other-resource".to_owned()];
            source_scope.scope_sha256 = "e".repeat(64);
        }
        let mut permission = ToolPermissionPolicy {
            mode: pin.mode,
            policy_id: pin.tool_policy.id.clone(),
            policy_version: pin.tool_policy.version.clone(),
            policy_sha256: pin.tool_policy.sha256.clone(),
        };
        if matches!(mutation, SeedMutation::LoopPermissionMismatch) {
            permission.policy_id = "other-tool-policy".to_owned();
            permission.policy_sha256 = "f".repeat(64);
        }
        let identity = AgentLoopIdentity {
            run_id,
            project_id: if matches!(mutation, SeedMutation::LoopProjectMismatch) {
                "other-project".to_owned()
            } else {
                PROJECT_ID.to_owned()
            },
            invocation_id: invocation_id.clone(),
            initial_context_compilation_id: initial_receipt.compilation_id,
            source_scope,
            permission,
        };
        let mut loop_service = if matches!(mutation, SeedMutation::ForgedContinuationOrigin) {
            continuation_loop(identity, initial_dispatch.clone(), current_dispatch.clone())
        } else {
            AgentLoopService::new(identity, loop_policy(), initial_dispatch.clone()).unwrap()
        };
        if !matches!(mutation, SeedMutation::NoLoop) {
            AgentLoopJournalRepository::new(&mut journal)
                .create(&loop_service, "loop-created", loop_metadata("loop-created"))
                .unwrap();
            if matches!(kind, SeedKind::Continuation)
                && !matches!(mutation, SeedMutation::ForgedContinuationOrigin)
            {
                advance_loop_to_continuation(
                    &mut journal,
                    &mut loop_service,
                    current_dispatch.clone(),
                    &provider,
                );
            }
        }

        let authoritative_request = ProviderInferenceRequest {
            compilation: current_receipt.clone(),
            messages: vec![novelx_runtime::provider_gateway::ProviderInferenceMessage {
                role: novelx_runtime::provider_gateway::ProviderInferenceRole::System,
                content: "可靠小说管家".to_owned(),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            tools: vec![],
        };
        let prepared = gateway
            .prepare_inference(providers.resolve(&provider).unwrap(), authoritative_request)
            .unwrap();
        let mut attempt_id = current_dispatch.attempt_id;
        let mut attempt_number = 1;
        let mut idempotency_key = current_dispatch.inference_idempotency_key.clone();
        let mut attempt_created_at = now_string();
        if matches!(
            kind,
            SeedKind::RetryReady | SeedKind::RetryFuture | SeedKind::RetryExpired
        ) {
            let parent_requested_at = if matches!(kind, SeedKind::RetryExpired) {
                OffsetDateTime::now_utc() - Duration::minutes(7)
            } else {
                OffsetDateTime::now_utc() - Duration::seconds(3)
            };
            let parent_sent_at = parent_requested_at + Duration::milliseconds(100);
            let parent_failed_at = parent_requested_at + Duration::milliseconds(200);
            let scheduled_at = if matches!(kind, SeedKind::RetryFuture) {
                OffsetDateTime::now_utc() + Duration::minutes(2)
            } else if matches!(kind, SeedKind::RetryExpired) {
                OffsetDateTime::now_utc() - Duration::minutes(6)
            } else {
                OffsetDateTime::now_utc() - Duration::seconds(1)
            };
            let parent_failure = retryable_failure();
            let mut failure = if matches!(mutation, SeedMutation::RetryMissingParent) {
                ProviderRetryFailureObservation {
                    attempt_id: current_dispatch.attempt_id,
                    attempt_number: 1,
                    attempt_aggregate_sequence: 3,
                    attempt_definition_sha256: "a".repeat(64),
                    evidence_sha256: "b".repeat(64),
                    failure: parent_failure,
                    observed_at: format_time_value(parent_failed_at),
                }
            } else {
                let parent_definition = attempt_definition(
                    &run_id,
                    &invocation_id,
                    current_dispatch.inference_id,
                    &provider,
                    &current_receipt,
                    prepared.transport_payload_sha256(),
                    1,
                );
                let sequence = current_run_sequence(&journal, &run_id.to_string());
                let mut parent_attempt = ProviderAttemptAggregate::create(
                    &mut journal,
                    &run_id.to_string(),
                    &current_dispatch.attempt_id.to_string(),
                    parent_definition,
                    sequence,
                    attempt_metadata(
                        "parent-attempt-requested",
                        &current_dispatch.inference_idempotency_key,
                        &format_time_value(parent_requested_at),
                    ),
                )
                .unwrap();
                let sequence = current_run_sequence(&journal, &run_id.to_string());
                parent_attempt
                    .mark_sent(
                        &mut journal,
                        sequence,
                        "parent-legacy-dispatch",
                        attempt_metadata(
                            "parent-attempt-sent",
                            "parent-attempt-sent",
                            &format_time_value(parent_sent_at),
                        ),
                    )
                    .unwrap();
                let sequence = current_run_sequence(&journal, &run_id.to_string());
                parent_attempt
                    .fail(
                        &mut journal,
                        sequence,
                        parent_failure.clone(),
                        attempt_metadata(
                            "parent-attempt-failed",
                            "parent-attempt-failed",
                            &format_time_value(parent_failed_at),
                        ),
                    )
                    .unwrap();
                ProviderRetryFailureObservation {
                    attempt_id: current_dispatch.attempt_id,
                    attempt_number: 1,
                    attempt_aggregate_sequence: parent_attempt.aggregate_sequence(),
                    attempt_definition_sha256: provider_attempt_definition_sha256(&parent_attempt)
                        .unwrap(),
                    evidence_sha256: provider_attempt_evidence_sha256(&parent_attempt).unwrap(),
                    failure: parent_failure,
                    observed_at: format_time_value(parent_failed_at),
                }
            };
            if matches!(mutation, SeedMutation::RetryObservationMismatch) {
                failure.evidence_sha256 = "b".repeat(64);
            }
            let mut retry_definition = retry_definition(
                &run_id,
                &invocation_id,
                current_dispatch.inference_id,
                current_dispatch.attempt_id,
                &provider,
                &current_receipt,
                prepared.transport_payload_sha256(),
            );
            let retry_started_at = parent_requested_at - Duration::seconds(1);
            retry_definition.started_at = format_time_value(retry_started_at);
            retry_definition.deadline_at =
                format_time_value(retry_started_at + Duration::milliseconds(300_000));
            let sequence = current_run_sequence(&journal, &run_id.to_string());
            let mut retry = ProviderRetryAggregate::create(
                &mut journal,
                retry_definition.clone(),
                failure.clone(),
                sequence,
                retry_metadata("retry-created", &failure.observed_at),
            )
            .unwrap();
            let schedule = derive_retry_schedule(
                &retry_definition,
                &failure,
                0,
                &format_time_value(scheduled_at),
            )
            .unwrap();
            let at = schedule.not_before.clone();
            let sequence = current_run_sequence(&journal, &run_id.to_string());
            retry
                .schedule_retry(
                    &mut journal,
                    schedule.clone(),
                    sequence,
                    retry_metadata("retry-scheduled", &at),
                )
                .unwrap();
            let sequence = current_run_sequence(&journal, &run_id.to_string());
            retry
                .begin_materializing(
                    &mut journal,
                    &at,
                    sequence,
                    retry_metadata("retry-materializing", &at),
                )
                .unwrap();
            let sequence = current_run_sequence(&journal, &run_id.to_string());
            retry
                .mark_awaiting_attempt(
                    &mut journal,
                    &at,
                    sequence,
                    retry_metadata("retry-awaiting", &at),
                )
                .unwrap();
            let binding = ProviderRetryBinding {
                schedule_id: schedule.schedule_id.to_string(),
                schedule_sha256: schedule.schedule_sha256.clone(),
                parent_attempt_evidence_sha256: schedule.parent_failure_evidence_sha256.clone(),
                previous_attempt_id: current_dispatch.attempt_id,
                previous_attempt_number: 1,
                next: InferenceDispatchIdentity {
                    inference_id: current_dispatch.inference_id,
                    attempt_id: schedule.next_attempt_id,
                    request_number,
                    context_compilation_id: current_receipt.compilation_id,
                    attempt_number: schedule.next_attempt_number,
                    inference_idempotency_key: "inference:1:retry:2".to_owned(),
                },
            };
            let previous = loop_service.clone();
            loop_service.acknowledge_inference_retry(&binding).unwrap();
            AgentLoopJournalRepository::new(&mut journal)
                .append_inference_retried(
                    &previous,
                    &loop_service,
                    &binding,
                    "loop-retried",
                    loop_metadata("loop-retried"),
                )
                .unwrap();
            attempt_id = schedule.next_attempt_id;
            attempt_number = schedule.next_attempt_number;
            idempotency_key = binding.next.inference_idempotency_key;
            attempt_created_at = at;
        }
        let transport_payload_sha256 = if matches!(mutation, SeedMutation::TamperedPayloadHash) {
            "0".repeat(64)
        } else {
            prepared.transport_payload_sha256().to_owned()
        };
        let canonical_context_sha256 = if matches!(mutation, SeedMutation::TamperedContextHash) {
            "1".repeat(64)
        } else {
            current_receipt.canonical_context_sha256.clone()
        };
        let mut definition = attempt_definition(
            &run_id,
            &invocation_id,
            current_dispatch.inference_id,
            &provider,
            &current_receipt,
            &transport_payload_sha256,
            attempt_number,
        );
        definition.canonical_context_sha256 = canonical_context_sha256;
        let sequence = current_run_sequence(&journal, &run_id.to_string());
        let mut attempt = ProviderAttemptAggregate::create(
            &mut journal,
            &run_id.to_string(),
            &attempt_id.to_string(),
            definition,
            sequence,
            attempt_metadata("attempt-requested", &idempotency_key, &attempt_created_at),
        )
        .unwrap();
        if matches!(mutation, SeedMutation::LegacySent) {
            let sequence = current_run_sequence(&journal, &run_id.to_string());
            attempt
                .mark_sent(
                    &mut journal,
                    sequence,
                    "legacy-dispatch",
                    attempt_metadata("attempt-sent", "attempt-sent", &attempt_created_at),
                )
                .unwrap();
        }
        drop(journal);
        let lease =
            Arc::new(WorkspaceRuntimeLease::acquire(&self.database, "live-authorizer").unwrap());
        Seeded {
            request: ProviderLiveEffectAuthorizationRequest {
                run_id,
                invocation_id,
                attempt_id,
            },
            providers,
            gateway,
            lease,
        }
    }
}

fn continuation_loop(
    identity: AgentLoopIdentity,
    initial_dispatch: InferenceDispatchIdentity,
    continuation_dispatch: InferenceDispatchIdentity,
) -> AgentLoopService {
    let initial = AgentLoopService::new(identity, loop_policy(), initial_dispatch).unwrap();
    let mut checkpoint = initial.checkpoint().unwrap();
    checkpoint["expectedRequestNumber"] = serde_json::json!(continuation_dispatch.request_number);
    checkpoint["expectedContextCompilationId"] =
        serde_json::json!(continuation_dispatch.context_compilation_id);
    checkpoint["pendingInference"] = serde_json::to_value(continuation_dispatch).unwrap();
    AgentLoopService::restore(checkpoint).unwrap()
}

fn advance_loop_to_continuation(
    journal: &mut EventJournal,
    loop_service: &mut AgentLoopService,
    next_dispatch: InferenceDispatchIdentity,
    provider: &ProviderRunIdentity,
) {
    let initial_dispatch = loop_service.pending_inference().unwrap().clone();
    let run_id = loop_service.identity().run_id;
    let call = provider_tool_call();
    let previous = loop_service.clone();
    let directive = loop_service
        .accept_provider_outcome(
            provider_completion(run_id, &initial_dispatch, provider, call.clone()),
            vec![materialized_tool_call(&call)],
        )
        .unwrap();
    AgentLoopJournalRepository::new(journal)
        .append_transition(
            &previous,
            loop_service,
            &directive,
            "loop-provider-completed",
            loop_metadata("loop-provider-completed"),
        )
        .unwrap();

    let previous = loop_service.clone();
    let directive = loop_service
        .accept_tool_results(vec![finalized_tool_result()])
        .unwrap();
    AgentLoopJournalRepository::new(journal)
        .append_transition(
            &previous,
            loop_service,
            &directive,
            "loop-tool-results",
            loop_metadata("loop-tool-results"),
        )
        .unwrap();

    let previous = loop_service.clone();
    let directive = loop_service
        .accept_context_compiled(next_dispatch.context_compilation_id)
        .unwrap();
    AgentLoopJournalRepository::new(journal)
        .append_transition(
            &previous,
            loop_service,
            &directive,
            "loop-context-compiled",
            loop_metadata("loop-context-compiled"),
        )
        .unwrap();

    let previous = loop_service.clone();
    loop_service
        .acknowledge_inference_started(next_dispatch)
        .unwrap();
    let started_at = now_string();
    AgentLoopJournalRepository::new(journal)
        .append_inference_started(
            &previous,
            loop_service,
            "loop-inference-started",
            AgentLoopEventMetadata {
                message_id: "loop-inference-started",
                created_at: &started_at,
            },
        )
        .unwrap();
}

fn provider_completion(
    run_id: Uuid,
    dispatch: &InferenceDispatchIdentity,
    provider: &ProviderRunIdentity,
    call: ProviderInferenceToolCall,
) -> ProviderInferenceCompleted {
    ProviderInferenceCompleted {
        identity: ProviderInferenceIdentity {
            run_id,
            inference_id: dispatch.inference_id,
            attempt_id: dispatch.attempt_id,
            context_compilation_id: dispatch.context_compilation_id,
            request_number: dispatch.request_number,
            attempt_number: u64::from(dispatch.attempt_number),
        },
        provider_id: provider.provider_id.clone(),
        model_id: provider.model_id.clone(),
        response_id_sha256: "c".repeat(64),
        response_body_sha256: "d".repeat(64),
        stop_reason: "tool_calls".to_owned(),
        usage: ProviderInferenceUsage {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
        },
        output: None,
        tool_calls: vec![call],
    }
}

fn provider_tool_call() -> ProviderInferenceToolCall {
    let arguments = serde_json::json!({"path": "world.md"});
    ProviderInferenceToolCall {
        id: "provider-call-1".to_owned(),
        name: "read_project_file".to_owned(),
        arguments_sha256: sha256(&serde_json::to_vec(&arguments).unwrap()),
        arguments,
    }
}

fn materialized_tool_call(call: &ProviderInferenceToolCall) -> MaterializedProviderToolCall {
    MaterializedProviderToolCall {
        tool_call_id: Uuid::new_v4(),
        provider_tool_call_id: call.id.clone(),
        tool_name: call.name.clone(),
        arguments: ToolArtifactReceipt {
            artifact_id: Uuid::new_v4(),
            media_type: "application/json".to_owned(),
            sha256: call.arguments_sha256.clone(),
            utf8_bytes: 32,
        },
    }
}

fn finalized_tool_result() -> FinalizedToolResult {
    let content = serde_json::json!({"content": "world material", "complete": true});
    FinalizedToolResult {
        provider_tool_call_id: "provider-call-1".to_owned(),
        tool_name: "read_project_file".to_owned(),
        content_sha256: sha256(&serde_json::to_vec(&content).unwrap()),
        content,
        is_error: false,
    }
}

fn context_command(
    request_number: u64,
    invocation_id: &str,
    provider: ProviderRunIdentity,
    context_policy: novelx_protocol::VersionedPolicyIdentity,
) -> ContextCompile {
    let system = "可靠小说管家";
    ContextCompile {
        compile_idempotency_key: format!("context:{request_number}"),
        invocation_id: invocation_id.to_owned(),
        request_number,
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

fn retry_definition(
    run_id: &Uuid,
    invocation_id: &str,
    inference_id: Uuid,
    first_attempt_id: Uuid,
    provider: &ProviderRunIdentity,
    receipt: &novelx_protocol::ContextCompilationReceipt,
    transport_payload_sha256: &str,
) -> ProviderRetryDefinition {
    let policy = ExponentialFullJitterPolicy {
        algorithm: ProviderRetryPolicyAlgorithm::ExponentialFullJitterV1,
        initial_delay_ms: 1,
        max_delay_ms: 1,
        max_attempts: 2,
        max_total_delay_ms: 1_000,
    };
    ProviderRetryDefinition {
        run_id: run_id.to_string(),
        invocation_id: invocation_id.to_owned(),
        inference_id: inference_id.to_string(),
        request_number: receipt.request_number,
        context_compilation_id: receipt.compilation_id,
        provider: provider.clone(),
        canonical_context_sha256: receipt.canonical_context_sha256.clone(),
        transport_payload_sha256: transport_payload_sha256.to_owned(),
        first_attempt_id,
        first_attempt_number: 1,
        started_at: format_time_value(OffsetDateTime::now_utc() - Duration::seconds(5)),
        deadline_at: format_time_value(OffsetDateTime::now_utc() + Duration::minutes(5)),
        request_timeout_ms: 30_000,
        total_deadline_ms: 300_000,
        policy_sha256: provider_retry_policy_sha256(&policy).unwrap(),
        policy,
    }
}

fn attempt_definition(
    run_id: &Uuid,
    invocation_id: &str,
    inference_id: Uuid,
    provider: &ProviderRunIdentity,
    receipt: &novelx_protocol::ContextCompilationReceipt,
    transport_payload_sha256: &str,
    attempt_number: u16,
) -> ProviderAttemptDefinition {
    ProviderAttemptDefinition {
        run_id: run_id.to_string(),
        inference_id: inference_id.to_string(),
        invocation_id: invocation_id.to_owned(),
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

fn retryable_failure() -> ProviderAttemptFailure {
    ProviderAttemptFailure {
        code: "PROVIDER_HTTP_RETRYABLE".to_owned(),
        retryable: true,
        retry_after_ms: None,
        retry_after: None,
        http_status: Some(500),
        delivery_certainty: ProviderDeliveryCertainty::ResponseReceived,
        diagnostic_id: Uuid::new_v4(),
    }
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
    message: &'a str,
    key: &'a str,
    created_at: &'a str,
) -> ProviderAttemptMetadata<'a> {
    ProviderAttemptMetadata {
        message_id: message,
        idempotency_key: key,
        created_at,
        reason: None,
    }
}

fn retry_metadata<'a>(message: &'a str, created_at: &'a str) -> ProviderRetryMetadata<'a> {
    ProviderRetryMetadata {
        message_id: message,
        idempotency_key: message,
        created_at,
    }
}

fn current_run_sequence(journal: &EventJournal, run_id: &str) -> u64 {
    journal
        .read_run(run_id, 0)
        .unwrap()
        .last()
        .map_or(0, |event| event.run_sequence)
}

fn now_string() -> String {
    format_time_value(OffsetDateTime::now_utc())
}

fn format_time_value(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).unwrap()
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
