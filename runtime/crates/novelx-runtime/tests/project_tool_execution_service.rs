mod support;

use std::fs;

use novelx_protocol::{
    ProviderInferenceToolCall, RunPermissionMode, ToolAuthorizationResolutionDecision,
    ToolAuthorizationResolve,
};
use novelx_runtime::artifact_store::ArtifactStore;
use novelx_runtime::event_journal::EventJournal;
use novelx_runtime::project_path::ProjectRoot;
use novelx_runtime::project_tool_execution_service::{
    ProjectToolExecutionErrorClass, ProjectToolExecutionService,
};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate};
use novelx_runtime::tool_coordination_service::{ToolCoordinationService, ToolCoordinationStatus};
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

#[tokio::test]
async fn free_mode_executes_and_replays_the_same_persisted_result_without_redispatch() {
    let fixture = Fixture::new(RunPermissionMode::Free);
    fs::write(fixture.project.join("story.txt"), "first version").unwrap();
    let call = call(
        "call-read-1",
        "read_project_file",
        json!({"path": "story.txt"}),
    );
    let service = fixture.service();

    let first = service
        .execute_provider_calls(
            &fixture.run_id,
            "invocation-1",
            "inference-1",
            std::slice::from_ref(&call),
            "2026-07-12T00:00:00Z",
        )
        .await
        .unwrap();
    assert_eq!(first[0].snapshot.status, ToolCoordinationStatus::Succeeded);
    let receipt = first[0].snapshot.result.clone().unwrap();
    let stored = ArtifactStore::open(&fixture.database)
        .unwrap()
        .get(receipt.artifact_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.content["content"], "first version");

    fs::write(fixture.project.join("story.txt"), "second version").unwrap();
    let replay = service
        .execute_provider_calls(
            &fixture.run_id,
            "invocation-1",
            "inference-1",
            &[call],
            "2026-07-12T00:01:00Z",
        )
        .await
        .unwrap();
    assert_eq!(replay, first);
    let stored = ArtifactStore::open(&fixture.database)
        .unwrap()
        .get(receipt.artifact_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.content["content"], "first version");
}

#[tokio::test]
async fn assist_mode_stops_before_dispatch_until_host_approval() {
    let fixture = Fixture::new(RunPermissionMode::Assist);
    fs::write(fixture.project.join("world.md"), "world").unwrap();
    let call = call(
        "call-assist-1",
        "read_project_file",
        json!({"path": "world.md"}),
    );
    let service = fixture.service();

    let waiting = service
        .execute_provider_calls(
            &fixture.run_id,
            "invocation-1",
            "inference-1",
            std::slice::from_ref(&call),
            "2026-07-12T00:00:00Z",
        )
        .await
        .unwrap();
    assert_eq!(
        waiting[0].snapshot.status,
        ToolCoordinationStatus::ApprovalRequired
    );
    assert!(waiting[0].snapshot.result.is_none());

    let resolution = ToolAuthorizationResolve {
        authorization_idempotency_key: "host-approval-1".to_owned(),
        tool_call_id: waiting[0].tool_call_id,
        decision: ToolAuthorizationResolutionDecision::Approve,
    };
    let completed = service
        .resolve_assist_and_execute(
            &fixture.run_id,
            "invocation-1",
            "inference-1",
            &call,
            &resolution,
            "2026-07-12T00:01:00Z",
        )
        .await
        .unwrap();
    assert_eq!(completed.snapshot.status, ToolCoordinationStatus::Succeeded);
}

