use std::io::{self, BufRead, Write};

use novelx_protocol::{
    Envelope, MessageType, PROTOCOL_VERSION, RuntimeBuild, RuntimeHello, RuntimeIdentity,
    RuntimeInitialize, RuntimeReady,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

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
            recovered_run_count: 0,
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
