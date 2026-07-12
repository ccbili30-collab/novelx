use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::workspace_event_journal::{
    NewWorkspaceEvent, WorkspaceEvent, WorkspaceEventJournal, WorkspaceEventJournalError,
};

const STREAM_TYPE: &str = "operational_recovery";
const EVENT_TYPE: &str = "operational_recovery.event";
const EVENT_VERSION: u32 = 1;
const GENESIS_HASH: &str = "GENESIS";
pub const OPERATIONAL_RECOVERY_POLICY_VERSION: &str = "operational-recovery-v1";

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

    fn append(
        &mut self,
        current: OperationalRecoveryAggregate,
        data: RecoveryEventData,
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
        self.journal
            .append(event, workspace_sequence, current.revision)?;
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
}
