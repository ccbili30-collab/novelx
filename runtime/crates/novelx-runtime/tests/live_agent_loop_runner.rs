mod support;

use std::sync::{Arc, Mutex};

use novelx_protocol::{
    ContextCompile, ContextDisclosure, ContextItem, ContextMessageRole, ProviderRunIdentity,
    RunPermissionMode, RunPrepare, RunStart, ToolAuthorizationResolutionDecision,
    ToolAuthorizationResolve,
};
use novelx_runtime::{
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity, LoopPhase,
    },
    context_compile_service::ContextCompileService,
    event_journal::EventJournal,
    live_agent_loop_runner::{
        LiveAgentLoopError, LiveAgentLoopOutcome, LiveAgentLoopProgress, LiveAgentLoopRunner,
    },
    project_path::ProjectRoot,
    project_tool_execution_service::ProjectToolExecutionService,
    provider_gateway::{
        ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderGateway,
        ProviderInferenceOutcome, ProviderInferenceReceipt, ProviderInferenceRequest,
        ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy, ProviderUsageReceipt,
        provider_config_sha256,
    },
    provider_inference_service::ProviderInferenceExecution,
    run_aggregate::{EventMetadata, RunAggregate},
    run_command_service::{RunCommandService, WorkspaceBinding},
    workspace_runtime_lease::WorkspaceRuntimeLease,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

#[test]
fn open_rejects_empty_workspace_identity() {
    let fixture = Fixture::new();
    let result = LiveAgentLoopRunner::open(
        &fixture.database,
        "   ".to_owned(),
        Arc::clone(&fixture.lease),
        ProjectRoot::open(fixture.project.path().to_str().unwrap()).unwrap(),
        "project-1".to_owned(),
        ProviderRegistry::default(),
        ProviderGateway::new().unwrap(),
        loop_policy(),
    );

    assert!(matches!(result, Err(LiveAgentLoopError::IdentityInvalid)));
}

#[test]
fn open_rejects_lease_for_a_different_database() {
    let fixture = Fixture::new();
    let other_directory = tempfile::tempdir().unwrap();
    let other_database = other_directory.path().join("other-runtime.db");
    let wrong_lease =
        Arc::new(WorkspaceRuntimeLease::acquire(&other_database, "wrong-database-lease").unwrap());
    let result = LiveAgentLoopRunner::open(
        &fixture.database,
        "workspace-1".to_owned(),
        wrong_lease,
        ProjectRoot::open(fixture.project.path().to_str().unwrap()).unwrap(),
        "project-1".to_owned(),
        ProviderRegistry::default(),
        ProviderGateway::new().unwrap(),
        loop_policy(),
    );

    assert!(matches!(
        result,
        Err(LiveAgentLoopError::WorkspaceLeaseInvalid)
    ));
}

#[test]
fn awaiting_provider_is_precreated_once_and_reused_after_restart() {
    let fixture = Fixture::new();
    let base_url = "http://127.0.0.1:9/v1".to_owned();
    let (providers, provider) = registry(base_url.clone());
    let (run_id, receipt) = fixture.seed(&providers, provider.clone(), RunPermissionMode::Free);
    let execution = execution(run_id, provider, receipt, "precreate-once");
    let runner = open_runner(&fixture, providers, "project-1");

    let first = runner.ensure_awaiting_provider(&execution).unwrap();
    assert_eq!(first.phase(), LoopPhase::AwaitingProvider);
    assert_eq!(first.pending_inference().unwrap().attempt_number, 1);
    let second = runner.ensure_awaiting_provider(&execution).unwrap();
    assert_eq!(first, second);
    assert_eq!(agent_loop_event_count(&fixture, &execution), 1);
    drop(runner);

    let (providers, _) = registry(base_url);
    let reopened = open_runner(&fixture, providers, "project-1");
    assert_eq!(
        reopened.ensure_awaiting_provider(&execution).unwrap(),
        first
    );
    assert_eq!(agent_loop_event_count(&fixture, &execution), 1);
}

