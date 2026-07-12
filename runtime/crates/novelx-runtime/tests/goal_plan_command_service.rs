use novelx_protocol::{
    GoalAcceptanceCriterion, GoalActor, GoalComplete, GoalCompletionPropose, GoalCreate,
    GoalDefinition, GoalEvidenceReference, GoalGet, GoalPermissionMode, GoalRevise, GoalScope,
    GoalStatus, PlanCreate, PlanEvidence, PlanGet, PlanRevise, PlanStep, PlanStepComplete,
    PlanStepStart, PlanStepStatus, RuntimeErrorClass,
};
use novelx_runtime::{
    goal_plan_command_service::GoalPlanCommandService, run_command_service::WorkspaceBinding,
};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn goal_and_plan_commands_round_trip_exact_revisions_and_evidence() {
    let fixture = Fixture::new();
    let service = fixture.service();

    let created = service
        .create_goal(
            Uuid::new_v4(),
            goal_create("goal-1", incomplete_definition()),
        )
        .unwrap();
    assert_eq!(created.revision, 1);
    assert_eq!(
        service
            .get_goal(GoalGet {
                goal_id: "goal-1".into(),
                revision: Some(1),
            })
            .unwrap(),
        created
    );

    let revised = service
        .revise_goal(
            Uuid::new_v4(),
            GoalRevise {
                revise_idempotency_key: "goal-revise-1".into(),
                goal_id: "goal-1".into(),
                expected_revision: 1,
                definition: completed_definition(),
            },
        )
        .unwrap();
    assert_eq!(revised.revision, 2);

    let proposed = service
        .propose_goal_completion(
            Uuid::new_v4(),
            GoalCompletionPropose {
                propose_idempotency_key: "goal-propose-1".into(),
                goal_id: "goal-1".into(),
                expected_revision: 2,
                evidence_refs: vec![goal_evidence()],
            },
        )
        .unwrap();
    assert_eq!(proposed.status, GoalStatus::CompletionProposed);

    let completed = service
        .complete_goal(
            Uuid::new_v4(),
            GoalComplete {
                complete_idempotency_key: "goal-complete-1".into(),
                goal_id: "goal-1".into(),
                expected_revision: 3,
                actor: GoalActor {
                    agent_id: "steward".into(),
                    is_child_agent: false,
                },
                evidence_refs: vec![goal_evidence()],
            },
        )
        .unwrap();
    assert_eq!(completed.status, GoalStatus::Completed);

    service
        .create_goal(
            Uuid::new_v4(),
            goal_create("goal-plan", incomplete_definition()),
        )
        .unwrap();
    let plan = service
        .create_plan(
            Uuid::new_v4(),
            PlanCreate {
                create_idempotency_key: "plan-create-1".into(),
                plan_id: "plan-1".into(),
                goal_id: "goal-plan".into(),
                goal_revision: 1,
                steps: vec![plan_step()],
            },
        )
        .unwrap();
    assert_eq!(plan.current_revision.revision, 1);

    let revised_plan = service
        .revise_plan(
            Uuid::new_v4(),
            PlanRevise {
                revise_idempotency_key: "plan-revise-1".into(),
                plan_id: "plan-1".into(),
                expected_revision: 1,
                goal_revision: 1,
                steps: vec![plan_step()],
            },
        )
        .unwrap();
    assert_eq!(revised_plan.current_revision.revision, 2);

    let started = service
        .start_plan_step(
            Uuid::new_v4(),
            PlanStepStart {
                start_idempotency_key: "plan-start-1".into(),
                plan_id: "plan-1".into(),
                expected_revision: 2,
                step_id: "step-1".into(),
            },
        )
        .unwrap();
    assert_eq!(
        started.current_revision.steps[0].status,
        PlanStepStatus::InProgress
    );

    let finished = service
        .complete_plan_step(
            Uuid::new_v4(),
            PlanStepComplete {
                complete_idempotency_key: "plan-complete-1".into(),
                plan_id: "plan-1".into(),
                expected_revision: 3,
                step_id: "step-1".into(),
                evidence: vec![plan_evidence()],
            },
        )
        .unwrap();
    assert_eq!(
        finished.current_revision.steps[0].status,
        PlanStepStatus::Completed
    );
    assert_eq!(finished.current_revision.revision, 4);
    assert_eq!(
        service
            .get_plan(PlanGet {
                plan_id: "plan-1".into(),
                revision: Some(2),
            })
            .unwrap()
            .current_revision
            .revision,
        2
    );

    drop(service);
    let reopened = fixture.service();
    assert_eq!(
        reopened
            .get_goal(GoalGet {
                goal_id: "goal-1".into(),
                revision: Some(4),
            })
            .unwrap()
            .status,
        GoalStatus::Completed
    );
    assert_eq!(
        reopened
            .get_plan(PlanGet {
                plan_id: "plan-1".into(),
                revision: None,
            })
            .unwrap()
            .current_revision
            .revision,
        4
    );
}

