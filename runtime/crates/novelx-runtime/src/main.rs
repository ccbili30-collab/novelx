use std::io::{self, BufRead, Write};

use novelx_protocol::{
    Envelope, MessageType, PROTOCOL_VERSION, RuntimeBuild, RuntimeError, RuntimeErrorClass,
    RuntimeHello, RuntimeIdentity, RuntimeInitialize, RuntimeReady, RuntimeStatus, RuntimeStopped,
};
use novelx_runtime::event_journal::{EventJournal, EventJournalError};
use novelx_runtime::recovery::{RecoveryCoordinator, RecoveryError};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sent_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    let hello = RuntimeHello {
        runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
        protocol_versions: vec![PROTOCOL_VERSION],
        capabilities: vec!["handshake".to_owned()],
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

    let recovered_run_count = match initialize.workspace_database_path.as_deref() {
        None => 0,
        Some(path) => match initialize_runtime(path) {
            Ok(count) => count,
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
    if command.run_id.is_some() {
        return Err("runtime commands must not include runId".to_owned());
    }
    if command.sequence != expected_sequence {
        return Err(format!(
            "host sequence must be {expected_sequence}, received {}",
            command.sequence
        ));
    }
    if !matches!(
        command.name.as_str(),
        "runtime.status.get" | "runtime.shutdown"
    ) {
        return Err(format!("unknown runtime command: {}", command.name));
    }
    if !matches!(command.payload.as_object(), Some(payload) if payload.is_empty()) {
        return Err(format!("{} payload must be an empty object", command.name));
    }
    Ok(())
}

fn write_response(
    output: &mut impl Write,
    command: &Envelope,
    sequence: u64,
    name: &str,
    payload: impl serde::Serialize,
) -> Result<(), Box<dyn std::error::Error>> {
    let sent_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    let mut response = Envelope::new(MessageType::Response, name, sent_at, sequence, payload)?;
    response.correlation_id = Some(command.message_id);
    serde_json::to_writer(&mut *output, &response)?;
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

fn initialize_runtime(path: &str) -> Result<u64, InitializationError> {
    let journal = EventJournal::open(path).map_err(InitializationError::Storage)?;
    let report = RecoveryCoordinator::recover(&journal).map_err(InitializationError::Recovery)?;
    Ok(report.recovered_nonterminal_count)
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
