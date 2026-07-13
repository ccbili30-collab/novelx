use std::sync::{Arc, Barrier};

use novelx_protocol::MAX_SAFE_SEQUENCE;
use novelx_runtime::{
    event_journal::{EventJournal, EventJournalError, GlobalEventOrder, NewRuntimeEvent},
    workspace_event_journal::{
        NewWorkspaceEvent, WorkspaceEventJournal, WorkspaceEventJournalError,
    },
};
use rusqlite::{Connection, params};
use serde_json::json;

const MIGRATION_0005: &str = include_str!("../migrations/0005_global_event_clock.sql");

#[test]
fn database_identity_is_stable_across_reopen_and_copy_but_distinguishes_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let original_path = temp.path().join("original.db");
    let copy_path = temp.path().join("copy.db");
    let replacement_path = temp.path().join("replacement.db");

    let original_id = EventJournal::open(&original_path)
        .unwrap()
        .database_instance_id()
        .to_owned();
    assert_eq!(
        EventJournal::open(&original_path)
            .unwrap()
            .database_instance_id(),
        original_id
    );
    checkpoint(&original_path);
    std::fs::copy(&original_path, &copy_path).unwrap();
    assert_eq!(
        EventJournal::open(&copy_path)
            .unwrap()
            .database_instance_id(),
        original_id
    );

    let replacement_id = EventJournal::open(&replacement_path)
        .unwrap()
        .database_instance_id()
        .to_owned();
    assert_ne!(replacement_id, original_id);
    checkpoint(&replacement_path);
    std::fs::remove_file(&original_path).unwrap();
    std::fs::copy(&replacement_path, &original_path).unwrap();
    assert_eq!(
        EventJournal::open(&original_path)
            .unwrap()
            .database_instance_id(),
        replacement_id
    );
}

#[test]
fn runtime_and_workspace_events_receive_exact_shared_global_order_with_chinese_payloads() {
    let fixture = Fixture::new();
    let mut runtime = EventJournal::open(&fixture.path).unwrap();
    let runtime_event = runtime
        .append(
            runtime_event("运行-一", "运行键-一", "银河海岸线为什么曲折"),
            0,
            0,
        )
        .unwrap();
    assert_eq!(
        runtime
            .global_order_for_message(&runtime_event.message_id)
            .unwrap(),
        Some(GlobalEventOrder::Ordered(1))
    );

    let mut workspace = WorkspaceEventJournal::open(&fixture.path).unwrap();
    let workspace_event = workspace
        .append(
            workspace_event("工作区-一", "工作键-一", "精灵诞生于星潮"),
            0,
            0,
        )
        .unwrap();
    assert_eq!(
        workspace
            .global_order_for_message(&workspace_event.message_id)
            .unwrap(),
        Some(GlobalEventOrder::Ordered(2))
    );
    assert_eq!(workspace.current_global_sequence().unwrap(), 2);
    assert_eq!(runtime.current_global_sequence().unwrap(), 2);

    let rows: Vec<(i64, String, Option<String>, Option<String>)> = Connection::open(&fixture.path)
        .unwrap()
        .prepare(
            "SELECT global_sequence, event_kind, runtime_message_id, workspace_message_id \
             FROM runtime_global_event_ledger ORDER BY global_sequence",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            (1, "runtime".to_owned(), Some("运行-一".to_owned()), None),
            (
                2,
                "workspace".to_owned(),
                None,
                Some("工作区-一".to_owned())
            )
        ]
    );
}

#[test]
fn legacy_events_are_explicitly_unordered_and_new_order_starts_after_honest_prefix() {
    let fixture = Fixture::new();
    downgrade_empty_database_to_v5(&fixture.path);
    let connection = Connection::open(&fixture.path).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .unwrap();
    insert_legacy_runtime(&connection, "legacy-runtime");
    insert_legacy_workspace(&connection, "legacy-workspace");
    connection
        .execute(
            "UPDATE runtime_global_event_clock SET sequence = 0 WHERE singleton_id = 1",
            [],
        )
        .unwrap();
    drop(connection);

    let mut runtime = EventJournal::open(&fixture.path).unwrap();
    assert_eq!(runtime.current_global_sequence().unwrap(), 2);
    assert_eq!(
        runtime.global_order_for_message("legacy-runtime").unwrap(),
        Some(GlobalEventOrder::LegacyUnordered)
    );
    let workspace = WorkspaceEventJournal::open(&fixture.path).unwrap();
    assert_eq!(
        workspace
            .global_order_for_message("legacy-workspace")
            .unwrap(),
        Some(GlobalEventOrder::LegacyUnordered)
    );
    drop(workspace);

    runtime
        .append(
            runtime_event("ordered-runtime", "ordered-runtime-key", "迁移后的事实"),
            0,
            0,
        )
        .unwrap();
    assert_eq!(
        runtime.global_order_for_message("ordered-runtime").unwrap(),
        Some(GlobalEventOrder::Ordered(3))
    );
    assert_eq!(runtime.current_global_sequence().unwrap(), 3);
}

