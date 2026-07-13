mod support;

use novelx_protocol::{
    AgentAssignmentComplete, AgentAssignmentConfirmCancelled, AgentAssignmentCreate,
    AgentAssignmentFail, AgentAssignmentGet, AgentAssignmentRequestCancel, AgentAssignmentStart,
    AgentAssignmentStatus, AssignmentCompletionEvidence, AssignmentDefinition, AssignmentScope,
    ChildAgentPermission, ChildRunSpec, RevisionReference, RunPermissionMode, ToolPermissionPolicy,
    ToolSourceScope, child_run_pinned_identity_sha256,
};
use novelx_runtime::{
    agent_assignment_aggregate::AgentAssignmentRepository,
    agent_assignment_command_service::AgentAssignmentCommandService,
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopIdentity, AgentLoopPolicy, AgentLoopService, InferenceDispatchIdentity,
    },
    event_journal::EventJournal,
    goal_aggregate::{
        AcceptanceCriterion, GoalAggregate, GoalAggregateRepository, GoalDefinition, GoalIdentity,
        GoalPermissionMode, GoalScope,
    },
    plan_aggregate::{PlanAggregate, PlanEventMetadata, PlanStep, PlanStepStatus},
    run_aggregate::{EventMetadata, RunAggregate},
    run_command_service::WorkspaceBinding,
    run_state::RunState,
    workspace_event_journal::WorkspaceEventJournal,
    workspace_runtime_lease::{BoundWorkspaceRuntimeLease, WorkspaceRuntimeLease},
};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn create_binds_exact_sources_and_survives_reopen_idempotently() {
    let fixture = Fixture::new();
    let seeded = fixture.seed();
    let command = fixture.create_command(&seeded, "assignment-1");
    let message_id = Uuid::new_v4();

    let created = fixture
        .service()
        .create(message_id, command.clone())
        .unwrap();
    assert_eq!(created.workspace_id, fixture.binding.workspace_id);
    assert_eq!(created.project_id, fixture.binding.project_id);
    assert_eq!(created.goal.sha256, Some(seeded.goal.last_event_hash));
    assert_eq!(
        created.plan.sha256,
        Some(seeded.plan.current_revision().revision_sha256.clone())
    );
    assert_eq!(created.status, AgentAssignmentStatus::Allocated);

    let duplicate = fixture.service().create(message_id, command).unwrap();
    assert_eq!(duplicate, created);
    let reopened = fixture
        .service()
        .get(AgentAssignmentGet {
            assignment_id: "assignment-1".into(),
        })
        .unwrap();
    assert_eq!(reopened, created);
}

#[test]
fn create_rejects_wrong_hash_step_profile_scope_and_parent_run_without_writes() {
    let fixture = Fixture::new();
    let seeded = fixture.seed();

    let mut wrong_hash = fixture.create_command(&seeded, "bad-hash");
    wrong_hash.goal.sha256 = Some("0".repeat(64));
    assert_rejected(&fixture, wrong_hash, "ASSIGNMENT_GOAL_HASH_MISMATCH");

    let mut wrong_step = fixture.create_command(&seeded, "bad-step");
    wrong_step.plan_step_id = "missing-step".into();
    assert_rejected(&fixture, wrong_step, "ASSIGNMENT_PLAN_STEP_NOT_FOUND");

    let mut wrong_profile = fixture.create_command(&seeded, "bad-profile");
    wrong_profile.child_profile_id = "writer".into();
    assert_rejected(&fixture, wrong_profile, "ASSIGNMENT_PROFILE_MISMATCH");

    let mut wrong_scope = fixture.create_command(&seeded, "bad-scope");
    wrong_scope.scope = assignment_scope(&["resource-3"]);
    assert_rejected(&fixture, wrong_scope, "ASSIGNMENT_SCOPE_OUTSIDE_GOAL");

    let mut missing_parent = fixture.create_command(&seeded, "bad-parent");
    missing_parent.parent_run_id = Uuid::new_v4().to_string();
    assert_rejected(&fixture, missing_parent, "ASSIGNMENT_PARENT_RUN_NOT_FOUND");
}

