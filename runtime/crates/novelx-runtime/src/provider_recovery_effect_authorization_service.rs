use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    agent_loop_journal::{
        AgentLoopJournalError, AgentLoopJournalRepository, AgentLoopProviderAuthorizationSnapshot,
        PendingInferenceOrigin,
    },
    context_compile_service::{
        ContextCompileServiceError, ContextCompiledRecord, normalized_provider_input_sha256,
        recover_compiled_record,
    },
    event_journal::{EventJournal, EventJournalError},
    operational_recovery_action::OperationalRecoveryAction,
    operational_recovery_aggregate::{
        OperationalRecoveryAggregateError, OperationalRecoveryEffectClass,
        OperationalRecoveryOperation, OperationalRecoveryRepository,
        ProviderDispatchResumeAuthorization, ProviderDispatchResumeCapability,
    },
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptError, ProviderAttemptState,
        provider_attempt_definition_sha256, provider_attempt_evidence_sha256,
    },
    provider_effect_capability::{
        OperationalRecoveryActorBinding, OperationalRecoveryAuthorityBinding,
        ProviderEffectAuthorityBinding, ProviderEffectCapability, ProviderEffectCapabilityError,
        ProviderEffectGrantMaterial, ProviderEffectGrantReceipt,
        ProviderEffectRetryScheduleBinding, canonical_database_path_sha256,
    },
    provider_gateway::{
        BoundProvider, PreparedProviderInference, ProviderGateway, ProviderGatewayError,
        ProviderInferenceRequest, ProviderRegistry,
    },
    provider_inference_service::{ProviderAttemptExecutionGuard, ProviderInferenceExecution},
    provider_retry_aggregate::{
        ProviderRetryAggregate, ProviderRetryError, ProviderRetryState,
        provider_retry_failure_observation_sha256,
    },
    run_aggregate::{RunAggregate, RunAggregateError},
    run_state::RunState,
    workspace_event_journal::{WorkspaceEventJournal, WorkspaceEventJournalError},
    workspace_runtime_lease::WorkspaceRuntimeLease,
};

use super::ProviderLiveEffectAuthorization;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRecoveryEffectAuthorizationRequest {
    pub run_id: Uuid,
    pub operation_id: String,
    pub execution_id: String,
    pub resume_authorization_id: Option<String>,
}

pub struct ProviderRecoveryEffectAuthorizationService {
    database_path: PathBuf,
    workspace_id: String,
    project_id: String,
}

impl ProviderRecoveryEffectAuthorizationService {
    pub fn new(
        database_path: impl AsRef<Path>,
        workspace_id: impl Into<String>,
        project_id: impl Into<String>,
    ) -> Result<Self, ProviderRecoveryEffectAuthorizationError> {
        let database_path = database_path.as_ref().to_path_buf();
        let workspace_id = workspace_id.into();
        let project_id = project_id.into();
        if workspace_id.trim().is_empty() || project_id.trim().is_empty() {
            return Err(ProviderRecoveryEffectAuthorizationError::IdentityInvalid);
        }
        EventJournal::open(&database_path)?;
        Ok(Self {
            database_path,
            workspace_id,
            project_id,
        })
    }