#[test]
fn plan_rejects_missing_stale_foreign_and_terminal_goal_revisions() {
    let fixture = Fixture::new();
    let service = fixture.service();

    let missing = service
        .create_plan(Uuid::new_v4(), plan_create("missing", 1))
        .unwrap_err();
    assert_eq!(missing.error.code, "GOAL_NOT_FOUND");

    service
        .create_goal(
            Uuid::new_v4(),
            goal_create("goal-1", incomplete_definition()),
        )
        .unwrap();
    let stale = service
        .create_plan(Uuid::new_v4(), plan_create("goal-1", 2))
        .unwrap_err();
    assert_eq!(stale.error.code, "GOAL_REVISION_NOT_FOUND");
    assert_eq!(stale.error.class, RuntimeErrorClass::StaleVersion);

    let foreign_binding = WorkspaceBinding {
        workspace_id: fixture.binding.workspace_id.clone(),
        project_id: "project-foreign".into(),
    };
    let foreign = GoalPlanCommandService::new(&fixture.database_path, &foreign_binding)
        .create_plan(Uuid::new_v4(), plan_create("goal-1", 1))
        .unwrap_err();
    assert_eq!(foreign.error.code, "GOAL_WORKSPACE_BINDING_CONFLICT");

    service
        .revise_goal(
            Uuid::new_v4(),
            GoalRevise {
                revise_idempotency_key: "revise-complete".into(),
                goal_id: "goal-1".into(),
                expected_revision: 1,
                definition: completed_definition(),
            },
        )
        .unwrap();
    service
        .propose_goal_completion(
            Uuid::new_v4(),
            GoalCompletionPropose {
                propose_idempotency_key: "propose-complete".into(),
                goal_id: "goal-1".into(),
                expected_revision: 2,
                evidence_refs: vec![goal_evidence()],
            },
        )
        .unwrap();
    service
        .complete_goal(
            Uuid::new_v4(),
            GoalComplete {
                complete_idempotency_key: "complete-goal".into(),
                goal_id: "goal-1".into(),
                expected_revision: 3,
                actor: GoalActor {
                    agent_id: "steward".into(),
                    is_child_agent: false,
                },
                evidence_refs: vec![goal_evidence()],
            },
        )
        .unwrap();
    let terminal = service
        .create_plan(Uuid::new_v4(), plan_create("goal-1", 4))
        .unwrap_err();
    assert_eq!(terminal.error.code, "PLAN_GOAL_REVISION_UNUSABLE");
}

