use std::io::{self, BufRead, Write};

use novelx_protocol::{
    Envelope, MessageType, PROTOCOL_VERSION, RunLifecycleState, RunRecoveryClassification,
    RunSnapshot, RunStart, RuntimeBuild, RuntimeError, RuntimeErrorClass, RuntimeHello,
    RuntimeIdentity, RuntimeInitialize, RuntimeReady, RuntimeStatus, RuntimeStopped,
};
use novelx_runtime::event_journal::{EventJournal, EventJournalError};
use novelx_runtime::recovery::{RecoveryCoordinator, RecoveryError};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate, RunAggregateError};
use novelx_runtime::run_state::RunState;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sent_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    let hello = RuntimeHello {
        runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
        protocol_versions: vec![PROTOCOL_VERSION],
        capabilities: vec![
            "handshake".to_owned(),
            "runtime_control".to_owned(),
            "runs_v1".to_owned(),
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

    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, &hello_envelope)?;
    output.write_all(b"\n")?;
    output.flush()?;

    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let initialize_line = lines
        .next()
        .ok_or("runtime.initialize was not received")??;
    let initialize_envelope: Envelope = serde_json::from_str(&initialize_line)?;
    if let Err(error) = validate_initialize_envelope(&initialize_envelope) {
        write_protocol_error(&mut output, initialize_envelope.message_id, 2, &error)?;
        return Err(io::Error::new(io::ErrorKind::InvalidData, error).into());
    }
    let initialize: RuntimeInitialize =
        match serde_json::from_value(initialize_envelope.payload.clone()) {
            Ok(initialize) => initialize,
            Err(error) => {
                let error = format!("invalid runtime.initialize payload: {error}");
                write_protocol_error(&mut output, initialize_envelope.message_id, 2, &error)?;
                return Err(io::Error::new(io::ErrorKind::InvalidData, error).into());
            }
        };
    if initialize.selected_protocol_version != PROTOCOL_VERSION {
        let error = format!(
            "runtime.initialize selected unsupported protocol version {}",
            initialize.selected_protocol_version
        );
        write_protocol_error(&mut output, initialize_envelope.message_id, 2, &error)?;
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
            write_protocol_error(&mut output, initialize_envelope.message_id, 2, error)?;
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
                )?;
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
    serde_json::to_writer(&mut output, &ready_envelope)?;
    output.write_all(b"\n")?;
    output.flush()?;

    run_command_loop(
        &mut lines,
        &mut output,
        initialize.workspace_database_path.is_some(),
        recovered_run_count,
        &mut journal,
        workspace_binding.as_ref(),
    )
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

fn run_command_loop(
    lines: &mut impl Iterator<Item = Result<String, io::Error>>,
    output: &mut impl Write,
    workspace_database_configured: bool,
    recovered_run_count: u64,
    journal: &mut Option<EventJournal>,
    workspace_binding: Option<&WorkspaceBinding>,
) -> Result<(), Box<dyn std::error::Error>> {
    for ((expected_host_sequence, runtime_sequence), line) in (2_u64..).zip(3_u64..).zip(lines) {
        let line = line?;
        let command: Envelope = serde_json::from_str(&line)?;
        if let Err(error) = validate_command(&command, expected_host_sequence) {
            write_protocol_error(output, command.message_id, runtime_sequence, &error)?;
            return Err(io::Error::new(io::ErrorKind::InvalidData, error).into());
        }

        match command.name.as_str() {
            "runtime.status.get" => {
                write_response(
                    output,
                    &command,
                    runtime_sequence,
                    "runtime.status",
                    RuntimeStatus {
                        initialized: true,
                        workspace_database_configured,
                        recovered_run_count,
                        protocol_version: PROTOCOL_VERSION,
                        runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
                    },
                )?;
            }
            "runtime.shutdown" => {
                write_response(
                    output,
                    &command,
                    runtime_sequence,
                    "runtime.stopped",
                    RuntimeStopped {
                        reason: "requested".to_owned(),
                    },
                )?;
                return Ok(());
            }
            "run.start" => handle_run_start(
                output,
                &command,
                runtime_sequence,
                journal,
                workspace_binding,
            )?,
            "run.get" => handle_run_get(output, &command, runtime_sequence, journal)?,
            _ => unreachable!("validated command name"),
        }
    }

    Ok(())
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

fn handle_run_start(
    output: &mut impl Write,
    command: &Envelope,
    runtime_sequence: u64,
    journal: &mut Option<EventJournal>,
    workspace_binding: Option<&WorkspaceBinding>,
) -> Result<(), Box<dyn std::error::Error>> {
    let run_id = command.run_id.expect("validated run.start runId");
    let start: RunStart = serde_json::from_value(command.payload.clone())?;
    let Some(journal) = journal.as_mut() else {
        return write_run_rejected(
            output,
            command,
            runtime_sequence,
            run_id,
            runtime_error(
                "RUNTIME_STORAGE_REQUIRED",
                RuntimeErrorClass::Storage,
                false,
                "当前运行时没有绑定项目存储，无法创建任务。",
                "run.start.storage",
            ),
        );
    };
    let Some(binding) = workspace_binding else {
        return write_run_rejected(
            output,
            command,
            runtime_sequence,
            run_id,
            runtime_error(
                "RUNTIME_WORKSPACE_BINDING_REQUIRED",
                RuntimeErrorClass::Validation,
                false,
                "当前运行时缺少项目身份绑定，无法创建任务。",
                "run.start.binding",
            ),
        );
    };
    if start.pinned_identity.project_id != binding.project_id
        || start.pinned_identity.workspace_id != binding.workspace_id
    {
        return write_run_rejected(
            output,
            command,
            runtime_sequence,
            run_id,
            runtime_error(
                "RUN_WORKSPACE_BINDING_CONFLICT",
                RuntimeErrorClass::SourceConflict,
                false,
                "任务绑定的项目与当前运行时不一致，未写入任何数据。",
                "run.start.binding",
            ),
        );
    }

    let created_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    match RunAggregate::create(
        journal,
        &run_id.to_string(),
        start.pinned_identity,
        EventMetadata {
            message_id: &command.message_id.to_string(),
            idempotency_key: &start.start_idempotency_key,
            created_at: &created_at,
            reason: None,
        },
    ) {
        Ok(run) => write_run_snapshot(output, command, runtime_sequence, &run),
        Err(error) => write_run_failure(
            output,
            command,
            runtime_sequence,
            run_id,
            "run.start.persist",
            error,
        ),
    }
}

fn handle_run_get(
    output: &mut impl Write,
    command: &Envelope,
    runtime_sequence: u64,
    journal: &mut Option<EventJournal>,
) -> Result<(), Box<dyn std::error::Error>> {
    let run_id = command.run_id.expect("validated run.get runId");
    let Some(journal) = journal.as_ref() else {
        return write_run_rejected(
            output,
            command,
            runtime_sequence,
            run_id,
            runtime_error(
                "RUNTIME_STORAGE_REQUIRED",
                RuntimeErrorClass::Storage,
                false,
                "当前运行时没有绑定项目存储，无法查询任务。",
                "run.get.storage",
            ),
        );
    };
    match RunAggregate::recover(journal, &run_id.to_string()) {
        Ok(run) => write_run_snapshot(output, command, runtime_sequence, &run),
        Err(RunAggregateError::NotFound(_)) => write_run_rejected(
            output,
            command,
            runtime_sequence,
            run_id,
            runtime_error(
                "RUN_NOT_FOUND",
                RuntimeErrorClass::Validation,
                false,
                "没有找到这个任务。",
                "run.get.recover",
            ),
        ),
        Err(error) => write_run_failure(
            output,
            command,
            runtime_sequence,
            run_id,
            "run.get.recover",
            error,
        ),
    }
}

fn write_run_failure(
    output: &mut impl Write,
    command: &Envelope,
    sequence: u64,
    run_id: Uuid,
    stage: &str,
    error: RunAggregateError,
) -> Result<(), Box<dyn std::error::Error>> {
    let fatal = is_fatal_run_error(&error);
    write_run_rejected(
        output,
        command,
        sequence,
        run_id,
        run_aggregate_error(stage, &error),
    )?;
    if fatal {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("fatal Run journal failure: {error}"),
        )
        .into());
    }
    Ok(())
}