    pub fn authorize_recovery(
        &self,
        request: ProviderRecoveryEffectAuthorizationRequest,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        exclusive_lease: Arc<WorkspaceRuntimeLease>,
    ) -> Result<ProviderLiveEffectAuthorization, ProviderRecoveryEffectAuthorizationError> {
        validate_request(&request)?;
        if !exclusive_lease.protects_database(&self.database_path) {
            return Err(ProviderRecoveryEffectAuthorizationError::WorkspaceLeaseMismatch);
        }

        let clock = WorkspaceEventJournal::open(&self.database_path)?;
        let before_global = clock.current_global_sequence()?;
        let journal = EventJournal::open(&self.database_path)?;
        let run_id = request.run_id.to_string();
        let run = RunAggregate::recover(&journal, &run_id)?;
        if run.state() != RunState::Running {
            return Err(ProviderRecoveryEffectAuthorizationError::RunStateInvalid(
                run.state(),
            ));
        }
        let pinned = run.pinned_identity();
        if pinned.workspace_id != self.workspace_id || pinned.project_id != self.project_id {
            return Err(ProviderRecoveryEffectAuthorizationError::WorkspaceBindingMismatch);
        }
        let before_run_sequence = current_run_stream_sequence(&journal, &run_id)?;

        let recovery = OperationalRecoveryRepository::open(&self.database_path)?
            .load(&self.workspace_id, &run_id)?;
        if recovery.subject.workspace_id != self.workspace_id
            || recovery.subject.project_id != self.project_id
            || recovery.subject.run_id != run_id
        {
            return Err(ProviderRecoveryEffectAuthorizationError::RecoverySubjectMismatch);
        }
        let operation = recovery
            .operations
            .get(&request.operation_id)
            .ok_or(ProviderRecoveryEffectAuthorizationError::OperationMissing)?;
        let (claim, execution, action) = validate_operation(operation, &request)?;
        let dispatch = DispatchAction::from_action(action)?;
        let attempt = ProviderAttemptAggregate::recover(&journal, &run_id, &dispatch.attempt_id)?;
        if attempt.state() != ProviderAttemptState::Requested {
            return Err(
                ProviderRecoveryEffectAuthorizationError::AttemptNotRequested(attempt.state()),
            );
        }
        dispatch.validate_attempt(&run_id, &attempt)?;
        if pinned.provider != dispatch.provider {
            return Err(ProviderRecoveryEffectAuthorizationError::ProviderIdentityMismatch);
        }

        let definition_sha256 = provider_attempt_definition_sha256(&attempt)?;
        let evidence_sha256 = provider_attempt_evidence_sha256(&attempt)?;
        let (actor, issued_at) = recovery_actor(
            operation,
            &request,
            &attempt,
            &definition_sha256,
            &evidence_sha256,
            &exclusive_lease,
        )?;
        if parse_time(&issued_at)? < parse_time(attempt.requested_at())? {
            return Err(ProviderRecoveryEffectAuthorizationError::AuthorityBeforeAttempt);
        }

        let (loop_snapshot, pending_key, initial_context_compilation_id) = {
            let mut replay_journal = EventJournal::open(&self.database_path)?;
            let repository = AgentLoopJournalRepository::new(&mut replay_journal);
            let snapshot = repository
                .recover_provider_authorization_snapshot(&run_id, &dispatch.invocation_id)?;
            let record = repository.recover(&run_id, &dispatch.invocation_id)?;
            let identity = record.service.identity();
            if record.aggregate_sequence != snapshot.aggregate_sequence()
                || snapshot.run_id() != request.run_id
                || snapshot.invocation_id() != dispatch.invocation_id
                || identity.run_id != request.run_id
                || identity.project_id != self.project_id
                || identity.invocation_id != dispatch.invocation_id
                || identity.source_scope.source_checkpoint_id != pinned.source_checkpoint_id
                || identity.source_scope.resource_ids != pinned.scope_resource_ids
                || identity.source_scope.scope_sha256 != pinned.resource_scope_sha256
                || identity.permission.mode != pinned.mode
                || identity.permission.policy_id != pinned.tool_policy.id
                || identity.permission.policy_version != pinned.tool_policy.version
                || identity.permission.policy_sha256 != pinned.tool_policy.sha256
            {
                return Err(ProviderRecoveryEffectAuthorizationError::AgentLoopAuthorityMismatch);
            }
            let checkpoint = record.service.checkpoint_sha256()?;
            if checkpoint != dispatch.expected_loop_checkpoint_sha256
                || snapshot.checkpoint_sha256() != dispatch.expected_loop_checkpoint_sha256
            {
                return Err(ProviderRecoveryEffectAuthorizationError::LoopCheckpointMismatch);
            }
            let pending = record
                .service
                .pending_inference()
                .ok_or(ProviderRecoveryEffectAuthorizationError::PendingInferenceMissing)?;
            if pending.attempt_id.to_string() != dispatch.attempt_id
                || pending.inference_id.to_string() != dispatch.inference_id
                || pending.context_compilation_id.to_string() != dispatch.context_compilation_id
                || pending.request_number != attempt.definition().request_number
                || pending.attempt_number != dispatch.attempt_number
                || sha256(pending.inference_idempotency_key.as_bytes())
                    != attempt.requested_idempotency_key_sha256()
            {
                return Err(ProviderRecoveryEffectAuthorizationError::PendingInferenceMismatch);
            }
            validate_pending_origin(&snapshot, &attempt)?;
            (
                snapshot,
                pending.inference_idempotency_key.clone(),
                identity.initial_context_compilation_id,
            )
        };

        let compiled = recover_compiled_record(
            &journal,
            &run_id,
            attempt.definition().context_compilation_id,
        )?;
        validate_context(
            &compiled,
            &dispatch.invocation_id,
            attempt.definition().request_number,
            pinned,
        )?;
        let initial_context =
            recover_compiled_record(&journal, &run_id, initial_context_compilation_id)?;
        validate_context(&initial_context, &dispatch.invocation_id, 1, pinned)?;
        let provider = providers.resolve_owned(&pinned.provider)?;
        let prepared = gateway.prepare_inference(
            &provider,
            ProviderInferenceRequest {
                compilation: compiled.receipt.clone(),
                messages: compiled.normalized_input.messages.clone(),
                tools: compiled.normalized_input.tools.clone(),
            },
        )?;
        validate_transport(&attempt, &compiled, &prepared, &provider)?;

        let now = OffsetDateTime::now_utc();
        let (retry_schedule, inference_deadline_at, attempt_deadline_at) =
            recovery_deadlines(&journal, &attempt, &loop_snapshot, now)?;
        if parse_time(&issued_at)? >= parse_time(&attempt_deadline_at)? {
            return Err(ProviderRecoveryEffectAuthorizationError::DeadlineExpired);
        }
        let authority = ProviderEffectAuthorityBinding::OperationalRecovery(
            OperationalRecoveryAuthorityBinding {
                operation_id: request.operation_id,
                claim_id: claim.claim_id.clone(),
                execution_id: execution.execution_id.clone(),
                fencing_token: execution.fencing_token,
                action_spec_sha256: claim.action_spec_sha256.clone(),
                recovery_stream_sequence: recovery.revision,
                recovery_last_event_sha256: recovery.last_event_hash.clone(),
                actor,
            },
        );
        let material = ProviderEffectGrantMaterial {
            schema_version: ProviderEffectGrantMaterial::schema_version(),
            workspace_id: self.workspace_id.clone(),
            project_id: self.project_id.clone(),
            database_canonical_path_sha256: canonical_database_path_sha256(&self.database_path)?,
            lease_epoch: exclusive_lease.lease_epoch().to_owned(),
            run_id: request.run_id,
            invocation_id: dispatch.invocation_id.clone(),
            inference_id: Uuid::parse_str(&attempt.definition().inference_id)
                .map_err(|_| ProviderRecoveryEffectAuthorizationError::AttemptIdentityMismatch)?,
            attempt_id: Uuid::parse_str(&dispatch.attempt_id)
                .map_err(|_| ProviderRecoveryEffectAuthorizationError::AttemptIdentityMismatch)?,
            request_number: attempt.definition().request_number,
            attempt_number: attempt.definition().attempt_number,
            attempt_aggregate_sequence: attempt.aggregate_sequence(),
            attempt_definition_sha256: definition_sha256,
            attempt_evidence_sha256: evidence_sha256,
            context_compilation_id: attempt.definition().context_compilation_id,
            canonical_context_sha256: attempt.definition().canonical_context_sha256.clone(),
            transport_payload_sha256: attempt.definition().transport_payload_sha256.clone(),
            provider: attempt.definition().provider.clone(),
            inference_deadline_at,
            attempt_deadline_at,
            retry_schedule,
            authority,
            issued_at,
        };
        let execution_guard =
            ProviderAttemptExecutionGuard::acquire(&journal, &run_id, &dispatch.attempt_id)?;
        let expected_run_sequence = current_run_stream_sequence(&journal, &run_id)?;
        if expected_run_sequence != before_run_sequence {
            return Err(
                ProviderRecoveryEffectAuthorizationError::RunEvidenceChanged {
                    before: before_run_sequence,
                    after: expected_run_sequence,
                },
            );
        }
        let after_global = clock.current_global_sequence()?;
        if after_global != before_global {
            return Err(ProviderRecoveryEffectAuthorizationError::EvidenceChanged {
                before: before_global,
                after: after_global,
            });
        }
        let receipt = ProviderEffectGrantReceipt::derive(material.clone())?;
        let capability = ProviderEffectCapability::activate(
            receipt,
            &material,
            &self.database_path,
            Arc::clone(&exclusive_lease),
        )?;
        let provider_execution = ProviderInferenceExecution {
            run_id,
            attempt_id: dispatch.attempt_id,
            inference_id: dispatch.inference_id,
            invocation_id: dispatch.invocation_id,
            inference_idempotency_key: pending_key,
            attempt_number: dispatch.attempt_number,
            provider: dispatch.provider,
            request: ProviderInferenceRequest {
                compilation: compiled.receipt,
                messages: Vec::new(),
                tools: Vec::new(),
            },
        };
        Ok(ProviderLiveEffectAuthorization::from_parts(
            provider_execution,
            attempt,
            prepared,
            provider,
            execution_guard,
            capability,
            expected_run_sequence,
            before_global,
        ))
    }
}

