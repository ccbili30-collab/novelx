use std::collections::{BTreeMap, BTreeSet};

use novelx_protocol::ProviderRunIdentity;
use serde_json::json;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    agent_assignment_aggregate::AgentAssignmentStatus,
    agent_assignment_recovery::{
        AssignmentRecoveryClassification, AssignmentRecoveryReport, RecoveredAssignment,
    },
    agent_loop_journal::AgentLoopJournalRepository,
    agent_loop_service::{AgentLoopService, LoopPhase},
    event_journal::{EventJournal, EventJournalError},
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptError, ProviderAttemptRecovery,
        ProviderAttemptState,
    },
    run_aggregate::{RunAggregate, RunAggregateError},
    run_state::RunState,
    tool_aggregate::{ToolAggregateError, ToolCallAggregate},
    tool_state::{ToolAuthorization, ToolOutcomeKnowledge, ToolSideEffect, ToolState},
};

pub use crate::operational_recovery_action::OperationalRecoveryAction;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationalRecoveryGate {
    AwaitingProviderBinding,
    WaitingForApproval,
    WaitingForReconciliation,
    WaitingForExplicitExecution,
    ProviderDispatchReady,
    RecoveryReady,
    Quarantined,
    TerminalProjectionOnly,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryRun {
    pub run_id: String,
    pub run_state: RunState,
    pub source_fingerprint: String,
    pub gate: OperationalRecoveryGate,
    pub action: OperationalRecoveryAction,
    pub active_agent_loop_id: Option<String>,
    pub active_agent_loop_phase: Option<LoopPhase>,
    pub provider_attempt_states: Vec<ProviderAttemptState>,
    pub tool_states: Vec<ToolState>,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryReport {
    pub runs: Vec<OperationalRecoveryRun>,
}

pub struct OperationalRecoveryScanner<'a> {
    journal: &'a mut EventJournal,
    assignments: &'a AssignmentRecoveryReport,
    bound_providers: &'a [ProviderRunIdentity],
}

impl<'a> OperationalRecoveryScanner<'a> {
    pub const fn new(
        journal: &'a mut EventJournal,
        assignments: &'a AssignmentRecoveryReport,
        bound_providers: &'a [ProviderRunIdentity],
    ) -> Self {
        Self {
            journal,
            assignments,
            bound_providers,
        }
    }

    pub fn scan(
        &mut self,
        workspace_id: &str,
        project_id: &str,
    ) -> Result<OperationalRecoveryReport, OperationalRecoveryScanError> {
        require_text("workspace_id", workspace_id)?;
        require_text("project_id", project_id)?;

        let assignment_quarantine = assignment_quarantine(self.assignments);
        let assignments_by_child = assignments_by_child_run(self.assignments);
        let agent_loops = addresses_by_run(self.journal.list_aggregates("agent_loop")?);
        let provider_attempts = addresses_by_run(self.journal.list_aggregates("provider_attempt")?);
        let tools = addresses_by_run(self.journal.list_aggregates("tool")?);
        let mut runs = Vec::new();
        for address in self.journal.list_aggregates("run")? {
            if address.aggregate_id != address.run_id {
                return Err(OperationalRecoveryScanError::RunAddressMismatch {
                    run_id: address.run_id,
                    aggregate_id: address.aggregate_id,
                });
            }
            let run = RunAggregate::recover(self.journal, &address.run_id).map_err(|source| {
                OperationalRecoveryScanError::RunRecoveryFailed {
                    run_id: address.run_id.clone(),
                    source,
                }
            })?;
            if run.pinned_identity().workspace_id != workspace_id
                || run.pinned_identity().project_id != project_id
            {
                continue;
            }
            runs.push(
                self.scan_run(
                    &run,
                    &assignment_quarantine,
                    &assignments_by_child,
                    agent_loops
                        .get(run.run_id())
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                    provider_attempts
                        .get(run.run_id())
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                    tools.get(run.run_id()).map(Vec::as_slice).unwrap_or(&[]),
                )?,
            );
        }
        runs.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        Ok(OperationalRecoveryReport { runs })
    }

    fn scan_run(
        &mut self,
        run: &RunAggregate,
        assignment_quarantine: &BTreeMap<String, Vec<String>>,
        assignments_by_child: &BTreeMap<String, &RecoveredAssignment>,
        agent_loop_ids: &[String],
        provider_attempt_ids: &[String],
        tool_call_ids: &[String],
    ) -> Result<OperationalRecoveryRun, OperationalRecoveryScanError> {
        let run_id = run.run_id();
        let mut reasons = assignment_quarantine
            .get(run_id)
            .cloned()
            .unwrap_or_default();
        if let Some(reference) = run.pinned_identity().assignment.as_ref() {
            match assignments_by_child.get(run_id) {
                Some(assignment) if assignment.assignment_id == reference.id => {}
                Some(_) => reasons.push("assignment_recovery_identity_mismatch".to_owned()),
                None => reasons.push("assignment_recovery_record_missing".to_owned()),
            }
        }

        let mut active_loops = Vec::new();
        for invocation_id in agent_loop_ids {
            let record = AgentLoopJournalRepository::new(self.journal)
                .recover(run_id, invocation_id)
                .map_err(
                    |source| OperationalRecoveryScanError::AgentLoopRecoveryFailed {
                        run_id: run_id.to_owned(),
                        invocation_id: invocation_id.clone(),
                        source,
                    },
                )?;
            if record.service.is_active() {
                let checkpoint = record.service.checkpoint_sha256().map_err(|source| {
                    OperationalRecoveryScanError::AgentLoopCheckpointFailed {
                        run_id: run_id.to_owned(),
                        invocation_id: invocation_id.clone(),
                        source,
                    }
                })?;
                active_loops.push((invocation_id.clone(), record.service, checkpoint));
            }
        }
        if active_loops.len() > 1 {
            reasons.push("multiple_active_agent_loops".to_owned());
        }
        let active_loop = (active_loops.len() == 1).then(|| active_loops[0].clone());

        let mut attempts = Vec::new();
        for attempt_id in provider_attempt_ids {
            attempts.push(
                ProviderAttemptAggregate::recover(self.journal, run_id, attempt_id).map_err(
                    |source| OperationalRecoveryScanError::ProviderAttemptRecoveryFailed {
                        run_id: run_id.to_owned(),
                        attempt_id: attempt_id.clone(),
                        source,
                    },
                )?,
            );
        }

        let mut tools = Vec::new();
        for tool_call_id in tool_call_ids {
            tools.push(
                ToolCallAggregate::recover(self.journal, run_id, tool_call_id).map_err(
                    |source| OperationalRecoveryScanError::ToolRecoveryFailed {
                        run_id: run_id.to_owned(),
                        tool_call_id: tool_call_id.clone(),
                        source,
                    },
                )?,
            );
        }

        let provider_unknown = attempts
            .iter()
            .any(|attempt| matches!(attempt.recovery(), ProviderAttemptRecovery::OutcomeUnknown));
        let tool_unknown = tools.iter().any(|tool| {
            tool.state() == ToolState::Running
                || matches!(
                    tool.outcome_knowledge(),
                    Some(ToolOutcomeKnowledge::Unknown)
                )
        });
        let approval_wait = run.state() == RunState::WaitingForApproval
            || active_loop
                .as_ref()
                .is_some_and(|(_, service, _)| service.phase() == LoopPhase::AwaitingApproval)
            || tools.iter().any(|tool| {
                tool.authorization() == ToolAuthorization::ApprovalRequired
                    && tool.state() == ToolState::Requested
            });
        let has_recoverable_evidence = attempts.iter().any(|attempt| {
            matches!(
                attempt.recovery(),
                ProviderAttemptRecovery::Completed | ProviderAttemptRecovery::TerminalFailure
            )
        });
        let terminal_tool_without_verified_manifest =
            tools.iter().any(|tool| tool.state().is_terminal());
        let local_continuation = active_loop.as_ref().is_some_and(|(_, service, _)| {
            matches!(
                service.phase(),
                LoopPhase::AwaitingToolResults
                    | LoopPhase::AwaitingContextCompilation
                    | LoopPhase::AwaitingInferenceStart
            )
        }) || tools.iter().any(|tool| {
            matches!(tool.state(), ToolState::Requested | ToolState::Authorized)
                && tool.authorization() != ToolAuthorization::ApprovalRequired
        });
        let provider_bound = self
            .bound_providers
            .iter()
            .any(|provider| provider == &run.pinned_identity().provider);

        let assignment_evidence = run
            .pinned_identity()
            .assignment
            .as_ref()
            .and_then(|_| assignments_by_child.get(run_id).copied());
        let source_fingerprint = source_fingerprint(
            run,
            assignment_evidence,
            active_loop.as_ref(),
            provider_attempt_ids,
            &attempts,
            tool_call_ids,
            &tools,
            provider_bound,
        )?;

        let terminal_with_unknown_effect = run.state().is_terminal()
            && (provider_unknown || tool_unknown || terminal_tool_without_verified_manifest);
        let mut gate = if terminal_with_unknown_effect {
            reasons.push("terminal_run_has_unknown_external_outcome".to_owned());
            OperationalRecoveryGate::Quarantined
        } else if !reasons.is_empty() {
            OperationalRecoveryGate::Quarantined
        } else if provider_unknown || tool_unknown || terminal_tool_without_verified_manifest {
            if provider_unknown {
                reasons.push("provider_outcome_unknown".to_owned());
            }
            if tool_unknown {
                reasons.push("tool_outcome_unknown_or_manifest_missing".to_owned());
            }
            if terminal_tool_without_verified_manifest {
                reasons.push("tool_terminal_manifest_unverified".to_owned());
            }
            OperationalRecoveryGate::WaitingForReconciliation
        } else if run.state() == RunState::WaitingForReconciliation
            || run.state() == RunState::Committing
        {
            reasons.push("run_requires_reconciliation".to_owned());
            OperationalRecoveryGate::WaitingForReconciliation
        } else if approval_wait {
            reasons.push("host_approval_required".to_owned());
            OperationalRecoveryGate::WaitingForApproval
        } else if run.state().is_terminal() {
            OperationalRecoveryGate::TerminalProjectionOnly
        } else if has_recoverable_evidence || local_continuation || provider_bound {
            OperationalRecoveryGate::RecoveryReady
        } else {
            reasons.push("exact_provider_binding_missing".to_owned());
            OperationalRecoveryGate::AwaitingProviderBinding
        };

        let action = classify_action(
            gate,
            run,
            active_loop.as_ref(),
            provider_attempt_ids,
            &attempts,
        );
        if matches!(
            action,
            OperationalRecoveryAction::PersistedEvidenceConflict { .. }
        ) {
            reasons.push("persisted_provider_evidence_conflict".to_owned());
            gate = OperationalRecoveryGate::Quarantined;
        } else if gate == OperationalRecoveryGate::RecoveryReady
            && action.is_persisted_provider_dispatch()
        {
            gate = OperationalRecoveryGate::ProviderDispatchReady;
        } else if gate == OperationalRecoveryGate::RecoveryReady
            && !action.may_execute_without_new_external_effect()
        {
            reasons.push(action_wait_reason(&action).to_owned());
            gate = OperationalRecoveryGate::WaitingForExplicitExecution;
        }

        Ok(OperationalRecoveryRun {
            run_id: run_id.to_owned(),
            run_state: run.state(),
            source_fingerprint,
            gate,
            action,
            active_agent_loop_id: active_loop.as_ref().map(|(id, _, _)| id.clone()),
            active_agent_loop_phase: active_loop.map(|(_, service, _)| service.phase()),
            provider_attempt_states: attempts
                .iter()
                .map(ProviderAttemptAggregate::state)
                .collect(),
            tool_states: tools.iter().map(ToolCallAggregate::state).collect(),
            reasons,
        })
    }
}

fn action_wait_reason(action: &OperationalRecoveryAction) -> &'static str {
    match action {
        OperationalRecoveryAction::ProviderDispatchRequired { .. } => {
            "provider_dispatch_requires_effect_protocol"
        }
        OperationalRecoveryAction::PersistedProviderAttemptDispatch { .. } => {
            "persisted_provider_attempt_dispatch_requires_effect_protocol"
        }
        OperationalRecoveryAction::ToolEvidenceOrDispatchRequired { .. } => {
            "tool_result_manifest_or_dispatch_protocol_required"
        }
        OperationalRecoveryAction::ContextEvidenceRequired { .. } => {
            "persisted_context_compilation_evidence_required"
        }
        OperationalRecoveryAction::InferenceStartEvidenceRequired { .. } => {
            "deterministic_inference_start_evidence_required"
        }
        OperationalRecoveryAction::PersistedEvidenceConflict { .. } => {
            "persisted_provider_evidence_conflict"
        }
        OperationalRecoveryAction::NoExecutableProjection => "no_unique_local_recovery_projection",
        OperationalRecoveryAction::TerminalProjection => "terminal_projection_only",
        OperationalRecoveryAction::PersistedProviderResultProjection { .. } => {
            "persisted_provider_result_projection_ready"
        }
    }
}