fn is_fatal_run_error(error: &RunAggregateError) -> bool {
    matches!(
        error,
        RunAggregateError::SequenceGap { .. }
            | RunAggregateError::UnknownEvent(_)
            | RunAggregateError::UnknownEventVersion { .. }
            | RunAggregateError::DuplicateCreated
            | RunAggregateError::InvalidPayload
            | RunAggregateError::StateMismatch
            | RunAggregateError::Journal(
                novelx_runtime::event_journal::EventJournalError::MigrationChecksumMismatch { .. }
                    | novelx_runtime::event_journal::EventJournalError::MigrationVerificationFailed
                    | novelx_runtime::event_journal::EventJournalError::SchemaIntegrityFailed
                    | novelx_runtime::event_journal::EventJournalError::Storage(_)
            )
    )
}

fn write_run_snapshot(
    output: &mut impl Write,
    command: &Envelope,
    sequence: u64,
    run: &RunAggregate,
) -> Result<(), Box<dyn std::error::Error>> {
    let run_id = Uuid::parse_str(run.run_id())?;
    let mut response = response_envelope(
        command,
        sequence,
        "run.snapshot",
        RunSnapshot {
            run_id,
            pinned_identity: run.pinned_identity().clone(),
            state: lifecycle_state(run.state()),
            recovery_classification: recovery_classification(run.state()),
            run_sequence: run.last_run_sequence(),
            aggregate_sequence: run.last_sequence(),
            created_at: run.created_at().to_owned(),
            updated_at: run.updated_at().to_owned(),
        },
    )?;
    response.run_id = Some(run_id);
    write_envelope(output, &response)
}