#[test]
fn legacy_clock_ahead_of_stored_events_fails_closed() {
    let fixture = Fixture::new();
    downgrade_empty_database_to_v5(&fixture.path);
    Connection::open(&fixture.path)
        .unwrap()
        .execute(
            "UPDATE runtime_global_event_clock SET sequence = 1 WHERE singleton_id = 1",
            [],
        )
        .unwrap();
    assert!(matches!(
        EventJournal::open(&fixture.path),
        Err(EventJournalError::LegacyGlobalClockInvalid {
            clock: 1,
            event_count: 0
        })
    ));
}

#[test]
fn identity_ordering_and_ledger_rows_reject_external_mutation() {
    let fixture = Fixture::new();
    let mut runtime = EventJournal::open(&fixture.path).unwrap();
    runtime
        .append(
            runtime_event("runtime-1", "runtime-key-1", "不可篡改"),
            0,
            0,
        )
        .unwrap();
    drop(runtime);
    let connection = Connection::open(&fixture.path).unwrap();
    assert!(
        connection
            .execute(
                "UPDATE runtime_database_identity SET database_instance_id = ?1",
                [uuid::Uuid::new_v4().to_string()],
            )
            .is_err()
    );
    assert!(
        connection
            .execute(
                "UPDATE runtime_global_event_ordering SET ordered_sequence_base = 99",
                [],
            )
            .is_err()
    );
    assert!(
        connection
            .execute(
                "UPDATE runtime_global_event_ledger SET global_sequence = 99",
                [],
            )
            .is_err()
    );
    assert!(
        connection
            .execute("UPDATE runtime_global_event_clock SET sequence = 99", [])
            .is_err()
    );
}

#[test]
fn same_named_no_op_global_order_trigger_is_rejected_on_open() {
    let fixture = Fixture::new();
    drop(EventJournal::open(&fixture.path).unwrap());
    Connection::open(&fixture.path)
        .unwrap()
        .execute_batch(
            "DROP TRIGGER runtime_events_record_global_order; \
             CREATE TRIGGER runtime_events_record_global_order AFTER INSERT ON runtime_events \
             BEGIN SELECT 1; END;",
        )
        .unwrap();
    assert!(matches!(
        EventJournal::open(&fixture.path),
        Err(EventJournalError::SchemaIntegrityFailed)
    ));
}

#[test]
fn cross_journal_global_cas_allows_exactly_one_concurrent_winner() {
    let fixture = Fixture::new();
    drop(EventJournal::open(&fixture.path).unwrap());
    let barrier = Arc::new(Barrier::new(3));
    let runtime_path = fixture.path.clone();
    let runtime_barrier = Arc::clone(&barrier);
    let runtime = std::thread::spawn(move || {
        let mut journal = EventJournal::open(runtime_path).unwrap();
        runtime_barrier.wait();
        journal.append_at_global_sequence(
            runtime_event("runtime-cas", "runtime-cas-key", "并发运行事件"),
            0,
            0,
            0,
        )
    });
    let workspace_path = fixture.path.clone();
    let workspace_barrier = Arc::clone(&barrier);
    let workspace = std::thread::spawn(move || {
        let mut journal = WorkspaceEventJournal::open(workspace_path).unwrap();
        workspace_barrier.wait();
        journal.append_at_global_sequence(
            workspace_event("workspace-cas", "workspace-cas-key", "并发工作区事件"),
            0,
            0,
            0,
        )
    });
    barrier.wait();
    let runtime_result = runtime.join().unwrap();
    let workspace_result = workspace.join().unwrap();
    assert_ne!(runtime_result.is_ok(), workspace_result.is_ok());
    assert!(
        matches!(
            runtime_result,
            Err(EventJournalError::GlobalSequenceConflict {
                expected: 0,
                actual: 1
            })
        ) || matches!(
            workspace_result,
            Err(WorkspaceEventJournalError::GlobalSequenceConflict {
                expected: 0,
                actual: 1
            })
        )
    );
    assert_eq!(
        EventJournal::open(&fixture.path)
            .unwrap()
            .current_global_sequence()
            .unwrap(),
        1
    );
}