fn classify_action(
    gate: OperationalRecoveryGate,
    run: &RunAggregate,
    active_loop: Option<&(String, AgentLoopService, String)>,
    provider_attempt_ids: &[String],
    attempts: &[ProviderAttemptAggregate],
) -> OperationalRecoveryAction {
    if gate == OperationalRecoveryGate::TerminalProjectionOnly {
        return OperationalRecoveryAction::TerminalProjection;
    }
    if gate != OperationalRecoveryGate::RecoveryReady {
        return OperationalRecoveryAction::NoExecutableProjection;
    }
    let Some((invocation_id, service, checkpoint_sha256)) = active_loop else {
        return if attempts.is_empty() {
            OperationalRecoveryAction::ProviderDispatchRequired {
                invocation_id: None,
            }
        } else {
            OperationalRecoveryAction::NoExecutableProjection
        };
    };
    match service.phase() {
        LoopPhase::AwaitingProvider => {
            let Some(dispatch) = service.pending_inference() else {
                return OperationalRecoveryAction::NoExecutableProjection;
            };
            let same_request = provider_attempt_ids
                .iter()
                .zip(attempts)
                .filter(|(_, attempt)| {
                    attempt.definition().invocation_id == *invocation_id
                        && attempt.definition().request_number == dispatch.request_number
                })
                .collect::<Vec<_>>();
            if same_request.len() > 1 {
                return OperationalRecoveryAction::PersistedEvidenceConflict {
                    invocation_id: invocation_id.clone(),
                };
            }
            let Some((attempt_id, attempt)) = same_request.into_iter().next() else {
                return OperationalRecoveryAction::ProviderDispatchRequired {
                    invocation_id: Some(invocation_id.clone()),
                };
            };
            let identity_matches = attempt_id == &dispatch.attempt_id.to_string()
                && attempt.definition().inference_id == dispatch.inference_id.to_string()
                && attempt.definition().context_compilation_id == dispatch.context_compilation_id
                && attempt.definition().attempt_number == dispatch.attempt_number
                && attempt.definition().provider == run.pinned_identity().provider;
            let matched = (attempt.state() == ProviderAttemptState::Responded
                && identity_matches
                && attempt.response_receipt().is_some_and(|receipt| {
                    receipt.actual_provider_id == run.pinned_identity().provider.provider_id
                        && receipt.actual_model_id == run.pinned_identity().provider.model_id
                }))
            .then_some((attempt_id, attempt));
            matched.map_or_else(
                || {
                    if attempt.state() == ProviderAttemptState::Requested && identity_matches {
                        OperationalRecoveryAction::PersistedProviderAttemptDispatch {
                            invocation_id: invocation_id.clone(),
                            attempt_id: attempt_id.clone(),
                            inference_id: dispatch.inference_id.to_string(),
                            context_compilation_id: dispatch.context_compilation_id.to_string(),
                            attempt_number: dispatch.attempt_number,
                            provider: attempt.definition().provider.clone(),
                            canonical_context_sha256: attempt
                                .definition()
                                .canonical_context_sha256
                                .clone(),
                            expected_loop_checkpoint_sha256: checkpoint_sha256.clone(),
                            expected_attempt_sequence: attempt.aggregate_sequence(),
                            transport_payload_sha256: attempt
                                .definition()
                                .transport_payload_sha256
                                .clone(),
                        }
                    } else {
                        OperationalRecoveryAction::PersistedEvidenceConflict {
                            invocation_id: invocation_id.clone(),
                        }
                    }
                },
                |(attempt_id, attempt)| {
                    let response = attempt
                        .response_receipt()
                        .unwrap_or_else(|| unreachable!("matched responded attempt"));
                    OperationalRecoveryAction::PersistedProviderResultProjection {
                        invocation_id: invocation_id.clone(),
                        attempt_id: attempt_id.clone(),
                        expected_loop_checkpoint_sha256: checkpoint_sha256.clone(),
                        expected_attempt_sequence: attempt.aggregate_sequence(),
                        response_body_sha256: response.response_body_sha256.clone(),
                    }
                },
            )
        }
        LoopPhase::AwaitingContextCompilation => {
            OperationalRecoveryAction::ContextEvidenceRequired {
                invocation_id: invocation_id.clone(),
            }
        }
        LoopPhase::AwaitingToolResults => {
            OperationalRecoveryAction::ToolEvidenceOrDispatchRequired {
                invocation_id: invocation_id.clone(),
            }
        }
        LoopPhase::AwaitingInferenceStart => {
            OperationalRecoveryAction::InferenceStartEvidenceRequired {
                invocation_id: invocation_id.clone(),
            }
        }
        LoopPhase::AwaitingApproval
        | LoopPhase::Completed
        | LoopPhase::Cancelled
        | LoopPhase::Failed => OperationalRecoveryAction::NoExecutableProjection,
    }
}

