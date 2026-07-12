use novelx_protocol::{
    RunPermissionMode, RuntimeError, RuntimeErrorClass, ToolArtifactReceipt,
    ToolPermissionDecision, ToolPermissionLease, ToolPermissionPolicy, ToolProtocolSideEffect,
    ToolRequest, ToolSourceScope,
};
use novelx_runtime::tool_coordination_service::{ToolCoordinationSnapshot, ToolCoordinationStatus};
use novelx_runtime::tool_protocol_mapper::{ToolProtocolMapper, ToolProtocolMapperError};
use novelx_runtime::tool_state::{ToolAuthorization, ToolState};
use uuid::Uuid;

#[test]
fn maps_requested_authorized_running_success_and_failure_with_original_provider_id() {
    let run_id = Uuid::new_v4();
    let request = request();
    let mapper = ToolProtocolMapper::new(Uuid::new_v4(), "2026-07-12T00:00:00Z");
    let lease = lease(&request);

    let requested = mapper
        .requested(
            run_id,
            &request,
            &snapshot(run_id, &request, ToolState::Requested, None, None),
        )
        .unwrap();
    assert_eq!(
        requested.payload["providerToolCallId"],
        "call-provider-original"
    );
    let authorized_snapshot = snapshot(
        run_id,
        &request,
        ToolState::Authorized,
        Some(lease.clone()),
        None,
    );
    assert_eq!(
        mapper
            .authorized(run_id, &request, &authorized_snapshot)
            .unwrap()
            .name,
        "tool.authorized"
    );
    let running_snapshot = snapshot(
        run_id,
        &request,
        ToolState::Running,
        Some(lease.clone()),
        None,
    );
    assert_eq!(
        mapper
            .running(run_id, &request, &running_snapshot)
            .unwrap()
            .name,
        "tool.running"
    );
    let result = artifact();
    let completed = snapshot(
        run_id,
        &request,
        ToolState::Completed,
        Some(lease.clone()),
        Some(result.clone()),
    );
    assert_eq!(
        mapper
            .succeeded(run_id, &request, &completed)
            .unwrap()
            .payload["result"],
        serde_json::to_value(result).unwrap()
    );
    let failed = snapshot(run_id, &request, ToolState::Failed, Some(lease), None);
    assert_eq!(
        mapper
            .failed(
                run_id,
                &request,
                &failed,
                RuntimeError {
                    code: "PROJECT_READ_FAILED".to_owned(),
                    class: RuntimeErrorClass::Validation,
                    retryable: false,
                    public_message: "Project file read failed.".to_owned(),
                    stage: "tool.execute".to_owned(),
                    attempt: 1,
                    diagnostic_id: Uuid::new_v4(),
                },
            )
            .unwrap()
            .name,
        "tool.failed"
    );
}

#[test]
fn rejects_mismatched_state_identity_and_missing_result() {
    let run_id = Uuid::new_v4();
    let request = request();
    let mapper = ToolProtocolMapper::new(Uuid::new_v4(), "2026-07-12T00:00:00Z");
    let requested = snapshot(run_id, &request, ToolState::Requested, None, None);
    assert!(matches!(
        mapper.succeeded(run_id, &request, &requested),
        Err(ToolProtocolMapperError::StateMismatch)
    ));
    let completed_without_result = snapshot(
        run_id,
        &request,
        ToolState::Completed,
        Some(lease(&request)),
        None,
    );
    assert!(matches!(
        mapper.succeeded(run_id, &request, &completed_without_result),
        Err(ToolProtocolMapperError::ResultMissing)
    ));
    assert!(matches!(
        mapper.requested(Uuid::new_v4(), &request, &requested),
        Err(ToolProtocolMapperError::IdentityMismatch)
    ));
}

fn request() -> ToolRequest {
    ToolRequest {
        request_idempotency_key: "tool-request-1".to_owned(),
        tool_call_id: Uuid::new_v4(),
        provider_tool_call_id: "call-provider-original".to_owned(),
        invocation_id: "invocation-1".to_owned(),
        tool_name: "read_project_file".to_owned(),
        schema_version: 1,
        attempt: 1,
        side_effect: ToolProtocolSideEffect::None,
        parallel: false,
        arguments: artifact(),
        source_scope: ToolSourceScope {
            source_checkpoint_id: "checkpoint-1".to_owned(),
            resource_ids: vec!["resource-1".to_owned()],
            scope_sha256: "b".repeat(64),
        },
        permission: ToolPermissionPolicy {
            mode: RunPermissionMode::Free,
            policy_id: "tools".to_owned(),
            policy_version: "1.0.0".to_owned(),
            policy_sha256: "c".repeat(64),
        },
    }
}

fn artifact() -> ToolArtifactReceipt {
    ToolArtifactReceipt {
        artifact_id: Uuid::new_v4(),
        media_type: "application/json".to_owned(),
        sha256: "a".repeat(64),
        utf8_bytes: 2,
    }
}

fn lease(request: &ToolRequest) -> ToolPermissionLease {
    ToolPermissionLease {
        lease_id: Uuid::new_v4(),
        tool_call_id: request.tool_call_id,
        mode: RunPermissionMode::Free,
        decision: ToolPermissionDecision::Allowed,
        policy_id: request.permission.policy_id.clone(),
        policy_version: request.permission.policy_version.clone(),
        policy_sha256: request.permission.policy_sha256.clone(),
        source_scope_sha256: request.source_scope.scope_sha256.clone(),
        granted_at: "2026-07-12T00:00:00Z".to_owned(),
        expires_at: None,
    }
}

fn snapshot(
    run_id: Uuid,
    request: &ToolRequest,
    state: ToolState,
    lease: Option<ToolPermissionLease>,
    result: Option<ToolArtifactReceipt>,
) -> ToolCoordinationSnapshot {
    let (authorization, status) = match state {
        ToolState::Requested => (
            ToolAuthorization::Pending,
            ToolCoordinationStatus::Authorized,
        ),
        ToolState::Authorized => (
            ToolAuthorization::Allowed,
            ToolCoordinationStatus::Authorized,
        ),
        ToolState::Running => (ToolAuthorization::Allowed, ToolCoordinationStatus::Running),
        ToolState::Completed => (
            ToolAuthorization::Allowed,
            ToolCoordinationStatus::Succeeded,
        ),
        ToolState::Failed => (ToolAuthorization::Allowed, ToolCoordinationStatus::Failed),
        _ => unreachable!(),
    };
    ToolCoordinationSnapshot {
        run_id: run_id.to_string(),
        tool_call_id: request.tool_call_id,
        state,
        authorization,
        status,
        lease,
        result,
        failure: None,
    }
}