#[test]
fn lifecycle_commands_are_typed_and_start_only_records_child_run_identity() {
    let fixture = Fixture::new();
    let seeded = fixture.seed();
    fixture
        .service()
        .create(
            Uuid::new_v4(),
            fixture.create_command(&seeded, "assignment-lifecycle"),
        )
        .unwrap();
    let child_run_id = Uuid::new_v4().to_string();
    let started = fixture
        .service()
        .start(
            Uuid::new_v4(),
            AgentAssignmentStart {
                start_idempotency_key: "assignment-start".into(),
                assignment_id: "assignment-lifecycle".into(),
                expected_revision: 1,
                child_run_spec: fixture.child_spec("assignment-lifecycle", &child_run_id),
            },
        )
        .unwrap();
    assert_eq!(started.status, AgentAssignmentStatus::Running);
    assert_eq!(started.child_run_id.as_deref(), Some(child_run_id.as_str()));
    let runtime = EventJournal::open(&fixture.database).unwrap();
    assert!(runtime.read_run(&child_run_id, 0).unwrap().is_empty());
    drop(runtime);
    fixture.seed_terminal_child_run("assignment-lifecycle", &child_run_id, RunState::Completed);

    let stale = fixture
        .service()
        .request_cancel(
            Uuid::new_v4(),
            AgentAssignmentRequestCancel {
                cancel_idempotency_key: "assignment-stale-cancel".into(),
                assignment_id: "assignment-lifecycle".into(),
                expected_revision: 1,
            },
        )
        .unwrap_err();
    assert_eq!(stale.error.code, "ASSIGNMENT_REVISION_CONFLICT");
    assert!(stale.error.retryable);

    let completed = fixture
        .service()
        .complete(
            Uuid::new_v4(),
            AgentAssignmentComplete {
                complete_idempotency_key: "assignment-complete".into(),
                assignment_id: "assignment-lifecycle".into(),
                expected_revision: 2,
                evidence: vec![evidence()],
            },
        )
        .unwrap();
    assert_eq!(completed.status, AgentAssignmentStatus::Completed);
    assert_eq!(completed.completion_evidence, vec![evidence()]);

    let terminal = fixture
        .service()
        .request_cancel(
            Uuid::new_v4(),
            AgentAssignmentRequestCancel {
                cancel_idempotency_key: "assignment-cancel-terminal".into(),
                assignment_id: "assignment-lifecycle".into(),
                expected_revision: 3,
            },
        )
        .unwrap_err();
    assert_eq!(terminal.error.code, "ASSIGNMENT_TRANSITION_INVALID");
}

#[test]
fn cancellation_and_failure_paths_persist_typed_terminal_state() {
    let fixture = Fixture::new();
    let seeded = fixture.seed();
    let service = fixture.service();

    service
        .create(
            Uuid::new_v4(),
            fixture.create_command(&seeded, "assignment-cancel-before-start"),
        )
        .unwrap();
    service
        .request_cancel(
            Uuid::new_v4(),
            AgentAssignmentRequestCancel {
                cancel_idempotency_key: "cancel-before-start-request".into(),
                assignment_id: "assignment-cancel-before-start".into(),
                expected_revision: 1,
            },
        )
        .unwrap();
    let cancelled_before_start = service
        .confirm_cancelled(
            Uuid::new_v4(),
            AgentAssignmentConfirmCancelled {
                confirm_idempotency_key: "cancel-before-start-confirm".into(),
                assignment_id: "assignment-cancel-before-start".into(),
                expected_revision: 2,
            },
        )
        .unwrap();
    assert_eq!(
        cancelled_before_start.status,
        AgentAssignmentStatus::Cancelled
    );

    service
        .create(
            Uuid::new_v4(),
            fixture.create_command(&seeded, "assignment-cancel"),
        )
        .unwrap();
    let cancelled_child_run_id = Uuid::new_v4().to_string();
    service
        .start(
            Uuid::new_v4(),
            AgentAssignmentStart {
                start_idempotency_key: "cancel-start".into(),
                assignment_id: "assignment-cancel".into(),
                expected_revision: 1,
                child_run_spec: fixture.child_spec("assignment-cancel", &cancelled_child_run_id),
            },
        )
        .unwrap();
    let requested = service
        .request_cancel(
            Uuid::new_v4(),
            AgentAssignmentRequestCancel {
                cancel_idempotency_key: "cancel-request".into(),
                assignment_id: "assignment-cancel".into(),
                expected_revision: 2,
            },
        )
        .unwrap();
    assert_eq!(requested.status, AgentAssignmentStatus::CancelRequested);
    fixture.seed_terminal_child_run(
        "assignment-cancel",
        &cancelled_child_run_id,
        RunState::Cancelled,
    );
    let cancelled = service
        .confirm_cancelled(
            Uuid::new_v4(),
            AgentAssignmentConfirmCancelled {
                confirm_idempotency_key: "cancel-confirm".into(),
                assignment_id: "assignment-cancel".into(),
                expected_revision: 3,
            },
        )
        .unwrap();
    assert_eq!(cancelled.status, AgentAssignmentStatus::Cancelled);

    service
        .create(
            Uuid::new_v4(),
            fixture.create_command(&seeded, "assignment-fail"),
        )
        .unwrap();
    let failed_child_run_id = Uuid::new_v4().to_string();
    service
        .start(
            Uuid::new_v4(),
            AgentAssignmentStart {
                start_idempotency_key: "fail-start".into(),
                assignment_id: "assignment-fail".into(),
                expected_revision: 1,
                child_run_spec: fixture.child_spec("assignment-fail", &failed_child_run_id),
            },
        )
        .unwrap();
    fixture.seed_terminal_child_run("assignment-fail", &failed_child_run_id, RunState::Failed);
    let failed = service
        .fail(
            Uuid::new_v4(),
            AgentAssignmentFail {
                fail_idempotency_key: "fail-confirm".into(),
                assignment_id: "assignment-fail".into(),
                expected_revision: 2,
                failure_code: "CHILD_RUNTIME_FAILED".into(),
            },
        )
        .unwrap();
    assert_eq!(failed.status, AgentAssignmentStatus::Failed);
    assert_eq!(failed.failure_code.as_deref(), Some("CHILD_RUNTIME_FAILED"));
}

