use novelx_protocol::{
    ProviderInferenceCompleted, ProviderInferenceIdentity, ProviderInferenceToolCall,
    ProviderInferenceUsage, RunPermissionMode, ToolArtifactReceipt, ToolPermissionPolicy,
    ToolSourceScope,
};
use novelx_runtime::{
    agent_loop_journal::{
        AgentLoopEventMetadata, AgentLoopJournalError, AgentLoopJournalRepository,
        StateTransitionKind,
    },
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, AssistToolDecision,
        FinalizedToolResult, InferenceDispatchIdentity, LoopPhase, ProviderRetryBinding,
    },
    event_journal::EventJournal,
    provider_tool_materializer::MaterializedProviderToolCall,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[test]
fn persists_recovers_and_resumes_assist_by_internal_tool_call_id() {
    let fixture = Fixture::new();
    let mut loop_service = service("invocation-1");
    let original = loop_service.clone();
    let mut journal = fixture.open();
    AgentLoopJournalRepository::new(&mut journal)
        .create(&loop_service, "create-1", metadata("message-1"))
        .unwrap();

    let call = provider_call();
    let materialized = materialized(&call);
    let internal_id = materialized.tool_call_id;
    let directive = loop_service
        .accept_provider_outcome(completion(call), vec![materialized])
        .unwrap();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    let stored = repository
        .append_transition(
            &original,
            &loop_service,
            &directive,
            "await-approval-1",
            metadata("message-2"),
        )
        .unwrap();
    assert_eq!(stored.service.phase(), LoopPhase::AwaitingApproval);
    drop(journal);

    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    let pending = repository
        .find_pending_request(&run_id().to_string(), internal_id)
        .unwrap()
        .unwrap();
    assert_eq!(pending.invocation_id, "invocation-1");
    let mut recovered = repository
        .recover(&run_id().to_string(), "invocation-1")
        .unwrap()
        .service;
    let before_resolution = recovered.clone();
    let directive = recovered
        .resolve_assist(vec![AssistToolDecision::approve("provider-call-1")])
        .unwrap();
    let first = repository
        .append_transition(
            &before_resolution,
            &recovered,
            &directive,
            "assist-resolution-1",
            metadata("message-3"),
        )
        .unwrap();
    let retry = repository
        .append_transition(
            &before_resolution,
            &recovered,
            &directive,
            "assist-resolution-1",
            metadata("message-3-retry"),
        )
        .unwrap();
    assert_eq!(first.aggregate_sequence, retry.aggregate_sequence);
    assert_eq!(retry.service.phase(), LoopPhase::AwaitingToolResults);
}

#[test]
fn refuses_multiple_active_loops_for_one_run() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    repository
        .create(&service("invocation-1"), "create-1", metadata("message-1"))
        .unwrap();
    repository
        .create(&service("invocation-2"), "create-2", metadata("message-2"))
        .unwrap();
    assert!(matches!(
        repository.find_active_for_run(&run_id().to_string()),
        Err(AgentLoopJournalError::MultipleActiveLoops)
    ));
}

#[test]
fn persists_inference_started_without_fabricating_a_directive() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    let mut current = service("invocation-ack");
    repository
        .create(&current, "create-ack", metadata("ack-1"))
        .unwrap();

    let previous = current.clone();
    let call = provider_call();
    let directive = current
        .accept_provider_outcome(completion(call.clone()), vec![materialized(&call)])
        .unwrap();
    repository
        .append_transition(
            &previous,
            &current,
            &directive,
            "await-ack",
            metadata("ack-2"),
        )
        .unwrap();
    let previous = current.clone();
    let directive = current
        .resolve_assist(vec![AssistToolDecision::approve("provider-call-1")])
        .unwrap();
    repository
        .append_transition(
            &previous,
            &current,
            &directive,
            "execute-ack",
            metadata("ack-3"),
        )
        .unwrap();
    let previous = current.clone();
    let directive = current.accept_tool_results(vec![tool_result()]).unwrap();
    repository
        .append_transition(
            &previous,
            &current,
            &directive,
            "context-ack",
            metadata("ack-4"),
        )
        .unwrap();
    let previous = current.clone();
    let compilation_id = Uuid::new_v4();
    let directive = current.accept_context_compiled(compilation_id).unwrap();
    repository
        .append_transition(
            &previous,
            &current,
            &directive,
            "inference-ack",
            metadata("ack-5"),
        )
        .unwrap();
    let previous = current.clone();
    current
        .acknowledge_inference_started(dispatch_identity(2, compilation_id))
        .unwrap();
    let first = repository
        .append_inference_started(&previous, &current, "started-ack", metadata("ack-6"))
        .unwrap();
    let retry = repository
        .append_state_transition(
            &previous,
            &current,
            StateTransitionKind::InferenceStarted,
            "started-ack",
            metadata("ack-6-retry"),
        )
        .unwrap();
    assert_eq!(first.aggregate_sequence, retry.aggregate_sequence);
    assert_eq!(
        repository
            .recover(&run_id().to_string(), "invocation-ack")
            .unwrap()
            .service
            .phase(),
        LoopPhase::AwaitingProvider
    );
}