#[allow(clippy::too_many_arguments)]
fn source_fingerprint(
    run: &RunAggregate,
    assignment: Option<&RecoveredAssignment>,
    active_loop: Option<&(String, AgentLoopService, String)>,
    provider_attempt_ids: &[String],
    attempts: &[ProviderAttemptAggregate],
    tool_call_ids: &[String],
    tools: &[ToolCallAggregate],
    provider_bound: bool,
) -> Result<String, OperationalRecoveryScanError> {
    let provider_attempts = provider_attempt_ids
        .iter()
        .zip(attempts)
        .map(|(attempt_id, attempt)| {
            json!({
                "attemptId": attempt_id,
                "aggregateSequence": attempt.aggregate_sequence(),
                "state": provider_attempt_state_name(attempt.state()),
                "recovery": provider_attempt_recovery_name(attempt.recovery()),
                "definition": attempt.definition(),
                "response": attempt.response_receipt(),
                "responseTextSha256": attempt.response_text_sha256(),
            })
        })
        .collect::<Vec<_>>();
    let tool_calls = tool_call_ids
        .iter()
        .zip(tools)
        .map(|(tool_call_id, tool)| {
            json!({
                "toolCallId": tool_call_id,
                "aggregateSequence": tool.aggregate_sequence(),
                "state": tool_state_name(tool.state()),
                "authorization": tool_authorization_name(tool.authorization()),
                "outcomeKnowledge": tool.outcome_knowledge().map(tool_outcome_name),
                "definition": {
                    "providerToolCallId": tool.definition().provider_tool_call_id,
                    "toolName": tool.definition().tool_name,
                    "schemaVersion": tool.definition().schema_version,
                    "argumentsHash": tool.definition().arguments_hash,
                    "attempt": tool.definition().attempt,
                    "sideEffect": tool_side_effect_name(tool.definition().side_effect),
                    "parallel": tool.definition().parallel,
                },
            })
        })
        .collect::<Vec<_>>();
    let assignment = assignment.map(|value| {
        json!({
            "assignmentId": value.assignment_id,
            "revision": value.assignment_revision,
            "eventHash": value.assignment_event_hash,
            "status": assignment_status_name(&value.assignment_status),
            "classification": assignment_classification_name(&value.classification),
        })
    });
    let loop_evidence = active_loop.map(|(id, service, checkpoint_sha256)| {
        json!({
            "invocationId": id,
            "phase": loop_phase_name(service.phase()),
            "checkpointSha256": checkpoint_sha256,
        })
    });
    let pinned_identity_sha256 =
        novelx_protocol::child_run_pinned_identity_sha256(run.pinned_identity())
            .map_err(OperationalRecoveryScanError::FingerprintJson)?;
    let material = json!({
        "policyVersion": "operational-recovery-evidence-v1",
        "runId": run.run_id(),
        "runSequence": run.last_sequence(),
        "runState": run_state_name(run.state()),
        "pinnedIdentitySha256": pinned_identity_sha256,
        "assignment": assignment,
        "activeAgentLoop": loop_evidence,
        "providerAttempts": provider_attempts,
        "toolCalls": tool_calls,
        "exactProviderBound": provider_bound,
    });
    canonical_sha256(material)
}

