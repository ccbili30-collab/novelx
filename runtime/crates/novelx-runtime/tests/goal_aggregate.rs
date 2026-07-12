use std::sync::{Arc, Barrier};

use novelx_runtime::{
    goal_aggregate::{
        AcceptanceCriterion, EventMetadata, EvidenceRef, GoalActor, GoalAggregateError,
        GoalAggregateRepository, GoalBlocker, GoalCheckpoint, GoalDefinition, GoalIdentity,
        GoalPermissionMode, GoalStatus, replay,
    },
    workspace_event_journal::{NewWorkspaceEvent, WorkspaceEventJournal},
};
use serde_json::json;

#[test]
fn chinese_goal_round_trips_after_restart_with_all_identity_and_definition_fields() {
    let fixture = Fixture::new();
    let mut repository = fixture.open();
    let created = repository
        .create(identity(), completed_definition(), "m1", "k1", timestamp())
        .unwrap();
    assert_eq!(created.definition.objective, "完成银湾世界观的可审计整理");
    assert_eq!(created.identity.project_id, "项目-银湾");
    assert_eq!(created.identity.session_id, "会话-主线");
    assert_eq!(
        created.definition.permission_mode,
        GoalPermissionMode::Assist
    );
    drop(repository);

    let reopened = fixture.open();
    assert_eq!(reopened.load("工作区-一", "目标-一").unwrap(), created);
}

#[test]
fn expected_revision_rejects_stale_concurrent_writer() {
    let fixture = Fixture::new();
    fixture
        .open()
        .create(identity(), incomplete_definition(), "m1", "k1", timestamp())
        .unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let handles = (0..2)
        .map(|index| {
            let database = fixture.database.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let mut repository = GoalAggregateRepository::open(database).unwrap();
                barrier.wait();
                repository.revise(
                    "工作区-一",
                    "目标-一",
                    1,
                    if index == 0 {
                        completed_definition()
                    } else {
                        incomplete_definition()
                    },
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
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                Err(GoalAggregateError::RevisionConflict {
                    expected: 1,
                    actual: 2
                })
            ))
            .count(),
        1
    );
}

#[test]
fn child_and_non_owner_cannot_complete_and_required_evidence_is_enforced() {
    let fixture = Fixture::new();
    let mut repository = fixture.open();
    repository
        .create(identity(), incomplete_definition(), "m1", "k1", timestamp())
        .unwrap();
    repository
        .propose_completion(
            "工作区-一",
            "目标-一",
            1,
            vec![evidence("run", "运行-1")],
            metadata("m2", "k2"),
        )
        .unwrap();
    for actor in [
        GoalActor {
            agent_id: "代理-子级".into(),
            is_child_agent: true,
        },
        GoalActor {
            agent_id: "代理-其他".into(),
            is_child_agent: false,
        },
    ] {
        assert!(matches!(
            repository.complete(
                "工作区-一",
                "目标-一",
                2,
                &actor,
                vec![],
                metadata(
                    &format!("m-{}", actor.agent_id),
                    &format!("k-{}", actor.agent_id)
                )
            ),
            Err(GoalAggregateError::CompletionForbidden)
        ));
    }
    assert!(matches!(
        repository.complete(
            "工作区-一",
            "目标-一",
            2,
            &owner(),
            vec![],
            metadata("m5", "k5")
        ),
        Err(GoalAggregateError::RequiredCriteriaUnsatisfied)
    ));
}

#[test]
fn blocker_prevents_completion_until_reactivated_and_owner_supplies_evidence() {
    let fixture = Fixture::new();
    let mut repository = fixture.open();
    repository
        .create(identity(), completed_definition(), "m1", "k1", timestamp())
        .unwrap();
    repository
        .block(
            "工作区-一",
            "目标-一",
            1,
            GoalBlocker {
                blocker_id: "阻塞-1".into(),
                description: "真实模型尚未连通".into(),
                evidence_refs: vec![evidence("log", "日志-1")],
            },
            metadata("m2", "k2"),
        )
        .unwrap();
    assert!(matches!(
        repository.complete(
            "工作区-一",
            "目标-一",
            2,
            &owner(),
            vec![evidence("test", "测试-1")],
            metadata("m3", "k3")
        ),
        Err(GoalAggregateError::InvalidTransition)
    ));
    repository
        .reactivate("工作区-一", "目标-一", 2, metadata("m4", "k4"))
        .unwrap();
    repository
        .propose_completion(
            "工作区-一",
            "目标-一",
            3,
            vec![evidence("test", "测试-1")],
            metadata("m5", "k5"),
        )
        .unwrap();
    let completed = repository
        .complete(
            "工作区-一",
            "目标-一",
            4,
            &owner(),
            vec![evidence("audit", "审计-1")],
            metadata("m6", "k6"),
        )
        .unwrap();
    assert_eq!(completed.status, GoalStatus::Completed);
    assert_eq!(completed.revision, 5);
    assert!(completed.blockers.is_empty());
    assert_eq!(completed.evidence_refs.len(), 2);
}