#[test]
fn workspace_global_cas_retry_returns_the_original_event_after_global_progress() {
    let fixture = Fixture::new();
    let mut workspace = WorkspaceEventJournal::open(&fixture.path).unwrap();
    let event = workspace_event(
        "workspace-idempotent-cas",
        "workspace-idempotent-cas-key",
        "同一命令重试不得被后续全局事件破坏",
    );
    let stored = workspace
        .append_at_global_sequence(event.clone(), 0, 0, 0)
        .unwrap();

    EventJournal::open(&fixture.path)
        .unwrap()
        .append(
            runtime_event("runtime-after-retry", "runtime-after-retry-key", "后续事件"),
            0,
            0,
        )
        .unwrap();

    let mut retry = event;
    retry.message_id = "workspace-idempotent-cas-retry-message".to_owned();
    retry.created_at = "2026-07-13T00:00:09Z".to_owned();
    let retried = workspace
        .append_at_global_sequence(retry.clone(), 0, 0, 0)
        .unwrap();
    assert_eq!(retried, stored);
    assert!(matches!(
        workspace.append_at_global_sequence(retry, 0, 0, 1),
        Err(WorkspaceEventJournalError::GlobalSequenceConflict {
            expected: 1,
            actual: 0
        })
    ));
    assert_eq!(workspace.current_global_sequence().unwrap(), 2);
}

#[test]
fn runtime_global_cas_retry_reconstitutes_transport_fields_and_checks_original_fence() {
    let fixture = Fixture::new();
    let mut runtime = EventJournal::open(&fixture.path).unwrap();
    let event = runtime_event(
        "runtime-idempotent-cas",
        "runtime-idempotent-cas-key",
        "同一运行命令",
    );
    let stored = runtime
        .append_at_global_sequence(event.clone(), 0, 0, 0)
        .unwrap()
        .event;
    WorkspaceEventJournal::open(&fixture.path)
        .unwrap()
        .append(
            workspace_event(
                "workspace-after-runtime",
                "workspace-after-runtime-key",
                "后续事件",
            ),
            0,
            0,
        )
        .unwrap();

    let mut retry = event;
    retry.message_id = "runtime-idempotent-cas-retry-message".to_owned();
    retry.created_at = "2026-07-13T00:00:09Z".to_owned();
    let retried = runtime
        .append_at_global_sequence(retry.clone(), 0, 0, 0)
        .unwrap();
    assert!(!retried.inserted);
    assert_eq!(retried.event, stored);
    assert!(matches!(
        runtime.append_at_global_sequence(retry, 0, 0, 1),
        Err(EventJournalError::GlobalSequenceConflict {
            expected: 1,
            actual: 0
        })
    ));
}

