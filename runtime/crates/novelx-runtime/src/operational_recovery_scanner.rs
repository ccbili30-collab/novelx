use std::collections::{BTreeMap, BTreeSet};

use novelx_protocol::ProviderRunIdentity;
use thiserror::Error;

use crate::{
    agent_assignment_recovery::{
        AssignmentRecoveryClassification, AssignmentRecoveryReport, RecoveredAssignment,
    },
    agent_loop_journal::AgentLoopJournalRepository,
    agent_loop_service::LoopPhase,
    event_journal::{EventJournal, EventJournalError},
    provider_attempt::{
        ProviderAttemptAggregate, ProviderAttemptError, ProviderAttemptRecovery,
        ProviderAttemptState,
    },
    run_aggregate::{RunAggregate, RunAggregateError},
    run_state::RunState,
    tool_aggregate::{ToolAggregateError, ToolCallAggregate},
    tool_state::{ToolAuthorization, ToolOutcomeKnowledge, ToolState},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationalRecoveryGate {
    AwaitingProviderBinding,
    WaitingForApproval,
    WaitingForReconciliation,
    RecoveryReady,
    Quarantined,
    TerminalProjectionOnly,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRecoveryRun {
    pub run_id: String,
    pub run_state: RunState,
    pub gate: OperationalRecoveryGate,
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
                active_loops.push((invocation_id.clone(), record.service.phase()));
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
                .is_some_and(|(_, phase)| *phase == LoopPhase::AwaitingApproval)
            || tools.iter().any(|tool| {
                tool.authorization() == ToolAuthorization::ApprovalRequired
                    && tool.state() == ToolState::Requested
            });
        let has_recoverable_evidence = attempts.iter().any(|attempt| {
            matches!(
                attempt.recovery(),
                ProviderAttemptRecovery::Completed | ProviderAttemptRecovery::TerminalFailure
            )
        }) || tools.iter().any(|tool| tool.state().is_terminal());
        let local_continuation = active_loop.as_ref().is_some_and(|(_, phase)| {
            matches!(
                phase,
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

        let gate = if !reasons.is_empty() {
            OperationalRecoveryGate::Quarantined
        } else if provider_unknown || tool_unknown {
            if provider_unknown {
                reasons.push("provider_outcome_unknown".to_owned());
            }
            if tool_unknown {
                reasons.push("tool_outcome_unknown_or_manifest_missing".to_owned());
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

        Ok(OperationalRecoveryRun {
            run_id: run_id.to_owned(),
            run_state: run.state(),
            gate,
            active_agent_loop_id: active_loop.as_ref().map(|(id, _)| id.clone()),
            active_agent_loop_phase: active_loop.map(|(_, phase)| phase),
            provider_attempt_states: attempts
                .iter()
                .map(ProviderAttemptAggregate::state)
                .collect(),
            tool_states: tools.iter().map(ToolCallAggregate::state).collect(),
            reasons,
        })
    }
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
    #[error(transparent)]
    Journal(#[from] EventJournalError),
}
