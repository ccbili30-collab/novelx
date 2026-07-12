use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::operational_recovery_action::OperationalRecoveryAction;
use crate::provider_attempt::ProviderAttemptState;
use crate::workspace_event_journal::{
    NewWorkspaceEvent, WorkspaceEvent, WorkspaceEventJournal, WorkspaceEventJournalError,
};
use crate::workspace_runtime_lease::WorkspaceRuntimeLease;

const STREAM_TYPE: &str = "operational_recovery";
const EVENT_TYPE: &str = "operational_recovery.event";
const EVENT_VERSION: u32 = 1;
const GENESIS_HASH: &str = "GENESIS";
pub const OPERATIONAL_RECOVERY_POLICY_VERSION: &str = "operational-recovery-v1";
pub const MAX_RECOVERY_CLAIM_LEASE_SECONDS: u64 = 300;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalRecoverySubject {
    pub workspace_id: String,
    pub project_id: String,
    pub run_id: String,
    pub policy_version: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationalRecoveryObservedGate {
    AwaitingProviderBinding,
    WaitingForApproval,
    WaitingForReconciliation,
    WaitingForExplicitExecution,
    ProviderDispatchReady,
    RecoveryReady,
    Quarantined,
    TerminalProjectionOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationalRecoveryWaitingReason {
    ProviderBinding,
    HostApproval,
    Reconciliation,
    ExplicitExecution,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalRecoveryObservation {
    pub operation_id: String,
    pub action: String,
    pub source_fingerprint: String,
    pub gate: OperationalRecoveryObservedGate,
    pub reasons: Vec<String>,
}

impl OperationalRecoveryObservation {
    pub fn derive(
        subject: &OperationalRecoverySubject,
        source_fingerprint: String,
        gate: OperationalRecoveryObservedGate,
        mut reasons: Vec<String>,
    ) -> Result<Self, OperationalRecoveryAggregateError> {
        validate_subject(subject)?;
        require_sha256("source_fingerprint", &source_fingerprint)?;
        reasons.sort();
        reasons.dedup();
        for reason in &reasons {
            require_text("reason", reason)?;
        }
        let action = "resume_run".to_owned();
        let operation_id = canonical_sha256(&serde_json::json!({
            "workspaceId": subject.workspace_id,
            "projectId": subject.project_id,
            "runId": subject.run_id,
            "action": action,
            "sourceFingerprint": source_fingerprint,
            "policyVersion": subject.policy_version,
        }))?;
        Ok(Self {
            operation_id,
            action,
            source_fingerprint,
            gate,
            reasons,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OperationalRecoveryDisposition {
    Waiting {
        reason: OperationalRecoveryWaitingReason,
        evidence_fingerprint: String,
    },
    Quarantined {
        invariant_codes: Vec<String>,
        evidence_fingerprint: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryOperation {
    pub observation: OperationalRecoveryObservation,
    pub disposition: Option<OperationalRecoveryDisposition>,
    pub claim: Option<OperationalRecoveryClaim>,
    pub execution: Option<OperationalRecoveryExecution>,
    pub resumes: Vec<OperationalRecoveryResume>,
    pub provider_dispatch_resumes: Vec<ProviderDispatchResumeAuthorization>,
    pub outcome: Option<OperationalRecoveryOutcome>,
    pub stale: Option<OperationalRecoveryStale>,
}

impl OperationalRecoveryOperation {
    pub fn latest_provider_dispatch_resume(&self) -> Option<&ProviderDispatchResumeAuthorization> {
        self.provider_dispatch_resumes.last()
    }

    pub fn is_current_provider_dispatch_resume(&self, authorization_id: &str) -> bool {
        self.latest_provider_dispatch_resume()
            .is_some_and(|authorization| authorization.authorization_id == authorization_id)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalRecoveryResume {
    pub resume_id: String,
    pub execution_id: String,
    pub original_owner_instance_id: String,
    pub resumer_instance_id: String,
    pub fencing_token: u64,
    pub resumed_at: String,
}

impl OperationalRecoveryResume {
    pub fn derive(
        execution: &OperationalRecoveryExecution,
        resumer_instance_id: String,
        resumed_at: String,
    ) -> Result<Self, OperationalRecoveryAggregateError> {
        validate_execution(execution)?;
        require_text("resumer_instance_id", &resumer_instance_id)?;
        parse_time("resumed_at", &resumed_at)?;
        let resume_id = canonical_sha256(&serde_json::json!({
            "executionId": execution.execution_id,
            "resumerInstanceId": resumer_instance_id,
        }))?;
        Ok(Self {
            resume_id,
            execution_id: execution.execution_id.clone(),
            original_owner_instance_id: execution.owner_instance_id.clone(),
            resumer_instance_id,
            fencing_token: execution.fencing_token,
            resumed_at,
        })
    }
}

pub const PROVIDER_DISPATCH_RESUME_POLICY_VERSION: &str = "provider-dispatch-resume-v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderDispatchResumeCapability {
    DispatchRequested,
    FinalizeOutcomeUnknown,
    FinalizeResponded,
    FinalizeFailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderDispatchResumeAuthorization {
    pub authorization_id: String,
    pub operation_id: String,
    pub execution_id: String,
    pub claim_id: String,
    pub original_owner_instance_id: String,
    pub resumer_instance_id: String,
    pub fencing_token: u64,
    pub action_spec_sha256: String,
    pub attempt_id: String,
    pub attempt_state: ProviderAttemptState,
    pub attempt_aggregate_sequence: u64,
    pub attempt_definition_sha256: String,
    pub attempt_evidence_sha256: String,
    pub capability: ProviderDispatchResumeCapability,
    pub previous_authorization_id: Option<String>,
    pub authorization_generation: u64,
    pub authorized_at: String,
}

impl ProviderDispatchResumeAuthorization {
    #[allow(clippy::too_many_arguments)]
    pub fn derive(
        operation_id: String,
        execution: &OperationalRecoveryExecution,
        resumer_instance_id: String,
        action_spec_sha256: String,
        attempt_id: String,
        attempt_state: ProviderAttemptState,
        attempt_aggregate_sequence: u64,
        attempt_definition_sha256: String,
        attempt_evidence_sha256: String,
        previous: Option<&Self>,
        authorized_at: String,
    ) -> Result<Self, OperationalRecoveryAggregateError> {
        validate_execution(execution)?;
        require_sha256("operation_id", &operation_id)?;
        require_text("resumer_instance_id", &resumer_instance_id)?;
        if resumer_instance_id == execution.owner_instance_id {
            return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeNotAllowed);
        }
        if action_spec_sha256 != execution.action_spec_sha256 {
            return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeConflict);
        }
        require_text("attempt_id", &attempt_id)?;
        if attempt_aggregate_sequence == 0 {
            return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeConflict);
        }
        require_sha256("attempt_definition_sha256", &attempt_definition_sha256)?;
        require_sha256("attempt_evidence_sha256", &attempt_evidence_sha256)?;
        parse_time("authorized_at", &authorized_at)?;

        let capability = provider_dispatch_capability(attempt_state);
        let (previous_authorization_id, authorization_generation) = match previous {
            Some(previous) => {
                validate_provider_dispatch_resume(previous)?;
                if previous.operation_id != operation_id
                    || previous.execution_id != execution.execution_id
                    || previous.claim_id != execution.claim_id
                    || previous.original_owner_instance_id != execution.owner_instance_id
                    || previous.fencing_token != execution.fencing_token
                    || previous.action_spec_sha256 != action_spec_sha256
                {
                    return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeConflict);
                }
                (
                    Some(previous.authorization_id.clone()),
                    previous
                        .authorization_generation
                        .checked_add(1)
                        .ok_or(OperationalRecoveryAggregateError::RevisionOverflow)?,
                )
            }
            None => (None, 1),
        };
        let authorization_id = provider_dispatch_resume_id(
            &operation_id,
            execution,
            &resumer_instance_id,
            &action_spec_sha256,
            &attempt_id,
            attempt_state,
            attempt_aggregate_sequence,
            &attempt_definition_sha256,
            &attempt_evidence_sha256,
            capability,
            previous_authorization_id.as_deref(),
            authorization_generation,
        )?;
        Ok(Self {
            authorization_id,
            operation_id,
            execution_id: execution.execution_id.clone(),
            claim_id: execution.claim_id.clone(),
            original_owner_instance_id: execution.owner_instance_id.clone(),
            resumer_instance_id,
            fencing_token: execution.fencing_token,
            action_spec_sha256,
            attempt_id,
            attempt_state,
            attempt_aggregate_sequence,
            attempt_definition_sha256,
            attempt_evidence_sha256,
            capability,
            previous_authorization_id,
            authorization_generation,
            authorized_at,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalRecoveryStale {
    pub expected_operation_id: String,
    pub expected_source_fingerprint: String,
    pub actual_operation_id: String,
    pub actual_source_fingerprint: String,
    pub current_claim_id: Option<String>,
    pub current_fencing_token: Option<u64>,
    pub detector_instance_id: String,
    pub detected_at: String,
    pub scan_global_sequence: u64,
}

impl OperationalRecoveryStale {
    #[allow(clippy::too_many_arguments)]
    pub fn derive(
        expected_operation_id: String,
        expected_source_fingerprint: String,
        actual_operation_id: String,
        actual_source_fingerprint: String,
        current_claim_id: Option<String>,
        current_fencing_token: Option<u64>,
        detector_instance_id: String,
        detected_at: String,
        scan_global_sequence: u64,
    ) -> Result<Self, OperationalRecoveryAggregateError> {
        require_sha256("expected_operation_id", &expected_operation_id)?;
        require_sha256("expected_source_fingerprint", &expected_source_fingerprint)?;
        require_sha256("actual_operation_id", &actual_operation_id)?;
        require_sha256("actual_source_fingerprint", &actual_source_fingerprint)?;
        if expected_operation_id == actual_operation_id
            && expected_source_fingerprint == actual_source_fingerprint
        {
            return Err(OperationalRecoveryAggregateError::StaleEvidenceUnchanged);
        }
        match (&current_claim_id, current_fencing_token) {
            (Some(claim_id), Some(token)) if token > 0 => require_sha256("claim_id", claim_id)?,
            (None, None) => {}
            _ => return Err(OperationalRecoveryAggregateError::StaleClaimIdentityInvalid),
        }
        require_text("detector_instance_id", &detector_instance_id)?;
        parse_time("detected_at", &detected_at)?;
        Ok(Self {
            expected_operation_id,
            expected_source_fingerprint,
            actual_operation_id,
            actual_source_fingerprint,
            current_claim_id,
            current_fencing_token,
            detector_instance_id,
            detected_at,
            scan_global_sequence,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalRecoveryClaim {
    pub claim_id: String,
    pub operation_id: String,
    pub owner_instance_id: String,
    pub fencing_token: u64,
    pub source_fingerprint: String,
    pub claimed_at: String,
    pub lease_expires_at: String,
    pub executor_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_spec: Option<OperationalRecoveryAction>,
    pub action_spec_sha256: String,
}

impl OperationalRecoveryClaim {
    #[allow(clippy::too_many_arguments)]
    pub fn derive(
        operation_id: String,
        owner_instance_id: String,
        fencing_token: u64,
        source_fingerprint: String,
        claimed_at: String,
        lease_expires_at: String,
        executor_version: String,
        action_spec: Option<OperationalRecoveryAction>,
        action_spec_sha256: String,
    ) -> Result<Self, OperationalRecoveryAggregateError> {
        require_sha256("operation_id", &operation_id)?;
        require_text("owner_instance_id", &owner_instance_id)?;
        if fencing_token == 0 {
            return Err(OperationalRecoveryAggregateError::FencingTokenInvalid);
        }
        require_sha256("source_fingerprint", &source_fingerprint)?;
        require_text("claimed_at", &claimed_at)?;
        require_text("lease_expires_at", &lease_expires_at)?;
        let claimed = OffsetDateTime::parse(&claimed_at, &Rfc3339)?;
        let expires = OffsetDateTime::parse(&lease_expires_at, &Rfc3339)?;
        if expires <= claimed {
            return Err(OperationalRecoveryAggregateError::LeaseWindowInvalid);
        }
        require_text("executor_version", &executor_version)?;
        require_sha256("action_spec_sha256", &action_spec_sha256)?;
        if action_spec
            .as_ref()
            .map(OperationalRecoveryAction::action_spec_sha256)
            .transpose()?
            .is_some_and(|actual| actual != action_spec_sha256)
        {
            return Err(OperationalRecoveryAggregateError::ActionSpecHashMismatch);
        }
        let claim_id = canonical_sha256(&serde_json::json!({
            "operationId": operation_id,
            "ownerInstanceId": owner_instance_id,
            "fencingToken": fencing_token,
            "sourceFingerprint": source_fingerprint,
            "executorVersion": executor_version,
            "actionSpecSha256": action_spec_sha256,
        }))?;
        Ok(Self {
            claim_id,
            operation_id,
            owner_instance_id,
            fencing_token,
            source_fingerprint,
            claimed_at,
            lease_expires_at,
            executor_version,
            action_spec,
            action_spec_sha256,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationalRecoveryEffectClass {
    LocalDeterministic,
    PersistedProviderResultProjection,
    ProviderDispatch,
    VerifiedToolResultProjection,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalRecoveryExecution {
    pub execution_id: String,
    pub claim_id: String,
    pub owner_instance_id: String,
    pub fencing_token: u64,
    pub source_fingerprint: String,
    pub action_spec_sha256: String,
    pub effect_class: OperationalRecoveryEffectClass,
    pub started_at: String,
}

impl OperationalRecoveryExecution {
    pub fn derive(
        claim: &OperationalRecoveryClaim,
        effect_class: OperationalRecoveryEffectClass,
        started_at: String,
    ) -> Result<Self, OperationalRecoveryAggregateError> {
        validate_claim(claim)?;
        let started = OffsetDateTime::parse(&started_at, &Rfc3339)?;
        let expires = OffsetDateTime::parse(&claim.lease_expires_at, &Rfc3339)?;
        if started > expires {
            return Err(OperationalRecoveryAggregateError::ClaimLeaseExpired);
        }
        let execution_id = canonical_sha256(&serde_json::json!({
            "claimId": claim.claim_id,
            "ownerInstanceId": claim.owner_instance_id,
            "fencingToken": claim.fencing_token,
            "sourceFingerprint": claim.source_fingerprint,
            "actionSpecSha256": claim.action_spec_sha256,
            "effectClass": effect_class,
        }))?;
        Ok(Self {
            execution_id,
            claim_id: claim.claim_id.clone(),
            owner_instance_id: claim.owner_instance_id.clone(),
            fencing_token: claim.fencing_token,
            source_fingerprint: claim.source_fingerprint.clone(),
            action_spec_sha256: claim.action_spec_sha256.clone(),
            effect_class,
            started_at,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum OperationalRecoveryOutcome {
    Succeeded {
        execution_id: String,
        claim_id: String,
        owner_instance_id: String,
        fencing_token: u64,
        result_manifest_sha256: String,
        final_checkpoint_sha256: String,
        completed_at: String,
    },
    FailedSafe {
        execution_id: String,
        claim_id: String,
        owner_instance_id: String,
        fencing_token: u64,
        error_code: String,
        evidence_sha256: String,
        failed_at: String,
    },
    OutcomeUnknown {
        execution_id: String,
        claim_id: String,
        owner_instance_id: String,
        fencing_token: u64,
        reason_code: String,
        evidence_sha256: String,
        detected_at: String,
    },
}

impl OperationalRecoveryOutcome {
    pub fn succeeded(
        execution: &OperationalRecoveryExecution,
        result_manifest_sha256: String,
        final_checkpoint_sha256: String,
        completed_at: String,
    ) -> Result<Self, OperationalRecoveryAggregateError> {
        validate_execution(execution)?;
        require_sha256("result_manifest_sha256", &result_manifest_sha256)?;
        require_sha256("final_checkpoint_sha256", &final_checkpoint_sha256)?;
        parse_time("completed_at", &completed_at)?;
        Ok(Self::Succeeded {
            execution_id: execution.execution_id.clone(),
            claim_id: execution.claim_id.clone(),
            owner_instance_id: execution.owner_instance_id.clone(),
            fencing_token: execution.fencing_token,
            result_manifest_sha256,
            final_checkpoint_sha256,
            completed_at,
        })
    }

    pub fn failed_safe(
        execution: &OperationalRecoveryExecution,
        error_code: String,
        evidence_sha256: String,
        failed_at: String,
    ) -> Result<Self, OperationalRecoveryAggregateError> {
        validate_execution(execution)?;
        require_text("error_code", &error_code)?;
        require_sha256("evidence_sha256", &evidence_sha256)?;
        parse_time("failed_at", &failed_at)?;
        Ok(Self::FailedSafe {
            execution_id: execution.execution_id.clone(),
            claim_id: execution.claim_id.clone(),
            owner_instance_id: execution.owner_instance_id.clone(),
            fencing_token: execution.fencing_token,
            error_code,
            evidence_sha256,
            failed_at,
        })
    }

    pub fn outcome_unknown(
        execution: &OperationalRecoveryExecution,
        reason_code: String,
        evidence_sha256: String,
        detected_at: String,
    ) -> Result<Self, OperationalRecoveryAggregateError> {
        validate_execution(execution)?;
        require_text("reason_code", &reason_code)?;
        require_sha256("evidence_sha256", &evidence_sha256)?;
        parse_time("detected_at", &detected_at)?;
        Ok(Self::OutcomeUnknown {
            execution_id: execution.execution_id.clone(),
            claim_id: execution.claim_id.clone(),
            owner_instance_id: execution.owner_instance_id.clone(),
            fencing_token: execution.fencing_token,
            reason_code,
            evidence_sha256,
            detected_at,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryAggregate {
    pub subject: OperationalRecoverySubject,
    pub operations: BTreeMap<String, OperationalRecoveryOperation>,
    pub revision: u64,
    pub last_event_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryEventMetadata {
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
enum RecoveryEventData {
    Observed {
        subject: OperationalRecoverySubject,
        observation: OperationalRecoveryObservation,
    },
    Waiting {
        operation_id: String,
        reason: OperationalRecoveryWaitingReason,
        evidence_fingerprint: String,
    },
    Quarantined {
        operation_id: String,
        invariant_codes: Vec<String>,
        evidence_fingerprint: String,
    },
    Claimed {
        claim: OperationalRecoveryClaim,
    },
    ClaimTransferred {
        operation_id: String,
        previous_claim_id: String,
        exclusive_owner_instance_id: String,
        claim: OperationalRecoveryClaim,
    },
    LeaseRenewed {
        operation_id: String,
        claim_id: String,
        owner_instance_id: String,
        fencing_token: u64,
        previous_expires_at: String,
        renewed_at: String,
        lease_expires_at: String,
    },
    ExecutionStarted {
        operation_id: String,
        execution: OperationalRecoveryExecution,
    },
    ExecutionResumeAuthorized {
        operation_id: String,
        resume: OperationalRecoveryResume,
    },
    ProviderDispatchResumeAuthorized {
        operation_id: String,
        authorization: ProviderDispatchResumeAuthorization,
    },
    ExecutionFinished {
        operation_id: String,
        outcome: OperationalRecoveryOutcome,
    },
    StaleMarked {
        operation_id: String,
        stale: OperationalRecoveryStale,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct StoredRecoveryEvent {
    aggregate_revision: u64,
    previous_hash: String,
    data: RecoveryEventData,
    event_hash: String,
}

#[derive(Serialize)]
struct HashMaterial<'a> {
    aggregate_revision: u64,
    previous_hash: &'a str,
    data: &'a RecoveryEventData,
}

pub struct OperationalRecoveryRepository {
    journal: WorkspaceEventJournal,
}

impl OperationalRecoveryRepository {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, OperationalRecoveryAggregateError> {
        Ok(Self {
            journal: WorkspaceEventJournal::open(path)?,
        })
    }

    pub fn load(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        let events = self
            .journal
            .read_stream(workspace_id, STREAM_TYPE, &stream_id(run_id), 0)?;
        replay(&events)?.ok_or(OperationalRecoveryAggregateError::NotFound)
    }

    pub fn observe(
        &mut self,
        subject: OperationalRecoverySubject,
        observation: OperationalRecoveryObservation,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        validate_subject(&subject)?;
        validate_observation(&subject, &observation)?;
        let existing = self.journal.read_stream(
            &subject.workspace_id,
            STREAM_TYPE,
            &stream_id(&subject.run_id),
            0,
        )?;
        if let Some(current) = replay(&existing)? {
            if current.subject != subject {
                return Err(OperationalRecoveryAggregateError::SubjectConflict);
            }
            if let Some(operation) = current.operations.get(&observation.operation_id) {
                return if operation.observation == observation {
                    Ok(current)
                } else {
                    Err(OperationalRecoveryAggregateError::OperationConflict)
                };
            }
            return self.append(
                current,
                RecoveryEventData::Observed {
                    subject,
                    observation,
                },
                metadata,
            );
        }
        let candidate = empty(subject.clone());
        self.append(
            candidate,
            RecoveryEventData::Observed {
                subject,
                observation,
            },
            metadata,
        )
    }

    pub fn wait(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        reason: OperationalRecoveryWaitingReason,
        evidence_fingerprint: String,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        require_sha256("evidence_fingerprint", &evidence_fingerprint)?;
        let current = self.load(workspace_id, run_id)?;
        if let Some(operation) = current.operations.get(operation_id) {
            let candidate = OperationalRecoveryDisposition::Waiting {
                reason,
                evidence_fingerprint: evidence_fingerprint.clone(),
            };
            if operation.disposition.as_ref() == Some(&candidate) {
                return Ok(current);
            }
            if operation.disposition.is_some() {
                return Err(OperationalRecoveryAggregateError::DispositionConflict);
            }
        } else {
            return Err(OperationalRecoveryAggregateError::OperationNotFound);
        }
        self.append(
            current,
            RecoveryEventData::Waiting {
                operation_id: operation_id.to_owned(),
                reason,
                evidence_fingerprint,
            },
            metadata,
        )
    }

    pub fn quarantine(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        mut invariant_codes: Vec<String>,
        evidence_fingerprint: String,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        require_sha256("evidence_fingerprint", &evidence_fingerprint)?;
        invariant_codes.sort();
        invariant_codes.dedup();
        if invariant_codes.is_empty() {
            return Err(OperationalRecoveryAggregateError::InvariantCodesRequired);
        }
        for code in &invariant_codes {
            require_text("invariant_code", code)?;
        }
        let current = self.load(workspace_id, run_id)?;
        if let Some(operation) = current.operations.get(operation_id) {
            let candidate = OperationalRecoveryDisposition::Quarantined {
                invariant_codes: invariant_codes.clone(),
                evidence_fingerprint: evidence_fingerprint.clone(),
            };
            if operation.disposition.as_ref() == Some(&candidate) {
                return Ok(current);
            }
            if operation.disposition.is_some() {
                return Err(OperationalRecoveryAggregateError::DispositionConflict);
            }
        } else {
            return Err(OperationalRecoveryAggregateError::OperationNotFound);
        }
        self.append(
            current,
            RecoveryEventData::Quarantined {
                operation_id: operation_id.to_owned(),
                invariant_codes,
                evidence_fingerprint,
            },
            metadata,
        )
    }

    pub fn claim(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        claim: OperationalRecoveryClaim,
        expected_global_sequence: u64,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        validate_claim(&claim)?;
        validate_initial_lease_policy(&claim)?;
        let current = self.load(workspace_id, run_id)?;
        if current.operations.iter().any(|(operation_id, operation)| {
            operation_id != &claim.operation_id
                && operation.claim.is_some()
                && operation.outcome.is_none()
                && operation.stale.is_none()
        }) {
            return Err(OperationalRecoveryAggregateError::ActiveOperationConflict);
        }
        let operation = current
            .operations
            .get(&claim.operation_id)
            .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
        let action_matches_gate = match (operation.observation.gate, claim.action_spec.as_ref()) {
            (OperationalRecoveryObservedGate::RecoveryReady, Some(action)) => {
                action.may_execute_without_new_external_effect()
            }
            (OperationalRecoveryObservedGate::ProviderDispatchReady, Some(action)) => {
                action.is_persisted_provider_dispatch()
            }
            _ => false,
        };
        if !action_matches_gate
            || operation.disposition.is_some()
            || operation.stale.is_some()
            || operation.observation.source_fingerprint != claim.source_fingerprint
        {
            return Err(OperationalRecoveryAggregateError::OperationNotClaimable);
        }
        if let Some(existing) = &operation.claim {
            return if existing == &claim {
                Ok(current)
            } else {
                Err(OperationalRecoveryAggregateError::ClaimConflict)
            };
        }
        if claim.fencing_token != 1 {
            return Err(OperationalRecoveryAggregateError::FencingTokenInvalid);
        }
        self.append_at_global_sequence(
            current,
            RecoveryEventData::Claimed { claim },
            expected_global_sequence,
            metadata,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transfer_claim(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        previous_claim_id: &str,
        claim: OperationalRecoveryClaim,
        exclusive_lease: &WorkspaceRuntimeLease,
        expected_global_sequence: u64,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        validate_claim(&claim)?;
        validate_initial_lease_policy(&claim)?;
        if !exclusive_lease.proves_exclusive_owner(&claim.owner_instance_id) {
            return Err(OperationalRecoveryAggregateError::ExclusiveOwnerRequired);
        }
        let current = self.load(workspace_id, run_id)?;
        let operation = current
            .operations
            .get(operation_id)
            .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
        let previous = operation
            .claim
            .as_ref()
            .ok_or(OperationalRecoveryAggregateError::ClaimRequired)?;
        if previous.claim_id != previous_claim_id
            || operation.execution.is_some()
            || operation.outcome.is_some()
            || operation.stale.is_some()
            || claim.operation_id != previous.operation_id
            || claim.source_fingerprint != previous.source_fingerprint
            || claim.executor_version != previous.executor_version
            || claim.action_spec != previous.action_spec
            || claim.action_spec_sha256 != previous.action_spec_sha256
            || claim.fencing_token
                != previous
                    .fencing_token
                    .checked_add(1)
                    .ok_or(OperationalRecoveryAggregateError::FencingTokenInvalid)?
        {
            return Err(OperationalRecoveryAggregateError::ClaimTransferInvalid);
        }
        let transferred_at = parse_time("claimed_at", &claim.claimed_at)?;
        let previous_expiry = parse_time("lease_expires_at", &previous.lease_expires_at)?;
        if transferred_at < previous_expiry {
            return Err(OperationalRecoveryAggregateError::ClaimTransferBeforeExpiry);
        }
        self.append_at_global_sequence(
            current,
            RecoveryEventData::ClaimTransferred {
                operation_id: operation_id.to_owned(),
                previous_claim_id: previous_claim_id.to_owned(),
                exclusive_owner_instance_id: exclusive_lease.instance_id().to_owned(),
                claim,
            },
            expected_global_sequence,
            metadata,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mark_stale(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        stale: OperationalRecoveryStale,
        exclusive_lease: &WorkspaceRuntimeLease,
        expected_global_sequence: u64,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        validate_stale(&stale)?;
        if stale.detector_instance_id != exclusive_lease.instance_id() {
            return Err(OperationalRecoveryAggregateError::ExclusiveOwnerRequired);
        }
        let current = self.load(workspace_id, run_id)?;
        let operation = current
            .operations
            .get(operation_id)
            .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
        if stale.expected_operation_id != operation.observation.operation_id
            || stale.expected_source_fingerprint != operation.observation.source_fingerprint
            || operation.execution.is_some()
            || operation.outcome.is_some()
        {
            return Err(OperationalRecoveryAggregateError::StaleTransitionInvalid);
        }
        match (
            &operation.claim,
            &stale.current_claim_id,
            stale.current_fencing_token,
        ) {
            (None, None, None) => {}
            (Some(claim), Some(claim_id), Some(token))
                if claim.claim_id == *claim_id && claim.fencing_token == token => {}
            _ => return Err(OperationalRecoveryAggregateError::StaleClaimIdentityInvalid),
        }
        if let Some(existing) = &operation.stale {
            return if existing == &stale {
                Ok(current)
            } else {
                Err(OperationalRecoveryAggregateError::OperationTerminal)
            };
        }
        if stale.scan_global_sequence != expected_global_sequence {
            return Err(OperationalRecoveryAggregateError::StaleTransitionInvalid);
        }
        self.append_at_global_sequence(
            current,
            RecoveryEventData::StaleMarked {
                operation_id: operation_id.to_owned(),
                stale,
            },
            expected_global_sequence,
            metadata,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn renew_lease(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        claim_id: &str,
        owner_instance_id: &str,
        fencing_token: u64,
        renewed_at: String,
        lease_expires_at: String,
        expected_global_sequence: u64,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        let current = self.load(workspace_id, run_id)?;
        let operation = current
            .operations
            .get(operation_id)
            .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
        let claim = require_current_claim(operation, claim_id, owner_instance_id, fencing_token)?;
        if operation.outcome.is_some() || operation.stale.is_some() {
            return Err(OperationalRecoveryAggregateError::OperationTerminal);
        }
        let renewed = parse_time("renewed_at", &renewed_at)?;
        let previous = parse_time("lease_expires_at", &claim.lease_expires_at)?;
        let next = parse_time("lease_expires_at", &lease_expires_at)?;
        if renewed >= previous
            || next <= previous
            || next - renewed > time::Duration::seconds(MAX_RECOVERY_CLAIM_LEASE_SECONDS as i64)
        {
            return Err(OperationalRecoveryAggregateError::LeaseRenewalInvalid);
        }
        let previous_expires_at = claim.lease_expires_at.clone();
        self.append_at_global_sequence(
            current,
            RecoveryEventData::LeaseRenewed {
                operation_id: operation_id.to_owned(),
                claim_id: claim_id.to_owned(),
                owner_instance_id: owner_instance_id.to_owned(),
                fencing_token,
                previous_expires_at,
                renewed_at,
                lease_expires_at,
            },
            expected_global_sequence,
            metadata,
        )
    }

    pub fn start_execution(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        execution: OperationalRecoveryExecution,
        expected_global_sequence: u64,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        validate_execution(&execution)?;
        let current = self.load(workspace_id, run_id)?;
        let operation = current
            .operations
            .get(operation_id)
            .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
        let claim = require_current_claim(
            operation,
            &execution.claim_id,
            &execution.owner_instance_id,
            execution.fencing_token,
        )?;
        if execution.source_fingerprint != claim.source_fingerprint
            || execution.action_spec_sha256 != claim.action_spec_sha256
        {
            return Err(OperationalRecoveryAggregateError::ExecutionConflict);
        }
        if let Some(existing) = &operation.execution {
            return if existing == &execution {
                Ok(current)
            } else {
                Err(OperationalRecoveryAggregateError::ExecutionConflict)
            };
        }
        if operation.outcome.is_some() || operation.stale.is_some() {
            return Err(OperationalRecoveryAggregateError::OperationTerminal);
        }
        self.append_at_global_sequence(
            current,
            RecoveryEventData::ExecutionStarted {
                operation_id: operation_id.to_owned(),
                execution,
            },
            expected_global_sequence,
            metadata,
        )
    }

    pub fn finish_execution(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        outcome: OperationalRecoveryOutcome,
        expected_global_sequence: u64,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        validate_outcome(&outcome)?;
        let current = self.load(workspace_id, run_id)?;
        let operation = current
            .operations
            .get(operation_id)
            .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
        let execution = operation
            .execution
            .as_ref()
            .ok_or(OperationalRecoveryAggregateError::ExecutionRequired)?;
        validate_outcome_matches_execution(&outcome, execution)?;
        if let Some(existing) = &operation.outcome {
            return if existing == &outcome {
                Ok(current)
            } else {
                Err(OperationalRecoveryAggregateError::OperationTerminal)
            };
        }
        self.append_at_global_sequence(
            current,
            RecoveryEventData::ExecutionFinished {
                operation_id: operation_id.to_owned(),
                outcome,
            },
            expected_global_sequence,
            metadata,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn authorize_local_execution_resume(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        resume: OperationalRecoveryResume,
        exclusive_lease: &WorkspaceRuntimeLease,
        expected_global_sequence: u64,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        validate_resume(&resume)?;
        if !exclusive_lease.proves_exclusive_owner(&resume.resumer_instance_id) {
            return Err(OperationalRecoveryAggregateError::ExclusiveOwnerRequired);
        }
        let current = self.load(workspace_id, run_id)?;
        let operation = current
            .operations
            .get(operation_id)
            .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
        let execution = operation
            .execution
            .as_ref()
            .ok_or(OperationalRecoveryAggregateError::ExecutionRequired)?;
        if operation.outcome.is_some()
            || operation.stale.is_some()
            || execution.effect_class
                != OperationalRecoveryEffectClass::PersistedProviderResultProjection
            || resume.execution_id != execution.execution_id
            || resume.original_owner_instance_id != execution.owner_instance_id
            || resume.fencing_token != execution.fencing_token
        {
            return Err(OperationalRecoveryAggregateError::ResumeNotAllowed);
        }
        let derived = OperationalRecoveryResume::derive(
            execution,
            resume.resumer_instance_id.clone(),
            resume.resumed_at.clone(),
        )?;
        if derived != resume {
            return Err(OperationalRecoveryAggregateError::ResumeConflict);
        }
        if operation
            .resumes
            .iter()
            .any(|existing| existing.resume_id == resume.resume_id)
        {
            return Ok(current);
        }
        self.append_at_global_sequence(
            current,
            RecoveryEventData::ExecutionResumeAuthorized {
                operation_id: operation_id.to_owned(),
                resume,
            },
            expected_global_sequence,
            metadata,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn authorize_provider_dispatch_resume(
        &mut self,
        workspace_id: &str,
        run_id: &str,
        operation_id: &str,
        authorization: ProviderDispatchResumeAuthorization,
        exclusive_lease: &WorkspaceRuntimeLease,
        expected_global_sequence: u64,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        validate_provider_dispatch_resume(&authorization)?;
        if !exclusive_lease.proves_exclusive_owner(&authorization.resumer_instance_id) {
            return Err(OperationalRecoveryAggregateError::ExclusiveOwnerRequired);
        }
        let current = self.load(workspace_id, run_id)?;
        let operation = current
            .operations
            .get(operation_id)
            .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
        validate_provider_dispatch_resume_for_operation(operation_id, operation, &authorization)?;
        if operation
            .latest_provider_dispatch_resume()
            .is_some_and(|existing| existing == &authorization)
        {
            return Ok(current);
        }
        validate_provider_dispatch_resume_generation(operation, &authorization)?;
        self.append_at_global_sequence(
            current,
            RecoveryEventData::ProviderDispatchResumeAuthorized {
                operation_id: operation_id.to_owned(),
                authorization,
            },
            expected_global_sequence,
            metadata,
        )
    }

    fn append(
        &mut self,
        current: OperationalRecoveryAggregate,
        data: RecoveryEventData,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        self.append_inner(current, data, None, metadata)
    }

    fn append_at_global_sequence(
        &mut self,
        current: OperationalRecoveryAggregate,
        data: RecoveryEventData,
        expected_global_sequence: u64,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        self.append_inner(current, data, Some(expected_global_sequence), metadata)
    }

    fn append_inner(
        &mut self,
        current: OperationalRecoveryAggregate,
        data: RecoveryEventData,
        expected_global_sequence: Option<u64>,
        metadata: OperationalRecoveryEventMetadata,
    ) -> Result<OperationalRecoveryAggregate, OperationalRecoveryAggregateError> {
        require_text("created_at", &metadata.created_at)?;
        let next = current
            .revision
            .checked_add(1)
            .ok_or(OperationalRecoveryAggregateError::RevisionOverflow)?;
        let stored = StoredRecoveryEvent {
            aggregate_revision: next,
            previous_hash: current.last_event_hash.clone(),
            event_hash: event_hash(next, &current.last_event_hash, &data)?,
            data,
        };
        let operation_id = event_operation_id(&stored.data);
        let suffix = event_suffix(&stored.data)?;
        let stream = stream_id(&current.subject.run_id);
        let event = NewWorkspaceEvent {
            workspace_id: current.subject.workspace_id.clone(),
            stream_type: STREAM_TYPE.to_owned(),
            stream_id: stream.clone(),
            message_id: format!("recovery:{operation_id}:{suffix}"),
            idempotency_key: format!("recovery:{operation_id}:{suffix}"),
            event_type: EVENT_TYPE.to_owned(),
            event_version: EVENT_VERSION,
            payload: serde_json::to_value(stored)?,
            created_at: metadata.created_at,
        };
        let workspace_sequence = self
            .journal
            .current_workspace_sequence(&current.subject.workspace_id)?;
        if let Some(expected_global_sequence) = expected_global_sequence {
            self.journal.append_at_global_sequence(
                event,
                workspace_sequence,
                current.revision,
                expected_global_sequence,
            )?;
        } else {
            self.journal
                .append(event, workspace_sequence, current.revision)?;
        }
        self.load(&current.subject.workspace_id, &current.subject.run_id)
    }
}

fn replay(
    events: &[WorkspaceEvent],
) -> Result<Option<OperationalRecoveryAggregate>, OperationalRecoveryAggregateError> {
    let mut value: Option<OperationalRecoveryAggregate> = None;
    for (index, event) in events.iter().enumerate() {
        if event.stream_type != STREAM_TYPE
            || event.event_type != EVENT_TYPE
            || event.event_version != EVENT_VERSION
            || event.stream_sequence != (index as u64 + 1)
        {
            return Err(OperationalRecoveryAggregateError::EventEnvelopeMismatch);
        }
        let stored: StoredRecoveryEvent = serde_json::from_value(event.payload.clone())?;
        let expected_revision = index as u64 + 1;
        let previous_hash = value
            .as_ref()
            .map_or(GENESIS_HASH, |aggregate| aggregate.last_event_hash.as_str());
        if stored.aggregate_revision != expected_revision
            || stored.previous_hash != previous_hash
            || stored.event_hash != event_hash(expected_revision, previous_hash, &stored.data)?
        {
            return Err(OperationalRecoveryAggregateError::HashChainInvalid);
        }
        apply_event(&mut value, stored)?;
    }
    Ok(value)
}

fn apply_event(
    value: &mut Option<OperationalRecoveryAggregate>,
    event: StoredRecoveryEvent,
) -> Result<(), OperationalRecoveryAggregateError> {
    match event.data {
        RecoveryEventData::Observed {
            subject,
            observation,
        } => {
            validate_observation(&subject, &observation)?;
            let aggregate = value.get_or_insert_with(|| empty(subject.clone()));
            if aggregate.subject != subject
                || aggregate.operations.contains_key(&observation.operation_id)
            {
                return Err(OperationalRecoveryAggregateError::OperationConflict);
            }
            aggregate.operations.insert(
                observation.operation_id.clone(),
                OperationalRecoveryOperation {
                    observation,
                    disposition: None,
                    claim: None,
                    execution: None,
                    resumes: vec![],
                    provider_dispatch_resumes: vec![],
                    outcome: None,
                    stale: None,
                },
            );
            aggregate.revision = event.aggregate_revision;
            aggregate.last_event_hash = event.event_hash;
        }
        RecoveryEventData::Waiting {
            operation_id,
            reason,
            evidence_fingerprint,
        } => {
            require_sha256("evidence_fingerprint", &evidence_fingerprint)?;
            let aggregate = value
                .as_mut()
                .ok_or(OperationalRecoveryAggregateError::ObservedRequired)?;
            let operation = aggregate
                .operations
                .get_mut(&operation_id)
                .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
            if operation.disposition.is_some() {
                return Err(OperationalRecoveryAggregateError::DispositionConflict);
            }
            operation.disposition = Some(OperationalRecoveryDisposition::Waiting {
                reason,
                evidence_fingerprint,
            });
            aggregate.revision = event.aggregate_revision;
            aggregate.last_event_hash = event.event_hash;
        }
        RecoveryEventData::Quarantined {
            operation_id,
            invariant_codes,
            evidence_fingerprint,
        } => {
            require_sha256("evidence_fingerprint", &evidence_fingerprint)?;
            if invariant_codes.is_empty() {
                return Err(OperationalRecoveryAggregateError::InvariantCodesRequired);
            }
            let aggregate = value
                .as_mut()
                .ok_or(OperationalRecoveryAggregateError::ObservedRequired)?;
            let operation = aggregate
                .operations
                .get_mut(&operation_id)
                .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
            if operation.disposition.is_some() {
                return Err(OperationalRecoveryAggregateError::DispositionConflict);
            }
            operation.disposition = Some(OperationalRecoveryDisposition::Quarantined {
                invariant_codes,
                evidence_fingerprint,
            });
            aggregate.revision = event.aggregate_revision;
            aggregate.last_event_hash = event.event_hash;
        }
        RecoveryEventData::Claimed { claim } => {
            validate_claim(&claim)?;
            validate_initial_lease_policy(&claim)?;
            let aggregate = value
                .as_mut()
                .ok_or(OperationalRecoveryAggregateError::ObservedRequired)?;
            if aggregate
                .operations
                .iter()
                .any(|(operation_id, operation)| {
                    operation_id != &claim.operation_id
                        && operation.claim.is_some()
                        && operation.outcome.is_none()
                        && operation.stale.is_none()
                })
            {
                return Err(OperationalRecoveryAggregateError::ActiveOperationConflict);
            }
            let operation = aggregate
                .operations
                .get_mut(&claim.operation_id)
                .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
            let action_matches_gate = match (operation.observation.gate, claim.action_spec.as_ref())
            {
                (OperationalRecoveryObservedGate::RecoveryReady, Some(action)) => {
                    action.may_execute_without_new_external_effect()
                }
                (OperationalRecoveryObservedGate::ProviderDispatchReady, Some(action)) => {
                    action.is_persisted_provider_dispatch()
                }
                _ => false,
            };
            if !action_matches_gate
                || operation.disposition.is_some()
                || operation.claim.is_some()
                || operation.stale.is_some()
                || operation.observation.source_fingerprint != claim.source_fingerprint
                || claim.fencing_token != 1
            {
                return Err(OperationalRecoveryAggregateError::OperationNotClaimable);
            }
            operation.claim = Some(claim);
            aggregate.revision = event.aggregate_revision;
            aggregate.last_event_hash = event.event_hash;
        }
        RecoveryEventData::ClaimTransferred {
            operation_id,
            previous_claim_id,
            exclusive_owner_instance_id,
            claim,
        } => {
            validate_claim(&claim)?;
            validate_initial_lease_policy(&claim)?;
            let aggregate = value
                .as_mut()
                .ok_or(OperationalRecoveryAggregateError::ObservedRequired)?;
            let operation = aggregate
                .operations
                .get_mut(&operation_id)
                .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
            let previous = operation
                .claim
                .as_ref()
                .ok_or(OperationalRecoveryAggregateError::ClaimRequired)?;
            if previous.claim_id != previous_claim_id
                || exclusive_owner_instance_id != claim.owner_instance_id
                || operation.execution.is_some()
                || operation.outcome.is_some()
                || operation.stale.is_some()
                || claim.operation_id != previous.operation_id
                || claim.source_fingerprint != previous.source_fingerprint
                || claim.executor_version != previous.executor_version
                || claim.action_spec != previous.action_spec
                || claim.action_spec_sha256 != previous.action_spec_sha256
                || claim.fencing_token
                    != previous
                        .fencing_token
                        .checked_add(1)
                        .ok_or(OperationalRecoveryAggregateError::FencingTokenInvalid)?
                || parse_time("claimed_at", &claim.claimed_at)?
                    < parse_time("lease_expires_at", &previous.lease_expires_at)?
            {
                return Err(OperationalRecoveryAggregateError::ClaimTransferInvalid);
            }
            operation.claim = Some(claim);
            aggregate.revision = event.aggregate_revision;
            aggregate.last_event_hash = event.event_hash;
        }
        RecoveryEventData::ExecutionResumeAuthorized {
            operation_id,
            resume,
        } => {
            validate_resume(&resume)?;
            let aggregate = value
                .as_mut()
                .ok_or(OperationalRecoveryAggregateError::ObservedRequired)?;
            let operation = aggregate
                .operations
                .get_mut(&operation_id)
                .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
            let execution = operation
                .execution
                .as_ref()
                .ok_or(OperationalRecoveryAggregateError::ExecutionRequired)?;
            if operation.outcome.is_some()
                || operation.stale.is_some()
                || execution.effect_class
                    != OperationalRecoveryEffectClass::PersistedProviderResultProjection
                || resume.execution_id != execution.execution_id
                || resume.original_owner_instance_id != execution.owner_instance_id
                || resume.fencing_token != execution.fencing_token
                || operation
                    .resumes
                    .iter()
                    .any(|existing| existing.resume_id == resume.resume_id)
            {
                return Err(OperationalRecoveryAggregateError::ResumeNotAllowed);
            }
            let derived = OperationalRecoveryResume::derive(
                execution,
                resume.resumer_instance_id.clone(),
                resume.resumed_at.clone(),
            )?;
            if derived != resume {
                return Err(OperationalRecoveryAggregateError::ResumeConflict);
            }
            operation.resumes.push(resume);
            aggregate.revision = event.aggregate_revision;
            aggregate.last_event_hash = event.event_hash;
        }
        RecoveryEventData::ProviderDispatchResumeAuthorized {
            operation_id,
            authorization,
        } => {
            validate_provider_dispatch_resume(&authorization)?;
            let aggregate = value
                .as_mut()
                .ok_or(OperationalRecoveryAggregateError::ObservedRequired)?;
            let operation = aggregate
                .operations
                .get_mut(&operation_id)
                .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
            validate_provider_dispatch_resume_for_operation(
                &operation_id,
                operation,
                &authorization,
            )?;
            validate_provider_dispatch_resume_generation(operation, &authorization)?;
            operation.provider_dispatch_resumes.push(authorization);
            aggregate.revision = event.aggregate_revision;
            aggregate.last_event_hash = event.event_hash;
        }
        RecoveryEventData::LeaseRenewed {
            operation_id,
            claim_id,
            owner_instance_id,
            fencing_token,
            previous_expires_at,
            renewed_at,
            lease_expires_at,
        } => {
            let aggregate = value
                .as_mut()
                .ok_or(OperationalRecoveryAggregateError::ObservedRequired)?;
            let operation = aggregate
                .operations
                .get_mut(&operation_id)
                .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
            if operation.outcome.is_some() || operation.stale.is_some() {
                return Err(OperationalRecoveryAggregateError::OperationTerminal);
            }
            let claim =
                require_current_claim(operation, &claim_id, &owner_instance_id, fencing_token)?;
            if claim.lease_expires_at != previous_expires_at {
                return Err(OperationalRecoveryAggregateError::LeaseRenewalInvalid);
            }
            let renewed = parse_time("renewed_at", &renewed_at)?;
            let previous = parse_time("previous_expires_at", &previous_expires_at)?;
            let next = parse_time("lease_expires_at", &lease_expires_at)?;
            if renewed >= previous
                || next <= previous
                || next - renewed > time::Duration::seconds(MAX_RECOVERY_CLAIM_LEASE_SECONDS as i64)
            {
                return Err(OperationalRecoveryAggregateError::LeaseRenewalInvalid);
            }
            operation.claim.as_mut().unwrap().lease_expires_at = lease_expires_at;
            aggregate.revision = event.aggregate_revision;
            aggregate.last_event_hash = event.event_hash;
        }
        RecoveryEventData::ExecutionStarted {
            operation_id,
            execution,
        } => {
            validate_execution(&execution)?;
            let aggregate = value
                .as_mut()
                .ok_or(OperationalRecoveryAggregateError::ObservedRequired)?;
            let operation = aggregate
                .operations
                .get_mut(&operation_id)
                .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
            let claim = require_current_claim(
                operation,
                &execution.claim_id,
                &execution.owner_instance_id,
                execution.fencing_token,
            )?;
            if operation.execution.is_some()
                || operation.outcome.is_some()
                || operation.stale.is_some()
                || execution.source_fingerprint != claim.source_fingerprint
                || execution.action_spec_sha256 != claim.action_spec_sha256
            {
                return Err(OperationalRecoveryAggregateError::ExecutionConflict);
            }
            operation.execution = Some(execution);
            aggregate.revision = event.aggregate_revision;
            aggregate.last_event_hash = event.event_hash;
        }
        RecoveryEventData::ExecutionFinished {
            operation_id,
            outcome,
        } => {
            validate_outcome(&outcome)?;
            let aggregate = value
                .as_mut()
                .ok_or(OperationalRecoveryAggregateError::ObservedRequired)?;
            let operation = aggregate
                .operations
                .get_mut(&operation_id)
                .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
            let execution = operation
                .execution
                .as_ref()
                .ok_or(OperationalRecoveryAggregateError::ExecutionRequired)?;
            if operation.outcome.is_some() {
                return Err(OperationalRecoveryAggregateError::OperationTerminal);
            }
            validate_outcome_matches_execution(&outcome, execution)?;
            operation.outcome = Some(outcome);
            aggregate.revision = event.aggregate_revision;
            aggregate.last_event_hash = event.event_hash;
        }
        RecoveryEventData::StaleMarked {
            operation_id,
            stale,
        } => {
            validate_stale(&stale)?;
            let aggregate = value
                .as_mut()
                .ok_or(OperationalRecoveryAggregateError::ObservedRequired)?;
            let operation = aggregate
                .operations
                .get_mut(&operation_id)
                .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
            if stale.expected_operation_id != operation.observation.operation_id
                || stale.expected_source_fingerprint != operation.observation.source_fingerprint
                || operation.execution.is_some()
                || operation.outcome.is_some()
                || operation.stale.is_some()
            {
                return Err(OperationalRecoveryAggregateError::StaleTransitionInvalid);
            }
            match (
                &operation.claim,
                &stale.current_claim_id,
                stale.current_fencing_token,
            ) {
                (None, None, None) => {}
                (Some(claim), Some(claim_id), Some(token))
                    if claim.claim_id == *claim_id && claim.fencing_token == token => {}
                _ => return Err(OperationalRecoveryAggregateError::StaleClaimIdentityInvalid),
            }
            operation.stale = Some(stale);
            aggregate.revision = event.aggregate_revision;
            aggregate.last_event_hash = event.event_hash;
        }
    }
    Ok(())
}

fn empty(subject: OperationalRecoverySubject) -> OperationalRecoveryAggregate {
    OperationalRecoveryAggregate {
        subject,
        operations: BTreeMap::new(),
        revision: 0,
        last_event_hash: GENESIS_HASH.to_owned(),
    }
}

fn validate_subject(
    subject: &OperationalRecoverySubject,
) -> Result<(), OperationalRecoveryAggregateError> {
    require_text("workspace_id", &subject.workspace_id)?;
    require_text("project_id", &subject.project_id)?;
    require_text("run_id", &subject.run_id)?;
    if subject.policy_version != OPERATIONAL_RECOVERY_POLICY_VERSION {
        return Err(OperationalRecoveryAggregateError::PolicyVersionUnsupported);
    }
    Ok(())
}

fn validate_observation(
    subject: &OperationalRecoverySubject,
    observation: &OperationalRecoveryObservation,
) -> Result<(), OperationalRecoveryAggregateError> {
    require_sha256("operation_id", &observation.operation_id)?;
    require_sha256("source_fingerprint", &observation.source_fingerprint)?;
    let derived = OperationalRecoveryObservation::derive(
        subject,
        observation.source_fingerprint.clone(),
        observation.gate,
        observation.reasons.clone(),
    )?;
    if derived != *observation {
        return Err(OperationalRecoveryAggregateError::OperationConflict);
    }
    Ok(())
}

fn validate_claim(
    claim: &OperationalRecoveryClaim,
) -> Result<(), OperationalRecoveryAggregateError> {
    let derived = OperationalRecoveryClaim::derive(
        claim.operation_id.clone(),
        claim.owner_instance_id.clone(),
        claim.fencing_token,
        claim.source_fingerprint.clone(),
        claim.claimed_at.clone(),
        claim.lease_expires_at.clone(),
        claim.executor_version.clone(),
        claim.action_spec.clone(),
        claim.action_spec_sha256.clone(),
    )?;
    if derived == *claim {
        Ok(())
    } else {
        Err(OperationalRecoveryAggregateError::ClaimConflict)
    }
}

fn validate_initial_lease_policy(
    claim: &OperationalRecoveryClaim,
) -> Result<(), OperationalRecoveryAggregateError> {
    let claimed = parse_time("claimed_at", &claim.claimed_at)?;
    let expires = parse_time("lease_expires_at", &claim.lease_expires_at)?;
    if expires - claimed > time::Duration::seconds(MAX_RECOVERY_CLAIM_LEASE_SECONDS as i64) {
        Err(OperationalRecoveryAggregateError::LeaseWindowInvalid)
    } else {
        Ok(())
    }
}

fn validate_execution(
    execution: &OperationalRecoveryExecution,
) -> Result<(), OperationalRecoveryAggregateError> {
    require_sha256("execution_id", &execution.execution_id)?;
    require_sha256("claim_id", &execution.claim_id)?;
    require_text("owner_instance_id", &execution.owner_instance_id)?;
    if execution.fencing_token == 0 {
        return Err(OperationalRecoveryAggregateError::FencingTokenInvalid);
    }
    require_sha256("source_fingerprint", &execution.source_fingerprint)?;
    require_sha256("action_spec_sha256", &execution.action_spec_sha256)?;
    parse_time("started_at", &execution.started_at)?;
    let derived_id = canonical_sha256(&serde_json::json!({
        "claimId": execution.claim_id,
        "ownerInstanceId": execution.owner_instance_id,
        "fencingToken": execution.fencing_token,
        "sourceFingerprint": execution.source_fingerprint,
        "actionSpecSha256": execution.action_spec_sha256,
        "effectClass": execution.effect_class,
    }))?;
    if derived_id == execution.execution_id {
        Ok(())
    } else {
        Err(OperationalRecoveryAggregateError::ExecutionConflict)
    }
}

fn validate_resume(
    resume: &OperationalRecoveryResume,
) -> Result<(), OperationalRecoveryAggregateError> {
    require_sha256("resume_id", &resume.resume_id)?;
    require_sha256("execution_id", &resume.execution_id)?;
    require_text(
        "original_owner_instance_id",
        &resume.original_owner_instance_id,
    )?;
    require_text("resumer_instance_id", &resume.resumer_instance_id)?;
    if resume.fencing_token == 0 {
        return Err(OperationalRecoveryAggregateError::FencingTokenInvalid);
    }
    parse_time("resumed_at", &resume.resumed_at)?;
    Ok(())
}

const fn provider_dispatch_capability(
    state: ProviderAttemptState,
) -> ProviderDispatchResumeCapability {
    match state {
        ProviderAttemptState::Requested => ProviderDispatchResumeCapability::DispatchRequested,
        ProviderAttemptState::Sent | ProviderAttemptState::OutcomeUnknown => {
            ProviderDispatchResumeCapability::FinalizeOutcomeUnknown
        }
        ProviderAttemptState::Responded => ProviderDispatchResumeCapability::FinalizeResponded,
        ProviderAttemptState::Failed => ProviderDispatchResumeCapability::FinalizeFailed,
    }
}

#[allow(clippy::too_many_arguments)]
fn provider_dispatch_resume_id(
    operation_id: &str,
    execution: &OperationalRecoveryExecution,
    resumer_instance_id: &str,
    action_spec_sha256: &str,
    attempt_id: &str,
    attempt_state: ProviderAttemptState,
    attempt_aggregate_sequence: u64,
    attempt_definition_sha256: &str,
    attempt_evidence_sha256: &str,
    capability: ProviderDispatchResumeCapability,
    previous_authorization_id: Option<&str>,
    authorization_generation: u64,
) -> Result<String, OperationalRecoveryAggregateError> {
    provider_dispatch_resume_id_from_fields(
        operation_id,
        &execution.execution_id,
        &execution.claim_id,
        &execution.owner_instance_id,
        resumer_instance_id,
        execution.fencing_token,
        action_spec_sha256,
        attempt_id,
        attempt_state,
        attempt_aggregate_sequence,
        attempt_definition_sha256,
        attempt_evidence_sha256,
        capability,
        previous_authorization_id,
        authorization_generation,
    )
}

#[allow(clippy::too_many_arguments)]
fn provider_dispatch_resume_id_from_fields(
    operation_id: &str,
    execution_id: &str,
    claim_id: &str,
    original_owner_instance_id: &str,
    resumer_instance_id: &str,
    fencing_token: u64,
    action_spec_sha256: &str,
    attempt_id: &str,
    attempt_state: ProviderAttemptState,
    attempt_aggregate_sequence: u64,
    attempt_definition_sha256: &str,
    attempt_evidence_sha256: &str,
    capability: ProviderDispatchResumeCapability,
    previous_authorization_id: Option<&str>,
    authorization_generation: u64,
) -> Result<String, OperationalRecoveryAggregateError> {
    canonical_sha256(&serde_json::json!({
        "policyVersion": PROVIDER_DISPATCH_RESUME_POLICY_VERSION,
        "operationId": operation_id,
        "executionId": execution_id,
        "claimId": claim_id,
        "originalOwnerInstanceId": original_owner_instance_id,
        "resumerInstanceId": resumer_instance_id,
        "fencingToken": fencing_token,
        "actionSpecSha256": action_spec_sha256,
        "attemptId": attempt_id,
        "attemptState": attempt_state,
        "attemptAggregateSequence": attempt_aggregate_sequence,
        "attemptDefinitionSha256": attempt_definition_sha256,
        "attemptEvidenceSha256": attempt_evidence_sha256,
        "capability": capability,
        "previousAuthorizationId": previous_authorization_id,
        "authorizationGeneration": authorization_generation,
    }))
}

fn validate_provider_dispatch_resume(
    authorization: &ProviderDispatchResumeAuthorization,
) -> Result<(), OperationalRecoveryAggregateError> {
    require_sha256("authorization_id", &authorization.authorization_id)?;
    require_sha256("operation_id", &authorization.operation_id)?;
    require_sha256("execution_id", &authorization.execution_id)?;
    require_sha256("claim_id", &authorization.claim_id)?;
    require_text(
        "original_owner_instance_id",
        &authorization.original_owner_instance_id,
    )?;
    require_text("resumer_instance_id", &authorization.resumer_instance_id)?;
    if authorization.original_owner_instance_id == authorization.resumer_instance_id
        || authorization.fencing_token == 0
        || authorization.attempt_aggregate_sequence == 0
        || authorization.authorization_generation == 0
    {
        return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeNotAllowed);
    }
    require_sha256("action_spec_sha256", &authorization.action_spec_sha256)?;
    require_text("attempt_id", &authorization.attempt_id)?;
    require_sha256(
        "attempt_definition_sha256",
        &authorization.attempt_definition_sha256,
    )?;
    require_sha256(
        "attempt_evidence_sha256",
        &authorization.attempt_evidence_sha256,
    )?;
    if authorization.capability != provider_dispatch_capability(authorization.attempt_state)
        || (authorization.authorization_generation == 1
            && authorization.previous_authorization_id.is_some())
        || (authorization.authorization_generation > 1
            && authorization.previous_authorization_id.is_none())
    {
        return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeConflict);
    }
    if let Some(previous) = authorization.previous_authorization_id.as_deref() {
        require_sha256("previous_authorization_id", previous)?;
    }
    parse_time("authorized_at", &authorization.authorized_at)?;
    let expected = provider_dispatch_resume_id_from_fields(
        &authorization.operation_id,
        &authorization.execution_id,
        &authorization.claim_id,
        &authorization.original_owner_instance_id,
        &authorization.resumer_instance_id,
        authorization.fencing_token,
        &authorization.action_spec_sha256,
        &authorization.attempt_id,
        authorization.attempt_state,
        authorization.attempt_aggregate_sequence,
        &authorization.attempt_definition_sha256,
        &authorization.attempt_evidence_sha256,
        authorization.capability,
        authorization.previous_authorization_id.as_deref(),
        authorization.authorization_generation,
    )?;
    if expected != authorization.authorization_id {
        return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeConflict);
    }
    Ok(())
}

fn validate_provider_dispatch_resume_for_operation(
    operation_id: &str,
    operation: &OperationalRecoveryOperation,
    authorization: &ProviderDispatchResumeAuthorization,
) -> Result<(), OperationalRecoveryAggregateError> {
    if operation.outcome.is_some() || operation.stale.is_some() || operation.disposition.is_some() {
        return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeNotAllowed);
    }
    let claim = operation
        .claim
        .as_ref()
        .ok_or(OperationalRecoveryAggregateError::ClaimRequired)?;
    let execution = operation
        .execution
        .as_ref()
        .ok_or(OperationalRecoveryAggregateError::ExecutionRequired)?;
    let action = claim
        .action_spec
        .as_ref()
        .ok_or(OperationalRecoveryAggregateError::ProviderDispatchResumeNotAllowed)?;
    let OperationalRecoveryAction::PersistedProviderAttemptDispatch {
        attempt_id,
        expected_attempt_sequence,
        ..
    } = action
    else {
        return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeNotAllowed);
    };
    if execution.effect_class != OperationalRecoveryEffectClass::ProviderDispatch
        || action.action_spec_sha256()? != claim.action_spec_sha256
        || operation_id != authorization.operation_id
        || execution.execution_id != authorization.execution_id
        || execution.claim_id != authorization.claim_id
        || execution.owner_instance_id != authorization.original_owner_instance_id
        || execution.fencing_token != authorization.fencing_token
        || execution.action_spec_sha256 != authorization.action_spec_sha256
        || claim.claim_id != authorization.claim_id
        || claim.owner_instance_id != authorization.original_owner_instance_id
        || claim.fencing_token != authorization.fencing_token
        || claim.action_spec_sha256 != authorization.action_spec_sha256
        || attempt_id != &authorization.attempt_id
        || authorization.attempt_aggregate_sequence < *expected_attempt_sequence
        || (authorization.attempt_state == ProviderAttemptState::Requested
            && authorization.attempt_aggregate_sequence != *expected_attempt_sequence)
    {
        return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeNotAllowed);
    }
    Ok(())
}

fn validate_provider_dispatch_resume_generation(
    operation: &OperationalRecoveryOperation,
    authorization: &ProviderDispatchResumeAuthorization,
) -> Result<(), OperationalRecoveryAggregateError> {
    let (expected_previous, expected_generation) =
        if let Some(previous) = operation.latest_provider_dispatch_resume() {
            (
                Some(previous.authorization_id.as_str()),
                previous
                    .authorization_generation
                    .checked_add(1)
                    .ok_or(OperationalRecoveryAggregateError::RevisionOverflow)?,
            )
        } else {
            (None, 1)
        };
    if authorization.previous_authorization_id.as_deref() != expected_previous
        || authorization.authorization_generation != expected_generation
    {
        return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeConflict);
    }
    if let Some(previous) = operation.latest_provider_dispatch_resume() {
        let same_evidence = authorization.attempt_aggregate_sequence
            == previous.attempt_aggregate_sequence
            && authorization.attempt_state == previous.attempt_state
            && authorization.attempt_evidence_sha256 == previous.attempt_evidence_sha256;
        let advanced_evidence = authorization.attempt_aggregate_sequence
            > previous.attempt_aggregate_sequence
            && valid_provider_attempt_resume_transition(
                previous.attempt_state,
                authorization.attempt_state,
            );
        if authorization.attempt_id != previous.attempt_id
            || authorization.attempt_definition_sha256 != previous.attempt_definition_sha256
            || parse_time("authorized_at", &authorization.authorized_at)?
                < parse_time("authorized_at", &previous.authorized_at)?
            || (!same_evidence && !advanced_evidence)
        {
            return Err(OperationalRecoveryAggregateError::ProviderDispatchResumeConflict);
        }
    }
    Ok(())
}

fn valid_provider_attempt_resume_transition(
    previous: ProviderAttemptState,
    next: ProviderAttemptState,
) -> bool {
    matches!(
        (previous, next),
        (
            ProviderAttemptState::Requested,
            ProviderAttemptState::Sent
                | ProviderAttemptState::Responded
                | ProviderAttemptState::Failed
                | ProviderAttemptState::OutcomeUnknown
        ) | (
            ProviderAttemptState::Sent,
            ProviderAttemptState::Responded
                | ProviderAttemptState::Failed
                | ProviderAttemptState::OutcomeUnknown
        )
    )
}

fn validate_stale(
    stale: &OperationalRecoveryStale,
) -> Result<(), OperationalRecoveryAggregateError> {
    let derived = OperationalRecoveryStale::derive(
        stale.expected_operation_id.clone(),
        stale.expected_source_fingerprint.clone(),
        stale.actual_operation_id.clone(),
        stale.actual_source_fingerprint.clone(),
        stale.current_claim_id.clone(),
        stale.current_fencing_token,
        stale.detector_instance_id.clone(),
        stale.detected_at.clone(),
        stale.scan_global_sequence,
    )?;
    if derived == *stale {
        Ok(())
    } else {
        Err(OperationalRecoveryAggregateError::StaleTransitionInvalid)
    }
}

fn validate_outcome(
    outcome: &OperationalRecoveryOutcome,
) -> Result<(), OperationalRecoveryAggregateError> {
    let (execution_id, claim_id, owner_instance_id, fencing_token) = outcome_identity(outcome);
    require_sha256("execution_id", execution_id)?;
    require_sha256("claim_id", claim_id)?;
    require_text("owner_instance_id", owner_instance_id)?;
    if fencing_token == 0 {
        return Err(OperationalRecoveryAggregateError::FencingTokenInvalid);
    }
    match outcome {
        OperationalRecoveryOutcome::Succeeded {
            result_manifest_sha256,
            final_checkpoint_sha256,
            completed_at,
            ..
        } => {
            require_sha256("result_manifest_sha256", result_manifest_sha256)?;
            require_sha256("final_checkpoint_sha256", final_checkpoint_sha256)?;
            parse_time("completed_at", completed_at)?;
        }
        OperationalRecoveryOutcome::FailedSafe {
            error_code,
            evidence_sha256,
            failed_at,
            ..
        } => {
            require_text("error_code", error_code)?;
            require_sha256("evidence_sha256", evidence_sha256)?;
            parse_time("failed_at", failed_at)?;
        }
        OperationalRecoveryOutcome::OutcomeUnknown {
            reason_code,
            evidence_sha256,
            detected_at,
            ..
        } => {
            require_text("reason_code", reason_code)?;
            require_sha256("evidence_sha256", evidence_sha256)?;
            parse_time("detected_at", detected_at)?;
        }
    }
    Ok(())
}

fn outcome_identity(outcome: &OperationalRecoveryOutcome) -> (&str, &str, &str, u64) {
    match outcome {
        OperationalRecoveryOutcome::Succeeded {
            execution_id,
            claim_id,
            owner_instance_id,
            fencing_token,
            ..
        }
        | OperationalRecoveryOutcome::FailedSafe {
            execution_id,
            claim_id,
            owner_instance_id,
            fencing_token,
            ..
        }
        | OperationalRecoveryOutcome::OutcomeUnknown {
            execution_id,
            claim_id,
            owner_instance_id,
            fencing_token,
            ..
        } => (execution_id, claim_id, owner_instance_id, *fencing_token),
    }
}

fn validate_outcome_matches_execution(
    outcome: &OperationalRecoveryOutcome,
    execution: &OperationalRecoveryExecution,
) -> Result<(), OperationalRecoveryAggregateError> {
    let (execution_id, claim_id, owner_instance_id, fencing_token) = outcome_identity(outcome);
    if execution_id == execution.execution_id
        && claim_id == execution.claim_id
        && owner_instance_id == execution.owner_instance_id
        && fencing_token == execution.fencing_token
    {
        Ok(())
    } else {
        Err(OperationalRecoveryAggregateError::FenceMismatch)
    }
}

fn require_current_claim<'a>(
    operation: &'a OperationalRecoveryOperation,
    claim_id: &str,
    owner_instance_id: &str,
    fencing_token: u64,
) -> Result<&'a OperationalRecoveryClaim, OperationalRecoveryAggregateError> {
    let claim = operation
        .claim
        .as_ref()
        .ok_or(OperationalRecoveryAggregateError::ClaimRequired)?;
    if claim.claim_id == claim_id
        && claim.owner_instance_id == owner_instance_id
        && claim.fencing_token == fencing_token
    {
        Ok(claim)
    } else {
        Err(OperationalRecoveryAggregateError::FenceMismatch)
    }
}

fn parse_time(
    _field: &'static str,
    value: &str,
) -> Result<OffsetDateTime, OperationalRecoveryAggregateError> {
    require_text("timestamp", value)?;
    Ok(OffsetDateTime::parse(value, &Rfc3339)?)
}

fn event_hash(
    revision: u64,
    previous_hash: &str,
    data: &RecoveryEventData,
) -> Result<String, OperationalRecoveryAggregateError> {
    canonical_sha256(&serde_json::to_value(HashMaterial {
        aggregate_revision: revision,
        previous_hash,
        data,
    })?)
}

fn canonical_sha256(
    value: &serde_json::Value,
) -> Result<String, OperationalRecoveryAggregateError> {
    fn canonicalize(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(canonicalize).collect())
            }
            serde_json::Value::Object(values) => {
                let mut entries = values.into_iter().collect::<Vec<_>>();
                entries.sort_by(|left, right| left.0.cmp(&right.0));
                serde_json::Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key, canonicalize(value)))
                        .collect(),
                )
            }
            scalar => scalar,
        }
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonicalize(value.clone()))?)
    ))
}

fn stream_id(run_id: &str) -> String {
    format!("run:{run_id}")
}

fn event_operation_id(data: &RecoveryEventData) -> &str {
    match data {
        RecoveryEventData::Observed { observation, .. } => &observation.operation_id,
        RecoveryEventData::Waiting { operation_id, .. }
        | RecoveryEventData::Quarantined { operation_id, .. } => operation_id,
        RecoveryEventData::Claimed { claim } => &claim.operation_id,
        RecoveryEventData::ClaimTransferred { operation_id, .. }
        | RecoveryEventData::LeaseRenewed { operation_id, .. }
        | RecoveryEventData::ExecutionStarted { operation_id, .. }
        | RecoveryEventData::ExecutionResumeAuthorized { operation_id, .. }
        | RecoveryEventData::ProviderDispatchResumeAuthorized { operation_id, .. }
        | RecoveryEventData::ExecutionFinished { operation_id, .. }
        | RecoveryEventData::StaleMarked { operation_id, .. } => operation_id,
    }
}

fn event_suffix(data: &RecoveryEventData) -> Result<String, OperationalRecoveryAggregateError> {
    Ok(match data {
        RecoveryEventData::Observed { .. } => "observed".to_owned(),
        RecoveryEventData::Waiting { reason, .. } => format!("waiting:{reason:?}").to_lowercase(),
        RecoveryEventData::Quarantined {
            invariant_codes, ..
        } => format!(
            "quarantined:{}",
            canonical_sha256(&serde_json::to_value(invariant_codes)?)?
        ),
        RecoveryEventData::Claimed { claim } => format!("claimed:{}", claim.claim_id),
        RecoveryEventData::ClaimTransferred {
            previous_claim_id,
            claim,
            ..
        } => format!("claim-transferred:{previous_claim_id}:{}", claim.claim_id),
        RecoveryEventData::LeaseRenewed {
            claim_id,
            lease_expires_at,
            ..
        } => format!(
            "lease-renewed:{claim_id}:{}",
            canonical_sha256(&serde_json::json!(lease_expires_at))?
        ),
        RecoveryEventData::ExecutionStarted { execution, .. } => {
            format!("execution-started:{}", execution.execution_id)
        }
        RecoveryEventData::ExecutionResumeAuthorized { resume, .. } => {
            format!("execution-resumed:{}", resume.resume_id)
        }
        RecoveryEventData::ProviderDispatchResumeAuthorized { authorization, .. } => format!(
            "provider-dispatch-resume-authorized:{}",
            authorization.authorization_id
        ),
        RecoveryEventData::ExecutionFinished { outcome, .. } => format!(
            "execution-finished:{}",
            canonical_sha256(&serde_json::to_value(outcome)?)?
        ),
        RecoveryEventData::StaleMarked { stale, .. } => {
            format!("stale:{}", canonical_sha256(&serde_json::to_value(stale)?)?)
        }
    })
}

fn require_text(field: &'static str, value: &str) -> Result<(), OperationalRecoveryAggregateError> {
    if value.trim().is_empty() {
        Err(OperationalRecoveryAggregateError::EmptyField(field))
    } else {
        Ok(())
    }
}

fn require_sha256(
    field: &'static str,
    value: &str,
) -> Result<(), OperationalRecoveryAggregateError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(OperationalRecoveryAggregateError::InvalidSha256(field))
    }
}

#[derive(Debug, Error)]
pub enum OperationalRecoveryAggregateError {
    #[error("operational recovery field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("operational recovery field `{0}` must be lowercase SHA-256")]
    InvalidSha256(&'static str),
    #[error("operational recovery policy version is unsupported")]
    PolicyVersionUnsupported,
    #[error("operational recovery subject conflicts with persisted identity")]
    SubjectConflict,
    #[error("operational recovery operation conflicts with persisted intent")]
    OperationConflict,
    #[error("operational recovery operation was not found")]
    OperationNotFound,
    #[error("operational recovery observation is required first")]
    ObservedRequired,
    #[error("operational recovery operation already has a disposition")]
    DispositionConflict,
    #[error("operational recovery quarantine requires invariant codes")]
    InvariantCodesRequired,
    #[error("operational recovery operation is not claimable")]
    OperationNotClaimable,
    #[error("another operational recovery operation is still active for this run")]
    ActiveOperationConflict,
    #[error("operational recovery claim conflicts with persisted ownership")]
    ClaimConflict,
    #[error("operational recovery action spec does not match its persisted SHA-256")]
    ActionSpecHashMismatch,
    #[error("operational recovery fencing token is invalid")]
    FencingTokenInvalid,
    #[error("operational recovery requires the exclusive workspace runtime owner")]
    ExclusiveOwnerRequired,
    #[error("operational recovery claim transfer is invalid")]
    ClaimTransferInvalid,
    #[error("operational recovery claim cannot transfer before lease expiry")]
    ClaimTransferBeforeExpiry,
    #[error("operational recovery lease must expire after it is claimed")]
    LeaseWindowInvalid,
    #[error("operational recovery claim lease has expired")]
    ClaimLeaseExpired,
    #[error("operational recovery lease renewal is invalid")]
    LeaseRenewalInvalid,
    #[error("operational recovery claim is required")]
    ClaimRequired,
    #[error("operational recovery fencing identity does not match")]
    FenceMismatch,
    #[error("operational recovery execution conflicts with persisted state")]
    ExecutionConflict,
    #[error("operational recovery execution must start first")]
    ExecutionRequired,
    #[error("operational recovery local execution resume is not allowed")]
    ResumeNotAllowed,
    #[error("operational recovery local execution resume conflicts with persisted history")]
    ResumeConflict,
    #[error("operational recovery Provider dispatch resume is not allowed")]
    ProviderDispatchResumeNotAllowed,
    #[error("operational recovery Provider dispatch resume conflicts with persisted history")]
    ProviderDispatchResumeConflict,
    #[error("operational recovery operation is terminal")]
    OperationTerminal,
    #[error("operational recovery stale evidence did not change")]
    StaleEvidenceUnchanged,
    #[error("operational recovery stale claim identity is invalid")]
    StaleClaimIdentityInvalid,
    #[error("operational recovery stale transition is invalid")]
    StaleTransitionInvalid,
    #[error("operational recovery aggregate was not found")]
    NotFound,
    #[error("operational recovery event envelope is invalid")]
    EventEnvelopeMismatch,
    #[error("operational recovery event hash chain is invalid")]
    HashChainInvalid,
    #[error("operational recovery revision overflowed")]
    RevisionOverflow,
    #[error(transparent)]
    Journal(#[from] WorkspaceEventJournalError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Time(#[from] time::error::Parse),
}