#[test]
fn awaiting_provider_precreation_rejects_authority_and_dispatch_tampering() {
    let fixture = Fixture::new();
    let (providers, provider) = registry("http://127.0.0.1:9/v1".to_owned());
    let (run_id, receipt) = fixture.seed(&providers, provider.clone(), RunPermissionMode::Free);
    let execution = execution(run_id, provider, receipt, "tamper-check");
    let runner = open_runner(&fixture, providers, "project-1");
    runner.ensure_awaiting_provider(&execution).unwrap();

    let mut dispatch_tampered = execution.clone();
    dispatch_tampered.attempt_id = Uuid::new_v4().to_string();
    assert!(matches!(
        runner.ensure_awaiting_provider(&dispatch_tampered),
        Err(LiveAgentLoopError::ResumeStateInvalid)
    ));

    let mut context_tampered = execution.clone();
    context_tampered
        .request
        .compilation
        .canonical_context_sha256 = "0".repeat(64);
    assert!(matches!(
        runner.ensure_awaiting_provider(&context_tampered),
        Err(LiveAgentLoopError::IdentityInvalid)
    ));

    let mut invocation_tampered = execution.clone();
    invocation_tampered.invocation_id = "other-agent".to_owned();
    assert!(matches!(
        runner.ensure_awaiting_provider(&invocation_tampered),
        Err(LiveAgentLoopError::IdentityInvalid)
    ));

    let mut provider_tampered = execution.clone();
    provider_tampered.provider.model_id = "other-model".to_owned();
    assert!(matches!(
        runner.ensure_awaiting_provider(&provider_tampered),
        Err(LiveAgentLoopError::IdentityInvalid)
    ));

    let (other_project_providers, _) = registry("http://127.0.0.1:9/v1".to_owned());
    let other_project_runner = open_runner(&fixture, other_project_providers, "other-project");
    assert!(matches!(
        other_project_runner.ensure_awaiting_provider(&execution),
        Err(LiveAgentLoopError::IdentityInvalid)
    ));
    assert_eq!(agent_loop_event_count(&fixture, &execution), 1);
}

#[test]
fn awaiting_provider_rejects_persisted_source_scope_and_permission_tampering() {
    for tamper in ["source", "permission"] {
        let fixture = Fixture::new();
        let (providers, provider) = registry("http://127.0.0.1:9/v1".to_owned());
        let (run_id, receipt) = fixture.seed(&providers, provider.clone(), RunPermissionMode::Free);
        let execution = execution(run_id, provider, receipt, &format!("tamper-{tamper}"));
        let mut journal = EventJournal::open(&fixture.database).unwrap();
        let run = RunAggregate::recover(&journal, &execution.run_id).unwrap();
        let pinned = run.pinned_identity();
        let mut identity = AgentLoopIdentity {
            run_id,
            project_id: pinned.project_id.clone(),
            invocation_id: execution.invocation_id.clone(),
            initial_context_compilation_id: execution.request.compilation.compilation_id,
            source_scope: novelx_protocol::ToolSourceScope {
                source_checkpoint_id: pinned.source_checkpoint_id.clone(),
                resource_ids: pinned.scope_resource_ids.clone(),
                scope_sha256: pinned.resource_scope_sha256.clone(),
            },
            permission: novelx_protocol::ToolPermissionPolicy {
                mode: pinned.mode,
                policy_id: pinned.tool_policy.id.clone(),
                policy_version: pinned.tool_policy.version.clone(),
                policy_sha256: pinned.tool_policy.sha256.clone(),
            },
        };
        match tamper {
            "source" => identity.source_scope.source_checkpoint_id = "forged-checkpoint".to_owned(),
            "permission" => identity.permission.policy_sha256 = "0".repeat(64),
            _ => unreachable!(),
        }
        let dispatch = InferenceDispatchIdentity {
            inference_id: Uuid::parse_str(&execution.inference_id).unwrap(),
            attempt_id: Uuid::parse_str(&execution.attempt_id).unwrap(),
            request_number: execution.request.compilation.request_number,
            context_compilation_id: execution.request.compilation.compilation_id,
            attempt_number: execution.attempt_number,
            inference_idempotency_key: execution.inference_idempotency_key.clone(),
        };
        let forged = AgentLoopService::new(identity, loop_policy(), dispatch).unwrap();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &forged,
                &format!("forged-{tamper}"),
                AgentLoopEventMetadata {
                    message_id: "forged-message",
                    created_at: "2026-07-13T00:00:00Z",
                },
            )
            .unwrap();
        drop(journal);

        let runner = open_runner(&fixture, providers, "project-1");
        assert!(matches!(
            runner.ensure_awaiting_provider(&execution),
            Err(LiveAgentLoopError::ResumeStateInvalid)
        ));
        assert_eq!(agent_loop_event_count(&fixture, &execution), 1);
    }
}

