use std::path::{Path, PathBuf};

use novelx_protocol::{
    ProviderInferenceToolCall, ToolAuthorizationResolve, ToolPermissionPolicy,
    ToolProtocolSideEffect, ToolRequest, ToolSourceScope,
};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

use crate::artifact_store::{ArtifactStore, ArtifactStoreError};
use crate::event_journal::{EventJournal, EventJournalError};
use crate::project_path::ProjectRoot;
use crate::project_tool_dispatcher::{ProjectToolDispatchError, ProjectToolDispatcher};
use crate::provider_tool_materializer::{
    MaterializedProviderToolCall, ProviderToolMaterializer, ProviderToolMaterializerError,
};
use crate::run_aggregate::{RunAggregate, RunAggregateError};
use crate::tool_aggregate::ToolEventMetadata;
use crate::tool_coordination_service::{
    ToolCoordinationError, ToolCoordinationService, ToolCoordinationSnapshot,
    ToolCoordinationStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectToolExecutionOutcome {
    pub tool_call_id: Uuid,
    pub provider_tool_call_id: String,
    pub tool_name: String,
    pub snapshot: ToolCoordinationSnapshot,
}

pub struct ProjectToolExecutionService {
    database_path: PathBuf,
    project_id: String,
    dispatcher: ProjectToolDispatcher,
}

impl ProjectToolExecutionService {
    pub fn open(
        database_path: impl AsRef<Path>,
        project_root: ProjectRoot,
        project_id: String,
    ) -> Result<Self, ProjectToolExecutionError> {
        if project_id.trim().is_empty() {
            return Err(ProjectToolExecutionError::IdentityInvalid);
        }
        let database_path = database_path.as_ref().to_path_buf();
        EventJournal::open(&database_path)?;
        ArtifactStore::open(&database_path)?;
        let dispatcher = ProjectToolDispatcher::new(project_root)?;
        Ok(Self {
            database_path,
            project_id,
            dispatcher,
        })
    }

    pub async fn execute_provider_calls(
        &self,
        run_id: &str,
        invocation_id: &str,
        inference_id: &str,
        calls: &[ProviderInferenceToolCall],
        created_at: &str,
    ) -> Result<Vec<ProjectToolExecutionOutcome>, ProjectToolExecutionError> {
        let materialized = self.materialize(run_id, invocation_id, inference_id, calls)?;
        let mut outcomes = Vec::with_capacity(materialized.len());
        for call in materialized {
            let request = self.request_for(run_id, invocation_id, inference_id, &call)?;
            let snapshot = self.coordinate_request(run_id, &request, created_at)?;
            outcomes.push(
                self.continue_if_authorized(run_id, call, snapshot, created_at)
                    .await?,
            );
        }
        Ok(outcomes)
    }

    pub async fn resolve_assist_and_execute(
        &self,
        run_id: &str,
        invocation_id: &str,
        inference_id: &str,
        call: &ProviderInferenceToolCall,
        resolution: &ToolAuthorizationResolve,
        created_at: &str,
    ) -> Result<ProjectToolExecutionOutcome, ProjectToolExecutionError> {
        let materialized = self
            .materialize(
                run_id,
                invocation_id,
                inference_id,
                std::slice::from_ref(call),
            )?
            .remove(0);
        if materialized.tool_call_id != resolution.tool_call_id {
            return Err(ProjectToolExecutionError::IdentityConflict);
        }
        let request = self.request_for(run_id, invocation_id, inference_id, &materialized)?;
        self.coordinate_request(run_id, &request, created_at)?;
        let snapshot = {
            let mut journal = EventJournal::open(&self.database_path)?;
            let mut artifacts = ArtifactStore::open(&self.database_path)?;
            ToolCoordinationService::new(&mut journal, &mut artifacts).resolve_from_host(
                run_id,
                resolution,
                metadata(
                    &format!("host-resolve:{}", materialized.tool_call_id),
                    &resolution.authorization_idempotency_key,
                    created_at,
                ),
            )?
        };
        self.continue_if_authorized(run_id, materialized, snapshot, created_at)
            .await
    }

    pub async fn resolve_persisted_request_and_execute(
        &self,
        run_id: &str,
        request: &ToolRequest,
        resolution: &ToolAuthorizationResolve,
        created_at: &str,
    ) -> Result<ProjectToolExecutionOutcome, ProjectToolExecutionError> {
        if request.tool_call_id != resolution.tool_call_id {
            return Err(ProjectToolExecutionError::IdentityConflict);
        }
        let snapshot = {
            let mut journal = EventJournal::open(&self.database_path)?;
            let mut artifacts = ArtifactStore::open(&self.database_path)?;
            ToolCoordinationService::new(&mut journal, &mut artifacts).resolve_from_host(
                run_id,
                resolution,
                metadata(
                    &format!("host-resolve:{}", request.tool_call_id),
                    &resolution.authorization_idempotency_key,
                    created_at,
                ),
            )?
        };
        let materialized = MaterializedProviderToolCall {
            tool_call_id: request.tool_call_id,
            provider_tool_call_id: request.provider_tool_call_id.clone(),
            tool_name: request.tool_name.clone(),
            arguments: request.arguments.clone(),
        };
        self.continue_if_authorized(run_id, materialized, snapshot, created_at)
            .await
    }

    fn materialize(
        &self,
        run_id: &str,
        invocation_id: &str,
        inference_id: &str,
        calls: &[ProviderInferenceToolCall],
    ) -> Result<Vec<MaterializedProviderToolCall>, ProjectToolExecutionError> {
        let mut artifacts = ArtifactStore::open(&self.database_path)?;
        Ok(ProviderToolMaterializer::new(&mut artifacts).materialize(
            run_id,
            invocation_id,
            inference_id,
            calls,
        )?)
    }

    fn request_for(
        &self,
        run_id: &str,
        invocation_id: &str,
        inference_id: &str,
        call: &MaterializedProviderToolCall,
    ) -> Result<ToolRequest, ProjectToolExecutionError> {
        let journal = EventJournal::open(&self.database_path)?;
        let run = RunAggregate::recover(&journal, run_id)?;
        let pinned = run.pinned_identity();
        Ok(ToolRequest {
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
            side_effect: ToolProtocolSideEffect::None,
            parallel: false,
            arguments: call.arguments.clone(),
            source_scope: ToolSourceScope {
                source_checkpoint_id: pinned.source_checkpoint_id.clone(),
                resource_ids: pinned.scope_resource_ids.clone(),
                scope_sha256: pinned.resource_scope_sha256.clone(),
            },
            permission: ToolPermissionPolicy {
                mode: pinned.mode,
                policy_id: pinned.tool_policy.id.clone(),
                policy_version: pinned.tool_policy.version.clone(),
                policy_sha256: pinned.tool_policy.sha256.clone(),
            },
        })
    }

    fn coordinate_request(
        &self,
        run_id: &str,
        request: &ToolRequest,
        created_at: &str,
    ) -> Result<ToolCoordinationSnapshot, ProjectToolExecutionError> {
        let mut journal = EventJournal::open(&self.database_path)?;
        let mut artifacts = ArtifactStore::open(&self.database_path)?;
        Ok(
            ToolCoordinationService::new(&mut journal, &mut artifacts).request(
                run_id,
                &self.project_id,
                request,
                metadata(
                    &format!("tool-request:{}", request.tool_call_id),
                    &request.request_idempotency_key,
                    created_at,
                ),
            )?,
        )
    }

    async fn continue_if_authorized(
        &self,
        run_id: &str,
        call: MaterializedProviderToolCall,
        snapshot: ToolCoordinationSnapshot,
        created_at: &str,
    ) -> Result<ProjectToolExecutionOutcome, ProjectToolExecutionError> {
        match snapshot.status {
            ToolCoordinationStatus::ApprovalRequired
            | ToolCoordinationStatus::Succeeded
            | ToolCoordinationStatus::Failed
            | ToolCoordinationStatus::Denied => return Ok(outcome(call, snapshot)),
            ToolCoordinationStatus::Running => {
                return Err(ProjectToolExecutionError::OutcomeUnknown(call.tool_call_id));
            }
            ToolCoordinationStatus::Authorized => {}
        }
        let lease_id = snapshot
            .lease
            .as_ref()
            .ok_or(ProjectToolExecutionError::LeaseMissing)?
            .lease_id;
        let running = {
            let mut journal = EventJournal::open(&self.database_path)?;
            let mut artifacts = ArtifactStore::open(&self.database_path)?;
            ToolCoordinationService::new(&mut journal, &mut artifacts).start(
                run_id,
                call.tool_call_id,
                lease_id,
                metadata(
                    &format!("tool-start:{}", call.tool_call_id),
                    &format!("{}:start", call.tool_call_id),
                    created_at,
                ),
            )?
        };
        if running.status != ToolCoordinationStatus::Running {
            return Ok(outcome(call, running));
        }
        let arguments = ArtifactStore::open(&self.database_path)?
            .get(call.arguments.artifact_id)?
            .ok_or(ProjectToolExecutionError::ArgumentsMissing)?
            .content;
        match self.dispatcher.dispatch(&call.tool_name, arguments).await {
            Ok(result) => {
                let receipt = ArtifactStore::open(&self.database_path)?
                    .put_json(
                        execution_artifact_id(run_id, call.tool_call_id, "result"),
                        run_id,
                        &result,
                    )?
                    .receipt;
                let snapshot = {
                    let mut journal = EventJournal::open(&self.database_path)?;
                    let mut artifacts = ArtifactStore::open(&self.database_path)?;
                    ToolCoordinationService::new(&mut journal, &mut artifacts).succeed(
                        run_id,
                        call.tool_call_id,
                        lease_id,
                        &receipt,
                        metadata(
                            &format!("tool-success:{}", call.tool_call_id),
                            &format!("{}:success", call.tool_call_id),
                            created_at,
                        ),
                    )?
                };
                Ok(outcome(call, snapshot))
            }
            Err(error) => {
                let failure = dispatch_failure(&error);
                let receipt = ArtifactStore::open(&self.database_path)?
                    .put_json(
                        execution_artifact_id(run_id, call.tool_call_id, "failure"),
                        run_id,
                        &failure,
                    )?
                    .receipt;
                let snapshot = {
                    let mut journal = EventJournal::open(&self.database_path)?;
                    let mut artifacts = ArtifactStore::open(&self.database_path)?;
                    ToolCoordinationService::new(&mut journal, &mut artifacts).fail(
                        run_id,
                        call.tool_call_id,
                        lease_id,
                        &receipt,
                        metadata(
                            &format!("tool-failure:{}", call.tool_call_id),
                            &format!("{}:failure", call.tool_call_id),
                            created_at,
                        ),
                    )?
                };
                Ok(outcome(call, snapshot))
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectToolExecutionErrorClass {
    Initialization,
    Identity,
    Scope,
    Authorization,
    ToolArguments,
    Storage,
    RecoveryRequired,
}

#[derive(Debug, Error)]
pub enum ProjectToolExecutionError {
    #[error("project tool execution identity is invalid")]
    IdentityInvalid,
    #[error("project tool execution identity conflicts with the persisted call")]
    IdentityConflict,
    #[error("project tool arguments artifact is missing")]
    ArgumentsMissing,
    #[error("project tool permission lease is missing")]
    LeaseMissing,
    #[error(
        "project tool `{0}` was running without a terminal manifest and will not be redispatched"
    )]
    OutcomeUnknown(Uuid),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    Artifact(#[from] ArtifactStoreError),
    #[error(transparent)]
    Run(#[from] RunAggregateError),
    #[error(transparent)]
    Materialization(#[from] ProviderToolMaterializerError),
    #[error(transparent)]
    Coordination(#[from] ToolCoordinationError),
    #[error(transparent)]
    Dispatcher(#[from] ProjectToolDispatchError),
}

impl ProjectToolExecutionError {
    pub const fn class(&self) -> ProjectToolExecutionErrorClass {
        match self {
            Self::IdentityInvalid | Self::IdentityConflict => {
                ProjectToolExecutionErrorClass::Identity
            }
            Self::ArgumentsMissing => ProjectToolExecutionErrorClass::ToolArguments,
            Self::LeaseMissing => ProjectToolExecutionErrorClass::Authorization,
            Self::OutcomeUnknown(_) => ProjectToolExecutionErrorClass::RecoveryRequired,
            Self::Journal(_) | Self::Artifact(_) => ProjectToolExecutionErrorClass::Storage,
            Self::Run(_) => ProjectToolExecutionErrorClass::Scope,
            Self::Materialization(_) => ProjectToolExecutionErrorClass::ToolArguments,
            Self::Coordination(error) => coordination_class(error),
            Self::Dispatcher(_) => ProjectToolExecutionErrorClass::Initialization,
        }
    }

    pub const fn code(&self) -> &'static str {
        match self {
            Self::IdentityInvalid => "PROJECT_TOOL_IDENTITY_INVALID",
            Self::IdentityConflict => "PROJECT_TOOL_IDENTITY_CONFLICT",
            Self::ArgumentsMissing => "PROJECT_TOOL_ARGUMENTS_MISSING",
            Self::LeaseMissing => "PROJECT_TOOL_LEASE_MISSING",
            Self::OutcomeUnknown(_) => "PROJECT_TOOL_OUTCOME_UNKNOWN",
            Self::Journal(_) | Self::Artifact(_) => "PROJECT_TOOL_STORAGE_FAILED",
            Self::Run(_) => "PROJECT_TOOL_RUN_INVALID",
            Self::Materialization(_) => "PROJECT_TOOL_MATERIALIZATION_FAILED",
            Self::Coordination(_) => "PROJECT_TOOL_COORDINATION_REJECTED",
            Self::Dispatcher(_) => "PROJECT_TOOL_DISPATCHER_INITIALIZATION_FAILED",
        }
    }
}

const fn coordination_class(error: &ToolCoordinationError) -> ProjectToolExecutionErrorClass {
    match error {
        ToolCoordinationError::ProjectScopeMismatch
        | ToolCoordinationError::SourceScopeMismatch
        | ToolCoordinationError::RunNotRunning => ProjectToolExecutionErrorClass::Scope,
        ToolCoordinationError::PermissionPolicyMismatch
        | ToolCoordinationError::LeaseRequired
        | ToolCoordinationError::LeaseInvalid
        | ToolCoordinationError::HostResolutionNotAllowed => {
            ProjectToolExecutionErrorClass::Authorization
        }
        ToolCoordinationError::RequestInvalid
        | ToolCoordinationError::RequestIdentityConflict
        | ToolCoordinationError::ToolNotAllowed
        | ToolCoordinationError::ArtifactMissing
        | ToolCoordinationError::ArtifactScopeMismatch => {
            ProjectToolExecutionErrorClass::ToolArguments
        }
        ToolCoordinationError::CompletionManifestMissing
        | ToolCoordinationError::CompletionManifestConflict
        | ToolCoordinationError::FailureManifestMissing
        | ToolCoordinationError::FailureManifestConflict => {
            ProjectToolExecutionErrorClass::RecoveryRequired
        }
        ToolCoordinationError::Run(_) => ProjectToolExecutionErrorClass::Scope,
        ToolCoordinationError::Tool(_)
        | ToolCoordinationError::Artifact(_)
        | ToolCoordinationError::Journal(_)
        | ToolCoordinationError::Json(_) => ProjectToolExecutionErrorClass::Storage,
    }
}

fn outcome(
    call: MaterializedProviderToolCall,
    snapshot: ToolCoordinationSnapshot,
) -> ProjectToolExecutionOutcome {
    ProjectToolExecutionOutcome {
        tool_call_id: call.tool_call_id,
        provider_tool_call_id: call.provider_tool_call_id,
        tool_name: call.tool_name,
        snapshot,
    }
}

fn metadata<'a>(
    message_id: &'a str,
    idempotency_key: &'a str,
    created_at: &'a str,
) -> ToolEventMetadata<'a> {
    ToolEventMetadata {
        message_id,
        idempotency_key,
        created_at,
        reason: None,
    }
}

fn execution_artifact_id(run_id: &str, tool_call_id: Uuid, domain: &str) -> Uuid {
    const NAMESPACE: Uuid = Uuid::from_u128(0x98b517f1_a2df_4aa2_8cf7_d2854ef4fd93);
    Uuid::new_v5(
        &NAMESPACE,
        format!("novelx-project-tool-execution:{domain}:{run_id}:{tool_call_id}").as_bytes(),
    )
}

fn dispatch_failure(error: &ProjectToolDispatchError) -> Value {
    let (class, code) = match error {
        ProjectToolDispatchError::InvalidArguments(_) => {
            ("tool_arguments", "PROJECT_TOOL_ARGUMENTS_INVALID")
        }
        ProjectToolDispatchError::UnsupportedTool(_) => {
            ("tool_arguments", "PROJECT_TOOL_UNSUPPORTED")
        }
        ProjectToolDispatchError::Path(_) => ("project_scope", "PROJECT_PATH_REJECTED"),
        ProjectToolDispatchError::File(
            crate::project_file_tools::ProjectFileToolError::NotFound,
        ) => ("filesystem", "PROJECT_FILE_NOT_FOUND"),
        ProjectToolDispatchError::File(_) => ("filesystem", "PROJECT_FILE_OPERATION_FAILED"),
        ProjectToolDispatchError::Search(_) => ("filesystem", "PROJECT_SEARCH_FAILED"),
        ProjectToolDispatchError::ResultSerialization(_) => {
            ("internal", "PROJECT_TOOL_RESULT_INVALID")
        }
    };
    json!({
        "kind": "project_tool_failure_v1",
        "class": class,
        "code": code,
        "message": error.to_string(),
    })
}
