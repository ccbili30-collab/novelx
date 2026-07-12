use std::sync::{Arc, Barrier};

use novelx_runtime::{
    agent_assignment_aggregate::{
        AgentAssignmentAggregate, AgentAssignmentError, AgentAssignmentIdentity,
        AgentAssignmentRepository, AgentAssignmentStatus, AssignmentDefinition,
        AssignmentEventMetadata, AssignmentScope, ChildAgentPermission, CompletionEvidence,
        RevisionBinding, replay,
    },
    workspace_event_journal::{NewWorkspaceEvent, WorkspaceEventJournal},
};
use serde_json::json;
use sha2::{Digest, Sha256};

#[test]
fn immutable_assignment_round_trips_after_restart() {
    let fixture = Fixture::new();
    let mut repository = fixture.open();
    let allocated = repository
        .allocate(
            identity(),
            scope(&["chapter-1", "world"]),
            definition(),
            ChildAgentPermission::ProposeChangeSet,
            metadata("m1", "k1"),
        )
        .unwrap();
    assert_eq!(allocated.status, AgentAssignmentStatus::Allocated);
    assert_eq!(allocated.identity.goal.revision, 4);
    assert_eq!(allocated.identity.plan.revision, 7);
    assert_eq!(
        allocated.definition.bounded_objective,
        "Audit chapter continuity without editing canon"
    );
    assert_eq!(allocated.definition.source_checkpoint_id, "checkpoint-9");
    assert_eq!(allocated.definition.expected_artifact, "continuity-report");
    drop(repository);

    let mut repository = fixture.open();
    let running = repository
        .start(
            "workspace",
            "assignment-1",
            1,
            "child-run-1".into(),
            metadata("m2", "k2"),
        )
        .unwrap();
    drop(repository);
    let recovered = fixture.open().load("workspace", "assignment-1").unwrap();
    assert_eq!(recovered, running);
    assert_eq!(recovered.child_run_id.as_deref(), Some("child-run-1"));
    let allocated_revision = fixture
        .open()
        .load_revision("workspace", "assignment-1", 1)
        .unwrap();
    assert_eq!(allocated_revision.status, AgentAssignmentStatus::Allocated);
    assert_eq!(allocated_revision.child_run_id, None);
    assert!(matches!(
        fixture.open().load_revision("workspace", "assignment-1", 3),
        Err(AgentAssignmentError::RevisionNotFound(3))
    ));
}

#[test]
fn scope_is_canonical_and_permission_is_closed() {
    let fixture = Fixture::new();
    let mut repository = fixture.open();
    assert!(matches!(
        repository.allocate(
            identity(),
            scope(&["world", "chapter-1"]),
            definition(),
            ChildAgentPermission::ReadOnly,
            metadata("m1", "k1")
        ),
        Err(AgentAssignmentError::NonCanonicalScope)
    ));
    let mut invalid = scope(&["chapter-1", "world"]);
    invalid.scope_sha256 = "0".repeat(64);
    assert!(matches!(
        repository.allocate(
            identity(),
            invalid,
            definition(),
            ChildAgentPermission::ReadOnly,
            metadata("m2", "k2")
        ),
        Err(AgentAssignmentError::ScopeHashMismatch)
    ));
    assert!(matches!(
        repository.allocate(
            identity(),
            scope(&[]),
            definition(),
            ChildAgentPermission::ReadOnly,
            metadata("m3", "k3")
        ),
        Err(AgentAssignmentError::InvalidScope)
    ));
    let mut uppercase = identity();
    uppercase.goal.sha256 = "A".repeat(64);
    assert!(matches!(
        repository.allocate(
            uppercase,
            scope(&["chapter-1"]),
            definition(),
            ChildAgentPermission::ReadOnly,
            metadata("m4", "k4")
        ),
        Err(AgentAssignmentError::InvalidRevisionBinding("goal"))
    ));
}