#[tokio::test]
async fn precreated_loop_accepts_a_text_outcome_and_persists_completed() {
    let fixture = Fixture::new();
    let (providers, provider) = registry("http://127.0.0.1:9/v1".to_owned());
    let (run_id, receipt) = fixture.seed(&providers, provider.clone(), RunPermissionMode::Free);
    let execution = execution(run_id, provider, receipt, "precreated-text");
    let runner = open_runner(&fixture, providers, "project-1");
    runner.ensure_awaiting_provider(&execution).unwrap();
    let (_cancel_tx, mut cancellation) = tokio::sync::watch::channel(false);

    let outcome = runner
        .run(
            execution.clone(),
            Some(text_outcome(&execution, "正文完成")),
            |_| async { Ok(()) },
            &mut cancellation,
        )
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        LiveAgentLoopOutcome::Completed { ref output, rounds: 0, .. } if output == "正文完成"
    ));
    let mut journal = EventJournal::open(&fixture.database).unwrap();
    let persisted = AgentLoopJournalRepository::new(&mut journal)
        .recover(&execution.run_id, &execution.invocation_id)
        .unwrap();
    assert_eq!(persisted.service.phase(), LoopPhase::Completed);
    assert_eq!(persisted.aggregate_sequence, 2);
    drop(journal);
    assert!(matches!(
        runner.ensure_awaiting_provider(&execution),
        Err(LiveAgentLoopError::ResumeStateInvalid)
    ));
}

#[tokio::test]
async fn free_live_loop_executes_read_and_stat_then_sends_results_to_second_inference() {
    let fixture = Fixture::new();
    std::fs::write(fixture.project.path().join("世界.md"), "银湾海岸向北延伸。").unwrap();
    let (base_url, bodies, server) = spawn_two_round_server().await;
    let (providers, provider) = registry(base_url);
    let (run_id, receipt) = fixture.seed(&providers, provider.clone(), RunPermissionMode::Free);
    let execution = ProviderInferenceExecution {
        run_id: run_id.to_string(),
        attempt_id: Uuid::new_v4().to_string(),
        inference_id: Uuid::new_v4().to_string(),
        invocation_id: "steward-1".to_owned(),
        inference_idempotency_key: "live-loop-1".to_owned(),
        attempt_number: 1,
        provider,
        request: ProviderInferenceRequest {
            compilation: receipt,
            messages: vec![],
            tools: vec![],
        },
    };
    let runner = LiveAgentLoopRunner::open(
        &fixture.database,
        "workspace-1".to_owned(),
        Arc::clone(&fixture.lease),
        ProjectRoot::open(fixture.project.path().to_str().unwrap()).unwrap(),
        "project-1".to_owned(),
        providers,
        ProviderGateway::new().unwrap(),
        AgentLoopPolicy {
            maximum_tool_rounds: 4,
            tool_schema_version: 1,
        },
    )
    .unwrap();

    let progress = Arc::new(Mutex::new(Vec::new()));
    let captured_progress = Arc::clone(&progress);
    let (_cancel_tx, mut cancellation) = tokio::sync::watch::channel(false);
    let outcome = runner
        .run(
            execution,
            None,
            move |event| {
                let captured_progress = Arc::clone(&captured_progress);
                async move {
                    captured_progress.lock().unwrap().push(event);
                    Ok(())
                }
            },
            &mut cancellation,
        )
        .await
        .unwrap();

    assert!(matches!(
        outcome,
        LiveAgentLoopOutcome::Completed { ref output, rounds: 1, .. }
            if output == "银湾资料核对完成。"
    ));
    assert_eq!(
        progress
            .lock()
            .unwrap()
            .iter()
            .map(|event| match event {
                LiveAgentLoopProgress::ProviderCompleted(_) => "provider",
                LiveAgentLoopProgress::ToolsCompleted { .. } => "tools",
                LiveAgentLoopProgress::ContextCompiled(_) => "context",
                LiveAgentLoopProgress::InferenceStarted(_) => "inference",
                LiveAgentLoopProgress::Completed(_) => "completed",
                LiveAgentLoopProgress::AwaitingApproval { .. } => "approval",
                LiveAgentLoopProgress::Cancelled(_) => "cancelled",
            })
            .collect::<Vec<_>>(),
        vec![
            "provider",
            "tools",
            "context",
            "inference",
            "provider",
            "completed"
        ]
    );
    assert_eq!(
        progress
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                LiveAgentLoopProgress::ProviderCompleted(completion) => {
                    Some(completion.identity.request_number)
                }
                _ => None,
            })
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    server.await.unwrap();
    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2);
    assert!(bodies[1].contains("provider-read-1"));
    assert!(bodies[1].contains("provider-stat-1"));
    assert!(bodies[1].contains("银湾海岸向北延伸"));
    assert!(bodies[1].contains("tool"));
}