#[test]
fn persists_and_replays_the_only_allowed_same_phase_retry_transition() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    let previous = service("invocation-retry");
    repository
        .create(&previous, "create-retry", metadata("retry-1"))
        .unwrap();
    let binding = retry_binding(previous.pending_inference().unwrap());
    let mut current = previous.clone();
    current.acknowledge_inference_retry(&binding).unwrap();

    let first = repository
        .append_inference_retried(
            &previous,
            &current,
            &binding,
            "retry-attempt-2",
            metadata("retry-2"),
        )
        .unwrap();
    let idempotent = repository
        .append_inference_retried(
            &previous,
            &current,
            &binding,
            "retry-attempt-2",
            metadata("retry-2-again"),
        )
        .unwrap();
    assert_eq!(first.aggregate_sequence, idempotent.aggregate_sequence);
    drop(journal);

    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    let recovered = repository
        .recover(&run_id().to_string(), "invocation-retry")
        .unwrap();
    assert_eq!(recovered.service, current);
    assert_eq!(recovered.service.pending_inference(), Some(&binding.next));

    assert!(matches!(
        repository.append_state_transition(
            &current,
            &current,
            StateTransitionKind::InferenceStarted,
            "ordinary-same-phase",
            metadata("retry-3"),
        ),
        Err(AgentLoopJournalError::TransitionInvalid)
    ));
    assert!(matches!(
        repository.append_inference_retried(
            &previous,
            &current,
            &binding,
            "duplicate-under-new-key",
            metadata("retry-4"),
        ),
        Err(AgentLoopJournalError::StaleCheckpoint)
    ));
}

#[test]
fn retry_command_key_conflict_is_rejected() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    let previous = service("invocation-retry-key");
    repository
        .create(&previous, "create-retry-key", metadata("retry-key-1"))
        .unwrap();
    let binding = retry_binding(previous.pending_inference().unwrap());
    let mut current = previous.clone();
    current.acknowledge_inference_retry(&binding).unwrap();
    repository
        .append_inference_retried(
            &previous,
            &current,
            &binding,
            "same-retry-key",
            metadata("retry-key-2"),
        )
        .unwrap();

    let mut conflicting_binding = binding.clone();
    conflicting_binding.next.attempt_id = Uuid::new_v4();
    conflicting_binding.next.inference_idempotency_key = "different-attempt-2".to_owned();
    let mut conflicting_current = previous.clone();
    conflicting_current
        .acknowledge_inference_retry(&conflicting_binding)
        .unwrap();
    assert!(matches!(
        repository.append_inference_retried(
            &previous,
            &conflicting_current,
            &conflicting_binding,
            "same-retry-key",
            metadata("retry-key-3"),
        ),
        Err(AgentLoopJournalError::Journal(_))
    ));
}

