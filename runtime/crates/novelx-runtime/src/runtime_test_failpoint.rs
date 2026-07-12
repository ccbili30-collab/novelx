use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    thread,
    time::Duration,
};

use uuid::Uuid;

pub const NAME_ENV: &str = "NOVELX_RUNTIME_TEST_FAILPOINT_NAME";
pub const TOKEN_ENV: &str = "NOVELX_RUNTIME_TEST_FAILPOINT_TOKEN";
pub const DIRECTORY_ENV: &str = "NOVELX_RUNTIME_TEST_FAILPOINT_DIR";

pub fn hit(name: &'static str) {
    let Ok(selected) = env::var(NAME_ENV) else {
        return;
    };
    if selected != name {
        return;
    }
    let token = env::var(TOKEN_ENV).expect("armed Runtime test failpoint requires a token");
    Uuid::parse_str(&token).expect("Runtime test failpoint token must be a UUID");
    let directory = PathBuf::from(
        env::var_os(DIRECTORY_ENV)
            .expect("armed Runtime test failpoint requires a control directory"),
    );
    assert!(
        directory.is_absolute(),
        "Runtime test failpoint directory must be absolute"
    );
    let directory = directory
        .canonicalize()
        .expect("Runtime test failpoint directory must already exist");
    let armed_path = directory.join(format!("armed-{token}"));
    let armed = fs::read_to_string(&armed_path)
        .expect("Runtime test failpoint requires its one-time arm file");
    assert_eq!(
        armed.trim(),
        name,
        "Runtime test failpoint arm file does not match the selected point"
    );
    let reached_path = directory.join(format!("reached-{token}.json"));
    let reached_temporary_path = directory.join(format!("reached-{token}.tmp"));
    assert!(
        !reached_path.exists(),
        "Runtime test failpoint marker must be published exactly once"
    );
    let mut reached = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&reached_temporary_path)
        .expect("Runtime test failpoint marker must be created exactly once");
    let marker = serde_json::json!({
        "name": name,
        "token": token,
        "processId": std::process::id(),
    });
    serde_json::to_writer(&mut reached, &marker)
        .expect("Runtime test failpoint marker must serialize");
    reached
        .write_all(b"\n")
        .expect("Runtime test failpoint marker must finish writing");
    reached
        .sync_all()
        .expect("Runtime test failpoint marker must be durable before blocking");
    drop(reached);
    fs::rename(&reached_temporary_path, &reached_path)
        .expect("Runtime test failpoint marker must publish atomically");

    let release_path = directory.join(format!("release-{token}"));
    while !release_path.exists() {
        thread::park_timeout(Duration::from_millis(25));
    }
}