fn validate_request(
    request: &ProviderRecoveryEffectAuthorizationRequest,
) -> Result<(), ProviderRecoveryEffectAuthorizationError> {
    if request.operation_id.trim().is_empty() || request.execution_id.trim().is_empty() {
        Err(ProviderRecoveryEffectAuthorizationError::IdentityInvalid)
    } else {
        Ok(())
    }
}

fn validate_operation<'a>(
    operation: &'a OperationalRecoveryOperation,
    request: &ProviderRecoveryEffectAuthorizationRequest,
) -> Result<
    (
        &'a crate::operational_recovery_aggregate::OperationalRecoveryClaim,
        &'a crate::operational_recovery_aggregate::OperationalRecoveryExecution,
        &'a OperationalRecoveryAction,
    ),
    ProviderRecoveryEffectAuthorizationError,
> {
    if operation.observation.operation_id != request.operation_id {
        return Err(ProviderRecoveryEffectAuthorizationError::RecoveryFenceMismatch);
    }
    if operation.disposition.is_some() || operation.outcome.is_some() || operation.stale.is_some() {
        return Err(ProviderRecoveryEffectAuthorizationError::OperationNotExecutable);
    }
    let claim = operation
        .claim
        .as_ref()
        .ok_or(ProviderRecoveryEffectAuthorizationError::ClaimMissing)?;
    let execution = operation
        .execution
        .as_ref()
        .ok_or(ProviderRecoveryEffectAuthorizationError::ExecutionMissing)?;
    let action = claim
        .action_spec
        .as_ref()
        .ok_or(ProviderRecoveryEffectAuthorizationError::ActionMissing)?;
    if execution.execution_id != request.execution_id
        || execution.claim_id != claim.claim_id
        || execution.owner_instance_id != claim.owner_instance_id
        || execution.fencing_token != claim.fencing_token
        || execution.source_fingerprint != claim.source_fingerprint
        || execution.action_spec_sha256 != claim.action_spec_sha256
        || execution.effect_class != OperationalRecoveryEffectClass::ProviderDispatch
        || action.action_spec_sha256()? != claim.action_spec_sha256
    {
        return Err(ProviderRecoveryEffectAuthorizationError::RecoveryFenceMismatch);
    }
    Ok((claim, execution, action))
}

