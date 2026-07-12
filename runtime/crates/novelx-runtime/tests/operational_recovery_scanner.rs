mod support;

use novelx_protocol::{
    ProviderRunIdentity, RevisionReference, RunPermissionMode, ToolPermissionPolicy,
    ToolSourceScope,
};
use novelx_runtime::{
    agent_assignment_recovery::AssignmentRecoveryReport,
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity,
    },
    event_journal::EventJournal,
    operational_recovery_scanner::{OperationalRecoveryGate, OperationalRecoveryScanner},
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptMetadata,
        ProviderResponseReceipt,
    },
    run_aggregate::{EventMetadata, RunAggregate},
    tool_aggregate::{ToolCallAggregate, ToolCallDefinition, ToolEventMetadata},
    tool_state::ToolSideEffect,
};
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn exact_provider_binding_is_required_when_no_durable_outcome_exists() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4().to_string();
    let provider = create_running_run(&fixture, &run_id);

    assert_eq!(
        fixture.gate(&[], &run_id),
        OperationalRecoveryGate::AwaitingProviderBinding
    );
    assert_eq!(
        fixture.gate(&[provider], &run_id),
        OperationalRecoveryGate::RecoveryReady
    );

    let mut wrong_provider = support::pinned_identity().provider;
    wrong_provider.model_id = "deepseek-reasoner".to_owned();
    assert_eq!(
        fixture.gate(&[wrong_provider], &run_id),
        OperationalRecoveryGate::AwaitingProviderBinding
    );
}

#[test]
fn child_run_without_a_structural_assignment_record_is_quarantined() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4().to_string();
    let mut identity = support::pinned_identity();
    identity.goal = Some(RevisionReference {
        id: "goal-1".to_owned(),
        revision: 1,
        sha256: Some("a".repeat(64)),
    });
    identity.plan = Some(RevisionReference {
        id: "plan-1".to_owned(),
        revision: 1,
        sha256: Some("b".repeat(64)),
    });
    identity.assignment = Some(RevisionReference {
        id: "assignment-1".to_owned(),
        revision: 1,
        sha256: Some("c".repeat(64)),
    });
    identity.parent_run_id = Some("parent-run-1".to_owned());
    identity.delegation_depth = 1;
    let mut journal = fixture.open();
    let mut run = RunAggregate::create(
        &mut journal,
        &run_id,
        identity,
        run_metadata("child-run-create", "child-run-create-key"),
    )
    .unwrap();
    run.prepare(
        &mut journal,
        run_metadata("child-run-prepare", "child-run-prepare-key"),
    )
    .unwrap();
    run.start(
        &mut journal,
        run_metadata("child-run-start", "child-run-start-key"),
    )
    .unwrap();
    drop(journal);

    assert_eq!(
        fixture.gate(&[], &run_id),
        OperationalRecoveryGate::Quarantined
    );
}

#[test]
fn persisted_provider_response_is_evidence_first_without_provider_binding() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4().to_string();
    let provider = create_running_run(&fixture, &run_id);
    let mut journal = fixture.open();
    let run = RunAggregate::recover(&journal, &run_id).unwrap();
    let mut attempt = ProviderAttemptAggregate::create(
        &mut journal,
        &run_id,
        "attempt-1",
        attempt_definition(&run_id, provider),
        run.last_run_sequence(),
        provider_metadata("provider-request", "provider-request-key"),
    )
    .unwrap();
    attempt
        .mark_sent(
            &mut journal,
            run.last_run_sequence() + 1,
            "dispatch-1",
            provider_metadata("provider-sent", "provider-sent-key"),
        )
        .unwrap();
    attempt
        .respond_with_output(
            &mut journal,
            run.last_run_sequence() + 2,
            response_receipt(),
            Some("persisted output".to_owned()),
            vec![],
            provider_metadata("provider-response", "provider-response-key"),
        )
        .unwrap();
    drop(journal);

    assert_eq!(
        fixture.gate(&[], &run_id),
        OperationalRecoveryGate::RecoveryReady
    );
}

#[test]
fn sent_provider_attempt_requires_reconciliation_even_when_provider_is_bound() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4().to_string();
    let provider = create_running_run(&fixture, &run_id);
    let mut journal = fixture.open();
    let run = RunAggregate::recover(&journal, &run_id).unwrap();
    let mut attempt = ProviderAttemptAggregate::create(
        &mut journal,
        &run_id,
        "attempt-1",
        attempt_definition(&run_id, provider.clone()),
        run.last_run_sequence(),
        provider_metadata("provider-request", "provider-request-key"),
    )
    .unwrap();
    attempt
        .mark_sent(
            &mut journal,
            run.last_run_sequence() + 1,
            "dispatch-1",
            provider_metadata("provider-sent", "provider-sent-key"),
        )
        .unwrap();
    drop(journal);

    assert_eq!(
        fixture.gate(&[provider], &run_id),
        OperationalRecoveryGate::WaitingForReconciliation
    );
}

