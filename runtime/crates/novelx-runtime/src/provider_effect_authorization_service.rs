use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    agent_loop_journal::{
        AgentLoopJournalError, AgentLoopJournalRepository, AgentLoopProviderAuthorizationSnapshot,
        AgentLoopRecord, PendingInferenceOrigin,
    },
    agent_loop_service::InferenceDispatchIdentity,
    context_compile_service::{
        ContextCompileServiceError, ContextCompiledRecord, normalized_provider_input_sha256,
        recover_compiled_record,
    },
    event_journal::{EventJournal, EventJournalError},
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptError,
        ProviderAttemptState, provider_attempt_definition_sha256, provider_attempt_evidence_sha256,
    },
    provider_effect_capability::{
        AgentLoopContinuationAuthorityBinding, AgentLoopRetryAuthorityBinding,
        InitialAgentLoopAuthorityBinding, ProviderEffectAuthorityBinding, ProviderEffectCapability,
        ProviderEffectCapabilityError, ProviderEffectGrantMaterial, ProviderEffectGrantReceipt,
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

#[path = "provider_recovery_effect_authorization_service.rs"]
pub mod recovery;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveEffectAuthorizationRequest {
    pub run_id: Uuid,
    pub invocation_id: String,
    pub attempt_id: Uuid,
}

pub struct ProviderEffectAuthorizationService {
    database_path: PathBuf,
    workspace_id: String,
    project_id: String,
}

pub struct ProviderLiveEffectAuthorization {
    execution: ProviderInferenceExecution,
    attempt: ProviderAttemptAggregate,
    prepared: PreparedProviderInference,
    provider: Arc<BoundProvider>,
    execution_guard: ProviderAttemptExecutionGuard,
    capability: ProviderEffectCapability,
    expected_run_sequence: u64,
    expected_global_sequence: u64,
}

#[allow(dead_code)]
impl ProviderLiveEffectAuthorization {
    #[allow(clippy::too_many_arguments)]
    fn from_parts(
        execution: ProviderInferenceExecution,
        attempt: ProviderAttemptAggregate,
        prepared: PreparedProviderInference,
        provider: Arc<BoundProvider>,
        execution_guard: ProviderAttemptExecutionGuard,
        capability: ProviderEffectCapability,
        expected_run_sequence: u64,
        expected_global_sequence: u64,
    ) -> Self {
        Self {
            execution,
            attempt,
            prepared,
            provider,
            execution_guard,
            capability,
            expected_run_sequence,
            expected_global_sequence,
        }
    }

    pub const fn expected_run_sequence(&self) -> u64 {
        self.expected_run_sequence
    }

    pub const fn expected_global_sequence(&self) -> u64 {
        self.expected_global_sequence
    }

    pub(crate) fn recovery_probe(
        &self,
    ) -> (
        String,
        String,
        ProviderAttemptDefinition,
        ProviderAttemptExecutionGuard,
    ) {
        (
            self.execution.run_id.clone(),
            self.execution.attempt_id.clone(),
            self.attempt.definition().clone(),
            self.execution_guard.clone(),
        )
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        ProviderInferenceExecution,
        ProviderAttemptAggregate,
        PreparedProviderInference,
        Arc<BoundProvider>,
        ProviderAttemptExecutionGuard,
        ProviderEffectCapability,
        u64,
        u64,
    ) {
        (
            self.execution,
            self.attempt,
            self.prepared,
            self.provider,
            self.execution_guard,
            self.capability,
            self.expected_run_sequence,
            self.expected_global_sequence,
        )
    }
}

impl ProviderEffectAuthorizationService {
    pub fn new(
        database_path: impl AsRef<Path>,
        workspace_id: impl Into<String>,
        project_id: impl Into<String>,
    ) -> Result<Self, ProviderEffectAuthorizationError> {
        let database_path = database_path.as_ref().to_path_buf();
        let workspace_id = workspace_id.into();
        let project_id = project_id.into();
        if workspace_id.trim().is_empty() || project_id.trim().is_empty() {
            return Err(ProviderEffectAuthorizationError::IdentityInvalid);
        }
        EventJournal::open(&database_path)?;
        Ok(Self {
            database_path,
            workspace_id,
            project_id,
        })
    }

    pub fn authorize_live(
        &self,
        request: ProviderLiveEffectAuthorizationRequest,
        providers: &ProviderRegistry,
        gateway: &ProviderGateway,
        exclusive_lease: Arc<WorkspaceRuntimeLease>,
    ) -> Result<ProviderLiveEffectAuthorization, ProviderEffectAuthorizationError> {
        validate_request(&request)?;
        if !exclusive_lease.protects_database(&self.database_path) {
            return Err(ProviderEffectAuthorizationError::WorkspaceLeaseMismatch);
        }
        let clock = WorkspaceEventJournal::open(&self.database_path)?;
        let before = clock.current_global_sequence()?;
        let journal = EventJournal::open(&self.database_path)?;
        let run_id = request.run_id.to_string();
        let attempt_id = request.attempt_id.to_string();
        let execution_guard =
            ProviderAttemptExecutionGuard::acquire(&journal, &run_id, &attempt_id)?;

        let run = RunAggregate::recover(&journal, &run_id)?;
        if run.state() != RunState::Running {
            return Err(ProviderEffectAuthorizationError::RunStateInvalid(
                run.state(),
            ));
        }
        let pinned = run.pinned_identity();
        if pinned.workspace_id != self.workspace_id || pinned.project_id != self.project_id {
            return Err(ProviderEffectAuthorizationError::WorkspaceBindingMismatch);
        }
        let before_run_sequence = current_run_stream_sequence(&journal, &run_id)?;

        let (snapshot, loop_record) = {
            let mut replay_journal = EventJournal::open(&self.database_path)?;
            let repository = AgentLoopJournalRepository::new(&mut replay_journal);
            let snapshot = repository
                .recover_provider_authorization_snapshot(&run_id, &request.invocation_id)?;
            let record = repository.recover(&run_id, &request.invocation_id)?;
            (snapshot, record)
        };
        if snapshot.run_id() != request.run_id || snapshot.invocation_id() != request.invocation_id
        {
            return Err(ProviderEffectAuthorizationError::AgentLoopIdentityMismatch);
        }
        validate_loop_authority(&request, &snapshot, &loop_record, pinned, &self.project_id)?;

        let attempt = ProviderAttemptAggregate::recover(&journal, &run_id, &attempt_id)?;
        if attempt.state() != ProviderAttemptState::Requested {
            return Err(ProviderEffectAuthorizationError::AttemptNotRequested(
                attempt.state(),
            ));
        }
        let pending = snapshot.pending_inference();
        validate_pending_and_attempt(&request, pending, &attempt, &pinned.provider)?;

        let persisted = recover_compiled_record(
            &journal,
            &run_id,
            attempt.definition().context_compilation_id,
        )?;
        validate_context_source(
            &persisted,
            &request.invocation_id,
            attempt.definition().request_number,
            pinned,
        )?;
        let initial_context = recover_compiled_record(
            &journal,
            &run_id,
            loop_record
                .service
                .identity()
                .initial_context_compilation_id,
        )?;
        validate_context_source(&initial_context, &request.invocation_id, 1, pinned)?;
        if normalized_provider_input_sha256(&persisted.normalized_input)?
            != persisted.normalized_input_sha256
        {
            return Err(ProviderEffectAuthorizationError::NormalizedInputHashMismatch);
        }
        let provider = providers.resolve_owned(&pinned.provider)?;
        let prepared = gateway.prepare_inference(
            &provider,
            ProviderInferenceRequest {
                compilation: persisted.receipt.clone(),
                messages: persisted.normalized_input.messages.clone(),
                tools: persisted.normalized_input.tools.clone(),
            },
        )?;
        validate_context_and_transport(&attempt, &persisted.receipt, &prepared, &provider)?;

        let execution = ProviderInferenceExecution {
            run_id: run_id.clone(),
            attempt_id: attempt_id.clone(),
            inference_id: attempt.definition().inference_id.clone(),
            invocation_id: request.invocation_id.clone(),
            inference_idempotency_key: pending.inference_idempotency_key.clone(),
            attempt_number: attempt.definition().attempt_number,
            provider: pinned.provider.clone(),
            request: ProviderInferenceRequest {
                compilation: persisted.receipt,
                messages: Vec::new(),
                tools: Vec::new(),
            },
        };

        let now = OffsetDateTime::now_utc();
        let (authority, retry_schedule, issued_at, inference_deadline_at, attempt_deadline_at) =
            match (
                attempt.definition().request_number,
                attempt.definition().attempt_number,
            ) {
                (1, 1) => {
                    require_origin(&snapshot, PendingInferenceOrigin::Created)?;
                    if snapshot.last_retry_binding().is_some() {
                        return Err(ProviderEffectAuthorizationError::RetryBindingUnexpected);
                    }
                    let deadline = initial_deadline(&attempt)?;
                    require_before_deadline(now, &deadline)?;
                    (
                        ProviderEffectAuthorityBinding::InitialAgentLoop(
                            InitialAgentLoopAuthorityBinding {
                                requested_message_id: attempt.requested_message_id().to_owned(),
                                requested_idempotency_key_sha256: attempt
                                    .requested_idempotency_key_sha256(),
                                requested_at: attempt.requested_at().to_owned(),
                                agent_loop_aggregate_sequence: snapshot.aggregate_sequence(),
                                agent_loop_checkpoint_sha256: snapshot
                                    .checkpoint_sha256()
                                    .to_owned(),
                                pending_inference_sha256: snapshot
                                    .pending_inference_sha256()
                                    .to_owned(),
                            },
                        ),
                        None,
                        attempt.requested_at().to_owned(),
                        deadline.clone(),
                        deadline,
                    )
                }
                (request_number, 1) if request_number > 1 => {
                    require_origin(&snapshot, PendingInferenceOrigin::InferenceStarted)?;
                    if snapshot.last_retry_binding().is_some() {
                        return Err(ProviderEffectAuthorizationError::RetryBindingUnexpected);
                    }
                    let deadline = initial_deadline(&attempt)?;
                    require_before_deadline(now, &deadline)?;
                    let started_at = snapshot.pending_inference_persisted_at().to_owned();
                    (
                        ProviderEffectAuthorityBinding::AgentLoopContinuation(
                            AgentLoopContinuationAuthorityBinding {
                                agent_loop_aggregate_sequence: snapshot.aggregate_sequence(),
                                agent_loop_checkpoint_sha256: snapshot
                                    .checkpoint_sha256()
                                    .to_owned(),
                                pending_inference_sha256: snapshot
                                    .pending_inference_sha256()
                                    .to_owned(),
                                inference_started_at: started_at.clone(),
                            },
                        ),
                        None,
                        started_at,
                        deadline.clone(),
                        deadline,
                    )
                }
                (_, attempt_number) if attempt_number > 1 => {
                    require_origin(&snapshot, PendingInferenceOrigin::InferenceRetried)?;
                    retry_authority(&journal, &snapshot, &attempt, pending, now)?
                }
                _ => return Err(ProviderEffectAuthorizationError::AttemptIdentityMismatch),
            };

        let material = ProviderEffectGrantMaterial {
            schema_version: ProviderEffectGrantMaterial::schema_version(),
            workspace_id: self.workspace_id.clone(),
            project_id: self.project_id.clone(),
            database_canonical_path_sha256: canonical_database_path_sha256(&self.database_path)?,
            lease_epoch: exclusive_lease.lease_epoch().to_owned(),
            run_id: request.run_id,
            invocation_id: request.invocation_id,
            inference_id: Uuid::parse_str(&attempt.definition().inference_id)
                .map_err(|_| ProviderEffectAuthorizationError::AttemptIdentityMismatch)?,
            attempt_id: request.attempt_id,
            request_number: attempt.definition().request_number,
            attempt_number: attempt.definition().attempt_number,
            attempt_aggregate_sequence: attempt.aggregate_sequence(),
            attempt_definition_sha256: provider_attempt_definition_sha256(&attempt)?,
            attempt_evidence_sha256: provider_attempt_evidence_sha256(&attempt)?,
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
        let expected_run_sequence = current_run_stream_sequence(&journal, &run_id)?;
        if expected_run_sequence != before_run_sequence {
            return Err(ProviderEffectAuthorizationError::RunEvidenceChanged {
                before: before_run_sequence,
                after: expected_run_sequence,
            });
        }
        let after = clock.current_global_sequence()?;
        if after != before {
            return Err(ProviderEffectAuthorizationError::EvidenceChanged { before, after });
        }
        let receipt = ProviderEffectGrantReceipt::derive(material.clone())?;
        let capability = ProviderEffectCapability::activate(
            receipt,
            &material,
            &self.database_path,
            Arc::clone(&exclusive_lease),
        )?;
        Ok(ProviderLiveEffectAuthorization {
            execution,
            attempt,
            prepared,
            provider,
            execution_guard,
            capability,
            expected_run_sequence,
            expected_global_sequence: before,
        })
    }
}

fn validate_loop_authority(
    request: &ProviderLiveEffectAuthorizationRequest,
    snapshot: &AgentLoopProviderAuthorizationSnapshot,
    record: &AgentLoopRecord,
    pinned: &novelx_protocol::RunPinnedIdentity,
    project_id: &str,
) -> Result<(), ProviderEffectAuthorizationError> {
    let identity = record.service.identity();
    if record.aggregate_sequence != snapshot.aggregate_sequence()
        || record.service.pending_inference() != Some(snapshot.pending_inference())
        || identity.run_id != request.run_id
        || identity.project_id != project_id
        || identity.project_id != pinned.project_id
        || identity.invocation_id != request.invocation_id
        || identity.source_scope.source_checkpoint_id != pinned.source_checkpoint_id
        || identity.source_scope.resource_ids != pinned.scope_resource_ids
        || identity.source_scope.scope_sha256 != pinned.resource_scope_sha256
        || identity.permission.mode != pinned.mode
        || identity.permission.policy_id != pinned.tool_policy.id
        || identity.permission.policy_version != pinned.tool_policy.version
        || identity.permission.policy_sha256 != pinned.tool_policy.sha256
    {
        return Err(ProviderEffectAuthorizationError::AgentLoopAuthorityMismatch);
    }
    Ok(())
}

fn validate_context_source(
    persisted: &ContextCompiledRecord,
    invocation_id: &str,
    request_number: u64,
    pinned: &novelx_protocol::RunPinnedIdentity,
) -> Result<(), ProviderEffectAuthorizationError> {
    let source = persisted
        .source_command
        .as_ref()
        .ok_or(ProviderEffectAuthorizationError::ContextSourceCommandMissing)?;
    if !persisted.receipt.accepted
        || persisted.receipt.request_number != request_number
        || source.invocation_id != invocation_id
        || source.request_number != request_number
        || source.request_number != persisted.receipt.request_number
        || source.provider != pinned.provider
        || source.context_policy != pinned.context_policy
    {
        return Err(ProviderEffectAuthorizationError::ContextSourceCommandMismatch);
    }
    Ok(())
}

fn require_origin(
    snapshot: &AgentLoopProviderAuthorizationSnapshot,
    expected: PendingInferenceOrigin,
) -> Result<(), ProviderEffectAuthorizationError> {
    if snapshot.pending_inference_origin() == expected {
        Ok(())
    } else {
        Err(
            ProviderEffectAuthorizationError::PendingInferenceOriginMismatch {
                expected,
                actual: snapshot.pending_inference_origin(),
            },
        )
    }
}

fn validate_request(
    request: &ProviderLiveEffectAuthorizationRequest,
) -> Result<(), ProviderEffectAuthorizationError> {
    if request.invocation_id.trim().is_empty() {
        Err(ProviderEffectAuthorizationError::IdentityInvalid)
    } else {
        Ok(())
    }
}

fn validate_pending_and_attempt(
    request: &ProviderLiveEffectAuthorizationRequest,
    pending: &InferenceDispatchIdentity,
    attempt: &ProviderAttemptAggregate,
    pinned_provider: &novelx_protocol::ProviderRunIdentity,
) -> Result<(), ProviderEffectAuthorizationError> {
    let definition = attempt.definition();
    if pending.attempt_id != request.attempt_id
        || pending.inference_id.to_string() != definition.inference_id
        || pending.request_number != definition.request_number
        || pending.context_compilation_id != definition.context_compilation_id
        || pending.attempt_number != definition.attempt_number
        || definition.run_id != request.run_id.to_string()
        || definition.invocation_id != request.invocation_id
        || definition.provider != *pinned_provider
        || sha256(pending.inference_idempotency_key.as_bytes())
            != attempt.requested_idempotency_key_sha256()
    {
        return Err(ProviderEffectAuthorizationError::AttemptIdentityMismatch);
    }
    Ok(())
}

fn validate_context_and_transport(
    attempt: &ProviderAttemptAggregate,
    receipt: &novelx_protocol::ContextCompilationReceipt,
    prepared: &PreparedProviderInference,
    provider: &BoundProvider,
) -> Result<(), ProviderEffectAuthorizationError> {
    let definition = attempt.definition();
    if receipt.compilation_id != definition.context_compilation_id
        || receipt.request_number != definition.request_number
        || receipt.canonical_context_sha256 != definition.canonical_context_sha256
        || prepared.transport_payload_sha256() != definition.transport_payload_sha256
        || prepared.compilation() != receipt
        || provider.config_sha256() != definition.provider.config_sha256
        || provider.config().profile_id != definition.provider.profile_id
        || provider.config().provider_id != definition.provider.provider_id
        || provider.config().model_id != definition.provider.model_id
        || receipt.output_reserve_tokens != definition.output_reserve_tokens
        || provider.config().request_timeout_ms != definition.request_timeout_ms
        || provider.config().total_deadline_ms != definition.total_deadline_ms
        || provider.config().retry_policy.max_attempts != definition.max_attempts
        || provider.config().retry_policy.max_total_delay_ms != definition.max_total_delay_ms
    {
        return Err(ProviderEffectAuthorizationError::ContextOrPayloadMismatch);
    }
    Ok(())
}

fn initial_deadline(
    attempt: &ProviderAttemptAggregate,
) -> Result<String, ProviderEffectAuthorizationError> {
    let requested = parse_time(attempt.requested_at())?;
    let milliseconds = i64::try_from(attempt.definition().total_deadline_ms)
        .map_err(|_| ProviderEffectAuthorizationError::DeadlineInvalid)?;
    let deadline = requested
        .checked_add(Duration::milliseconds(milliseconds))
        .ok_or(ProviderEffectAuthorizationError::DeadlineInvalid)?;
    // Runtime V2 currently binds attempt and inference to the same absolute deadline. A later
    // evidence-version upgrade may shorten the attempt deadline without rewriting old receipts.
    format_time(deadline)
}

type RetryAuthority = (
    ProviderEffectAuthorityBinding,
    Option<ProviderEffectRetryScheduleBinding>,
    String,
    String,
    String,
);

fn retry_authority(
    journal: &EventJournal,
    snapshot: &crate::agent_loop_journal::AgentLoopProviderAuthorizationSnapshot,
    attempt: &ProviderAttemptAggregate,
    pending: &InferenceDispatchIdentity,
    now: OffsetDateTime,
) -> Result<RetryAuthority, ProviderEffectAuthorizationError> {
    let definition = attempt.definition();
    let retry =
        ProviderRetryAggregate::recover(journal, &definition.run_id, &definition.inference_id)?;
    if retry.state() != ProviderRetryState::AwaitingAttempt {
        return Err(ProviderEffectAuthorizationError::RetryNotAwaitingAttempt(
            retry.state(),
        ));
    }
    let schedule = retry
        .schedule()
        .ok_or(ProviderEffectAuthorizationError::RetryScheduleMissing)?;
    let awaiting_at = retry
        .awaiting_at()
        .ok_or(ProviderEffectAuthorizationError::RetryScheduleMissing)?;
    let binding = snapshot
        .last_retry_binding()
        .ok_or(ProviderEffectAuthorizationError::RetryBindingMissing)?;
    let binding_hash = snapshot
        .last_retry_binding_sha256()
        .ok_or(ProviderEffectAuthorizationError::RetryBindingMissing)?;
    let retry_definition = retry.definition();
    let failure_observation = retry
        .failure_observation()
        .ok_or(ProviderEffectAuthorizationError::RetryParentAttemptMissing)?;
    let parent_attempt = match ProviderAttemptAggregate::recover(
        journal,
        &definition.run_id,
        &failure_observation.attempt_id.to_string(),
    ) {
        Ok(parent) => parent,
        Err(ProviderAttemptError::InvalidHistory) => {
            return Err(ProviderEffectAuthorizationError::RetryParentAttemptMissing);
        }
        Err(error) => return Err(error.into()),
    };
    let parent_failure = parent_attempt
        .failure()
        .ok_or(ProviderEffectAuthorizationError::RetryParentAttemptMismatch)?;
    let parent_definition = parent_attempt.definition();
    let parent_definition_sha256 = provider_attempt_definition_sha256(&parent_attempt)?;
    let parent_evidence_sha256 = provider_attempt_evidence_sha256(&parent_attempt)?;
    let failure_observation_sha256 =
        provider_retry_failure_observation_sha256(failure_observation)?;
    if schedule.next_attempt_id != pending.attempt_id
        || schedule.next_attempt_number != pending.attempt_number
        || binding.next != *pending
        || binding.schedule_id != schedule.schedule_id.to_string()
        || binding.schedule_sha256 != schedule.schedule_sha256
        || binding.parent_attempt_evidence_sha256 != schedule.parent_failure_evidence_sha256
        || retry_definition.run_id != definition.run_id
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
    {
        return Err(ProviderEffectAuthorizationError::RetryScheduleMismatch);
    }
    if binding.previous_attempt_id != failure_observation.attempt_id
        || binding.previous_attempt_number != failure_observation.attempt_number
        || schedule.parent_failure_evidence_sha256 != failure_observation.evidence_sha256
        || schedule.parent_failure_observation_sha256 != failure_observation_sha256
        || parent_attempt.state() != ProviderAttemptState::Failed
        || !parent_failure.retryable
        || parent_attempt.attempt_id() != failure_observation.attempt_id.to_string()
        || parent_definition.attempt_number != failure_observation.attempt_number
        || parent_attempt.aggregate_sequence() != failure_observation.attempt_aggregate_sequence
        || parent_definition_sha256 != failure_observation.attempt_definition_sha256
        || parent_evidence_sha256 != failure_observation.evidence_sha256
        || parent_failure != &failure_observation.failure
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
        return Err(ProviderEffectAuthorizationError::RetryParentAttemptMismatch);
    }
    if now < parse_time(&schedule.not_before)? {
        return Err(ProviderEffectAuthorizationError::RetryNotBefore);
    }
    require_before_deadline(now, &schedule.attempt_deadline_at)?;
    Ok((
        ProviderEffectAuthorityBinding::AgentLoopRetry(AgentLoopRetryAuthorityBinding {
            agent_loop_aggregate_sequence: snapshot.aggregate_sequence(),
            agent_loop_checkpoint_sha256: snapshot.checkpoint_sha256().to_owned(),
            pending_inference_sha256: snapshot.pending_inference_sha256().to_owned(),
            retry_binding_sha256: binding_hash.to_owned(),
            retry_awaiting_at: awaiting_at.to_owned(),
            schedule_id: schedule.schedule_id,
            schedule_sha256: schedule.schedule_sha256.clone(),
        }),
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
        awaiting_at.to_owned(),
        retry_definition.deadline_at.clone(),
        schedule.attempt_deadline_at.clone(),
    ))
}

fn require_before_deadline(
    now: OffsetDateTime,
    deadline: &str,
) -> Result<(), ProviderEffectAuthorizationError> {
    if now < parse_time(deadline)? {
        Ok(())
    } else {
        Err(ProviderEffectAuthorizationError::DeadlineExpired)
    }
}

fn parse_time(value: &str) -> Result<OffsetDateTime, ProviderEffectAuthorizationError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| ProviderEffectAuthorizationError::DeadlineInvalid)
}

