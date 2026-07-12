use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::workspace_event_journal::{
    NewWorkspaceEvent, WorkspaceEvent, WorkspaceEventJournal, WorkspaceEventJournalError,
};

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
    pub outcome: Option<OperationalRecoveryOutcome>,
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
            action_spec_sha256,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationalRecoveryEffectClass {
    LocalDeterministic,
    PersistedProviderResultProjection,
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
    ExecutionFinished {
        operation_id: String,
        outcome: OperationalRecoveryOutcome,
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
        let operation = current
            .operations
            .get(&claim.operation_id)
            .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
        if operation.observation.gate != OperationalRecoveryObservedGate::RecoveryReady
            || operation.disposition.is_some()
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
        if operation.outcome.is_some() {
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
        if operation.outcome.is_some() {
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
                    outcome: None,
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
            let operation = aggregate
                .operations
                .get_mut(&claim.operation_id)
                .ok_or(OperationalRecoveryAggregateError::OperationNotFound)?;
            if operation.observation.gate != OperationalRecoveryObservedGate::RecoveryReady
                || operation.disposition.is_some()
                || operation.claim.is_some()
                || operation.observation.source_fingerprint != claim.source_fingerprint
                || claim.fencing_token != 1
            {
                return Err(OperationalRecoveryAggregateError::OperationNotClaimable);
            }
            operation.claim = Some(claim);
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
            if operation.outcome.is_some() {
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
        RecoveryEventData::LeaseRenewed { operation_id, .. }
        | RecoveryEventData::ExecutionStarted { operation_id, .. }
        | RecoveryEventData::ExecutionFinished { operation_id, .. } => operation_id,
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
        RecoveryEventData::ExecutionFinished { outcome, .. } => format!(
            "execution-finished:{}",
            canonical_sha256(&serde_json::to_value(outcome)?)?
        ),
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
    #[error("operational recovery claim conflicts with persisted ownership")]
    ClaimConflict,
    #[error("operational recovery fencing token is invalid")]
    FencingTokenInvalid,
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
    #[error("operational recovery operation is terminal")]
    OperationTerminal,
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