fn canonical_sha256(value: serde_json::Value) -> Result<String, OperationalRecoveryScanError> {
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
        Sha256::digest(serde_json::to_vec(&canonicalize(value))?)
    ))
}

fn addresses_by_run(
    addresses: Vec<crate::event_journal::AggregateAddress>,
) -> BTreeMap<String, Vec<String>> {
    let mut by_run = BTreeMap::<String, Vec<String>>::new();
    for address in addresses {
        by_run
            .entry(address.run_id)
            .or_default()
            .push(address.aggregate_id);
    }
    for ids in by_run.values_mut() {
        ids.sort();
    }
    by_run
}

fn assignments_by_child_run(
    report: &AssignmentRecoveryReport,
) -> BTreeMap<String, &RecoveredAssignment> {
    report
        .assignments
        .iter()
        .filter_map(|assignment| {
            assignment
                .child_run_id
                .as_ref()
                .map(|run_id| (run_id.clone(), assignment))
        })
        .collect()
}

fn run_state_name(value: RunState) -> &'static str {
    match value {
        RunState::Created => "created",
        RunState::Preparing => "preparing",
        RunState::Running => "running",
        RunState::WaitingForApproval => "waiting_for_approval",
        RunState::WaitingForReconciliation => "waiting_for_reconciliation",
        RunState::Committing => "committing",
        RunState::Retrying => "retrying",
        RunState::Blocked => "blocked",
        RunState::Cancelled => "cancelled",
        RunState::Failed => "failed",
        RunState::Completed => "completed",
    }
}