#[test]
fn running_tool_without_terminal_manifest_requires_reconciliation() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4().to_string();
    create_running_run(&fixture, &run_id);
    let mut journal = fixture.open();
    let run = RunAggregate::recover(&journal, &run_id).unwrap();
    let definition = ToolCallDefinition {
        provider_tool_call_id: "provider-call-1".to_owned(),
        tool_name: "read_project_file".to_owned(),
        schema_version: 1,
        arguments_hash: "a".repeat(64),
        attempt: 1,
        side_effect: ToolSideEffect::None,
        parallel: false,
    };
    let mut tool = ToolCallAggregate::create(
        &mut journal,
        &run_id,
        "tool-1",
        definition,
        run.last_run_sequence(),
        tool_metadata("tool-request", "tool-request-key"),
    )
    .unwrap();
    tool.authorize(
        &mut journal,
        run.last_run_sequence() + 1,
        tool_metadata("tool-authorize", "tool-authorize-key"),
    )
    .unwrap();
    tool.start(
        &mut journal,
        run.last_run_sequence() + 2,
        tool_metadata("tool-start", "tool-start-key"),
    )
    .unwrap();
    drop(journal);

    assert_eq!(
        fixture.gate(&[], &run_id),
        OperationalRecoveryGate::WaitingForReconciliation
    );
}

#[test]
fn approval_required_tool_waits_for_host_without_provider_binding() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4().to_string();
    create_running_run(&fixture, &run_id);
    let mut journal = fixture.open();
    let run = RunAggregate::recover(&journal, &run_id).unwrap();
    let mut tool = ToolCallAggregate::create(
        &mut journal,
        &run_id,
        "tool-approval",
        ToolCallDefinition {
            provider_tool_call_id: "provider-call-approval".to_owned(),
            tool_name: "write_project_file".to_owned(),
            schema_version: 1,
            arguments_hash: "a".repeat(64),
            attempt: 1,
            side_effect: ToolSideEffect::StagedWrite,
            parallel: false,
        },
        run.last_run_sequence(),
        tool_metadata("tool-request-approval", "tool-request-approval-key"),
    )
    .unwrap();
    tool.require_authorization(
        &mut journal,
        run.last_run_sequence() + 1,
        tool_metadata("tool-needs-approval", "tool-needs-approval-key"),
    )
    .unwrap();
    drop(journal);

    assert_eq!(
        fixture.gate(&[], &run_id),
        OperationalRecoveryGate::WaitingForApproval
    );
}

#[test]
fn terminal_tool_evidence_is_recovery_ready_without_provider_binding() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4().to_string();
    create_running_run(&fixture, &run_id);
    let mut journal = fixture.open();
    let run = RunAggregate::recover(&journal, &run_id).unwrap();
    let mut tool = ToolCallAggregate::create(
        &mut journal,
        &run_id,
        "tool-completed",
        ToolCallDefinition {
            provider_tool_call_id: "provider-call-completed".to_owned(),
            tool_name: "read_project_file".to_owned(),
            schema_version: 1,
            arguments_hash: "a".repeat(64),
            attempt: 1,
            side_effect: ToolSideEffect::None,
            parallel: false,
        },
        run.last_run_sequence(),
        tool_metadata("tool-request-completed", "tool-request-completed-key"),
    )
    .unwrap();
    tool.authorize(
        &mut journal,
        run.last_run_sequence() + 1,
        tool_metadata("tool-authorize-completed", "tool-authorize-completed-key"),
    )
    .unwrap();
    tool.start(
        &mut journal,
        run.last_run_sequence() + 2,
        tool_metadata("tool-start-completed", "tool-start-completed-key"),
    )
    .unwrap();
    tool.complete(
        &mut journal,
        run.last_run_sequence() + 3,
        tool_metadata("tool-complete", "tool-complete-key"),
    )
    .unwrap();
    drop(journal);

    assert_eq!(
        fixture.gate(&[], &run_id),
        OperationalRecoveryGate::RecoveryReady
    );
}

#[test]
fn multiple_active_agent_loops_quarantine_the_run() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4();
    create_running_run(&fixture, &run_id.to_string());
    let mut journal = fixture.open();
    let mut repository = AgentLoopJournalRepository::new(&mut journal);
    repository
        .create(
            &loop_service(run_id, "invocation-1"),
            "loop-create-1",
            loop_metadata("loop-message-1"),
        )
        .unwrap();
    repository
        .create(
            &loop_service(run_id, "invocation-2"),
            "loop-create-2",
            loop_metadata("loop-message-2"),
        )
        .unwrap();
    drop(journal);

    assert_eq!(
        fixture.gate(&[], &run_id.to_string()),
        OperationalRecoveryGate::Quarantined
    );
}

#[test]
fn terminal_run_projects_persisted_state_without_provider_binding() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4().to_string();
    create_running_run(&fixture, &run_id);
    let mut journal = fixture.open();
    let mut run = RunAggregate::recover(&journal, &run_id).unwrap();
    run.complete(
        &mut journal,
        run_metadata("run-complete", "run-complete-key"),
    )
    .unwrap();
    drop(journal);

    assert_eq!(
        fixture.gate(&[], &run_id),
        OperationalRecoveryGate::TerminalProjectionOnly
    );
}