#[test]
fn global_cas_retry_rejects_legacy_and_missing_orders_with_typed_errors() {
    let fixture = Fixture::new();
    downgrade_empty_database_to_v5(&fixture.path);
    let connection = Connection::open(&fixture.path).unwrap();
    insert_legacy_runtime(&connection, "legacy-runtime");
    insert_legacy_workspace(&connection, "legacy-workspace");
    drop(connection);

    let mut runtime = EventJournal::open(&fixture.path).unwrap();
    let legacy_runtime_retry = NewRuntimeEvent {
        run_id: "legacy-run".to_owned(),
        aggregate_type: "run".to_owned(),
        aggregate_id: "legacy-run".to_owned(),
        message_id: "legacy-runtime-retry-message".to_owned(),
        idempotency_key: "legacy-runtime-key".to_owned(),
        event_type: "legacy.runtime".to_owned(),
        event_version: 1,
        payload: json!({"事实": "旧运行事件"}),
        created_at: "2026-07-13T00:00:09Z".to_owned(),
    };
    assert!(matches!(
        runtime.append_at_global_sequence(legacy_runtime_retry, 0, 0, 2),
        Err(EventJournalError::GlobalEventLegacyUnordered { message_id })
            if message_id == "legacy-runtime"
    ));

    let mut workspace = WorkspaceEventJournal::open(&fixture.path).unwrap();
    let legacy_workspace_retry = NewWorkspaceEvent {
        workspace_id: "legacy-workspace".to_owned(),
        stream_type: "goal".to_owned(),
        stream_id: "legacy-goal".to_owned(),
        message_id: "legacy-workspace-retry-message".to_owned(),
        idempotency_key: "legacy-workspace-key".to_owned(),
        event_type: "legacy.workspace".to_owned(),
        event_version: 1,
        payload: json!({"事实": "旧工作区事件"}),
        created_at: "2026-07-13T00:00:09Z".to_owned(),
    };
    assert!(matches!(
        workspace.append_at_global_sequence(legacy_workspace_retry, 0, 0, 2),
        Err(WorkspaceEventJournalError::GlobalEventLegacyUnordered { message_id })
            if message_id == "legacy-workspace"
    ));

    let missing_event = runtime_event("ordered-missing", "ordered-missing-key", "账本将被破坏");
    runtime
        .append_at_global_sequence(missing_event.clone(), 0, 0, 2)
        .unwrap();
    let connection = Connection::open(&fixture.path).unwrap();
    connection
        .execute_batch(
            "DROP TRIGGER runtime_global_event_ledger_no_delete; \
             DELETE FROM runtime_global_event_ledger WHERE runtime_message_id = 'ordered-missing'; \
             CREATE TRIGGER runtime_global_event_ledger_no_delete \
             BEFORE DELETE ON runtime_global_event_ledger \
             BEGIN \
                 SELECT RAISE(ABORT, 'runtime_global_event_ledger is append-only'); \
             END;",
        )
        .unwrap();
    let mut missing_retry = missing_event;
    missing_retry.message_id = "ordered-missing-retry".to_owned();
    missing_retry.created_at = "2026-07-13T00:00:09Z".to_owned();
    assert!(matches!(
        runtime.append_at_global_sequence(missing_retry, 0, 0, 2),
        Err(EventJournalError::GlobalEventOrderMissing { message_id })
            if message_id == "ordered-missing"
    ));
}

#[test]
fn normal_open_is_structural_but_explicit_deep_check_detects_data_corruption() {
    let fixture = Fixture::new();
    EventJournal::open(&fixture.path)
        .unwrap()
        .append(
            runtime_event("deep-check", "deep-check-key", "深检证据"),
            0,
            0,
        )
        .unwrap();
    Connection::open(&fixture.path)
        .unwrap()
        .execute_batch(
            "DROP TRIGGER runtime_global_event_ledger_no_delete; \
             DELETE FROM runtime_global_event_ledger WHERE runtime_message_id = 'deep-check'; \
             CREATE TRIGGER runtime_global_event_ledger_no_delete \
             BEFORE DELETE ON runtime_global_event_ledger \
             BEGIN \
                 SELECT RAISE(ABORT, 'runtime_global_event_ledger is append-only'); \
             END;",
        )
        .unwrap();

    let mut structural = EventJournal::open(&fixture.path).unwrap();
    assert!(matches!(
        structural.verify_deep_data_integrity(),
        Err(EventJournalError::SchemaIntegrityFailed)
    ));
}

#[test]
fn exact_trigger_sql_rejects_changed_quoted_literal_case() {
    let fixture = Fixture::new();
    drop(EventJournal::open(&fixture.path).unwrap());
    Connection::open(&fixture.path)
        .unwrap()
        .execute_batch(
            "DROP TRIGGER runtime_events_record_global_order; \
             CREATE TRIGGER runtime_events_record_global_order \
             AFTER INSERT ON runtime_events \
             BEGIN \
                 INSERT INTO runtime_global_event_ledger ( \
                     global_sequence, event_kind, runtime_message_id, workspace_message_id \
                 ) \
                 SELECT \
                     COALESCE( \
                         (SELECT MAX(global_sequence) FROM runtime_global_event_ledger), \
                         (SELECT ordered_sequence_base FROM runtime_global_event_ordering WHERE singleton_id = 1) \
                     ) + 1, \
                     'RUNTIME', NEW.message_id, NULL; \
             END;",
        )
        .unwrap();
    assert!(matches!(
        EventJournal::open(&fixture.path),
        Err(EventJournalError::SchemaIntegrityFailed)
    ));
}

