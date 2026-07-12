use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::sync::Arc;

use novelx_protocol::{
    AgentAssignmentComplete, AgentAssignmentConfirmCancelled, AgentAssignmentCreate,
    AgentAssignmentFail, AgentAssignmentGet, AgentAssignmentRequestCancel, AgentAssignmentStart,
    ContextCompilationReceipt, ContextCompile, Envelope, GoalComplete, GoalCompletionPropose,
    GoalCreate, GoalGet, GoalRevise, MessageType, PROTOCOL_VERSION, PlanCreate, PlanGet,
    PlanRevise, PlanStepComplete, PlanStepStart, ProviderInferenceCompleted,
    ProviderInferenceStart, RunCancel, RunPrepare, RunReconcile, RunReconciliationReceipt,
    RunSnapshot, RunStart, RuntimeBuild, RuntimeError, RuntimeErrorClass, RuntimeHello,
    RuntimeIdentity, RuntimeInitialize, RuntimeReady, RuntimeStatus, RuntimeStopped,
    ToolAuthorizationResolve, ToolAuthorizationResolved, ToolAuthorizationResolvedStatus,
    ToolRequest,
};
use novelx_runtime::agent_assignment_command_service::{
    AgentAssignmentCommandFailure, AgentAssignmentCommandService,
};
use novelx_runtime::agent_assignment_recovery::{
    AgentAssignmentRecoveryError, AssignmentRecoveryReport, recover_agent_assignments,
};
use novelx_runtime::agent_loop_journal::AgentLoopJournalRepository;
use novelx_runtime::context_compile_service::{
    ContextCompileService, ContextCompileServiceError, recover_compilation_receipt,
};
use novelx_runtime::event_journal::{EventJournal, EventJournalError};
use novelx_runtime::goal_plan_command_service::{GoalPlanCommandFailure, GoalPlanCommandService};
use novelx_runtime::live_agent_loop_runner::{
    LiveAgentLoopOutcome, LiveAgentLoopProgress, LiveAgentLoopRunner,
};
use novelx_runtime::operational_recovery_recording_service::{
    OperationalRecoveryRecordingError, OperationalRecoveryRecordingService,
};
use novelx_runtime::operational_recovery_scanner::{
    OperationalRecoveryGate, OperationalRecoveryRun, OperationalRecoveryScanError,
    OperationalRecoveryScanner,
};
use novelx_runtime::project_path::ProjectRoot;
use novelx_runtime::project_tool_execution_service::{
    ProjectToolExecutionOutcome, ProjectToolExecutionService,
};
use novelx_runtime::provider_gateway::{
    ProviderBindSensitiveEnvelope, ProviderGateway, ProviderGatewayError, ProviderInferenceOutcome,
    ProviderInferenceRequest, ProviderRegistry,
};
use novelx_runtime::provider_inference_protocol::ProviderInferenceProtocolMapper;
use novelx_runtime::provider_inference_service::{
    PreparedProviderAttempt, ProviderInferenceExecution, ProviderInferenceService,
    ProviderInferenceServiceError,
};
use novelx_runtime::recovery::{RecoveryCoordinator, RecoveryError};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate, RunAggregateError};
use novelx_runtime::run_command_service::{RunCommandFailure, RunCommandService, WorkspaceBinding};
use novelx_runtime::run_pin_validator::RunPinValidator;
use novelx_runtime::run_reconciliation_service::{
    RunReconciliationService, RunReconciliationServiceError,
};
use novelx_runtime::run_state::RunState;
use novelx_runtime::runtime_actor::{
    RuntimeActor, RuntimeActorHandle, RuntimeOutputDraft, RuntimeTaskKey, RuntimeTaskProgressSender,
};
use novelx_runtime::tool_protocol_mapper::ToolProtocolMapper;
use novelx_runtime::{
    agent_loop_service::AgentLoopPolicy,
    live_agent_loop_runner::LiveAgentLoopError,
    tool_coordination_service::{ToolCoordinationSnapshot, ToolCoordinationStatus},
    tool_state::{ToolAuthorization, ToolState},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sent_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    let hello = RuntimeHello {
        runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
        protocol_versions: vec![PROTOCOL_VERSION],
        capabilities: vec![
            "handshake".to_owned(),
            "runtime_control".to_owned(),
            "runs_v1".to_owned(),
            "run_reconciliation_v1".to_owned(),
            "contexts_v1".to_owned(),
            "provider_inference_v1".to_owned(),
            "goals_v1".to_owned(),
            "plans_v1".to_owned(),
            "agent_assignments_v1".to_owned(),
        ],
        build: RuntimeBuild {
            commit: option_env!("NOVELX_BUILD_COMMIT")
                .unwrap_or("development")
                .to_owned(),
            target: option_env!("NOVELX_BUILD_TARGET")
                .unwrap_or(std::env::consts::ARCH)
                .to_owned(),
        },
    };
    let hello_envelope = Envelope::new(MessageType::Control, "runtime.hello", sent_at, 1, hello)?;

    let mut output = tokio::io::stdout();
    write_handshake_envelope(&mut output, &hello_envelope).await?;

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let initialize_line = lines
        .next_line()
        .await?
        .ok_or("runtime.initialize was not received")?;
    let initialize_envelope: Envelope = serde_json::from_str(&initialize_line)?;
    if let Err(error) = validate_initialize_envelope(&initialize_envelope) {
        write_protocol_error(&mut output, initialize_envelope.message_id, 2, &error).await?;
        return Err(io::Error::new(io::ErrorKind::InvalidData, error).into());
    }
    let initialize: RuntimeInitialize =
        match serde_json::from_value(initialize_envelope.payload.clone()) {
            Ok(initialize) => initialize,
            Err(error) => {
                let error = format!("invalid runtime.initialize payload: {error}");
                write_protocol_error(&mut output, initialize_envelope.message_id, 2, &error)
                    .await?;
                return Err(io::Error::new(io::ErrorKind::InvalidData, error).into());
            }
        };
    if initialize.selected_protocol_version != PROTOCOL_VERSION {
        let error = format!(
            "runtime.initialize selected unsupported protocol version {}",
            initialize.selected_protocol_version
        );
        write_protocol_error(&mut output, initialize_envelope.message_id, 2, &error).await?;
        return Err(io::Error::new(io::ErrorKind::InvalidData, error).into());
    }
    let workspace_binding = match (
        initialize.workspace_database_path.as_ref(),
        initialize.project_root_path.as_ref(),
        initialize.project_id.as_ref(),
        initialize.workspace_id.as_ref(),
    ) {
        (None, None, None, None) => None,
        (Some(_), Some(_), Some(project_id), Some(workspace_id))
            if !project_id.trim().is_empty() && !workspace_id.trim().is_empty() =>
        {
            Some(WorkspaceBinding {
                project_id: project_id.clone(),
                workspace_id: workspace_id.clone(),
            })
        }
        _ => {
            let error = "runtime.initialize requires projectRootPath, projectId and workspaceId exactly when workspaceDatabasePath is configured";
            write_protocol_error(&mut output, initialize_envelope.message_id, 2, error).await?;
            return Err(io::Error::new(io::ErrorKind::InvalidData, error).into());
        }
    };

    let project_root = match initialize.project_root_path.as_deref() {
        None => None,
        Some(path) => match ProjectRoot::open(path) {
            Ok(root) => Some(root),
            Err(error) => {
                let message = format!("runtime project root binding failed: {error}");
                write_protocol_error(&mut output, initialize_envelope.message_id, 2, &message)
                    .await?;
                return Err(io::Error::new(io::ErrorKind::InvalidInput, message).into());
            }
        },
    };

    let (
        mut journal,
        recovered_run_count,
        assignment_recovery_report,
        mut operational_recovery_runs,
        quarantined_assignment_ids,
    ) = match initialize.workspace_database_path.as_deref() {
        None => (
            None,
            0,
            AssignmentRecoveryReport {
                assignments: vec![],
                quarantined: vec![],
            },
            BTreeMap::new(),
            BTreeSet::new(),
        ),
        Some(path) => match initialize_runtime(
            path,
            workspace_binding
                .as_ref()
                .expect("validated workspace binding"),
        ) {
            Ok(state) => (
                Some(state.journal),
                state.recovered_run_count,
                state.assignment_report,
                state.operational_runs,
                state.quarantined_assignment_ids,
            ),
            Err(error) => {
                let diagnostic_id = Uuid::new_v4();
                write_initialization_failed(
                    &mut output,
                    initialize_envelope.message_id,
                    diagnostic_id,
                    &error,
                )
                .await?;
                return Err(
                    format!("runtime initialization failed [{diagnostic_id}]: {error}").into(),
                );
            }
        },
    };

    let sent_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    let mut ready_envelope = Envelope::new(
        MessageType::Control,
        "runtime.ready",
        sent_at,
        2,
        RuntimeReady {
            selected_protocol_version: PROTOCOL_VERSION,
            runtime: RuntimeIdentity {
                version: env!("CARGO_PKG_VERSION").to_owned(),
                build: RuntimeBuild {
                    commit: option_env!("NOVELX_BUILD_COMMIT")
                        .unwrap_or("development")
                        .to_owned(),
                    target: option_env!("NOVELX_BUILD_TARGET")
                        .unwrap_or(std::env::consts::ARCH)
                        .to_owned(),
                },
            },
            recovered_run_count,
        },
    )?;
    ready_envelope.correlation_id = Some(initialize_envelope.message_id);
    write_handshake_envelope(&mut output, &ready_envelope).await?;

    let mut provider_registry = ProviderRegistry::default();
    let provider_gateway = Arc::new(ProviderGateway::new()?);
    let (actor, actor_handle) = RuntimeActor::new(output, 2, 64);
    let actor_task = tokio::spawn(actor.run());
    let mut command_context = RuntimeCommandContext {
        workspace_database_path: initialize.workspace_database_path.as_deref(),
        recovered_run_count,
        journal: &mut journal,
        workspace_binding: workspace_binding.as_ref(),
        assignment_recovery_report: &assignment_recovery_report,
        operational_recovery_runs: &mut operational_recovery_runs,
        quarantined_assignment_ids: &quarantined_assignment_ids,
        provider_registry: &mut provider_registry,
        provider_gateway: &provider_gateway,
        project_root: project_root.as_ref(),
    };
    let loop_result = run_command_loop(&mut lines, &actor_handle, &mut command_context).await;
    drop(actor_handle);
    let actor_result = actor_task.await?;
    loop_result?;
    actor_result?;
    Ok(())
}

