mod support;

use novelx_protocol::{
    RunPermissionMode, ToolArtifactReceipt, ToolAuthorizationResolutionDecision,
    ToolAuthorizationResolve, ToolPermissionPolicy, ToolProtocolSideEffect, ToolRequest,
    ToolSourceScope,
};
use novelx_runtime::artifact_store::ArtifactStore;
use novelx_runtime::event_journal::EventJournal;
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate};
use novelx_runtime::tool_aggregate::{ToolCallAggregate, ToolCallDefinition};
use novelx_runtime::tool_coordination_service::{
    ToolCoordinationError, ToolCoordinationService, ToolCoordinationStatus,
};
use novelx_runtime::tool_state::{ToolAuthorization, ToolSideEffect, ToolState};
use serde_json::json;
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn free_mode_authorizes_starts_succeeds_and_recovers_idempotently() {
    let fixture = Fixture::new(RunPermissionMode::Free);
    let request = fixture.request("list_project_directory");
    let mut journal = fixture.journal();
    let mut artifacts = fixture.artifacts();
    let result = artifacts
        .put_json(Uuid::new_v4(), &fixture.run_id, &json!({"entries": []}))
        .unwrap();
    let changed_result = artifacts
        .put_json(
            Uuid::new_v4(),
            &fixture.run_id,
            &json!({"entries": ["changed"]}),
        )
        .unwrap();
    let mut service = ToolCoordinationService::new(&mut journal, &mut artifacts);

    let first = service
        .request(&fixture.run_id, "project-1", &request, meta("request-1"))
        .unwrap();
    assert_eq!(first.status, ToolCoordinationStatus::Authorized);
    assert_eq!(first.state, ToolState::Authorized);
    assert_eq!(first.authorization, ToolAuthorization::Allowed);
    let lease = first.lease.clone().unwrap();
    let replay = service
        .request(
            &fixture.run_id,
            "project-1",
            &request,
            meta("request-retry"),
        )
        .unwrap();
    assert_eq!(replay, first);

    let running = service
        .start(
            &fixture.run_id,
            request.tool_call_id,
            lease.lease_id,
            meta("start-1"),
        )
        .unwrap();
    assert_eq!(running.state, ToolState::Running);
    let completed = service
        .succeed(
            &fixture.run_id,
            request.tool_call_id,
            lease.lease_id,
            &result.receipt,
            meta("success-1"),
        )
        .unwrap();
    assert_eq!(completed.state, ToolState::Completed);
    assert_eq!(completed.result.as_ref(), Some(&result.receipt));
    let replayed_completion = service
        .succeed(
            &fixture.run_id,
            request.tool_call_id,
            lease.lease_id,
            &result.receipt,
            meta("success-retry"),
        )
        .unwrap();
    assert_eq!(replayed_completion, completed);
    assert!(matches!(
        service.succeed(
            &fixture.run_id,
            request.tool_call_id,
            lease.lease_id,
            &changed_result.receipt,
            meta("success-conflict"),
        ),
        Err(ToolCoordinationError::CompletionManifestConflict)
    ));
    drop(journal);

    let mut journal = fixture.journal();
    let mut artifacts = fixture.artifacts();
    let recovered = ToolCoordinationService::new(&mut journal, &mut artifacts)
        .recover(&fixture.run_id, request.tool_call_id)
        .unwrap();
    assert_eq!(recovered, completed);
    let events = journal
        .read_aggregate(
            &fixture.run_id,
            "tool",
            &request.tool_call_id.to_string(),
            0,
        )
        .unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec![
            "tool.requested",
            "tool.authorized",
            "tool.started",
            "tool.completed",
        ]
    );
}