fn recovery_actor(
    operation: &OperationalRecoveryOperation,
    request: &ProviderRecoveryEffectAuthorizationRequest,
    attempt: &ProviderAttemptAggregate,
    definition_sha256: &str,
    evidence_sha256: &str,
    exclusive_lease: &WorkspaceRuntimeLease,
) -> Result<(OperationalRecoveryActorBinding, String), ProviderRecoveryEffectAuthorizationError> {
    let execution = operation
        .execution
        .as_ref()
        .ok_or(ProviderRecoveryEffectAuthorizationError::ExecutionMissing)?;
    if exclusive_lease.proves_exclusive_owner(&execution.owner_instance_id) {
        if request.resume_authorization_id.is_some() {
            return Err(ProviderRecoveryEffectAuthorizationError::ResumeAuthorizationUnexpected);
        }
        return Ok((
            OperationalRecoveryActorBinding::OriginalOwner {
                owner_lease_epoch: exclusive_lease.lease_epoch().to_owned(),
                execution_started_at: execution.started_at.clone(),
            },
            execution.started_at.clone(),
        ));
    }

    let authorization_id = request
        .resume_authorization_id
        .as_deref()
        .ok_or(ProviderRecoveryEffectAuthorizationError::ResumeAuthorizationMissing)?;
    let authorization = operation
        .latest_provider_dispatch_resume()
        .ok_or(ProviderRecoveryEffectAuthorizationError::ResumeAuthorizationMissing)?;
    validate_resume_authorization(
        operation,
        authorization,
        authorization_id,
        attempt,
        definition_sha256,
        evidence_sha256,
        exclusive_lease,
    )?;
    Ok((
        OperationalRecoveryActorBinding::ResumeAuthorized {
            resumer_lease_epoch: exclusive_lease.lease_epoch().to_owned(),
            authorization_id: authorization.authorization_id.clone(),
            authorization_sha256: canonical_sha256(authorization)?,
            authorization_generation: authorization.authorization_generation,
            authorized_at: authorization.authorized_at.clone(),
        },
        authorization.authorized_at.clone(),
    ))
}

#[allow(clippy::too_many_arguments)]
fn validate_resume_authorization(
    operation: &OperationalRecoveryOperation,
    authorization: &ProviderDispatchResumeAuthorization,
    authorization_id: &str,
    attempt: &ProviderAttemptAggregate,
    definition_sha256: &str,
    evidence_sha256: &str,
    exclusive_lease: &WorkspaceRuntimeLease,
) -> Result<(), ProviderRecoveryEffectAuthorizationError> {
    let claim = operation
        .claim
        .as_ref()
        .ok_or(ProviderRecoveryEffectAuthorizationError::ClaimMissing)?;
    let execution = operation
        .execution
        .as_ref()
        .ok_or(ProviderRecoveryEffectAuthorizationError::ExecutionMissing)?;
    if authorization.authorization_id != authorization_id
        || authorization.operation_id != operation.observation.operation_id
        || authorization.execution_id != execution.execution_id
        || authorization.claim_id != claim.claim_id
        || authorization.original_owner_instance_id != execution.owner_instance_id
        || authorization.resumer_instance_id != exclusive_lease.instance_id()
        || authorization.fencing_token != execution.fencing_token
        || authorization.action_spec_sha256 != claim.action_spec_sha256
        || authorization.attempt_id != attempt.attempt_id()
        || authorization.attempt_state != ProviderAttemptState::Requested
        || authorization.attempt_aggregate_sequence != attempt.aggregate_sequence()
        || authorization.attempt_definition_sha256 != definition_sha256
        || authorization.attempt_evidence_sha256 != evidence_sha256
        || authorization.capability != ProviderDispatchResumeCapability::DispatchRequested
        || !exclusive_lease.proves_exclusive_owner(&authorization.resumer_instance_id)
    {
        return Err(ProviderRecoveryEffectAuthorizationError::ResumeEvidenceChanged);
    }
    Ok(())
}