#[test]
fn definition_requires_bounded_fields_and_canonical_capabilities() {
    let fixture = Fixture::new();
    let mut repository = fixture.open();
    let mut invalid = definition();
    invalid.capabilities.reverse();
    assert!(matches!(
        repository.allocate(
            identity(),
            scope(&["chapter-1", "world"]),
            invalid,
            ChildAgentPermission::ReadOnly,
            metadata("m1", "k1")
        ),
        Err(AgentAssignmentError::NonCanonicalCapabilities)
    ));
    let mut invalid = definition();
    invalid.bounded_objective.clear();
    assert!(matches!(
        repository.allocate(
            identity(),
            scope(&["chapter-1", "world"]),
            invalid,
            ChildAgentPermission::ReadOnly,
            metadata("m2", "k2")
        ),
        Err(AgentAssignmentError::EmptyField("bounded_objective"))
    ));
    let mut invalid = definition();
    invalid.capabilities.clear();
    assert!(matches!(
        repository.allocate(
            identity(),
            scope(&["chapter-1", "world"]),
            invalid,
            ChildAgentPermission::ReadOnly,
            metadata("m3", "k3")
        ),
        Err(AgentAssignmentError::InvalidCapabilities)
    ));
}

#[test]
fn completion_evidence_wins_a_cancel_race_without_fabricating_cancellation() {
    let fixture = Fixture::new();
    let mut repository = allocated(&fixture);
    repository
        .start(
            "workspace",
            "assignment-1",
            1,
            "child-run-1".into(),
            metadata("m2", "k2"),
        )
        .unwrap();
    repository
        .request_cancel("workspace", "assignment-1", 2, metadata("m3", "k3"))
        .unwrap();
    let completed = repository
        .complete(
            "workspace",
            "assignment-1",
            3,
            vec![evidence()],
            metadata("m4", "k4"),
        )
        .unwrap();
    assert_eq!(completed.status, AgentAssignmentStatus::Completed);
    assert_eq!(completed.revision, 4);
}

#[test]
fn start_is_single_use_and_terminal_states_are_immutable() {
    let fixture = Fixture::new();
    let mut repository = allocated(&fixture);
    repository
        .start(
            "workspace",
            "assignment-1",
            1,
            "child-run-1".into(),
            metadata("m2", "k2"),
        )
        .unwrap();
    assert!(matches!(
        repository.start(
            "workspace",
            "assignment-1",
            2,
            "child-run-2".into(),
            metadata("m3", "k3")
        ),
        Err(AgentAssignmentError::InvalidTransition)
    ));
    let completed = repository
        .complete(
            "workspace",
            "assignment-1",
            2,
            vec![evidence()],
            metadata("m4", "k4"),
        )
        .unwrap();
    assert_eq!(completed.status, AgentAssignmentStatus::Completed);
    assert!(matches!(
        repository.request_cancel("workspace", "assignment-1", 3, metadata("m5", "k5")),
        Err(AgentAssignmentError::TerminalAssignment)
    ));
    assert_eq!(
        fixture
            .journal()
            .current_stream_sequence("workspace", "agent_assignment", "assignment-1")
            .unwrap(),
        3
    );
}

#[test]
fn cancellation_is_idempotent_and_recovery_preserves_exact_state() {
    let fixture = Fixture::new();
    let mut repository = allocated(&fixture);
    let requested = repository
        .request_cancel("workspace", "assignment-1", 1, metadata("m2", "k2"))
        .unwrap();
    let repeated = repository
        .request_cancel("workspace", "assignment-1", 2, metadata("m3", "k3"))
        .unwrap();
    assert_eq!(repeated, requested);
    assert_eq!(repeated.revision, 2);
    let cancelled = repository
        .confirm_cancelled("workspace", "assignment-1", 2, metadata("m4", "k4"))
        .unwrap();
    assert_eq!(cancelled.status, AgentAssignmentStatus::Cancelled);
    drop(repository);
    assert_eq!(
        fixture.open().load("workspace", "assignment-1").unwrap(),
        cancelled
    );
}