#[tokio::test]
async fn dispatcher_failure_is_persisted_as_a_structured_failure_artifact() {
    let fixture = Fixture::new(RunPermissionMode::Free);
    let call = call(
        "call-missing-1",
        "read_project_file",
        json!({"path": "missing.md"}),
    );
    let outcome = fixture
        .service()
        .execute_provider_calls(
            &fixture.run_id,
            "invocation-1",
            "inference-1",
            &[call],
            "2026-07-12T00:00:00Z",
        )
        .await
        .unwrap();

    assert_eq!(outcome[0].snapshot.status, ToolCoordinationStatus::Failed);
    let failure = outcome[0].snapshot.failure.as_ref().unwrap();
    let stored = ArtifactStore::open(&fixture.database)
        .unwrap()
        .get(failure.artifact_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.content["kind"], "project_tool_failure_v1");
    assert_eq!(stored.content["class"], "filesystem");
    assert_eq!(stored.content["code"], "PROJECT_FILE_NOT_FOUND");
}

#[tokio::test]
async fn bound_project_root_cannot_be_replaced_per_call_and_running_orphans_do_not_redispatch() {
    let fixture = Fixture::new(RunPermissionMode::Free);
    let outside = fixture._temp.path().join("outside.txt");
    fs::write(&outside, "outside").unwrap();
    let absolute = call(
        "call-escape-1",
        "read_project_file",
        json!({"path": outside.to_string_lossy()}),
    );
    let failed = fixture
        .service()
        .execute_provider_calls(
            &fixture.run_id,
            "invocation-1",
            "inference-escape",
            &[absolute],
            "2026-07-12T00:00:00Z",
        )
        .await
        .unwrap();
    assert_eq!(failed[0].snapshot.status, ToolCoordinationStatus::Failed);

    fs::write(fixture.project.join("story.txt"), "content").unwrap();
    let call = call(
        "call-running-1",
        "read_project_file",
        json!({"path": "story.txt"}),
    );
    let materialized = {
        let mut artifacts = ArtifactStore::open(&fixture.database).unwrap();
        novelx_runtime::provider_tool_materializer::ProviderToolMaterializer::new(&mut artifacts)
            .materialize(
                &fixture.run_id,
                "invocation-running",
                "inference-running",
                std::slice::from_ref(&call),
            )
            .unwrap()
            .remove(0)
    };
    {
        let mut journal = EventJournal::open(&fixture.database).unwrap();
        let mut artifacts = ArtifactStore::open(&fixture.database).unwrap();
        let request = fixture.request(&materialized, "invocation-running", "inference-running");
        let mut coordinator = ToolCoordinationService::new(&mut journal, &mut artifacts);
        let authorized = coordinator
            .request(
                &fixture.run_id,
                "project-1",
                &request,
                tool_meta("manual-request"),
            )
            .unwrap();
        coordinator
            .start(
                &fixture.run_id,
                materialized.tool_call_id,
                authorized.lease.unwrap().lease_id,
                tool_meta("manual-start"),
            )
            .unwrap();
    }
    let error = fixture
        .service()
        .execute_provider_calls(
            &fixture.run_id,
            "invocation-running",
            "inference-running",
            &[call],
            "2026-07-12T00:02:00Z",
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.class(),
        ProjectToolExecutionErrorClass::RecoveryRequired
    );
    assert_eq!(error.code(), "PROJECT_TOOL_OUTCOME_UNKNOWN");
}

#[tokio::test]
async fn predispatch_errors_have_stable_classes_and_codes() {
    let fixture = Fixture::new(RunPermissionMode::Free);
    let invalid_hash = ProviderInferenceToolCall {
        id: "call-invalid-hash".to_owned(),
        name: "stat_project_file".to_owned(),
        arguments: json!({"path": "story.txt"}),
        arguments_sha256: "0".repeat(64),
    };
    let error = fixture
        .service()
        .execute_provider_calls(
            &fixture.run_id,
            "invocation-1",
            "inference-invalid",
            &[invalid_hash],
            "2026-07-12T00:00:00Z",
        )
        .await
        .unwrap_err();
    assert_eq!(error.class(), ProjectToolExecutionErrorClass::ToolArguments);
    assert_eq!(error.code(), "PROJECT_TOOL_MATERIALIZATION_FAILED");

    let wrong_project = ProjectToolExecutionService::open(
        fixture.database.clone(),
        ProjectRoot::open(fixture.project.to_str().unwrap()).unwrap(),
        "other-project".to_owned(),
    )
    .unwrap();
    let error = wrong_project
        .execute_provider_calls(
            &fixture.run_id,
            "invocation-2",
            "inference-scope",
            &[call(
                "call-scope",
                "stat_project_file",
                json!({"path": "story.txt"}),
            )],
            "2026-07-12T00:00:00Z",
        )
        .await
        .unwrap_err();
    assert_eq!(error.class(), ProjectToolExecutionErrorClass::Scope);
    assert_eq!(error.code(), "PROJECT_TOOL_COORDINATION_REJECTED");
}