#[derive(Clone)]
struct DispatchAction {
    invocation_id: String,
    attempt_id: String,
    inference_id: String,
    context_compilation_id: String,
    attempt_number: u16,
    provider: novelx_protocol::ProviderRunIdentity,
    canonical_context_sha256: String,
    expected_loop_checkpoint_sha256: String,
    expected_attempt_sequence: u64,
    transport_payload_sha256: String,
}

impl DispatchAction {
    fn from_action(
        action: &OperationalRecoveryAction,
    ) -> Result<Self, ProviderRecoveryEffectAuthorizationError> {
        let OperationalRecoveryAction::PersistedProviderAttemptDispatch {
            invocation_id,
            attempt_id,
            inference_id,
            context_compilation_id,
            attempt_number,
            provider,
            canonical_context_sha256,
            expected_loop_checkpoint_sha256,
            expected_attempt_sequence,
            transport_payload_sha256,
        } = action
        else {
            return Err(ProviderRecoveryEffectAuthorizationError::ActionNotDispatch);
        };
        Ok(Self {
            invocation_id: invocation_id.clone(),
            attempt_id: attempt_id.clone(),
            inference_id: inference_id.clone(),
            context_compilation_id: context_compilation_id.clone(),
            attempt_number: *attempt_number,
            provider: provider.clone(),
            canonical_context_sha256: canonical_context_sha256.clone(),
            expected_loop_checkpoint_sha256: expected_loop_checkpoint_sha256.clone(),
            expected_attempt_sequence: *expected_attempt_sequence,
            transport_payload_sha256: transport_payload_sha256.clone(),
        })
    }

    fn validate_attempt(
        &self,
        run_id: &str,
        attempt: &ProviderAttemptAggregate,
    ) -> Result<(), ProviderRecoveryEffectAuthorizationError> {
        let definition = attempt.definition();
        if attempt.attempt_id() != self.attempt_id
            || definition.run_id != run_id
            || definition.inference_id != self.inference_id
            || definition.invocation_id != self.invocation_id
            || definition.context_compilation_id.to_string() != self.context_compilation_id
            || definition.attempt_number != self.attempt_number
            || definition.provider != self.provider
            || definition.canonical_context_sha256 != self.canonical_context_sha256
            || definition.transport_payload_sha256 != self.transport_payload_sha256
            || attempt.aggregate_sequence() != self.expected_attempt_sequence
        {
            return Err(ProviderRecoveryEffectAuthorizationError::AttemptIdentityMismatch);
        }
        Ok(())
    }
}

fn validate_context(
    compiled: &ContextCompiledRecord,
    invocation_id: &str,
    expected_request_number: u64,
    pinned: &novelx_protocol::RunPinnedIdentity,
) -> Result<(), ProviderRecoveryEffectAuthorizationError> {
    let source = compiled
        .source_command
        .as_ref()
        .ok_or(ProviderRecoveryEffectAuthorizationError::ContextSourceMissing)?;
    if !compiled.receipt.accepted
        || source.invocation_id != invocation_id
        || source.request_number != expected_request_number
        || compiled.receipt.request_number != expected_request_number
        || source.provider != pinned.provider
        || source.context_policy != pinned.context_policy
        || normalized_provider_input_sha256(&compiled.normalized_input)?
            != compiled.normalized_input_sha256
    {
        return Err(ProviderRecoveryEffectAuthorizationError::ContextEvidenceMismatch);
    }
    Ok(())
}

fn validate_pending_origin(
    snapshot: &AgentLoopProviderAuthorizationSnapshot,
    attempt: &ProviderAttemptAggregate,
) -> Result<(), ProviderRecoveryEffectAuthorizationError> {
    let expected = match (
        attempt.definition().request_number,
        attempt.definition().attempt_number,
    ) {
        (1, 1) => PendingInferenceOrigin::Created,
        (request_number, 1) if request_number > 1 => PendingInferenceOrigin::InferenceStarted,
        (_, attempt_number) if attempt_number > 1 => PendingInferenceOrigin::InferenceRetried,
        _ => return Err(ProviderRecoveryEffectAuthorizationError::PendingInferenceMismatch),
    };
    if snapshot.pending_inference_origin() != expected {
        return Err(
            ProviderRecoveryEffectAuthorizationError::PendingInferenceOriginMismatch {
                expected,
                actual: snapshot.pending_inference_origin(),
            },
        );
    }
    if attempt.definition().attempt_number == 1 && snapshot.last_retry_binding().is_some() {
        return Err(ProviderRecoveryEffectAuthorizationError::RetryBindingUnexpected);
    }
    Ok(())
}

