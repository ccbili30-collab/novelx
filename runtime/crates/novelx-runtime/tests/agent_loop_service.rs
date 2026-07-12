use novelx_protocol::{
    ProviderInferenceCompleted, ProviderInferenceIdentity, ProviderInferenceOutput,
    ProviderInferenceToolCall, ProviderInferenceUsage, RunPermissionMode, ToolArtifactReceipt,
    ToolPermissionPolicy, ToolSourceScope,
};
use novelx_runtime::agent_loop_service::{
    AgentLoopDirective, AgentLoopError, AgentLoopIdentity, AgentLoopPolicy, AgentLoopService,
    AssistToolDecision, FinalizedToolResult, InferenceDispatchIdentity, LoopPhase,
    ProviderRetryBinding,
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
fn provider_completion_must_match_the_persisted_dispatch_identity() {
    let service = service(RunPermissionMode::Free, 4);
    assert_eq!(service.pending_inference(), Some(&dispatch_identity(1)));
    let checkpoint = service.checkpoint().unwrap();
    let mut recovered = AgentLoopService::restore(checkpoint).unwrap();
    assert_eq!(recovered.pending_inference(), Some(&dispatch_identity(1)));

    let mut mismatched = completion(1, vec![], Some("不应接受"));
    mismatched.identity.attempt_id = Uuid::new_v4();
    assert_eq!(
        recovered
            .accept_provider_outcome(mismatched, vec![])
            .unwrap_err(),
        AgentLoopError::ProviderIdentityMismatch
    );
    assert_eq!(recovered.phase(), LoopPhase::AwaitingProvider);

    recovered
        .accept_provider_outcome(completion(1, vec![], Some("已恢复")), vec![])
        .unwrap();
    assert_eq!(recovered.phase(), LoopPhase::Completed);
    assert_eq!(recovered.pending_inference(), None);
}

#[test]
fn retry_replaces_only_the_pending_attempt_and_survives_checkpoint_restore() {
    let mut service = service(RunPermissionMode::Free, 4);
    let previous = dispatch_identity(1);
    let binding = retry_binding(&previous);

    service.acknowledge_inference_retry(&binding).unwrap();
    assert_eq!(service.phase(), LoopPhase::AwaitingProvider);
    assert_eq!(service.pending_inference(), Some(&binding.next));

    let checkpoint = service.checkpoint().unwrap();
    let mut recovered = AgentLoopService::restore(checkpoint).unwrap();
    assert_eq!(recovered.pending_inference(), Some(&binding.next));

    let old_completion = completion_for_dispatch(&previous, "old attempt");
    assert_eq!(
        recovered
            .accept_provider_outcome(old_completion, vec![])
            .unwrap_err(),
        AgentLoopError::ProviderIdentityMismatch
    );
    recovered
        .accept_provider_outcome(
            completion_for_dispatch(&binding.next, "new attempt"),
            vec![],
        )
        .unwrap();
    assert_eq!(recovered.phase(), LoopPhase::Completed);
}

#[test]
fn retry_rejects_cross_identity_jump_same_attempt_and_malformed_evidence() {
    let previous = dispatch_identity(1);
    let valid = retry_binding(&previous);
    let mut invalid = Vec::new();

    let mut cross_inference = valid.clone();
    cross_inference.next.inference_id = Uuid::new_v4();
    invalid.push(cross_inference);

    let mut cross_request = valid.clone();
    cross_request.next.request_number += 1;
    invalid.push(cross_request);

    let mut cross_context = valid.clone();
    cross_context.next.context_compilation_id = Uuid::new_v4();
    invalid.push(cross_context);

    let mut skipped_attempt = valid.clone();
    skipped_attempt.next.attempt_number += 1;
    invalid.push(skipped_attempt);

    let mut same_attempt_id = valid.clone();
    same_attempt_id.next.attempt_id = previous.attempt_id;
    invalid.push(same_attempt_id);

    let mut wrong_previous = valid.clone();
    wrong_previous.previous_attempt_number += 1;
    invalid.push(wrong_previous);

    let mut wrong_previous_id = valid.clone();
    wrong_previous_id.previous_attempt_id = Uuid::new_v4();
    invalid.push(wrong_previous_id);

    let mut malformed_hash = valid.clone();
    malformed_hash.schedule_sha256 = "A".repeat(64);
    invalid.push(malformed_hash);

    let mut missing_schedule = valid.clone();
    missing_schedule.schedule_id = " ".to_owned();
    invalid.push(missing_schedule);

    let mut empty_idempotency = valid;
    empty_idempotency.next.inference_idempotency_key.clear();
    invalid.push(empty_idempotency);

    let mut reused_idempotency = retry_binding(&previous);
    reused_idempotency.next.inference_idempotency_key = previous.inference_idempotency_key.clone();
    invalid.push(reused_idempotency);

    for binding in invalid {
        let mut service = service(RunPermissionMode::Free, 4);
        assert_eq!(
            service.acknowledge_inference_retry(&binding).unwrap_err(),
            AgentLoopError::RetryBindingInvalid
        );
        assert_eq!(service.pending_inference(), Some(&previous));
    }

    let mut terminal = service(RunPermissionMode::Free, 4);
    terminal
        .accept_provider_outcome(completion(1, vec![], Some("done")), vec![])
        .unwrap();
    assert_eq!(
        terminal.acknowledge_inference_retry(&retry_binding(&previous)),
        Err(AgentLoopError::PhaseInvalid)
    );
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
    service
        .acknowledge_inference_started(dispatch_identity_for(2, compilation_id))
        .unwrap();
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
    service
        .acknowledge_inference_started(dispatch_identity(2))
        .unwrap();

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
        dispatch_identity(1),
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
            attempt_id: attempt_id(request_number),
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

fn completion_for_dispatch(
    dispatch: &InferenceDispatchIdentity,
    output: &str,
) -> ProviderInferenceCompleted {
    let mut completion = completion(dispatch.request_number, vec![], Some(output));
    completion.identity.inference_id = dispatch.inference_id;
    completion.identity.attempt_id = dispatch.attempt_id;
    completion.identity.context_compilation_id = dispatch.context_compilation_id;
    completion.identity.attempt_number = u64::from(dispatch.attempt_number);
    completion
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

fn attempt_id(request_number: u64) -> Uuid {
    Uuid::parse_str(&format!("44444444-4444-4444-8444-{request_number:012}")).unwrap()
}

fn dispatch_identity(request_number: u64) -> InferenceDispatchIdentity {
    dispatch_identity_for(request_number, context_id(request_number))
}

fn dispatch_identity_for(
    request_number: u64,
    context_compilation_id: Uuid,
) -> InferenceDispatchIdentity {
    InferenceDispatchIdentity {
        inference_id: inference_id(request_number),
        attempt_id: attempt_id(request_number),
        request_number,
        context_compilation_id,
        attempt_number: 1,
        inference_idempotency_key: format!("inference-{request_number}"),
    }
}

fn retry_binding(previous: &InferenceDispatchIdentity) -> ProviderRetryBinding {
    ProviderRetryBinding {
        schedule_id: "provider-retry-schedule-1".to_owned(),
        schedule_sha256: "e".repeat(64),
        parent_attempt_evidence_sha256: "f".repeat(64),
        previous_attempt_id: previous.attempt_id,
        previous_attempt_number: previous.attempt_number,
        next: InferenceDispatchIdentity {
            inference_id: previous.inference_id,
            attempt_id: Uuid::parse_str("55555555-5555-4555-8555-000000000001").unwrap(),
            request_number: previous.request_number,
            context_compilation_id: previous.context_compilation_id,
            attempt_number: previous.attempt_number + 1,
            inference_idempotency_key: "inference-1-attempt-2".to_owned(),
        },
    }
}

fn sha(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
