use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    Command,
    Event,
    Response,
    Control,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub protocol_version: u16,
    pub message_id: Uuid,
    pub message_type: MessageType,
    pub name: String,
    pub sent_at: String,
    pub correlation_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub sequence: u64,
    pub payload: Value,
}

impl Envelope {
    pub fn new(
        message_type: MessageType,
        name: impl Into<String>,
        sent_at: impl Into<String>,
        sequence: u64,
        payload: impl Serialize,
    ) -> Result<Self, serde_json::Error> {
        Ok(Self {
            protocol_version: PROTOCOL_VERSION,
            message_id: Uuid::new_v4(),
            message_type,
            name: name.into(),
            sent_at: sent_at.into(),
            correlation_id: None,
            run_id: None,
            sequence,
            payload: serde_json::to_value(payload)?,
        })
    }

    pub fn validate_version(&self) -> Result<(), ProtocolError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion {
                received: self.protocol_version,
                supported: PROTOCOL_VERSION,
            });
        }
        if self.sequence == 0 || self.sequence > MAX_SAFE_SEQUENCE {
            return Err(ProtocolError::SequenceOutOfRange {
                received: self.sequence,
                maximum: MAX_SAFE_SEQUENCE,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    UnsupportedVersion { received: u16, supported: u16 },
    SequenceOutOfRange { received: u64, maximum: u64 },
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedVersion {
                received,
                supported,
            } => write!(
                formatter,
                "unsupported protocol version {received}; supported version is {supported}"
            ),
            Self::SequenceOutOfRange { received, maximum } => write!(
                formatter,
                "protocol sequence {received} is outside the supported range 1..={maximum}"
            ),
        }
    }
}