#[test]
fn completion_requires_hashed_evidence_and_does_not_write_parent_goal() {
    let fixture = Fixture::new();
    let mut repository = allocated(&fixture);
    repository
        .start(
            "workspace",
            "assignment-1",
            1,
            "child-run-1".into(),
            metadata("m2", "k2"),
        )
        .unwrap();
    assert!(matches!(
        repository.complete("workspace", "assignment-1", 2, vec![], metadata("m3", "k3")),
        Err(AgentAssignmentError::CompletionEvidenceRequired)
    ));
    let mut invalid = evidence();
    invalid.sha256 = "not-a-hash".into();
    assert!(matches!(
        repository.complete(
            "workspace",
            "assignment-1",
            2,
            vec![invalid],
            metadata("m4", "k4")
        ),
        Err(AgentAssignmentError::InvalidEvidenceHash)
    ));
    repository
        .complete(
            "workspace",
            "assignment-1",
            2,
            vec![evidence()],
            metadata("m5", "k5"),
        )
        .unwrap();
    assert_eq!(
        fixture
            .journal()
            .current_stream_sequence("workspace", "goal", "goal-1")
            .unwrap(),
        0
    );
}

#[test]
fn stale_concurrent_writers_fail_closed() {
    let fixture = Fixture::new();
    allocated(&fixture);
    let barrier = Arc::new(Barrier::new(3));
    let handles = (0..2)
        .map(|index| {
            let database = fixture.database.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let mut repository = AgentAssignmentRepository::open(database).unwrap();
                barrier.wait();
                repository.start(
                    "workspace",
                    "assignment-1",
                    1,
                    format!("child-run-{index}"),
                    metadata(&format!("m-{index}"), &format!("k-{index}")),
                )
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
}

#[test]
fn replay_rejects_unknown_version_sequence_gap_and_tampered_hash() {
    for (version, stream_sequence_gap, tamper_hash) in
        [(2, false, false), (1, true, false), (1, false, true)]
    {
        let fixture = Fixture::new();
        let mut source = fixture.open();
        source
            .allocate(
                identity(),
                scope(&["chapter-1", "world"]),
                definition(),
                ChildAgentPermission::ReadOnly,
                metadata("source-m", "source-k"),
            )
            .unwrap();
        let source_events = fixture
            .journal()
            .read_stream("workspace", "agent_assignment", "assignment-1", 0)
            .unwrap();
        let mut event = source_events[0].clone();
        event.event_version = version;
        if stream_sequence_gap {
            event.stream_sequence = 2;
        }
        if tamper_hash {
            event.payload["event_hash"] = json!("0".repeat(64));
        }
        let result = replay(&[event]);
        if version == 2 {
            assert!(matches!(
                result,
                Err(AgentAssignmentError::UnknownEventVersion { .. })
            ));
        } else if stream_sequence_gap {
            assert!(matches!(result, Err(AgentAssignmentError::SequenceGap)));
        } else {
            assert!(matches!(
                result,
                Err(AgentAssignmentError::EventIntegrityFailed { .. })
            ));
        }
    }
}

#[test]
fn replay_requires_event_type_to_match_payload_kind() {
    let fixture = Fixture::new();
    let mut repository = allocated(&fixture);
    repository
        .start(
            "workspace",
            "assignment-1",
            1,
            "child-run-1".into(),
            metadata("m2", "k2"),
        )
        .unwrap();
    let events = fixture
        .journal()
        .read_stream("workspace", "agent_assignment", "assignment-1", 0)
        .unwrap();
    assert_eq!(events[0].event_type, "agent_assignment.allocated");
    assert_eq!(events[1].event_type, "agent_assignment.started");
    let mut mismatched = events[1].clone();
    mismatched.event_type = "agent_assignment.completed".into();
    assert!(matches!(
        replay(&[events[0].clone(), mismatched]),
        Err(AgentAssignmentError::EventTypeMismatch { .. })
    ));
}

#[test]
fn journal_idempotency_conflicts_fail_closed() {
    let fixture = Fixture::new();
    let mut repository = fixture.open();
    let first = repository
        .allocate(
            identity(),
            scope(&["chapter-1", "world"]),
            definition(),
            ChildAgentPermission::ReadOnly,
            metadata("same-message", "same-key"),
        )
        .unwrap();
    assert_eq!(first.revision, 1);
    let retried = repository
        .allocate(
            identity(),
            scope(&["chapter-1", "world"]),
            definition(),
            ChildAgentPermission::ReadOnly,
            metadata_at("different-message", "same-key", "2026-07-12T11:00:00Z"),
        )
        .unwrap();
    assert_eq!(retried, first);

    let mut changed_definition = definition();
    changed_definition.expected_artifact = "different-artifact".into();
    assert!(matches!(
        repository.allocate(
            identity(),
            scope(&["chapter-1", "world"]),
            changed_definition,
            ChildAgentPermission::ReadOnly,
            metadata("third-message", "same-key")
        ),
        Err(AgentAssignmentError::IdempotencyIntentConflict)
    ));

    let mut second_identity = identity();
    second_identity.assignment_id = "assignment-2".into();
    assert!(matches!(
        repository.allocate(
            second_identity,
            scope(&["chapter-1", "world"]),
            definition(),
            ChildAgentPermission::ReadOnly,
            metadata("same-message", "other-key")
        ),
        Err(AgentAssignmentError::Journal(_))
    ));
}

fn identity() -> AgentAssignmentIdentity {
    AgentAssignmentIdentity {
        assignment_id: "assignment-1".into(),
        workspace_id: "workspace".into(),
        project_id: "project".into(),
        goal: RevisionBinding {
            id: "goal-1".into(),
            revision: 4,
            sha256: "a".repeat(64),
        },
        plan: RevisionBinding {
            id: "plan-1".into(),
            revision: 7,
            sha256: "b".repeat(64),
        },
        plan_step_id: "step-2".into(),
        parent_run_id: "parent-run".into(),
        parent_invocation_id: "invocation-3".into(),
        child_profile_id: "checker".into(),
    }
}

fn scope(ids: &[&str]) -> AssignmentScope {
    let resource_ids = ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
    AssignmentScope {
        scope_sha256: sha(&serde_json::to_vec(&resource_ids).unwrap()),
        resource_ids,
    }
}

fn definition() -> AssignmentDefinition {
    AssignmentDefinition {
        bounded_objective: "Audit chapter continuity without editing canon".into(),
        source_checkpoint_id: "checkpoint-9".into(),
        expected_artifact: "continuity-report".into(),
        capabilities: vec!["project.read".into(), "project.search".into()],
    }
}

fn evidence() -> CompletionEvidence {
    CompletionEvidence {
        kind: "artifact".into(),
        reference: "artifact-1".into(),
        sha256: "c".repeat(64),
    }
}

fn metadata(message_id: &str, idempotency_key: &str) -> AssignmentEventMetadata {
    metadata_at(message_id, idempotency_key, "2026-07-12T10:00:00Z")
}

fn metadata_at(
    message_id: &str,
    idempotency_key: &str,
    created_at: &str,
) -> AssignmentEventMetadata {
    AssignmentEventMetadata {
        message_id: message_id.into(),
        idempotency_key: idempotency_key.into(),
        created_at: created_at.into(),
    }
}

fn allocated(fixture: &Fixture) -> AgentAssignmentRepository {
    let mut repository = fixture.open();
    repository
        .allocate(
            identity(),
            scope(&["chapter-1", "world"]),
            definition(),
            ChildAgentPermission::ReadOnly,
            metadata("m1", "k1"),
        )
        .unwrap();
    repository
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct Fixture {
    _temp: tempfile::TempDir,
    database: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("workspace.db");
        Self {
            _temp: temp,
            database,
        }
    }

    fn open(&self) -> AgentAssignmentRepository {
        AgentAssignmentRepository::open(&self.database).unwrap()
    }

    fn journal(&self) -> WorkspaceEventJournal {
        WorkspaceEventJournal::open(&self.database).unwrap()
    }
}

#[allow(dead_code)]
fn raw_event(payload: serde_json::Value) -> NewWorkspaceEvent {
    NewWorkspaceEvent {
        workspace_id: "workspace".into(),
        stream_type: "agent_assignment".into(),
        stream_id: "assignment-1".into(),
        message_id: "raw-message".into(),
        idempotency_key: "raw-key".into(),
        event_type: "agent_assignment.event".into(),
        event_version: 1,
        payload,
        created_at: "2026-07-12T10:00:00Z".into(),
    }
}

#[allow(dead_code)]
fn assert_aggregate(_: &AgentAssignmentAggregate) {}