fn write_run_rejected(
    output: &mut impl Write,
    command: &Envelope,
    sequence: u64,
    run_id: Uuid,
    error: RuntimeError,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut response = response_envelope(command, sequence, "run.rejected", error)?;
    response.run_id = Some(run_id);
    write_envelope(output, &response)
}

fn run_aggregate_error(stage: &str, error: &RunAggregateError) -> RuntimeError {
    let (code, class) = match error {
        RunAggregateError::InvalidPinnedIdentity(_) => {
            ("RUN_PINNED_IDENTITY_INVALID", RuntimeErrorClass::Validation)
        }
        RunAggregateError::Journal(
            novelx_runtime::event_journal::EventJournalError::IdempotencyConflict { .. },
        ) => (
            "RUN_START_IDEMPOTENCY_CONFLICT",
            RuntimeErrorClass::Protocol,
        ),
        RunAggregateError::Journal(
            novelx_runtime::event_journal::EventJournalError::MessageIdConflict { .. },
        ) => ("MESSAGE_ID_CONFLICT", RuntimeErrorClass::Protocol),
        RunAggregateError::UnknownEvent(_)
        | RunAggregateError::UnknownEventVersion { .. }
        | RunAggregateError::InvalidPayload
        | RunAggregateError::StateMismatch
        | RunAggregateError::SequenceGap { .. }
        | RunAggregateError::DuplicateCreated => (
            "RUN_JOURNAL_INTEGRITY_FAILED",
            RuntimeErrorClass::Validation,
        ),
        _ => ("RUN_PERSISTENCE_FAILED", RuntimeErrorClass::Storage),
    };
    eprintln!("{stage}: {error}");
    runtime_error(
        code,
        class,
        false,
        "任务状态无法安全处理，项目数据未被覆盖。",
        stage,
    )
}