fn provider_attempt_state_name(value: ProviderAttemptState) -> &'static str {
    match value {
        ProviderAttemptState::Requested => "requested",
        ProviderAttemptState::Sent => "sent",
        ProviderAttemptState::Responded => "responded",
        ProviderAttemptState::Failed => "failed",
        ProviderAttemptState::OutcomeUnknown => "outcome_unknown",
    }
}

fn provider_attempt_recovery_name(value: ProviderAttemptRecovery) -> &'static str {
    match value {
        ProviderAttemptRecovery::SafeToSend => "safe_to_send",
        ProviderAttemptRecovery::OutcomeUnknown => "outcome_unknown",
        ProviderAttemptRecovery::Completed => "completed",
        ProviderAttemptRecovery::RetryEligible => "retry_eligible",
        ProviderAttemptRecovery::TerminalFailure => "terminal_failure",
    }
}

fn tool_state_name(value: ToolState) -> &'static str {
    match value {
        ToolState::Requested => "requested",
        ToolState::Authorized => "authorized",
        ToolState::Running => "running",
        ToolState::Completed => "completed",
        ToolState::Failed => "failed",
        ToolState::Denied => "denied",
        ToolState::Cancelled => "cancelled",
        ToolState::TimedOut => "timed_out",
    }
}

