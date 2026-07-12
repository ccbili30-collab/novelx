use std::{path::Path, sync::Arc};

use novelx_protocol::ProviderRunIdentity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::workspace_runtime_lease::WorkspaceRuntimeLease;

const PROVIDER_EFFECT_SCHEMA_VERSION: u16 = 1;
const PROVIDER_EFFECT_DISPATCH_NAMESPACE: Uuid =
    Uuid::from_u128(0xc416_a83d_1740_5f3b_90c7_1aa7_138c_55d1);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitialAgentLoopAuthorityBinding {
    pub requested_message_id: String,
    pub requested_idempotency_key_sha256: String,
    pub requested_at: String,
    pub agent_loop_aggregate_sequence: u64,
    pub agent_loop_checkpoint_sha256: String,
    pub pending_inference_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLoopContinuationAuthorityBinding {
    pub agent_loop_aggregate_sequence: u64,
    pub agent_loop_checkpoint_sha256: String,
    pub pending_inference_sha256: String,
    pub inference_started_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLoopRetryAuthorityBinding {
    pub agent_loop_aggregate_sequence: u64,
    pub agent_loop_checkpoint_sha256: String,
    pub pending_inference_sha256: String,
    pub retry_binding_sha256: String,
    pub retry_awaiting_at: String,
    pub schedule_id: Uuid,
    pub schedule_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum OperationalRecoveryActorBinding {
    OriginalOwner {
        owner_lease_epoch: String,
        execution_started_at: String,
    },
    ResumeAuthorized {
        resumer_lease_epoch: String,
        authorization_id: String,
        authorization_sha256: String,
        authorization_generation: u64,
        authorized_at: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalRecoveryAuthorityBinding {
    pub operation_id: String,
    pub claim_id: String,
    pub execution_id: String,
    pub fencing_token: u64,
    pub action_spec_sha256: String,
    pub recovery_stream_sequence: u64,
    pub recovery_last_event_sha256: String,
    pub actor: OperationalRecoveryActorBinding,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ProviderEffectAuthorityBinding {
    InitialAgentLoop(InitialAgentLoopAuthorityBinding),
    AgentLoopContinuation(AgentLoopContinuationAuthorityBinding),
    AgentLoopRetry(AgentLoopRetryAuthorityBinding),
    OperationalRecovery(OperationalRecoveryAuthorityBinding),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderEffectRetryScheduleBinding {
    pub retry_definition_sha256: String,
    pub retry_aggregate_sequence: u64,
    pub schedule_id: Uuid,
    pub schedule_sha256: String,
    pub parent_failure_evidence_sha256: String,
    pub parent_failure_observation_sha256: String,
    pub next_attempt_id: Uuid,
    pub next_attempt_number: u16,
    pub not_before: String,
    pub attempt_deadline_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderEffectGrantMaterial {
    pub schema_version: u16,
    pub workspace_id: String,
    pub project_id: String,
    pub database_canonical_path_sha256: String,
    pub lease_epoch: String,
    pub run_id: Uuid,
    pub invocation_id: String,
    pub inference_id: Uuid,
    pub attempt_id: Uuid,
    pub request_number: u64,
    pub attempt_number: u16,
    pub attempt_aggregate_sequence: u64,
    pub attempt_definition_sha256: String,
    pub attempt_evidence_sha256: String,
    pub context_compilation_id: Uuid,
    pub canonical_context_sha256: String,
    pub transport_payload_sha256: String,
    pub provider: ProviderRunIdentity,
    pub inference_deadline_at: String,
    pub attempt_deadline_at: String,
    pub retry_schedule: Option<ProviderEffectRetryScheduleBinding>,
    pub authority: ProviderEffectAuthorityBinding,
    pub issued_at: String,
}

impl ProviderEffectGrantMaterial {
    pub const fn schema_version() -> u16 {
        PROVIDER_EFFECT_SCHEMA_VERSION
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderEffectGrantReceipt {
    material: ProviderEffectGrantMaterial,
    grant_sha256: String,
    dispatch_id: Uuid,
}

impl ProviderEffectGrantReceipt {
    pub const fn material(&self) -> &ProviderEffectGrantMaterial {
        &self.material
    }

    pub fn grant_sha256(&self) -> &str {
        &self.grant_sha256
    }

    pub const fn dispatch_id(&self) -> Uuid {
        self.dispatch_id
    }

    pub fn validate(&self) -> Result<(), ProviderEffectCapabilityError> {
        validate_material(&self.material)?;
        let expected_hash = grant_sha256(&self.material)?;
        if self.grant_sha256 != expected_hash
            || self.dispatch_id != dispatch_id_for_grant(&expected_hash)
        {
            return Err(ProviderEffectCapabilityError::ReceiptInvalid);
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn derive(
        material: ProviderEffectGrantMaterial,
    ) -> Result<Self, ProviderEffectCapabilityError> {
        validate_material(&material)?;
        let grant_sha256 = grant_sha256(&material)?;
        let dispatch_id = dispatch_id_for_grant(&grant_sha256);
        Ok(Self {
            material,
            grant_sha256,
            dispatch_id,
        })
    }
}

/// A process-local, one-shot authority to cross the Provider inference effect boundary.
///
/// This type intentionally implements neither `Clone`, `Copy`, `Serialize`, nor `Deserialize`.
/// Its receipt is durable evidence; this value itself is not durable and is not a statement about
/// Provider-side idempotency or result lookup.
#[allow(dead_code)]
pub struct ProviderEffectCapability {
    receipt: ProviderEffectGrantReceipt,
    live_lease: Arc<WorkspaceRuntimeLease>,
    _seal: private::Seal,
}

impl std::fmt::Debug for ProviderEffectCapability {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProviderEffectCapability")
            .field("grant_sha256", &self.receipt.grant_sha256)
            .field("dispatch_id", &self.receipt.dispatch_id)
            .finish_non_exhaustive()
    }
}

#[allow(dead_code)]
impl ProviderEffectCapability {
    pub(crate) fn activate(
        receipt: ProviderEffectGrantReceipt,
        expected_material: &ProviderEffectGrantMaterial,
        database_path: impl AsRef<Path>,
        live_lease: Arc<WorkspaceRuntimeLease>,
    ) -> Result<Self, ProviderEffectCapabilityError> {
        Self::activate_at(
            receipt,
            expected_material,
            database_path,
            live_lease,
            OffsetDateTime::now_utc(),
        )
    }

    pub(crate) fn activate_at(
        receipt: ProviderEffectGrantReceipt,
        expected_material: &ProviderEffectGrantMaterial,
        database_path: impl AsRef<Path>,
        live_lease: Arc<WorkspaceRuntimeLease>,
        now: OffsetDateTime,
    ) -> Result<Self, ProviderEffectCapabilityError> {
        validate_for_use(
            &receipt,
            expected_material,
            database_path.as_ref(),
            &live_lease,
            now,
        )?;
        Ok(Self {
            receipt,
            live_lease,
            _seal: private::Seal,
        })
    }

    pub(crate) fn receipt(&self) -> &ProviderEffectGrantReceipt {
        &self.receipt
    }

    pub(crate) fn consume(
        self,
        expected_material: &ProviderEffectGrantMaterial,
        database_path: impl AsRef<Path>,
    ) -> Result<ConsumedProviderEffect, ProviderEffectCapabilityError> {
        self.consume_at(expected_material, database_path, OffsetDateTime::now_utc())
    }

    pub(crate) fn consume_at(
        self,
        expected_material: &ProviderEffectGrantMaterial,
        database_path: impl AsRef<Path>,
        now: OffsetDateTime,
    ) -> Result<ConsumedProviderEffect, ProviderEffectCapabilityError> {
        validate_for_use(
            &self.receipt,
            expected_material,
            database_path.as_ref(),
            &self.live_lease,
            now,
        )?;
        Ok(ConsumedProviderEffect {
            receipt: self.receipt,
            live_lease: self.live_lease,
            _seal: private::Seal,
        })
    }
}

/// A validated one-shot effect that has not yet crossed the durable `provider.sent` boundary.
///
/// This value is move-only and deliberately retains the live workspace lease.
#[allow(dead_code)]
pub struct ConsumedProviderEffect {
    receipt: ProviderEffectGrantReceipt,
    live_lease: Arc<WorkspaceRuntimeLease>,
    _seal: private::Seal,
}

impl std::fmt::Debug for ConsumedProviderEffect {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        effect_debug("ConsumedProviderEffect", &self.receipt, formatter)
    }
}

#[allow(dead_code)]
impl ConsumedProviderEffect {
    pub(crate) fn receipt(&self) -> &ProviderEffectGrantReceipt {
        &self.receipt
    }

    pub(crate) fn arm(
        self,
        persisted_receipt: ProviderEffectGrantReceipt,
    ) -> Result<ArmedProviderEffect, ProviderEffectCapabilityError> {
        persisted_receipt.validate()?;
        if persisted_receipt != self.receipt {
            return Err(ProviderEffectCapabilityError::PersistedReceiptMismatch);
        }
        Ok(ArmedProviderEffect {
            receipt: persisted_receipt,
            live_lease: self.live_lease,
            _seal: private::Seal,
        })
    }
}

/// A move-only Provider effect whose exact receipt has crossed the durable send boundary.
#[allow(dead_code)]
pub struct ArmedProviderEffect {
    receipt: ProviderEffectGrantReceipt,
    live_lease: Arc<WorkspaceRuntimeLease>,
    _seal: private::Seal,
}

impl std::fmt::Debug for ArmedProviderEffect {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        effect_debug("ArmedProviderEffect", &self.receipt, formatter)
    }
}

#[allow(dead_code)]
impl ArmedProviderEffect {
    pub(crate) fn receipt(&self) -> &ProviderEffectGrantReceipt {
        &self.receipt
    }

    pub(crate) fn into_dispatched(self) -> DispatchedProviderEffect {
        DispatchedProviderEffect {
            receipt: self.receipt,
            live_lease: self.live_lease,
            _seal: private::Seal,
        }
    }
}

/// A move-only lifecycle guard that keeps the workspace lease alive until terminal persistence.
#[allow(dead_code)]
pub struct DispatchedProviderEffect {
    receipt: ProviderEffectGrantReceipt,
    live_lease: Arc<WorkspaceRuntimeLease>,
    _seal: private::Seal,
}

impl std::fmt::Debug for DispatchedProviderEffect {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        effect_debug("DispatchedProviderEffect", &self.receipt, formatter)
    }
}

#[allow(dead_code)]
impl DispatchedProviderEffect {
    pub(crate) fn receipt(&self) -> &ProviderEffectGrantReceipt {
        &self.receipt
    }
}

fn effect_debug(
    name: &str,
    receipt: &ProviderEffectGrantReceipt,
    formatter: &mut std::fmt::Formatter<'_>,
) -> std::fmt::Result {
    formatter
        .debug_struct(name)
        .field("grant_sha256", &receipt.grant_sha256)
        .field("dispatch_id", &receipt.dispatch_id)
        .finish_non_exhaustive()
}

pub fn canonical_database_path_sha256(
    database_path: impl AsRef<Path>,
) -> Result<String, ProviderEffectCapabilityError> {
    let canonical = std::fs::canonicalize(database_path)?;
    Ok(sha256(canonical.to_string_lossy().as_bytes()))
}

#[allow(dead_code)]
fn validate_for_use(
    receipt: &ProviderEffectGrantReceipt,
    expected_material: &ProviderEffectGrantMaterial,
    database_path: &Path,
    live_lease: &WorkspaceRuntimeLease,
    now: OffsetDateTime,
) -> Result<(), ProviderEffectCapabilityError> {
    receipt.validate()?;
    validate_material(expected_material)?;
    if receipt.material != *expected_material {
        return Err(ProviderEffectCapabilityError::MaterialMismatch);
    }
    if !live_lease.protects_database(database_path) {
        return Err(ProviderEffectCapabilityError::WorkspaceLeaseMismatch);
    }
    if live_lease.lease_epoch() != receipt.material.lease_epoch {
        return Err(ProviderEffectCapabilityError::LeaseEpochMismatch);
    }
    if canonical_database_path_sha256(database_path)?
        != receipt.material.database_canonical_path_sha256
    {
        return Err(ProviderEffectCapabilityError::DatabasePathMismatch);
    }
    validate_time_window(&receipt.material, now)
}

fn validate_material(
    material: &ProviderEffectGrantMaterial,
) -> Result<(), ProviderEffectCapabilityError> {
    if material.schema_version != PROVIDER_EFFECT_SCHEMA_VERSION {
        return Err(ProviderEffectCapabilityError::SchemaVersionUnsupported);
    }
    require_text(&material.workspace_id)?;
    require_text(&material.project_id)?;
    require_sha256(&material.database_canonical_path_sha256)?;
    require_text(&material.lease_epoch)?;
    require_text(&material.invocation_id)?;
    if material.request_number == 0
        || material.attempt_number == 0
        || material.attempt_aggregate_sequence == 0
    {
        return Err(ProviderEffectCapabilityError::AttemptIdentityInvalid);
    }
    require_sha256(&material.attempt_definition_sha256)?;
    require_sha256(&material.attempt_evidence_sha256)?;
    require_sha256(&material.canonical_context_sha256)?;
    require_sha256(&material.transport_payload_sha256)?;
    validate_provider(&material.provider)?;
    let issued = parse_time(&material.issued_at)?;
    let attempt_deadline = parse_time(&material.attempt_deadline_at)?;
    let inference_deadline = parse_time(&material.inference_deadline_at)?;
    if issued >= attempt_deadline || attempt_deadline > inference_deadline {
        return Err(ProviderEffectCapabilityError::DeadlineInvalid);
    }

    match material.attempt_number {
        1 if material.retry_schedule.is_some() => {
            return Err(ProviderEffectCapabilityError::UnexpectedRetrySchedule);
        }
        1 => {}
        _ if material.retry_schedule.is_none() => {
            return Err(ProviderEffectCapabilityError::RetryScheduleRequired);
        }
        _ => {}
    }
    if let Some(schedule) = &material.retry_schedule {
        validate_retry_schedule(schedule, material)?;
    }
    validate_authority(&material.authority, material)
}

#[allow(dead_code)]
fn validate_time_window(
    material: &ProviderEffectGrantMaterial,
    now: OffsetDateTime,
) -> Result<(), ProviderEffectCapabilityError> {
    let issued = parse_time(&material.issued_at)?;
    let attempt_deadline = parse_time(&material.attempt_deadline_at)?;
    let inference_deadline = parse_time(&material.inference_deadline_at)?;
    if issued > now {
        return Err(ProviderEffectCapabilityError::IssuedInFuture);
    }
    if now >= attempt_deadline || now >= inference_deadline {
        return Err(ProviderEffectCapabilityError::Expired);
    }
    Ok(())
}

fn validate_retry_schedule(
    schedule: &ProviderEffectRetryScheduleBinding,
    material: &ProviderEffectGrantMaterial,
) -> Result<(), ProviderEffectCapabilityError> {
    require_sha256(&schedule.retry_definition_sha256)?;
    require_sha256(&schedule.schedule_sha256)?;
    require_sha256(&schedule.parent_failure_evidence_sha256)?;
    require_sha256(&schedule.parent_failure_observation_sha256)?;
    if schedule.retry_aggregate_sequence == 0
        || schedule.next_attempt_id != material.attempt_id
        || schedule.next_attempt_number != material.attempt_number
        || parse_time(&schedule.not_before)? > parse_time(&schedule.attempt_deadline_at)?
        || schedule.attempt_deadline_at != material.attempt_deadline_at
    {
        return Err(ProviderEffectCapabilityError::RetryScheduleMismatch);
    }
    Ok(())
}

fn validate_authority(
    authority: &ProviderEffectAuthorityBinding,
    material: &ProviderEffectGrantMaterial,
) -> Result<(), ProviderEffectCapabilityError> {
    match authority {
        ProviderEffectAuthorityBinding::InitialAgentLoop(binding) => {
            if material.request_number != 1
                || material.attempt_number != 1
                || binding.agent_loop_aggregate_sequence == 0
            {
                return Err(ProviderEffectCapabilityError::AuthorityMismatch);
            }
            require_text(&binding.requested_message_id)?;
            require_sha256(&binding.requested_idempotency_key_sha256)?;
            parse_time(&binding.requested_at)?;
            require_sha256(&binding.agent_loop_checkpoint_sha256)?;
            require_sha256(&binding.pending_inference_sha256)?;
            require_authority_time(&material.issued_at, &binding.requested_at)
        }
        ProviderEffectAuthorityBinding::AgentLoopContinuation(binding) => {
            if material.request_number <= 1
                || material.attempt_number != 1
                || binding.agent_loop_aggregate_sequence == 0
            {
                return Err(ProviderEffectCapabilityError::AuthorityMismatch);
            }
            require_sha256(&binding.agent_loop_checkpoint_sha256)?;
            require_sha256(&binding.pending_inference_sha256)?;
            parse_time(&binding.inference_started_at)?;
            require_authority_time(&material.issued_at, &binding.inference_started_at)
        }
        ProviderEffectAuthorityBinding::AgentLoopRetry(binding) => {
            let schedule = material
                .retry_schedule
                .as_ref()
                .ok_or(ProviderEffectCapabilityError::RetryScheduleRequired)?;
            if material.attempt_number <= 1
                || binding.agent_loop_aggregate_sequence == 0
                || binding.schedule_id != schedule.schedule_id
                || binding.schedule_sha256 != schedule.schedule_sha256
            {
                return Err(ProviderEffectCapabilityError::AuthorityMismatch);
            }
            require_sha256(&binding.agent_loop_checkpoint_sha256)?;
            require_sha256(&binding.pending_inference_sha256)?;
            require_sha256(&binding.retry_binding_sha256)?;
            parse_time(&binding.retry_awaiting_at)?;
            require_authority_time(&material.issued_at, &binding.retry_awaiting_at)
        }
        ProviderEffectAuthorityBinding::OperationalRecovery(binding) => {
            require_sha256(&binding.operation_id)?;
            require_sha256(&binding.claim_id)?;
            require_sha256(&binding.execution_id)?;
            require_sha256(&binding.action_spec_sha256)?;
            require_sha256(&binding.recovery_last_event_sha256)?;
            if binding.fencing_token == 0 || binding.recovery_stream_sequence == 0 {
                return Err(ProviderEffectCapabilityError::RecoveryEvidenceInvalid);
            }
            match &binding.actor {
                OperationalRecoveryActorBinding::OriginalOwner {
                    owner_lease_epoch,
                    execution_started_at,
                } => {
                    require_text(owner_lease_epoch)?;
                    parse_time(execution_started_at)?;
                    if owner_lease_epoch != &material.lease_epoch {
                        return Err(ProviderEffectCapabilityError::RecoveryEvidenceInvalid);
                    }
                    require_authority_time(&material.issued_at, execution_started_at)?;
                }
                OperationalRecoveryActorBinding::ResumeAuthorized {
                    resumer_lease_epoch,
                    authorization_id,
                    authorization_sha256,
                    authorization_generation,
                    authorized_at,
                } => {
                    require_text(resumer_lease_epoch)?;
                    require_sha256(authorization_id)?;
                    require_sha256(authorization_sha256)?;
                    parse_time(authorized_at)?;
                    if resumer_lease_epoch != &material.lease_epoch
                        || *authorization_generation == 0
                    {
                        return Err(ProviderEffectCapabilityError::RecoveryEvidenceInvalid);
                    }
                    require_authority_time(&material.issued_at, authorized_at)?;
                }
            }
            Ok(())
        }
    }
}

fn require_authority_time(
    issued_at: &str,
    authority_time: &str,
) -> Result<(), ProviderEffectCapabilityError> {
    if issued_at == authority_time {
        Ok(())
    } else {
        Err(ProviderEffectCapabilityError::AuthorityTimeMismatch)
    }
}

fn validate_provider(provider: &ProviderRunIdentity) -> Result<(), ProviderEffectCapabilityError> {
    require_text(&provider.profile_id)?;
    require_text(&provider.provider_id)?;
    require_text(&provider.model_id)?;
    require_sha256(&provider.config_sha256)
}

fn grant_sha256(
    material: &ProviderEffectGrantMaterial,
) -> Result<String, ProviderEffectCapabilityError> {
    let value = serde_json::to_value(material)?;
    Ok(sha256(&serde_json::to_vec(&canonicalize(value))?))
}

fn dispatch_id_for_grant(grant_sha256: &str) -> Uuid {
    Uuid::new_v5(&PROVIDER_EFFECT_DISPATCH_NAMESPACE, grant_sha256.as_bytes())
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

fn parse_time(value: &str) -> Result<OffsetDateTime, ProviderEffectCapabilityError> {
    OffsetDateTime::parse(value, &Rfc3339).map_err(|_| ProviderEffectCapabilityError::TimeInvalid)
}

fn require_text(value: &str) -> Result<(), ProviderEffectCapabilityError> {
    if value.trim().is_empty() {
        Err(ProviderEffectCapabilityError::TextRequired)
    } else {
        Ok(())
    }
}

fn require_sha256(value: &str) -> Result<(), ProviderEffectCapabilityError> {
    if is_sha256(value) {
        Ok(())
    } else {
        Err(ProviderEffectCapabilityError::Sha256Invalid)
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Error)]
pub enum ProviderEffectCapabilityError {
    #[error("Provider effect capability schema version is unsupported")]
    SchemaVersionUnsupported,
    #[error("Provider effect capability text evidence is required")]
    TextRequired,
    #[error("Provider effect capability SHA-256 evidence is invalid")]
    Sha256Invalid,
    #[error("Provider effect capability attempt identity is invalid")]
    AttemptIdentityInvalid,
    #[error("Provider effect capability deadline ordering is invalid")]
    DeadlineInvalid,
    #[error("Provider effect capability was issued in the future")]
    IssuedInFuture,
    #[error("Provider effect capability has expired")]
    Expired,
    #[error("Provider effect capability cannot attach a retry schedule to attempt one")]
    UnexpectedRetrySchedule,
    #[error("Provider effect capability requires an exact retry schedule")]
    RetryScheduleRequired,
    #[error("Provider effect capability retry schedule does not match the attempt")]
    RetryScheduleMismatch,
    #[error("Provider effect capability authority does not match the attempt")]
    AuthorityMismatch,
    #[error("Provider effect capability issuedAt does not match its persisted authority time")]
    AuthorityTimeMismatch,
    #[error("Provider effect capability recovery evidence is invalid")]
    RecoveryEvidenceInvalid,
    #[error("Provider effect grant receipt is invalid")]
    ReceiptInvalid,
    #[error("Persisted Provider effect receipt does not match the consumed capability")]
    PersistedReceiptMismatch,
    #[error("Provider effect capability material does not match the dispatch")]
    MaterialMismatch,
    #[error("Provider effect capability workspace lease does not protect this database")]
    WorkspaceLeaseMismatch,
    #[error("Provider effect capability lease epoch does not match the live owner")]
    LeaseEpochMismatch,
    #[error("Provider effect capability database canonical path does not match")]
    DatabasePathMismatch,
    #[error("Provider effect capability time evidence is invalid")]
    TimeInvalid,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

mod private {
    pub struct Seal;
}