#[test]
fn all_persisted_sequence_domains_enforce_javascript_safe_integer_bounds() {
    let fixture = Fixture::new();
    let mut runtime = EventJournal::open(&fixture.path).unwrap();
    assert!(matches!(
        runtime.append(
            runtime_event("unsafe-expected-run", "unsafe-expected-run-key", "越界"),
            MAX_SAFE_SEQUENCE + 1,
            0,
        ),
        Err(EventJournalError::SequenceOutOfRange)
    ));
    assert!(matches!(
        runtime.append(
            runtime_event(
                "unsafe-expected-aggregate",
                "unsafe-expected-aggregate-key",
                "越界",
            ),
            0,
            MAX_SAFE_SEQUENCE + 1,
        ),
        Err(EventJournalError::SequenceOutOfRange)
    ));
    assert!(matches!(
        runtime.append_at_global_sequence(
            runtime_event("unsafe-global", "unsafe-global-key", "越界"),
            0,
            0,
            MAX_SAFE_SEQUENCE + 1,
        ),
        Err(EventJournalError::SequenceOutOfRange)
    ));
    let mut workspace = WorkspaceEventJournal::open(&fixture.path).unwrap();
    assert!(matches!(
        workspace.append(
            workspace_event("unsafe-workspace", "unsafe-workspace-key", "越界"),
            0,
            MAX_SAFE_SEQUENCE + 1,
        ),
        Err(WorkspaceEventJournalError::SequenceOutOfRange)
    ));
    assert!(matches!(
        workspace.append(
            workspace_event(
                "unsafe-workspace-sequence",
                "unsafe-workspace-sequence-key",
                "越界",
            ),
            MAX_SAFE_SEQUENCE + 1,
            0,
        ),
        Err(WorkspaceEventJournalError::SequenceOutOfRange)
    ));

    let connection = Connection::open(&fixture.path).unwrap();
    let unsafe_value = i64::try_from(MAX_SAFE_SEQUENCE + 1).unwrap();
    assert!(
        connection
            .execute(
                "INSERT INTO runtime_events (run_id, run_sequence, aggregate_type, aggregate_id, \
             aggregate_sequence, message_id, idempotency_key, event_type, event_version, \
             payload_json, created_at) VALUES ('unsafe-run', ?1, 'run', 'unsafe-run', 1, \
             'unsafe-runtime-row', 'unsafe-runtime-row-key', 'unsafe.runtime', 1, '{}', \
             '2026-07-13T00:00:00Z')",
                [unsafe_value],
            )
            .is_err()
    );
    assert!(
        connection
            .execute(
                "INSERT INTO runtime_events (run_id, run_sequence, aggregate_type, aggregate_id, \
             aggregate_sequence, message_id, idempotency_key, event_type, event_version, \
             payload_json, created_at) VALUES ('unsafe-aggregate', 1, 'run', \
             'unsafe-aggregate', ?1, 'unsafe-aggregate-row', 'unsafe-aggregate-row-key', \
             'unsafe.runtime', 1, '{}', '2026-07-13T00:00:00Z')",
                [unsafe_value],
            )
            .is_err()
    );
    assert!(
        connection
            .execute(
                "INSERT INTO workspace_events (workspace_id, workspace_sequence, stream_type, \
             stream_id, stream_sequence, message_id, idempotency_key, event_type, event_version, \
             payload_json, created_at) VALUES ('unsafe-workspace-row', 1, 'test', 'unsafe', ?1, \
             'unsafe-workspace-row-message', 'unsafe-workspace-row-key', 'unsafe.workspace', 1, \
             '{}', '2026-07-13T00:00:00Z')",
                [unsafe_value],
            )
            .is_err()
    );
    assert!(
        connection
            .execute(
                "INSERT INTO workspace_events (workspace_id, workspace_sequence, stream_type, \
             stream_id, stream_sequence, message_id, idempotency_key, event_type, event_version, \
             payload_json, created_at) VALUES ('unsafe-workspace-sequence-row', ?1, 'test', \
             'unsafe', 1, 'unsafe-workspace-sequence-row-message', \
             'unsafe-workspace-sequence-row-key', 'unsafe.workspace', 1, '{}', \
             '2026-07-13T00:00:00Z')",
                [unsafe_value],
            )
            .is_err()
    );
    assert!(
        connection
            .execute(
                "INSERT INTO runtime_global_event_ledger (global_sequence, event_kind, \
             runtime_message_id, workspace_message_id) VALUES (?1, 'runtime', \
             'missing-global-row', NULL)",
                [unsafe_value],
            )
            .is_err()
    );
    connection
        .execute_batch("DROP TRIGGER runtime_global_event_ordering_no_update;")
        .unwrap();
    assert!(
        connection
            .execute(
                "UPDATE runtime_global_event_ordering SET ordered_sequence_base = ?1",
                [unsafe_value],
            )
            .is_err()
    );
}