fn validate_transport(
    attempt: &ProviderAttemptAggregate,
    compiled: &ContextCompiledRecord,
    prepared: &PreparedProviderInference,
    provider: &BoundProvider,
) -> Result<(), ProviderRecoveryEffectAuthorizationError> {
    let definition = attempt.definition();
    if compiled.receipt.compilation_id != definition.context_compilation_id
        || compiled.receipt.request_number != definition.request_number
        || compiled.receipt.canonical_context_sha256 != definition.canonical_context_sha256
        || compiled.receipt.output_reserve_tokens != definition.output_reserve_tokens
        || prepared.compilation() != &compiled.receipt
        || prepared.transport_payload_sha256() != definition.transport_payload_sha256
        || provider.config_sha256() != definition.provider.config_sha256
        || provider.config().profile_id != definition.provider.profile_id
        || provider.config().provider_id != definition.provider.provider_id
        || provider.config().model_id != definition.provider.model_id
        || provider.config().request_timeout_ms != definition.request_timeout_ms
        || provider.config().total_deadline_ms != definition.total_deadline_ms
        || provider.config().retry_policy.max_attempts != definition.max_attempts
        || provider.config().retry_policy.max_total_delay_ms != definition.max_total_delay_ms
    {
        return Err(ProviderRecoveryEffectAuthorizationError::ContextOrProviderMismatch);
    }
    Ok(())
}

fn recovery_deadlines(
    journal: &EventJournal,
    attempt: &ProviderAttemptAggregate,
    snapshot: &AgentLoopProviderAuthorizationSnapshot,
    now: OffsetDateTime,
) -> Result<
    (Option<ProviderEffectRetryScheduleBinding>, String, String),
    ProviderRecoveryEffectAuthorizationError,
