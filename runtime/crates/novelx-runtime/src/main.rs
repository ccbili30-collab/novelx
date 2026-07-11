use std::io::{self, BufRead, Write};

use novelx_protocol::{
    Envelope, MessageType, PROTOCOL_VERSION, RuntimeBuild, RuntimeError, RuntimeErrorClass,
    RuntimeHello, RuntimeIdentity, RuntimeInitialize, RuntimeReady,
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
    initialize_envelope.validate_version()?;
    if initialize_envelope.message_type != MessageType::Command {
        return Err("runtime.initialize must be a command message".into());
    }
    if initialize_envelope.name != "runtime.initialize" {
        return Err(format!("unexpected handshake message: {}", initialize_envelope.name).into());
    }
    if initialize_envelope.correlation_id.is_some() {
        return Err("runtime.initialize must not include correlationId".into());
    }
    if initialize_envelope.run_id.is_some() {
        return Err("runtime.initialize must not include runId".into());
    }
    let initialize: RuntimeInitialize = serde_json::from_value(initialize_envelope.payload)?;
    if initialize.selected_protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "runtime.initialize selected unsupported protocol version {}",
            initialize.selected_protocol_version
        )
        .into());
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

    if let Some(extra_line) = lines.next() {
        extra_line?;
        return Err(
            "runtime accepts no messages after runtime.initialize in handshake-only mode".into(),
        );
    }
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