fn tool_authorization_name(value: ToolAuthorization) -> &'static str {
    match value {
        ToolAuthorization::Pending => "pending",
        ToolAuthorization::Allowed => "allowed",
        ToolAuthorization::ApprovalRequired => "approval_required",
        ToolAuthorization::Denied => "denied",
    }
}

fn tool_outcome_name(value: ToolOutcomeKnowledge) -> &'static str {
    match value {
        ToolOutcomeKnowledge::Known => "known",
        ToolOutcomeKnowledge::Unknown => "unknown",
    }
}

fn tool_side_effect_name(value: ToolSideEffect) -> &'static str {
    match value {
        ToolSideEffect::None => "none",
        ToolSideEffect::StagedWrite => "staged_write",
        ToolSideEffect::ExternalEffect => "external_effect",
    }
}

fn loop_phase_name(value: LoopPhase) -> &'static str {
    match value {
        LoopPhase::AwaitingProvider => "awaiting_provider",
        LoopPhase::AwaitingApproval => "awaiting_approval",
        LoopPhase::AwaitingToolResults => "awaiting_tool_results",
        LoopPhase::AwaitingContextCompilation => "awaiting_context_compilation",
        LoopPhase::AwaitingInferenceStart => "awaiting_inference_start",
        LoopPhase::Completed => "completed",
        LoopPhase::Cancelled => "cancelled",
        LoopPhase::Failed => "failed",
    }
}

