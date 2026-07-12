use novelx_protocol::{
    ProviderInferenceCompleted, ProviderInferenceIdentity, ProviderInferenceToolCall,
    ProviderInferenceUsage, RunPermissionMode, ToolArtifactReceipt, ToolPermissionPolicy,
    ToolSourceScope,
};
use novelx_runtime::{
    agent_loop_journal::{
        AgentLoopEventMetadata, AgentLoopJournalError, AgentLoopJournalRepository,
        PendingInferenceOrigin, StateTransitionKind,
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
fn initial_provider_authorization_snapshot_binds_the_replayed_attempt_one_head() {
    let fixture = Fixture::new();
    let initial = service("invocation-snapshot-initial");
    let expected_pending = initial.pending_inference().unwrap().clone();
    let expected_checkpoint_sha256 = initial.checkpoint_sha256().unwrap();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    repository
        .create(
            &initial,
            "create-snapshot-initial",
            metadata_at("snapshot-initial-1", "2026-07-12T01:02:03Z"),
        )
        .unwrap();

    let snapshot = repository
        .recover_provider_authorization_snapshot(
            &run_id().to_string(),
            "invocation-snapshot-initial",
        )
        .unwrap();
    assert_eq!(snapshot.run_id(), run_id());
    assert_eq!(snapshot.invocation_id(), "invocation-snapshot-initial");
    assert_eq!(snapshot.aggregate_sequence(), 1);
    assert_eq!(snapshot.checkpoint_sha256(), expected_checkpoint_sha256);
    assert_eq!(snapshot.pending_inference(), &expected_pending);
    assert_eq!(
        snapshot.pending_inference_sha256(),
        canonical_sha(&serde_json::to_value(&expected_pending).unwrap())
    );
    assert!(is_lowercase_sha256(snapshot.checkpoint_sha256()));
    assert!(is_lowercase_sha256(snapshot.pending_inference_sha256()));
    assert_eq!(
        snapshot.pending_inference_persisted_at(),
        "2026-07-12T01:02:03Z"
    );
    assert_eq!(
        snapshot.pending_inference_origin(),
        PendingInferenceOrigin::Created
    );
    assert_eq!(snapshot.last_retry_binding(), None);
    assert_eq!(snapshot.last_retry_binding_sha256(), None);
}

#[test]
fn a_forged_request_two_created_checkpoint_is_not_reported_as_a_continuation() {
    let fixture = Fixture::new();
    let mut checkpoint = service("invocation-forged-created").checkpoint().unwrap();
    let forged_dispatch = dispatch_identity(2, context_id());
    checkpoint["expectedRequestNumber"] = json!(2);
    checkpoint["pendingInference"] = serde_json::to_value(&forged_dispatch).unwrap();
    let forged = AgentLoopService::restore(checkpoint).unwrap();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    repository
        .create(
            &forged,
            "create-forged-request-two",
            metadata_at("forged-request-two-1", "2026-07-12T01:03:03Z"),
        )
        .unwrap();

    let snapshot = repository
        .recover_provider_authorization_snapshot(&run_id().to_string(), "invocation-forged-created")
        .unwrap();
    assert_eq!(snapshot.pending_inference().request_number, 2);
    assert_eq!(
        snapshot.pending_inference_origin(),
        PendingInferenceOrigin::Created
    );
    assert_ne!(
        snapshot.pending_inference_origin(),
        PendingInferenceOrigin::InferenceStarted
    );
}

#[test]
fn tampering_a_created_event_type_cannot_forge_a_continuation_origin() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &service("invocation-origin-tamper"),
                "create-origin-tamper",
                metadata_at("origin-tamper-1", "2026-07-12T01:04:03Z"),
            )
            .unwrap();
    }
    fixture.mutate(
        "UPDATE runtime_events SET event_type = 'agent_loop.transitioned' WHERE aggregate_type = 'agent_loop'",
        &[],
    );
    let mut journal = fixture.open();
    assert!(matches!(
        AgentLoopJournalRepository::new(&mut journal).recover_provider_authorization_snapshot(
            &run_id().to_string(),
            "invocation-origin-tamper"
        ),
        Err(AgentLoopJournalError::InvalidHistory)
    ));
}

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
    assert!(matches!(
        repository.recover_provider_authorization_snapshot(&run_id().to_string(), "invocation-1"),
        Err(AgentLoopJournalError::ProviderAuthorizationUnavailable)
    ));
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
        .append_inference_started(
            &previous,
            &current,
            "started-ack",
            metadata_at("ack-6", "2026-07-12T02:03:04Z"),
        )
        .unwrap();
    let retry = repository
        .append_state_transition(
            &previous,
            &current,
            StateTransitionKind::InferenceStarted,
            "started-ack",
            metadata_at("ack-6-retry", "2026-07-12T02:03:05Z"),
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
    let snapshot = repository
        .recover_provider_authorization_snapshot(&run_id().to_string(), "invocation-ack")
        .unwrap();
    assert_eq!(
        snapshot.pending_inference_persisted_at(),
        "2026-07-12T02:03:04Z"
    );
    assert_eq!(
        snapshot.pending_inference_origin(),
        PendingInferenceOrigin::InferenceStarted
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
            metadata_at("retry-2", "2026-07-12T03:04:05Z"),
        )
        .unwrap();
    let idempotent = repository
        .append_inference_retried(
            &previous,
            &current,
            &binding,
            "retry-attempt-2",
            metadata_at("retry-2-again", "2026-07-12T03:04:06Z"),
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
    let snapshot = repository
        .recover_provider_authorization_snapshot(&run_id().to_string(), "invocation-retry")
        .unwrap();
    assert_eq!(snapshot.aggregate_sequence(), 2);
    assert_eq!(
        snapshot.checkpoint_sha256(),
        current.checkpoint_sha256().unwrap()
    );
    assert_eq!(snapshot.pending_inference(), &binding.next);
    assert_eq!(snapshot.last_retry_binding(), Some(&binding));
    assert_eq!(
        snapshot.last_retry_binding_sha256(),
        Some(sha(&serde_json::to_vec(&binding).unwrap()).as_str())
    );
    assert!(is_lowercase_sha256(snapshot.pending_inference_sha256()));
    assert!(is_lowercase_sha256(
        snapshot.last_retry_binding_sha256().unwrap()
    ));
    assert_eq!(
        snapshot.pending_inference_persisted_at(),
        "2026-07-12T03:04:05Z"
    );
    assert_eq!(
        snapshot.pending_inference_origin(),
        PendingInferenceOrigin::InferenceRetried
    );

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
fn a_new_non_retry_provider_round_clears_the_previous_retry_binding() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    let mut current = service("invocation-retry-cleared");
    repository
        .create(
            &current,
            "create-retry-cleared",
            metadata("retry-cleared-1"),
        )
        .unwrap();

    let previous = current.clone();
    let binding = retry_binding(previous.pending_inference().unwrap());
    current.acknowledge_inference_retry(&binding).unwrap();
    repository
        .append_inference_retried(
            &previous,
            &current,
            &binding,
            "retry-cleared-attempt-2",
            metadata("retry-cleared-2"),
        )
        .unwrap();

    let previous = current.clone();
    let call = provider_call();
    let mut retried_completion = completion(call.clone());
    retried_completion.identity.attempt_id = binding.next.attempt_id;
    retried_completion.identity.attempt_number = u64::from(binding.next.attempt_number);
    let directive = current
        .accept_provider_outcome(retried_completion, vec![materialized(&call)])
        .unwrap();
    repository
        .append_transition(
            &previous,
            &current,
            &directive,
            "retry-cleared-await-approval",
            metadata("retry-cleared-3"),
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
            "retry-cleared-execute",
            metadata("retry-cleared-4"),
        )
        .unwrap();

    let previous = current.clone();
    let directive = current.accept_tool_results(vec![tool_result()]).unwrap();
    repository
        .append_transition(
            &previous,
            &current,
            &directive,
            "retry-cleared-context",
            metadata("retry-cleared-5"),
        )
        .unwrap();

    let previous = current.clone();
    let next_context_id = Uuid::new_v4();
    let directive = current.accept_context_compiled(next_context_id).unwrap();
    repository
        .append_transition(
            &previous,
            &current,
            &directive,
            "retry-cleared-next-inference",
            metadata("retry-cleared-6"),
        )
        .unwrap();

    let previous = current.clone();
    let next_dispatch = dispatch_identity(2, next_context_id);
    current
        .acknowledge_inference_started(next_dispatch.clone())
        .unwrap();
    repository
        .append_inference_started(
            &previous,
            &current,
            "retry-cleared-started",
            metadata("retry-cleared-7"),
        )
        .unwrap();

    let snapshot = repository
        .recover_provider_authorization_snapshot(&run_id().to_string(), "invocation-retry-cleared")
        .unwrap();
    assert_eq!(snapshot.aggregate_sequence(), 7);
    assert_eq!(snapshot.pending_inference(), &next_dispatch);
    assert_eq!(snapshot.pending_inference().attempt_number, 1);
    assert_eq!(snapshot.last_retry_binding(), None);
    assert_eq!(snapshot.last_retry_binding_sha256(), None);
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
        drop(journal);
        let mut journal = fixture.open();
        assert!(
            AgentLoopJournalRepository::new(&mut journal)
                .recover_provider_authorization_snapshot(
                    &run_id().to_string(),
                    &format!("invocation-{case}"),
                )
                .is_err(),
            "corrupted retry history unexpectedly produced an authorization snapshot: {case}"
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
fn provider_authorization_snapshot_rejects_a_tampered_non_rfc3339_event_time() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        AgentLoopJournalRepository::new(&mut journal)
            .create(
                &service("invocation-time-tamper"),
                "create-time-tamper",
                metadata_at("time-tamper-1", "2026-07-12T04:05:06Z"),
            )
            .unwrap();
    }
    fixture.mutate(
        "UPDATE runtime_events SET created_at = 'not-rfc3339' WHERE aggregate_type = 'agent_loop'",
        &[],
    );
    let mut journal = fixture.open();
    assert!(matches!(
        AgentLoopJournalRepository::new(&mut journal).recover_provider_authorization_snapshot(
            &run_id().to_string(),
            "invocation-time-tamper"
        ),
        Err(AgentLoopJournalError::EventTimestampInvalid)
    ));
}

#[test]
fn replays_legacy_events_without_the_optional_retry_binding_field() {
    let fixture = Fixture::new();
    let legacy = service("invocation-legacy");
    let legacy_checkpoint = legacy.checkpoint().unwrap();
    let legacy_checkpoint_sha256 = sha(&serde_json::to_vec(&legacy_checkpoint).unwrap());
    {
        let mut journal = fixture.open();
        AgentLoopJournalRepository::new(&mut journal)
            .create(&legacy, "create-legacy", metadata("legacy-1"))
            .unwrap();
    }
    fixture.mutate(
        "UPDATE runtime_events SET payload_json = json_set(json_remove(json_remove(payload_json, '$.retryBinding'), '$.retryBindingSha256'), '$.checkpointSha256', ?1) WHERE aggregate_type = 'agent_loop'",
        &[&legacy_checkpoint_sha256],
    );
    let mut journal = fixture.open();
    let repository = AgentLoopJournalRepository::new(&mut journal);
    let recovered = repository
        .recover(&run_id().to_string(), "invocation-legacy")
        .unwrap();
    assert_eq!(recovered.service.phase(), LoopPhase::AwaitingProvider);
    let snapshot = repository
        .recover_provider_authorization_snapshot(&run_id().to_string(), "invocation-legacy")
        .unwrap();
    assert_eq!(snapshot.checkpoint_sha256(), legacy_checkpoint_sha256);
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
    metadata_at(message_id, "2026-07-12T00:00:00Z")
}

fn metadata_at<'a>(message_id: &'a str, created_at: &'a str) -> AgentLoopEventMetadata<'a> {
    AgentLoopEventMetadata {
        message_id,
        created_at,
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

fn canonical_sha(value: &serde_json::Value) -> String {
    fn canonicalize(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(canonicalize).collect())
            }
            serde_json::Value::Object(values) => {
                let mut entries = values.into_iter().collect::<Vec<_>>();
                entries.sort_by(|left, right| left.0.cmp(&right.0));
                serde_json::Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key, canonicalize(value)))
                        .collect(),
                )
            }
            scalar => scalar,
        }
    }
    sha(&serde_json::to_vec(&canonicalize(value.clone())).unwrap())
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