fn validate_initialize_envelope(envelope: &Envelope) -> Result<(), String> {
    envelope
        .validate_version()
        .map_err(|error| error.to_string())?;
    if envelope.message_type != MessageType::Command {
        return Err("runtime.initialize must be a command message".to_owned());
    }
    if envelope.name != "runtime.initialize" {
        return Err(format!("unexpected handshake message: {}", envelope.name));
    }
    if envelope.correlation_id.is_some() {
        return Err("runtime.initialize must not include correlationId".to_owned());
    }
    if envelope.run_id.is_some() {
        return Err("runtime.initialize must not include runId".to_owned());
    }
    if envelope.sequence != 1 {
        return Err(format!(
            "runtime.initialize sequence must be 1, received {}",
            envelope.sequence
        ));
    }
    Ok(())
}

async fn run_command_loop(
    lines: &mut tokio::io::Lines<BufReader<tokio::io::Stdin>>,
    output: &RuntimeActorHandle,
    context: &mut RuntimeCommandContext<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut expected_host_sequence = 2_u64;
    while let Some(line) = lines.next_line().await? {
        let value: serde_json::Value = serde_json::from_str(&line)?;
        if value.get("messageType").and_then(serde_json::Value::as_str) == Some("sensitive_command")
        {
            let sensitive: ProviderBindSensitiveEnvelope = serde_json::from_value(value)?;
            if let Err(error) = sensitive.validate(expected_host_sequence) {
                output
                    .emit(protocol_error_draft(
                        sensitive.message_id,
                        &error.to_string(),
                    )?)
                    .await?;
                return Err(io::Error::new(io::ErrorKind::InvalidData, error.to_string()).into());
            }
            output
                .emit(handle_provider_bind(sensitive, context)?)
                .await?;
            expected_host_sequence += 1;
            continue;
        }
        let command: Envelope = serde_json::from_value(value)?;
        if let Err(error) = validate_command(&command, expected_host_sequence) {
            output
                .emit(protocol_error_draft(command.message_id, &error)?)
                .await?;
            return Err(io::Error::new(io::ErrorKind::InvalidData, error).into());
        }
        if let Some(rejected) = operational_recovery_guard(&command, context)? {
            output.emit(rejected).await?;
            expected_host_sequence += 1;
            continue;
        }

        let routed = match command.name.as_str() {
            "runtime.status.get" => RoutedOutput::normal(response_draft(
                &command,
                "runtime.status",
                RuntimeStatus {
                    initialized: true,
                    workspace_database_configured: context.workspace_database_path.is_some(),
                    recovered_run_count: context.recovered_run_count,
                    protocol_version: PROTOCOL_VERSION,
                    runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
                },
            )?),
            "goal.create"
            | "goal.get"
            | "goal.revise"
            | "goal.completion.propose"
            | "goal.complete"
            | "plan.create"
            | "plan.get"
            | "plan.revise"
            | "plan.step.start"
            | "plan.step.complete" => handle_goal_plan_command(
                &command,
                context.workspace_database_path,
                context.workspace_binding,
            )?,
            "agent.assignment.create"
            | "agent.assignment.get"
            | "agent.assignment.start"
            | "agent.assignment.request_cancel"
            | "agent.assignment.confirm_cancelled"
            | "agent.assignment.complete"
            | "agent.assignment.fail" => handle_agent_assignment_command(
                &command,
                context.workspace_database_path,
                context.workspace_binding,
                context.quarantined_assignment_ids,
            )?,
            "runtime.shutdown" => {
                output
                    .shutdown(response_draft(
                        &command,
                        "runtime.stopped",
                        RuntimeStopped {
                            reason: "requested".to_owned(),
                        },
                    )?)
                    .await?;
                return Ok(());
            }
            "run.start" => handle_run_start(
                &command,
                context.journal,
                context.workspace_binding,
                context.workspace_database_path,
            )?,
            "run.get" => handle_run_get(&command, context.journal)?,
            "run.cancel" => {
                let run_id = command.run_id.expect("validated run.cancel runId");
                let active_tasks = output.active_run_tasks(run_id).await?;
                if active_tasks.is_empty() {
                    handle_run_cancel(&command, context.journal)?
                } else {
                    let routed =
                        handle_active_inference_cancel(&command, context.journal, &active_tasks)?;
                    output.emit(routed.output).await?;
                    output.cancel_run(run_id).await?;
                    expected_host_sequence += 1;
                    continue;
                }
            }
            "run.prepare" => {
                handle_run_prepare(&command, context.journal, context.provider_registry)?
            }
            "run.reconcile" => {
                let routed = handle_run_reconcile(&command, context.journal)?;
                refresh_operational_recovery(context)?;
                routed
            }
            "context.compile" => {
                handle_context_compile(&command, context.journal, context.provider_registry)?
            }
            "tool.authorization.resolve" => {
                handle_tool_authorization_resolve(output, &command, context).await?;
                refresh_operational_recovery(context)?;
                expected_host_sequence += 1;
                continue;
            }
            "provider.inference.start" => {
                handle_provider_inference_start(
                    output,
                    &command,
                    context.journal,
                    context.workspace_database_path,
                    context.project_root,
                    context
                        .workspace_binding
                        .map(|binding| binding.project_id.as_str()),
                    context.provider_registry,
                    context.provider_gateway,
                )
                .await?;
                expected_host_sequence += 1;
                continue;
            }
            _ => unreachable!("validated command name"),
        };
        output.emit(routed.output).await?;
        if routed.fatal {
            return Err(io::Error::new(io::ErrorKind::InvalidData, routed.fatal_message).into());
        }
        expected_host_sequence += 1;
    }

    Ok(())
}

fn operational_recovery_guard(
    command: &Envelope,
    context: &RuntimeCommandContext<'_>,
) -> Result<Option<RuntimeOutputDraft>, Box<dyn std::error::Error>> {
    let Some(run_id) = command.run_id else {
        return Ok(None);
    };
    let run_id_text = run_id.to_string();
    let Some(recovery) = context.operational_recovery_runs.get(&run_id_text) else {
        return Ok(None);
    };
    let is_assignment_child = context
        .assignment_recovery_report
        .assignments
        .iter()
        .any(|assignment| assignment.child_run_id.as_deref() == Some(run_id_text.as_str()));
    if !is_assignment_child {
        return Ok(None);
    }
    let allowed = match command.name.as_str() {
        "run.get" => true,
        "run.start" => recovery.gate != OperationalRecoveryGate::Quarantined,
        "run.reconcile" => recovery.gate == OperationalRecoveryGate::WaitingForReconciliation,
        "tool.authorization.resolve" => {
            recovery.gate == OperationalRecoveryGate::WaitingForApproval
        }
        _ => false,
    };
    if allowed {
        return Ok(None);
    }
    let (code, class, retryable) = match recovery.gate {
        OperationalRecoveryGate::AwaitingProviderBinding => (
            "RUN_RECOVERY_AWAITING_PROVIDER_BINDING",
            RuntimeErrorClass::ProviderAuth,
            true,
        ),
        OperationalRecoveryGate::WaitingForApproval => (
            "RUN_RECOVERY_APPROVAL_REQUIRED",
            RuntimeErrorClass::ToolPermission,
            false,
        ),
        OperationalRecoveryGate::WaitingForReconciliation => (
            "RUN_RECOVERY_RECONCILIATION_REQUIRED",
            RuntimeErrorClass::SourceConflict,
            false,
        ),
        OperationalRecoveryGate::RecoveryReady => (
            "RUN_RECOVERY_OPERATION_REQUIRED",
            RuntimeErrorClass::Protocol,
            false,
        ),
        OperationalRecoveryGate::Quarantined => (
            "RUN_RECOVERY_QUARANTINED",
            RuntimeErrorClass::SourceConflict,
            false,
        ),
        OperationalRecoveryGate::TerminalProjectionOnly => (
            "RUN_RECOVERY_TERMINAL",
            RuntimeErrorClass::Validation,
            false,
        ),
    };
    let message = operational_recovery_public_message(recovery.gate);
    let mut rejected = response_draft(
        command,
        if command.name.starts_with("run.") {
            "run.rejected"
        } else {
            "runtime.error"
        },
        RuntimeError {
            code: code.to_owned(),
            class,
            retryable,
            public_message: message.to_owned(),
            stage: "operational_recovery.gate".to_owned(),
            attempt: 0,
            diagnostic_id: Uuid::new_v4(),
        },
    )?;
    rejected.run_id = Some(run_id);
    Ok(Some(rejected))
}

fn operational_recovery_public_message(gate: OperationalRecoveryGate) -> &'static str {
    match gate {
        OperationalRecoveryGate::AwaitingProviderBinding => {
            "\u{8be5}\u{8fd0}\u{884c}\u{6b63}\u{5728}\u{7b49}\u{5f85}\u{5b8c}\u{5168}\u{5339}\u{914d}\u{7684}\u{6a21}\u{578b}\u{670d}\u{52a1}\u{914d}\u{7f6e}\u{ff0c}\u{5c1a}\u{672a}\u{7ee7}\u{7eed}\u{6267}\u{884c}\u{3002}"
        }
        OperationalRecoveryGate::WaitingForApproval => {
            "\u{8be5}\u{8fd0}\u{884c}\u{6b63}\u{5728}\u{7b49}\u{5f85}\u{7528}\u{6237}\u{5904}\u{7406}\u{5df2}\u{6709}\u{5ba1}\u{6279}\u{ff0c}\u{4e0d}\u{80fd}\u{6267}\u{884c}\u{5176}\u{4ed6}\u{6062}\u{590d}\u{64cd}\u{4f5c}\u{3002}"
        }
        OperationalRecoveryGate::WaitingForReconciliation => {
            "\u{8be5}\u{8fd0}\u{884c}\u{5b58}\u{5728}\u{7ed3}\u{679c}\u{672a}\u{77e5}\u{7684}\u{5916}\u{90e8}\u{64cd}\u{4f5c}\u{ff0c}\u{5fc5}\u{987b}\u{5148}\u{5b8c}\u{6210}\u{5bf9}\u{8d26}\u{3002}"
        }
        OperationalRecoveryGate::RecoveryReady => {
            "\u{8be5}\u{8fd0}\u{884c}\u{5df2}\u{5177}\u{5907}\u{6062}\u{590d}\u{6761}\u{4ef6}\u{ff0c}\u{4f46}\u{53ea}\u{80fd}\u{7531}\u{53d7}\u{5ba1}\u{8ba1}\u{7684}\u{6062}\u{590d}\u{64cd}\u{4f5c}\u{7ee7}\u{7eed}\u{3002}"
        }
        OperationalRecoveryGate::Quarantined => {
            "\u{8be5}\u{8fd0}\u{884c}\u{7684}\u{6062}\u{590d}\u{8bc1}\u{636e}\u{5b58}\u{5728}\u{51b2}\u{7a81}\u{ff0c}\u{5df2}\u{88ab}\u{9694}\u{79bb}\u{3002}"
        }
        OperationalRecoveryGate::TerminalProjectionOnly => {
            "\u{8be5}\u{8fd0}\u{884c}\u{5df2}\u{7ecf}\u{7ed3}\u{675f}\u{ff0c}\u{53ea}\u{80fd}\u{8bfb}\u{53d6}\u{5176}\u{6301}\u{4e45}\u{5316}\u{7ed3}\u{679c}\u{3002}"
        }
    }
}

