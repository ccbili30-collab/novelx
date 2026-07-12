mod support;

use std::sync::{Arc, Mutex};

use novelx_protocol::{
    ContextCompile, ContextDisclosure, ContextItem, ContextMessageRole, ProviderRunIdentity,
    RunPermissionMode, RunPrepare, RunStart, ToolAuthorizationResolutionDecision,
    ToolAuthorizationResolve,
};
use novelx_runtime::{
    agent_loop_service::AgentLoopPolicy,
    context_compile_service::ContextCompileService,
    event_journal::EventJournal,
    live_agent_loop_runner::{
        LiveAgentLoopError, LiveAgentLoopOutcome, LiveAgentLoopProgress, LiveAgentLoopRunner,
    },
    project_path::ProjectRoot,
    project_tool_execution_service::ProjectToolExecutionService,
    provider_gateway::{
        ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderGateway,
        ProviderInferenceRequest, ProviderInputCapability, ProviderRegistry, ProviderRetryPolicy,
        provider_config_sha256,
    },
    provider_inference_service::ProviderInferenceExecution,
    run_aggregate::{EventMetadata, RunAggregate},
    run_command_service::{RunCommandService, WorkspaceBinding},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

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
            || false,
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
            || false,
        )
        .await;
    assert!(matches!(interrupted, Err(LiveAgentLoopError::Progress(_))));

    let resumed = runner
        .resume_awaiting_provider(run_id, invocation_id, |_| async { Ok(()) }, || false)
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
    let waiting = runner
        .run(execution, None, |_| async { Ok(()) }, || false)
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
        .resume_after_assist(run_id, invocation_id, |_| async { Ok(()) }, || false)
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
        .resume_after_assist(run_id, invocation_id, |_| async { Ok(()) }, || false)
        .await
        .unwrap();
    assert!(
        matches!(completed, LiveAgentLoopOutcome::Completed { ref output, .. } if output == "银湾资料核对完成。")
    );
    server.await.unwrap();
}

struct Fixture {
    _temp: tempfile::TempDir,
    project: tempfile::TempDir,
    database: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let database = temp.path().join("runtime.db");
        Self {
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