fn runtime_error(
    code: &str,
    class: RuntimeErrorClass,
    retryable: bool,
    public_message: &str,
    stage: &str,
) -> RuntimeError {
    RuntimeError {
        code: code.to_owned(),
        class,
        retryable,
        public_message: public_message.to_owned(),
        stage: stage.to_owned(),
        attempt: 0,
        diagnostic_id: Uuid::new_v4(),
    }
}

fn lifecycle_state(state: RunState) -> RunLifecycleState {
    match state {
        RunState::Created => RunLifecycleState::Created,
        RunState::Preparing => RunLifecycleState::Preparing,
        RunState::Running => RunLifecycleState::Running,
        RunState::WaitingForApproval => RunLifecycleState::WaitingForApproval,
        RunState::Committing => RunLifecycleState::Committing,
        RunState::Retrying => RunLifecycleState::Retrying,
        RunState::Blocked => RunLifecycleState::Blocked,
        RunState::Cancelled => RunLifecycleState::Cancelled,
        RunState::Failed => RunLifecycleState::Failed,
        RunState::Completed => RunLifecycleState::Completed,
    }
}

fn recovery_classification(state: RunState) -> RunRecoveryClassification {
    match state {
        RunState::Created | RunState::Preparing | RunState::Running | RunState::Retrying => {
            RunRecoveryClassification::Resumable
        }
        RunState::WaitingForApproval => RunRecoveryClassification::WaitingForApproval,
        RunState::Committing => RunRecoveryClassification::CommitUncertain,
        RunState::Blocked | RunState::Cancelled | RunState::Failed | RunState::Completed => {
            RunRecoveryClassification::Terminal
        }
    }
}

#[derive(Clone, Debug)]
struct WorkspaceBinding {
    project_id: String,
    workspace_id: String,
}

fn write_response(
    output: &mut impl Write,
    command: &Envelope,
    sequence: u64,
    name: &str,
    payload: impl serde::Serialize,
) -> Result<(), Box<dyn std::error::Error>> {
    let response = response_envelope(command, sequence, name, payload)?;
    write_envelope(output, &response)
}

fn response_envelope(
    command: &Envelope,
    sequence: u64,
    name: &str,
    payload: impl serde::Serialize,
) -> Result<Envelope, Box<dyn std::error::Error>> {
    let sent_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    let mut response = Envelope::new(MessageType::Response, name, sent_at, sequence, payload)?;
    response.correlation_id = Some(command.message_id);
    Ok(response)
}

fn write_envelope(
    output: &mut impl Write,
    envelope: &Envelope,
) -> Result<(), Box<dyn std::error::Error>> {
    serde_json::to_writer(&mut *output, envelope)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn write_protocol_error(
    output: &mut impl Write,
    correlation_id: Uuid,
    sequence: u64,
    error: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let sent_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    let mut envelope = Envelope::new(
        MessageType::Event,
        "runtime.error",
        sent_at,
        sequence,
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
    envelope.correlation_id = Some(correlation_id);
    serde_json::to_writer(&mut *output, &envelope)?;
    output.write_all(b"\n")?;
    output.flush()?;
    eprintln!("runtime protocol error: {error}");
    Ok(())
}

fn initialize_runtime(path: &str) -> Result<(EventJournal, u64), InitializationError> {
    let journal = EventJournal::open(path).map_err(InitializationError::Storage)?;
    let report = RecoveryCoordinator::recover(&journal).map_err(InitializationError::Recovery)?;
    let count = report.recovered_nonterminal_count;
    Ok((journal, count))
}

fn write_initialization_failed(
    output: &mut impl Write,
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
    serde_json::to_writer(&mut *output, &envelope)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
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