struct RuntimeCommandContext<'a> {
    workspace_database_path: Option<&'a str>,
    recovered_run_count: u64,
    journal: &'a mut Option<EventJournal>,
    workspace_binding: Option<&'a WorkspaceBinding>,
    assignment_recovery_report: &'a AssignmentRecoveryReport,
    operational_recovery_runs: &'a mut BTreeMap<String, OperationalRecoveryRun>,
    quarantined_assignment_ids: &'a BTreeSet<String>,
    provider_registry: &'a mut ProviderRegistry,
    provider_gateway: &'a Arc<ProviderGateway>,
    project_root: Option<&'a ProjectRoot>,
}

fn validate_command(command: &Envelope, expected_sequence: u64) -> Result<(), String> {
    command
        .validate_version()
        .map_err(|error| error.to_string())?;
    if command.message_type != MessageType::Command {
        return Err("runtime messages after initialization must be commands".to_owned());
    }
    if command.correlation_id.is_some() {
        return Err("runtime commands must not include correlationId".to_owned());
    }
    if command.sequence != expected_sequence {
        return Err(format!(
            "host sequence must be {expected_sequence}, received {}",
            command.sequence
        ));
    }
    match command.name.as_str() {
        "runtime.status.get" | "runtime.shutdown" => {
            if command.run_id.is_some() {
                return Err("runtime control commands must not include runId".to_owned());
            }
            require_empty_payload(command)?;
        }
        "goal.create" => {
            require_workspace_command(command)?;
            serde_json::from_value::<GoalCreate>(command.payload.clone())
                .map_err(|error| format!("invalid goal.create payload: {error}"))?;
        }
        "goal.get" => {
            require_workspace_command(command)?;
            serde_json::from_value::<GoalGet>(command.payload.clone())
                .map_err(|error| format!("invalid goal.get payload: {error}"))?;
        }
        "goal.revise" => {
            require_workspace_command(command)?;
            serde_json::from_value::<GoalRevise>(command.payload.clone())
                .map_err(|error| format!("invalid goal.revise payload: {error}"))?;
        }
        "goal.completion.propose" => {
            require_workspace_command(command)?;
            serde_json::from_value::<GoalCompletionPropose>(command.payload.clone())
                .map_err(|error| format!("invalid goal.completion.propose payload: {error}"))?;
        }
        "goal.complete" => {
            require_workspace_command(command)?;
            serde_json::from_value::<GoalComplete>(command.payload.clone())
                .map_err(|error| format!("invalid goal.complete payload: {error}"))?;
        }
        "plan.create" => {
            require_workspace_command(command)?;
            serde_json::from_value::<PlanCreate>(command.payload.clone())
                .map_err(|error| format!("invalid plan.create payload: {error}"))?;
        }
        "plan.get" => {
            require_workspace_command(command)?;
            serde_json::from_value::<PlanGet>(command.payload.clone())
                .map_err(|error| format!("invalid plan.get payload: {error}"))?;
        }
        "plan.revise" => {
            require_workspace_command(command)?;
            serde_json::from_value::<PlanRevise>(command.payload.clone())
                .map_err(|error| format!("invalid plan.revise payload: {error}"))?;
        }
        "plan.step.start" => {
            require_workspace_command(command)?;
            serde_json::from_value::<PlanStepStart>(command.payload.clone())
                .map_err(|error| format!("invalid plan.step.start payload: {error}"))?;
        }
        "plan.step.complete" => {
            require_workspace_command(command)?;
            serde_json::from_value::<PlanStepComplete>(command.payload.clone())
                .map_err(|error| format!("invalid plan.step.complete payload: {error}"))?;
        }
        "agent.assignment.create" => {
            require_workspace_command(command)?;
            serde_json::from_value::<AgentAssignmentCreate>(command.payload.clone())
                .map_err(|error| format!("invalid agent.assignment.create payload: {error}"))?;
        }
        "agent.assignment.get" => {
            require_workspace_command(command)?;
            serde_json::from_value::<AgentAssignmentGet>(command.payload.clone())
                .map_err(|error| format!("invalid agent.assignment.get payload: {error}"))?;
        }
        "agent.assignment.start" => {
            require_workspace_command(command)?;
            serde_json::from_value::<AgentAssignmentStart>(command.payload.clone())
                .map_err(|error| format!("invalid agent.assignment.start payload: {error}"))?;
        }
        "agent.assignment.request_cancel" => {
            require_workspace_command(command)?;
            serde_json::from_value::<AgentAssignmentRequestCancel>(command.payload.clone())
                .map_err(|error| {
                    format!("invalid agent.assignment.request_cancel payload: {error}")
                })?;
        }
        "agent.assignment.confirm_cancelled" => {
            require_workspace_command(command)?;
            serde_json::from_value::<AgentAssignmentConfirmCancelled>(command.payload.clone())
                .map_err(|error| {
                    format!("invalid agent.assignment.confirm_cancelled payload: {error}")
                })?;
        }
        "agent.assignment.complete" => {
            require_workspace_command(command)?;
            serde_json::from_value::<AgentAssignmentComplete>(command.payload.clone())
                .map_err(|error| format!("invalid agent.assignment.complete payload: {error}"))?;
        }
        "agent.assignment.fail" => {
            require_workspace_command(command)?;
            serde_json::from_value::<AgentAssignmentFail>(command.payload.clone())
                .map_err(|error| format!("invalid agent.assignment.fail payload: {error}"))?;
        }
        "run.start" => {
            if command.run_id.is_none() {
                return Err("run.start requires runId".to_owned());
            }
            serde_json::from_value::<RunStart>(command.payload.clone())
                .map_err(|error| format!("invalid run.start payload: {error}"))?;
        }
        "run.get" => {
            if command.run_id.is_none() {
                return Err("run.get requires runId".to_owned());
            }
            require_empty_payload(command)?;
        }
        "run.cancel" => {
            if command.run_id.is_none() {
                return Err("run.cancel requires runId".to_owned());
            }
            serde_json::from_value::<RunCancel>(command.payload.clone())
                .map_err(|error| format!("invalid run.cancel payload: {error}"))?;
        }
        "run.prepare" => {
            if command.run_id.is_none() {
                return Err("run.prepare requires runId".to_owned());
            }
            serde_json::from_value::<RunPrepare>(command.payload.clone())
                .map_err(|error| format!("invalid run.prepare payload: {error}"))?;
        }
        "run.reconcile" => {
            if command.run_id.is_none() {
                return Err("run.reconcile requires runId".to_owned());
            }
            let reconcile = serde_json::from_value::<RunReconcile>(command.payload.clone())
                .map_err(|error| format!("invalid run.reconcile payload: {error}"))?;
            reconcile
                .validate()
                .map_err(|error| format!("invalid run.reconcile payload: {error}"))?;
        }
        "context.compile" => {
            if command.run_id.is_none() {
                return Err("context.compile requires runId".to_owned());
            }
            serde_json::from_value::<ContextCompile>(command.payload.clone())
                .map_err(|error| format!("invalid context.compile payload: {error}"))?;
        }
        "tool.authorization.resolve" => {
            if command.run_id.is_none() {
                return Err("tool.authorization.resolve requires runId".to_owned());
            }
            serde_json::from_value::<ToolAuthorizationResolve>(command.payload.clone())
                .map_err(|error| format!("invalid tool.authorization.resolve payload: {error}"))?;
        }
        "provider.inference.start" => {
            if command.run_id.is_none() {
                return Err("provider.inference.start requires runId".to_owned());
            }
            let start = serde_json::from_value::<ProviderInferenceStart>(command.payload.clone())
                .map_err(|error| {
                format!("invalid provider.inference.start payload: {error}")
            })?;
            start
                .validate()
                .map_err(|error| format!("invalid provider.inference.start payload: {error}"))?;
            u16::try_from(start.attempt_number).map_err(|_| {
                "invalid provider.inference.start payload: attemptNumber exceeds u16".to_owned()
            })?;
        }
        _ => return Err(format!("unknown runtime command: {}", command.name)),
    }
    Ok(())
}

fn require_workspace_command(command: &Envelope) -> Result<(), String> {
    if command.run_id.is_some() {
        return Err(format!("{} must not include runId", command.name));
    }
    Ok(())
}

fn require_empty_payload(command: &Envelope) -> Result<(), String> {
    if matches!(command.payload.as_object(), Some(payload) if payload.is_empty()) {
        Ok(())
    } else {
        Err(format!("{} payload must be an empty object", command.name))
    }
}

fn handle_provider_bind(
    command: ProviderBindSensitiveEnvelope,
    context: &mut RuntimeCommandContext<'_>,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let correlation_id = command.message_id;
    let payload = command.payload;
    match context
        .provider_registry
        .bind(payload.config, &payload.config_sha256, payload.credential)
    {
        Ok(receipt) => {
            refresh_operational_recovery(context)?;
            correlated_response_draft(correlation_id, "provider.bound", receipt)
        }
        Err(error) => {
            eprintln!("provider.bind rejected: {error}");
            correlated_response_draft(
                correlation_id,
                "provider.rejected",
                provider_binding_error(&error),
            )
        }
    }
}

fn refresh_operational_recovery(
    context: &mut RuntimeCommandContext<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    let (Some(database_path), Some(binding), Some(journal)) = (
        context.workspace_database_path,
        context.workspace_binding,
        context.journal.as_mut(),
    ) else {
        return Ok(());
    };
    let providers = context.provider_registry.bound_identities();
    let report =
        OperationalRecoveryScanner::new(journal, context.assignment_recovery_report, &providers)
            .scan(&binding.workspace_id, &binding.project_id)?;
    let created_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    OperationalRecoveryRecordingService::new(database_path).record(
        &binding.workspace_id,
        &binding.project_id,
        &report,
        &created_at,
    )?;
    context.operational_recovery_runs.clear();
    context
        .operational_recovery_runs
        .extend(report.runs.into_iter().map(|run| (run.run_id.clone(), run)));
    Ok(())
}