struct Fixture {
    _temp: TempDir,
    project: std::path::PathBuf,
    database: std::path::PathBuf,
    run_id: String,
}

impl Fixture {
    fn new(mode: RunPermissionMode) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir(&project).unwrap();
        let database = temp.path().join("runtime.db");
        let run_id = Uuid::new_v4().to_string();
        let mut journal = EventJournal::open(&database).unwrap();
        let mut pinned = support::pinned_identity();
        pinned.mode = mode;
        let mut run =
            RunAggregate::create(&mut journal, &run_id, pinned, run_meta("run-create")).unwrap();
        run.prepare(&mut journal, run_meta("run-prepare")).unwrap();
        run.start(&mut journal, run_meta("run-start")).unwrap();
        Self {
            _temp: temp,
            project,
            database,
            run_id,
        }
    }

    fn service(&self) -> ProjectToolExecutionService {
        ProjectToolExecutionService::open(
            self.database.clone(),
            ProjectRoot::open(self.project.to_str().unwrap()).unwrap(),
            "project-1".to_owned(),
        )
        .unwrap()
    }

    fn request(
        &self,
        call: &novelx_runtime::provider_tool_materializer::MaterializedProviderToolCall,
        invocation_id: &str,
        inference_id: &str,
    ) -> novelx_protocol::ToolRequest {
        let journal = EventJournal::open(&self.database).unwrap();
        let run = RunAggregate::recover(&journal, &self.run_id).unwrap();
        let pinned = run.pinned_identity();
        novelx_protocol::ToolRequest {
            request_idempotency_key: format!(
                "tool-request:{inference_id}:{}:{}",
                call.provider_tool_call_id, call.arguments.sha256
            ),
            tool_call_id: call.tool_call_id,
            provider_tool_call_id: call.provider_tool_call_id.clone(),
            invocation_id: invocation_id.to_owned(),
            tool_name: call.tool_name.clone(),
            schema_version: 1,
            attempt: 1,
            side_effect: novelx_protocol::ToolProtocolSideEffect::None,
            parallel: false,
            arguments: call.arguments.clone(),
            source_scope: novelx_protocol::ToolSourceScope {
                source_checkpoint_id: pinned.source_checkpoint_id.clone(),
                resource_ids: pinned.scope_resource_ids.clone(),
                scope_sha256: pinned.resource_scope_sha256.clone(),
            },
            permission: novelx_protocol::ToolPermissionPolicy {
                mode: pinned.mode,
                policy_id: pinned.tool_policy.id.clone(),
                policy_version: pinned.tool_policy.version.clone(),
                policy_sha256: pinned.tool_policy.sha256.clone(),
            },
        }
    }
}

fn call(id: &str, name: &str, arguments: serde_json::Value) -> ProviderInferenceToolCall {
    let arguments_sha256 = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&arguments).unwrap())
    );
    ProviderInferenceToolCall {
        id: id.to_owned(),
        name: name.to_owned(),
        arguments,
        arguments_sha256,
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

fn tool_meta(message_id: &str) -> novelx_runtime::tool_aggregate::ToolEventMetadata<'_> {
    novelx_runtime::tool_aggregate::ToolEventMetadata {
        message_id,
        idempotency_key: message_id,
        created_at: "2026-07-12T00:00:00Z",
        reason: None,
    }
}
