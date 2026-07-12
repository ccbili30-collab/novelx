use novelx_protocol::{
    ProviderInferenceCompleted, ProviderInferenceIdentity, ProviderInferenceOutput,
    ProviderInferenceToolCall, ProviderInferenceUsage, RunPermissionMode, ToolArtifactReceipt,
    ToolPermissionPolicy, ToolSourceScope,
};
use novelx_runtime::agent_loop_service::{
    AgentLoopDirective, AgentLoopError, AgentLoopIdentity, AgentLoopPolicy, AgentLoopService,
    AssistToolDecision, FinalizedToolResult, LoopPhase,
};
use novelx_runtime::provider_tool_materializer::MaterializedProviderToolCall;
use serde_json::json;
use uuid::Uuid;

#[test]
fn no_tool_provider_output_completes_without_another_inference() {
    let mut service = service(RunPermissionMode::Free, 4);
    let directive = service
        .accept_provider_outcome(completion(1, vec![], Some("正文完成")), vec![])
        .unwrap();
    assert!(matches!(
        directive,
        AgentLoopDirective::Completed { ref output } if output == "正文完成"
    ));
    assert_eq!(service.phase(), LoopPhase::Completed);
}

#[test]
fn free_mode_batches_multiple_calls_and_continues_after_success_and_failure_results() {
    let mut service = service(RunPermissionMode::Free, 4);
    let calls = provider_calls();
    let directive = service
        .accept_provider_outcome(completion(1, calls.clone(), None), materialized(&calls))
        .unwrap();
    let batch = match directive {
        AgentLoopDirective::ExecuteTools(batch) => batch,
        other => panic!("unexpected directive: {other:?}"),
    };
    assert_eq!(batch.requests.len(), 2);
    assert!(batch.denied_provider_tool_call_ids.is_empty());
    assert_eq!(batch.assistant_message_id, inference_id(1).to_string());

    let context = service
        .accept_tool_results(vec![
            tool_result("provider-call-1", "read_project_file", false),
            tool_result("provider-call-2", "stat_project_file", true),
        ])
        .unwrap();
    let intent = match context {
        AgentLoopDirective::CompileContext(intent) => intent,
        other => panic!("unexpected directive: {other:?}"),
    };
    assert_eq!(intent.exchanges.len(), 4);
    assert_eq!(
        intent.exchanges[0].content["assistantMessageId"],
        inference_id(1).to_string()
    );
    assert_eq!(
        intent.exchanges[0].content["providerToolCallId"],
        "provider-call-1"
    );
    assert_eq!(intent.exchanges[3].content["isError"], true);

    let compilation_id = Uuid::new_v4();
    let next = service.accept_context_compiled(compilation_id).unwrap();
    assert!(matches!(
        next,
        AgentLoopDirective::StartInference(ref intent)
            if intent.context_compilation_id == compilation_id && intent.round == 2
    ));
    service.acknowledge_inference_started(2).unwrap();
    assert_eq!(service.phase(), LoopPhase::AwaitingProvider);
}

#[test]
fn assist_mode_pauses_and_resumes_with_mixed_approval_decisions() {
    let mut service = service(RunPermissionMode::Assist, 4);
    let calls = provider_calls();
    let directive = service
        .accept_provider_outcome(completion(1, calls.clone(), None), materialized(&calls))
        .unwrap();
    let approval = match directive {
        AgentLoopDirective::AwaitApproval(value) => value,
        other => panic!("unexpected directive: {other:?}"),
    };
    assert_eq!(approval.requests.len(), 2);
    assert_eq!(service.phase(), LoopPhase::AwaitingApproval);
    let checkpoint = service.checkpoint().unwrap();
    let mut service = AgentLoopService::restore(checkpoint).unwrap();
    assert_eq!(service.phase(), LoopPhase::AwaitingApproval);

    let resumed = service
        .resolve_assist(vec![
            AssistToolDecision::approve("provider-call-1"),
            AssistToolDecision::deny("provider-call-2"),
        ])
        .unwrap();
    let batch = match resumed {
        AgentLoopDirective::ExecuteTools(value) => value,
        other => panic!("unexpected directive: {other:?}"),
    };
    assert_eq!(batch.requests.len(), 1);
    assert_eq!(batch.denied_provider_tool_call_ids, vec!["provider-call-2"]);

    let context = service
        .accept_tool_results(vec![
            tool_result("provider-call-1", "read_project_file", false),
            tool_result("provider-call-2", "stat_project_file", true),
        ])
        .unwrap();
    assert!(matches!(context, AgentLoopDirective::CompileContext(_)));
}

#[test]
fn enforces_maximum_tool_rounds_before_scheduling_more_work() {
    let mut service = service(RunPermissionMode::Free, 1);
    let first_calls = vec![provider_calls().remove(0)];
    service
        .accept_provider_outcome(
            completion(1, first_calls.clone(), None),
            materialized(&first_calls),
        )
        .unwrap();
    service
        .accept_tool_results(vec![tool_result(
            "provider-call-1",
            "read_project_file",
            false,
        )])
        .unwrap();
    service.accept_context_compiled(context_id(2)).unwrap();
    service.acknowledge_inference_started(2).unwrap();

    let second_calls = vec![provider_calls().remove(0)];
    let error = service
        .accept_provider_outcome(
            completion(2, second_calls.clone(), None),
            materialized(&second_calls),
        )
        .unwrap_err();
    assert_eq!(error, AgentLoopError::MaximumToolRoundsExceeded);
    assert_eq!(service.phase(), LoopPhase::Failed);
}