> {
    if attempt.definition().attempt_number == 1 {
        let requested = parse_time(attempt.requested_at())?;
        let milliseconds = i64::try_from(attempt.definition().total_deadline_ms)
            .map_err(|_| ProviderRecoveryEffectAuthorizationError::DeadlineInvalid)?;
        let deadline = requested
            .checked_add(Duration::milliseconds(milliseconds))
            .ok_or(ProviderRecoveryEffectAuthorizationError::DeadlineInvalid)?;
        if now >= deadline {
            return Err(ProviderRecoveryEffectAuthorizationError::DeadlineExpired);
        }
        let deadline = format_time(deadline)?;
        return Ok((None, deadline.clone(), deadline));
    }

    let definition = attempt.definition();
    let retry =
        ProviderRetryAggregate::recover(journal, &definition.run_id, &definition.inference_id)?;
    if retry.state() != ProviderRetryState::AwaitingAttempt {
        return Err(
            ProviderRecoveryEffectAuthorizationError::RetryNotAwaitingAttempt(retry.state()),
        );
    }
    let retry_definition = retry.definition();
    let schedule = retry
        .schedule()
        .ok_or(ProviderRecoveryEffectAuthorizationError::RetryScheduleMissing)?;
    let observation = retry
        .failure_observation()
        .ok_or(ProviderRecoveryEffectAuthorizationError::RetryParentMissing)?;
    let parent = ProviderAttemptAggregate::recover(
        journal,
        &definition.run_id,
        &observation.attempt_id.to_string(),
    )?;
    let parent_failure = parent
        .failure()
        .ok_or(ProviderRecoveryEffectAuthorizationError::RetryParentMismatch)?;
    let parent_definition = parent.definition();
    let observation_sha256 = provider_retry_failure_observation_sha256(observation)?;
    let binding = snapshot
        .last_retry_binding()
        .ok_or(ProviderRecoveryEffectAuthorizationError::RetryBindingMissing)?;
    if retry_definition.run_id != definition.run_id
        || retry_definition.invocation_id != definition.invocation_id
        || retry_definition.inference_id != definition.inference_id
        || retry_definition.request_number != definition.request_number
        || retry_definition.context_compilation_id != definition.context_compilation_id
        || retry_definition.provider != definition.provider
        || retry_definition.canonical_context_sha256 != definition.canonical_context_sha256
        || retry_definition.transport_payload_sha256 != definition.transport_payload_sha256
        || retry_definition.request_timeout_ms != definition.request_timeout_ms
        || retry_definition.total_deadline_ms != definition.total_deadline_ms
        || retry_definition.policy.max_attempts != definition.max_attempts
        || retry_definition.policy.max_total_delay_ms != definition.max_total_delay_ms
        || schedule.next_attempt_id.to_string() != attempt.attempt_id()
        || schedule.next_attempt_number != definition.attempt_number
        || schedule.parent_failure_evidence_sha256 != observation.evidence_sha256
        || schedule.parent_failure_observation_sha256 != observation_sha256
        || binding.next.attempt_id.to_string() != attempt.attempt_id()
        || binding.next.inference_id.to_string() != definition.inference_id
        || binding.next.request_number != definition.request_number
        || binding.next.context_compilation_id != definition.context_compilation_id
        || binding.next.attempt_number != definition.attempt_number
        || binding.schedule_id != schedule.schedule_id.to_string()
        || binding.schedule_sha256 != schedule.schedule_sha256
        || binding.previous_attempt_id != observation.attempt_id
        || binding.previous_attempt_number != observation.attempt_number
        || binding.parent_attempt_evidence_sha256 != observation.evidence_sha256
        || parent.state() != ProviderAttemptState::Failed
        || !parent_failure.retryable
        || parent.attempt_id() != observation.attempt_id.to_string()
        || parent_definition.attempt_number != observation.attempt_number
        || parent.aggregate_sequence() != observation.attempt_aggregate_sequence
        || provider_attempt_definition_sha256(&parent)? != observation.attempt_definition_sha256
        || provider_attempt_evidence_sha256(&parent)? != observation.evidence_sha256
        || parent_failure != &observation.failure
        || parent_definition.run_id != definition.run_id
        || parent_definition.invocation_id != definition.invocation_id
        || parent_definition.inference_id != definition.inference_id
        || parent_definition.request_number != definition.request_number
        || parent_definition.context_compilation_id != definition.context_compilation_id
        || parent_definition.provider != definition.provider
        || parent_definition.canonical_context_sha256 != definition.canonical_context_sha256
        || parent_definition.transport_payload_sha256 != definition.transport_payload_sha256
        || parent_definition.output_reserve_tokens != definition.output_reserve_tokens
        || parent_definition.request_timeout_ms != definition.request_timeout_ms
        || parent_definition.total_deadline_ms != definition.total_deadline_ms
        || parent_definition.max_attempts != definition.max_attempts
        || parent_definition.max_total_delay_ms != definition.max_total_delay_ms
    {
        return Err(ProviderRecoveryEffectAuthorizationError::RetryParentMismatch);
    }
    if now < parse_time(&schedule.not_before)? {
        return Err(ProviderRecoveryEffectAuthorizationError::RetryNotBefore);
    }
    if now >= parse_time(&schedule.attempt_deadline_at)?
        || now >= parse_time(&retry_definition.deadline_at)?
    {
        return Err(ProviderRecoveryEffectAuthorizationError::DeadlineExpired);
    }
    Ok((
        Some(ProviderEffectRetryScheduleBinding {
            retry_definition_sha256: retry.definition_sha256().to_owned(),
            retry_aggregate_sequence: retry.aggregate_sequence(),
            schedule_id: schedule.schedule_id,
            schedule_sha256: schedule.schedule_sha256.clone(),
            parent_failure_evidence_sha256: schedule.parent_failure_evidence_sha256.clone(),
            parent_failure_observation_sha256: schedule.parent_failure_observation_sha256.clone(),
            next_attempt_id: schedule.next_attempt_id,
            next_attempt_number: schedule.next_attempt_number,
            not_before: schedule.not_before.clone(),
            attempt_deadline_at: schedule.attempt_deadline_at.clone(),
        }),
        retry_definition.deadline_at.clone(),
        schedule.attempt_deadline_at.clone(),
    ))
}

fn canonical_sha256<T: Serialize>(
    value: &T,
) -> Result<String, ProviderRecoveryEffectAuthorizationError> {
    Ok(sha256(&serde_json::to_vec(&canonicalize(
        serde_json::to_value(value)?,
    ))?))
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        Value::Object(values) => {
            let mut entries = values.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonicalize(value)))
                    .collect(),
            )
        }
        scalar => scalar,
    }
}

fn current_run_stream_sequence(
    journal: &EventJournal,
    run_id: &str,
) -> Result<u64, ProviderRecoveryEffectAuthorizationError> {
    journal
        .read_run(run_id, 0)?
        .last()
        .map(|event| event.run_sequence)
        .ok_or(ProviderRecoveryEffectAuthorizationError::RunEvidenceMissing)
}

fn parse_time(value: &str) -> Result<OffsetDateTime, ProviderRecoveryEffectAuthorizationError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| ProviderRecoveryEffectAuthorizationError::DeadlineInvalid)
}

fn format_time(value: OffsetDateTime) -> Result<String, ProviderRecoveryEffectAuthorizationError> {
    value
        .format(&Rfc3339)
        .map_err(|_| ProviderRecoveryEffectAuthorizationError::DeadlineInvalid)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Error)]