fn create_running_run(fixture: &Fixture, run_id: &str) -> ProviderRunIdentity {
    let identity = support::pinned_identity();
    let provider = identity.provider.clone();
    let mut journal = fixture.open();
    let mut run = RunAggregate::create(
        &mut journal,
        run_id,
        identity,
        run_metadata("run-create", "run-create-key"),
    )
    .unwrap();
    run.prepare(&mut journal, run_metadata("run-prepare", "run-prepare-key"))
        .unwrap();
    run.start(&mut journal, run_metadata("run-start", "run-start-key"))
        .unwrap();
    provider
}

fn attempt_definition(run_id: &str, provider: ProviderRunIdentity) -> ProviderAttemptDefinition {
    ProviderAttemptDefinition {
        run_id: run_id.to_owned(),
        inference_id: "inference-1".to_owned(),
        invocation_id: "invocation-1".to_owned(),
        context_compilation_id: Uuid::new_v4(),
        canonical_context_sha256: "b".repeat(64),
        transport_payload_sha256: "c".repeat(64),
        provider,
        request_number: 1,
        attempt_number: 1,
        output_reserve_tokens: 4096,
        request_timeout_ms: 30_000,
        total_deadline_ms: 120_000,
        max_attempts: 3,
        max_total_delay_ms: 30_000,
    }
}

fn response_receipt() -> ProviderResponseReceipt {
    ProviderResponseReceipt {
        http_status: 200,
        actual_provider_id: "deepseek".to_owned(),
        actual_model_id: "deepseek-chat".to_owned(),
        response_id_sha256: Some("d".repeat(64)),
        response_body_sha256: "e".repeat(64),
        stop_reason: "stop".to_owned(),
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
    }
}

fn loop_service(run_id: Uuid, invocation_id: &str) -> AgentLoopService {
    let compilation_id = Uuid::new_v4();
    AgentLoopService::new(
        AgentLoopIdentity {
            run_id,
            project_id: "project-1".to_owned(),
            invocation_id: invocation_id.to_owned(),
            initial_context_compilation_id: compilation_id,
            source_scope: ToolSourceScope {
                source_checkpoint_id: "checkpoint-1".to_owned(),
                resource_ids: vec!["resource-1".to_owned()],
                scope_sha256: "f".repeat(64),
            },
            permission: ToolPermissionPolicy {
                mode: RunPermissionMode::Assist,
                policy_id: "policy-1".to_owned(),
                policy_version: "1".to_owned(),
                policy_sha256: "a".repeat(64),
            },
        },
        AgentLoopPolicy {
            maximum_tool_rounds: 4,
            tool_schema_version: 1,
        },
        InferenceDispatchIdentity {
            inference_id: Uuid::new_v4(),
            attempt_id: Uuid::new_v4(),
            request_number: 1,
            context_compilation_id: compilation_id,
            attempt_number: 1,
            inference_idempotency_key: format!("{invocation_id}:inference:1"),
        },
    )
    .unwrap()
}

fn run_metadata<'a>(message_id: &'a str, key: &'a str) -> EventMetadata<'a> {
    EventMetadata {
        message_id,
        idempotency_key: key,
        created_at: "2026-07-12T00:00:00Z",
        reason: None,
    }
}

fn provider_metadata<'a>(message_id: &'a str, key: &'a str) -> ProviderAttemptMetadata<'a> {
    ProviderAttemptMetadata {
        message_id,
        idempotency_key: key,
        created_at: "2026-07-12T00:00:00Z",
        reason: None,
    }
}

fn tool_metadata<'a>(message_id: &'a str, key: &'a str) -> ToolEventMetadata<'a> {
    ToolEventMetadata {
        message_id,
        idempotency_key: key,
        created_at: "2026-07-12T00:00:00Z",
        reason: None,
    }
}

fn loop_metadata(message_id: &str) -> AgentLoopEventMetadata<'_> {
    AgentLoopEventMetadata {
        message_id,
        created_at: "2026-07-12T00:00:00Z",
    }
}

struct Fixture {
    _temp: TempDir,
    path: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        Self { _temp: temp, path }
    }

    fn open(&self) -> EventJournal {
        EventJournal::open(&self.path).unwrap()
    }

    fn gate(&self, providers: &[ProviderRunIdentity], run_id: &str) -> OperationalRecoveryGate {
        let mut journal = self.open();
        let assignments = AssignmentRecoveryReport {
            assignments: vec![],
            quarantined: vec![],
        };
        let report = OperationalRecoveryScanner::new(&mut journal, &assignments, providers)
            .scan("workspace-1", "project-1")
            .unwrap();
        report
            .runs
            .into_iter()
            .find(|run| run.run_id == run_id)
            .unwrap()
            .gate
    }
}
