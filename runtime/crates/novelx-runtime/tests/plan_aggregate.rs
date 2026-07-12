use novelx_runtime::{
    plan_aggregate::{
        PlanAggregate, PlanAggregateError, PlanEventMetadata, PlanEvidence, PlanStep,
        PlanStepStatus,
    },
    workspace_event_journal::{NewWorkspaceEvent, WorkspaceEventJournal},
};
use serde_json::json;
use tempfile::tempdir;

fn metadata<'a>(message: &'a str, key: &'a str, at: &'a str) -> PlanEventMetadata<'a> {
    PlanEventMetadata {
        message_id: message,
        idempotency_key: key,
        created_at: at,
    }
}
fn step(id: &str, dependencies: &[&str], evidence: &[&str]) -> PlanStep {
    PlanStep {
        step_id: id.into(),
        purpose: format!("完成{id}"),
        dependencies: dependencies.iter().map(|v| (*v).into()).collect(),
        assigned_agent: Some("写作智能体".into()),
        capabilities: vec!["读取项目".into()],
        expected_artifact: format!("{id}产物"),
        required_evidence: evidence.iter().map(|v| (*v).into()).collect(),
        status: PlanStepStatus::Pending,
        completion_evidence: vec![],
    }
}
fn evidence(kind: &str) -> PlanEvidence {
    PlanEvidence {
        evidence_type: kind.into(),
        reference_id: "artifact-中文".into(),
        sha256: "a".repeat(64),
    }
}
fn fixture() -> (tempfile::TempDir, std::path::PathBuf, WorkspaceEventJournal) {
    let dir = tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let journal = WorkspaceEventJournal::open(&path).unwrap();
    (dir, path, journal)
}

#[test]
fn chinese_plan_restarts_and_old_revisions_remain_readable() {
    let (_dir, path, mut journal) = fixture();
    let mut plan = PlanAggregate::create(
        &mut journal,
        "工作区",
        "计划一",
        "目标一",
        3,
        vec![
            step("整理世界观", &[], &["artifact"]),
            step("撰写正文", &["整理世界观"], &["run_event"]),
        ],
        metadata("m1", "k1", "2026-07-12T01:00:00Z"),
    )
    .unwrap();
    plan.start_step(
        &mut journal,
        1,
        "整理世界观",
        metadata("m2", "k2", "2026-07-12T01:01:00Z"),
    )
    .unwrap();
    plan.complete_step(
        &mut journal,
        2,
        "整理世界观",
        vec![evidence("artifact")],
        metadata("m3", "k3", "2026-07-12T01:02:00Z"),
    )
    .unwrap();
    drop(journal);
    let journal = WorkspaceEventJournal::open(path).unwrap();
    let recovered = PlanAggregate::recover(&journal, "工作区", "计划一").unwrap();
    assert_eq!(recovered.goal_id(), "目标一");
    assert_eq!(recovered.current_revision().revision, 3);
    assert_eq!(
        recovered.revision(1).unwrap().steps[0].status,
        PlanStepStatus::Pending
    );
    assert_eq!(
        recovered.revision(2).unwrap().steps[0].status,
        PlanStepStatus::InProgress
    );
    assert_eq!(
        recovered.revision(3).unwrap().steps[0].completion_evidence[0].reference_id,
        "artifact-中文"
    );
}

#[test]
fn dependencies_and_evidence_fail_closed_without_writing() {
    let (_dir, _path, mut journal) = fixture();
    let mut plan = PlanAggregate::create(
        &mut journal,
        "w",
        "p",
        "g",
        1,
        vec![
            step("one", &[], &["artifact"]),
            step("two", &["one"], &["artifact"]),
        ],
        metadata("m1", "k1", "2026-07-12T01:00:00Z"),
    )
    .unwrap();
    assert!(matches!(
        plan.start_step(
            &mut journal,
            1,
            "two",
            metadata("m2", "k2", "2026-07-12T01:01:00Z")
        ),
        Err(PlanAggregateError::DependencyIncomplete { .. })
    ));
    plan.start_step(
        &mut journal,
        1,
        "one",
        metadata("m3", "k3", "2026-07-12T01:02:00Z"),
    )
    .unwrap();
    assert!(matches!(
        plan.complete_step(
            &mut journal,
            2,
            "one",
            vec![],
            metadata("m4", "k4", "2026-07-12T01:03:00Z")
        ),
        Err(PlanAggregateError::EvidenceRequired(_))
    ));
    assert_eq!(
        journal.current_stream_sequence("w", "plan", "p").unwrap(),
        2
    );
}