pub enum ProviderRecoveryEffectAuthorizationError {
    #[error("Provider recovery effect authorization identity is invalid")]
    IdentityInvalid,
    #[error("Provider recovery effect authorization lease does not protect this database")]
    WorkspaceLeaseMismatch,
    #[error("Provider recovery effect authorization workspace/project does not match the Run")]
    WorkspaceBindingMismatch,
    #[error("Provider recovery effect authorization requires a Running Run, found {0:?}")]
    RunStateInvalid(RunState),
    #[error("Provider recovery subject does not match the requested Run")]
    RecoverySubjectMismatch,
    #[error("Provider recovery operation is missing")]
    OperationMissing,
    #[error("Provider recovery Claim is missing")]
    ClaimMissing,
    #[error("Provider recovery Execution is missing")]
    ExecutionMissing,
    #[error("Provider recovery dispatch action is missing")]
    ActionMissing,
    #[error("Provider recovery action is not a persisted Provider dispatch")]
    ActionNotDispatch,
    #[error("Provider recovery operation is terminal, stale, waiting, or quarantined")]
    OperationNotExecutable,
    #[error("Provider recovery Claim, Execution, or action fence does not match")]
    RecoveryFenceMismatch,
    #[error("Provider recovery requires a Requested attempt, found {0:?}")]
    AttemptNotRequested(ProviderAttemptState),
    #[error("Provider recovery attempt does not match the durable action")]
    AttemptIdentityMismatch,
    #[error("Provider recovery Provider identity does not match the pinned Run")]
    ProviderIdentityMismatch,
    #[error("Provider recovery original authority predates provider.requested")]
    AuthorityBeforeAttempt,
    #[error("Provider recovery Agent Loop authority does not match the pinned Run")]
    AgentLoopAuthorityMismatch,
    #[error("Provider recovery Agent Loop checkpoint changed")]
    LoopCheckpointMismatch,
    #[error("Provider recovery pending inference is missing")]
    PendingInferenceMissing,
    #[error("Provider recovery pending inference does not match the action")]
    PendingInferenceMismatch,
    #[error(
        "Provider recovery pending inference origin differs: expected {expected:?}, found {actual:?}"
    )]
    PendingInferenceOriginMismatch {
        expected: PendingInferenceOrigin,
        actual: PendingInferenceOrigin,
    },
    #[error("Provider recovery compiled context has no source command")]
    ContextSourceMissing,
    #[error("Provider recovery compiled context evidence changed")]
    ContextEvidenceMismatch,
    #[error("Provider recovery context, transport payload, or Provider config changed")]
    ContextOrProviderMismatch,
    #[error("Provider recovery resume authorization is required")]
    ResumeAuthorizationMissing,
    #[error("Provider recovery resume authorization is invalid for the original owner")]
    ResumeAuthorizationUnexpected,
    #[error("Provider recovery resume authorization no longer matches persisted evidence")]
    ResumeEvidenceChanged,
    #[error("Provider recovery retry is not AwaitingAttempt, found {0:?}")]
    RetryNotAwaitingAttempt(ProviderRetryState),
    #[error("Provider recovery retry binding is missing")]
    RetryBindingMissing,
    #[error("Provider recovery retry binding is unexpected for attempt one")]
    RetryBindingUnexpected,
    #[error("Provider recovery retry schedule is missing")]
    RetryScheduleMissing,
    #[error("Provider recovery retry parent evidence is missing")]
    RetryParentMissing,
    #[error("Provider recovery retry parent evidence changed")]
    RetryParentMismatch,
    #[error("Provider recovery retry not-before time has not arrived")]
    RetryNotBefore,
    #[error("Provider recovery deadline is invalid")]
    DeadlineInvalid,
    #[error("Provider recovery deadline has expired")]
    DeadlineExpired,
    #[error("Provider recovery Run evidence changed during authorization: {before} -> {after}")]
    RunEvidenceChanged { before: u64, after: u64 },
    #[error("Provider recovery evidence changed during authorization: {before} -> {after}")]
    EvidenceChanged { before: u64, after: u64 },
    #[error("Provider recovery Run stream is empty")]
    RunEvidenceMissing,
    #[error(transparent)]
    Recovery(#[from] OperationalRecoveryAggregateError),
    #[error(transparent)]
    AgentLoop(#[from] AgentLoopJournalError),
    #[error(transparent)]
    AgentLoopState(#[from] crate::agent_loop_service::AgentLoopError),
    #[error(transparent)]
    Attempt(#[from] ProviderAttemptError),
    #[error(transparent)]
    Context(#[from] ContextCompileServiceError),
    #[error(transparent)]
    Retry(#[from] ProviderRetryError),
    #[error(transparent)]
    Provider(#[from] ProviderGatewayError),
    #[error(transparent)]
    ProviderInference(#[from] crate::provider_inference_service::ProviderInferenceServiceError),
    #[error(transparent)]
    Capability(#[from] ProviderEffectCapabilityError),
    #[error(transparent)]
    Run(#[from] RunAggregateError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    WorkspaceJournal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
