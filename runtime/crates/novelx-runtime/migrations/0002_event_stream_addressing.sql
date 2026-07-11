DROP TRIGGER IF EXISTS runtime_events_no_update;
DROP TRIGGER IF EXISTS runtime_events_no_delete;

ALTER TABLE runtime_events RENAME TO runtime_events_0001;

CREATE TABLE runtime_events (
    run_id TEXT NOT NULL,
    run_sequence INTEGER NOT NULL CHECK (run_sequence > 0),
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    aggregate_sequence INTEGER NOT NULL CHECK (aggregate_sequence > 0),
    message_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL CHECK (event_version > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, run_sequence),
    UNIQUE (run_id, aggregate_type, aggregate_id, aggregate_sequence),
    UNIQUE (run_id, idempotency_key)
) STRICT;

INSERT INTO runtime_events (
    run_id, run_sequence, aggregate_type, aggregate_id, aggregate_sequence,
    message_id, idempotency_key, event_type, event_version, payload_json, created_at
)
SELECT
    run_id, sequence, 'run', run_id, sequence,
    message_id, message_id, event_type, 1, payload_json, created_at
FROM runtime_events_0001
ORDER BY run_id, sequence;

CREATE INDEX runtime_events_aggregate_replay
    ON runtime_events (run_id, aggregate_type, aggregate_id, aggregate_sequence);

CREATE INDEX runtime_events_run_type_order
    ON runtime_events (run_id, aggregate_type, run_sequence);

CREATE TRIGGER runtime_events_no_update
BEFORE UPDATE ON runtime_events
BEGIN
    SELECT RAISE(ABORT, 'RUNTIME_EVENT_IMMUTABLE');
END;

CREATE TRIGGER runtime_events_no_delete
BEFORE DELETE ON runtime_events
BEGIN
    SELECT RAISE(ABORT, 'RUNTIME_EVENT_IMMUTABLE');
END;