#[test]
fn expected_revision_rejects_stale_instances_and_concurrent_writers() {
    let (_dir, path, mut first_journal) = fixture();
    let mut first = PlanAggregate::create(
        &mut first_journal,
        "w",
        "p",
        "g",
        1,
        vec![step("one", &[], &["artifact"])],
        metadata("m1", "k1", "2026-07-12T01:00:00Z"),
    )
    .unwrap();
    let mut second_journal = WorkspaceEventJournal::open(path).unwrap();
    let mut second = PlanAggregate::recover(&second_journal, "w", "p").unwrap();
    first
        .start_step(
            &mut first_journal,
            1,
            "one",
            metadata("m2", "k2", "2026-07-12T01:01:00Z"),
        )
        .unwrap();
    let error = second
        .start_step(
            &mut second_journal,
            1,
            "one",
            metadata("m3", "k3", "2026-07-12T01:02:00Z"),
        )
        .unwrap_err();
    assert!(matches!(error, PlanAggregateError::Journal(_)));
    assert!(matches!(
        first.start_step(
            &mut first_journal,
            1,
            "one",
            metadata("m4", "k4", "2026-07-12T01:03:00Z")
        ),
        Err(PlanAggregateError::RevisionConflict {
            expected: 1,
            actual: 2
        })
    ));
}

#[test]
fn revision_preserves_goal_binding_and_goal_revision() {
    let (_dir, _path, mut journal) = fixture();
    let mut plan = PlanAggregate::create(
        &mut journal,
        "w",
        "p",
        "g",
        4,
        vec![step("one", &[], &["artifact"])],
        metadata("m1", "k1", "2026-07-12T01:00:00Z"),
    )
    .unwrap();
    plan.revise(
        &mut journal,
        1,
        7,
        vec![step("新步骤", &[], &["artifact"])],
        metadata("m2", "k2", "2026-07-12T01:01:00Z"),
    )
    .unwrap();
    assert_eq!(plan.goal_id(), "g");
    assert_eq!(plan.revision(1).unwrap().goal_revision, 4);
    assert_eq!(plan.revision(2).unwrap().goal_revision, 7);
}

#[test]
fn unknown_events_versions_and_corrupt_hashes_fail_closed() {
    for (event_type, version, mutate) in [
        ("plan.future", 1, false),
        ("plan.created", 9, false),
        ("plan.created", 1, true),
    ] {
        let (_dir, _path, mut journal) = fixture();
        let checkpoint = json!({ "revision": 1, "goalRevision": 1, "steps": [step("one", &[], &["artifact"])],
            "previousRevisionSha256": null, "revisionSha256": if mutate { "b".repeat(64) } else { "a".repeat(64) }, "createdAt": "2026-07-12T01:00:00Z" });
        journal
            .append(
                NewWorkspaceEvent {
                    workspace_id: "w".into(),
                    stream_type: "plan".into(),
                    stream_id: "p".into(),
                    message_id: "m".into(),
                    idempotency_key: "k".into(),
                    event_type: event_type.into(),
                    event_version: version,
                    payload: json!({"goalId":"g", "checkpoint": checkpoint}),
                    created_at: "2026-07-12T01:00:00Z".into(),
                },
                0,
                0,
            )
            .unwrap();
        let result = PlanAggregate::recover(&journal, "w", "p");
        if event_type == "plan.future" {
            assert!(matches!(result, Err(PlanAggregateError::UnknownEvent(_))));
        } else if version == 9 {
            assert!(matches!(
                result,
                Err(PlanAggregateError::UnknownEventVersion { .. })
            ));
        } else {
            assert!(matches!(
                result,
                Err(PlanAggregateError::CheckpointHashMismatch)
            ));
        }
    }
}
