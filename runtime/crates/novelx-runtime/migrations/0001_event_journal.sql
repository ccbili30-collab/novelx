CREATE TABLE IF NOT EXISTS runtime_events (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    message_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS runtime_events_run_order
    ON runtime_events (run_id, sequence);

CREATE TRIGGER IF NOT EXISTS runtime_events_no_update
BEFORE UPDATE ON runtime_events
BEGIN
    SELECT RAISE(ABORT, 'RUNTIME_EVENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS runtime_events_no_delete
BEFORE DELETE ON runtime_events
BEGIN
    SELECT RAISE(ABORT, 'RUNTIME_EVENT_IMMUTABLE');
END;