#[test]
fn replay_rejects_missing_malformed_and_forged_retry_binding() {
    for (case, mutation) in [
        (
            "missing",
            "UPDATE runtime_events SET payload_json = json_remove(payload_json, '$.retryBinding') WHERE event_type = 'agent_loop.inference_retried'",
        ),
        (
            "malformed-hash",
            "UPDATE runtime_events SET payload_json = json_set(payload_json, '$.retryBinding.scheduleSha256', '0000000000000000000000000000000000000000000000000000000000000000') WHERE event_type = 'agent_loop.inference_retried'",
        ),
        (
            "forged-next",
            "UPDATE runtime_events SET payload_json = json_set(payload_json, '$.retryBinding.next.attemptId', '66666666-6666-4666-8666-000000000001') WHERE event_type = 'agent_loop.inference_retried'",
        ),
        (
            "unknown-event",
            "UPDATE runtime_events SET event_type = 'agent_loop.unknown_retry' WHERE event_type = 'agent_loop.inference_retried'",
        ),
        (
            "unknown-version",
            "UPDATE runtime_events SET event_version = 99 WHERE event_type = 'agent_loop.inference_retried'",
        ),
        (
            "sequence-gap",
            "UPDATE runtime_events SET aggregate_sequence = 3 WHERE event_type = 'agent_loop.inference_retried'",
        ),
    ] {
        let fixture = retry_fixture(case);
        fixture.mutate(mutation, &[]);
        let mut journal = fixture.open();
        assert!(
            AgentLoopJournalRepository::new(&mut journal)
                .recover(&run_id().to_string(), &format!("invocation-{case}"))
                .is_err(),
            "corrupted retry history unexpectedly recovered: {case}"
        );
    }
}

#[test]
fn rejects_a_corrupted_checkpoint_hash() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &service("invocation-hash"),
                "create-hash",
                metadata("hash-1"),
            )
            .unwrap();
    }
    fixture.mutate(
        "UPDATE runtime_events SET payload_json = json_set(payload_json, '$.checkpointSha256', ?1) WHERE aggregate_type = 'agent_loop'",
        &[&"0".repeat(64)],
    );
    let mut journal = fixture.open();
    assert!(matches!(
        AgentLoopJournalRepository::new(&mut journal)
            .recover(&run_id().to_string(), "invocation-hash"),
        Err(AgentLoopJournalError::CheckpointHashMismatch)
    ));
}

#[test]
fn replays_legacy_events_without_the_optional_retry_binding_field() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &service("invocation-legacy"),
                "create-legacy",
                metadata("legacy-1"),
            )
            .unwrap();
    }
    fixture.mutate(
        "UPDATE runtime_events SET payload_json = json_remove(json_remove(payload_json, '$.retryBinding'), '$.retryBindingSha256') WHERE aggregate_type = 'agent_loop'",
        &[],
    );
    let mut journal = fixture.open();
    let recovered = AgentLoopJournalRepository::new(&mut journal)
        .recover(&run_id().to_string(), "invocation-legacy")
        .unwrap();
    assert_eq!(recovered.service.phase(), LoopPhase::AwaitingProvider);
}

#[test]
fn rejects_an_aggregate_sequence_gap() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        let mut service = service("invocation-gap");
        let original = service.clone();
        let mut repository = AgentLoopJournalRepository::new(&mut journal);
        repository
            .create(&service, "create-gap", metadata("gap-1"))
            .unwrap();
        let call = provider_call();
        let directive = service
            .accept_provider_outcome(completion(call.clone()), vec![materialized(&call)])
            .unwrap();
        repository
            .append_transition(
                &original,
                &service,
                &directive,
                "transition-gap",
                metadata("gap-2"),
            )
            .unwrap();
    }
    fixture.mutate(
        "UPDATE runtime_events SET aggregate_sequence = 3 WHERE aggregate_type = 'agent_loop' AND aggregate_sequence = 2",
        &[],
    );
    let mut journal = fixture.open();
    assert!(matches!(
        AgentLoopJournalRepository::new(&mut journal)
            .recover(&run_id().to_string(), "invocation-gap"),
        Err(AgentLoopJournalError::SequenceGap)
    ));
}