fn provider_binding_error(error: &ProviderGatewayError) -> RuntimeError {
    let (code, class, public_message) = match error {
        ProviderGatewayError::CredentialInvalid | ProviderGatewayError::CredentialRequired => (
            "PROVIDER_CREDENTIAL_REQUIRED",
            RuntimeErrorClass::ProviderAuth,
            "模型服务凭据不可用。",
        ),
        ProviderGatewayError::ConfigHashMismatch | ProviderGatewayError::ProfileMismatch => (
            "PROVIDER_PROFILE_MISMATCH",
            RuntimeErrorClass::Validation,
            "模型服务配置与任务记录不一致。",
        ),
        _ => (
            "PROVIDER_CONFIG_INVALID",
            RuntimeErrorClass::Validation,
            "模型服务配置无效。",
        ),
    };
    RuntimeError {
        code: code.to_owned(),
        class,
        retryable: false,
        public_message: public_message.to_owned(),
        stage: "provider.bind".to_owned(),
        attempt: 0,
        diagnostic_id: Uuid::new_v4(),
    }
}

fn handle_goal_plan_command(
    command: &Envelope,
    workspace_database_path: Option<&str>,
    workspace_binding: Option<&WorkspaceBinding>,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    let Some(database_path) = workspace_database_path else {
        return goal_plan_command_failure(
            command,
            GoalPlanCommandFailure {
                error: Box::new(runtime_domain_error(
                    "RUNTIME_STORAGE_REQUIRED",
                    RuntimeErrorClass::Storage,
                    "当前运行时没有绑定工作区存储。",
                    "goal_plan.storage",
                )),
                internal_message: "Goal/Plan command requires workspace storage".to_owned(),
            },
        );
    };
    let Some(binding) = workspace_binding else {
        return goal_plan_command_failure(
            command,
            GoalPlanCommandFailure {
                error: Box::new(runtime_domain_error(
                    "RUNTIME_WORKSPACE_BINDING_REQUIRED",
                    RuntimeErrorClass::Validation,
                    "当前运行时缺少工作区和项目身份绑定。",
                    "goal_plan.binding",
                )),
                internal_message: "Goal/Plan command requires workspace binding".to_owned(),
            },
        );
    };
    let service = GoalPlanCommandService::new(database_path, binding);
    let result: Result<(&str, serde_json::Value), GoalPlanCommandFailure> =
        match command.name.as_str() {
            "goal.create" => service
                .create_goal(
                    command.message_id,
                    serde_json::from_value(command.payload.clone())?,
                )
                .and_then(|snapshot| serialized_domain_snapshot("goal.snapshot", snapshot)),
            "goal.get" => service
                .get_goal(serde_json::from_value(command.payload.clone())?)
                .and_then(|snapshot| serialized_domain_snapshot("goal.snapshot", snapshot)),
            "goal.revise" => service
                .revise_goal(
                    command.message_id,
                    serde_json::from_value(command.payload.clone())?,
                )
                .and_then(|snapshot| serialized_domain_snapshot("goal.snapshot", snapshot)),
            "goal.completion.propose" => service
                .propose_goal_completion(
                    command.message_id,
                    serde_json::from_value(command.payload.clone())?,
                )
                .and_then(|snapshot| serialized_domain_snapshot("goal.snapshot", snapshot)),
            "goal.complete" => service
                .complete_goal(
                    command.message_id,
                    serde_json::from_value(command.payload.clone())?,
                )
                .and_then(|snapshot| serialized_domain_snapshot("goal.snapshot", snapshot)),
            "plan.create" => service
                .create_plan(
                    command.message_id,
                    serde_json::from_value(command.payload.clone())?,
                )
                .and_then(|snapshot| serialized_domain_snapshot("plan.snapshot", snapshot)),
            "plan.get" => service
                .get_plan(serde_json::from_value(command.payload.clone())?)
                .and_then(|snapshot| serialized_domain_snapshot("plan.snapshot", snapshot)),
            "plan.revise" => service
                .revise_plan(
                    command.message_id,
                    serde_json::from_value(command.payload.clone())?,
                )
                .and_then(|snapshot| serialized_domain_snapshot("plan.snapshot", snapshot)),
            "plan.step.start" => service
                .start_plan_step(
                    command.message_id,
                    serde_json::from_value(command.payload.clone())?,
                )
                .and_then(|snapshot| serialized_domain_snapshot("plan.snapshot", snapshot)),
            "plan.step.complete" => service
                .complete_plan_step(
                    command.message_id,
                    serde_json::from_value(command.payload.clone())?,
                )
                .and_then(|snapshot| serialized_domain_snapshot("plan.snapshot", snapshot)),
            _ => unreachable!("validated Goal/Plan command"),
        };
    match result {
        Ok((name, payload)) => {
            let mut response = response_draft(command, name, payload)?;
            response.run_id = None;
            Ok(RoutedOutput::normal(response))
        }
        Err(failure) => goal_plan_command_failure(command, failure),
    }
}

fn serialized_domain_snapshot<T: serde::Serialize>(
    name: &'static str,
    snapshot: T,
) -> Result<(&'static str, serde_json::Value), GoalPlanCommandFailure> {
    serde_json::to_value(snapshot)
        .map(|payload| (name, payload))
        .map_err(|error| GoalPlanCommandFailure {
            error: Box::new(runtime_domain_error(
                "GOAL_PLAN_SNAPSHOT_SERIALIZATION_FAILED",
                RuntimeErrorClass::RuntimeCrash,
                "目标或计划状态无法序列化。",
                "goal_plan.snapshot",
            )),
            internal_message: error.to_string(),
        })
}

fn goal_plan_command_failure(
    command: &Envelope,
    failure: GoalPlanCommandFailure,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    eprintln!("Goal/Plan command rejected: {}", failure.internal_message);
    let name = if command.name.starts_with("goal.") {
        "goal.rejected"
    } else {
        "plan.rejected"
    };
    Ok(RoutedOutput::normal(response_draft(
        command,
        name,
        *failure.error,
    )?))
}

