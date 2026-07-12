CREATE TABLE runtime_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK (length(media_type) > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    utf8_bytes INTEGER NOT NULL CHECK (utf8_bytes >= 0),
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX runtime_artifacts_run_created
ON runtime_artifacts (run_id, created_at, artifact_id);

CREATE TRIGGER runtime_artifacts_no_update
BEFORE UPDATE ON runtime_artifacts
BEGIN
    SELECT RAISE(ABORT, 'runtime_artifact_immutable');
END;

CREATE TRIGGER runtime_artifacts_no_delete
BEFORE DELETE ON runtime_artifacts
BEGIN
    SELECT RAISE(ABORT, 'runtime_artifact_immutable');
END;