fn assignment_status_name(value: &AgentAssignmentStatus) -> &'static str {
    match value {
        AgentAssignmentStatus::Allocated => "allocated",
        AgentAssignmentStatus::Running => "running",
        AgentAssignmentStatus::CancelRequested => "cancel_requested",
        AgentAssignmentStatus::Cancelled => "cancelled",
        AgentAssignmentStatus::Completed => "completed",
        AgentAssignmentStatus::Failed => "failed",
    }
}

fn assignment_classification_name(value: &AssignmentRecoveryClassification) -> &'static str {
    match value {
        AssignmentRecoveryClassification::AwaitingDispatch => "awaiting_dispatch",
        AssignmentRecoveryClassification::ProvisionChildRun => "provision_child_run",
        AssignmentRecoveryClassification::RunningChild(_) => "running_child",
        AssignmentRecoveryClassification::ReadyToConfirmCancellation => {
            "ready_to_confirm_cancellation"
        }
        AssignmentRecoveryClassification::CancellationPending => "cancellation_pending",
        AssignmentRecoveryClassification::ReconciliationRequired => "reconciliation_required",
        AssignmentRecoveryClassification::TerminalConfirmed => "terminal_confirmed",
        AssignmentRecoveryClassification::Quarantined => "quarantined",
    }
}

fn assignment_quarantine(report: &AssignmentRecoveryReport) -> BTreeMap<String, Vec<String>> {
    let mut quarantined = BTreeMap::<String, Vec<String>>::new();
    for item in &report.quarantined {
        if let Some(run_id) = &item.child_run_id {
            quarantined
                .entry(run_id.clone())
                .or_default()
                .push(format!("assignment_quarantined:{}", item.assignment_id));
        }
    }
    for assignment in &report.assignments {
        if assignment.classification == AssignmentRecoveryClassification::Quarantined
            && let Some(run_id) = &assignment.child_run_id
        {
            quarantined.entry(run_id.clone()).or_default().push(format!(
                "assignment_quarantined:{}",
                assignment.assignment_id
            ));
        }
    }
    for reasons in quarantined.values_mut() {
        let unique = reasons.drain(..).collect::<BTreeSet<_>>();
        reasons.extend(unique);
    }
    quarantined
}

fn require_text(field: &'static str, value: &str) -> Result<(), OperationalRecoveryScanError> {
    if value.trim().is_empty() {
        Err(OperationalRecoveryScanError::EmptyField(field))
    } else {
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum OperationalRecoveryScanError {
    #[error("operational recovery field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("run aggregate address mismatch for run `{run_id}` and aggregate `{aggregate_id}`")]
    RunAddressMismatch {
        run_id: String,
        aggregate_id: String,
    },
    #[error("run `{run_id}` recovery failed: {source}")]
    RunRecoveryFailed {
        run_id: String,
        #[source]
        source: RunAggregateError,
    },
    #[error("agent loop `{invocation_id}` in run `{run_id}` recovery failed: {source}")]
    AgentLoopRecoveryFailed {
        run_id: String,
        invocation_id: String,
        #[source]
        source: crate::agent_loop_journal::AgentLoopJournalError,
    },
    #[error("agent loop `{invocation_id}` in run `{run_id}` checkpoint hash failed: {source}")]
    AgentLoopCheckpointFailed {
        run_id: String,
        invocation_id: String,
        #[source]
        source: crate::agent_loop_service::AgentLoopError,
    },
    #[error("provider attempt `{attempt_id}` in run `{run_id}` recovery failed: {source}")]
    ProviderAttemptRecoveryFailed {
        run_id: String,
        attempt_id: String,
        #[source]
        source: ProviderAttemptError,
    },
    #[error("tool call `{tool_call_id}` in run `{run_id}` recovery failed: {source}")]
    ToolRecoveryFailed {
        run_id: String,
        tool_call_id: String,
        #[source]
        source: ToolAggregateError,
    },
    #[error("operational recovery evidence JSON failed: {0}")]
    FingerprintJson(#[from] serde_json::Error),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
}
