mod support;

use novelx_protocol::{ChildRunSpec, RevisionReference, child_run_pinned_identity_sha256};
use novelx_runtime::{
    agent_assignment_aggregate::{
        AgentAssignmentAggregate, AgentAssignmentIdentity, AgentAssignmentRepository,
        AssignmentDefinition, AssignmentEventMetadata, AssignmentScope, ChildAgentPermission,
        RevisionBinding,
    },
    agent_assignment_recovery::{
        AgentAssignmentRecoveryError, AssignmentRecoveryClassification, recover_agent_assignments,
    },
    event_journal::{EventJournal, NewRuntimeEvent},
    run_aggregate::{EventMetadata, RunAggregate, RunAggregateError},
    run_state::RunState,
    workspace_runtime_lease::{BoundWorkspaceRuntimeLease, WorkspaceRuntimeLease},
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

#[test]
fn recovery_is_stably_sorted_and_repeated_scans_write_no_events() {
    let fixture = Fixture::new();
    fixture.allocate("z-assignment", "parent-z");
    fixture.allocate("a-assignment", "parent-a");
    let running = fixture.start("m-assignment", "parent-m", "child-m");
    fixture.create_child(&running, RunState::Running, None);
    let before = fixture.event_counts();

    let first = recover_agent_assignments(&fixture.database, "workspace-1", "project-1").unwrap();
    let second = recover_agent_assignments(&fixture.database, "workspace-1", "project-1").unwrap();

    assert_eq!(first, second);
    assert_eq!(fixture.event_counts(), before);
    assert_eq!(
        first
            .assignments
            .iter()
            .map(|value| value.assignment_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a-assignment", "m-assignment", "z-assignment"]
    );
    assert_eq!(
        first.assignments[1].classification,
        AssignmentRecoveryClassification::RunningChild(RunState::Running)
    );
    assert!(first.quarantined.is_empty());
}

#[test]
fn classifies_cancellation_without_guessing_terminal_outcomes() {
    let fixture = Fixture::new();
    let no_child = fixture.allocate("cancel-no-child", "parent-1");
    fixture.request_cancel(&no_child);

    let active = fixture.start("cancel-active", "parent-2", "child-active");
    fixture.create_child(&active, RunState::Running, None);
    fixture.request_cancel(&active);

    let cancelled = fixture.start("cancel-done", "parent-3", "child-cancelled");
    fixture.create_child(&cancelled, RunState::Cancelled, None);
    fixture.request_cancel(&cancelled);

    let unknown = fixture.start("cancel-unknown", "parent-4", "child-blocked");
    fixture.create_child(&unknown, RunState::Blocked, None);
    fixture.request_cancel(&unknown);

    let report = recover_agent_assignments(&fixture.database, "workspace-1", "project-1").unwrap();
    let by_id = report
        .assignments
        .into_iter()
        .map(|value| (value.assignment_id.clone(), value.classification))
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(
        by_id["cancel-no-child"],
        AssignmentRecoveryClassification::ReadyToConfirmCancellation
    );
    assert_eq!(
        by_id["cancel-active"],
        AssignmentRecoveryClassification::CancellationPending
    );
    assert_eq!(
        by_id["cancel-done"],
        AssignmentRecoveryClassification::ReadyToConfirmCancellation
    );
    assert_eq!(
        by_id["cancel-unknown"],
        AssignmentRecoveryClassification::ReconciliationRequired
    );
}

#[test]
fn preserves_every_running_child_run_state_in_the_classification() {
    let states = [
        RunState::Created,
        RunState::Preparing,
        RunState::Running,
        RunState::WaitingForApproval,
        RunState::WaitingForReconciliation,
        RunState::Committing,
        RunState::Retrying,
        RunState::Blocked,
        RunState::Cancelled,
        RunState::Failed,
        RunState::Completed,
    ];
    for (index, expected) in states.into_iter().enumerate() {
        let fixture = Fixture::new();
        let assignment = fixture.start("assignment", "parent", "child");
        fixture.create_child(&assignment, expected, None);
        let values =
            recover_agent_assignments(&fixture.database, "workspace-1", "project-1").unwrap();
        assert_eq!(
            values.assignments[0].classification,
            AssignmentRecoveryClassification::RunningChild(expected),
            "case {index}"
        );
    }
}

#[test]
fn provisions_a_missing_child_from_spec_and_quarantines_terminal_mismatch() {
    let fixture = Fixture::new();
    fixture.start("missing", "parent-1", "missing-child");
    let report = recover_agent_assignments(&fixture.database, "workspace-1", "project-1").unwrap();
    assert_eq!(
        report.assignments[0].classification,
        AssignmentRecoveryClassification::ProvisionChildRun
    );
    let intent = report.assignments[0].provision_intent.as_ref().unwrap();
    assert_eq!(intent.saga.workspace_id, "workspace-1");
    assert_eq!(intent.saga.assignment_id, "missing");
    assert_eq!(intent.saga.allocation_revision, 1);
    assert_eq!(intent.saga.child_run_id, "missing-child");
    assert_eq!(
        intent.create_idempotency_key,
        format!(
            "assignment:missing:{}:child-run:create",
            intent.saga.allocation_sha256
        )
    );
    assert_eq!(
        intent.prepare_idempotency_key,
        format!(
            "assignment:missing:{}:child-run:prepare",
            intent.saga.allocation_sha256
        )
    );
    assert_eq!(
        intent.cancel_idempotency_key,
        format!(
            "assignment:missing:{}:cancel",
            intent.saga.allocation_sha256
        )
    );
    assert!(report.quarantined.is_empty());

    let fixture = Fixture::new();
    let running = fixture.start("terminal", "parent-2", "child-terminal");
    fixture.create_child(&running, RunState::Failed, None);
    fixture.complete_assignment(&running);
    let report = recover_agent_assignments(&fixture.database, "workspace-1", "project-1").unwrap();
    assert_eq!(
        report.assignments[0].classification,
        AssignmentRecoveryClassification::Quarantined
    );
    assert_eq!(report.quarantined.len(), 1);

    let fixture = Fixture::new();
    let allocated = fixture.allocate("tampered-spec", "parent-3");
    let mut spec = fixture.child_spec(&allocated, "child-tampered");
    spec.pinned_identity.assignment.as_mut().unwrap().sha256 = Some("9".repeat(64));
    spec.pinned_identity_sha256 = child_run_pinned_identity_sha256(&spec.pinned_identity).unwrap();
    AgentAssignmentRepository::open(&fixture.database)
        .unwrap()
        .start(
            "workspace-1",
            "tampered-spec",
            allocated.revision,
            spec,
            assignment_metadata("tampered-spec-start"),
        )
        .unwrap();
    let report = recover_agent_assignments(&fixture.database, "workspace-1", "project-1").unwrap();
    assert_eq!(
        report.assignments[0].classification,
        AssignmentRecoveryClassification::Quarantined
    );
    assert!(report.assignments[0].provision_intent.is_none());
    assert_eq!(report.quarantined.len(), 1);
}

#[test]
fn rejects_orphan_hash_mismatch_and_recursive_child_runs() {
    let fixture = Fixture::new();
    fixture.create_orphan("orphan-child", "missing-assignment", 1);
    let report = recover_agent_assignments(&fixture.database, "workspace-1", "project-1").unwrap();
    assert!(report.assignments.is_empty());
    assert_eq!(report.quarantined.len(), 1);

    let fixture = Fixture::new();
    let running = fixture.start("bad-hash", "parent-hash", "child-hash");
    fixture.create_child(&running, RunState::Created, Some("0".repeat(64)));
    let report = recover_agent_assignments(&fixture.database, "workspace-1", "project-1").unwrap();
    assert_eq!(
        report.assignments[0].classification,
        AssignmentRecoveryClassification::Quarantined
    );
    assert_eq!(report.quarantined.len(), 1);

    let fixture = Fixture::new();
    fixture.create_orphan("recursive-child", "missing-assignment", 2);
    assert!(matches!(
        recover_agent_assignments(&fixture.database, "workspace-1", "project-1"),
        Err(AgentAssignmentRecoveryError::Run(
            RunAggregateError::InvalidPinnedIdentity("delegation")
        ))
    ));
}

struct Fixture {
    _temp: TempDir,
    database: std::path::PathBuf,
    lease: BoundWorkspaceRuntimeLease,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("workspace.db");
        EventJournal::open(&database).unwrap();
        let lease = WorkspaceRuntimeLease::acquire(&database, "assignment-recovery")
            .unwrap()
            .bind_database(&database)
            .unwrap();
        Self {
            database,
            _temp: temp,
            lease,
        }
    }

    fn allocate(&self, assignment_id: &str, parent_run_id: &str) -> AgentAssignmentAggregate {
        self.create_parent(parent_run_id);
        AgentAssignmentRepository::open(&self.database)
            .unwrap()
            .allocate(
                AgentAssignmentIdentity {
                    assignment_id: assignment_id.into(),
                    workspace_id: "workspace-1".into(),
                    project_id: "project-1".into(),
                    goal: binding("goal-1", 'a'),
                    plan: binding("plan-1", 'b'),
                    plan_step_id: "step-1".into(),
                    parent_run_id: parent_run_id.into(),
                    parent_invocation_id: "invocation-1".into(),
                    child_profile_id: "checker".into(),
                },
                scope(),
                definition(),
                ChildAgentPermission::ReadOnly,
                assignment_metadata(&format!("{assignment_id}-allocate")),
            )
            .unwrap()
    }

    fn start(&self, assignment_id: &str, parent: &str, child: &str) -> AgentAssignmentAggregate {
        let allocated = self.allocate(assignment_id, parent);
        let spec = self.child_spec(&allocated, child);
        AgentAssignmentRepository::open(&self.database)
            .unwrap()
            .start(
                "workspace-1",
                assignment_id,
                allocated.revision,
                spec,
                assignment_metadata(&format!("{assignment_id}-start")),
            )
            .unwrap()
    }

    fn request_cancel(&self, assignment: &AgentAssignmentAggregate) {
        AgentAssignmentRepository::open(&self.database)
            .unwrap()
            .request_cancel(
                "workspace-1",
                &assignment.identity.assignment_id,
                assignment.revision,
                assignment_metadata(&format!("{}-cancel", assignment.identity.assignment_id)),
            )
            .unwrap();
    }

    fn complete_assignment(&self, assignment: &AgentAssignmentAggregate) {
        AgentAssignmentRepository::open(&self.database)
            .unwrap()
            .complete(
                "workspace-1",
                &assignment.identity.assignment_id,
                assignment.revision,
                vec![
                    novelx_runtime::agent_assignment_aggregate::CompletionEvidence {
                        kind: "artifact".into(),
                        reference: "artifact-1".into(),
                        sha256: "c".repeat(64),
                    },
                ],
                assignment_metadata(&format!("{}-complete", assignment.identity.assignment_id)),
            )
            .unwrap();
    }

    fn create_parent(&self, run_id: &str) {
        let mut identity = support::pinned_identity();
        identity.goal = Some(reference("goal-1", 1, 'a'));
        identity.plan = Some(reference("plan-1", 1, 'b'));
        let mut journal = EventJournal::open(&self.database).unwrap();
        RunAggregate::create(
            &mut journal,
            run_id,
            identity,
            run_metadata(&format!("{run_id}-create")),
        )
        .unwrap();
    }

    fn create_child(
        &self,
        assignment: &AgentAssignmentAggregate,
        state: RunState,
        hash_override: Option<String>,
    ) {
        let child_id = assignment.child_run_id.as_deref().unwrap();
        let mut identity = assignment
            .child_run_spec
            .as_ref()
            .unwrap()
            .pinned_identity
            .clone();
        if let Some(hash) = hash_override {
            identity.assignment.as_mut().unwrap().sha256 = Some(hash);
        }
        let mut journal = EventJournal::open(&self.database).unwrap();
        let mut child = RunAggregate::create(
            &mut journal,
            child_id,
            identity,
            run_metadata(&format!("{child_id}-create")),
        )
        .unwrap();
        advance(&mut child, &mut journal, &self.lease, state, child_id);
    }

    fn child_spec(
        &self,
        allocation: &AgentAssignmentAggregate,
        child_run_id: &str,
    ) -> ChildRunSpec {
        let mut pinned_identity = support::pinned_identity();
        pinned_identity.goal = Some(reference("goal-1", 1, 'a'));
        pinned_identity.plan = Some(reference("plan-1", 1, 'b'));
        pinned_identity.assignment = Some(RevisionReference {
            id: allocation.identity.assignment_id.clone(),
            revision: allocation.revision,
            sha256: Some(allocation.last_event_hash.clone()),
        });
        pinned_identity.parent_run_id = Some(allocation.identity.parent_run_id.clone());
        pinned_identity.delegation_depth = 1;
        pinned_identity.agent_profile.id = "checker".into();
        pinned_identity.scope_resource_ids = allocation.scope.resource_ids.clone();
        pinned_identity.resource_scope_sha256 = allocation.scope.scope_sha256.clone();
        pinned_identity.source_checkpoint_id = allocation.definition.source_checkpoint_id.clone();
        ChildRunSpec {
            child_run_id: child_run_id.into(),
            run_start_idempotency_key: format!("{child_run_id}-create"),
            pinned_identity_sha256: child_run_pinned_identity_sha256(&pinned_identity).unwrap(),
            pinned_identity,
        }
    }

    fn create_orphan(&self, run_id: &str, assignment_id: &str, depth: u32) {
        let mut identity = support::pinned_identity();
        identity.goal = Some(reference("goal-1", 1, 'a'));
        identity.plan = Some(reference("plan-1", 1, 'b'));
        identity.assignment = Some(reference(assignment_id, 2, 'c'));
        identity.parent_run_id = Some("parent-orphan".into());
        identity.delegation_depth = depth;
        let mut journal = EventJournal::open(&self.database).unwrap();
        if depth == 1 {
            RunAggregate::create(
                &mut journal,
                run_id,
                identity,
                run_metadata("orphan-create"),
            )
            .unwrap();
        } else {
            journal
                .append(
                    NewRuntimeEvent {
                        run_id: run_id.into(),
                        aggregate_type: "run".into(),
                        aggregate_id: run_id.into(),
                        message_id: "recursive-create-message".into(),
                        idempotency_key: "recursive-create".into(),
                        event_type: "run.created".into(),
                        event_version: 2,
                        payload: serde_json::json!({
                            "previousState": null,
                            "currentState": "created",
                            "reason": "corrupt fixture",
                            "pinnedIdentity": identity,
                        }),
                        created_at: "2026-07-12T00:00:00Z".into(),
                    },
                    0,
                    0,
                )
                .unwrap();
        }
    }

    fn event_counts(&self) -> (i64, i64) {
        let connection = Connection::open(&self.database).unwrap();
        (
            connection
                .query_row("SELECT count(*) FROM workspace_events", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            connection
                .query_row("SELECT count(*) FROM runtime_events", [], |row| row.get(0))
                .unwrap(),
        )
    }
}

fn advance(
    child: &mut RunAggregate,
    journal: &mut EventJournal,
    lease: &BoundWorkspaceRuntimeLease,
    state: RunState,
    id: &str,
) {
    if state == RunState::Created {
        return;
    }
    child
        .prepare(journal, run_metadata(&format!("{id}-prepare")))
        .unwrap();
    if state == RunState::Preparing {
        return;
    }
    child
        .start(journal, run_metadata(&format!("{id}-start")))
        .unwrap();
    match state {
        RunState::Running => {}
        RunState::WaitingForApproval => child
            .wait_for_approval(journal, run_metadata(&format!("{id}-approval")))
            .unwrap(),
        RunState::WaitingForReconciliation => child
            .wait_for_reconciliation(journal, run_metadata(&format!("{id}-reconcile")))
            .unwrap(),
        RunState::Committing => child
            .begin_commit(journal, run_metadata(&format!("{id}-commit")))
            .unwrap(),
        RunState::Retrying => child
            .retry(journal, run_metadata(&format!("{id}-retry")))
            .unwrap(),
        RunState::Cancelled => child
            .cancel(journal, lease, run_metadata(&format!("{id}-cancel")))
            .unwrap(),
        RunState::Failed => child
            .fail(journal, run_metadata(&format!("{id}-fail")))
            .unwrap(),
        RunState::Completed => child
            .complete(journal, run_metadata(&format!("{id}-complete")))
            .unwrap(),
        RunState::Blocked => child
            .block(journal, run_metadata(&format!("{id}-block")))
            .unwrap(),
        other => panic!("test helper does not implement {other:?}"),
    }
}

fn binding(id: &str, hash: char) -> RevisionBinding {
    RevisionBinding {
        id: id.into(),
        revision: 1,
        sha256: hash.to_string().repeat(64),
    }
}

fn reference(id: &str, revision: u64, hash: char) -> RevisionReference {
    RevisionReference {
        id: id.into(),
        revision,
        sha256: Some(hash.to_string().repeat(64)),
    }
}

fn scope() -> AssignmentScope {
    let resource_ids = vec!["resource-1".into(), "resource-2".into()];
    AssignmentScope {
        scope_sha256: scope_hash(&resource_ids),
        resource_ids,
    }
}

fn scope_hash(resources: &[String]) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(resources).unwrap())
    )
}

fn definition() -> AssignmentDefinition {
    AssignmentDefinition {
        bounded_objective: "Inspect sources".into(),
        source_checkpoint_id: "checkpoint-1".into(),
        expected_artifact: "source-report".into(),
        capabilities: vec!["project.read".into()],
    }
}

fn assignment_metadata(key: &str) -> AssignmentEventMetadata {
    AssignmentEventMetadata {
        message_id: format!("{key}-message"),
        idempotency_key: key.into(),
        created_at: "2026-07-12T00:00:00Z".into(),
    }
}

fn run_metadata(key: &str) -> EventMetadata<'_> {
    EventMetadata {
        message_id: Box::leak(format!("{key}-message").into_boxed_str()),
        idempotency_key: Box::leak(key.to_owned().into_boxed_str()),
        created_at: "2026-07-12T00:00:00Z",
        reason: Some("test"),
    }
}