fn assert_rejected(fixture: &Fixture, command: AgentAssignmentCreate, code: &str) {
    let assignment_id = command.assignment_id.clone();
    let failure = fixture
        .service()
        .create(Uuid::new_v4(), command)
        .unwrap_err();
    assert_eq!(failure.error.code, code);
    let missing = fixture
        .service()
        .get(AgentAssignmentGet { assignment_id })
        .unwrap_err();
    assert_eq!(missing.error.code, "ASSIGNMENT_NOT_FOUND");
}

struct Seeded {
    goal: GoalAggregate,
    plan: PlanAggregate,
    parent_run_id: String,
}

struct Fixture {
    _temp: TempDir,
    database: std::path::PathBuf,
    binding: WorkspaceBinding,
    lease: BoundWorkspaceRuntimeLease,
}

impl Fixture {
    fn child_spec(&self, assignment_id: &str, child_run_id: &str) -> ChildRunSpec {
        let allocation = AgentAssignmentRepository::open(&self.database)
            .unwrap()
            .load_revision("workspace-1", assignment_id, 1)
            .unwrap();
        let mut pinned_identity = support::pinned_identity();
        pinned_identity.goal = Some(RevisionReference {
            id: allocation.identity.goal.id.clone(),
            revision: allocation.identity.goal.revision,
            sha256: Some(allocation.identity.goal.sha256.clone()),
        });
        pinned_identity.plan = Some(RevisionReference {
            id: allocation.identity.plan.id.clone(),
            revision: allocation.identity.plan.revision,
            sha256: Some(allocation.identity.plan.sha256.clone()),
        });
        pinned_identity.assignment = Some(RevisionReference {
            id: allocation.identity.assignment_id.clone(),
            revision: allocation.revision,
            sha256: Some(allocation.last_event_hash.clone()),
        });
        pinned_identity.parent_run_id = Some(allocation.identity.parent_run_id.clone());
        pinned_identity.delegation_depth = 1;
        pinned_identity.agent_profile.id = allocation.identity.child_profile_id.clone();
        pinned_identity.scope_resource_ids = allocation.scope.resource_ids.clone();
        pinned_identity.resource_scope_sha256 = allocation.scope.scope_sha256.clone();
        pinned_identity.source_checkpoint_id = allocation.definition.source_checkpoint_id.clone();
        let pinned_identity_sha256 = child_run_pinned_identity_sha256(&pinned_identity).unwrap();
        ChildRunSpec {
            child_run_id: child_run_id.into(),
            run_start_idempotency_key: format!("child-start-{assignment_id}"),
            pinned_identity,
            pinned_identity_sha256,
        }
    }

    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("workspace.db");
        EventJournal::open(&database).unwrap();
        let lease = WorkspaceRuntimeLease::acquire(&database, "assignment-command-service")
            .unwrap()
            .bind_database(&database)
            .unwrap();
        Self {
            database,
            _temp: temp,
            binding: WorkspaceBinding {
                workspace_id: "workspace-1".into(),
                project_id: "project-1".into(),
            },
            lease,
        }
    }

    fn service(&self) -> AgentAssignmentCommandService<'_> {
        AgentAssignmentCommandService::new(&self.database, &self.binding)
    }

    fn seed(&self) -> Seeded {
        let resources = vec!["resource-1".to_owned(), "resource-2".to_owned()];
        let mut goals = GoalAggregateRepository::open(&self.database).unwrap();
        let goal = goals
            .create(
                GoalIdentity {
                    workspace_id: self.binding.workspace_id.clone(),
                    project_id: self.binding.project_id.clone(),
                    session_id: "session-1".into(),
                    goal_id: "goal-1".into(),
                    owner_agent_id: "steward".into(),
                },
                GoalDefinition {
                    objective: "Inspect the project".into(),
                    scope: GoalScope {
                        resource_ids: resources.clone(),
                        scope_sha256: scope_sha(&resources),
                    },
                    acceptance_criteria: vec![AcceptanceCriterion {
                        criterion_id: "criterion-1".into(),
                        description: "Produce traceable evidence".into(),
                        required: true,
                        satisfied: false,
                        evidence_refs: vec![],
                    }],
                    constraints: vec!["Do not invent sources".into()],
                    permission_mode: GoalPermissionMode::Assist,
                },
                Uuid::new_v4().to_string(),
                "seed-goal",
                "2026-07-12T00:00:00Z",
            )
            .unwrap();
        let mut workspace = WorkspaceEventJournal::open(&self.database).unwrap();
        let plan = PlanAggregate::create(
            &mut workspace,
            &self.binding.workspace_id,
            "plan-1",
            &goal.identity.goal_id,
            goal.revision,
            vec![PlanStep {
                step_id: "step-1".into(),
                purpose: "Inspect sources".into(),
                dependencies: vec![],
                assigned_agent: Some("checker".into()),
                capabilities: vec!["project.read".into()],
                expected_artifact: "source-report".into(),
                required_evidence: vec!["artifact".into()],
                status: PlanStepStatus::Pending,
                completion_evidence: vec![],
            }],
            PlanEventMetadata {
                message_id: &Uuid::new_v4().to_string(),
                idempotency_key: "seed-plan",
                created_at: "2026-07-12T00:00:01Z",
            },
        )
        .unwrap();
        let parent_run_id = Uuid::new_v4().to_string();
        let mut identity = support::pinned_identity();
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
        let mut runtime = EventJournal::open(&self.database).unwrap();
        let mut parent = RunAggregate::create(
            &mut runtime,
            &parent_run_id,
            identity,
            EventMetadata {
                message_id: &Uuid::new_v4().to_string(),
                idempotency_key: "seed-parent-run",
                created_at: "2026-07-12T00:00:02Z",
                reason: None,
            },
        )
        .unwrap();
        parent
            .prepare(&mut runtime, run_metadata("parent-prepare", None))
            .unwrap();
        parent
            .start(&mut runtime, run_metadata("parent-start", None))
            .unwrap();
        let context_compilation_id = Uuid::new_v4();
        let loop_service = AgentLoopService::new(
            AgentLoopIdentity {
                run_id: Uuid::parse_str(&parent_run_id).unwrap(),
                project_id: self.binding.project_id.clone(),
                invocation_id: "invocation-1".into(),
                initial_context_compilation_id: context_compilation_id,
                source_scope: ToolSourceScope {
                    source_checkpoint_id: "checkpoint-1".into(),
                    resource_ids: resources,
                    scope_sha256: "a".repeat(64),
                },
                permission: ToolPermissionPolicy {
                    mode: RunPermissionMode::Assist,
                    policy_id: "tool-policy".into(),
                    policy_version: "1.0.0".into(),
                    policy_sha256: "b".repeat(64),
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
                context_compilation_id,
                attempt_number: 1,
                inference_idempotency_key: "parent-inference-1".into(),
            },
        )
        .unwrap();
        AgentLoopJournalRepository::new(&mut runtime)
            .create(
                &loop_service,
                "parent-loop-create",
                AgentLoopEventMetadata {
                    message_id: &Uuid::new_v4().to_string(),
                    created_at: "2026-07-12T00:00:05Z",
                },
            )
            .unwrap();
        Seeded {
            goal,
            plan,
            parent_run_id,
        }
    }

    fn create_command(&self, seeded: &Seeded, assignment_id: &str) -> AgentAssignmentCreate {
        AgentAssignmentCreate {
            create_idempotency_key: format!("create-{assignment_id}"),
            assignment_id: assignment_id.into(),
            goal: RevisionReference {
                id: seeded.goal.identity.goal_id.clone(),
                revision: seeded.goal.revision,
                sha256: Some(seeded.goal.last_event_hash.clone()),
            },
            plan: RevisionReference {
                id: seeded.plan.plan_id().to_owned(),
                revision: seeded.plan.current_revision().revision,
                sha256: Some(seeded.plan.current_revision().revision_sha256.clone()),
            },
            plan_step_id: "step-1".into(),
            parent_run_id: seeded.parent_run_id.clone(),
            parent_invocation_id: "invocation-1".into(),
            child_profile_id: "checker".into(),
            scope: assignment_scope(&["resource-1"]),
            definition: AssignmentDefinition {
                bounded_objective: "Inspect resource-1 and return sourced findings".into(),
                source_checkpoint_id: "checkpoint-1".into(),
                expected_artifact: "source-report".into(),
                capabilities: vec!["project.read".into()],
            },
            permission: ChildAgentPermission::ReadOnly,
        }
    }

    fn seed_terminal_child_run(&self, assignment_id: &str, run_id: &str, terminal: RunState) {
        let assignment = AgentAssignmentRepository::open(&self.database)
            .unwrap()
            .load("workspace-1", assignment_id)
            .unwrap();
        let pinned = assignment.child_run_spec.unwrap().pinned_identity;
        let mut runtime = EventJournal::open(&self.database).unwrap();
        let create_key = format!("{run_id}-create");
        let mut child = RunAggregate::create(
            &mut runtime,
            run_id,
            pinned,
            run_metadata(&create_key, None),
        )
        .unwrap();
        let prepare_key = format!("{run_id}-prepare");
        child
            .prepare(&mut runtime, run_metadata(&prepare_key, None))
            .unwrap();
        let start_key = format!("{run_id}-start");
        child
            .start(&mut runtime, run_metadata(&start_key, None))
            .unwrap();
        match terminal {
            RunState::Completed => {
                let key = format!("{run_id}-complete");
                child
                    .complete(&mut runtime, run_metadata(&key, None))
                    .unwrap();
            }
            RunState::Cancelled => {
                let key = format!("{run_id}-cancel");
                child
                    .cancel(
                        &mut runtime,
                        &self.lease,
                        run_metadata(&key, Some("assignment cancelled")),
                    )
                    .unwrap();
            }
            RunState::Failed => {
                let key = format!("{run_id}-fail");
                child
                    .fail(
                        &mut runtime,
                        run_metadata(&key, Some("child runtime failed")),
                    )
                    .unwrap();
            }
            other => panic!("unsupported terminal child state: {other:?}"),
        }
    }
}

fn assignment_scope(resources: &[&str]) -> AssignmentScope {
    let resource_ids: Vec<String> = resources.iter().map(|value| (*value).to_owned()).collect();
    AssignmentScope {
        scope_sha256: scope_sha(&resource_ids),
        resource_ids,
    }
}

fn scope_sha(resources: &[String]) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(resources).unwrap())
    )
}

fn evidence() -> AssignmentCompletionEvidence {
    AssignmentCompletionEvidence {
        kind: "artifact".into(),
        reference: "artifact-1".into(),
        sha256: "a".repeat(64),
    }
}

fn run_metadata<'a>(key: &'a str, reason: Option<&'a str>) -> EventMetadata<'a> {
    EventMetadata {
        message_id: key,
        idempotency_key: key,
        created_at: "2026-07-12T00:00:04Z",
        reason,
    }
}