#[test]
fn rejects_a_duplicate_pending_internal_tool_id_across_active_loops() {
    let fixture = Fixture::new();
    let duplicated = Uuid::new_v4();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    for (ordinal, invocation) in ["invocation-dup-1", "invocation-dup-2"]
        .into_iter()
        .enumerate()
    {
        let mut loop_service = service(invocation);
        let original = loop_service.clone();
        repository
            .create(
                &loop_service,
                &format!("create-dup-{ordinal}"),
                metadata(if ordinal == 0 { "dup-1" } else { "dup-2" }),
            )
            .unwrap();
        let call = provider_call();
        let directive = loop_service
            .accept_provider_outcome(
                completion(call.clone()),
                vec![materialized_with_id(&call, duplicated)],
            )
            .unwrap();
        repository
            .append_transition(
                &original,
                &loop_service,
                &directive,
                &format!("pending-dup-{ordinal}"),
                metadata(if ordinal == 0 { "dup-3" } else { "dup-4" }),
            )
            .unwrap();
    }
    assert!(matches!(
        repository.find_pending_request(&run_id().to_string(), duplicated),
        Err(AgentLoopJournalError::DuplicatePendingToolCall)
    ));
}

#[test]
fn conflicting_reuse_of_a_transition_command_key_is_rejected() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    let original = service("invocation-key");
    repository
        .create(&original, "create-key", metadata("key-1"))
        .unwrap();
    let call = provider_call();
    let mut approval = original.clone();
    let directive = approval
        .accept_provider_outcome(completion(call.clone()), vec![materialized(&call)])
        .unwrap();
    repository
        .append_transition(
            &original,
            &approval,
            &directive,
            "same-key",
            metadata("key-2"),
        )
        .unwrap();
    let mut cancelled = original.clone();
    let cancel = cancelled.cancel("用户取消").unwrap();
    assert!(matches!(
        repository.append_transition(
            &original,
            &cancelled,
            &cancel,
            "same-key",
            metadata("key-3"),
        ),
        Err(AgentLoopJournalError::Journal(_))
    ));
}

#[test]
fn rejects_a_transition_based_on_a_stale_checkpoint() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    let original = service("invocation-stale");
    repository
        .create(&original, "create-stale", metadata("stale-1"))
        .unwrap();
    let call = provider_call();
    let mut approval = original.clone();
    let directive = approval
        .accept_provider_outcome(completion(call.clone()), vec![materialized(&call)])
        .unwrap();
    repository
        .append_transition(
            &original,
            &approval,
            &directive,
            "approval-stale",
            metadata("stale-2"),
        )
        .unwrap();
    let mut cancelled = original.clone();
    let cancel = cancelled.cancel("过期命令").unwrap();
    assert!(matches!(
        repository.append_transition(
            &original,
            &cancelled,
            &cancel,
            "cancel-stale",
            metadata("stale-3"),
        ),
        Err(AgentLoopJournalError::StaleCheckpoint)
    ));
}

#[test]
fn invalid_metadata_is_rejected_before_any_agent_loop_write() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    assert!(matches!(
        repository.create(
            &service("invocation-metadata"),
            "",
            AgentLoopEventMetadata {
                message_id: "",
                created_at: "",
            },
        ),
        Err(AgentLoopJournalError::MetadataInvalid)
    ));
    assert!(
        journal
            .read_aggregate(
                &run_id().to_string(),
                "agent_loop",
                "invocation-metadata",
                0,
            )
            .unwrap()
            .is_empty()
    );
}

#[test]
fn create_key_cannot_be_reused_with_a_different_checkpoint() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    let original = service("invocation-create-conflict");
    repository
        .create(&original, "create-conflict", metadata("create-conflict-1"))
        .unwrap();
    let mut changed = original.clone();
    changed.cancel("改变检查点").unwrap();
    assert!(matches!(
        repository.create(&changed, "create-conflict", metadata("create-conflict-2"),),
        Err(AgentLoopJournalError::IdentityConflict)
    ));
}

struct Fixture {
    _temp: tempfile::TempDir,
    database: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("runtime.db");
        Self {
            _temp: temp,
            database,
        }
    }

    fn open(&self) -> EventJournal {
        EventJournal::open(&self.database).unwrap()
    }

    fn mutate(&self, sql: &str, params: &[&dyn rusqlite::ToSql]) {
        let connection = rusqlite::Connection::open(&self.database).unwrap();
        connection
            .execute_batch("DROP TRIGGER runtime_events_no_update;")
            .unwrap();
        connection.execute(sql, params).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER runtime_events_no_update BEFORE UPDATE ON runtime_events BEGIN SELECT RAISE(ABORT, 'RUNTIME_EVENT_IMMUTABLE'); END;",
            )
            .unwrap();
    }
}