#[test]
fn revision_conflicts_and_forbidden_completion_are_typed_nonfatal_domain_errors() {
    let fixture = Fixture::new();
    let service = fixture.service();
    service
        .create_goal(
            Uuid::new_v4(),
            goal_create("goal-1", incomplete_definition()),
        )
        .unwrap();

    let stale = service
        .revise_goal(
            Uuid::new_v4(),
            GoalRevise {
                revise_idempotency_key: "stale".into(),
                goal_id: "goal-1".into(),
                expected_revision: 2,
                definition: incomplete_definition(),
            },
        )
        .unwrap_err();
    assert_eq!(stale.error.code, "GOAL_REVISION_CONFLICT");
    assert!(stale.error.retryable);

    service
        .revise_goal(
            Uuid::new_v4(),
            GoalRevise {
                revise_idempotency_key: "valid-revise".into(),
                goal_id: "goal-1".into(),
                expected_revision: 1,
                definition: completed_definition(),
            },
        )
        .unwrap();
    service
        .propose_goal_completion(
            Uuid::new_v4(),
            GoalCompletionPropose {
                propose_idempotency_key: "valid-propose".into(),
                goal_id: "goal-1".into(),
                expected_revision: 2,
                evidence_refs: vec![goal_evidence()],
            },
        )
        .unwrap();
    let forbidden = service
        .complete_goal(
            Uuid::new_v4(),
            GoalComplete {
                complete_idempotency_key: "child-complete".into(),
                goal_id: "goal-1".into(),
                expected_revision: 3,
                actor: GoalActor {
                    agent_id: "child".into(),
                    is_child_agent: true,
                },
                evidence_refs: vec![goal_evidence()],
            },
        )
        .unwrap_err();
    assert_eq!(forbidden.error.code, "GOAL_OPERATION_FORBIDDEN");
    assert!(!forbidden.error.retryable);
}

struct Fixture {
    _temp: TempDir,
    database_path: std::path::PathBuf,
    binding: WorkspaceBinding,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let database_path = temp.path().join("workspace.db");
        Self {
            _temp: temp,
            database_path,
            binding: WorkspaceBinding {
                workspace_id: "workspace-1".into(),
                project_id: "project-1".into(),
            },
        }
    }

    fn service(&self) -> GoalPlanCommandService<'_> {
        GoalPlanCommandService::new(&self.database_path, &self.binding)
    }
}

fn goal_create(goal_id: &str, definition: GoalDefinition) -> GoalCreate {
    GoalCreate {
        create_idempotency_key: format!("create-{goal_id}"),
        goal_id: goal_id.into(),
        session_id: "session-1".into(),
        owner_agent_id: "steward".into(),
        definition,
    }
}

fn incomplete_definition() -> GoalDefinition {
    definition(false)
}

fn completed_definition() -> GoalDefinition {
    definition(true)
}

fn definition(satisfied: bool) -> GoalDefinition {
    let resource_ids = vec!["resource-a".to_owned(), "resource-b".to_owned()];
    GoalDefinition {
        objective: "Complete the auditable world package".into(),
        scope: GoalScope {
            scope_sha256: sha(&serde_json::to_vec(&resource_ids).unwrap()),
            resource_ids,
        },
        acceptance_criteria: vec![GoalAcceptanceCriterion {
            criterion_id: "criterion-1".into(),
            description: "Contract tests pass".into(),
            required: true,
            satisfied,
            evidence_refs: if satisfied {
                vec![goal_evidence()]
            } else {
                vec![]
            },
        }],
        constraints: vec!["No mock live behavior".into()],
        permission_mode: GoalPermissionMode::Assist,
    }
}

fn goal_evidence() -> GoalEvidenceReference {
    GoalEvidenceReference {
        kind: "test".into(),
        reference: "goal-plan-command-service".into(),
        description: "The real storage contract passed".into(),
    }
}

fn plan_create(goal_id: &str, goal_revision: u64) -> PlanCreate {
    PlanCreate {
        create_idempotency_key: format!("create-plan-{goal_id}-{goal_revision}"),
        plan_id: format!("plan-{goal_id}-{goal_revision}"),
        goal_id: goal_id.into(),
        goal_revision,
        steps: vec![plan_step()],
    }
}

fn plan_step() -> PlanStep {
    PlanStep {
        step_id: "step-1".into(),
        purpose: "Verify the package".into(),
        dependencies: vec![],
        assigned_agent: Some("checker".into()),
        capabilities: vec!["project.read".into()],
        expected_artifact: "verification-report".into(),
        required_evidence: vec!["test".into()],
        status: PlanStepStatus::Pending,
        completion_evidence: vec![],
    }
}

fn plan_evidence() -> PlanEvidence {
    PlanEvidence {
        evidence_type: "test".into(),
        reference_id: "test-1".into(),
        sha256: "a".repeat(64),
    }
}

fn sha(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
