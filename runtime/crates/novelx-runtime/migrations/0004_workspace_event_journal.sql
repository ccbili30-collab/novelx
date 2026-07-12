CREATE TABLE workspace_events (
    workspace_id TEXT NOT NULL CHECK (length(trim(workspace_id)) > 0),
    workspace_sequence INTEGER NOT NULL CHECK (workspace_sequence > 0),
    stream_type TEXT NOT NULL CHECK (length(trim(stream_type)) > 0),
    stream_id TEXT NOT NULL CHECK (length(trim(stream_id)) > 0),
    stream_sequence INTEGER NOT NULL CHECK (stream_sequence > 0),
    message_id TEXT NOT NULL CHECK (length(trim(message_id)) > 0),
    idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
    event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
    event_version INTEGER NOT NULL CHECK (event_version > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    PRIMARY KEY (workspace_id, workspace_sequence),
    UNIQUE (workspace_id, stream_type, stream_id, stream_sequence),
    UNIQUE (message_id),
    UNIQUE (workspace_id, idempotency_key)
) STRICT;

CREATE INDEX workspace_events_stream_replay
    ON workspace_events (workspace_id, stream_type, stream_id, stream_sequence);

CREATE INDEX workspace_events_type_order
    ON workspace_events (workspace_id, stream_type, workspace_sequence);

CREATE TRIGGER workspace_events_no_update
BEFORE UPDATE ON workspace_events
BEGIN
    SELECT RAISE(ABORT, 'workspace_events is append-only');
END;

CREATE TRIGGER workspace_events_no_delete
BEFORE DELETE ON workspace_events
BEGIN
    SELECT RAISE(ABORT, 'workspace_events is append-only');
END;