fn handle_agent_assignment_command(
    command: &Envelope,
    workspace_database_path: Option<&str>,
    workspace_binding: Option<&WorkspaceBinding>,
    quarantined_assignment_ids: &BTreeSet<String>,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    let Some(database_path) = workspace_database_path else {
        return agent_assignment_command_failure(
            command,
            AgentAssignmentCommandFailure {
                error: Box::new(runtime_domain_error(
                    "RUNTIME_STORAGE_REQUIRED",
                    RuntimeErrorClass::Storage,
                    "当前运行时没有绑定工作区存储。",
                    "agent_assignment.storage",
                )),
                internal_message: "Assignment command requires workspace storage".to_owned(),
            },
        );
    };
    let Some(binding) = workspace_binding else {
        return agent_assignment_command_failure(
            command,
            AgentAssignmentCommandFailure {
                error: Box::new(runtime_domain_error(
                    "RUNTIME_WORKSPACE_BINDING_REQUIRED",
                    RuntimeErrorClass::Validation,
                    "当前运行时缺少工作区和项目身份绑定。",
                    "agent_assignment.binding",
                )),
                internal_message: "Assignment command requires workspace binding".to_owned(),
            },
        );
    };
    if command.name != "agent.assignment.get"
        && command
            .payload
            .get("assignmentId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| quarantined_assignment_ids.contains(id))
    {
        return agent_assignment_command_failure(
            command,
            AgentAssignmentCommandFailure {
                error: Box::new(runtime_domain_error(
                    "ASSIGNMENT_RECOVERY_QUARANTINED",
                    RuntimeErrorClass::SourceConflict,
                    "该智能体分配在启动恢复中被隔离，必须先处理一致性问题。",
                    "agent_assignment.recovery_barrier",
                )),
                internal_message: "Assignment mutation rejected by recovery quarantine".to_owned(),
            },
        );
    }
    let service = AgentAssignmentCommandService::new(database_path, binding);
    let result: Result<serde_json::Value, AgentAssignmentCommandFailure> =
        match command.name.as_str() {
            "agent.assignment.create" => service.create(
                command.message_id,
                serde_json::from_value(command.payload.clone())?,
            ),
            "agent.assignment.get" => service.get(serde_json::from_value(command.payload.clone())?),
            "agent.assignment.start" => service.start(
                command.message_id,
                serde_json::from_value(command.payload.clone())?,
            ),
            "agent.assignment.request_cancel" => service.request_cancel(
                command.message_id,
                serde_json::from_value(command.payload.clone())?,
            ),
            "agent.assignment.confirm_cancelled" => service.confirm_cancelled(
                command.message_id,
                serde_json::from_value(command.payload.clone())?,
            ),
            "agent.assignment.complete" => service.complete(
                command.message_id,
                serde_json::from_value(command.payload.clone())?,
            ),
            "agent.assignment.fail" => service.fail(
                command.message_id,
                serde_json::from_value(command.payload.clone())?,
            ),
            _ => unreachable!("validated Agent Assignment command"),
        }
        .and_then(|snapshot| {
            serde_json::to_value(snapshot).map_err(|error| AgentAssignmentCommandFailure {
                error: Box::new(runtime_domain_error(
                    "ASSIGNMENT_SNAPSHOT_SERIALIZATION_FAILED",
                    RuntimeErrorClass::RuntimeCrash,
                    "智能体分配状态无法序列化。",
                    "agent_assignment.snapshot",
                )),
                internal_message: error.to_string(),
            })
        });
    match result {
        Ok(payload) => {
            let mut response = response_draft(command, "agent.assignment.snapshot", payload)?;
            response.run_id = None;
            Ok(RoutedOutput::normal(response))
        }
        Err(failure) => agent_assignment_command_failure(command, failure),
    }
}

fn agent_assignment_command_failure(
    command: &Envelope,
    failure: AgentAssignmentCommandFailure,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    eprintln!(
        "Agent Assignment command rejected: {}",
        failure.internal_message
    );
    Ok(RoutedOutput::normal(response_draft(
        command,
        "agent.assignment.rejected",
        *failure.error,
    )?))
}

fn runtime_domain_error(
    code: &str,
    class: RuntimeErrorClass,
    public_message: &str,
    stage: &str,
) -> RuntimeError {
    RuntimeError {
        code: code.to_owned(),
        class,
        retryable: false,
        public_message: public_message.to_owned(),
        stage: stage.to_owned(),
        attempt: 0,
        diagnostic_id: Uuid::new_v4(),
    }
}

fn handle_run_start(
    command: &Envelope,
    journal: &mut Option<EventJournal>,
    workspace_binding: Option<&WorkspaceBinding>,
    workspace_database_path: Option<&str>,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    let run_id = command.run_id.expect("validated run.start runId");
    let start: RunStart = serde_json::from_value(command.payload.clone())?;
    let pin_validator = workspace_database_path.map(RunPinValidator::new);
    let mut service = RunCommandService::new(journal, workspace_binding);
    if let Some(validator) = pin_validator.as_ref() {
        service = service.with_pin_validator(validator);
    }
    match service.start(run_id, command.message_id, start) {
        Ok(snapshot) => Ok(RoutedOutput::normal(run_snapshot_draft(command, snapshot)?)),
        Err(failure) => run_command_failure(command, run_id, failure),
    }
}

fn handle_run_get(
    command: &Envelope,
    journal: &mut Option<EventJournal>,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    let run_id = command.run_id.expect("validated run.get runId");
    match RunCommandService::new(journal, None).get(run_id) {
        Ok(snapshot) => Ok(RoutedOutput::normal(run_snapshot_draft(command, snapshot)?)),
        Err(failure) => run_command_failure(command, run_id, failure),
    }
}

fn handle_run_cancel(
    command: &Envelope,
    journal: &mut Option<EventJournal>,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    let run_id = command.run_id.expect("validated run.cancel runId");
    let cancel: RunCancel = serde_json::from_value(command.payload.clone())?;
    match RunCommandService::new(journal, None).cancel(run_id, command.message_id, cancel) {
        Ok(snapshot) => Ok(RoutedOutput::normal(run_snapshot_draft(command, snapshot)?)),
        Err(failure) => run_command_failure(command, run_id, failure),
    }
}

fn handle_active_inference_cancel(
    command: &Envelope,
    journal: &mut Option<EventJournal>,
    active_tasks: &[RuntimeTaskKey],
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    let run_id = command.run_id.expect("validated run.cancel runId");
    let cancel: RunCancel = serde_json::from_value(command.payload.clone())?;
    let Some(storage) = journal.as_mut() else {
        return handle_run_cancel(command, journal);
    };
    let mut run = RunAggregate::recover(storage, &run_id.to_string())?;
    let attempt_ids = active_tasks
        .iter()
        .map(|task| task.attempt_id.to_string())
        .collect::<Vec<_>>();
    let created_at = current_timestamp()?;
    let message_id = command.message_id.to_string();
    run.request_cancellation_reconciliation(
        storage,
        &attempt_ids,
        &cancel.reason,
        EventMetadata {
            message_id: &message_id,
            idempotency_key: &cancel.cancel_idempotency_key,
            created_at: &created_at,
            reason: Some("active_provider_inference_cancellation_requested"),
        },
    )?;
    match RunCommandService::new(journal, None).get(run_id) {
        Ok(snapshot) => Ok(RoutedOutput::normal(run_snapshot_draft(command, snapshot)?)),
        Err(failure) => run_command_failure(command, run_id, failure),
    }
}

fn handle_run_prepare(
    command: &Envelope,
    journal: &mut Option<EventJournal>,
    providers: &ProviderRegistry,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    let run_id = command.run_id.expect("validated run.prepare runId");
    let prepare: RunPrepare = serde_json::from_value(command.payload.clone())?;
    match RunCommandService::new(journal, None).prepare(
        run_id,
        command.message_id,
        prepare,
        providers,
    ) {
        Ok(snapshot) => Ok(RoutedOutput::normal(run_snapshot_draft(command, snapshot)?)),
        Err(failure) => run_command_failure(command, run_id, failure),
    }
}

fn handle_run_reconcile(
    command: &Envelope,
    journal: &mut Option<EventJournal>,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    let run_id = command.run_id.expect("validated run.reconcile runId");
    let reconcile: RunReconcile = serde_json::from_value(command.payload.clone())?;
    let Some(storage) = journal.as_mut() else {
        return Ok(RoutedOutput::normal(run_rejected_draft(
            command,
            run_id,
            runtime_reconciliation_error(
                "RUNTIME_STORAGE_REQUIRED",
                RuntimeErrorClass::Storage,
                "Runtime storage is required to reconcile a Run.",
            ),
        )?));
    };
    let created_at = current_timestamp()?;
    match RunReconciliationService::new(storage).reconcile(
        &run_id.to_string(),
        &reconcile,
        &command.message_id.to_string(),
        &created_at,
    ) {
        Ok(receipt) => Ok(RoutedOutput::normal(run_reconciled_draft(
            command, run_id, receipt,
        )?)),
        Err(error) => {
            let fatal = matches!(
                error,
                RunReconciliationServiceError::Journal(_)
                    | RunReconciliationServiceError::Attempt(_)
                    | RunReconciliationServiceError::Run(
                        RunAggregateError::SequenceGap { .. }
                            | RunAggregateError::UnknownEvent(_)
                            | RunAggregateError::UnknownEventVersion { .. }
                            | RunAggregateError::DuplicateCreated
                            | RunAggregateError::InvalidPayload
                            | RunAggregateError::InvalidPinnedIdentity(_)
                            | RunAggregateError::StateMismatch
                    )
            );
            let output = run_rejected_draft(command, run_id, reconciliation_service_error(&error))?;
            Ok(if fatal {
                RoutedOutput::fatal(output, "fatal Run reconciliation failure")
            } else {
                RoutedOutput::normal(output)
            })
        }
    }
}

fn run_reconciled_draft(
    command: &Envelope,
    run_id: Uuid,
    receipt: RunReconciliationReceipt,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let mut response = response_draft(command, "run.reconciled", receipt)?;
    response.run_id = Some(run_id);
    Ok(response)
}

fn reconciliation_service_error(error: &RunReconciliationServiceError) -> RuntimeError {
    match error {
        RunReconciliationServiceError::AttemptNotFound => runtime_reconciliation_error(
            "RECONCILIATION_ATTEMPT_NOT_FOUND",
            RuntimeErrorClass::Validation,
            "The Provider attempt to reconcile was not found.",
        ),
        RunReconciliationServiceError::AttemptRunMismatch
        | RunReconciliationServiceError::AttemptOutcomeKnown
        | RunReconciliationServiceError::InvalidIdentity
        | RunReconciliationServiceError::InvalidCommand(_)
        | RunReconciliationServiceError::Run(RunAggregateError::NotFound(_))
        | RunReconciliationServiceError::Run(RunAggregateError::ReconciliationStateRequired)
        | RunReconciliationServiceError::Run(RunAggregateError::Transition(_)) => {
            runtime_reconciliation_error(
                "RUN_RECONCILIATION_INVALID",
                RuntimeErrorClass::Validation,
                "The Run reconciliation request is invalid for the current state.",
            )
        }
        RunReconciliationServiceError::Journal(_)
        | RunReconciliationServiceError::Attempt(_)
        | RunReconciliationServiceError::Run(_) => runtime_reconciliation_error(
            "RUN_RECONCILIATION_STORAGE_FAILED",
            RuntimeErrorClass::Storage,
            "The Run reconciliation could not be persisted or recovered.",
        ),
    }
}

fn runtime_reconciliation_error(
    code: &str,
    class: RuntimeErrorClass,
    public_message: &str,
) -> RuntimeError {
    RuntimeError {
        code: code.to_owned(),
        class,
        retryable: false,
        public_message: public_message.to_owned(),
        stage: "run.reconcile".to_owned(),
        attempt: 0,
        diagnostic_id: Uuid::new_v4(),
    }
}

async fn handle_tool_authorization_resolve(
    output: &RuntimeActorHandle,
    command: &Envelope,
    context: &mut RuntimeCommandContext<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    let run_id = command
        .run_id
        .expect("validated tool.authorization.resolve runId");
    let resolution: ToolAuthorizationResolve = serde_json::from_value(command.payload.clone())?;
    let database_path = context
        .workspace_database_path
        .ok_or("tool authorization requires Runtime storage")?;
    let project_root = context
        .project_root
        .cloned()
        .ok_or("tool authorization requires a verified project root")?;
    let project_id = context
        .workspace_binding
        .map(|binding| binding.project_id.clone())
        .ok_or("tool authorization requires a project binding")?;
    let pending = {
        let journal = context
            .journal
            .as_mut()
            .ok_or("tool authorization requires Runtime storage")?;
        AgentLoopJournalRepository::new(journal)
            .find_pending_request(&run_id.to_string(), resolution.tool_call_id)?
            .ok_or("pending ToolCall was not found")?
    };
    let service = ProjectToolExecutionService::open(database_path, project_root, project_id)?;
    let outcome = service
        .resolve_persisted_request_and_execute(
            &run_id.to_string(),
            &pending.request,
            &resolution,
            &current_timestamp()?,
        )
        .await?;
    let (status, lease) = match resolution.decision {
        novelx_protocol::ToolAuthorizationResolutionDecision::Approve => (
            ToolAuthorizationResolvedStatus::Authorized,
            outcome.snapshot.lease.clone(),
        ),
        novelx_protocol::ToolAuthorizationResolutionDecision::Deny => {
            (ToolAuthorizationResolvedStatus::Denied, None)
        }
    };
    let resolved = ToolAuthorizationResolved {
        tool_call_id: resolution.tool_call_id,
        decision: resolution.decision,
        status,
        lease,
    };
    resolved.validate()?;
    let mut response = response_draft(command, "tool.authorization.resolved", resolved)?;
    response.run_id = Some(run_id);
    output.emit(response).await?;
    if resolution.decision == novelx_protocol::ToolAuthorizationResolutionDecision::Approve {
        emit_resolved_tool_lifecycle(
            output,
            command.message_id,
            run_id,
            &pending.request,
            &outcome,
        )
        .await?;
    }
    let runner = LiveAgentLoopRunner::open(
        database_path,
        context
            .project_root
            .cloned()
            .ok_or("tool authorization requires a verified project root")?,
        context
            .workspace_binding
            .map(|binding| binding.project_id.clone())
            .ok_or("tool authorization requires a project binding")?,
        context.provider_registry.clone(),
        context.provider_gateway.as_ref().clone(),
        AgentLoopPolicy {
            maximum_tool_rounds: 8,
            tool_schema_version: 1,
        },
    )?;
    if runner.assist_ready(run_id, &pending.invocation_id)? {
        start_assist_resume_task(
            output,
            command.message_id,
            run_id,
            pending.invocation_id,
            runner,
        )
        .await?;
    }
    Ok(())
}

async fn start_assist_resume_task(
    output: &RuntimeActorHandle,
    correlation_id: Uuid,
    run_id: Uuid,
    invocation_id: String,
    runner: LiveAgentLoopRunner,
) -> Result<(), Box<dyn std::error::Error>> {
    let task_key = RuntimeTaskKey {
        run_id,
        attempt_id: Uuid::new_v4(),
    };
    let failure = inference_runtime_error_draft(
        correlation_id,
        run_id,
        runtime_inference_error(
            "ASSIST_RESUME_FAILED",
            RuntimeErrorClass::RuntimeCrash,
            "Assist tool execution could not resume the Agent loop.",
            1,
        ),
    )?;
    output
        .start_silent_streaming_task(task_key, failure, move |cancellation, progress| {
            Box::pin(async move {
                let progress_sender = progress.clone();
                let outcome = runner
                    .resume_after_assist(
                        run_id,
                        &invocation_id,
                        move |event| {
                            let progress = progress_sender.clone();
                            async move {
                                emit_live_loop_progress(correlation_id, run_id, event, progress)
                                    .await
                                    .map_err(LiveAgentLoopError::Progress)
                            }
                        },
                        || *cancellation.borrow(),
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                match outcome {
                    LiveAgentLoopOutcome::Completed { completion, .. } => {
                        provider_completion_draft(correlation_id, completion)
                    }
                    LiveAgentLoopOutcome::AwaitingApproval { .. } => Err(
                        "Assist resume returned to approval after all decisions were persisted"
                            .to_owned(),
                    ),
                    LiveAgentLoopOutcome::Cancelled => {
                        Err("Assist Agent loop was cancelled".to_owned())
                    }
                }
            })
        })
        .await?;
    Ok(())
}

async fn emit_resolved_tool_lifecycle(
    output: &RuntimeActorHandle,
    correlation_id: Uuid,
    run_id: Uuid,
    request: &ToolRequest,
    outcome: &ProjectToolExecutionOutcome,
) -> Result<(), Box<dyn std::error::Error>> {
    let mapper = ToolProtocolMapper::new(correlation_id, current_timestamp()?);
    let lease = outcome
        .snapshot
        .lease
        .clone()
        .ok_or("approved ToolCall lease is missing")?;
    let authorized = projected_snapshot(
        &outcome.snapshot,
        ToolState::Authorized,
        ToolCoordinationStatus::Authorized,
        Some(lease.clone()),
    );
    output
        .emit(mapper.authorized(run_id, request, &authorized)?)
        .await?;
    let running = projected_snapshot(
        &outcome.snapshot,
        ToolState::Running,
        ToolCoordinationStatus::Running,
        Some(lease),
    );
    output
        .emit(mapper.running(run_id, request, &running)?)
        .await?;
    let terminal = match outcome.snapshot.status {
        ToolCoordinationStatus::Succeeded => {
            mapper.succeeded(run_id, request, &outcome.snapshot)?
        }
        ToolCoordinationStatus::Failed => mapper.failed(
            run_id,
            request,
            &outcome.snapshot,
            runtime_inference_error(
                "PROJECT_TOOL_EXECUTION_FAILED",
                RuntimeErrorClass::Validation,
                "Project tool execution failed.",
                u64::from(request.attempt),
            ),
        )?,
        _ => return Err("approved ToolCall did not reach a terminal state".into()),
    };
    output.emit(terminal).await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn handle_provider_inference_start(
    output: &RuntimeActorHandle,
    command: &Envelope,
    journal: &mut Option<EventJournal>,
    workspace_database_path: Option<&str>,
    project_root: Option<&ProjectRoot>,
    project_id: Option<&str>,
    providers: &ProviderRegistry,
    gateway: &Arc<ProviderGateway>,
) -> Result<(), Box<dyn std::error::Error>> {
    let run_id = command
        .run_id
        .expect("validated provider.inference.start runId");
    let start: ProviderInferenceStart = serde_json::from_value(command.payload.clone())?;
    start.validate()?;
    let attempt_number = u16::try_from(start.attempt_number)?;
    let Some(database_path) = workspace_database_path else {
        output
            .emit(inference_runtime_error_draft(
                command.message_id,
                run_id,
                runtime_inference_error(
                    "RUNTIME_STORAGE_REQUIRED",
                    RuntimeErrorClass::Storage,
                    "Runtime storage is required for Provider inference.",
                    start.attempt_number,
                ),
            )?)
            .await?;
        return Ok(());
    };
    let Some(journal) = journal.as_mut() else {
        output
            .emit(inference_runtime_error_draft(
                command.message_id,
                run_id,
                runtime_inference_error(
                    "RUNTIME_STORAGE_REQUIRED",
                    RuntimeErrorClass::Storage,
                    "Runtime storage is required for Provider inference.",
                    start.attempt_number,
                ),
            )?)
            .await?;
        return Ok(());
    };
    let receipt = match recover_compilation_receipt(
        journal,
        &run_id.to_string(),
        start.context_compilation_id,
    ) {
        Ok(receipt) if receipt.request_number == start.request_number => receipt,
        Ok(_) | Err(ContextCompileServiceError::CompilationNotFound) => {
            output
                .emit(inference_runtime_error_draft(
                    command.message_id,
                    run_id,
                    runtime_inference_error(
                        "CONTEXT_RECEIPT_NOT_PERSISTED",
                        RuntimeErrorClass::Validation,
                        "The accepted Context Compilation is unavailable.",
                        start.attempt_number,
                    ),
                )?)
                .await?;
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    let mut run = match RunAggregate::recover(journal, &run_id.to_string()) {
        Ok(run) => run,
        Err(novelx_runtime::run_aggregate::RunAggregateError::NotFound(_)) => {
            output
                .emit(inference_runtime_error_draft(
                    command.message_id,
                    run_id,
                    runtime_inference_error(
                        "RUN_NOT_FOUND",
                        RuntimeErrorClass::Validation,
                        "The Run for Provider inference was not found.",
                        start.attempt_number,
                    ),
                )?)
                .await?;
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    if run.state() == RunState::Preparing {
        let message_id = Uuid::new_v4().to_string();
        let idempotency_key = format!("{}:run-running", start.inference_idempotency_key);
        let created_at = current_timestamp()?;
        run.start(
            journal,
            EventMetadata {
                message_id: &message_id,
                idempotency_key: &idempotency_key,
                created_at: &created_at,
                reason: Some("provider_inference_accepted"),
            },
        )?;
    }
    let execution = ProviderInferenceExecution {
        run_id: run_id.to_string(),
        attempt_id: start.attempt_id.to_string(),
        inference_id: start.inference_id.to_string(),
        invocation_id: start.invocation_id.clone(),
        inference_idempotency_key: start.inference_idempotency_key.clone(),
        attempt_number,
        provider: run.pinned_identity().provider.clone(),
        request: ProviderInferenceRequest {
            compilation: receipt,
            messages: Vec::new(),
            tools: Vec::new(),
        },
    };
    let provider = match providers.resolve_owned(&execution.provider) {
        Ok(provider) => provider,
        Err(error) => {
            let service_error = ProviderInferenceServiceError::Gateway(error);
            let mapper =
                ProviderInferenceProtocolMapper::new(command.message_id, current_timestamp()?);
            output
                .emit(mapper.rejected(&execution, &service_error)?)
                .await?;
            return Ok(());
        }
    };
    let prepared = match ProviderInferenceService::new(journal, providers, gateway)
        .prepare_attempt(execution.clone())
    {
        Ok(prepared) => prepared,
        Err(error) => {
            let mapper =
                ProviderInferenceProtocolMapper::new(command.message_id, current_timestamp()?);
            output.emit(mapper.rejected(&execution, &error)?).await?;
            return Ok(());
        }
    };
    let accepted = ProviderInferenceProtocolMapper::new(command.message_id, current_timestamp()?)
        .accepted(&execution)?;
    let database_path = database_path.to_owned();
    let gateway = Arc::clone(gateway);
    let loop_gateway = gateway.as_ref().clone();
    let loop_providers = providers.clone();
    let project_root = project_root.cloned();
    let project_id = project_id.map(str::to_owned);
    let correlation_id = command.message_id;
    let task_key = RuntimeTaskKey {
        run_id,
        attempt_id: start.attempt_id,
    };
    let task_failure = inference_runtime_error_draft(
        correlation_id,
        run_id,
        runtime_inference_error(
            "PROVIDER_TERMINAL_MAPPING_FAILED",
            RuntimeErrorClass::RuntimeCrash,
            "Provider inference completed, but its terminal event could not be produced.",
            start.attempt_number,
        ),
    )?;
    output
        .start_streaming_task(
            task_key,
            accepted,
            task_failure,
            move |mut cancellation, progress| Box::pin(async move {
                let result = match prepared {
                    PreparedProviderAttempt::Recovered(outcome) => Ok(*outcome),
                    PreparedProviderAttempt::Dispatch(dispatch) => {
                        let dispatched = ProviderInferenceService::dispatch_attempt_cancellable(
                            &gateway,
                            &provider,
                            *dispatch,
                            &mut cancellation,
                        )
                        .await;
                        match EventJournal::open(&database_path) {
                            Ok(mut journal) => {
                                let finalized = ProviderInferenceService::finalize_attempt_in(
                                    &mut journal,
                                    dispatched,
                                );
                                match finalized {
                                    Ok(outcome) => match RunAggregate::recover(
                                        &journal,
                                        &execution.run_id,
                                    ) {
                                        Ok(run)
                                            if run.state()
                                                == RunState::WaitingForReconciliation =>
                                        {
                                            Err(ProviderInferenceServiceError::CancelledAfterDispatch)
                                        }
                                        Ok(run) if run.state() != RunState::Running => Err(
                                            ProviderInferenceServiceError::RunNotRunning(run.state()),
                                        ),
                                        Ok(_) => Ok(outcome),
                                        Err(_) => Err(
                                            ProviderInferenceServiceError::FinalizationOutcomeUnknown,
                                        ),
                                    },
                                    Err(error @ ProviderInferenceServiceError::Gateway(_))
                                    | Err(error @ ProviderInferenceServiceError::DeliveryUnknown(_))
                                    | Err(error @ ProviderInferenceServiceError::CancelledAfterDispatch) => {
                                        Err(error)
                                    }
                                    Err(_) => Err(
                                        ProviderInferenceServiceError::FinalizationOutcomeUnknown,
                                    ),
                                }
                            }
                            Err(_) => Err(
                                ProviderInferenceServiceError::FinalizationOutcomeUnknown,
                            ),
                        }
                    }
                };
                let mapper = ProviderInferenceProtocolMapper::new(
                    correlation_id,
                    current_timestamp().map_err(|error| error.to_string())?,
                );
                match result {
                    Ok(outcome) if outcome.tool_calls.is_empty() => {
                        mapper.completed(&execution, &outcome).map_err(|error| error.to_string())
                    }
                    Ok(outcome) => run_live_tool_loop(
                        correlation_id,
                        execution.clone(),
                        outcome,
                        &database_path,
                        project_root,
                        project_id,
                        loop_providers,
                        loop_gateway,
                        progress,
                        &cancellation,
                    )
                    .await,
                    Err(error) if inference_outcome_unknown(&error) => {
                        mapper.reconciliation_required(&execution, &error).map_err(|error| error.to_string())
                    }
                    Err(error) => mapper.failed(&execution, &error).map_err(|error| error.to_string()),
                }
            }),
        )
        .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_live_tool_loop(
    correlation_id: Uuid,
    execution: ProviderInferenceExecution,
    initial_outcome: ProviderInferenceOutcome,
    database_path: &str,
    project_root: Option<ProjectRoot>,
    project_id: Option<String>,
    providers: ProviderRegistry,
    gateway: ProviderGateway,
    progress: RuntimeTaskProgressSender,
    cancellation: &tokio::sync::watch::Receiver<bool>,
) -> Result<RuntimeOutputDraft, String> {
    let project_root =
        project_root.ok_or_else(|| "verified project root is required".to_owned())?;
    let project_id = project_id.ok_or_else(|| "project identity is required".to_owned())?;
    let run_id = Uuid::parse_str(&execution.run_id).map_err(|error| error.to_string())?;
    let runner = LiveAgentLoopRunner::open(
        database_path,
        project_root,
        project_id,
        providers,
        gateway,
        AgentLoopPolicy {
            maximum_tool_rounds: 8,
            tool_schema_version: 1,
        },
    )
    .map_err(|error| error.to_string())?;
    let progress_sender = progress.clone();
    let outcome = runner
        .run(
            execution,
            Some(initial_outcome),
            move |event| {
                let progress = progress_sender.clone();
                async move {
                    emit_live_loop_progress(correlation_id, run_id, event, progress)
                        .await
                        .map_err(LiveAgentLoopError::Progress)
                }
            },
            || *cancellation.borrow(),
        )
        .await
        .map_err(|error| error.to_string())?;
    match outcome {
        LiveAgentLoopOutcome::Completed { completion, .. }
        | LiveAgentLoopOutcome::AwaitingApproval { completion, .. } => {
            provider_completion_draft(correlation_id, completion)
        }
        LiveAgentLoopOutcome::Cancelled => Err("live agent loop was cancelled".to_owned()),
    }
}

async fn emit_live_loop_progress(
    correlation_id: Uuid,
    run_id: Uuid,
    event: LiveAgentLoopProgress,
    progress: RuntimeTaskProgressSender,
) -> Result<(), String> {
    match event {
        LiveAgentLoopProgress::AwaitingApproval { requests, outcomes } => {
            emit_tool_outcomes(
                correlation_id,
                run_id,
                &requests,
                &outcomes,
                true,
                false,
                &progress,
            )
            .await
        }
        LiveAgentLoopProgress::ToolsCompleted { requests, outcomes } => {
            emit_tool_outcomes(
                correlation_id,
                run_id,
                &requests,
                &outcomes,
                true,
                true,
                &progress,
            )
            .await
        }
        LiveAgentLoopProgress::ProviderCompleted(_)
        | LiveAgentLoopProgress::ContextCompiled(_)
        | LiveAgentLoopProgress::InferenceStarted(_)
        | LiveAgentLoopProgress::Completed(_)
        | LiveAgentLoopProgress::Cancelled(_) => Ok(()),
    }
}

async fn emit_tool_outcomes(
    correlation_id: Uuid,
    run_id: Uuid,
    requests: &[ToolRequest],
    outcomes: &[ProjectToolExecutionOutcome],
    emit_requested: bool,
    terminal: bool,
    progress: &RuntimeTaskProgressSender,
) -> Result<(), String> {
    let mapper = ToolProtocolMapper::new(
        correlation_id,
        current_timestamp().map_err(|error| error.to_string())?,
    );
    for request in requests {
        let outcome = outcomes
            .iter()
            .find(|outcome| outcome.tool_call_id == request.tool_call_id)
            .ok_or_else(|| "tool execution outcome is missing".to_owned())?;
        if emit_requested {
            progress
                .emit(
                    mapper
                        .requested(run_id, request, &outcome.snapshot)
                        .map_err(|error| error.to_string())?,
                )
                .await
                .map_err(|error| error.to_string())?;
        }
        if !terminal {
            continue;
        }
        if outcome.snapshot.status == ToolCoordinationStatus::Denied {
            continue;
        }
        let lease = outcome
            .snapshot
            .lease
            .clone()
            .ok_or_else(|| "tool execution lease is missing".to_owned())?;
        let authorized = projected_snapshot(
            &outcome.snapshot,
            ToolState::Authorized,
            ToolCoordinationStatus::Authorized,
            Some(lease.clone()),
        );
        progress
            .emit(
                mapper
                    .authorized(run_id, request, &authorized)
                    .map_err(|error| error.to_string())?,
            )
            .await
            .map_err(|error| error.to_string())?;
        let running = projected_snapshot(
            &outcome.snapshot,
            ToolState::Running,
            ToolCoordinationStatus::Running,
            Some(lease),
        );
        progress
            .emit(
                mapper
                    .running(run_id, request, &running)
                    .map_err(|error| error.to_string())?,
            )
            .await
            .map_err(|error| error.to_string())?;
        let terminal_draft = match outcome.snapshot.status {
            ToolCoordinationStatus::Succeeded => mapper
                .succeeded(run_id, request, &outcome.snapshot)
                .map_err(|error| error.to_string())?,
            ToolCoordinationStatus::Failed | ToolCoordinationStatus::Denied => mapper
                .failed(
                    run_id,
                    request,
                    &outcome.snapshot,
                    runtime_inference_error(
                        "PROJECT_TOOL_EXECUTION_FAILED",
                        RuntimeErrorClass::Validation,
                        "Project tool execution failed.",
                        u64::from(request.attempt),
                    ),
                )
                .map_err(|error| error.to_string())?,
            _ => return Err("tool execution did not reach a terminal state".to_owned()),
        };
        progress
            .emit(terminal_draft)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn projected_snapshot(
    source: &ToolCoordinationSnapshot,
    state: ToolState,
    status: ToolCoordinationStatus,
    lease: Option<novelx_protocol::ToolPermissionLease>,
) -> ToolCoordinationSnapshot {
    ToolCoordinationSnapshot {
        run_id: source.run_id.clone(),
        tool_call_id: source.tool_call_id,
        state,
        authorization: ToolAuthorization::Allowed,
        status,
        lease,
        result: None,
        failure: None,
    }
}

fn provider_completion_draft(
    correlation_id: Uuid,
    completion: ProviderInferenceCompleted,
) -> Result<RuntimeOutputDraft, String> {
    Ok(RuntimeOutputDraft {
        message_type: MessageType::Event,
        name: "provider.inference.completed".to_owned(),
        sent_at: current_timestamp().map_err(|error| error.to_string())?,
        correlation_id: Some(correlation_id),
        run_id: Some(completion.identity.run_id),
        payload: serde_json::to_value(completion).map_err(|error| error.to_string())?,
    })
}

fn inference_outcome_unknown(error: &ProviderInferenceServiceError) -> bool {
    matches!(
        error,
        ProviderInferenceServiceError::OutcomeUnknown
            | ProviderInferenceServiceError::FinalizationOutcomeUnknown
            | ProviderInferenceServiceError::CancelledAfterDispatch
            | ProviderInferenceServiceError::DeliveryUnknown(_)
            | ProviderInferenceServiceError::ExistingTerminal(
                novelx_runtime::provider_attempt::ProviderAttemptRecovery::OutcomeUnknown
            )
    )
}

fn inference_runtime_error_draft(
    correlation_id: Uuid,
    run_id: Uuid,
    error: RuntimeError,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let mut draft = output_draft(MessageType::Event, "runtime.error", error)?;
    draft.correlation_id = Some(correlation_id);
    draft.run_id = Some(run_id);
    Ok(draft)
}

fn runtime_inference_error(
    code: &str,
    class: RuntimeErrorClass,
    public_message: &str,
    attempt: u64,
) -> RuntimeError {
    RuntimeError {
        code: code.to_owned(),
        class,
        retryable: false,
        public_message: public_message.to_owned(),
        stage: "provider.inference".to_owned(),
        attempt,
        diagnostic_id: Uuid::new_v4(),
    }
}

fn current_timestamp() -> Result<String, time::error::Format> {
    OffsetDateTime::now_utc().format(&Rfc3339)
}

fn handle_context_compile(
    command: &Envelope,
    journal: &mut Option<EventJournal>,
    providers: &ProviderRegistry,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    let run_id = command.run_id.expect("validated context.compile runId");
    let compile: ContextCompile = serde_json::from_value(command.payload.clone())?;
    let Some(journal) = journal.as_mut() else {
        return Ok(RoutedOutput::normal(context_rejected_draft(
            command,
            run_id,
            context_error(
                "RUNTIME_STORAGE_REQUIRED",
                RuntimeErrorClass::Storage,
                "Runtime storage is required to compile context.",
            ),
        )?));
    };
    match ContextCompileService::new(journal, providers).compile(
        run_id,
        command.message_id,
        compile,
    ) {
        Ok(receipt) => Ok(RoutedOutput::normal(context_compilation_draft(
            command, receipt,
        )?)),
        Err(error) => {
            let fatal = matches!(
                error,
                ContextCompileServiceError::InvalidHistory | ContextCompileServiceError::Journal(_)
            );
            eprintln!("context.compile rejected: {error}");
            let output = context_rejected_draft(command, run_id, context_service_error(&error))?;
            Ok(if fatal {
                RoutedOutput::fatal(output, "fatal Context Compiler failure")
            } else {
                RoutedOutput::normal(output)
            })
        }
    }
}

fn context_compilation_draft(
    command: &Envelope,
    receipt: ContextCompilationReceipt,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let mut response = response_draft(command, "context.compilation", receipt)?;
    response.run_id = command.run_id;
    Ok(response)
}

fn context_rejected_draft(
    command: &Envelope,
    run_id: Uuid,
    error: RuntimeError,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let mut response = response_draft(command, "context.rejected", error)?;
    response.run_id = Some(run_id);
    Ok(response)
}

fn context_service_error(error: &ContextCompileServiceError) -> RuntimeError {
    match error {
        ContextCompileServiceError::Compiler(
            novelx_runtime::context_compiler::ContextCompilerError::RequiredContextExceedsWindow {
                ..
            },
        ) => context_error(
            "AGENT_CONTEXT_BUDGET_EXCEEDED",
            RuntimeErrorClass::ContextCapacity,
            "The required context does not fit the selected model window.",
        ),
        ContextCompileServiceError::Compiler(
            novelx_runtime::context_compiler::ContextCompilerError::ToolPairingInvalid { .. },
        ) => context_error(
            "PROVIDER_PROTOCOL_FAILED",
            RuntimeErrorClass::Protocol,
            "The tool transcript is incomplete or mismatched.",
        ),
        ContextCompileServiceError::Provider(ProviderGatewayError::CredentialRequired) => {
            context_error(
                "REAL_GM_PROVIDER_REQUIRED",
                RuntimeErrorClass::ProviderAuth,
                "A configured model service is required.",
            )
        }
        ContextCompileServiceError::ProviderCapabilityMismatch
        | ContextCompileServiceError::PinnedIdentityMismatch
        | ContextCompileServiceError::Provider(ProviderGatewayError::ProfileMismatch) => {
            context_error(
                "PROVIDER_PROFILE_MISMATCH",
                RuntimeErrorClass::Validation,
                "The model or context policy differs from the pinned Run.",
            )
        }
        ContextCompileServiceError::IdempotencyConflict => context_error(
            "CONTEXT_COMPILE_IDEMPOTENCY_CONFLICT",
            RuntimeErrorClass::Validation,
            "This context request conflicts with an existing compilation.",
        ),
        ContextCompileServiceError::RunStateInvalid => context_error(
            "CONTEXT_COMPILE_RUN_STATE_INVALID",
            RuntimeErrorClass::Validation,
            "The Run must pass Provider preparation before context compilation.",
        ),
        ContextCompileServiceError::InvalidInput(_)
        | ContextCompileServiceError::Compiler(_)
        | ContextCompileServiceError::Provider(_) => context_error(
            "CONTEXT_COMPILE_INVALID",
            RuntimeErrorClass::Validation,
            "The context compilation input is invalid.",
        ),
        ContextCompileServiceError::Run(_)
        | ContextCompileServiceError::Journal(_)
        | ContextCompileServiceError::Json(_)
        | ContextCompileServiceError::Time(_)
        | ContextCompileServiceError::InvalidHistory
        | ContextCompileServiceError::CompilationNotFound => context_error(
            "CONTEXT_COMPILE_RUNTIME_FAILED",
            RuntimeErrorClass::Storage,
            "The context compilation could not be persisted or recovered.",
        ),
    }
}

fn context_error(code: &str, class: RuntimeErrorClass, public_message: &str) -> RuntimeError {
    RuntimeError {
        code: code.to_owned(),
        class,
        retryable: false,
        public_message: public_message.to_owned(),
        stage: "context.compile".to_owned(),
        attempt: 0,
        diagnostic_id: Uuid::new_v4(),
    }
}

fn run_command_failure(
    command: &Envelope,
    run_id: Uuid,
    failure: RunCommandFailure,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    eprintln!("{}", failure.internal_message);
    let output = run_rejected_draft(command, run_id, *failure.error)?;
    Ok(if failure.fatal {
        RoutedOutput::fatal(output, "fatal Run command failure")
    } else {
        RoutedOutput::normal(output)
    })
}

fn run_snapshot_draft(
    command: &Envelope,
    snapshot: RunSnapshot,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let run_id = snapshot.run_id;
    let mut response = response_draft(command, "run.snapshot", snapshot)?;
    response.run_id = Some(run_id);
    Ok(response)
}

fn run_rejected_draft(
    command: &Envelope,
    run_id: Uuid,
    error: RuntimeError,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let mut response = response_draft(command, "run.rejected", error)?;
    response.run_id = Some(run_id);
    Ok(response)
}

fn response_draft(
    command: &Envelope,
    name: &str,
    payload: impl serde::Serialize,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let mut response = output_draft(MessageType::Response, name, payload)?;
    response.correlation_id = Some(command.message_id);
    Ok(response)
}

fn correlated_response_draft(
    correlation_id: Uuid,
    name: &str,
    payload: impl serde::Serialize,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let mut response = output_draft(MessageType::Response, name, payload)?;
    response.correlation_id = Some(correlation_id);
    Ok(response)
}

fn output_draft(
    message_type: MessageType,
    name: &str,
    payload: impl serde::Serialize,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let sent_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    Ok(RuntimeOutputDraft {
        message_type,
        name: name.to_owned(),
        sent_at,
        correlation_id: None,
        run_id: None,
        payload: serde_json::to_value(payload)?,
    })
}

async fn write_handshake_envelope(
    output: &mut (impl AsyncWrite + Unpin),
    envelope: &Envelope,
) -> Result<(), Box<dyn std::error::Error>> {
    output.write_all(&serde_json::to_vec(envelope)?).await?;
    output.write_all(b"\n").await?;
    output.flush().await?;
    Ok(())
}

fn protocol_error_draft(
    correlation_id: Uuid,
    error: &str,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let mut output = output_draft(
        MessageType::Event,
        "runtime.error",
        RuntimeError {
            code: "RUNTIME_PROTOCOL_ERROR".to_owned(),
            class: RuntimeErrorClass::Protocol,
            retryable: false,
            public_message: "运行时收到不符合协议的消息，已停止处理。".to_owned(),
            stage: "runtime.command.validate".to_owned(),
            attempt: 0,
            diagnostic_id: Uuid::new_v4(),
        },
    )?;
    output.correlation_id = Some(correlation_id);
    eprintln!("runtime protocol error: {error}");
    Ok(output)
}

async fn write_protocol_error(
    output: &mut (impl AsyncWrite + Unpin),
    correlation_id: Uuid,
    sequence: u64,
    error: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let draft = protocol_error_draft(correlation_id, error)?;
    let envelope = Envelope {
        protocol_version: novelx_protocol::PROTOCOL_VERSION,
        message_id: Uuid::new_v4(),
        message_type: draft.message_type,
        name: draft.name,
        sent_at: draft.sent_at,
        correlation_id: draft.correlation_id,
        run_id: draft.run_id,
        sequence,
        payload: draft.payload,
    };
    write_handshake_envelope(output, &envelope).await
}

struct InitializedRuntimeState {
    journal: EventJournal,
    recovered_run_count: u64,
    assignment_report: AssignmentRecoveryReport,
    operational_runs: BTreeMap<String, OperationalRecoveryRun>,
    quarantined_assignment_ids: BTreeSet<String>,
}

fn initialize_runtime(
    path: &str,
    binding: &WorkspaceBinding,
) -> Result<InitializedRuntimeState, InitializationError> {
    let mut journal = EventJournal::open(path).map_err(InitializationError::Storage)?;
    let report = RecoveryCoordinator::recover_and_reconcile(&mut journal)
        .map_err(InitializationError::Recovery)?;
    let assignment_report =
        recover_agent_assignments(path, &binding.workspace_id, &binding.project_id)
            .map_err(InitializationError::AssignmentRecovery)?;
    let quarantined = assignment_report
        .quarantined
        .iter()
        .map(|value| value.assignment_id.clone())
        .collect();
    let operational_report = OperationalRecoveryScanner::new(&mut journal, &assignment_report, &[])
        .scan(&binding.workspace_id, &binding.project_id)
        .map_err(InitializationError::OperationalRecoveryScan)?;
    let created_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(InitializationError::Time)?;
    OperationalRecoveryRecordingService::new(path)
        .record(
            &binding.workspace_id,
            &binding.project_id,
            &operational_report,
            &created_at,
        )
        .map_err(InitializationError::OperationalRecoveryRecording)?;
    let operational_runs = operational_report
        .runs
        .into_iter()
        .map(|run| (run.run_id.clone(), run))
        .collect();
    let count = report.recovered_nonterminal_count;
    Ok(InitializedRuntimeState {
        journal,
        recovered_run_count: count,
        assignment_report,
        operational_runs,
        quarantined_assignment_ids: quarantined,
    })
}

async fn write_initialization_failed(
    output: &mut (impl AsyncWrite + Unpin),
    correlation_id: Uuid,
    diagnostic_id: Uuid,
    error: &InitializationError,
) -> Result<(), Box<dyn std::error::Error>> {
    let (code, class, stage) = match error {
        InitializationError::Storage(_) => (
            "RUNTIME_STORAGE_INITIALIZATION_FAILED",
            RuntimeErrorClass::Storage,
            "runtime.initialize.storage",
        ),
        InitializationError::Recovery(_) => (
            "RUNTIME_RECOVERY_FAILED",
            RuntimeErrorClass::Validation,
            "runtime.initialize.recovery",
        ),
        InitializationError::AssignmentRecovery(_) => (
            "ASSIGNMENT_RECOVERY_FAILED",
            RuntimeErrorClass::Validation,
            "runtime.initialize.assignment_recovery",
        ),
        InitializationError::OperationalRecoveryScan(_) => (
            "OPERATIONAL_RECOVERY_SCAN_FAILED",
            RuntimeErrorClass::Validation,
            "runtime.initialize.operational_recovery.scan",
        ),
        InitializationError::OperationalRecoveryRecording(_) => (
            "OPERATIONAL_RECOVERY_RECORDING_FAILED",
            RuntimeErrorClass::Storage,
            "runtime.initialize.operational_recovery.record",
        ),
        InitializationError::Time(_) => (
            "RUNTIME_INITIALIZATION_TIME_FAILED",
            RuntimeErrorClass::Storage,
            "runtime.initialize.time",
        ),
    };
    let sent_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    let mut envelope = Envelope::new(
        MessageType::Control,
        "runtime.initialization_failed",
        sent_at,
        2,
        RuntimeError {
            code: code.to_owned(),
            class,
            retryable: false,
            public_message: "运行时初始化失败，项目数据未被修改。".to_owned(),
            stage: stage.to_owned(),
            attempt: 0,
            diagnostic_id,
        },
    )?;
    envelope.correlation_id = Some(correlation_id);
    write_handshake_envelope(output, &envelope).await
}

struct RoutedOutput {
    output: RuntimeOutputDraft,
    fatal: bool,
    fatal_message: &'static str,
}

impl RoutedOutput {
    const fn normal(output: RuntimeOutputDraft) -> Self {
        Self {
            output,
            fatal: false,
            fatal_message: "",
        }
    }

    const fn fatal(output: RuntimeOutputDraft, fatal_message: &'static str) -> Self {
        Self {
            output,
            fatal: true,
            fatal_message,
        }
    }
}

#[derive(Debug)]
enum InitializationError {
    Storage(EventJournalError),
    Recovery(RecoveryError),
    AssignmentRecovery(AgentAssignmentRecoveryError),
    OperationalRecoveryScan(OperationalRecoveryScanError),
    OperationalRecoveryRecording(OperationalRecoveryRecordingError),
    Time(time::error::Format),
}

impl std::fmt::Display for InitializationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Storage(error) => write!(formatter, "storage: {error}"),
            Self::Recovery(error) => write!(formatter, "recovery: {error}"),
            Self::AssignmentRecovery(error) => {
                write!(formatter, "assignment recovery: {error}")
            }
            Self::OperationalRecoveryScan(error) => {
                write!(formatter, "operational recovery scan: {error}")
            }
            Self::OperationalRecoveryRecording(error) => {
                write!(formatter, "operational recovery recording: {error}")
            }
            Self::Time(error) => write!(formatter, "initialization time: {error}"),
        }
    }
}

impl std::error::Error for InitializationError {}
