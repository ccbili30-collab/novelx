use std::io;
use std::sync::Arc;

use novelx_protocol::{
    ContextCompilationReceipt, ContextCompile, Envelope, MessageType, PROTOCOL_VERSION,
    ProviderInferenceStart, RunCancel, RunPrepare, RunSnapshot, RunStart, RuntimeBuild,
    RuntimeError, RuntimeErrorClass, RuntimeHello, RuntimeIdentity, RuntimeInitialize,
    RuntimeReady, RuntimeStatus, RuntimeStopped,
};
use novelx_runtime::context_compile_service::{
    ContextCompileService, ContextCompileServiceError, recover_compilation_receipt,
};
use novelx_runtime::event_journal::{EventJournal, EventJournalError};
use novelx_runtime::provider_gateway::{
    ProviderBindSensitiveEnvelope, ProviderGateway, ProviderGatewayError, ProviderInferenceRequest,
    ProviderRegistry,
};
use novelx_runtime::provider_inference_protocol::ProviderInferenceProtocolMapper;
use novelx_runtime::provider_inference_service::{
    PreparedProviderAttempt, ProviderInferenceExecution, ProviderInferenceService,
    ProviderInferenceServiceError,
};
use novelx_runtime::recovery::{RecoveryCoordinator, RecoveryError};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate};
use novelx_runtime::run_command_service::{RunCommandFailure, RunCommandService, WorkspaceBinding};
use novelx_runtime::run_state::RunState;
use novelx_runtime::runtime_actor::{RuntimeActor, RuntimeActorHandle, RuntimeOutputDraft};
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
            "contexts_v1".to_owned(),
            "provider_inference_v1".to_owned(),
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
        initialize.project_id.as_ref(),
        initialize.workspace_id.as_ref(),
    ) {
        (None, None, None) => None,
        (Some(_), Some(project_id), Some(workspace_id))
            if !project_id.trim().is_empty() && !workspace_id.trim().is_empty() =>
        {
            Some(WorkspaceBinding {
                project_id: project_id.clone(),
                workspace_id: workspace_id.clone(),
            })
        }
        _ => {
            let error = "runtime.initialize requires projectId and workspaceId exactly when workspaceDatabasePath is configured";
            write_protocol_error(&mut output, initialize_envelope.message_id, 2, error).await?;
            return Err(io::Error::new(io::ErrorKind::InvalidData, error).into());
        }
    };

    let (mut journal, recovered_run_count) = match initialize.workspace_database_path.as_deref() {
        None => (None, 0),
        Some(path) => match initialize_runtime(path) {
            Ok((journal, count)) => (Some(journal), count),
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
        provider_registry: &mut provider_registry,
        provider_gateway: &provider_gateway,
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
                .emit(handle_provider_bind(sensitive, context.provider_registry)?)
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
            "run.start" => handle_run_start(&command, context.journal, context.workspace_binding)?,
            "run.get" => handle_run_get(&command, context.journal)?,
            "run.cancel" => handle_run_cancel(&command, context.journal)?,
            "run.prepare" => {
                handle_run_prepare(&command, context.journal, context.provider_registry)?
            }
            "context.compile" => {
                handle_context_compile(&command, context.journal, context.provider_registry)?
            }
            "provider.inference.start" => {
                handle_provider_inference_start(
                    output,
                    &command,
                    context.journal,
                    context.workspace_database_path,
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

struct RuntimeCommandContext<'a> {
    workspace_database_path: Option<&'a str>,
    recovered_run_count: u64,
    journal: &'a mut Option<EventJournal>,
    workspace_binding: Option<&'a WorkspaceBinding>,
    provider_registry: &'a mut ProviderRegistry,
    provider_gateway: &'a Arc<ProviderGateway>,
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
        "context.compile" => {
            if command.run_id.is_none() {
                return Err("context.compile requires runId".to_owned());
            }
            serde_json::from_value::<ContextCompile>(command.payload.clone())
                .map_err(|error| format!("invalid context.compile payload: {error}"))?;
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

fn require_empty_payload(command: &Envelope) -> Result<(), String> {
    if matches!(command.payload.as_object(), Some(payload) if payload.is_empty()) {
        Ok(())
    } else {
        Err(format!("{} payload must be an empty object", command.name))
    }
}

fn handle_provider_bind(
    command: ProviderBindSensitiveEnvelope,
    registry: &mut ProviderRegistry,
) -> Result<RuntimeOutputDraft, Box<dyn std::error::Error>> {
    let correlation_id = command.message_id;
    let payload = command.payload;
    match registry.bind(payload.config, &payload.config_sha256, payload.credential) {
        Ok(receipt) => correlated_response_draft(correlation_id, "provider.bound", receipt),
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

fn handle_run_start(
    command: &Envelope,
    journal: &mut Option<EventJournal>,
    workspace_binding: Option<&WorkspaceBinding>,
) -> Result<RoutedOutput, Box<dyn std::error::Error>> {
    let run_id = command.run_id.expect("validated run.start runId");
    let start: RunStart = serde_json::from_value(command.payload.clone())?;
    match RunCommandService::new(journal, workspace_binding).start(
        run_id,
        command.message_id,
        start,
    ) {
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

async fn handle_provider_inference_start(
    output: &RuntimeActorHandle,
    command: &Envelope,
    journal: &mut Option<EventJournal>,
    workspace_database_path: Option<&str>,
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
    let correlation_id = command.message_id;
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
        .start_task(
            accepted,
            task_failure,
            Box::pin(async move {
                let result = match prepared {
                    PreparedProviderAttempt::Recovered(outcome) => Ok(*outcome),
                    PreparedProviderAttempt::Dispatch(dispatch) => {
                        let dispatched = ProviderInferenceService::dispatch_attempt(
                            &gateway, &provider, *dispatch,
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
                                        Ok(run) if run.state() == RunState::Cancelled => Err(
                                            ProviderInferenceServiceError::RunNotRunning(
                                                RunState::Cancelled,
                                            ),
                                        ),
                                        Ok(_) => Ok(outcome),
                                        Err(_) => Err(
                                            ProviderInferenceServiceError::FinalizationOutcomeUnknown,
                                        ),
                                    },
                                    Err(error @ ProviderInferenceServiceError::Gateway(_))
                                    | Err(error @ ProviderInferenceServiceError::DeliveryUnknown(_)) => {
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
                    Ok(outcome) => mapper.completed(&execution, &outcome),
                    Err(error) if inference_outcome_unknown(&error) => {
                        mapper.reconciliation_required(&execution, &error)
                    }
                    Err(error) => mapper.failed(&execution, &error),
                }
                .map_err(|error| error.to_string())
            }),
        )
        .await?;
    Ok(())
}

fn inference_outcome_unknown(error: &ProviderInferenceServiceError) -> bool {
    matches!(
        error,
        ProviderInferenceServiceError::OutcomeUnknown
            | ProviderInferenceServiceError::FinalizationOutcomeUnknown
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

fn initialize_runtime(path: &str) -> Result<(EventJournal, u64), InitializationError> {
    let journal = EventJournal::open(path).map_err(InitializationError::Storage)?;
    let report = RecoveryCoordinator::recover(&journal).map_err(InitializationError::Recovery)?;
    let count = report.recovered_nonterminal_count;
    Ok((journal, count))
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
}

impl std::fmt::Display for InitializationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Storage(error) => write!(formatter, "storage: {error}"),
            Self::Recovery(error) => write!(formatter, "recovery: {error}"),
        }
    }
}

impl std::error::Error for InitializationError {}
