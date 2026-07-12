mod support;

use novelx_protocol::{RevisionReference, RunStart};
use novelx_runtime::{
    event_journal::EventJournal,
    goal_aggregate::{
        AcceptanceCriterion, GoalAggregateRepository, GoalDefinition, GoalIdentity,
        GoalPermissionMode, GoalScope,
    },
    plan_aggregate::{PlanAggregate, PlanEventMetadata, PlanStep, PlanStepStatus},
    run_command_service::{RunCommandService, WorkspaceBinding},
    run_pin_validator::{RunPinValidationError, RunPinValidator},
    workspace_event_journal::WorkspaceEventJournal,
};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn validates_exact_goal_and_plan_revisions_with_hashes_and_scope() {
    let fixture = Fixture::new();
    let (goal, plan) = fixture.seed();
    let mut identity = pinned_identity();
    identity.goal = Some(RevisionReference {
        id: goal.identity.goal_id.clone(),
        revision: goal.revision,
        sha256: Some(goal.last_event_hash.clone()),
    });
    identity.plan = Some(RevisionReference {
        id: plan.plan_id().to_owned(),
        revision: plan.current_revision().revision,
        sha256: Some(plan.current_revision().revision_sha256.clone()),
    });

    let receipt = RunPinValidator::new(&fixture.database)
        .validate(&identity)
        .unwrap();
    assert_eq!(receipt.goal_sha256, Some(goal.last_event_hash));
    assert_eq!(
        receipt.plan_sha256,
        Some(plan.current_revision().revision_sha256.clone())
    );
}

#[test]
fn rejects_missing_hash_scope_revision_and_plan_without_goal() {
    let fixture = Fixture::new();
    let (goal, plan) = fixture.seed();
    let validator = RunPinValidator::new(&fixture.database);
    let mut identity = pinned_identity();
    identity.plan = Some(RevisionReference {
        id: plan.plan_id().to_owned(),
        revision: 1,
        sha256: Some(plan.current_revision().revision_sha256.clone()),
    });
    assert!(matches!(
        validator.validate(&identity),
        Err(RunPinValidationError::PlanWithoutGoal)
    ));

    identity.goal = Some(RevisionReference {
        id: goal.identity.goal_id.clone(),
        revision: 99,
        sha256: Some(goal.last_event_hash.clone()),
    });
    identity.plan = None;
    assert!(matches!(
        validator.validate(&identity),
        Err(RunPinValidationError::GoalRevisionNotFound)
    ));

    identity.goal = Some(RevisionReference {
        id: goal.identity.goal_id.clone(),
        revision: goal.revision,
        sha256: Some("0".repeat(64)),
    });
    assert!(matches!(
        validator.validate(&identity),
        Err(RunPinValidationError::GoalHashMismatch)
    ));

    identity.goal.as_mut().unwrap().sha256 = Some(goal.last_event_hash);
    identity.scope_resource_ids = vec!["resource-outside".to_owned()];
    identity.resource_scope_sha256 = scope_sha(&identity.scope_resource_ids);
    assert!(matches!(
        validator.validate(&identity),
        Err(RunPinValidationError::GoalScopeConflict)
    ));
}

#[test]
fn invalid_pin_blocks_run_start_without_writing_a_run_event() {
    let fixture = Fixture::new();
    let mut identity = pinned_identity();
    identity.goal = Some(RevisionReference {
        id: "missing-goal".to_owned(),
        revision: 1,
        sha256: Some("0".repeat(64)),
    });
    let mut journal = Some(EventJournal::open(&fixture.database).unwrap());
    let binding = WorkspaceBinding {
        project_id: "project-1".to_owned(),
        workspace_id: "workspace-1".to_owned(),
    };
    let validator = RunPinValidator::new(&fixture.database);
    let run_id = Uuid::new_v4();
    let error = RunCommandService::new(&mut journal, Some(&binding))
        .with_pin_validator(&validator)
        .start(
            run_id,
            Uuid::new_v4(),
            RunStart {
                start_idempotency_key: "invalid-pin-start".to_owned(),
                pinned_identity: identity,
            },
        )
        .unwrap_err();
    assert_eq!(error.error.code, "RUN_GOAL_PIN_NOT_FOUND");
    assert!(
        journal
            .as_ref()
            .unwrap()
            .read_run(&run_id.to_string(), 0)
            .unwrap()
            .is_empty()
    );
}

struct Fixture {
    _temp: TempDir,
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

    fn seed(&self) -> (novelx_runtime::goal_aggregate::GoalAggregate, PlanAggregate) {
        let resource_ids = vec!["resource-1".to_owned(), "resource-2".to_owned()];
        let mut goals = GoalAggregateRepository::open(&self.database).unwrap();
        let goal = goals
            .create(
                GoalIdentity {
                    workspace_id: "workspace-1".to_owned(),
                    project_id: "project-1".to_owned(),
                    session_id: "session-1".to_owned(),
                    goal_id: "goal-1".to_owned(),
                    owner_agent_id: "steward".to_owned(),
                },
                GoalDefinition {
                    objective: "整理世界资料".to_owned(),
                    scope: GoalScope {
                        scope_sha256: scope_sha(&resource_ids),
                        resource_ids,
                    },
                    acceptance_criteria: vec![AcceptanceCriterion {
                        criterion_id: "criterion-1".to_owned(),
                        description: "资料来源可审计".to_owned(),
                        required: true,
                        satisfied: false,
                        evidence_refs: vec![],
                    }],
                    constraints: vec!["不得编造来源".to_owned()],
                    permission_mode: GoalPermissionMode::Assist,
                },
                "goal-create-message",
                "goal-create-key",
                "2026-07-12T00:00:00Z",
            )
            .unwrap();
        let mut journal = WorkspaceEventJournal::open(&self.database).unwrap();
        let plan = PlanAggregate::create(
            &mut journal,
            "workspace-1",
            "plan-1",
            "goal-1",
            goal.revision,
            vec![PlanStep {
                step_id: "step-1".to_owned(),
                purpose: "读取资料".to_owned(),
                dependencies: vec![],
                assigned_agent: Some("steward".to_owned()),
                capabilities: vec!["project.read".to_owned()],
                expected_artifact: "source-report".to_owned(),
                required_evidence: vec!["artifact".to_owned()],
                status: PlanStepStatus::Pending,
                completion_evidence: vec![],
            }],
            PlanEventMetadata {
                message_id: "plan-create-message",
                idempotency_key: "plan-create-key",
                created_at: "2026-07-12T00:00:01Z",
            },
        )
        .unwrap();
        (goal, plan)
    }
}

fn scope_sha(resource_ids: &[String]) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(resource_ids).unwrap())
    )
}