#[test]
fn workspace_current_sequence_apis_reject_unsafe_persisted_values() {
    let fixture = Fixture::new();
    let mut workspace = WorkspaceEventJournal::open(&fixture.path).unwrap();
    let unsafe_value = i64::try_from(MAX_SAFE_SEQUENCE + 1).unwrap();
    let connection = Connection::open(&fixture.path).unwrap();
    connection
        .execute_batch("DROP TRIGGER workspace_events_safe_sequence_insert;")
        .unwrap();
    connection
        .execute(
            "INSERT INTO workspace_events (workspace_id, workspace_sequence, stream_type, \
             stream_id, stream_sequence, message_id, idempotency_key, event_type, event_version, \
             payload_json, created_at) VALUES ('unsafe-api-workspace', ?1, 'test', \
             'unsafe-api-stream', ?1, 'unsafe-api-message', 'unsafe-api-key', \
             'unsafe.api', 1, '{}', '2026-07-13T00:00:00Z')",
            [unsafe_value],
        )
        .unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER workspace_events_safe_sequence_insert \
             BEFORE INSERT ON workspace_events \
             WHEN NEW.workspace_sequence > 9007199254740991 \
                 OR NEW.stream_sequence > 9007199254740991 \
             BEGIN \
                 SELECT RAISE(ABORT, 'workspace_events sequence exceeds MAX_SAFE_SEQUENCE'); \
             END;",
        )
        .unwrap();

    assert!(matches!(
        workspace.current_workspace_sequence("unsafe-api-workspace"),
        Err(WorkspaceEventJournalError::SequenceOutOfRange)
    ));
    assert!(matches!(
        workspace.current_stream_sequence("unsafe-api-workspace", "test", "unsafe-api-stream"),
        Err(WorkspaceEventJournalError::SequenceOutOfRange)
    ));
    assert!(matches!(
        workspace.verify_deep_data_integrity(),
        Err(WorkspaceEventJournalError::RuntimeJournal(
            EventJournalError::SequenceOutOfRange
        ))
    ));
}