fn service(invocation_id: &str) -> AgentLoopService {
    AgentLoopService::new(
        AgentLoopIdentity {
            run_id: run_id(),
            project_id: "project-1".to_owned(),
            invocation_id: invocation_id.to_owned(),
            initial_context_compilation_id: context_id(),
            source_scope: ToolSourceScope {
                source_checkpoint_id: "checkpoint-1".to_owned(),
                resource_ids: vec!["world-1".to_owned()],
                scope_sha256: "a".repeat(64),
            },
            permission: ToolPermissionPolicy {
                mode: RunPermissionMode::Assist,
                policy_id: "tool-policy".to_owned(),
                policy_version: "1.0.0".to_owned(),
                policy_sha256: "b".repeat(64),
            },
        },
        AgentLoopPolicy {
            maximum_tool_rounds: 4,
            tool_schema_version: 1,
        },
        dispatch_identity(1, context_id()),
    )
    .unwrap()
}

fn retry_fixture(case: &str) -> Fixture {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    let previous = service(&format!("invocation-{case}"));
    repository
        .create(
            &previous,
            &format!("create-{case}"),
            metadata(&format!("{case}-1")),
        )
        .unwrap();
    let binding = retry_binding(previous.pending_inference().unwrap());
    let mut current = previous.clone();
    current.acknowledge_inference_retry(&binding).unwrap();
    repository
        .append_inference_retried(
            &previous,
            &current,
            &binding,
            &format!("retry-{case}"),
            metadata(&format!("{case}-2")),
        )
        .unwrap();
    drop(journal);
    fixture
}

fn completion(call: ProviderInferenceToolCall) -> ProviderInferenceCompleted {
    ProviderInferenceCompleted {
        identity: ProviderInferenceIdentity {
            run_id: run_id(),
            inference_id: inference_id(1),
            attempt_id: attempt_id(1),
            context_compilation_id: context_id(),
            request_number: 1,
            attempt_number: 1,
        },
        provider_id: "deepseek".to_owned(),
        model_id: "deepseek-chat".to_owned(),
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

fn provider_call() -> ProviderInferenceToolCall {
    let arguments = json!({ "path": "world.md" });
    ProviderInferenceToolCall {
        id: "provider-call-1".to_owned(),
        name: "read_project_file".to_owned(),
        arguments_sha256: sha(&serde_json::to_vec(&arguments).unwrap()),
        arguments,
    }
}

fn materialized(call: &ProviderInferenceToolCall) -> MaterializedProviderToolCall {
    materialized_with_id(call, Uuid::new_v4())
}

fn materialized_with_id(
    call: &ProviderInferenceToolCall,
    tool_call_id: Uuid,
) -> MaterializedProviderToolCall {
    MaterializedProviderToolCall {
        tool_call_id,
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

fn tool_result() -> FinalizedToolResult {
    let content = json!({ "content": "世界资料", "complete": true });
    FinalizedToolResult {
        provider_tool_call_id: "provider-call-1".to_owned(),
        tool_name: "read_project_file".to_owned(),
        content_sha256: sha(&serde_json::to_vec(&content).unwrap()),
        content,
        is_error: false,
    }
}

fn metadata(message_id: &str) -> AgentLoopEventMetadata<'_> {
    AgentLoopEventMetadata {
        message_id,
        created_at: "2026-07-12T00:00:00Z",
    }
}

fn run_id() -> Uuid {
    Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap()
}

fn context_id() -> Uuid {
    Uuid::parse_str("33333333-3333-4333-8333-000000000001").unwrap()
}

fn inference_id(request_number: u64) -> Uuid {
    Uuid::parse_str(&format!("22222222-2222-4222-8222-{request_number:012}")).unwrap()
}

fn attempt_id(request_number: u64) -> Uuid {
    Uuid::parse_str(&format!("44444444-4444-4444-8444-{request_number:012}")).unwrap()
}

fn dispatch_identity(
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
    format!("{:x}", Sha256::digest(bytes))
}