fn format_time(value: OffsetDateTime) -> Result<String, ProviderEffectAuthorizationError> {
    value
        .format(&Rfc3339)
        .map_err(|_| ProviderEffectAuthorizationError::DeadlineInvalid)
}

fn sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn current_run_stream_sequence(
    journal: &EventJournal,
    run_id: &str,
) -> Result<u64, ProviderEffectAuthorizationError> {
    journal
        .read_run(run_id, 0)?
        .last()
        .map(|event| event.run_sequence)
        .ok_or(ProviderEffectAuthorizationError::RunEvidenceMissing)
}

#[derive(Debug, Error)]
pub enum ProviderEffectAuthorizationError {
    #[error("Provider live effect authorization identity is invalid")]
    IdentityInvalid,
    #[error("Provider live effect authorization lease does not protect this database")]
    WorkspaceLeaseMismatch,
    #[error("Provider live effect authorization workspace/project binding does not match the Run")]
    WorkspaceBindingMismatch,
    #[error("Provider live effect authorization requires a Running Run, found {0:?}")]
    RunStateInvalid(RunState),
    #[error("Provider live effect Agent Loop identity does not match")]
    AgentLoopIdentityMismatch,
    #[error("Provider live effect Agent Loop authority differs from the pinned Run")]
    AgentLoopAuthorityMismatch,
    #[error(
        "Provider live effect pending inference origin differs: expected {expected:?}, found {actual:?}"
    )]
    PendingInferenceOriginMismatch {
        expected: PendingInferenceOrigin,
        actual: PendingInferenceOrigin,
    },
    #[error("Provider live effect requires a Requested attempt, found {0:?}")]
    AttemptNotRequested(ProviderAttemptState),
    #[error("Provider live effect attempt identity does not match durable Agent Loop evidence")]
    AttemptIdentityMismatch,
    #[error("Provider live effect normalized input hash does not match durable context")]
    NormalizedInputHashMismatch,
    #[error("Provider live effect context has no durable source command")]
    ContextSourceCommandMissing,
    #[error("Provider live effect context source command differs from the pinned Run")]
    ContextSourceCommandMismatch,
    #[error("Provider live effect context, payload, Provider, or Attempt definition differs")]
    ContextOrPayloadMismatch,
    #[error("Provider live effect retry binding is missing")]
    RetryBindingMissing,
    #[error("Provider live effect retry binding is unexpected for attempt one")]
    RetryBindingUnexpected,
    #[error("Provider live effect retry schedule is missing")]
    RetryScheduleMissing,
    #[error("Provider live effect retry is not AwaitingAttempt, found {0:?}")]
    RetryNotAwaitingAttempt(ProviderRetryState),
    #[error("Provider live effect retry schedule does not match the pending inference")]
    RetryScheduleMismatch,
    #[error("Provider live effect retry has no durable parent failure observation")]
    RetryParentAttemptMissing,
    #[error("Provider live effect retry parent Attempt does not match its failure observation")]
    RetryParentAttemptMismatch,
    #[error("Provider live effect retry not-before time has not arrived")]
    RetryNotBefore,
    #[error("Provider live effect absolute deadline is invalid")]
    DeadlineInvalid,
    #[error("Provider live effect absolute deadline has expired")]
    DeadlineExpired,
    #[error("Provider live effect evidence changed during authorization: {before} -> {after}")]
    EvidenceChanged { before: u64, after: u64 },
    #[error("Provider live effect Run stream is empty")]
    RunEvidenceMissing,
    #[error("Provider live effect Run evidence changed during authorization: {before} -> {after}")]
    RunEvidenceChanged { before: u64, after: u64 },
    #[error("Provider live effect execution is already in flight or invalid: {0}")]
    ExecutionGuard(#[from] crate::provider_inference_service::ProviderInferenceServiceError),
    #[error(transparent)]
    AgentLoop(#[from] AgentLoopJournalError),
    #[error(transparent)]
    Attempt(#[from] ProviderAttemptError),
    #[error(transparent)]
    Context(#[from] ContextCompileServiceError),
    #[error(transparent)]
    Retry(#[from] ProviderRetryError),
    #[error(transparent)]
    Provider(#[from] ProviderGatewayError),
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
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