#[test]
fn assist_mode_requires_host_resolution_before_runtime_lease() {
    let fixture = Fixture::new(RunPermissionMode::Assist);
    let request = fixture.request("read_project_file");
    let mut journal = fixture.journal();
    let mut artifacts = fixture.artifacts();
    let mut service = ToolCoordinationService::new(&mut journal, &mut artifacts);

    let waiting = service
        .request(&fixture.run_id, "project-1", &request, meta("request-1"))
        .unwrap();
    assert_eq!(waiting.status, ToolCoordinationStatus::ApprovalRequired);
    assert_eq!(waiting.authorization, ToolAuthorization::ApprovalRequired);
    assert!(waiting.lease.is_none());
    assert!(matches!(
        service.start(
            &fixture.run_id,
            request.tool_call_id,
            Uuid::new_v4(),
            meta("start-denied")
        ),
        Err(ToolCoordinationError::LeaseRequired)
    ));

    let resolution = ToolAuthorizationResolve {
        authorization_idempotency_key: "host-approval-1".to_owned(),
        tool_call_id: request.tool_call_id,
        decision: ToolAuthorizationResolutionDecision::Approve,
    };
    let approved = service
        .resolve_from_host(&fixture.run_id, &resolution, meta("host-1"))
        .unwrap();
    assert_eq!(approved.status, ToolCoordinationStatus::Authorized);
    assert_eq!(
        approved.lease.as_ref().unwrap().mode,
        RunPermissionMode::Assist
    );
    let replay = service
        .resolve_from_host(&fixture.run_id, &resolution, meta("host-retry"))
        .unwrap();
    assert_eq!(replay, approved);
}