#[tokio::test]
async fn awaiting_provider_resume_reuses_the_persisted_dispatch_identity() {
    let fixture = Fixture::new();
    std::fs::write(fixture.project.path().join("世界.md"), "银湾海岸向北延伸。").unwrap();
    let (base_url, bodies, server) = spawn_two_round_server().await;
    let (providers, provider) = registry(base_url);
    let (run_id, receipt) = fixture.seed(&providers, provider.clone(), RunPermissionMode::Free);
    let invocation_id = "steward-1";
    let execution = ProviderInferenceExecution {
        run_id: run_id.to_string(),
        attempt_id: Uuid::new_v4().to_string(),
        inference_id: Uuid::new_v4().to_string(),
        invocation_id: invocation_id.to_owned(),
        inference_idempotency_key: "resume-dispatch-1".to_owned(),
        attempt_number: 1,
        provider,
        request: ProviderInferenceRequest {
            compilation: receipt,
            messages: vec![],
            tools: vec![],
        },
    };
    let runner = LiveAgentLoopRunner::open(
        &fixture.database,
        "workspace-1".to_owned(),
        Arc::clone(&fixture.lease),
        ProjectRoot::open(fixture.project.path().to_str().unwrap()).unwrap(),
        "project-1".to_owned(),
        providers,
        ProviderGateway::new().unwrap(),
        AgentLoopPolicy {
            maximum_tool_rounds: 4,
            tool_schema_version: 1,
        },
    )
    .unwrap();
    let (_cancel_tx, mut cancellation) = tokio::sync::watch::channel(false);

    let interrupted = runner
        .run(
            execution,
            None,
            |event| async move {
                if matches!(event, LiveAgentLoopProgress::InferenceStarted(_)) {
                    return Err(LiveAgentLoopError::Progress(
                        "simulated process interruption".to_owned(),
                    ));
                }
                Ok(())
            },
            &mut cancellation,
        )
        .await;
    assert!(matches!(interrupted, Err(LiveAgentLoopError::Progress(_))));

    let resumed = runner
        .resume_awaiting_provider(
            run_id,
            invocation_id,
            |_| async { Ok(()) },
            &mut cancellation,
        )
        .await
        .unwrap();
    assert!(
        matches!(resumed, LiveAgentLoopOutcome::Completed { ref output, .. } if output == "银湾资料核对完成。")
    );
    server.await.unwrap();
    assert_eq!(bodies.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn assist_resume_waits_for_all_decisions_then_completes_second_provider_round() {
    let fixture = Fixture::new();
    std::fs::write(fixture.project.path().join("世界.md"), "银湾海岸向北延伸。").unwrap();
    let (base_url, _, server) = spawn_two_round_server().await;
    let (providers, provider) = registry(base_url);
    let (run_id, receipt) = fixture.seed(&providers, provider.clone(), RunPermissionMode::Assist);
    let invocation_id = "steward-1";
    let execution = ProviderInferenceExecution {
        run_id: run_id.to_string(),
        attempt_id: Uuid::new_v4().to_string(),
        inference_id: Uuid::new_v4().to_string(),
        invocation_id: invocation_id.to_owned(),
        inference_idempotency_key: "assist-live-1".to_owned(),
        attempt_number: 1,
        provider,
        request: ProviderInferenceRequest {
            compilation: receipt,
            messages: vec![],
            tools: vec![],
        },
    };
    let root = ProjectRoot::open(fixture.project.path().to_str().unwrap()).unwrap();
    let runner = LiveAgentLoopRunner::open(
        &fixture.database,
        "workspace-1".to_owned(),
        Arc::clone(&fixture.lease),
        root.clone(),
        "project-1".to_owned(),
        providers,
        ProviderGateway::new().unwrap(),
        AgentLoopPolicy {
            maximum_tool_rounds: 4,
            tool_schema_version: 1,
        },
    )
    .unwrap();
    let (_cancel_tx, mut cancellation) = tokio::sync::watch::channel(false);
    let waiting = runner
        .run(execution, None, |_| async { Ok(()) }, &mut cancellation)
        .await
        .unwrap();
    let LiveAgentLoopOutcome::AwaitingApproval {
        completion,
        tool_call_ids,
        ..
    } = waiting
    else {
        panic!("Assist must wait for approval")
    };
    assert_eq!(tool_call_ids.len(), 2);
    let tools =
        ProjectToolExecutionService::open(&fixture.database, root, "project-1".to_owned()).unwrap();
    tools
        .resolve_assist_and_execute(
            &run_id.to_string(),
            invocation_id,
            &completion.identity.inference_id.to_string(),
            &completion.tool_calls[0],
            &ToolAuthorizationResolve {
                authorization_idempotency_key: "approve-read".to_owned(),
                tool_call_id: tool_call_ids[0],
                decision: ToolAuthorizationResolutionDecision::Approve,
            },
            "2026-07-12T00:01:00Z",
        )
        .await
        .unwrap();

    let still_waiting = runner
        .resume_after_assist(
            run_id,
            invocation_id,
            |_| async { Ok(()) },
            &mut cancellation,
        )
        .await
        .unwrap();
    assert!(matches!(
        still_waiting,
        LiveAgentLoopOutcome::AwaitingApproval { .. }
    ));

    tools
        .resolve_assist_and_execute(
            &run_id.to_string(),
            invocation_id,
            &completion.identity.inference_id.to_string(),
            &completion.tool_calls[1],
            &ToolAuthorizationResolve {
                authorization_idempotency_key: "approve-stat".to_owned(),
                tool_call_id: tool_call_ids[1],
                decision: ToolAuthorizationResolutionDecision::Approve,
            },
            "2026-07-12T00:02:00Z",
        )
        .await
        .unwrap();
    let completed = runner
        .resume_after_assist(
            run_id,
            invocation_id,
            |_| async { Ok(()) },
            &mut cancellation,
        )
        .await
        .unwrap();
    assert!(
        matches!(completed, LiveAgentLoopOutcome::Completed { ref output, .. } if output == "银湾资料核对完成。")
    );
    server.await.unwrap();
}

fn open_runner(
    fixture: &Fixture,
    providers: ProviderRegistry,
    project_id: &str,
) -> LiveAgentLoopRunner {
    LiveAgentLoopRunner::open(
        &fixture.database,
        "workspace-1".to_owned(),
        Arc::clone(&fixture.lease),
        ProjectRoot::open(fixture.project.path().to_str().unwrap()).unwrap(),
        project_id.to_owned(),
        providers,
        ProviderGateway::new().unwrap(),
        loop_policy(),
    )
    .unwrap()
}

const fn loop_policy() -> AgentLoopPolicy {
    AgentLoopPolicy {
        maximum_tool_rounds: 4,
        tool_schema_version: 1,
    }
}

fn execution(
    run_id: Uuid,
    provider: ProviderRunIdentity,
    receipt: novelx_protocol::ContextCompilationReceipt,
    idempotency_key: &str,
) -> ProviderInferenceExecution {
    ProviderInferenceExecution {
        run_id: run_id.to_string(),
        attempt_id: Uuid::new_v4().to_string(),
        inference_id: Uuid::new_v4().to_string(),
        invocation_id: "steward-1".to_owned(),
        inference_idempotency_key: idempotency_key.to_owned(),
        attempt_number: 1,
        provider,
        request: ProviderInferenceRequest {
            compilation: receipt,
            messages: vec![],
            tools: vec![],
        },
    }
}

fn agent_loop_event_count(fixture: &Fixture, execution: &ProviderInferenceExecution) -> usize {
    EventJournal::open(&fixture.database)
        .unwrap()
        .read_aggregate(&execution.run_id, "agent_loop", &execution.invocation_id, 0)
        .unwrap()
        .len()
}

fn text_outcome(execution: &ProviderInferenceExecution, text: &str) -> ProviderInferenceOutcome {
    ProviderInferenceOutcome {
        text: Some(text.to_owned()),
        tool_calls: vec![],
        receipt: ProviderInferenceReceipt {
            context_compilation_id: execution.request.compilation.compilation_id,
            canonical_context_sha256: execution
                .request
                .compilation
                .canonical_context_sha256
                .clone(),
            requested_model_id: execution.provider.model_id.clone(),
            actual_model_id: execution.provider.model_id.clone(),
            response_id_sha256: "c".repeat(64),
            response_body_sha256: "d".repeat(64),
            finish_reason: "stop".to_owned(),
            usage: ProviderUsageReceipt {
                input_tokens: 10,
                output_tokens: 2,
                total_tokens: 12,
            },
            provider_request_count: 1,
        },
    }
}

struct Fixture {
    lease: Arc<WorkspaceRuntimeLease>,
    _temp: tempfile::TempDir,
    project: tempfile::TempDir,
    database: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let database = temp.path().join("runtime.db");
        let lease = Arc::new(
            WorkspaceRuntimeLease::acquire(&database, format!("live-loop-{}", Uuid::new_v4()))
                .unwrap(),
        );
        Self {
            lease,
            _temp: temp,
            project,
            database,
        }
    }

    fn seed(
        &self,
        providers: &ProviderRegistry,
        provider: ProviderRunIdentity,
        mode: RunPermissionMode,
    ) -> (Uuid, novelx_protocol::ContextCompilationReceipt) {
        let run_id = Uuid::new_v4();
        let mut identity = pinned_identity();
        identity.provider = provider.clone();
        identity.mode = mode;
        let mut journal = Some(EventJournal::open(&self.database).unwrap());
        let binding = WorkspaceBinding {
            project_id: "project-1".to_owned(),
            workspace_id: "workspace-1".to_owned(),
        };
        let mut runs = RunCommandService::new(&mut journal, Some(&binding));
        runs.start(
            run_id,
            Uuid::new_v4(),
            RunStart {
                start_idempotency_key: "start-1".to_owned(),
                pinned_identity: identity.clone(),
            },
        )
        .unwrap();
        runs.prepare(
            run_id,
            Uuid::new_v4(),
            RunPrepare {
                prepare_idempotency_key: "prepare-1".to_owned(),
            },
            providers,
        )
        .unwrap();
        drop(journal);
        let mut journal = EventJournal::open(&self.database).unwrap();
        let mut run = RunAggregate::recover(&journal, &run_id.to_string()).unwrap();
        run.start(
            &mut journal,
            EventMetadata {
                message_id: "run-started",
                idempotency_key: "run-started",
                created_at: "2026-07-12T00:00:00Z",
                reason: None,
            },
        )
        .unwrap();
        let receipt = ContextCompileService::new(&mut journal, providers)
            .compile(
                run_id,
                Uuid::new_v4(),
                command(provider, identity.context_policy),
            )
            .unwrap();
        (run_id, receipt)
    }
}

fn command(
    provider: ProviderRunIdentity,
    context_policy: novelx_protocol::VersionedPolicyIdentity,
) -> ContextCompile {
    let system = "你是小说创作管家，必须先读取项目资料再回答。";
    let user = "读取世界.md，并检查文件状态。";
    ContextCompile {
        compile_idempotency_key: "base-context".to_owned(),
        invocation_id: "steward-1".to_owned(),
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
                content_sha256: sha(system.as_bytes()),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            ContextItem::SessionMessage {
                item_id: "user".to_owned(),
                message_id: "user-1".to_owned(),
                role: ContextMessageRole::User,
                content: user.to_owned(),
                content_sha256: sha(user.as_bytes()),
                created_at: "2026-07-12T00:00:00Z".to_owned(),
                disclosure: ContextDisclosure::ProjectPrivate,
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

fn registry(base_url: String) -> (ProviderRegistry, ProviderRunIdentity) {
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
        max_tokens: Some(2_000),
        reasoning: false,
        input: vec![ProviderInputCapability::Text],
        request_timeout_ms: 5_000,
        total_deadline_ms: 10_000,
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
    let mut providers = ProviderRegistry::default();
    providers
        .bind(config, &hash, "test-key".to_owned())
        .unwrap();
    (providers, identity)
}

async fn spawn_two_round_server() -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>)
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&bodies);
    let server = tokio::spawn(async move {
        for round in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 131_072];
            let length = socket.read(&mut request).await.unwrap();
            captured
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&request[..length]).into_owned());
            let body = if round == 0 {
                json!({
                    "id": "response-1", "model": "deepseek-chat",
                    "choices": [{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,
                        "tool_calls":[
                            {"id":"provider-read-1","type":"function","function":{"name":"read_project_file","arguments":"{\"path\":\"世界.md\"}"}},
                            {"id":"provider-stat-1","type":"function","function":{"name":"stat_project_file","arguments":"{\"path\":\"世界.md\"}"}}
                        ]}}],
                    "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
                }).to_string()
            } else {
                json!({
                    "id":"response-2","model":"deepseek-chat",
                    "choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"银湾资料核对完成。"}}],
                    "usage":{"prompt_tokens":30,"completion_tokens":8,"total_tokens":38}
                }).to_string()
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    (format!("http://{address}/v1"), bodies, server)
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