impl std::error::Error for ProtocolError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeBuild {
    pub commit: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHello {
    pub runtime_version: String,
    pub protocol_versions: Vec<u16>,
    pub capabilities: Vec<String>,
    pub build: RuntimeBuild,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeApplicationIdentity {
    pub id: String,
    pub version: String,
    pub commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInitialize {
    pub selected_protocol_version: u16,
    pub application: RuntimeApplicationIdentity,
    pub workspace_database_path: Option<String>,
    pub project_root_path: Option<String>,
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    pub feature_flags: BTreeMap<String, bool>,
    pub host_capability_versions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeIdentity {
    pub version: String,
    pub build: RuntimeBuild,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeReady {
    pub selected_protocol_version: u16,
    pub runtime: RuntimeIdentity,
    pub recovered_run_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStatus {
    pub initialized: bool,
    pub workspace_database_configured: bool,
    pub recovered_run_count: u64,
    pub protocol_version: u16,
    pub runtime_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStopped {
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunPermissionMode {
    Free,
    Assist,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionReference {
    pub id: String,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalPermissionMode {
    Free,
    Assist,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalEvidenceReference {
    pub kind: String,
    pub reference: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalAcceptanceCriterion {
    pub criterion_id: String,
    pub description: String,
    pub required: bool,
    pub satisfied: bool,
    pub evidence_refs: Vec<GoalEvidenceReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalDefinition {
    pub objective: String,
    pub scope: GoalScope,
    pub acceptance_criteria: Vec<GoalAcceptanceCriterion>,
    pub constraints: Vec<String>,
    pub permission_mode: GoalPermissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalScope {
    pub resource_ids: Vec<String>,
    pub scope_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalIdentity {
    pub workspace_id: String,
    pub project_id: String,
    pub session_id: String,
    pub goal_id: String,
    pub owner_agent_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalBlocker {
    pub blocker_id: String,
    pub description: String,
    pub evidence_refs: Vec<GoalEvidenceReference>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    CompletionProposed,
    Completed,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalSnapshot {
    pub identity: GoalIdentity,
    pub definition: GoalDefinition,
    pub definition_revision: u64,
    pub revision: u64,
    pub status: GoalStatus,
    pub evidence_refs: Vec<GoalEvidenceReference>,
    pub blockers: Vec<GoalBlocker>,
    pub last_event_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalCreate {
    pub create_idempotency_key: String,
    pub goal_id: String,
    pub session_id: String,
    pub owner_agent_id: String,
    pub definition: GoalDefinition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalGet {
    pub goal_id: String,
    pub revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalRevise {
    pub revise_idempotency_key: String,
    pub goal_id: String,
    pub expected_revision: u64,
    pub definition: GoalDefinition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalCompletionPropose {
    pub propose_idempotency_key: String,
    pub goal_id: String,
    pub expected_revision: u64,
    pub evidence_refs: Vec<GoalEvidenceReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalComplete {
    pub complete_idempotency_key: String,
    pub goal_id: String,
    pub expected_revision: u64,
    pub evidence_refs: Vec<GoalEvidenceReference>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Pending,
    InProgress,
    Completed,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanEvidence {
    pub evidence_type: String,
    pub reference_id: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanStep {
    pub step_id: String,
    pub purpose: String,
    pub dependencies: Vec<String>,
    pub assigned_agent: Option<String>,
    pub capabilities: Vec<String>,
    pub expected_artifact: String,
    pub required_evidence: Vec<String>,
    pub status: PlanStepStatus,
    #[serde(default)]
    pub completion_evidence: Vec<PlanEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRevision {
    pub revision: u64,
    pub goal_revision: u64,
    pub steps: Vec<PlanStep>,
    pub previous_revision_sha256: Option<String>,
    pub revision_sha256: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanSnapshot {
    pub workspace_id: String,
    pub plan_id: String,
    pub goal_id: String,
    pub current_revision: PlanRevision,
    pub last_stream_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanCreate {
    pub create_idempotency_key: String,
    pub plan_id: String,
    pub goal_id: String,
    pub goal_revision: u64,
    pub steps: Vec<PlanStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanGet {
    pub plan_id: String,
    pub revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRevise {
    pub revise_idempotency_key: String,
    pub plan_id: String,
    pub expected_revision: u64,
    pub goal_revision: u64,
    pub steps: Vec<PlanStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanStepStart {
    pub start_idempotency_key: String,
    pub plan_id: String,
    pub expected_revision: u64,
    pub step_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanStepComplete {
    pub complete_idempotency_key: String,
    pub plan_id: String,
    pub expected_revision: u64,
    pub step_id: String,
    pub evidence: Vec<PlanEvidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildAgentPermission {
    ReadOnly,
    ProposeChangeSet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentAssignmentStatus {
    Allocated,
    Running,
    CancelRequested,
    Cancelled,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentScope {
    pub resource_ids: Vec<String>,
    pub scope_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentDefinition {
    pub bounded_objective: String,
    pub source_checkpoint_id: String,
    pub expected_artifact: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentCompletionEvidence {
    pub kind: String,
    pub reference: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildRunSpec {
    pub child_run_id: String,
    pub run_start_idempotency_key: String,
    pub pinned_identity: RunPinnedIdentity,
    pub pinned_identity_sha256: String,
}

pub const ASSIGNMENT_CHILD_PROVISION_OPERATION_VERSION: &str = "assignment-child-provision-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentChildProvisionSagaIdentity {
    pub workspace_id: String,
    pub assignment_id: String,
    pub allocation_revision: u64,
    pub allocation_sha256: String,
    pub child_run_id: String,
    pub child_run_spec_sha256: String,
    pub operation_version: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentChildProvisionIntent {
    pub saga: AssignmentChildProvisionSagaIdentity,
    pub create_idempotency_key: String,
    pub prepare_idempotency_key: String,
    pub cancel_idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAssignmentSnapshot {
    pub assignment_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub goal: RevisionReference,
    pub plan: RevisionReference,
    pub plan_step_id: String,
    pub parent_run_id: String,
    pub parent_invocation_id: String,
    pub child_profile_id: String,
    pub scope: AssignmentScope,
    pub definition: AssignmentDefinition,
    pub permission: ChildAgentPermission,
    pub status: AgentAssignmentStatus,
    pub child_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_run_spec: Option<ChildRunSpec>,
    pub completion_evidence: Vec<AssignmentCompletionEvidence>,
    pub failure_code: Option<String>,
    pub revision: u64,
    pub last_event_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAssignmentCreate {
    pub create_idempotency_key: String,
    pub assignment_id: String,
    pub goal: RevisionReference,
    pub plan: RevisionReference,
    pub plan_step_id: String,
    pub parent_run_id: String,
    pub parent_invocation_id: String,
    pub child_profile_id: String,
    pub scope: AssignmentScope,
    pub definition: AssignmentDefinition,
    pub permission: ChildAgentPermission,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAssignmentGet {
    pub assignment_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAssignmentStart {
    pub start_idempotency_key: String,
    pub assignment_id: String,
    pub expected_revision: u64,
    pub child_run_spec: ChildRunSpec,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAssignmentRequestCancel {
    pub cancel_idempotency_key: String,
    pub assignment_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAssignmentConfirmCancelled {
    pub confirm_idempotency_key: String,
    pub assignment_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAssignmentComplete {
    pub complete_idempotency_key: String,
    pub assignment_id: String,
    pub expected_revision: u64,
    pub evidence: Vec<AssignmentCompletionEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAssignmentFail {
    pub fail_idempotency_key: String,
    pub assignment_id: String,
    pub expected_revision: u64,
    pub failure_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentAssignmentValidationError {
    EmptyField { field: &'static str },
    NumberMustBePositive { field: &'static str },
    CollectionMustNotBeEmpty { field: &'static str },
    InvalidSha256 { field: &'static str },
    NonCanonicalCollection { field: &'static str },
    InvalidState,
}

impl std::fmt::Display for AgentAssignmentValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyField { field } => write!(formatter, "{field} must not be empty"),
            Self::NumberMustBePositive { field } => write!(formatter, "{field} must be positive"),
            Self::CollectionMustNotBeEmpty { field } => {
                write!(formatter, "{field} must not be empty")
            }
            Self::InvalidSha256 { field } => {
                write!(formatter, "{field} must be a lowercase SHA-256")
            }
            Self::NonCanonicalCollection { field } => {
                write!(formatter, "{field} must be sorted and unique")
            }
            Self::InvalidState => write!(formatter, "assignment snapshot state is inconsistent"),
        }
    }
}

impl std::error::Error for AgentAssignmentValidationError {}

impl AssignmentScope {
    fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_canonical("scope.resourceIds", &self.resource_ids)?;
        assignment_require_sha256("scope.scopeSha256", &self.scope_sha256)
    }
}

impl AssignmentDefinition {
    fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_text("boundedObjective", &self.bounded_objective)?;
        assignment_require_text("sourceCheckpointId", &self.source_checkpoint_id)?;
        assignment_require_text("expectedArtifact", &self.expected_artifact)?;
        assignment_require_canonical("capabilities", &self.capabilities)
    }
}

impl AssignmentCompletionEvidence {
    fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_text("evidence.kind", &self.kind)?;
        assignment_require_text("evidence.reference", &self.reference)?;
        assignment_require_sha256("evidence.sha256", &self.sha256)
    }
}

impl AgentAssignmentSnapshot {
    pub fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        for (field, value) in [
            ("assignmentId", self.assignment_id.as_str()),
            ("workspaceId", self.workspace_id.as_str()),
            ("projectId", self.project_id.as_str()),
            ("planStepId", self.plan_step_id.as_str()),
            ("parentRunId", self.parent_run_id.as_str()),
            ("parentInvocationId", self.parent_invocation_id.as_str()),
            ("childProfileId", self.child_profile_id.as_str()),
        ] {
            assignment_require_text(field, value)?;
        }
        assignment_validate_reference("goal", &self.goal)?;
        assignment_validate_reference("plan", &self.plan)?;
        self.scope.validate()?;
        self.definition.validate()?;
        if let Some(child_run_id) = &self.child_run_id {
            assignment_require_text("childRunId", child_run_id)?;
        }
        if let Some(spec) = &self.child_run_spec {
            spec.validate()?;
            if self.child_run_id.as_deref() != Some(spec.child_run_id.as_str()) {
                return Err(AgentAssignmentValidationError::InvalidState);
            }
        }
        for evidence in &self.completion_evidence {
            evidence.validate()?;
        }
        if let Some(failure_code) = &self.failure_code {
            assignment_require_text("failureCode", failure_code)?;
        }
        let state_valid = match self.status {
            AgentAssignmentStatus::Allocated => {
                self.child_run_id.is_none()
                    && self.completion_evidence.is_empty()
                    && self.failure_code.is_none()
            }
            AgentAssignmentStatus::Running => {
                self.child_run_id.is_some()
                    && self.completion_evidence.is_empty()
                    && self.failure_code.is_none()
            }
            AgentAssignmentStatus::CancelRequested | AgentAssignmentStatus::Cancelled => {
                self.completion_evidence.is_empty() && self.failure_code.is_none()
            }
            AgentAssignmentStatus::Completed => {
                self.child_run_id.is_some()
                    && !self.completion_evidence.is_empty()
                    && self.failure_code.is_none()
            }
            AgentAssignmentStatus::Failed => {
                self.child_run_id.is_some()
                    && self.completion_evidence.is_empty()
                    && self.failure_code.is_some()
            }
        };
        if !state_valid {
            return Err(AgentAssignmentValidationError::InvalidState);
        }
        assignment_require_positive("revision", self.revision)?;
        assignment_require_sha256("lastEventHash", &self.last_event_hash)
    }
}

impl AgentAssignmentCreate {
    pub fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_text("createIdempotencyKey", &self.create_idempotency_key)?;
        assignment_require_text("assignmentId", &self.assignment_id)?;
        assignment_validate_reference("goal", &self.goal)?;
        assignment_validate_reference("plan", &self.plan)?;
        assignment_require_text("planStepId", &self.plan_step_id)?;
        assignment_require_text("parentRunId", &self.parent_run_id)?;
        assignment_require_text("parentInvocationId", &self.parent_invocation_id)?;
        assignment_require_text("childProfileId", &self.child_profile_id)?;
        self.scope.validate()?;
        self.definition.validate()
    }
}

impl AgentAssignmentGet {
    pub fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_text("assignmentId", &self.assignment_id)
    }
}

impl AgentAssignmentStart {
    pub fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_text("startIdempotencyKey", &self.start_idempotency_key)?;
        assignment_require_text("assignmentId", &self.assignment_id)?;
        assignment_require_positive("expectedRevision", self.expected_revision)?;
        self.child_run_spec.validate()
    }
}

impl ChildRunSpec {
    pub fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_text("childRunSpec.childRunId", &self.child_run_id)?;
        assignment_require_text(
            "childRunSpec.runStartIdempotencyKey",
            &self.run_start_idempotency_key,
        )?;
        assignment_require_sha256(
            "childRunSpec.pinnedIdentitySha256",
            &self.pinned_identity_sha256,
        )?;
        let actual = child_run_pinned_identity_sha256(&self.pinned_identity)
            .map_err(|_| AgentAssignmentValidationError::InvalidState)?;
        if actual != self.pinned_identity_sha256 {
            return Err(AgentAssignmentValidationError::InvalidState);
        }
        Ok(())
    }
}

impl AssignmentChildProvisionSagaIdentity {
    pub fn derive(
        workspace_id: &str,
        assignment_id: &str,
        allocation_revision: u64,
        allocation_sha256: &str,
        child_run_spec: &ChildRunSpec,
    ) -> Result<Self, AgentAssignmentValidationError> {
        assignment_require_text("workspaceId", workspace_id)?;
        assignment_require_text("assignmentId", assignment_id)?;
        assignment_require_positive("allocationRevision", allocation_revision)?;
        assignment_require_sha256("allocationSha256", allocation_sha256)?;
        child_run_spec.validate()?;
        let child_run_spec_sha256 = child_run_spec_sha256(child_run_spec)
            .map_err(|_| AgentAssignmentValidationError::InvalidState)?;
        let operation_version = ASSIGNMENT_CHILD_PROVISION_OPERATION_VERSION.to_owned();
        let mut value = Self {
            workspace_id: workspace_id.to_owned(),
            assignment_id: assignment_id.to_owned(),
            allocation_revision,
            allocation_sha256: allocation_sha256.to_owned(),
            child_run_id: child_run_spec.child_run_id.clone(),
            child_run_spec_sha256,
            operation_version,
            operation_id: String::new(),
        };
        value.operation_id = value.expected_operation_id()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_text("workspaceId", &self.workspace_id)?;
        assignment_require_text("assignmentId", &self.assignment_id)?;
        assignment_require_positive("allocationRevision", self.allocation_revision)?;
        assignment_require_sha256("allocationSha256", &self.allocation_sha256)?;
        assignment_require_text("childRunId", &self.child_run_id)?;
        assignment_require_sha256("childRunSpecSha256", &self.child_run_spec_sha256)?;
        if self.operation_version != ASSIGNMENT_CHILD_PROVISION_OPERATION_VERSION {
            return Err(AgentAssignmentValidationError::InvalidState);
        }
        assignment_require_sha256("operationId", &self.operation_id)?;
        if self.operation_id != self.expected_operation_id()? {
            return Err(AgentAssignmentValidationError::InvalidState);
        }
        Ok(())
    }

    pub fn create_idempotency_key(&self) -> String {
        self.idempotency_key("child-run:create")
    }

    pub fn prepare_idempotency_key(&self) -> String {
        self.idempotency_key("child-run:prepare")
    }

    pub fn cancel_idempotency_key(&self) -> String {
        self.idempotency_key("cancel")
    }

    pub fn terminal_idempotency_key(
        &self,
        child_terminal_event_sha256: &str,
    ) -> Result<String, AgentAssignmentValidationError> {
        assignment_require_sha256("childTerminalEventSha256", child_terminal_event_sha256)?;
        Ok(self.idempotency_key(&format!("terminal:{child_terminal_event_sha256}")))
    }

    fn idempotency_key(&self, suffix: &str) -> String {
        format!(
            "assignment:{}:{}:{suffix}",
            self.assignment_id, self.allocation_sha256
        )
    }

    fn expected_operation_id(&self) -> Result<String, AgentAssignmentValidationError> {
        let operation_material = serde_json::json!({
            "workspaceId": self.workspace_id,
            "assignmentId": self.assignment_id,
            "allocationRevision": self.allocation_revision,
            "allocationSha256": self.allocation_sha256,
            "childRunId": self.child_run_id,
            "childRunSpecSha256": self.child_run_spec_sha256,
            "operationVersion": self.operation_version,
        });
        let canonical = serde_json::to_vec(&canonicalize_json(operation_material))
            .map_err(|_| AgentAssignmentValidationError::InvalidState)?;
        Ok(format!("{:x}", Sha256::digest(canonical)))
    }
}

impl AssignmentChildProvisionIntent {
    pub fn derive(
        workspace_id: &str,
        assignment_id: &str,
        allocation_revision: u64,
        allocation_sha256: &str,
        child_run_spec: &ChildRunSpec,
    ) -> Result<Self, AgentAssignmentValidationError> {
        let saga = AssignmentChildProvisionSagaIdentity::derive(
            workspace_id,
            assignment_id,
            allocation_revision,
            allocation_sha256,
            child_run_spec,
        )?;
        Ok(Self {
            create_idempotency_key: saga.create_idempotency_key(),
            prepare_idempotency_key: saga.prepare_idempotency_key(),
            cancel_idempotency_key: saga.cancel_idempotency_key(),
            saga,
        })
    }

    pub fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        self.saga.validate()?;
        if self.create_idempotency_key != self.saga.create_idempotency_key()
            || self.prepare_idempotency_key != self.saga.prepare_idempotency_key()
            || self.cancel_idempotency_key != self.saga.cancel_idempotency_key()
        {
            return Err(AgentAssignmentValidationError::InvalidState);
        }
        Ok(())
    }
}

pub fn child_run_spec_sha256(spec: &ChildRunSpec) -> Result<String, serde_json::Error> {
    let value = serde_json::to_value(spec)?;
    let canonical = serde_json::to_vec(&canonicalize_json(value))?;
    Ok(format!("{:x}", Sha256::digest(canonical)))
}

pub fn child_run_pinned_identity_sha256(
    identity: &RunPinnedIdentity,
) -> Result<String, serde_json::Error> {
    let value = serde_json::to_value(identity)?;
    let canonical = serde_json::to_vec(&canonicalize_json(value))?;
    Ok(format!("{:x}", Sha256::digest(canonical)))
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
        Value::Object(values) => {
            let mut entries = values.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            let mut canonical = serde_json::Map::new();
            for (key, value) in entries {
                canonical.insert(key, canonicalize_json(value));
            }
            Value::Object(canonical)
        }
        scalar => scalar,
    }
}

impl AgentAssignmentRequestCancel {
    pub fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_text("cancelIdempotencyKey", &self.cancel_idempotency_key)?;
        assignment_require_text("assignmentId", &self.assignment_id)?;
        assignment_require_positive("expectedRevision", self.expected_revision)
    }
}

impl AgentAssignmentConfirmCancelled {
    pub fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_text("confirmIdempotencyKey", &self.confirm_idempotency_key)?;
        assignment_require_text("assignmentId", &self.assignment_id)?;
        assignment_require_positive("expectedRevision", self.expected_revision)
    }
}

impl AgentAssignmentComplete {
    pub fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_text("completeIdempotencyKey", &self.complete_idempotency_key)?;
        assignment_require_text("assignmentId", &self.assignment_id)?;
        assignment_require_positive("expectedRevision", self.expected_revision)?;
        if self.evidence.is_empty() {
            return Err(AgentAssignmentValidationError::CollectionMustNotBeEmpty {
                field: "evidence",
            });
        }
        for evidence in &self.evidence {
            evidence.validate()?;
        }
        Ok(())
    }
}

impl AgentAssignmentFail {
    pub fn validate(&self) -> Result<(), AgentAssignmentValidationError> {
        assignment_require_text("failIdempotencyKey", &self.fail_idempotency_key)?;
        assignment_require_text("assignmentId", &self.assignment_id)?;
        assignment_require_positive("expectedRevision", self.expected_revision)?;
        assignment_require_text("failureCode", &self.failure_code)
    }
}

fn assignment_validate_reference(
    field: &'static str,
    value: &RevisionReference,
) -> Result<(), AgentAssignmentValidationError> {
    assignment_require_text(field, &value.id)?;
    assignment_require_positive(field, value.revision)?;
    assignment_require_sha256(
        field,
        value
            .sha256
            .as_deref()
            .ok_or(AgentAssignmentValidationError::EmptyField { field })?,
    )
}

fn assignment_require_text(
    field: &'static str,
    value: &str,
) -> Result<(), AgentAssignmentValidationError> {
    if value.trim().is_empty() {
        Err(AgentAssignmentValidationError::EmptyField { field })
    } else {
        Ok(())
    }
}

fn assignment_require_positive(
    field: &'static str,
    value: u64,
) -> Result<(), AgentAssignmentValidationError> {
    if value == 0 {
        Err(AgentAssignmentValidationError::NumberMustBePositive { field })
    } else {
        Ok(())
    }
}

fn assignment_require_sha256(
    field: &'static str,
    value: &str,
) -> Result<(), AgentAssignmentValidationError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(AgentAssignmentValidationError::InvalidSha256 { field })
    }
}

fn assignment_require_canonical(
    field: &'static str,
    values: &[String],
) -> Result<(), AgentAssignmentValidationError> {
    if values.is_empty() {
        return Err(AgentAssignmentValidationError::CollectionMustNotBeEmpty { field });
    }
    let mut previous: Option<&str> = None;
    for value in values {
        assignment_require_text(field, value)?;
        if previous.is_some_and(|item| item >= value.as_str()) {
            return Err(AgentAssignmentValidationError::NonCanonicalCollection { field });
        }
        previous = Some(value);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalPlanValidationError {
    EmptyField { field: &'static str },
    NumberMustBePositive { field: &'static str },
    CollectionMustNotBeEmpty { field: &'static str },
    InvalidSha256 { field: &'static str },
    SatisfiedCriterionNeedsEvidence { criterion_id: String },
    DuplicateIdentifier { field: &'static str, value: String },
    InvalidPlanStepState { step_id: String },
}

impl std::fmt::Display for GoalPlanValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyField { field } => write!(formatter, "{field} must not be empty"),
            Self::NumberMustBePositive { field } => write!(formatter, "{field} must be positive"),
            Self::CollectionMustNotBeEmpty { field } => {
                write!(formatter, "{field} must not be empty")
            }
            Self::InvalidSha256 { field } => {
                write!(formatter, "{field} must be a lowercase SHA-256")
            }
            Self::SatisfiedCriterionNeedsEvidence { criterion_id } => write!(
                formatter,
                "satisfied criterion {criterion_id} requires evidence"
            ),
            Self::DuplicateIdentifier { field, value } => {
                write!(formatter, "duplicate {field}: {value}")
            }
            Self::InvalidPlanStepState { step_id } => write!(
                formatter,
                "plan step {step_id} has an invalid authoring state"
            ),
        }
    }
}

impl std::error::Error for GoalPlanValidationError {}

impl RevisionReference {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("id", &self.id)?;
        gp_require_positive("revision", self.revision)?;
        let sha256 = self
            .sha256
            .as_deref()
            .ok_or(GoalPlanValidationError::EmptyField { field: "sha256" })?;
        gp_require_sha256("sha256", sha256)
    }

    pub fn validate_legacy_replay(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("id", &self.id)?;
        gp_require_positive("revision", self.revision)?;
        if let Some(sha256) = self.sha256.as_deref() {
            gp_require_sha256("sha256", sha256)?;
        }
        Ok(())
    }
}

impl GoalEvidenceReference {
    fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("evidence.kind", &self.kind)?;
        gp_require_text("evidence.reference", &self.reference)?;
        gp_require_text("evidence.description", &self.description)
    }
}

impl GoalDefinition {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("objective", &self.objective)?;
        self.scope.validate()?;
        gp_require_nonempty("acceptanceCriteria", &self.acceptance_criteria)?;
        let mut criterion_ids = std::collections::BTreeSet::new();
        for criterion in &self.acceptance_criteria {
            gp_require_text("criterionId", &criterion.criterion_id)?;
            gp_require_text("criterion.description", &criterion.description)?;
            if !criterion_ids.insert(criterion.criterion_id.as_str()) {
                return Err(GoalPlanValidationError::DuplicateIdentifier {
                    field: "criterionId",
                    value: criterion.criterion_id.clone(),
                });
            }
            gp_validate_goal_evidence(&criterion.evidence_refs)?;
            if criterion.satisfied && criterion.evidence_refs.is_empty() {
                return Err(GoalPlanValidationError::SatisfiedCriterionNeedsEvidence {
                    criterion_id: criterion.criterion_id.clone(),
                });
            }
        }
        for constraint in &self.constraints {
            gp_require_text("constraint", constraint)?;
        }
        Ok(())
    }
}

impl GoalScope {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_nonempty("scope.resourceIds", &self.resource_ids)?;
        let mut previous: Option<&str> = None;
        for resource_id in &self.resource_ids {
            gp_require_text("scope.resourceId", resource_id)?;
            if previous.is_some_and(|value| value >= resource_id.as_str()) {
                return Err(GoalPlanValidationError::DuplicateIdentifier {
                    field: "scope.resourceIds",
                    value: resource_id.clone(),
                });
            }
            previous = Some(resource_id);
        }
        gp_require_sha256("scope.scopeSha256", &self.scope_sha256)
    }
}

impl GoalSnapshot {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        for (field, value) in [
            ("identity.workspaceId", &self.identity.workspace_id),
            ("identity.projectId", &self.identity.project_id),
            ("identity.sessionId", &self.identity.session_id),
            ("identity.goalId", &self.identity.goal_id),
            ("identity.ownerAgentId", &self.identity.owner_agent_id),
        ] {
            gp_require_text(field, value)?;
        }
        self.definition.validate()?;
        gp_require_positive("definitionRevision", self.definition_revision)?;
        gp_require_positive("revision", self.revision)?;
        gp_validate_goal_evidence(&self.evidence_refs)?;
        for blocker in &self.blockers {
            gp_require_text("blockerId", &blocker.blocker_id)?;
            gp_require_text("blocker.description", &blocker.description)?;
            gp_validate_goal_evidence(&blocker.evidence_refs)?;
        }
        gp_require_sha256("lastEventHash", &self.last_event_hash)
    }
}

impl GoalCreate {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("createIdempotencyKey", &self.create_idempotency_key)?;
        gp_require_text("goalId", &self.goal_id)?;
        gp_require_text("sessionId", &self.session_id)?;
        gp_require_text("ownerAgentId", &self.owner_agent_id)?;
        self.definition.validate()
    }
}

impl GoalGet {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("goalId", &self.goal_id)?;
        if let Some(revision) = self.revision {
            gp_require_positive("revision", revision)?;
        }
        Ok(())
    }
}

impl GoalRevise {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("reviseIdempotencyKey", &self.revise_idempotency_key)?;
        gp_require_text("goalId", &self.goal_id)?;
        gp_require_positive("expectedRevision", self.expected_revision)?;
        self.definition.validate()
    }
}

impl GoalCompletionPropose {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("proposeIdempotencyKey", &self.propose_idempotency_key)?;
        gp_require_text("goalId", &self.goal_id)?;
        gp_require_positive("expectedRevision", self.expected_revision)?;
        gp_require_nonempty("evidenceRefs", &self.evidence_refs)?;
        gp_validate_goal_evidence(&self.evidence_refs)
    }
}

impl GoalComplete {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("completeIdempotencyKey", &self.complete_idempotency_key)?;
        gp_require_text("goalId", &self.goal_id)?;
        gp_require_positive("expectedRevision", self.expected_revision)?;
        gp_require_nonempty("evidenceRefs", &self.evidence_refs)?;
        gp_validate_goal_evidence(&self.evidence_refs)
    }
}

impl PlanEvidence {
    fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("evidenceType", &self.evidence_type)?;
        gp_require_text("referenceId", &self.reference_id)?;
        gp_require_sha256("evidence.sha256", &self.sha256)
    }
}

impl PlanRevision {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_positive("revision", self.revision)?;
        gp_require_positive("goalRevision", self.goal_revision)?;
        gp_validate_plan_steps(&self.steps, false)?;
        if let Some(previous) = &self.previous_revision_sha256 {
            gp_require_sha256("previousRevisionSha256", previous)?;
        }
        gp_require_sha256("revisionSha256", &self.revision_sha256)?;
        gp_require_text("createdAt", &self.created_at)
    }
}

impl PlanSnapshot {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("workspaceId", &self.workspace_id)?;
        gp_require_text("planId", &self.plan_id)?;
        gp_require_text("goalId", &self.goal_id)?;
        self.current_revision.validate()?;
        gp_require_positive("lastStreamSequence", self.last_stream_sequence)
    }
}

impl PlanCreate {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("createIdempotencyKey", &self.create_idempotency_key)?;
        gp_require_text("planId", &self.plan_id)?;
        gp_require_text("goalId", &self.goal_id)?;
        gp_require_positive("goalRevision", self.goal_revision)?;
        gp_validate_plan_steps(&self.steps, true)
    }
}

impl PlanGet {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("planId", &self.plan_id)?;
        if let Some(revision) = self.revision {
            gp_require_positive("revision", revision)?;
        }
        Ok(())
    }
}

impl PlanRevise {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("reviseIdempotencyKey", &self.revise_idempotency_key)?;
        gp_require_text("planId", &self.plan_id)?;
        gp_require_positive("expectedRevision", self.expected_revision)?;
        gp_require_positive("goalRevision", self.goal_revision)?;
        gp_validate_plan_steps(&self.steps, true)
    }
}

impl PlanStepStart {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("startIdempotencyKey", &self.start_idempotency_key)?;
        gp_require_text("planId", &self.plan_id)?;
        gp_require_positive("expectedRevision", self.expected_revision)?;
        gp_require_text("stepId", &self.step_id)
    }
}

impl PlanStepComplete {
    pub fn validate(&self) -> Result<(), GoalPlanValidationError> {
        gp_require_text("completeIdempotencyKey", &self.complete_idempotency_key)?;
        gp_require_text("planId", &self.plan_id)?;
        gp_require_positive("expectedRevision", self.expected_revision)?;
        gp_require_text("stepId", &self.step_id)?;
        gp_require_nonempty("evidence", &self.evidence)?;
        for item in &self.evidence {
            item.validate()?;
        }
        Ok(())
    }
}

fn gp_validate_goal_evidence(
    evidence: &[GoalEvidenceReference],
) -> Result<(), GoalPlanValidationError> {
    for item in evidence {
        item.validate()?;
    }
    Ok(())
}

fn gp_validate_plan_steps(
    steps: &[PlanStep],
    authoring: bool,
) -> Result<(), GoalPlanValidationError> {
    gp_require_nonempty("steps", steps)?;
    let mut ids = std::collections::BTreeSet::new();
    for step in steps {
        gp_require_text("stepId", &step.step_id)?;
        gp_require_text("step.purpose", &step.purpose)?;
        gp_require_text("expectedArtifact", &step.expected_artifact)?;
        gp_require_nonempty("capabilities", &step.capabilities)?;
        gp_require_nonempty("requiredEvidence", &step.required_evidence)?;
        for value in step.capabilities.iter().chain(&step.required_evidence) {
            gp_require_text("step.listItem", value)?;
        }
        if let Some(agent) = &step.assigned_agent {
            gp_require_text("assignedAgent", agent)?;
        }
        if !ids.insert(step.step_id.as_str()) {
            return Err(GoalPlanValidationError::DuplicateIdentifier {
                field: "stepId",
                value: step.step_id.clone(),
            });
        }
        if authoring
            && (step.status != PlanStepStatus::Pending || !step.completion_evidence.is_empty())
        {
            return Err(GoalPlanValidationError::InvalidPlanStepState {
                step_id: step.step_id.clone(),
            });
        }
        for evidence in &step.completion_evidence {
            evidence.validate()?;
        }
    }
    for (index, step) in steps.iter().enumerate() {
        let mut dependencies = std::collections::BTreeSet::new();
        for dependency in &step.dependencies {
            gp_require_text("dependency", dependency)?;
            if !dependencies.insert(dependency.as_str())
                || !steps[..index]
                    .iter()
                    .any(|candidate| candidate.step_id == *dependency)
            {
                return Err(GoalPlanValidationError::DuplicateIdentifier {
                    field: "dependency",
                    value: dependency.clone(),
                });
            }
        }
    }
    Ok(())
}

fn gp_require_text(field: &'static str, value: &str) -> Result<(), GoalPlanValidationError> {
    if value.trim().is_empty() {
        Err(GoalPlanValidationError::EmptyField { field })
    } else {
        Ok(())
    }
}

fn gp_require_positive(field: &'static str, value: u64) -> Result<(), GoalPlanValidationError> {
    if value == 0 {
        Err(GoalPlanValidationError::NumberMustBePositive { field })
    } else {
        Ok(())
    }
}

fn gp_require_nonempty<T>(
    field: &'static str,
    values: &[T],
) -> Result<(), GoalPlanValidationError> {
    if values.is_empty() {
        Err(GoalPlanValidationError::CollectionMustNotBeEmpty { field })
    } else {
        Ok(())
    }
}

fn gp_require_sha256(field: &'static str, value: &str) -> Result<(), GoalPlanValidationError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(GoalPlanValidationError::InvalidSha256 { field })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionedPolicyIdentity {
    pub id: String,
    pub version: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRunIdentity {
    pub profile_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub config_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunPinnedIdentity {
    pub project_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub session_branch_id: String,
    pub user_message_id: String,
    pub project_branch_id: String,
    pub goal: Option<RevisionReference>,
    pub plan: Option<RevisionReference>,
    #[serde(default)]
    pub assignment: Option<RevisionReference>,
    #[serde(default)]
    pub parent_run_id: Option<String>,
    #[serde(default)]
    pub delegation_depth: u32,
    pub provider: ProviderRunIdentity,
    pub prompt_bundle: VersionedPolicyIdentity,
    pub agent_profile: VersionedPolicyIdentity,
    pub tool_policy: VersionedPolicyIdentity,
    pub context_policy: VersionedPolicyIdentity,
    pub runtime_policy: VersionedPolicyIdentity,
    pub runtime_contract_version: String,
    pub mode: RunPermissionMode,
    pub source_checkpoint_id: String,
    pub scope_resource_ids: Vec<String>,
    pub resource_scope_sha256: String,
    pub user_input_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunStart {
    pub start_idempotency_key: String,
    pub pinned_identity: RunPinnedIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunCancel {
    pub cancel_idempotency_key: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunPrepare {
    pub prepare_idempotency_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunReconciliationDecision {
    CancelRun,
    RetryAsNewAttemptAcknowledgingDuplicate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunReconcile {
    pub reconciliation_idempotency_key: String,
    pub attempt_id: Uuid,
    pub decision: RunReconciliationDecision,
    pub duplicate_execution_acknowledged: bool,
}

impl RunReconcile {
    pub fn validate(&self) -> Result<(), RunReconcileValidationError> {
        if self.reconciliation_idempotency_key.trim().is_empty() {
            return Err(RunReconcileValidationError::EmptyIdempotencyKey);
        }
        let required = matches!(
            self.decision,
            RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate
        );
        if self.duplicate_execution_acknowledged != required {
            return Err(RunReconcileValidationError::DuplicateAcknowledgementMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunReconcileValidationError {
    EmptyIdempotencyKey,
    DuplicateAcknowledgementMismatch,
}

impl std::fmt::Display for RunReconcileValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyIdempotencyKey => {
                write!(formatter, "reconciliationIdempotencyKey must not be empty")
            }
            Self::DuplicateAcknowledgementMismatch => write!(
                formatter,
                "duplicateExecutionAcknowledged must be true only for retry_as_new_attempt_acknowledging_duplicate"
            ),
        }
    }
}

impl std::error::Error for RunReconcileValidationError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunReconciliationReceipt {
    pub attempt_id: Uuid,
    pub decision: RunReconciliationDecision,
    pub state: RunLifecycleState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunLifecycleState {
    Created,
    Preparing,
    Running,
    WaitingForApproval,
    WaitingForReconciliation,
    Committing,
    Retrying,
    Blocked,
    Cancelled,
    Failed,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunRecoveryClassification {
    Resumable,
    WaitingForApproval,
    WaitingForReconciliation,
    CommitUncertain,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSnapshot {
    pub run_id: Uuid,
    pub pinned_identity: RunPinnedIdentity,
    pub state: RunLifecycleState,
    pub recovery_classification: RunRecoveryClassification,
    pub run_sequence: u64,
    pub aggregate_sequence: u64,
    pub created_at: String,
    pub updated_at: String,
    pub terminal_error: Option<RuntimeError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextDisclosure {
    Public,
    ProjectPrivate,
    AgentInternal,
    PlayerHidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextMessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextRuntimeExchangeKind {
    UserMessage,
    AssistantMessage,
    ToolCall,
    ToolResult,
    Correction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSourceKind {
    Document,
    GraphAssertion,
    TaskMemory,
    ProjectFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ContextItem {
    SystemPrompt {
        item_id: String,
        content: String,
        content_sha256: String,
        disclosure: ContextDisclosure,
        required: bool,
    },
    ToolProtocol {
        item_id: String,
        tool_name: String,
        schema_version: u32,
        protocol: Value,
        content_sha256: String,
        disclosure: ContextDisclosure,
        required: bool,
    },
    SessionMessage {
        item_id: String,
        message_id: String,
        role: ContextMessageRole,
        content: String,
        content_sha256: String,
        created_at: String,
        disclosure: ContextDisclosure,
        required: bool,
    },
    RetrievalSource {
        item_id: String,
        source_receipt_id: String,
        source_kind: ContextSourceKind,
        stable_version_id: String,
        content: String,
        content_sha256: String,
        complete: bool,
        disclosure: ContextDisclosure,
        required: bool,
    },
    RuntimeExchange {
        item_id: String,
        exchange_id: String,
        kind: ContextRuntimeExchangeKind,
        content: Value,
        content_sha256: String,
        disclosure: ContextDisclosure,
        required: bool,
    },
    OutputReserve {
        item_id: String,
        requested_tokens: u64,
        policy_id: String,
        disclosure: ContextDisclosure,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenizerKind {
    ProviderExact,
    KnownModel,
    FallbackEstimate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenizerIdentity {
    pub kind: TokenizerKind,
    pub id: String,
    pub version: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextBudgetCategory {
    SystemPrompt,
    ToolProtocol,
    SessionHistory,
    Collaboration,
    Retrieval,
    RuntimeConversation,
    OutputReserve,
    SafetyReserve,
    AccountingOverhead,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextBudgetAllocation {
    pub category: ContextBudgetCategory,
    pub estimated_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompile {
    pub compile_idempotency_key: String,
    pub invocation_id: String,
    pub request_number: u64,
    pub provider: ProviderRunIdentity,
    pub context_policy: VersionedPolicyIdentity,
    pub compiler_version: String,
    pub context_window: u64,
    pub configured_max_output_tokens: Option<u64>,
    pub safety_reserve_tokens: u64,
    pub items: Vec<ContextItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextRepresentation {
    NormalizedMessages,
    PiContextJson,
    OpenAiChatCompletions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompilationReceipt {
    pub compilation_id: Uuid,
    pub request_number: u64,
    pub compiler_version: String,
    pub tokenizer: TokenizerIdentity,
    pub representation: ContextRepresentation,
    pub canonical_context_sha256: String,
    pub serialized_input_bytes: u64,
    pub estimated_input_tokens: u64,
    pub exact_input_tokens: Option<u64>,
    pub context_window: u64,
    pub safety_reserve_tokens: u64,
    pub output_reserve_tokens: u64,
    pub available_input_tokens: u64,
    pub accepted: bool,
    pub budget: Vec<ContextBudgetAllocation>,
    pub included_item_ids: Vec<String>,
    pub omitted_item_ids: Vec<String>,
    pub incomplete: bool,
    pub disclosure: ContextDisclosure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeErrorClass {
    Protocol,
    ProviderAuth,
    ProviderRateLimit,
    ProviderTimeout,
    ProviderRejected,
    ContextCapacity,
    ToolArguments,
    ToolPermission,
    ToolExecution,
    SourceConflict,
    StaleVersion,
    Storage,
    RuntimeCrash,
    Cancelled,
    Validation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeError {
    pub code: String,
    pub class: RuntimeErrorClass,
    pub retryable: bool,
    pub public_message: String,
    pub stage: String,
    pub attempt: u64,
    pub diagnostic_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceStart {
    pub inference_id: Uuid,
    pub attempt_id: Uuid,
    pub invocation_id: String,
    pub context_compilation_id: Uuid,
    pub request_number: u64,
    pub attempt_number: u64,
    pub inference_idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceIdentity {
    pub run_id: Uuid,
    pub inference_id: Uuid,
    pub attempt_id: Uuid,
    pub context_compilation_id: Uuid,
    pub request_number: u64,
    pub attempt_number: u64,
}

pub type ProviderInferenceAccepted = ProviderInferenceIdentity;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolAuthorizationEvidenceReference {
    pub tool_call_id: Uuid,
    pub aggregate_sequence: u64,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceContinuationProposal {
    pub continuation_id: Uuid,
    pub run_id: Uuid,
    pub invocation_id: String,
    pub parent_inference_identity: ProviderInferenceIdentity,
    pub continuation_inference_identity: ProviderInferenceIdentity,
    pub continuation_identity_sha256: String,
    pub triggering_tool_call_ids: Vec<Uuid>,
    pub authorization_evidence: Vec<ToolAuthorizationEvidenceReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceContinuationAcknowledge {
    pub continuation_id: Uuid,
    pub continuation_identity_sha256: String,
    pub parent_inference_identity: ProviderInferenceIdentity,
    pub authorization_evidence: Vec<ToolAuthorizationEvidenceReference>,
}

pub type ProviderInferenceContinuationAccepted = ProviderInferenceContinuationProposal;

pub fn provider_inference_identity_sha256(
    identity: &ProviderInferenceIdentity,
) -> Result<String, serde_json::Error> {
    let value = serde_json::to_value(identity)?;
    let canonical = serde_json::to_vec(&canonicalize_json(value))?;
    Ok(format!("{:x}", Sha256::digest(canonical)))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceOutput {
    pub text: String,
    pub text_sha256: String,
    pub utf8_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    pub arguments_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceCompleted {
    #[serde(flatten)]
    pub identity: ProviderInferenceIdentity,
    pub provider_id: String,
    pub model_id: String,
    pub response_id_sha256: String,
    pub response_body_sha256: String,
    pub stop_reason: String,
    pub usage: ProviderInferenceUsage,
    pub output: Option<ProviderInferenceOutput>,
    #[serde(default)]
    pub tool_calls: Vec<ProviderInferenceToolCall>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceFailed {
    #[serde(flatten)]
    pub identity: ProviderInferenceIdentity,
    pub error: RuntimeError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderInferenceReconciliationReason {
    OutcomeUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceReconciliationRequired {
    #[serde(flatten)]
    pub identity: ProviderInferenceIdentity,
    pub reason: ProviderInferenceReconciliationReason,
    pub error: RuntimeError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolProtocolSideEffect {
    None,
    StagedWrite,
    ExternalEffect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolPermissionDecision {
    Allowed,
    ApprovalRequired,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolArtifactReceipt {
    pub artifact_id: Uuid,
    pub media_type: String,
    pub sha256: String,
    pub utf8_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolSourceScope {
    pub source_checkpoint_id: String,
    pub resource_ids: Vec<String>,
    pub scope_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolPermissionPolicy {
    pub mode: RunPermissionMode,
    pub policy_id: String,
    pub policy_version: String,
    pub policy_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolPermissionLease {
    pub lease_id: Uuid,
    pub tool_call_id: Uuid,
    pub mode: RunPermissionMode,
    pub decision: ToolPermissionDecision,
    pub policy_id: String,
    pub policy_version: String,
    pub policy_sha256: String,
    pub source_scope_sha256: String,
    pub granted_at: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolRequest {
    pub request_idempotency_key: String,
    pub tool_call_id: Uuid,
    pub provider_tool_call_id: String,
    pub invocation_id: String,
    pub tool_name: String,
    pub schema_version: u32,
    pub attempt: u32,
    pub side_effect: ToolProtocolSideEffect,
    pub parallel: bool,
    pub arguments: ToolArtifactReceipt,
    pub source_scope: ToolSourceScope,
    pub permission: ToolPermissionPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolAuthorizationResolutionDecision {
    Approve,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolAuthorizationResolve {
    pub authorization_idempotency_key: String,
    pub tool_call_id: Uuid,
    pub decision: ToolAuthorizationResolutionDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolAuthorizationResolvedStatus {
    Authorized,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolAuthorizationResolved {
    pub tool_call_id: Uuid,
    pub decision: ToolAuthorizationResolutionDecision,
    pub status: ToolAuthorizationResolvedStatus,
    pub lease: Option<ToolPermissionLease>,
}

impl ToolAuthorizationResolved {
    pub fn validate(&self) -> Result<(), ToolProtocolValidationError> {
        match (&self.decision, &self.status, &self.lease) {
            (
                ToolAuthorizationResolutionDecision::Approve,
                ToolAuthorizationResolvedStatus::Authorized,
                Some(lease),
            ) if lease.tool_call_id == self.tool_call_id
                && lease.decision == ToolPermissionDecision::Allowed =>
            {
                Ok(())
            }
            (
                ToolAuthorizationResolutionDecision::Deny,
                ToolAuthorizationResolvedStatus::Denied,
                None,
            ) => Ok(()),
            _ => Err(ToolProtocolValidationError::PermissionModeMismatch),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolEventIdentity {
    pub run_id: Uuid,
    pub tool_call_id: Uuid,
    pub provider_tool_call_id: String,
    pub invocation_id: String,
    pub tool_name: String,
    pub schema_version: u32,
    pub attempt: u32,
    pub side_effect: ToolProtocolSideEffect,
    pub parallel: bool,
    pub arguments_sha256: String,
    pub source_scope_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolRequested {
    #[serde(flatten)]
    pub identity: ToolEventIdentity,
    pub permission: ToolPermissionPolicy,
    pub authorization: ToolPermissionDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolAuthorized {
    #[serde(flatten)]
    pub identity: ToolEventIdentity,
    pub lease: ToolPermissionLease,
}

pub type ToolRunning = ToolAuthorized;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolSucceeded {
    #[serde(flatten)]
    pub identity: ToolEventIdentity,
    pub lease_id: Uuid,
    pub result: ToolArtifactReceipt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolFailed {
    #[serde(flatten)]
    pub identity: ToolEventIdentity,
    pub lease_id: Option<Uuid>,
    pub error: RuntimeError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolOutcomeUnknown {
    #[serde(flatten)]
    pub identity: ToolEventIdentity,
    pub lease_id: Uuid,
    pub error: RuntimeError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolProtocolValidationError {
    InvalidField(&'static str),
    SourceScopeNotCanonical,
    PermissionModeMismatch,
    LeaseIdentityMismatch,
    OutcomeUnknownCannotRetry,
}

impl std::fmt::Display for ToolProtocolValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "invalid ToolCall protocol payload: {self:?}")
    }
}
impl std::error::Error for ToolProtocolValidationError {}

impl ToolRequest {
    pub fn validate(&self) -> Result<(), ToolProtocolValidationError> {
        for (field, value) in [
            (
                "requestIdempotencyKey",
                self.request_idempotency_key.as_str(),
            ),
            ("invocationId", self.invocation_id.as_str()),
            ("providerToolCallId", self.provider_tool_call_id.as_str()),
            ("toolName", self.tool_name.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(ToolProtocolValidationError::InvalidField(field));
            }
        }
        if self.schema_version == 0 || self.attempt == 0 {
            return Err(ToolProtocolValidationError::InvalidField(
                "schemaVersion/attempt",
            ));
        }
        validate_tool_artifact(&self.arguments)?;
        validate_tool_scope(&self.source_scope)?;
        validate_tool_policy(&self.permission)
    }
}

impl ToolPermissionLease {
    pub fn validate_for(
        &self,
        identity: &ToolEventIdentity,
    ) -> Result<(), ToolProtocolValidationError> {
        if self.tool_call_id != identity.tool_call_id
            || self.source_scope_sha256 != identity.source_scope_sha256
        {
            return Err(ToolProtocolValidationError::LeaseIdentityMismatch);
        }
        if self.decision != ToolPermissionDecision::Allowed {
            return Err(ToolProtocolValidationError::InvalidField("decision"));
        }
        require_sha256("policySha256", &self.policy_sha256)
            .map_err(|_| ToolProtocolValidationError::InvalidField("policySha256"))?;
        Ok(())
    }
}

impl ToolRequested {
    pub fn validate(&self) -> Result<(), ToolProtocolValidationError> {
        validate_tool_event_identity(&self.identity)?;
        validate_tool_policy(&self.permission)?;
        let expected = match self.permission.mode {
            RunPermissionMode::Free => ToolPermissionDecision::Allowed,
            RunPermissionMode::Assist => ToolPermissionDecision::ApprovalRequired,
        };
        if self.authorization != expected {
            return Err(ToolProtocolValidationError::PermissionModeMismatch);
        }
        Ok(())
    }
}

impl ToolAuthorized {
    pub fn validate(&self) -> Result<(), ToolProtocolValidationError> {
        validate_tool_event_identity(&self.identity)?;
        self.lease.validate_for(&self.identity)
    }
}

impl ToolSucceeded {
    pub fn validate(&self) -> Result<(), ToolProtocolValidationError> {
        validate_tool_event_identity(&self.identity)?;
        validate_tool_artifact(&self.result)
    }
}

impl ToolFailed {
    pub fn validate(&self) -> Result<(), ToolProtocolValidationError> {
        validate_tool_event_identity(&self.identity)
    }
}

impl ToolOutcomeUnknown {
    pub fn validate(&self) -> Result<(), ToolProtocolValidationError> {
        validate_tool_event_identity(&self.identity)?;
        if self.error.retryable {
            return Err(ToolProtocolValidationError::OutcomeUnknownCannotRetry);
        }
        Ok(())
    }
}

fn validate_tool_artifact(value: &ToolArtifactReceipt) -> Result<(), ToolProtocolValidationError> {
    if value.media_type.trim().is_empty() || require_sha256("sha256", &value.sha256).is_err() {
        return Err(ToolProtocolValidationError::InvalidField("artifact"));
    }
    Ok(())
}

fn validate_tool_scope(value: &ToolSourceScope) -> Result<(), ToolProtocolValidationError> {
    if value.source_checkpoint_id.trim().is_empty()
        || value.resource_ids.is_empty()
        || value.resource_ids.iter().any(|item| item.trim().is_empty())
        || value.resource_ids.windows(2).any(|pair| pair[0] >= pair[1])
        || require_sha256("scopeSha256", &value.scope_sha256).is_err()
    {
        return Err(ToolProtocolValidationError::SourceScopeNotCanonical);
    }
    Ok(())
}

fn validate_tool_policy(value: &ToolPermissionPolicy) -> Result<(), ToolProtocolValidationError> {
    if value.policy_id.trim().is_empty()
        || value.policy_version.trim().is_empty()
        || require_sha256("policySha256", &value.policy_sha256).is_err()
    {
        return Err(ToolProtocolValidationError::InvalidField("permission"));
    }
    Ok(())
}

fn validate_tool_event_identity(
    value: &ToolEventIdentity,
) -> Result<(), ToolProtocolValidationError> {
    if value.provider_tool_call_id.trim().is_empty()
        || value.invocation_id.trim().is_empty()
        || value.tool_name.trim().is_empty()
        || value.schema_version == 0
        || value.attempt == 0
        || require_sha256("argumentsSha256", &value.arguments_sha256).is_err()
        || require_sha256("sourceScopeSha256", &value.source_scope_sha256).is_err()
    {
        return Err(ToolProtocolValidationError::InvalidField("identity"));
    }
    Ok(())
}

pub const MAX_PROVIDER_INFERENCE_OUTPUT_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderInferenceValidationError {
    EmptyIdentity { field: &'static str },
    NumberMustBePositive { field: &'static str },
    InvalidSha256 { field: &'static str },
    UsageTotalMismatch,
    OutputEmpty,
    OutputTooLarge { actual: usize, maximum: usize },
    OutputByteLengthMismatch { declared: u64, actual: usize },
    OutputHashMismatch,
    ToolCallInvalid,
    ToolCallDuplicateId,
    ReconciliationCannotBeRetryable,
}

impl std::fmt::Display for ProviderInferenceValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyIdentity { field } => write!(formatter, "{field} must not be empty"),
            Self::NumberMustBePositive { field } => write!(formatter, "{field} must be positive"),
            Self::InvalidSha256 { field } => write!(formatter, "{field} must be lowercase SHA-256"),
            Self::UsageTotalMismatch => write!(
                formatter,
                "totalTokens must equal inputTokens plus outputTokens"
            ),
            Self::OutputEmpty => write!(formatter, "Provider inference output must not be empty"),
            Self::OutputTooLarge { actual, maximum } => write!(
                formatter,
                "Provider inference output is {actual} bytes; maximum is {maximum}"
            ),
            Self::OutputByteLengthMismatch { declared, actual } => write!(
                formatter,
                "declared output byte length {declared} does not match actual length {actual}"
            ),
            Self::OutputHashMismatch => write!(
                formatter,
                "textSha256 does not match Provider inference output"
            ),
            Self::ToolCallInvalid => write!(formatter, "Provider tool call is invalid"),
            Self::ToolCallDuplicateId => write!(formatter, "Provider tool call ids must be unique"),
            Self::ReconciliationCannotBeRetryable => write!(
                formatter,
                "unknown Provider outcomes cannot be automatically retryable"
            ),
        }
    }
}

impl std::error::Error for ProviderInferenceValidationError {}

impl ProviderInferenceStart {
    pub fn validate(&self) -> Result<(), ProviderInferenceValidationError> {
        require_identity("invocationId", &self.invocation_id)?;
        require_identity("inferenceIdempotencyKey", &self.inference_idempotency_key)?;
        require_positive("requestNumber", self.request_number)?;
        require_positive("attemptNumber", self.attempt_number)
    }
}

impl ProviderInferenceIdentity {
    pub fn validate(&self) -> Result<(), ProviderInferenceValidationError> {
        require_positive("requestNumber", self.request_number)?;
        require_positive("attemptNumber", self.attempt_number)
    }
}

impl ProviderInferenceCompleted {
    pub fn validate(&self) -> Result<(), ProviderInferenceValidationError> {
        self.identity.validate()?;
        require_identity("providerId", &self.provider_id)?;
        require_identity("modelId", &self.model_id)?;
        require_identity("stopReason", &self.stop_reason)?;
        require_sha256("responseIdSha256", &self.response_id_sha256)?;
        require_sha256("responseBodySha256", &self.response_body_sha256)?;
        if self
            .usage
            .input_tokens
            .checked_add(self.usage.output_tokens)
            != Some(self.usage.total_tokens)
        {
            return Err(ProviderInferenceValidationError::UsageTotalMismatch);
        }
        if self.output.is_none() && self.tool_calls.is_empty() {
            return Err(ProviderInferenceValidationError::OutputEmpty);
        }
        match self.stop_reason.as_str() {
            "stop" if self.output.is_some() && self.tool_calls.is_empty() => {}
            "tool_calls" if !self.tool_calls.is_empty() => {}
            _ => return Err(ProviderInferenceValidationError::ToolCallInvalid),
        }
        if let Some(output) = &self.output {
            require_sha256("textSha256", &output.text_sha256)?;
            if output.text.is_empty() {
                return Err(ProviderInferenceValidationError::OutputEmpty);
            }
            let actual_bytes = output.text.len();
            if actual_bytes > MAX_PROVIDER_INFERENCE_OUTPUT_BYTES {
                return Err(ProviderInferenceValidationError::OutputTooLarge {
                    actual: actual_bytes,
                    maximum: MAX_PROVIDER_INFERENCE_OUTPUT_BYTES,
                });
            }
            if output.utf8_bytes != actual_bytes as u64 {
                return Err(ProviderInferenceValidationError::OutputByteLengthMismatch {
                    declared: output.utf8_bytes,
                    actual: actual_bytes,
                });
            }
            if lowercase_sha256(output.text.as_bytes()) != output.text_sha256 {
                return Err(ProviderInferenceValidationError::OutputHashMismatch);
            }
        }
        let mut ids = std::collections::BTreeSet::new();
        for call in &self.tool_calls {
            if call.id.trim().is_empty()
                || call.name.trim().is_empty()
                || !call.arguments.is_object()
            {
                return Err(ProviderInferenceValidationError::ToolCallInvalid);
            }
            require_sha256("argumentsSha256", &call.arguments_sha256)?;
            if lowercase_sha256(
                &serde_json::to_vec(&call.arguments)
                    .map_err(|_| ProviderInferenceValidationError::ToolCallInvalid)?,
            ) != call.arguments_sha256
            {
                return Err(ProviderInferenceValidationError::ToolCallInvalid);
            }
            if !ids.insert(call.id.as_str()) {
                return Err(ProviderInferenceValidationError::ToolCallDuplicateId);
            }
        }
        Ok(())
    }
}

impl ProviderInferenceFailed {
    pub fn validate(&self) -> Result<(), ProviderInferenceValidationError> {
        self.identity.validate()
    }
}

impl ProviderInferenceReconciliationRequired {
    pub fn validate(&self) -> Result<(), ProviderInferenceValidationError> {
        self.identity.validate()?;
        if self.error.retryable {
            return Err(ProviderInferenceValidationError::ReconciliationCannotBeRetryable);
        }
        Ok(())
    }
}

fn require_identity(
    field: &'static str,
    value: &str,
) -> Result<(), ProviderInferenceValidationError> {
    if value.trim().is_empty() {
        return Err(ProviderInferenceValidationError::EmptyIdentity { field });
    }
    Ok(())
}

fn require_positive(
    field: &'static str,
    value: u64,
) -> Result<(), ProviderInferenceValidationError> {
    if value == 0 {
        return Err(ProviderInferenceValidationError::NumberMustBePositive { field });
    }
    Ok(())
}

fn require_sha256(
    field: &'static str,
    value: &str,
) -> Result<(), ProviderInferenceValidationError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ProviderInferenceValidationError::InvalidSha256 { field });
    }
    Ok(())
}

fn lowercase_sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_run_identity_hash_has_a_cross_language_canonical_vector() {
        let identity: RunPinnedIdentity = serde_json::from_value(serde_json::json!({
            "projectId": "project-1", "workspaceId": "workspace-1",
            "sessionId": "session-1", "sessionBranchId": "branch-1",
            "userMessageId": "message-1", "projectBranchId": "project-branch-1",
            "goal": { "id": "goal-1", "revision": 1, "sha256": "a".repeat(64) },
            "plan": { "id": "plan-1", "revision": 2, "sha256": "b".repeat(64) },
            "assignment": { "id": "assignment-1", "revision": 1, "sha256": "c".repeat(64) },
            "parentRunId": "parent-1", "delegationDepth": 1,
            "provider": { "profileId": "provider-profile", "providerId": "deepseek", "modelId": "deepseek-chat", "configSha256": "d".repeat(64) },
            "promptBundle": { "id": "prompt", "version": "1", "sha256": "e".repeat(64) },
            "agentProfile": { "id": "checker", "version": "1", "sha256": "f".repeat(64) },
            "toolPolicy": { "id": "tools", "version": "1", "sha256": "1".repeat(64) },
            "contextPolicy": { "id": "context", "version": "1", "sha256": "2".repeat(64) },
            "runtimePolicy": { "id": "runtime", "version": "1", "sha256": "3".repeat(64) },
            "runtimeContractVersion": "2", "mode": "assist",
            "sourceCheckpointId": "checkpoint-1", "scopeResourceIds": ["chapter-1", "world"],
            "resourceScopeSha256": "4".repeat(64), "userInputSha256": "5".repeat(64)
        })).unwrap();
        assert_eq!(
            child_run_pinned_identity_sha256(&identity).unwrap(),
            "569c60cbd64889175a0c84a7fa5d19233e7f49d7a359ba930d67365250a4227e"
        );
    }

    #[test]
    fn assignment_child_provision_saga_is_stable_typed_and_sensitive_to_every_pin() {
        let pinned_identity: RunPinnedIdentity = serde_json::from_value(serde_json::json!({
            "projectId": "project-1", "workspaceId": "workspace-1",
            "sessionId": "session-1", "sessionBranchId": "branch-1",
            "userMessageId": "message-1", "projectBranchId": "project-branch-1",
            "goal": { "id": "goal-1", "revision": 1, "sha256": "a".repeat(64) },
            "plan": { "id": "plan-1", "revision": 2, "sha256": "b".repeat(64) },
            "assignment": { "id": "assignment-1", "revision": 1, "sha256": "c".repeat(64) },
            "parentRunId": "parent-1", "delegationDepth": 1,
            "provider": { "profileId": "provider-profile", "providerId": "deepseek", "modelId": "deepseek-chat", "configSha256": "d".repeat(64) },
            "promptBundle": { "id": "prompt", "version": "1", "sha256": "e".repeat(64) },
            "agentProfile": { "id": "checker", "version": "1", "sha256": "f".repeat(64) },
            "toolPolicy": { "id": "tools", "version": "1", "sha256": "1".repeat(64) },
            "contextPolicy": { "id": "context", "version": "1", "sha256": "2".repeat(64) },
            "runtimePolicy": { "id": "runtime", "version": "1", "sha256": "3".repeat(64) },
            "runtimeContractVersion": "2", "mode": "assist",
            "sourceCheckpointId": "checkpoint-1", "scopeResourceIds": ["chapter-1", "world"],
            "resourceScopeSha256": "4".repeat(64), "userInputSha256": "5".repeat(64)
        })).unwrap();
        let mut spec = ChildRunSpec {
            child_run_id: "child-1".to_owned(),
            run_start_idempotency_key: "child-start-1".to_owned(),
            pinned_identity_sha256: child_run_pinned_identity_sha256(&pinned_identity).unwrap(),
            pinned_identity,
        };
        let first = AssignmentChildProvisionIntent::derive(
            "workspace-1",
            "assignment-1",
            1,
            &"c".repeat(64),
            &spec,
        )
        .unwrap();
        let second = AssignmentChildProvisionIntent::derive(
            "workspace-1",
            "assignment-1",
            1,
            &"c".repeat(64),
            &spec,
        )
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first.saga.operation_version,
            ASSIGNMENT_CHILD_PROVISION_OPERATION_VERSION
        );
        assert_eq!(
            first.saga.operation_id,
            "7a12516041e7c7e5f9aafd2baa22dbbac2d5b3a962c01943dd8756da0178ed95"
        );
        assert_eq!(
            first.saga.child_run_spec_sha256,
            "0e9e4a5c392bd7d5dc3519ba97cc3c12bab1db690e14adf99bd7c4e7f2b76bb2"
        );
        assert_eq!(
            first.saga.child_run_spec_sha256,
            child_run_spec_sha256(&spec).unwrap()
        );
        assert_eq!(
            first.create_idempotency_key,
            format!(
                "assignment:assignment-1:{}:child-run:create",
                "c".repeat(64)
            )
        );
        assert_eq!(
            first.prepare_idempotency_key,
            format!(
                "assignment:assignment-1:{}:child-run:prepare",
                "c".repeat(64)
            )
        );
        assert_eq!(
            first.cancel_idempotency_key,
            format!("assignment:assignment-1:{}:cancel", "c".repeat(64))
        );
        assert_eq!(
            first
                .saga
                .terminal_idempotency_key(&"9".repeat(64))
                .unwrap(),
            format!(
                "assignment:assignment-1:{}:terminal:{}",
                "c".repeat(64),
                "9".repeat(64)
            )
        );
        assert!(first.saga.terminal_idempotency_key("invalid").is_err());

        spec.run_start_idempotency_key = "child-start-2".to_owned();
        let changed = AssignmentChildProvisionSagaIdentity::derive(
            "workspace-1",
            "assignment-1",
            1,
            &"c".repeat(64),
            &spec,
        )
        .unwrap();
        assert_ne!(
            changed.child_run_spec_sha256,
            first.saga.child_run_spec_sha256
        );
        assert_ne!(changed.operation_id, first.saga.operation_id);

        let mut forged = first;
        forged.saga.operation_id = "0".repeat(64);
        assert_eq!(
            forged.validate(),
            Err(AgentAssignmentValidationError::InvalidState)
        );
    }

    #[test]
    fn envelope_round_trips_with_camel_case_fields() {
        let envelope = Envelope::new(
            MessageType::Control,
            "runtime.hello",
            "2026-07-12T00:00:00Z",
            1,
            RuntimeHello {
                runtime_version: "0.1.0".to_owned(),
                protocol_versions: vec![PROTOCOL_VERSION],
                capabilities: vec!["runs".to_owned()],
                build: RuntimeBuild {
                    commit: "test".to_owned(),
                    target: "x86_64-pc-windows-msvc".to_owned(),
                },
            },
        )
        .expect("hello payload should serialize");

        let encoded = serde_json::to_string(&envelope).expect("envelope should serialize");
        assert!(encoded.contains("\"protocolVersion\":1"));
        assert!(encoded.contains("\"messageType\":\"control\""));

        let decoded: Envelope = serde_json::from_str(&encoded).expect("envelope should parse");
        assert_eq!(decoded, envelope);
        assert_eq!(decoded.validate_version(), Ok(()));
    }

    #[test]
    fn unsupported_protocol_version_is_rejected() {
        let mut envelope = Envelope::new(
            MessageType::Command,
            "runtime.initialize",
            "2026-07-12T00:00:00Z",
            1,
            serde_json::json!({}),
        )
        .expect("empty payload should serialize");
        envelope.protocol_version = PROTOCOL_VERSION + 1;

        assert_eq!(
            envelope.validate_version(),
            Err(ProtocolError::UnsupportedVersion {
                received: PROTOCOL_VERSION + 1,
                supported: PROTOCOL_VERSION,
            })
        );
    }

    #[test]
    fn sequence_must_fit_the_cross_language_safe_integer_range() {
        let mut envelope = Envelope::new(
            MessageType::Event,
            "run.created",
            "2026-07-12T00:00:00Z",
            1,
            serde_json::json!({}),
        )
        .expect("empty payload should serialize");

        envelope.sequence = MAX_SAFE_SEQUENCE + 1;
        assert_eq!(
            envelope.validate_version(),
            Err(ProtocolError::SequenceOutOfRange {
                received: MAX_SAFE_SEQUENCE + 1,
                maximum: MAX_SAFE_SEQUENCE,
            })
        );
    }

    #[test]
    fn context_compile_and_receipt_round_trip_with_strict_tagged_items() {
        let items = vec![
            ContextItem::SystemPrompt {
                item_id: "system-1".to_owned(),
                content: "Stay within the project.".to_owned(),
                content_sha256: "a".repeat(64),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            ContextItem::ToolProtocol {
                item_id: "tool-1".to_owned(),
                tool_name: "project.read".to_owned(),
                schema_version: 1,
                protocol: serde_json::json!({ "type": "object" }),
                content_sha256: "b".repeat(64),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            ContextItem::SessionMessage {
                item_id: "session-1".to_owned(),
                message_id: "message-1".to_owned(),
                role: ContextMessageRole::User,
                content: "Continue the coastline discussion.".to_owned(),
                content_sha256: "c".repeat(64),
                created_at: "2026-07-12T00:00:00Z".to_owned(),
                disclosure: ContextDisclosure::ProjectPrivate,
                required: false,
            },
            ContextItem::RetrievalSource {
                item_id: "source-1".to_owned(),
                source_receipt_id: "receipt-1".to_owned(),
                source_kind: ContextSourceKind::Document,
                stable_version_id: "version-1".to_owned(),
                content: "The coast was formed by subsidence.".to_owned(),
                content_sha256: "d".repeat(64),
                complete: true,
                disclosure: ContextDisclosure::ProjectPrivate,
                required: true,
            },
            ContextItem::RuntimeExchange {
                item_id: "exchange-1".to_owned(),
                exchange_id: "tool-call-1".to_owned(),
                kind: ContextRuntimeExchangeKind::ToolResult,
                content: serde_json::json!({ "ok": true }),
                content_sha256: "e".repeat(64),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            ContextItem::OutputReserve {
                item_id: "output-1".to_owned(),
                requested_tokens: 8_192,
                policy_id: "auto-output-v1".to_owned(),
                disclosure: ContextDisclosure::AgentInternal,
            },
        ];
        let compile = ContextCompile {
            compile_idempotency_key: "compile-1".to_owned(),
            invocation_id: "run-1:steward".to_owned(),
            request_number: 1,
            provider: ProviderRunIdentity {
                profile_id: "profile-1".to_owned(),
                provider_id: "provider-1".to_owned(),
                model_id: "model-1".to_owned(),
                config_sha256: "f".repeat(64),
            },
            context_policy: VersionedPolicyIdentity {
                id: "context-policy".to_owned(),
                version: "1.0.0".to_owned(),
                sha256: "1".repeat(64),
            },
            compiler_version: "1.0.0".to_owned(),
            context_window: 262_144,
            configured_max_output_tokens: None,
            safety_reserve_tokens: 26_215,
            items,
        };
        let encoded = serde_json::to_string(&compile).unwrap();
        assert!(encoded.contains("\"type\":\"system_prompt\""));
        assert!(encoded.contains("\"requestedTokens\":8192"));
        assert_eq!(
            serde_json::from_str::<ContextCompile>(&encoded).unwrap(),
            compile
        );

        let receipt = ContextCompilationReceipt {
            compilation_id: Uuid::new_v4(),
            request_number: 1,
            compiler_version: "1.0.0".to_owned(),
            tokenizer: TokenizerIdentity {
                kind: TokenizerKind::FallbackEstimate,
                id: "unicode-mixed".to_owned(),
                version: "1.0.0".to_owned(),
                provider_id: Some("provider-1".to_owned()),
                model_id: Some("model-1".to_owned()),
            },
            representation: ContextRepresentation::NormalizedMessages,
            canonical_context_sha256: "2".repeat(64),
            serialized_input_bytes: 12_000,
            estimated_input_tokens: 4_000,
            exact_input_tokens: None,
            context_window: 262_144,
            safety_reserve_tokens: 26_215,
            output_reserve_tokens: 8_192,
            available_input_tokens: 227_737,
            accepted: true,
            budget: vec![ContextBudgetAllocation {
                category: ContextBudgetCategory::SystemPrompt,
                estimated_tokens: 500,
            }],
            included_item_ids: vec!["system-1".to_owned()],
            omitted_item_ids: vec!["session-1".to_owned()],
            incomplete: true,
            disclosure: ContextDisclosure::AgentInternal,
        };
        let encoded = serde_json::to_string(&receipt).unwrap();
        assert_eq!(
            serde_json::from_str::<ContextCompilationReceipt>(&encoded).unwrap(),
            receipt
        );
    }

    #[test]
    fn context_protocol_rejects_unknown_compile_and_item_fields() {
        let compile_with_unknown = serde_json::json!({
            "compileIdempotencyKey": "compile-1",
            "invocationId": "run-1:steward",
            "requestNumber": 1,
            "provider": {
                "profileId": "profile-1",
                "providerId": "provider-1",
                "modelId": "model-1",
                "configSha256": "a"
            },
            "contextPolicy": { "id": "policy", "version": "1", "sha256": "b" },
            "compilerVersion": "1.0.0",
            "contextWindow": 128000,
            "configuredMaxOutputTokens": null,
            "safetyReserveTokens": 12800,
            "items": [],
            "unexpected": true
        });
        assert!(serde_json::from_value::<ContextCompile>(compile_with_unknown).is_err());

        let item_with_unknown = serde_json::json!({
            "type": "system_prompt",
            "itemId": "system-1",
            "content": "prompt",
            "contentSha256": "a",
            "disclosure": "agent_internal",
            "required": true,
            "unexpected": true
        });
        assert!(serde_json::from_value::<ContextItem>(item_with_unknown).is_err());

        let tokenizer_with_unknown = serde_json::json!({
            "kind": "fallback_estimate",
            "id": "unicode-mixed",
            "version": "1.0.0",
            "providerId": null,
            "modelId": null,
            "unexpected": true
        });
        assert!(serde_json::from_value::<TokenizerIdentity>(tokenizer_with_unknown).is_err());

        let receipt_with_unknown = serde_json::json!({
            "compilationId": Uuid::new_v4(),
            "requestNumber": 1,
            "compilerVersion": "1.0.0",
            "tokenizer": {
                "kind": "fallback_estimate",
                "id": "unicode-mixed",
                "version": "1.0.0",
                "providerId": null,
                "modelId": null
            },
            "representation": "normalized_messages",
            "canonicalContextSha256": "a",
            "serializedInputBytes": 1,
            "estimatedInputTokens": 1,
            "exactInputTokens": null,
            "contextWindow": 128000,
            "safetyReserveTokens": 12800,
            "outputReserveTokens": 8192,
            "availableInputTokens": 107008,
            "accepted": true,
            "budget": [],
            "includedItemIds": [],
            "omittedItemIds": [],
            "disclosure": "agent_internal",
            "unexpected": true
        });
        assert!(serde_json::from_value::<ContextCompilationReceipt>(receipt_with_unknown).is_err());
    }

    #[test]
    fn provider_inference_payloads_round_trip_strictly() {
        let run_id = Uuid::new_v4();
        let identity = ProviderInferenceIdentity {
            run_id,
            inference_id: Uuid::new_v4(),
            attempt_id: Uuid::new_v4(),
            context_compilation_id: Uuid::new_v4(),
            request_number: 1,
            attempt_number: 1,
        };
        let start = ProviderInferenceStart {
            inference_id: identity.inference_id,
            attempt_id: identity.attempt_id,
            invocation_id: "invocation-1".to_owned(),
            context_compilation_id: identity.context_compilation_id,
            request_number: 1,
            attempt_number: 1,
            inference_idempotency_key: "inference-key-1".to_owned(),
        };
        let accepted: ProviderInferenceAccepted = identity.clone();
        let error = RuntimeError {
            code: "PROVIDER_REJECTED".to_owned(),
            class: RuntimeErrorClass::ProviderRejected,
            retryable: false,
            public_message: "Provider rejected the request.".to_owned(),
            stage: "provider.inference".to_owned(),
            attempt: 1,
            diagnostic_id: Uuid::new_v4(),
        };
        let completed = ProviderInferenceCompleted {
            identity: identity.clone(),
            provider_id: "deepseek".to_owned(),
            model_id: "deepseek-chat".to_owned(),
            response_id_sha256: "a".repeat(64),
            response_body_sha256: "b".repeat(64),
            stop_reason: "stop".to_owned(),
            usage: ProviderInferenceUsage {
                input_tokens: 10,
                output_tokens: 2,
                total_tokens: 12,
            },
            output: Some(ProviderInferenceOutput {
                text: "done".to_owned(),
                text_sha256: lowercase_sha256(b"done"),
                utf8_bytes: 4,
            }),
            tool_calls: vec![],
        };
        let failed = ProviderInferenceFailed {
            identity: identity.clone(),
            error: error.clone(),
        };
        let reconciliation = ProviderInferenceReconciliationRequired {
            identity,
            reason: ProviderInferenceReconciliationReason::OutcomeUnknown,
            error,
        };

        let start_json = serde_json::to_value(&start).unwrap();
        let accepted_json = serde_json::to_value(&accepted).unwrap();
        let completed_json = serde_json::to_value(&completed).unwrap();
        let failed_json = serde_json::to_value(&failed).unwrap();
        let reconciliation_json = serde_json::to_value(&reconciliation).unwrap();
        assert_eq!(start.validate(), Ok(()));
        assert_eq!(accepted.validate(), Ok(()));
        assert_eq!(completed.validate(), Ok(()));
        assert_eq!(failed.validate(), Ok(()));
        assert_eq!(reconciliation.validate(), Ok(()));
        assert_eq!(
            serde_json::from_value::<ProviderInferenceStart>(start_json).unwrap(),
            start
        );
        assert_eq!(
            serde_json::from_value::<ProviderInferenceAccepted>(accepted_json).unwrap(),
            accepted
        );
        assert_eq!(
            serde_json::from_value::<ProviderInferenceCompleted>(completed_json).unwrap(),
            completed
        );
        assert_eq!(
            serde_json::from_value::<ProviderInferenceFailed>(failed_json).unwrap(),
            failed
        );
        assert_eq!(
            serde_json::from_value::<ProviderInferenceReconciliationRequired>(reconciliation_json)
                .unwrap(),
            reconciliation
        );
    }

    #[test]
    fn provider_inference_payloads_reject_unknown_fields_and_bad_uuids() {
        let start_with_unknown = serde_json::json!({
            "inferenceId": Uuid::new_v4(),
            "attemptId": Uuid::new_v4(),
            "invocationId": "invocation-1",
            "contextCompilationId": Uuid::new_v4(),
            "requestNumber": 1,
            "attemptNumber": 1,
            "inferenceIdempotencyKey": "inference-key-1",
            "credential": "must-not-cross-protocol"
        });
        assert!(serde_json::from_value::<ProviderInferenceStart>(start_with_unknown).is_err());

        let identity_with_bad_uuid = serde_json::json!({
            "runId": "not-a-uuid",
            "inferenceId": Uuid::new_v4(),
            "attemptId": Uuid::new_v4(),
            "contextCompilationId": Uuid::new_v4(),
            "requestNumber": 1,
            "attemptNumber": 1
        });
        assert!(
            serde_json::from_value::<ProviderInferenceIdentity>(identity_with_bad_uuid).is_err()
        );

        let reconciliation_with_bad_reason = serde_json::json!({
            "runId": Uuid::new_v4(),
            "inferenceId": Uuid::new_v4(),
            "attemptId": Uuid::new_v4(),
            "contextCompilationId": Uuid::new_v4(),
            "requestNumber": 1,
            "attemptNumber": 1,
            "reason": "retry",
            "error": {
                "code": "PROVIDER_OUTCOME_UNKNOWN",
                "class": "provider_timeout",
                "retryable": false,
                "publicMessage": "Outcome unknown.",
                "stage": "provider.inference",
                "attempt": 1,
                "diagnosticId": Uuid::new_v4()
            }
        });
        assert!(
            serde_json::from_value::<ProviderInferenceReconciliationRequired>(
                reconciliation_with_bad_reason
            )
            .is_err()
        );
    }

    #[test]
    fn provider_inference_validation_rejects_semantically_invalid_payloads() {
        let identity = ProviderInferenceIdentity {
            run_id: Uuid::new_v4(),
            inference_id: Uuid::new_v4(),
            attempt_id: Uuid::new_v4(),
            context_compilation_id: Uuid::new_v4(),
            request_number: 1,
            attempt_number: 1,
        };
        let error = RuntimeError {
            code: "PROVIDER_OUTCOME_UNKNOWN".to_owned(),
            class: RuntimeErrorClass::ProviderTimeout,
            retryable: false,
            public_message: "Outcome unknown.".to_owned(),
            stage: "provider.inference".to_owned(),
            attempt: 1,
            diagnostic_id: Uuid::new_v4(),
        };
        let valid_completed = ProviderInferenceCompleted {
            identity: identity.clone(),
            provider_id: "deepseek".to_owned(),
            model_id: "deepseek-chat".to_owned(),
            response_id_sha256: "a".repeat(64),
            response_body_sha256: "b".repeat(64),
            stop_reason: "stop".to_owned(),
            usage: ProviderInferenceUsage {
                input_tokens: 10,
                output_tokens: 2,
                total_tokens: 12,
            },
            output: Some(ProviderInferenceOutput {
                text: "done".to_owned(),
                text_sha256: lowercase_sha256(b"done"),
                utf8_bytes: 4,
            }),
            tool_calls: vec![],
        };

        let mut start = ProviderInferenceStart {
            inference_id: identity.inference_id,
            attempt_id: identity.attempt_id,
            invocation_id: " ".to_owned(),
            context_compilation_id: identity.context_compilation_id,
            request_number: 1,
            attempt_number: 1,
            inference_idempotency_key: "key".to_owned(),
        };
        assert_eq!(
            start.validate(),
            Err(ProviderInferenceValidationError::EmptyIdentity {
                field: "invocationId"
            })
        );
        start.invocation_id = "invocation".to_owned();
        start.request_number = 0;
        assert_eq!(
            start.validate(),
            Err(ProviderInferenceValidationError::NumberMustBePositive {
                field: "requestNumber"
            })
        );

        let mut completed = valid_completed.clone();
        completed.provider_id.clear();
        assert!(matches!(
            completed.validate(),
            Err(ProviderInferenceValidationError::EmptyIdentity {
                field: "providerId"
            })
        ));
        completed = valid_completed.clone();
        completed.response_id_sha256 = "A".repeat(64);
        assert!(matches!(
            completed.validate(),
            Err(ProviderInferenceValidationError::InvalidSha256 {
                field: "responseIdSha256"
            })
        ));
        completed = valid_completed.clone();
        completed.usage.total_tokens = 11;
        assert_eq!(
            completed.validate(),
            Err(ProviderInferenceValidationError::UsageTotalMismatch)
        );
        completed = valid_completed.clone();
        completed.output.as_mut().unwrap().text.clear();
        assert_eq!(
            completed.validate(),
            Err(ProviderInferenceValidationError::OutputEmpty)
        );
        completed = valid_completed.clone();
        completed.output.as_mut().unwrap().utf8_bytes = 3;
        assert!(matches!(
            completed.validate(),
            Err(ProviderInferenceValidationError::OutputByteLengthMismatch { .. })
        ));
        completed = valid_completed.clone();
        completed.output.as_mut().unwrap().text_sha256 = "c".repeat(64);
        assert_eq!(
            completed.validate(),
            Err(ProviderInferenceValidationError::OutputHashMismatch)
        );
        completed = valid_completed;
        let output = completed.output.as_mut().unwrap();
        output.text = "a".repeat(MAX_PROVIDER_INFERENCE_OUTPUT_BYTES + 1);
        output.text_sha256 = lowercase_sha256(output.text.as_bytes());
        output.utf8_bytes = output.text.len() as u64;
        assert!(matches!(
            completed.validate(),
            Err(ProviderInferenceValidationError::OutputTooLarge { .. })
        ));

        let reconciliation = ProviderInferenceReconciliationRequired {
            identity,
            reason: ProviderInferenceReconciliationReason::OutcomeUnknown,
            error: RuntimeError {
                retryable: true,
                ..error
            },
        };
        assert_eq!(
            reconciliation.validate(),
            Err(ProviderInferenceValidationError::ReconciliationCannotBeRetryable)
        );
    }

    #[test]
    fn run_reconciliation_requires_explicit_duplicate_acknowledgement() {
        let retry = RunReconcile {
            reconciliation_idempotency_key: "reconcile-1".to_owned(),
            attempt_id: Uuid::new_v4(),
            decision: RunReconciliationDecision::RetryAsNewAttemptAcknowledgingDuplicate,
            duplicate_execution_acknowledged: true,
        };
        assert_eq!(retry.validate(), Ok(()));
        let encoded = serde_json::to_value(&retry).unwrap();
        assert_eq!(
            serde_json::from_value::<RunReconcile>(encoded).unwrap(),
            retry
        );
        let invalid = RunReconcile {
            duplicate_execution_acknowledged: false,
            ..retry
        };
        assert_eq!(
            invalid.validate(),
            Err(RunReconcileValidationError::DuplicateAcknowledgementMismatch)
        );
    }

    #[test]
    fn tool_request_and_unknown_outcome_are_strict_and_nonretryable() {
        let request = ToolRequest {
            request_idempotency_key: "tool-1".to_owned(),
            tool_call_id: Uuid::new_v4(),
            provider_tool_call_id: "call-provider-1".to_owned(),
            invocation_id: "invocation-1".to_owned(),
            tool_name: "project.read".to_owned(),
            schema_version: 1,
            attempt: 1,
            side_effect: ToolProtocolSideEffect::None,
            parallel: false,
            arguments: ToolArtifactReceipt {
                artifact_id: Uuid::new_v4(),
                media_type: "application/json".to_owned(),
                sha256: "a".repeat(64),
                utf8_bytes: 2,
            },
            source_scope: ToolSourceScope {
                source_checkpoint_id: "checkpoint-1".to_owned(),
                resource_ids: vec!["resource-1".to_owned()],
                scope_sha256: "b".repeat(64),
            },
            permission: ToolPermissionPolicy {
                mode: RunPermissionMode::Assist,
                policy_id: "tools".to_owned(),
                policy_version: "1.0.0".to_owned(),
                policy_sha256: "c".repeat(64),
            },
        };
        assert_eq!(request.validate(), Ok(()));
        assert_eq!(
            serde_json::from_value::<ToolRequest>(serde_json::to_value(&request).unwrap()).unwrap(),
            request
        );
        let mut bad = request;
        bad.provider_tool_call_id.clear();
        assert_eq!(
            bad.validate(),
            Err(ToolProtocolValidationError::InvalidField(
                "providerToolCallId"
            ))
        );
        bad.provider_tool_call_id = "call-provider-1".to_owned();
        bad.source_scope.resource_ids = vec!["resource-2".to_owned(), "resource-1".to_owned()];
        assert_eq!(
            bad.validate(),
            Err(ToolProtocolValidationError::SourceScopeNotCanonical)
        );
    }

    fn goal_definition() -> GoalDefinition {
        GoalDefinition {
            objective: "Finish the world package".to_owned(),
            scope: GoalScope {
                resource_ids: vec!["resource-a".to_owned(), "resource-b".to_owned()],
                scope_sha256: "a".repeat(64),
            },
            acceptance_criteria: vec![GoalAcceptanceCriterion {
                criterion_id: "criterion-1".to_owned(),
                description: "The package is verified".to_owned(),
                required: true,
                satisfied: false,
                evidence_refs: vec![],
            }],
            constraints: vec!["Use real provider evidence".to_owned()],
            permission_mode: GoalPermissionMode::Assist,
        }
    }

    fn plan_step() -> PlanStep {
        PlanStep {
            step_id: "step-1".to_owned(),
            purpose: "Verify the package".to_owned(),
            dependencies: vec![],
            assigned_agent: Some("checker".to_owned()),
            capabilities: vec!["project.read".to_owned()],
            expected_artifact: "verification-report".to_owned(),
            required_evidence: vec!["test".to_owned()],
            status: PlanStepStatus::Pending,
            completion_evidence: vec![],
        }
    }

    fn goal_evidence() -> GoalEvidenceReference {
        GoalEvidenceReference {
            kind: "test".to_owned(),
            reference: "tests/goal.rs".to_owned(),
            description: "Goal contract passed".to_owned(),
        }
    }

    #[test]
    fn goal_command_payloads_are_strict_camel_case_and_validate() {
        let create = GoalCreate {
            create_idempotency_key: "goal-create-1".to_owned(),
            goal_id: "goal-1".to_owned(),
            session_id: "session-1".to_owned(),
            owner_agent_id: "steward".to_owned(),
            definition: goal_definition(),
        };
        let get = GoalGet {
            goal_id: "goal-1".to_owned(),
            revision: None,
        };
        let revise = GoalRevise {
            revise_idempotency_key: "goal-revise-1".to_owned(),
            goal_id: "goal-1".to_owned(),
            expected_revision: 1,
            definition: goal_definition(),
        };
        let propose = GoalCompletionPropose {
            propose_idempotency_key: "goal-propose-1".to_owned(),
            goal_id: "goal-1".to_owned(),
            expected_revision: 2,
            evidence_refs: vec![goal_evidence()],
        };
        let complete = GoalComplete {
            complete_idempotency_key: "goal-complete-1".to_owned(),
            goal_id: "goal-1".to_owned(),
            expected_revision: 3,
            evidence_refs: vec![goal_evidence()],
        };

        assert_eq!(create.validate(), Ok(()));
        assert_eq!(get.validate(), Ok(()));
        assert_eq!(revise.validate(), Ok(()));
        assert_eq!(propose.validate(), Ok(()));
        assert_eq!(complete.validate(), Ok(()));
        let mut forged_complete = serde_json::to_value(&complete).unwrap();
        forged_complete["actor"] = serde_json::json!({
            "agentId": "child",
            "isChildAgent": false
        });
        assert!(serde_json::from_value::<GoalComplete>(forged_complete).is_err());
        let encoded = serde_json::to_value(&create).unwrap();
        assert!(encoded.get("createIdempotencyKey").is_some());
        assert!(encoded["definition"]["scope"].get("scopeSha256").is_some());
        assert_eq!(
            serde_json::from_value::<GoalCreate>(encoded).unwrap(),
            create
        );
        assert!(
            serde_json::from_value::<GoalGet>(serde_json::json!({
                "goalId": "goal-1", "unexpected": true
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<GoalCreate>(serde_json::json!({
            "createIdempotencyKey": "key",
            "goalId": "goal-1",
            "sessionId": "session-1",
            "ownerAgentId": "steward",
            "definition": {
                "objective": "objective",
                "scope": { "resourceIds": ["resource-1"], "scopeSha256": "a".repeat(64), "extra": true },
                "acceptanceCriteria": [],
                "constraints": [],
                "permissionMode": "assist"
            }
        })).is_err());
    }

    #[test]
    fn plan_command_payloads_are_strict_camel_case_and_validate() {
        let create = PlanCreate {
            create_idempotency_key: "plan-create-1".to_owned(),
            plan_id: "plan-1".to_owned(),
            goal_id: "goal-1".to_owned(),
            goal_revision: 1,
            steps: vec![plan_step()],
        };
        let get = PlanGet {
            plan_id: "plan-1".to_owned(),
            revision: None,
        };
        let revise = PlanRevise {
            revise_idempotency_key: "plan-revise-1".to_owned(),
            plan_id: "plan-1".to_owned(),
            expected_revision: 1,
            goal_revision: 2,
            steps: vec![plan_step()],
        };
        let start = PlanStepStart {
            start_idempotency_key: "plan-start-1".to_owned(),
            plan_id: "plan-1".to_owned(),
            expected_revision: 2,
            step_id: "step-1".to_owned(),
        };
        let complete = PlanStepComplete {
            complete_idempotency_key: "plan-complete-1".to_owned(),
            plan_id: "plan-1".to_owned(),
            expected_revision: 3,
            step_id: "step-1".to_owned(),
            evidence: vec![PlanEvidence {
                evidence_type: "test".to_owned(),
                reference_id: "test-1".to_owned(),
                sha256: "b".repeat(64),
            }],
        };

        assert_eq!(create.validate(), Ok(()));
        assert_eq!(get.validate(), Ok(()));
        assert_eq!(revise.validate(), Ok(()));
        assert_eq!(start.validate(), Ok(()));
        assert_eq!(complete.validate(), Ok(()));
        let encoded = serde_json::to_value(&complete).unwrap();
        assert!(encoded.get("completeIdempotencyKey").is_some());
        assert_eq!(
            serde_json::from_value::<PlanStepComplete>(encoded).unwrap(),
            complete
        );
        assert!(
            serde_json::from_value::<PlanGet>(serde_json::json!({
                "planId": "plan-1", "unexpected": true
            }))
            .is_err()
        );
    }

    #[test]
    fn goal_plan_snapshots_and_revision_references_require_real_revisions_and_hashes() {
        let revision_reference = RevisionReference {
            id: "goal-1".to_owned(),
            revision: 3,
            sha256: Some("c".repeat(64)),
        };
        assert_eq!(revision_reference.validate(), Ok(()));
        assert!(
            serde_json::to_string(&revision_reference)
                .unwrap()
                .contains("\"sha256\"")
        );

        let goal = GoalSnapshot {
            identity: GoalIdentity {
                workspace_id: "workspace-1".to_owned(),
                project_id: "project-1".to_owned(),
                session_id: "session-1".to_owned(),
                goal_id: "goal-1".to_owned(),
                owner_agent_id: "steward".to_owned(),
            },
            definition: goal_definition(),
            definition_revision: 1,
            revision: 1,
            status: GoalStatus::Active,
            evidence_refs: vec![],
            blockers: vec![],
            last_event_hash: "d".repeat(64),
        };
        let plan = PlanSnapshot {
            workspace_id: "workspace-1".to_owned(),
            plan_id: "plan-1".to_owned(),
            goal_id: "goal-1".to_owned(),
            current_revision: PlanRevision {
                revision: 1,
                goal_revision: 1,
                steps: vec![plan_step()],
                previous_revision_sha256: None,
                revision_sha256: "e".repeat(64),
                created_at: "2026-07-12T00:00:00Z".to_owned(),
            },
            last_stream_sequence: 1,
        };
        assert_eq!(goal.validate(), Ok(()));
        assert_eq!(plan.validate(), Ok(()));
        assert_eq!(
            serde_json::from_value::<GoalSnapshot>(serde_json::to_value(&goal).unwrap()).unwrap(),
            goal
        );
        assert_eq!(
            serde_json::from_value::<PlanSnapshot>(serde_json::to_value(&plan).unwrap()).unwrap(),
            plan
        );

        let mut invalid_reference = revision_reference;
        invalid_reference.revision = 0;
        assert_eq!(
            invalid_reference.validate(),
            Err(GoalPlanValidationError::NumberMustBePositive { field: "revision" })
        );
        invalid_reference.revision = 1;
        invalid_reference.sha256 = Some("A".repeat(64));
        assert_eq!(
            invalid_reference.validate(),
            Err(GoalPlanValidationError::InvalidSha256 { field: "sha256" })
        );
        invalid_reference.sha256 = None;
        assert_eq!(
            invalid_reference.validate(),
            Err(GoalPlanValidationError::EmptyField { field: "sha256" })
        );
        assert_eq!(invalid_reference.validate_legacy_replay(), Ok(()));
    }

    #[test]
    fn goal_plan_validation_rejects_empty_fields_unsorted_scope_and_invalid_evidence_hashes() {
        let mut create = GoalCreate {
            create_idempotency_key: " ".to_owned(),
            goal_id: "goal-1".to_owned(),
            session_id: "session-1".to_owned(),
            owner_agent_id: "steward".to_owned(),
            definition: goal_definition(),
        };
        assert_eq!(
            create.validate(),
            Err(GoalPlanValidationError::EmptyField {
                field: "createIdempotencyKey"
            })
        );
        create.create_idempotency_key = "key".to_owned();
        create.definition.scope.resource_ids.reverse();
        assert!(matches!(
            create.validate(),
            Err(GoalPlanValidationError::DuplicateIdentifier {
                field: "scope.resourceIds",
                ..
            })
        ));
        create.definition.scope.resource_ids.reverse();
        create.definition.scope.scope_sha256 = "A".repeat(64);
        assert_eq!(
            create.validate(),
            Err(GoalPlanValidationError::InvalidSha256 {
                field: "scope.scopeSha256"
            })
        );

        let complete = PlanStepComplete {
            complete_idempotency_key: "key".to_owned(),
            plan_id: "plan-1".to_owned(),
            expected_revision: 0,
            step_id: "step-1".to_owned(),
            evidence: vec![PlanEvidence {
                evidence_type: "test".to_owned(),
                reference_id: "test-1".to_owned(),
                sha256: "bad".to_owned(),
            }],
        };
        assert_eq!(
            complete.validate(),
            Err(GoalPlanValidationError::NumberMustBePositive {
                field: "expectedRevision"
            })
        );
        let complete = PlanStepComplete {
            expected_revision: 1,
            ..complete
        };
        assert_eq!(
            complete.validate(),
            Err(GoalPlanValidationError::InvalidSha256 {
                field: "evidence.sha256"
            })
        );
    }
}
