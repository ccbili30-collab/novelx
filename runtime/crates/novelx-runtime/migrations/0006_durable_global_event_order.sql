DROP TRIGGER runtime_events_advance_global_clock;
DROP TRIGGER workspace_events_advance_global_clock;
DROP TRIGGER runtime_global_event_clock_no_delete;
DROP TABLE runtime_global_event_clock;

CREATE TABLE runtime_database_identity (
    singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
    database_instance_id TEXT NOT NULL UNIQUE CHECK (
        length(database_instance_id) = 36
        AND substr(database_instance_id, 9, 1) = '-'
        AND substr(database_instance_id, 14, 1) = '-'
        AND substr(database_instance_id, 19, 1) = '-'
        AND substr(database_instance_id, 24, 1) = '-'
    )
) STRICT;

CREATE TABLE runtime_global_event_ordering (
    singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
    ordering_version INTEGER NOT NULL CHECK (ordering_version = 1),
    ordered_sequence_base INTEGER NOT NULL CHECK (
        ordered_sequence_base BETWEEN 0 AND 9007199254740991
    ),
    legacy_runtime_event_count INTEGER NOT NULL CHECK (
        legacy_runtime_event_count BETWEEN 0 AND 9007199254740991
    ),
    legacy_workspace_event_count INTEGER NOT NULL CHECK (
        legacy_workspace_event_count BETWEEN 0 AND 9007199254740991
    ),
    FOREIGN KEY (singleton_id) REFERENCES runtime_database_identity(singleton_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE runtime_global_event_ledger (
    global_sequence INTEGER NOT NULL PRIMARY KEY CHECK (
        global_sequence BETWEEN 1 AND 9007199254740991
    ),
    event_kind TEXT NOT NULL CHECK (event_kind IN ('runtime', 'workspace')),
    runtime_message_id TEXT UNIQUE REFERENCES runtime_events(message_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    workspace_message_id TEXT UNIQUE REFERENCES workspace_events(message_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (
        (event_kind = 'runtime' AND runtime_message_id IS NOT NULL AND workspace_message_id IS NULL)
        OR
        (event_kind = 'workspace' AND runtime_message_id IS NULL AND workspace_message_id IS NOT NULL)
    )
) STRICT;

CREATE TABLE runtime_legacy_unordered_events (
    event_kind TEXT NOT NULL CHECK (event_kind IN ('runtime', 'workspace')),
    message_id TEXT NOT NULL CHECK (length(trim(message_id)) > 0),
    PRIMARY KEY (event_kind, message_id)
) STRICT;

CREATE TRIGGER runtime_database_identity_no_insert
BEFORE INSERT ON runtime_database_identity
WHEN EXISTS (SELECT 1 FROM runtime_database_identity)
BEGIN
    SELECT RAISE(ABORT, 'runtime_database_identity is immutable');
END;

CREATE TRIGGER runtime_database_identity_no_update
BEFORE UPDATE ON runtime_database_identity
BEGIN
    SELECT RAISE(ABORT, 'runtime_database_identity is immutable');
END;

CREATE TRIGGER runtime_database_identity_no_delete
BEFORE DELETE ON runtime_database_identity
BEGIN
    SELECT RAISE(ABORT, 'runtime_database_identity is immutable');
END;

CREATE TRIGGER runtime_global_event_ordering_no_insert
BEFORE INSERT ON runtime_global_event_ordering
WHEN EXISTS (SELECT 1 FROM runtime_global_event_ordering)
BEGIN
    SELECT RAISE(ABORT, 'runtime_global_event_ordering is immutable');
END;

CREATE TRIGGER runtime_global_event_ordering_no_update
BEFORE UPDATE ON runtime_global_event_ordering
BEGIN
    SELECT RAISE(ABORT, 'runtime_global_event_ordering is immutable');
END;

CREATE TRIGGER runtime_global_event_ordering_no_delete
BEFORE DELETE ON runtime_global_event_ordering
BEGIN
    SELECT RAISE(ABORT, 'runtime_global_event_ordering is immutable');
END;

CREATE TRIGGER runtime_legacy_unordered_events_no_insert
BEFORE INSERT ON runtime_legacy_unordered_events
WHEN EXISTS (SELECT 1 FROM runtime_global_event_ordering)
BEGIN
    SELECT RAISE(ABORT, 'runtime_legacy_unordered_events is immutable');
END;

CREATE TRIGGER runtime_legacy_unordered_events_no_update
BEFORE UPDATE ON runtime_legacy_unordered_events
BEGIN
    SELECT RAISE(ABORT, 'runtime_legacy_unordered_events is immutable');
END;

CREATE TRIGGER runtime_legacy_unordered_events_no_delete
BEFORE DELETE ON runtime_legacy_unordered_events
BEGIN
    SELECT RAISE(ABORT, 'runtime_legacy_unordered_events is immutable');
END;

CREATE TRIGGER runtime_events_safe_sequence_insert
BEFORE INSERT ON runtime_events
WHEN NEW.run_sequence > 9007199254740991
    OR NEW.aggregate_sequence > 9007199254740991
BEGIN
    SELECT RAISE(ABORT, 'runtime_events sequence exceeds MAX_SAFE_SEQUENCE');
END;

CREATE TRIGGER workspace_events_safe_sequence_insert
BEFORE INSERT ON workspace_events
WHEN NEW.workspace_sequence > 9007199254740991
    OR NEW.stream_sequence > 9007199254740991
BEGIN
    SELECT RAISE(ABORT, 'workspace_events sequence exceeds MAX_SAFE_SEQUENCE');
END;

CREATE TRIGGER runtime_global_event_ledger_validate_insert
BEFORE INSERT ON runtime_global_event_ledger
BEGIN
    SELECT CASE
        WHEN COALESCE(
            (SELECT MAX(global_sequence) FROM runtime_global_event_ledger),
            (SELECT ordered_sequence_base FROM runtime_global_event_ordering WHERE singleton_id = 1)
        ) >= 9007199254740991
        THEN RAISE(ABORT, 'runtime_global_event_ledger exhausted MAX_SAFE_SEQUENCE')
    END;
    SELECT CASE
        WHEN NEW.global_sequence <> COALESCE(
            (SELECT MAX(global_sequence) FROM runtime_global_event_ledger),
            (SELECT ordered_sequence_base FROM runtime_global_event_ordering WHERE singleton_id = 1)
        ) + 1
        THEN RAISE(ABORT, 'runtime_global_event_ledger sequence is not next')
    END;
END;

CREATE TRIGGER runtime_events_record_global_order
AFTER INSERT ON runtime_events
BEGIN
    INSERT INTO runtime_global_event_ledger (
        global_sequence, event_kind, runtime_message_id, workspace_message_id
    )
    SELECT
        COALESCE(
            (SELECT MAX(global_sequence) FROM runtime_global_event_ledger),
            (SELECT ordered_sequence_base FROM runtime_global_event_ordering WHERE singleton_id = 1)
        ) + 1,
        'runtime', NEW.message_id, NULL;
END;

CREATE TRIGGER workspace_events_record_global_order
AFTER INSERT ON workspace_events
BEGIN
    INSERT INTO runtime_global_event_ledger (
        global_sequence, event_kind, runtime_message_id, workspace_message_id
    )
    SELECT
        COALESCE(
            (SELECT MAX(global_sequence) FROM runtime_global_event_ledger),
            (SELECT ordered_sequence_base FROM runtime_global_event_ordering WHERE singleton_id = 1)
        ) + 1,
        'workspace', NULL, NEW.message_id;
END;

CREATE TRIGGER runtime_global_event_ledger_no_update
BEFORE UPDATE ON runtime_global_event_ledger
BEGIN
    SELECT RAISE(ABORT, 'runtime_global_event_ledger is append-only');
END;

CREATE TRIGGER runtime_global_event_ledger_no_delete
BEFORE DELETE ON runtime_global_event_ledger
BEGIN
    SELECT RAISE(ABORT, 'runtime_global_event_ledger is append-only');
END;