#[test]
fn unknown_event_version_and_corrupt_payload_fail_closed() {
    let fixture = Fixture::new();
    let mut journal = WorkspaceEventJournal::open(&fixture.database).unwrap();
    journal
        .append(raw_event(2, json!({"anything": true}), "m1", "k1"), 0, 0)
        .unwrap();
    let events = journal
        .read_stream("工作区-一", "goal", "目标-一", 0)
        .unwrap();
    assert!(matches!(
        replay(None, &events),
        Err(GoalAggregateError::UnsupportedEventVersion(2))
    ));

    let second = Fixture::new();
    let mut journal = WorkspaceEventJournal::open(&second.database).unwrap();
    journal
        .append(raw_event(1, json!({"broken": "payload"}), "m2", "k2"), 0, 0)
        .unwrap();
    let events = journal
        .read_stream("工作区-一", "goal", "目标-一", 0)
        .unwrap();
    assert!(matches!(
        replay(None, &events),
        Err(GoalAggregateError::CorruptEventPayload)
    ));
}

#[test]
fn tampered_checkpoint_and_hash_chain_fail_closed() {
    let fixture = Fixture::new();
    let mut repository = fixture.open();
    let created = repository
        .create(identity(), completed_definition(), "m1", "k1", timestamp())
        .unwrap();
    let mut checkpoint = GoalCheckpoint::create(created).unwrap();
    checkpoint.aggregate.definition.objective = "篡改后的目标".into();
    assert!(matches!(
        replay(Some(&checkpoint), &[]),
        Err(GoalAggregateError::CheckpointIntegrityFailed)
    ));

    let journal = WorkspaceEventJournal::open(&fixture.database).unwrap();
    let mut payload = journal
        .read_stream("工作区-一", "goal", "目标-一", 0)
        .unwrap()[0]
        .payload
        .clone();
    payload["event_hash"] = json!("0".repeat(64));
    let isolated = Fixture::new();
    let mut isolated_journal = WorkspaceEventJournal::open(&isolated.database).unwrap();
    isolated_journal
        .append(raw_event(1, payload, "m9", "k9"), 0, 0)
        .unwrap();
    let events = isolated_journal
        .read_stream("工作区-一", "goal", "目标-一", 0)
        .unwrap();
    assert!(matches!(
        replay(None, &events),
        Err(GoalAggregateError::EventIntegrityFailed { revision: 1 })
    ));
}

fn identity() -> GoalIdentity {
    GoalIdentity {
        workspace_id: "工作区-一".into(),
        project_id: "项目-银湾".into(),
        session_id: "会话-主线".into(),
        goal_id: "目标-一".into(),
        owner_agent_id: "代理-管家".into(),
    }
}

fn completed_definition() -> GoalDefinition {
    GoalDefinition {
        objective: "完成银湾世界观的可审计整理".into(),
        scope: vec!["世界观".into(), "角色关系".into()],
        acceptance_criteria: vec![AcceptanceCriterion {
            criterion_id: "标准-1".into(),
            description: "真实回放通过".into(),
            required: true,
            satisfied: true,
            evidence_refs: vec![evidence("test", "测试-回放")],
        }],
        constraints: vec!["不得伪造模型输出".into()],
        permission_mode: GoalPermissionMode::Assist,
    }
}

fn incomplete_definition() -> GoalDefinition {
    let mut definition = completed_definition();
    definition.acceptance_criteria[0].satisfied = false;
    definition.acceptance_criteria[0].evidence_refs.clear();
    definition
}

fn evidence(kind: &str, reference: &str) -> EvidenceRef {
    EvidenceRef {
        kind: kind.into(),
        reference: reference.into(),
        description: "可复核证据".into(),
    }
}

fn owner() -> GoalActor {
    GoalActor {
        agent_id: "代理-管家".into(),
        is_child_agent: false,
    }
}

fn metadata(message_id: &str, key: &str) -> EventMetadata {
    EventMetadata {
        message_id: message_id.into(),
        idempotency_key: key.into(),
        created_at: timestamp().into(),
    }
}

fn timestamp() -> &'static str {
    "2026-07-12T08:00:00Z"
}

fn raw_event(
    version: u32,
    payload: serde_json::Value,
    message_id: &str,
    key: &str,
) -> NewWorkspaceEvent {
    NewWorkspaceEvent {
        workspace_id: "工作区-一".into(),
        stream_type: "goal".into(),
        stream_id: "目标-一".into(),
        message_id: message_id.into(),
        idempotency_key: key.into(),
        event_type: "goal.event".into(),
        event_version: version,
        payload,
        created_at: timestamp().into(),
    }
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
    fn open(&self) -> GoalAggregateRepository {
        GoalAggregateRepository::open(&self.database).unwrap()
    }
}
