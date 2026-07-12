use novelx_protocol::{
    RunPermissionMode, ToolArtifactReceipt, ToolAuthorizationResolutionDecision,
    ToolAuthorizationResolve, ToolPermissionDecision, ToolPermissionLease, ToolProtocolSideEffect,
    ToolRequest,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::artifact_store::{ArtifactStore, ArtifactStoreError, StoredArtifact};
use crate::event_journal::{EventJournal, EventJournalError};
use crate::run_aggregate::{RunAggregate, RunAggregateError};
use crate::run_state::RunState;
use crate::tool_aggregate::{
    ToolAggregateError, ToolCallAggregate, ToolCallDefinition, ToolEventMetadata,
};
use crate::tool_state::{ToolAuthorization, ToolOutcomeKnowledge, ToolSideEffect, ToolState};

const READ_ONLY_TOOLS: [&str; 5] = [
    "list_project_directory",
    "stat_project_file",
    "glob_project_files",
    "search_project_files",
    "read_project_file",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolCoordinationStatus {
    ApprovalRequired,
    Authorized,
    Running,
    Succeeded,
    Failed,
    Denied,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolCoordinationSnapshot {
    pub run_id: String,
    pub tool_call_id: Uuid,
    pub state: ToolState,
    pub authorization: ToolAuthorization,
    pub status: ToolCoordinationStatus,
    pub lease: Option<ToolPermissionLease>,
    pub result: Option<ToolArtifactReceipt>,
    pub failure: Option<ToolArtifactReceipt>,
}

pub struct ToolCoordinationService<'a> {
    journal: &'a mut EventJournal,
    artifacts: &'a mut ArtifactStore,
}

impl<'a> ToolCoordinationService<'a> {
    pub const fn new(journal: &'a mut EventJournal, artifacts: &'a mut ArtifactStore) -> Self {
        Self { journal, artifacts }
    }

    pub fn request(
        &mut self,
        run_id: &str,
        project_id: &str,
        request: &ToolRequest,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<ToolCoordinationSnapshot, ToolCoordinationError> {
        request
            .validate()
            .map_err(|_| ToolCoordinationError::RequestInvalid)?;
        let run = self.validate_run_and_request(run_id, project_id, request)?;
        self.require_artifact(run_id, &request.arguments)?;
        let tool_call_id = request.tool_call_id.to_string();
        let definition = definition(request)?;
        let events = self
            .journal
            .read_aggregate(run_id, "tool", &tool_call_id, 0)?;
        let mut aggregate = if events.is_empty() {
            ToolCallAggregate::create(
                self.journal,
                run_id,
                &tool_call_id,
                definition,
                run.last_run_sequence(),
                ToolEventMetadata {
                    message_id: metadata.message_id,
                    idempotency_key: &request.request_idempotency_key,
                    created_at: metadata.created_at,
                    reason: metadata.reason,
                },
            )?
        } else {
            if events[0].idempotency_key != request.request_idempotency_key {
                return Err(ToolCoordinationError::RequestIdentityConflict);
            }
            let aggregate = ToolCallAggregate::recover(self.journal, run_id, &tool_call_id)?;
            if aggregate.definition() != &definition {
                return Err(ToolCoordinationError::RequestIdentityConflict);
            }
            aggregate
        };
        self.reconcile_orphans(run_id, request.tool_call_id, &mut aggregate)?;

        match request.permission.mode {
            RunPermissionMode::Free => {
                if aggregate.state() == ToolState::Requested
                    && aggregate.authorization() == ToolAuthorization::Pending
                {
                    let key = format!("{}:runtime-authorize", request.request_idempotency_key);
                    let lease = self.ensure_lease(
                        run_id,
                        request.tool_call_id,
                        &run,
                        &key,
                        metadata.created_at,
                    )?;
                    let message_id = format!("{}:runtime-authorize", metadata.message_id);
                    aggregate.authorize(
                        self.journal,
                        current_run_sequence(self.journal, run_id)?,
                        ToolEventMetadata {
                            message_id: &message_id,
                            idempotency_key: &key,
                            created_at: metadata.created_at,
                            reason: Some("free_mode_runtime_lease"),
                        },
                    )?;
                    return Ok(snapshot(&aggregate, request.tool_call_id, Some(lease)));
                }
            }
            RunPermissionMode::Assist => {
                if aggregate.state() == ToolState::Requested
                    && aggregate.authorization() == ToolAuthorization::Pending
                {
                    let key = format!("{}:approval-required", request.request_idempotency_key);
                    let message_id = format!("{}:approval-required", metadata.message_id);
                    aggregate.require_authorization(
                        self.journal,
                        current_run_sequence(self.journal, run_id)?,
                        ToolEventMetadata {
                            message_id: &message_id,
                            idempotency_key: &key,
                            created_at: metadata.created_at,
                            reason: Some("assist_mode_host_approval_required"),
                        },
                    )?;
                }
            }
        }
        let persisted = self.reconcile_orphans(run_id, request.tool_call_id, &mut aggregate)?;
        Ok(snapshot_with_outcome(
            &aggregate,
            request.tool_call_id,
            persisted.lease,
            persisted.result,
            persisted.failure,
        ))
    }

    pub fn resolve_from_host(
        &mut self,
        run_id: &str,
        resolution: &ToolAuthorizationResolve,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<ToolCoordinationSnapshot, ToolCoordinationError> {
        if resolution.authorization_idempotency_key.trim().is_empty() {
            return Err(ToolCoordinationError::RequestInvalid);
        }
        let run = RunAggregate::recover(self.journal, run_id)?;
        if run.state() != RunState::Running
            || run.pinned_identity().mode != RunPermissionMode::Assist
        {
            return Err(ToolCoordinationError::HostResolutionNotAllowed);
        }
        let tool_call_id = resolution.tool_call_id.to_string();
        let mut aggregate = ToolCallAggregate::recover(self.journal, run_id, &tool_call_id)?;
        if aggregate.state() == ToolState::Denied {
            self.require_transition_idempotency(
                run_id,
                &tool_call_id,
                "tool.denied",
                &resolution.authorization_idempotency_key,
            )?;
            return Ok(snapshot(&aggregate, resolution.tool_call_id, None));
        }
        if aggregate.authorization() == ToolAuthorization::Allowed {
            self.require_transition_idempotency(
                run_id,
                &tool_call_id,
                "tool.authorized",
                &resolution.authorization_idempotency_key,
            )?;
            let lease = self
                .load_lease(run_id, resolution.tool_call_id)?
                .ok_or(ToolCoordinationError::LeaseRequired)?;
            return Ok(snapshot(&aggregate, resolution.tool_call_id, Some(lease)));
        }
        if aggregate.authorization() != ToolAuthorization::ApprovalRequired {
            return Err(ToolCoordinationError::HostResolutionNotAllowed);
        }
        match resolution.decision {
            ToolAuthorizationResolutionDecision::Approve => {
                let lease = self.ensure_lease(
                    run_id,
                    resolution.tool_call_id,
                    &run,
                    &resolution.authorization_idempotency_key,
                    metadata.created_at,
                )?;
                aggregate.authorize(
                    self.journal,
                    current_run_sequence(self.journal, run_id)?,
                    ToolEventMetadata {
                        message_id: metadata.message_id,
                        idempotency_key: &resolution.authorization_idempotency_key,
                        created_at: metadata.created_at,
                        reason: Some("host_approved"),
                    },
                )?;
                Ok(snapshot(&aggregate, resolution.tool_call_id, Some(lease)))
            }
            ToolAuthorizationResolutionDecision::Deny => {
                aggregate.deny(
                    self.journal,
                    current_run_sequence(self.journal, run_id)?,
                    ToolEventMetadata {
                        message_id: metadata.message_id,
                        idempotency_key: &resolution.authorization_idempotency_key,
                        created_at: metadata.created_at,
                        reason: Some("host_denied"),
                    },
                )?;
                Ok(snapshot(&aggregate, resolution.tool_call_id, None))
            }
        }
    }

    pub fn start(
        &mut self,
        run_id: &str,
        tool_call_id: Uuid,
        lease_id: Uuid,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<ToolCoordinationSnapshot, ToolCoordinationError> {
        let mut aggregate =
            ToolCallAggregate::recover(self.journal, run_id, &tool_call_id.to_string())?;
        let persisted = self.reconcile_orphans(run_id, tool_call_id, &mut aggregate)?;
        if matches!(
            aggregate.state(),
            ToolState::Running | ToolState::Completed | ToolState::Failed
        ) {
            return Ok(snapshot_with_outcome(
                &aggregate,
                tool_call_id,
                persisted.lease,
                persisted.result,
                persisted.failure,
            ));
        }
        let lease = self.require_lease(run_id, tool_call_id, lease_id)?;
        if aggregate.state() == ToolState::Running {
            return Ok(snapshot(&aggregate, tool_call_id, Some(lease)));
        }
        aggregate.start(
            self.journal,
            current_run_sequence(self.journal, run_id)?,
            metadata,
        )?;
        Ok(snapshot(&aggregate, tool_call_id, Some(lease)))
    }

    pub fn succeed(
        &mut self,
        run_id: &str,
        tool_call_id: Uuid,
        lease_id: Uuid,
        result: &ToolArtifactReceipt,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<ToolCoordinationSnapshot, ToolCoordinationError> {
        let mut aggregate =
            ToolCallAggregate::recover(self.journal, run_id, &tool_call_id.to_string())?;
        let lease = self.require_lease(run_id, tool_call_id, lease_id)?;
        self.require_artifact(run_id, result)?;
        let manifest =
            self.ensure_completion(run_id, tool_call_id, lease_id, result, metadata.created_at)?;
        if aggregate.state() != ToolState::Completed {
            aggregate.complete(
                self.journal,
                current_run_sequence(self.journal, run_id)?,
                metadata,
            )?;
        }
        Ok(snapshot_with_result(
            &aggregate,
            tool_call_id,
            Some(lease),
            Some(manifest.result),
        ))
    }

    pub fn fail(
        &mut self,
        run_id: &str,
        tool_call_id: Uuid,
        lease_id: Uuid,
        error: &ToolArtifactReceipt,
        metadata: ToolEventMetadata<'_>,
    ) -> Result<ToolCoordinationSnapshot, ToolCoordinationError> {
        let mut aggregate =
            ToolCallAggregate::recover(self.journal, run_id, &tool_call_id.to_string())?;
        let lease = self.require_lease(run_id, tool_call_id, lease_id)?;
        self.require_artifact(run_id, error)?;
        let manifest =
            self.ensure_failure(run_id, tool_call_id, lease_id, error, metadata.created_at)?;
        if aggregate.state() != ToolState::Failed {
            aggregate.fail(
                self.journal,
                current_run_sequence(self.journal, run_id)?,
                ToolOutcomeKnowledge::Known,
                metadata,
            )?;
        }
        Ok(snapshot_with_outcome(
            &aggregate,
            tool_call_id,
            Some(lease),
            None,
            Some(manifest.error),
        ))
    }

    pub fn recover(
        &mut self,
        run_id: &str,
        tool_call_id: Uuid,
    ) -> Result<ToolCoordinationSnapshot, ToolCoordinationError> {
        let mut aggregate =
            ToolCallAggregate::recover(self.journal, run_id, &tool_call_id.to_string())?;
        let persisted = self.reconcile_orphans(run_id, tool_call_id, &mut aggregate)?;
        Ok(snapshot_with_outcome(
            &aggregate,
            tool_call_id,
            persisted.lease,
            persisted.result,
            persisted.failure,
        ))
    }

    fn reconcile_orphans(
        &mut self,
        run_id: &str,
        tool_call_id: Uuid,
        aggregate: &mut ToolCallAggregate,
    ) -> Result<PersistedOutcome, ToolCoordinationError> {
        let run = RunAggregate::recover(self.journal, run_id)?;
        let lease_manifest = self.load_lease_manifest(run_id, tool_call_id)?;
        let completion = self.load_completion(run_id, tool_call_id)?;
        let failure = self.load_failure(run_id, tool_call_id)?;
        if completion.is_some() && failure.is_some() {
            return Err(ToolCoordinationError::CompletionManifestConflict);
        }
        if let Some(manifest) = &lease_manifest {
            validate_lease_against_run(&manifest.lease, &run)?;
            if aggregate.state() == ToolState::Requested {
                let message_id = format!("recovery:{tool_call_id}:authorize");
                aggregate.authorize(
                    self.journal,
                    current_run_sequence(self.journal, run_id)?,
                    ToolEventMetadata {
                        message_id: &message_id,
                        idempotency_key: &manifest.authorization_idempotency_key,
                        created_at: &manifest.lease.granted_at,
                        reason: Some("recover_persisted_permission_lease"),
                    },
                )?;
            }
        } else if matches!(
            aggregate.state(),
            ToolState::Authorized | ToolState::Running | ToolState::Completed | ToolState::Failed
        ) {
            return Err(ToolCoordinationError::LeaseRequired);
        }
        let lease = lease_manifest.map(|manifest| manifest.lease);
        if let Some(manifest) = &completion {
            validate_manifest_lease(Some(manifest), lease.as_ref())?;
            match aggregate.state() {
                ToolState::Running => {
                    let message_id = format!("recovery:{tool_call_id}:complete");
                    let idempotency_key = format!("{tool_call_id}:recover-completion");
                    aggregate.complete(
                        self.journal,
                        current_run_sequence(self.journal, run_id)?,
                        ToolEventMetadata {
                            message_id: &message_id,
                            idempotency_key: &idempotency_key,
                            created_at: &manifest.recorded_at,
                            reason: Some("recover_persisted_completion_manifest"),
                        },
                    )?;
                }
                ToolState::Completed => {}
                _ => return Err(ToolCoordinationError::CompletionManifestConflict),
            }
        } else if aggregate.state() == ToolState::Completed {
            return Err(ToolCoordinationError::CompletionManifestMissing);
        }
        if let Some(manifest) = &failure {
            if lease
                .as_ref()
                .is_none_or(|lease| lease.lease_id != manifest.lease_id)
            {
                return Err(ToolCoordinationError::FailureManifestConflict);
            }
            match aggregate.state() {
                ToolState::Running => {
                    let message_id = format!("recovery:{tool_call_id}:fail");
                    let idempotency_key = format!("{tool_call_id}:recover-failure");
                    aggregate.fail(
                        self.journal,
                        current_run_sequence(self.journal, run_id)?,
                        ToolOutcomeKnowledge::Known,
                        ToolEventMetadata {
                            message_id: &message_id,
                            idempotency_key: &idempotency_key,
                            created_at: &manifest.recorded_at,
                            reason: Some("recover_persisted_failure_manifest"),
                        },
                    )?;
                }
                ToolState::Failed => {}
                _ => return Err(ToolCoordinationError::FailureManifestConflict),
            }
        } else if aggregate.state() == ToolState::Failed {
            return Err(ToolCoordinationError::FailureManifestMissing);
        }
        Ok(PersistedOutcome {
            lease,
            result: completion.map(|manifest| manifest.result),
            failure: failure.map(|manifest| manifest.error),
        })
    }

    fn validate_run_and_request(
        &self,
        run_id: &str,
        project_id: &str,
        request: &ToolRequest,
    ) -> Result<RunAggregate, ToolCoordinationError> {
        let run = RunAggregate::recover(self.journal, run_id)?;
        let pinned = run.pinned_identity();
        if run.state() != RunState::Running {
            return Err(ToolCoordinationError::RunNotRunning);
        }
        if pinned.project_id != project_id {
            return Err(ToolCoordinationError::ProjectScopeMismatch);
        }
        if request.source_scope.source_checkpoint_id != pinned.source_checkpoint_id
            || request.source_scope.resource_ids != pinned.scope_resource_ids
            || request.source_scope.scope_sha256 != pinned.resource_scope_sha256
        {
            return Err(ToolCoordinationError::SourceScopeMismatch);
        }
        if request.permission.mode != pinned.mode
            || request.permission.policy_id != pinned.tool_policy.id
            || request.permission.policy_version != pinned.tool_policy.version
            || request.permission.policy_sha256 != pinned.tool_policy.sha256
        {
            return Err(ToolCoordinationError::PermissionPolicyMismatch);
        }
        if request.side_effect != ToolProtocolSideEffect::None
            || !READ_ONLY_TOOLS.contains(&request.tool_name.as_str())
        {
            return Err(ToolCoordinationError::ToolNotAllowed);
        }
        Ok(run)
    }

    fn require_artifact(
        &self,
        run_id: &str,
        receipt: &ToolArtifactReceipt,
    ) -> Result<StoredArtifact, ToolCoordinationError> {
        let stored = self
            .artifacts
            .get(receipt.artifact_id)?
            .ok_or(ToolCoordinationError::ArtifactMissing)?;
        if stored.run_id != run_id || stored.receipt != *receipt {
            return Err(ToolCoordinationError::ArtifactScopeMismatch);
        }
        Ok(stored)
    }

    fn ensure_lease(
        &mut self,
        run_id: &str,
        tool_call_id: Uuid,
        run: &RunAggregate,
        authorization_idempotency_key: &str,
        granted_at: &str,
    ) -> Result<ToolPermissionLease, ToolCoordinationError> {
        if let Some(manifest) = self.load_lease_manifest(run_id, tool_call_id)? {
            if manifest.authorization_idempotency_key != authorization_idempotency_key {
                return Err(ToolCoordinationError::RequestIdentityConflict);
            }
            validate_lease_against_run(&manifest.lease, run)?;
            return Ok(manifest.lease);
        }
        let pinned = run.pinned_identity();
        let lease = ToolPermissionLease {
            lease_id: Uuid::new_v4(),
            tool_call_id,
            mode: pinned.mode,
            decision: ToolPermissionDecision::Allowed,
            policy_id: pinned.tool_policy.id.clone(),
            policy_version: pinned.tool_policy.version.clone(),
            policy_sha256: pinned.tool_policy.sha256.clone(),
            source_scope_sha256: pinned.resource_scope_sha256.clone(),
            granted_at: granted_at.to_owned(),
            expires_at: None,
        };
        let manifest = PermissionLeaseManifest {
            kind: "tool_permission_lease_v1".to_owned(),
            authorization_idempotency_key: authorization_idempotency_key.to_owned(),
            lease: lease.clone(),
        };
        self.artifacts.put_json(
            coordination_artifact_id(run_id, tool_call_id, "permission-lease"),
            run_id,
            &serde_json::to_value(&manifest)?,
        )?;
        Ok(lease)
    }

    fn load_lease(
        &self,
        run_id: &str,
        tool_call_id: Uuid,
    ) -> Result<Option<ToolPermissionLease>, ToolCoordinationError> {
        Ok(self
            .load_lease_manifest(run_id, tool_call_id)?
            .map(|manifest| manifest.lease))
    }

    fn load_lease_manifest(
        &self,
        run_id: &str,
        tool_call_id: Uuid,
    ) -> Result<Option<PermissionLeaseManifest>, ToolCoordinationError> {
        let Some(stored) = self.artifacts.get(coordination_artifact_id(
            run_id,
            tool_call_id,
            "permission-lease",
        ))?
        else {
            return Ok(None);
        };
        if stored.run_id != run_id {
            return Err(ToolCoordinationError::ArtifactScopeMismatch);
        }
        let manifest: PermissionLeaseManifest = serde_json::from_value(stored.content)?;
        if manifest.kind != "tool_permission_lease_v1"
            || manifest.authorization_idempotency_key.trim().is_empty()
            || manifest.lease.tool_call_id != tool_call_id
            || manifest.lease.decision != ToolPermissionDecision::Allowed
        {
            return Err(ToolCoordinationError::LeaseInvalid);
        }
        Ok(Some(manifest))
    }

    fn ensure_completion(
        &mut self,
        run_id: &str,
        tool_call_id: Uuid,
        lease_id: Uuid,
        result: &ToolArtifactReceipt,
        recorded_at: &str,
    ) -> Result<CompletionManifest, ToolCoordinationError> {
        if let Some(existing) = self.load_completion(run_id, tool_call_id)? {
            if existing.lease_id == lease_id && existing.result == *result {
                return Ok(existing);
            }
            return Err(ToolCoordinationError::CompletionManifestConflict);
        }
        let manifest = CompletionManifest {
            kind: "tool_completion_manifest_v1".to_owned(),
            tool_call_id,
            lease_id,
            result: result.clone(),
            recorded_at: recorded_at.to_owned(),
        };
        self.artifacts.put_json(
            coordination_artifact_id(run_id, tool_call_id, "completion-manifest"),
            run_id,
            &serde_json::to_value(&manifest)?,
        )?;
        Ok(manifest)
    }

    fn load_completion(
        &self,
        run_id: &str,
        tool_call_id: Uuid,
    ) -> Result<Option<CompletionManifest>, ToolCoordinationError> {
        let Some(stored) = self.artifacts.get(coordination_artifact_id(
            run_id,
            tool_call_id,
            "completion-manifest",
        ))?
        else {
            return Ok(None);
        };
        if stored.run_id != run_id {
            return Err(ToolCoordinationError::ArtifactScopeMismatch);
        }
        let manifest: CompletionManifest = serde_json::from_value(stored.content)?;
        if manifest.kind != "tool_completion_manifest_v1"
            || manifest.tool_call_id != tool_call_id
            || manifest.recorded_at.trim().is_empty()
        {
            return Err(ToolCoordinationError::CompletionManifestConflict);
        }
        self.require_artifact(run_id, &manifest.result)?;
        Ok(Some(manifest))
    }

    fn ensure_failure(
        &mut self,
        run_id: &str,
        tool_call_id: Uuid,
        lease_id: Uuid,
        error: &ToolArtifactReceipt,
        recorded_at: &str,
    ) -> Result<FailureManifest, ToolCoordinationError> {
        if let Some(existing) = self.load_failure(run_id, tool_call_id)? {
            if existing.lease_id == lease_id && existing.error == *error {
                return Ok(existing);
            }
            return Err(ToolCoordinationError::FailureManifestConflict);
        }
        let manifest = FailureManifest {
            kind: "tool_failure_manifest_v1".to_owned(),
            tool_call_id,
            lease_id,
            error: error.clone(),
            recorded_at: recorded_at.to_owned(),
        };
        self.artifacts.put_json(
            coordination_artifact_id(run_id, tool_call_id, "failure-manifest"),
            run_id,
            &serde_json::to_value(&manifest)?,
        )?;
        Ok(manifest)
    }

    fn load_failure(
        &self,
        run_id: &str,
        tool_call_id: Uuid,
    ) -> Result<Option<FailureManifest>, ToolCoordinationError> {
        let Some(stored) = self.artifacts.get(coordination_artifact_id(
            run_id,
            tool_call_id,
            "failure-manifest",
        ))?
        else {
            return Ok(None);
        };
        if stored.run_id != run_id {
            return Err(ToolCoordinationError::ArtifactScopeMismatch);
        }
        let manifest: FailureManifest = serde_json::from_value(stored.content)?;
        if manifest.kind != "tool_failure_manifest_v1"
            || manifest.tool_call_id != tool_call_id
            || manifest.recorded_at.trim().is_empty()
        {
            return Err(ToolCoordinationError::FailureManifestConflict);
        }
        self.require_artifact(run_id, &manifest.error)?;
        Ok(Some(manifest))
    }

    fn require_lease(
        &self,
        run_id: &str,
        tool_call_id: Uuid,
        lease_id: Uuid,
    ) -> Result<ToolPermissionLease, ToolCoordinationError> {
        let lease = self
            .load_lease(run_id, tool_call_id)?
            .ok_or(ToolCoordinationError::LeaseRequired)?;
        if lease.lease_id != lease_id {
            return Err(ToolCoordinationError::LeaseInvalid);
        }
        let run = RunAggregate::recover(self.journal, run_id)?;
        validate_lease_against_run(&lease, &run)?;
        Ok(lease)
    }

    fn require_transition_idempotency(
        &self,
        run_id: &str,
        tool_call_id: &str,
        event_type: &str,
        idempotency_key: &str,
    ) -> Result<(), ToolCoordinationError> {
        let matched = self
            .journal
            .read_aggregate(run_id, "tool", tool_call_id, 0)?
            .into_iter()
            .find(|event| event.event_type == event_type)
            .is_some_and(|event| event.idempotency_key == idempotency_key);
        if matched {
            Ok(())
        } else {
            Err(ToolCoordinationError::RequestIdentityConflict)
        }
    }
}

#[derive(Debug, Error)]
pub enum ToolCoordinationError {
    #[error("tool request is invalid")]
    RequestInvalid,
    #[error("tool request identity conflicts with persisted state")]
    RequestIdentityConflict,
    #[error("tool Run is not running")]
    RunNotRunning,
    #[error("tool project scope does not match the Run")]
    ProjectScopeMismatch,
    #[error("tool source scope does not match the Run")]
    SourceScopeMismatch,
    #[error("tool permission policy does not match the Run")]
    PermissionPolicyMismatch,
    #[error("tool is not an allowed read-only project tool")]
    ToolNotAllowed,
    #[error("tool artifact does not exist")]
    ArtifactMissing,
    #[error("tool artifact does not belong to this Run or receipt")]
    ArtifactScopeMismatch,
    #[error("tool lease is required")]
    LeaseRequired,
    #[error("tool lease is invalid")]
    LeaseInvalid,
    #[error("completed tool call is missing its persisted completion manifest")]
    CompletionManifestMissing,
    #[error("tool completion manifest conflicts with the persisted result")]
    CompletionManifestConflict,
    #[error("failed tool call is missing its persisted failure manifest")]
    FailureManifestMissing,
    #[error("tool failure manifest conflicts with the persisted error")]
    FailureManifestConflict,
    #[error("only the host may resolve Assist authorization")]
    HostResolutionNotAllowed,
    #[error(transparent)]
    Run(#[from] RunAggregateError),
    #[error(transparent)]
    Tool(#[from] ToolAggregateError),
    #[error(transparent)]
    Artifact(#[from] ArtifactStoreError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

fn definition(request: &ToolRequest) -> Result<ToolCallDefinition, ToolCoordinationError> {
    let side_effect = match request.side_effect {
        ToolProtocolSideEffect::None => ToolSideEffect::None,
        ToolProtocolSideEffect::StagedWrite => ToolSideEffect::StagedWrite,
        ToolProtocolSideEffect::ExternalEffect => ToolSideEffect::ExternalEffect,
    };
    Ok(ToolCallDefinition {
        provider_tool_call_id: request.provider_tool_call_id.clone(),
        tool_name: request.tool_name.clone(),
        schema_version: request.schema_version,
        arguments_hash: request.arguments.sha256.clone(),
        attempt: request.attempt,
        side_effect,
        parallel: request.parallel,
    })
}

fn snapshot(
    aggregate: &ToolCallAggregate,
    tool_call_id: Uuid,
    lease: Option<ToolPermissionLease>,
) -> ToolCoordinationSnapshot {
    snapshot_with_outcome(aggregate, tool_call_id, lease, None, None)
}

fn snapshot_with_result(
    aggregate: &ToolCallAggregate,
    tool_call_id: Uuid,
    lease: Option<ToolPermissionLease>,
    result: Option<ToolArtifactReceipt>,
) -> ToolCoordinationSnapshot {
    snapshot_with_outcome(aggregate, tool_call_id, lease, result, None)
}

fn snapshot_with_outcome(
    aggregate: &ToolCallAggregate,
    tool_call_id: Uuid,
    lease: Option<ToolPermissionLease>,
    result: Option<ToolArtifactReceipt>,
    failure: Option<ToolArtifactReceipt>,
) -> ToolCoordinationSnapshot {
    let status = match aggregate.state() {
        ToolState::Requested => ToolCoordinationStatus::ApprovalRequired,
        ToolState::Authorized => ToolCoordinationStatus::Authorized,
        ToolState::Running => ToolCoordinationStatus::Running,
        ToolState::Completed => ToolCoordinationStatus::Succeeded,
        ToolState::Failed | ToolState::TimedOut | ToolState::Cancelled => {
            ToolCoordinationStatus::Failed
        }
        ToolState::Denied => ToolCoordinationStatus::Denied,
    };
    ToolCoordinationSnapshot {
        run_id: aggregate.run_id().to_owned(),
        tool_call_id,
        state: aggregate.state(),
        authorization: aggregate.authorization(),
        status,
        lease,
        result,
        failure,
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompletionManifest {
    kind: String,
    tool_call_id: Uuid,
    lease_id: Uuid,
    result: ToolArtifactReceipt,
    recorded_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FailureManifest {
    kind: String,
    tool_call_id: Uuid,
    lease_id: Uuid,
    error: ToolArtifactReceipt,
    recorded_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PermissionLeaseManifest {
    kind: String,
    authorization_idempotency_key: String,
    lease: ToolPermissionLease,
}

struct PersistedOutcome {
    lease: Option<ToolPermissionLease>,
    result: Option<ToolArtifactReceipt>,
    failure: Option<ToolArtifactReceipt>,
}

fn coordination_artifact_id(run_id: &str, tool_call_id: Uuid, domain: &str) -> Uuid {
    const NAMESPACE: Uuid = Uuid::from_u128(0x6aab8a1b_4fa0_4b33_a5e8_9db52a916a2f);
    Uuid::new_v5(
        &NAMESPACE,
        format!("novelx-runtime-v2:{domain}:{run_id}:{tool_call_id}").as_bytes(),
    )
}

fn validate_lease_against_run(
    lease: &ToolPermissionLease,
    run: &RunAggregate,
) -> Result<(), ToolCoordinationError> {
    let pinned = run.pinned_identity();
    if lease.mode != pinned.mode
        || lease.policy_id != pinned.tool_policy.id
        || lease.policy_version != pinned.tool_policy.version
        || lease.policy_sha256 != pinned.tool_policy.sha256
        || lease.source_scope_sha256 != pinned.resource_scope_sha256
    {
        return Err(ToolCoordinationError::LeaseInvalid);
    }
    Ok(())
}

fn validate_manifest_lease(
    manifest: Option<&CompletionManifest>,
    lease: Option<&ToolPermissionLease>,
) -> Result<(), ToolCoordinationError> {
    if let Some(manifest) = manifest
        && lease.is_none_or(|lease| lease.lease_id != manifest.lease_id)
    {
        return Err(ToolCoordinationError::CompletionManifestConflict);
    }
    Ok(())
}

fn current_run_sequence(journal: &EventJournal, run_id: &str) -> Result<u64, EventJournalError> {
    Ok(journal
        .read_run(run_id, 0)?
        .last()
        .map_or(0, |event| event.run_sequence))
}