#[test]
fn cancellation_is_terminal_and_prevents_assist_resume() {
    let mut service = service(RunPermissionMode::Assist, 4);
    let calls = provider_calls();
    service
        .accept_provider_outcome(completion(1, calls.clone(), None), materialized(&calls))
        .unwrap();
    let cancelled = service.cancel("用户取消工具循环").unwrap();
    assert!(matches!(cancelled, AgentLoopDirective::Cancelled { .. }));
    assert_eq!(service.phase(), LoopPhase::Cancelled);
    assert_eq!(
        service
            .resolve_assist(vec![AssistToolDecision::approve("provider-call-1")])
            .unwrap_err(),
        AgentLoopError::PhaseInvalid
    );
}

fn service(mode: RunPermissionMode, maximum_tool_rounds: u32) -> AgentLoopService {
    AgentLoopService::new(
        AgentLoopIdentity {
            run_id: run_id(),
            project_id: "project-1".to_owned(),
            invocation_id: "steward-1".to_owned(),
            initial_context_compilation_id: context_id(1),
            source_scope: ToolSourceScope {
                source_checkpoint_id: "checkpoint-1".to_owned(),
                resource_ids: vec!["world-1".to_owned()],
                scope_sha256: "a".repeat(64),
            },
            permission: ToolPermissionPolicy {
                mode,
                policy_id: "tool-policy".to_owned(),
                policy_version: "1.0.0".to_owned(),
                policy_sha256: "b".repeat(64),
            },
        },
        AgentLoopPolicy {
            maximum_tool_rounds,
            tool_schema_version: 1,
        },
    )
    .unwrap()
}

fn completion(
    request_number: u64,
    tool_calls: Vec<ProviderInferenceToolCall>,
    output: Option<&str>,
) -> ProviderInferenceCompleted {
    ProviderInferenceCompleted {
        identity: ProviderInferenceIdentity {
            run_id: run_id(),
            inference_id: inference_id(request_number),
            attempt_id: Uuid::new_v4(),
            context_compilation_id: context_id(request_number),
            request_number,
            attempt_number: 1,
        },
        provider_id: "deepseek".to_owned(),
        model_id: "deepseek-chat".to_owned(),
        response_id_sha256: "c".repeat(64),
        response_body_sha256: "d".repeat(64),
        stop_reason: if tool_calls.is_empty() {
            "stop"
        } else {
            "tool_calls"
        }
        .to_owned(),
        usage: ProviderInferenceUsage {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
        },
        output: output.map(|text| ProviderInferenceOutput {
            text: text.to_owned(),
            text_sha256: sha(text.as_bytes()),
            utf8_bytes: text.len() as u64,
        }),
        tool_calls,
    }
}

fn provider_calls() -> Vec<ProviderInferenceToolCall> {
    vec![
        call(
            "provider-call-1",
            "read_project_file",
            json!({ "path": "世界.md" }),
        ),
        call(
            "provider-call-2",
            "stat_project_file",
            json!({ "path": "世界.md" }),
        ),
    ]
}

fn call(id: &str, name: &str, arguments: serde_json::Value) -> ProviderInferenceToolCall {
    ProviderInferenceToolCall {
        id: id.to_owned(),
        name: name.to_owned(),
        arguments_sha256: sha(&serde_json::to_vec(&arguments).unwrap()),
        arguments,
    }
}

fn materialized(calls: &[ProviderInferenceToolCall]) -> Vec<MaterializedProviderToolCall> {
    calls
        .iter()
        .map(|call| MaterializedProviderToolCall {
            tool_call_id: Uuid::new_v4(),
            provider_tool_call_id: call.id.clone(),
            tool_name: call.name.clone(),
            arguments: artifact(&call.arguments_sha256),
        })
        .collect()
}

fn tool_result(provider_id: &str, name: &str, is_error: bool) -> FinalizedToolResult {
    let content = if is_error {
        json!({ "code": "TOOL_FAILED", "message": "读取失败" })
    } else {
        json!({ "content": "世界资料", "complete": true })
    };
    FinalizedToolResult {
        provider_tool_call_id: provider_id.to_owned(),
        tool_name: name.to_owned(),
        content_sha256: sha(&serde_json::to_vec(&content).unwrap()),
        content,
        is_error,
    }
}

fn artifact(sha256: &str) -> ToolArtifactReceipt {
    ToolArtifactReceipt {
        artifact_id: Uuid::new_v4(),
        media_type: "application/json".to_owned(),
        sha256: sha256.to_owned(),
        utf8_bytes: 32,
    }
}

fn run_id() -> Uuid {
    Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap()
}

fn inference_id(request_number: u64) -> Uuid {
    Uuid::parse_str(&format!("22222222-2222-4222-8222-{request_number:012}")).unwrap()
}

fn context_id(request_number: u64) -> Uuid {
    Uuid::parse_str(&format!("33333333-3333-4333-8333-{request_number:012}")).unwrap()
}

fn sha(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