#[test]
fn rejects_scope_policy_artifact_and_non_readonly_tool_mismatches_without_writing() {
    for case in [
        "project",
        "checkpoint",
        "resources",
        "scope_hash",
        "policy",
        "artifact",
        "side_effect",
        "tool",
    ] {
        let fixture = Fixture::new(RunPermissionMode::Free);
        let mut request = fixture.request("stat_project_file");
        let project = if case == "project" {
            "other-project"
        } else {
            "project-1"
        };
        match case {
            "checkpoint" => request.source_scope.source_checkpoint_id = "other".to_owned(),
            "resources" => request.source_scope.resource_ids = vec!["resource-3".to_owned()],
            "scope_hash" => request.source_scope.scope_sha256 = "9".repeat(64),
            "policy" => request.permission.policy_sha256 = "9".repeat(64),
            "artifact" => request.arguments.artifact_id = Uuid::new_v4(),
            "side_effect" => request.side_effect = ToolProtocolSideEffect::StagedWrite,
            "tool" => request.tool_name = "save_task_note".to_owned(),
            _ => {}
        }
        let mut journal = fixture.journal();
        let mut artifacts = fixture.artifacts();
        let result = ToolCoordinationService::new(&mut journal, &mut artifacts).request(
            &fixture.run_id,
            project,
            &request,
            meta("request-1"),
        );
        assert!(result.is_err(), "{case} must fail closed");
        assert!(
            journal
                .read_aggregate(
                    &fixture.run_id,
                    "tool",
                    &request.tool_call_id.to_string(),
                    0
                )
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn all_five_read_only_tools_are_allowed_but_request_identity_cannot_change() {
    let fixture = Fixture::new(RunPermissionMode::Free);
    let mut journal = fixture.journal();
    let mut artifacts = fixture.artifacts();
    let mut service = ToolCoordinationService::new(&mut journal, &mut artifacts);
    for (index, name) in [
        "list_project_directory",
        "stat_project_file",
        "glob_project_files",
        "search_project_files",
        "read_project_file",
    ]
    .into_iter()
    .enumerate()
    {
        let mut request = fixture.request(name);
        request.request_idempotency_key = format!("tool-request-{index}");
        let snapshot = service
            .request(
                &fixture.run_id,
                "project-1",
                &request,
                meta(&format!("request-{index}")),
            )
            .unwrap();
        assert_eq!(snapshot.status, ToolCoordinationStatus::Authorized);

        let mut conflicting = request.clone();
        conflicting.request_idempotency_key = format!("changed-request-{index}");
        assert!(matches!(
            service.request(
                &fixture.run_id,
                "project-1",
                &conflicting,
                meta(&format!("conflict-{index}"))
            ),
            Err(ToolCoordinationError::RequestIdentityConflict)
        ));
    }
}

#[test]
fn assist_host_denial_and_runtime_failure_are_idempotent_and_recoverable() {
    let fixture = Fixture::new(RunPermissionMode::Assist);
    let denied_request = fixture.request("glob_project_files");
    let mut journal = fixture.journal();
    let mut artifacts = fixture.artifacts();
    let failure_artifact = artifacts
        .put_json(
            Uuid::new_v4(),
            &fixture.run_id,
            &json!({"code": "PROJECT_FILE_NOT_FOUND", "message": "missing"}),
        )
        .unwrap();
    let mut service = ToolCoordinationService::new(&mut journal, &mut artifacts);
    service
        .request(
            &fixture.run_id,
            "project-1",
            &denied_request,
            meta("deny-request"),
        )
        .unwrap();
    let denial = ToolAuthorizationResolve {
        authorization_idempotency_key: "host-deny-1".to_owned(),
        tool_call_id: denied_request.tool_call_id,
        decision: ToolAuthorizationResolutionDecision::Deny,
    };
    let denied = service
        .resolve_from_host(&fixture.run_id, &denial, meta("host-deny"))
        .unwrap();
    assert_eq!(denied.status, ToolCoordinationStatus::Denied);
    assert_eq!(
        service
            .resolve_from_host(&fixture.run_id, &denial, meta("host-deny-retry"))
            .unwrap(),
        denied
    );

    let mut failed_request = fixture.request("search_project_files");
    failed_request.request_idempotency_key = "tool-request-failure-1".to_owned();
    service
        .request(
            &fixture.run_id,
            "project-1",
            &failed_request,
            meta("fail-request"),
        )
        .unwrap();
    let approval = ToolAuthorizationResolve {
        authorization_idempotency_key: "host-approve-failure-1".to_owned(),
        tool_call_id: failed_request.tool_call_id,
        decision: ToolAuthorizationResolutionDecision::Approve,
    };
    let approved = service
        .resolve_from_host(&fixture.run_id, &approval, meta("host-approve-failure"))
        .unwrap();
    let lease_id = approved.lease.as_ref().unwrap().lease_id;
    service
        .start(
            &fixture.run_id,
            failed_request.tool_call_id,
            lease_id,
            meta("fail-start"),
        )
        .unwrap();
    let failed = service
        .fail(
            &fixture.run_id,
            failed_request.tool_call_id,
            lease_id,
            &failure_artifact.receipt,
            meta("fail-terminal"),
        )
        .unwrap();
    assert_eq!(failed.status, ToolCoordinationStatus::Failed);
    assert_eq!(failed.failure.as_ref(), Some(&failure_artifact.receipt));
    drop(journal);

    let mut journal = fixture.journal();
    let mut artifacts = fixture.artifacts();
    assert_eq!(
        ToolCoordinationService::new(&mut journal, &mut artifacts)
            .recover(&fixture.run_id, failed_request.tool_call_id)
            .unwrap(),
        failed
    );
}

#[test]
fn recovery_calibrates_persisted_lease_and_completion_manifest_without_redispatch() {
    let fixture = Fixture::new(RunPermissionMode::Free);
    let request = fixture.request("read_project_file");
    let lease = novelx_protocol::ToolPermissionLease {
        lease_id: Uuid::new_v4(),
        tool_call_id: request.tool_call_id,
        mode: RunPermissionMode::Free,
        decision: novelx_protocol::ToolPermissionDecision::Allowed,
        policy_id: "novelx.tools".to_owned(),
        policy_version: "1.0.0".to_owned(),
        policy_sha256: "d".repeat(64),
        source_scope_sha256: request.source_scope.scope_sha256.clone(),
        granted_at: "2026-07-12T00:00:00Z".to_owned(),
        expires_at: None,
    };
    let result = {
        let mut artifacts = fixture.artifacts();
        artifacts
            .put_json(Uuid::new_v4(), &fixture.run_id, &json!({"text": "ok"}))
            .unwrap()
    };
    {
        let mut journal = fixture.journal();
        let run = RunAggregate::recover(&journal, &fixture.run_id).unwrap();
        ToolCallAggregate::create(
            &mut journal,
            &fixture.run_id,
            &request.tool_call_id.to_string(),
            ToolCallDefinition {
                provider_tool_call_id: request.provider_tool_call_id.clone(),
                tool_name: request.tool_name.clone(),
                schema_version: request.schema_version,
                arguments_hash: request.arguments.sha256.clone(),
                attempt: request.attempt,
                side_effect: ToolSideEffect::None,
                parallel: false,
            },
            run.last_run_sequence(),
            meta("orphan-request"),
        )
        .unwrap();
    }
    {
        let mut artifacts = fixture.artifacts();
        artifacts
            .put_json(
                coordination_id(&fixture.run_id, request.tool_call_id, "permission-lease"),
                &fixture.run_id,
                &json!({
                    "kind": "tool_permission_lease_v1",
                    "authorizationIdempotencyKey": "tool-request-1:runtime-authorize",
                    "lease": lease,
                }),
            )
            .unwrap();
    }
    {
        let mut journal = fixture.journal();
        let mut artifacts = fixture.artifacts();
        let mut service = ToolCoordinationService::new(&mut journal, &mut artifacts);
        let authorized = service
            .recover(&fixture.run_id, request.tool_call_id)
            .unwrap();
        assert_eq!(authorized.state, ToolState::Authorized);
        service
            .start(
                &fixture.run_id,
                request.tool_call_id,
                lease.lease_id,
                meta("orphan-start"),
            )
            .unwrap();
    }
    {
        let mut artifacts = fixture.artifacts();
        artifacts
            .put_json(
                coordination_id(&fixture.run_id, request.tool_call_id, "completion-manifest"),
                &fixture.run_id,
                &json!({
                    "kind": "tool_completion_manifest_v1",
                    "toolCallId": request.tool_call_id,
                    "leaseId": lease.lease_id,
                    "result": result.receipt,
                    "recordedAt": "2026-07-12T00:00:00Z",
                }),
            )
            .unwrap();
    }
    let mut journal = fixture.journal();
    let mut artifacts = fixture.artifacts();
    let recovered = ToolCoordinationService::new(&mut journal, &mut artifacts)
        .recover(&fixture.run_id, request.tool_call_id)
        .unwrap();
    assert_eq!(recovered.state, ToolState::Completed);
    assert_eq!(recovered.result.as_ref(), Some(&result.receipt));
    let events = journal
        .read_aggregate(
            &fixture.run_id,
            "tool",
            &request.tool_call_id.to_string(),
            0,
        )
        .unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec![
            "tool.requested",
            "tool.authorized",
            "tool.started",
            "tool.completed",
        ]
    );
}

#[test]
fn rejects_argument_or_result_artifacts_owned_by_another_run() {
    let fixture = Fixture::new(RunPermissionMode::Free);
    let mut artifacts = fixture.artifacts();
    let foreign = artifacts
        .put_json(Uuid::new_v4(), "foreign-run", &json!({"path": "docs"}))
        .unwrap();
    let mut request = fixture.request("read_project_file");
    request.arguments = foreign.receipt.clone();
    let mut journal = fixture.journal();
    assert!(matches!(
        ToolCoordinationService::new(&mut journal, &mut artifacts).request(
            &fixture.run_id,
            "project-1",
            &request,
            meta("foreign-args")
        ),
        Err(ToolCoordinationError::ArtifactScopeMismatch)
    ));

    let request = fixture.request("read_project_file");
    let mut service = ToolCoordinationService::new(&mut journal, &mut artifacts);
    let authorized = service
        .request(
            &fixture.run_id,
            "project-1",
            &request,
            meta("valid-request"),
        )
        .unwrap();
    let lease_id = authorized.lease.as_ref().unwrap().lease_id;
    service
        .start(
            &fixture.run_id,
            request.tool_call_id,
            lease_id,
            meta("valid-start"),
        )
        .unwrap();
    assert!(matches!(
        service.succeed(
            &fixture.run_id,
            request.tool_call_id,
            lease_id,
            &foreign.receipt,
            meta("foreign-result")
        ),
        Err(ToolCoordinationError::ArtifactScopeMismatch)
    ));
}

struct Fixture {
    _temp: TempDir,
    database: std::path::PathBuf,
    run_id: String,
    arguments: ToolArtifactReceipt,
    mode: RunPermissionMode,
}

impl Fixture {
    fn new(mode: RunPermissionMode) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("runtime.db");
        let run_id = Uuid::new_v4().to_string();
        let mut journal = EventJournal::open(&database).unwrap();
        let mut pinned = support::pinned_identity();
        pinned.mode = mode;
        let mut run =
            RunAggregate::create(&mut journal, &run_id, pinned, run_meta("run-create")).unwrap();
        run.prepare(&mut journal, run_meta("run-prepare")).unwrap();
        run.start(&mut journal, run_meta("run-start")).unwrap();
        drop(journal);
        let arguments = ArtifactStore::open(&database)
            .unwrap()
            .put_json(Uuid::new_v4(), &run_id, &json!({"path": "docs"}))
            .unwrap()
            .receipt;
        Self {
            _temp: temp,
            database,
            run_id,
            arguments,
            mode,
        }
    }

    fn journal(&self) -> EventJournal {
        EventJournal::open(&self.database).unwrap()
    }
    fn artifacts(&self) -> ArtifactStore {
        ArtifactStore::open(&self.database).unwrap()
    }
    fn request(&self, tool_name: &str) -> ToolRequest {
        ToolRequest {
            request_idempotency_key: "tool-request-1".to_owned(),
            tool_call_id: Uuid::new_v4(),
            provider_tool_call_id: format!("call_{}", Uuid::new_v4()),
            invocation_id: "run:steward".to_owned(),
            tool_name: tool_name.to_owned(),
            schema_version: 1,
            attempt: 1,
            side_effect: ToolProtocolSideEffect::None,
            parallel: false,
            arguments: self.arguments.clone(),
            source_scope: ToolSourceScope {
                source_checkpoint_id: "checkpoint-1".to_owned(),
                resource_ids: vec!["resource-1".to_owned(), "resource-2".to_owned()],
                scope_sha256: support::pinned_identity().resource_scope_sha256,
            },
            permission: ToolPermissionPolicy {
                mode: self.mode,
                policy_id: "novelx.tools".to_owned(),
                policy_version: "1.0.0".to_owned(),
                policy_sha256: "d".repeat(64),
            },
        }
    }
}

fn meta(message_id: &str) -> novelx_runtime::tool_aggregate::ToolEventMetadata<'_> {
    novelx_runtime::tool_aggregate::ToolEventMetadata {
        message_id,
        idempotency_key: message_id,
        created_at: "2026-07-12T00:00:00Z",
        reason: None,
    }
}

fn run_meta(message_id: &str) -> EventMetadata<'_> {
    EventMetadata {
        message_id,
        idempotency_key: message_id,
        created_at: "2026-07-12T00:00:00Z",
        reason: None,
    }
}

fn coordination_id(run_id: &str, tool_call_id: Uuid, domain: &str) -> Uuid {
    let namespace = Uuid::from_u128(0x6aab8a1b_4fa0_4b33_a5e8_9db52a916a2f);
    Uuid::new_v5(
        &namespace,
        format!("novelx-runtime-v2:{domain}:{run_id}:{tool_call_id}").as_bytes(),
    )
}
