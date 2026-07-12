CREATE TABLE runtime_global_event_clock (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    sequence INTEGER NOT NULL CHECK (sequence >= 0)
) STRICT;

INSERT INTO runtime_global_event_clock (singleton_id, sequence) VALUES (1, 0);

CREATE TRIGGER runtime_events_advance_global_clock
AFTER INSERT ON runtime_events
BEGIN
    UPDATE runtime_global_event_clock SET sequence = sequence + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER workspace_events_advance_global_clock
AFTER INSERT ON workspace_events
BEGIN
    UPDATE runtime_global_event_clock SET sequence = sequence + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER runtime_global_event_clock_no_delete
BEFORE DELETE ON runtime_global_event_clock
BEGIN
    SELECT RAISE(ABORT, 'runtime_global_event_clock cannot be deleted');
END;