#[test]
fn concurrent_v5_to_v6_open_rechecks_migration_after_acquiring_write_lock() {
    let fixture = Fixture::new();
    downgrade_empty_database_to_v5(&fixture.path);
    let barrier = Arc::new(Barrier::new(3));
    let handles = (0..2)
        .map(|_| {
            let path = fixture.path.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                EventJournal::open(path).map(|journal| journal.database_instance_id().to_owned())
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let ids = handles
        .into_iter()
        .map(|handle| handle.join().unwrap().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids[0], ids[1]);
    let migration_count: i64 = Connection::open(&fixture.path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM runtime_schema_migrations WHERE version = 6",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(migration_count, 1);
}

#[test]
fn concurrent_mixed_journals_allocate_one_contiguous_global_order() {
    let fixture = Fixture::new();
    drop(EventJournal::open(&fixture.path).unwrap());
    let handles = (0..16)
        .map(|index| {
            let path = fixture.path.clone();
            std::thread::spawn(move || {
                if index % 2 == 0 {
                    EventJournal::open(path)
                        .unwrap()
                        .append(
                            runtime_event(
                                &format!("runtime-parallel-{index}"),
                                &format!("runtime-parallel-key-{index}"),
                                "并发事实",
                            ),
                            0,
                            0,
                        )
                        .unwrap();
                } else {
                    let mut event = workspace_event(
                        &format!("workspace-parallel-{index}"),
                        &format!("workspace-parallel-key-{index}"),
                        "并发世界事实",
                    );
                    event.workspace_id = format!("workspace-parallel-{index}");
                    WorkspaceEventJournal::open(path)
                        .unwrap()
                        .append(event, 0, 0)
                        .unwrap();
                }
            })
        })
        .collect::<Vec<_>>();
    for handle in handles {
        handle.join().unwrap();
    }

    let connection = Connection::open(&fixture.path).unwrap();
    let sequences = connection
        .prepare("SELECT global_sequence FROM runtime_global_event_ledger ORDER BY global_sequence")
        .unwrap()
        .query_map([], |row| row.get::<_, u64>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(sequences, (1..=16).collect::<Vec<_>>());
}

fn checkpoint(path: &std::path::Path) {
    Connection::open(path)
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
}

fn downgrade_empty_database_to_v5(path: &std::path::Path) {
    drop(EventJournal::open(path).unwrap());
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .unwrap();
    connection
        .execute_batch(
            "DROP TRIGGER runtime_database_identity_no_insert; \
             DROP TRIGGER runtime_database_identity_no_update; \
             DROP TRIGGER runtime_database_identity_no_delete; \
             DROP TRIGGER runtime_global_event_ordering_no_insert; \
             DROP TRIGGER runtime_global_event_ordering_no_update; \
             DROP TRIGGER runtime_global_event_ordering_no_delete; \
             DROP TRIGGER runtime_legacy_unordered_events_no_insert; \
             DROP TRIGGER runtime_legacy_unordered_events_no_update; \
             DROP TRIGGER runtime_legacy_unordered_events_no_delete; \
             DROP TRIGGER runtime_events_safe_sequence_insert; \
             DROP TRIGGER workspace_events_safe_sequence_insert; \
             DROP TRIGGER runtime_global_event_ledger_validate_insert; \
             DROP TRIGGER runtime_events_record_global_order; \
             DROP TRIGGER workspace_events_record_global_order; \
             DROP TRIGGER runtime_global_event_ledger_no_update; \
             DROP TRIGGER runtime_global_event_ledger_no_delete; \
             DROP TABLE runtime_global_event_ledger; \
             DROP TABLE runtime_global_event_ordering; \
             DROP TABLE runtime_legacy_unordered_events; \
             DROP TABLE runtime_database_identity; \
             DELETE FROM runtime_schema_migrations WHERE version = 6;",
        )
        .unwrap();
    connection.execute_batch(MIGRATION_0005).unwrap();
}

fn insert_legacy_runtime(connection: &Connection, message_id: &str) {
    connection
        .execute(
            "INSERT INTO runtime_events (\
             run_id, run_sequence, aggregate_type, aggregate_id, aggregate_sequence,\
             message_id, idempotency_key, event_type, event_version, payload_json, created_at\
             ) VALUES ('legacy-run', 1, 'run', 'legacy-run', 1, ?1, ?2,\
             'legacy.runtime', 1, ?3, '2026-07-13T00:00:00Z')",
            params![
                message_id,
                format!("{message_id}-key"),
                json!({"事实": "旧运行事件"}).to_string()
            ],
        )
        .unwrap();
}

fn insert_legacy_workspace(connection: &Connection, message_id: &str) {
    connection
        .execute(
            "INSERT INTO workspace_events (\
             workspace_id, workspace_sequence, stream_type, stream_id, stream_sequence,\
             message_id, idempotency_key, event_type, event_version, payload_json, created_at\
             ) VALUES ('legacy-workspace', 1, 'goal', 'legacy-goal', 1, ?1, ?2,\
             'legacy.workspace', 1, ?3, '2026-07-13T00:00:01Z')",
            params![
                message_id,
                format!("{message_id}-key"),
                json!({"事实": "旧工作区事件"}).to_string()
            ],
        )
        .unwrap();
}

fn runtime_event(message_id: &str, key: &str, fact: &str) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: format!("run-{message_id}"),
        aggregate_type: "run".to_owned(),
        aggregate_id: format!("run-{message_id}"),
        message_id: message_id.to_owned(),
        idempotency_key: key.to_owned(),
        event_type: "test.runtime".to_owned(),
        event_version: 1,
        payload: json!({"事实": fact}),
        created_at: "2026-07-13T00:00:00Z".to_owned(),
    }
}

fn workspace_event(message_id: &str, key: &str, fact: &str) -> NewWorkspaceEvent {
    NewWorkspaceEvent {
        workspace_id: "workspace-global".to_owned(),
        stream_type: "canon".to_owned(),
        stream_id: format!("canon-{message_id}"),
        message_id: message_id.to_owned(),
        idempotency_key: key.to_owned(),
        event_type: "test.workspace".to_owned(),
        event_version: 1,
        payload: json!({"事实": fact}),
        created_at: "2026-07-13T00:00:01Z".to_owned(),
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    path: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("global-events.db");
        Self { _temp: temp, path }
    }
}
