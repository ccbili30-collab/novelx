use std::path::{Path, PathBuf};

use novelx_protocol::MAX_SAFE_SEQUENCE;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const MIGRATION_0001: &str = include_str!("../migrations/0001_event_journal.sql");
const MIGRATION_0002: &str = include_str!("../migrations/0002_event_stream_addressing.sql");
const MIGRATION_0003: &str = include_str!("../migrations/0003_artifact_store.sql");
const MIGRATION_0004: &str = include_str!("../migrations/0004_workspace_event_journal.sql");
const MIGRATION_0005: &str = include_str!("../migrations/0005_global_event_clock.sql");
const MIGRATION_0006: &str = include_str!("../migrations/0006_durable_global_event_order.sql");

#[derive(Clone, Debug, PartialEq)]
pub struct NewRuntimeEvent {
    pub run_id: String,
    pub aggregate_type: String,
    pub aggregate_id: String,
    pub message_id: String,
    pub idempotency_key: String,
    pub event_type: String,
    pub event_version: u32,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeEvent {
    pub run_id: String,
    pub run_sequence: u64,
    pub aggregate_type: String,
    pub aggregate_id: String,
    pub aggregate_sequence: u64,
    pub message_id: String,
    pub idempotency_key: String,
    pub event_type: String,
    pub event_version: u32,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AppendRuntimeEventOutcome {
    pub event: RuntimeEvent,
    pub inserted: bool,
}

/// A durable global position exists only for events appended after migration 0006.
/// Pre-migration events are deliberately not assigned a fabricated cross-table order.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GlobalEventOrder {
    Ordered(u64),
    LegacyUnordered,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AggregateAddress {
    pub run_id: String,
    pub aggregate_type: String,
    pub aggregate_id: String,
}

#[derive(Debug, Error)]
pub enum EventJournalError {
    #[error("runtime event field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("runtime event sequence is outside the supported range")]
    SequenceOutOfRange,
    #[error("runtime event version must be greater than zero")]
    InvalidEventVersion,
    #[error("runtime event message_id `{message_id}` is already used")]
    MessageIdConflict { message_id: String },
    #[error("runtime event idempotency key `{idempotency_key}` conflicts with another event")]
    IdempotencyConflict { idempotency_key: String },
    #[error("runtime run sequence conflict: expected {expected}, actual {actual}")]
    RunSequenceConflict { expected: u64, actual: u64 },
    #[error("runtime aggregate sequence conflict: expected {expected}, actual {actual}")]
    AggregateSequenceConflict { expected: u64, actual: u64 },
    #[error("runtime global event sequence conflict: expected {expected}, actual {actual}")]
    GlobalSequenceConflict { expected: u64, actual: u64 },
    #[error("runtime event `{message_id}` predates durable global ordering")]
    GlobalEventLegacyUnordered { message_id: String },
    #[error("runtime event `{message_id}` is missing its durable global order")]
    GlobalEventOrderMissing { message_id: String },
    #[error("runtime migration {version} checksum mismatch")]
    MigrationChecksumMismatch { version: u32 },
    #[error("runtime migration 0002 verification failed")]
    MigrationVerificationFailed,
    #[error("runtime event journal schema integrity check failed")]
    SchemaIntegrityFailed,
    #[error(
        "legacy global event clock {clock} exceeds the {event_count} stored events; migration cannot establish an honest ordering boundary"
    )]
    LegacyGlobalClockInvalid { clock: u64, event_count: u64 },
    #[error("runtime database instance id is missing or is not a canonical UUID")]
    InvalidDatabaseInstanceId,
    #[error("runtime event payload is not valid JSON: {0}")]
    InvalidPayload(#[from] serde_json::Error),
    #[error("runtime event journal storage failed: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("runtime migration timestamp failed: {0}")]
    Timestamp(#[from] time::error::Format),
    #[error("runtime event journal database path could not be canonicalized: {0}")]
    DatabasePath(#[from] std::io::Error),
}

pub struct EventJournal {
    connection: Connection,
    database_path: PathBuf,
    database_instance_id: String,
}

impl EventJournal {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, EventJournalError> {
        let path = path.as_ref();
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS runtime_schema_migrations (\
             version INTEGER PRIMARY KEY CHECK (version > 0),\
             applied_at TEXT NOT NULL, checksum TEXT NOT NULL CHECK (length(checksum) = 64)\
             ) STRICT;",
        )?;
        verify_migration_ledger_schema(&connection)?;
        apply_simple_migration(&mut connection, 1, MIGRATION_0001)?;
        apply_addressing_migration(&mut connection)?;
        apply_simple_migration(&mut connection, 3, MIGRATION_0003)?;
        apply_simple_migration(&mut connection, 4, MIGRATION_0004)?;
        apply_simple_migration(&mut connection, 5, MIGRATION_0005)?;
        apply_global_ordering_migration(&mut connection)?;
        verify_schema_integrity(&connection)?;
        let database_instance_id = load_database_instance_id(&connection)?;
        let database_path = std::fs::canonicalize(path)?;
        Ok(Self {
            connection,
            database_path,
            database_instance_id,
        })
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn database_instance_id(&self) -> &str {
        &self.database_instance_id
    }

    pub fn current_global_sequence(&self) -> Result<u64, EventJournalError> {
        current_global_sequence(&self.connection)
    }

    pub fn global_order_for_message(
        &self,
        message_id: &str,
    ) -> Result<Option<GlobalEventOrder>, EventJournalError> {
        require_non_empty("message_id", message_id)?;
        global_order_for_runtime_message(&self.connection, message_id)
    }

    /// Performs the O(n) data scan required at process startup before `runtime.ready`.
    /// Normal command-path opens deliberately perform only O(1) structural checks.
    pub fn verify_deep_data_integrity(&mut self) -> Result<(), EventJournalError> {
        let verification = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        verify_deep_data_integrity(&verification)?;
        verification.commit()?;
        Ok(())
    }

    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }

    pub(crate) fn connection_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }

    pub fn append(
        &mut self,
        event: NewRuntimeEvent,
        expected_run_sequence: u64,
        expected_aggregate_sequence: u64,
    ) -> Result<RuntimeEvent, EventJournalError> {
        self.append_with_outcome(event, expected_run_sequence, expected_aggregate_sequence)
            .map(|outcome| outcome.event)
    }

    pub fn append_with_outcome(
        &mut self,
        event: NewRuntimeEvent,
        expected_run_sequence: u64,
        expected_aggregate_sequence: u64,
    ) -> Result<AppendRuntimeEventOutcome, EventJournalError> {
        self.append_inner(
            event,
            expected_run_sequence,
            expected_aggregate_sequence,
            None,
        )
    }

    pub fn append_at_global_sequence(
        &mut self,
        event: NewRuntimeEvent,
        expected_run_sequence: u64,
        expected_aggregate_sequence: u64,
        expected_global_sequence: u64,
    ) -> Result<AppendRuntimeEventOutcome, EventJournalError> {
        self.append_inner(
            event,
            expected_run_sequence,
            expected_aggregate_sequence,
            Some(expected_global_sequence),
        )
    }

    fn append_inner(
        &mut self,
        event: NewRuntimeEvent,
        expected_run_sequence: u64,
        expected_aggregate_sequence: u64,
        expected_global_sequence: Option<u64>,
    ) -> Result<AppendRuntimeEventOutcome, EventJournalError> {
        validate(&event)?;
        validate_sequence(expected_run_sequence, true)?;
        validate_sequence(expected_aggregate_sequence, true)?;
        if let Some(expected_global_sequence) = expected_global_sequence {
            validate_sequence(expected_global_sequence, true)?;
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(existing) = find_by_message_id(&transaction, &event.message_id)? {
            if same_full_event(
                &existing,
                &event,
                expected_run_sequence,
                expected_aggregate_sequence,
            ) {
                validate_idempotent_global_order(
                    &transaction,
                    &existing.message_id,
                    expected_global_sequence,
                )?;
                transaction.commit()?;
                return Ok(AppendRuntimeEventOutcome {
                    event: existing,
                    inserted: false,
                });
            }
            return Err(EventJournalError::MessageIdConflict {
                message_id: event.message_id,
            });
        }
        if let Some(existing) =
            find_by_idempotency_key(&transaction, &event.run_id, &event.idempotency_key)?
        {
            if same_idempotent_intent(
                &existing,
                &event,
                expected_run_sequence,
                expected_aggregate_sequence,
            ) {
                validate_idempotent_global_order(
                    &transaction,
                    &existing.message_id,
                    expected_global_sequence,
                )?;
                transaction.commit()?;
                return Ok(AppendRuntimeEventOutcome {
                    event: existing,
                    inserted: false,
                });
            }
            return Err(EventJournalError::IdempotencyConflict {
                idempotency_key: event.idempotency_key,
            });
        }

        let actual_global = current_global_sequence(&transaction)?;
        if let Some(expected_global_sequence) = expected_global_sequence
            && actual_global != expected_global_sequence
        {
            return Err(EventJournalError::GlobalSequenceConflict {
                expected: expected_global_sequence,
                actual: actual_global,
            });
        }
        checked_next(actual_global)?;

        let actual_run = current_run_sequence(&transaction, &event.run_id)?;
        if actual_run != expected_run_sequence {
            return Err(EventJournalError::RunSequenceConflict {
                expected: expected_run_sequence,
                actual: actual_run,
            });
        }
        let actual_aggregate = current_aggregate_sequence(
            &transaction,
            &event.run_id,
            &event.aggregate_type,
            &event.aggregate_id,
        )?;
        if actual_aggregate != expected_aggregate_sequence {
            return Err(EventJournalError::AggregateSequenceConflict {
                expected: expected_aggregate_sequence,
                actual: actual_aggregate,
            });
        }

        let run_sequence = checked_next(actual_run)?;
        let aggregate_sequence = checked_next(actual_aggregate)?;
        let payload_json = serde_json::to_string(&event.payload)?;
        transaction.execute(
            "INSERT INTO runtime_events (\
             run_id, run_sequence, aggregate_type, aggregate_id, aggregate_sequence,\
             message_id, idempotency_key, event_type, event_version, payload_json, created_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                event.run_id,
                to_sql_integer(run_sequence)?,
                event.aggregate_type,
                event.aggregate_id,
                to_sql_integer(aggregate_sequence)?,
                event.message_id,
                event.idempotency_key,
                event.event_type,
                i64::from(event.event_version),
                payload_json,
                event.created_at,
            ],
        )?;
        let inserted = find_by_message_id(&transaction, &event.message_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        transaction.commit()?;
        Ok(AppendRuntimeEventOutcome {
            event: inserted,
            inserted: true,
        })
    }

    pub fn read_run(
        &self,
        run_id: &str,
        after: u64,
    ) -> Result<Vec<RuntimeEvent>, EventJournalError> {
        require_non_empty("run_id", run_id)?;
        let mut statement = self.connection.prepare(&format!(
            "{} WHERE run_id = ?1 AND run_sequence > ?2 ORDER BY run_sequence ASC",
            select_event_sql()
        ))?;
        let rows = statement.query_map(params![run_id, to_sql_integer(after)?], map_event_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn read_aggregate(
        &self,
        run_id: &str,
        aggregate_type: &str,
        aggregate_id: &str,
        after: u64,
    ) -> Result<Vec<RuntimeEvent>, EventJournalError> {
        require_non_empty("run_id", run_id)?;
        require_non_empty("aggregate_type", aggregate_type)?;
        require_non_empty("aggregate_id", aggregate_id)?;
        let mut statement = self.connection.prepare(&format!(
            "{} WHERE run_id = ?1 AND aggregate_type = ?2 AND aggregate_id = ?3 \
             AND aggregate_sequence > ?4 ORDER BY aggregate_sequence ASC",
            select_event_sql()
        ))?;
        let rows = statement.query_map(
            params![run_id, aggregate_type, aggregate_id, to_sql_integer(after)?],
            map_event_row,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_aggregates(
        &self,
        aggregate_type: &str,
    ) -> Result<Vec<AggregateAddress>, EventJournalError> {
        require_non_empty("aggregate_type", aggregate_type)?;
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT run_id, aggregate_type, aggregate_id FROM runtime_events \
             WHERE aggregate_type = ?1 ORDER BY run_id, aggregate_id",
        )?;
        let rows = statement.query_map([aggregate_type], |row| {
            Ok(AggregateAddress {
                run_id: row.get(0)?,
                aggregate_type: row.get(1)?,
                aggregate_id: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

fn apply_simple_migration(
    connection: &mut Connection,
    version: u32,
    sql: &str,
) -> Result<(), EventJournalError> {
    let checksum = checksum(sql);
    if verify_existing_migration(connection, version, &checksum)? {
        return Ok(());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(sql)?;
    record_migration(&transaction, version, &checksum)?;
    transaction.commit()?;
    Ok(())
}

fn apply_addressing_migration(connection: &mut Connection) -> Result<(), EventJournalError> {
    let checksum = checksum(MIGRATION_0002);
    if verify_existing_migration(connection, 2, &checksum)? {
        return Ok(());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(MIGRATION_0002)?;
    let old_count: i64 =
        transaction.query_row("SELECT COUNT(*) FROM runtime_events_0001", [], |row| {
            row.get(0)
        })?;
    let mismatches: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM runtime_events_0001 old LEFT JOIN runtime_events current \
         ON current.run_id = old.run_id AND current.run_sequence = old.sequence \
         WHERE current.run_id IS NULL OR current.aggregate_type <> 'run' OR current.aggregate_id <> old.run_id \
         OR current.aggregate_sequence <> old.sequence OR current.message_id <> old.message_id \
         OR current.idempotency_key <> old.message_id OR current.event_type <> old.event_type \
         OR current.event_version <> 1 OR current.payload_json <> old.payload_json OR current.created_at <> old.created_at",
        [],
        |row| row.get(0),
    )?;
    let new_count: i64 =
        transaction.query_row("SELECT COUNT(*) FROM runtime_events", [], |row| row.get(0))?;
    if old_count != new_count || mismatches != 0 {
        return Err(EventJournalError::MigrationVerificationFailed);
    }
    transaction.execute_batch("DROP TABLE runtime_events_0001;")?;
    record_migration(&transaction, 2, &checksum)?;
    transaction.commit()?;
    Ok(())
}

fn apply_global_ordering_migration(connection: &mut Connection) -> Result<(), EventJournalError> {
    let migration_checksum = checksum(MIGRATION_0006);
    if verify_existing_migration(connection, 6, &migration_checksum)? {
        return Ok(());
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if verify_existing_migration(&transaction, 6, &migration_checksum)? {
        transaction.commit()?;
        return Ok(());
    }
    verify_legacy_global_clock_schema(&transaction)?;
    let legacy_runtime_count: i64 =
        transaction.query_row("SELECT COUNT(*) FROM runtime_events", [], |row| row.get(0))?;
    let legacy_workspace_count: i64 =
        transaction.query_row("SELECT COUNT(*) FROM workspace_events", [], |row| {
            row.get(0)
        })?;
    let legacy_clock: i64 = transaction.query_row(
        "SELECT sequence FROM runtime_global_event_clock WHERE singleton_id = 1",
        [],
        |row| row.get(0),
    )?;
    let legacy_event_count = legacy_runtime_count
        .checked_add(legacy_workspace_count)
        .ok_or(EventJournalError::SequenceOutOfRange)?;
    for value in [
        legacy_runtime_count,
        legacy_workspace_count,
        legacy_event_count,
    ] {
        validate_sql_sequence(value, true)?;
    }
    verify_persisted_event_sequence_bounds(&transaction)?;
    if legacy_clock < 0 || legacy_clock > legacy_event_count {
        return Err(EventJournalError::LegacyGlobalClockInvalid {
            clock: u64::try_from(legacy_clock).unwrap_or(u64::MAX),
            event_count: u64::try_from(legacy_event_count)
                .map_err(|_| EventJournalError::SequenceOutOfRange)?,
        });
    }

    transaction.execute_batch(MIGRATION_0006)?;
    let database_instance_id = uuid::Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO runtime_database_identity (singleton_id, database_instance_id) VALUES (1, ?1)",
        [&database_instance_id],
    )?;
    transaction.execute(
        "INSERT INTO runtime_legacy_unordered_events (event_kind, message_id) \
         SELECT 'runtime', message_id FROM runtime_events",
        [],
    )?;
    transaction.execute(
        "INSERT INTO runtime_legacy_unordered_events (event_kind, message_id) \
         SELECT 'workspace', message_id FROM workspace_events",
        [],
    )?;
    transaction.execute(
        "INSERT INTO runtime_global_event_ordering (\
         singleton_id, ordering_version, ordered_sequence_base,\
         legacy_runtime_event_count, legacy_workspace_event_count\
         ) VALUES (1, 1, ?1, ?2, ?3)",
        params![
            legacy_event_count,
            legacy_runtime_count,
            legacy_workspace_count
        ],
    )?;
    record_migration(&transaction, 6, &migration_checksum)?;
    transaction.commit()?;
    Ok(())
}

fn verify_existing_migration(
    connection: &Connection,
    version: u32,
    expected_checksum: &str,
) -> Result<bool, EventJournalError> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT checksum FROM runtime_schema_migrations WHERE version = ?1",
            [version],
            |row| row.get(0),
        )
        .optional()?;
    match stored {
        None => Ok(false),
        Some(value) if value == expected_checksum => Ok(true),
        Some(_) => Err(EventJournalError::MigrationChecksumMismatch { version }),
    }
}

fn record_migration(
    transaction: &Transaction<'_>,
    version: u32,
    migration_checksum: &str,
) -> Result<(), EventJournalError> {
    let applied_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    transaction.execute(
        "INSERT INTO runtime_schema_migrations (version, applied_at, checksum) VALUES (?1, ?2, ?3)",
        params![version, applied_at, migration_checksum],
    )?;
    Ok(())
}

fn same_full_event(
    existing: &RuntimeEvent,
    candidate: &NewRuntimeEvent,
    expected_run_sequence: u64,
    expected_aggregate_sequence: u64,
) -> bool {
    same_idempotent_intent(
        existing,
        candidate,
        expected_run_sequence,
        expected_aggregate_sequence,
    ) && existing.message_id == candidate.message_id
        && existing.created_at == candidate.created_at
}

fn same_idempotent_intent(
    existing: &RuntimeEvent,
    candidate: &NewRuntimeEvent,
    expected_run_sequence: u64,
    expected_aggregate_sequence: u64,
) -> bool {
    existing.run_id == candidate.run_id
        && expected_run_sequence.checked_add(1) == Some(existing.run_sequence)
        && existing.aggregate_type == candidate.aggregate_type
        && existing.aggregate_id == candidate.aggregate_id
        && expected_aggregate_sequence.checked_add(1) == Some(existing.aggregate_sequence)
        && existing.idempotency_key == candidate.idempotency_key
        && existing.event_type == candidate.event_type
        && existing.event_version == candidate.event_version
        && existing.payload == candidate.payload
}

fn validate(event: &NewRuntimeEvent) -> Result<(), EventJournalError> {
    for (field, value) in [
        ("run_id", event.run_id.as_str()),
        ("aggregate_type", event.aggregate_type.as_str()),
        ("aggregate_id", event.aggregate_id.as_str()),
        ("message_id", event.message_id.as_str()),
        ("idempotency_key", event.idempotency_key.as_str()),
        ("event_type", event.event_type.as_str()),
        ("created_at", event.created_at.as_str()),
    ] {
        require_non_empty(field, value)?;
    }
    if event.event_version == 0 {
        return Err(EventJournalError::InvalidEventVersion);
    }
    Ok(())
}

fn require_non_empty(field: &'static str, value: &str) -> Result<(), EventJournalError> {
    if value.trim().is_empty() {
        return Err(EventJournalError::EmptyField(field));
    }
    Ok(())
}

fn current_run_sequence(
    transaction: &Transaction<'_>,
    run_id: &str,
) -> Result<u64, EventJournalError> {
    let value: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(run_sequence), 0) FROM runtime_events WHERE run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    validate_sql_sequence(value, true)
}

fn current_aggregate_sequence(
    transaction: &Transaction<'_>,
    run_id: &str,
    aggregate_type: &str,
    aggregate_id: &str,
) -> Result<u64, EventJournalError> {
    let value: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(aggregate_sequence), 0) FROM runtime_events \
         WHERE run_id = ?1 AND aggregate_type = ?2 AND aggregate_id = ?3",
        params![run_id, aggregate_type, aggregate_id],
        |row| row.get(0),
    )?;
    validate_sql_sequence(value, true)
}

fn current_global_sequence(connection: &Connection) -> Result<u64, EventJournalError> {
    let value: i64 = connection.query_row(
        "SELECT COALESCE(\
            (SELECT MAX(global_sequence) FROM runtime_global_event_ledger),\
            (SELECT ordered_sequence_base FROM runtime_global_event_ordering WHERE singleton_id = 1)\
         )",
        [],
        |row| row.get(0),
    )?;
    validate_sql_sequence(value, true)
}

fn global_order_for_runtime_message(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<GlobalEventOrder>, EventJournalError> {
    let position: Option<(Option<i64>, i64)> = connection
        .query_row(
            "SELECT ledger.global_sequence, EXISTS(\
                 SELECT 1 FROM runtime_legacy_unordered_events legacy \
                 WHERE legacy.event_kind = 'runtime' AND legacy.message_id = event.message_id\
             ) FROM runtime_events event \
             LEFT JOIN runtime_global_event_ledger ledger \
               ON ledger.event_kind = 'runtime' AND ledger.runtime_message_id = event.message_id \
             WHERE event.message_id = ?1",
            [message_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    position
        .map(|(position, legacy)| match (position, legacy) {
            (Some(value), 0) => validate_sql_sequence(value, false).map(GlobalEventOrder::Ordered),
            (None, 1) => Ok(GlobalEventOrder::LegacyUnordered),
            (None, 0) => Err(EventJournalError::GlobalEventOrderMissing {
                message_id: message_id.to_owned(),
            }),
            _ => Err(EventJournalError::SchemaIntegrityFailed),
        })
        .transpose()
}

fn validate_idempotent_global_order(
    connection: &Connection,
    message_id: &str,
    expected_global_sequence: Option<u64>,
) -> Result<(), EventJournalError> {
    let Some(expected) = expected_global_sequence else {
        return Ok(());
    };
    match global_order_for_runtime_message(connection, message_id)? {
        Some(GlobalEventOrder::Ordered(sequence)) => {
            let actual = sequence
                .checked_sub(1)
                .ok_or(EventJournalError::SequenceOutOfRange)?;
            if actual != expected {
                return Err(EventJournalError::GlobalSequenceConflict { expected, actual });
            }
            Ok(())
        }
        Some(GlobalEventOrder::LegacyUnordered) => {
            Err(EventJournalError::GlobalEventLegacyUnordered {
                message_id: message_id.to_owned(),
            })
        }
        None => Err(EventJournalError::GlobalEventOrderMissing {
            message_id: message_id.to_owned(),
        }),
    }
}

fn load_database_instance_id(connection: &Connection) -> Result<String, EventJournalError> {
    let value: String = connection
        .query_row(
            "SELECT database_instance_id FROM runtime_database_identity WHERE singleton_id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| EventJournalError::InvalidDatabaseInstanceId)?;
    let parsed =
        uuid::Uuid::parse_str(&value).map_err(|_| EventJournalError::InvalidDatabaseInstanceId)?;
    if parsed.to_string() != value {
        return Err(EventJournalError::InvalidDatabaseInstanceId);
    }
    Ok(value)
}

fn find_by_message_id(
    transaction: &Transaction<'_>,
    message_id: &str,
) -> Result<Option<RuntimeEvent>, EventJournalError> {
    transaction
        .query_row(
            &format!("{} WHERE message_id = ?1", select_event_sql()),
            [message_id],
            map_event_row,
        )
        .optional()
        .map_err(Into::into)
}

fn find_by_idempotency_key(
    transaction: &Transaction<'_>,
    run_id: &str,
    idempotency_key: &str,
) -> Result<Option<RuntimeEvent>, EventJournalError> {
    transaction
        .query_row(
            &format!(
                "{} WHERE run_id = ?1 AND idempotency_key = ?2",
                select_event_sql()
            ),
            params![run_id, idempotency_key],
            map_event_row,
        )
        .optional()
        .map_err(Into::into)
}

fn select_event_sql() -> &'static str {
    "SELECT run_id, run_sequence, aggregate_type, aggregate_id, aggregate_sequence, \
     message_id, idempotency_key, event_type, event_version, payload_json, created_at FROM runtime_events"
}

fn map_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeEvent> {
    let payload_json: String = row.get(9)?;
    let payload = serde_json::from_str(&payload_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let event_version: i64 = row.get(8)?;
    Ok(RuntimeEvent {
        run_id: row.get(0)?,
        run_sequence: from_sql_integer(row.get(1)?, 1)?,
        aggregate_type: row.get(2)?,
        aggregate_id: row.get(3)?,
        aggregate_sequence: from_sql_integer(row.get(4)?, 4)?,
        message_id: row.get(5)?,
        idempotency_key: row.get(6)?,
        event_type: row.get(7)?,
        event_version: u32::try_from(event_version).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                8,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?,
        payload,
        created_at: row.get(10)?,
    })
}

fn checked_next(value: u64) -> Result<u64, EventJournalError> {
    validate_sequence(value, true)?;
    let next = value
        .checked_add(1)
        .ok_or(EventJournalError::SequenceOutOfRange)?;
    validate_sequence(next, false)?;
    Ok(next)
}

fn to_sql_integer(value: u64) -> Result<i64, EventJournalError> {
    validate_sequence(value, true)?;
    i64::try_from(value).map_err(|_| EventJournalError::SequenceOutOfRange)
}

fn from_sql_integer(value: i64, column: usize) -> rusqlite::Result<u64> {
    let value = u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })?;
    if value == 0 || value > MAX_SAFE_SEQUENCE {
        return Err(rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Integer,
            Box::new(EventJournalError::SequenceOutOfRange),
        ));
    }
    Ok(value)
}

fn validate_sequence(value: u64, allow_zero: bool) -> Result<u64, EventJournalError> {
    if value > MAX_SAFE_SEQUENCE || (!allow_zero && value == 0) {
        return Err(EventJournalError::SequenceOutOfRange);
    }
    Ok(value)
}

fn validate_sql_sequence(value: i64, allow_zero: bool) -> Result<u64, EventJournalError> {
    let value = u64::try_from(value).map_err(|_| EventJournalError::SequenceOutOfRange)?;
    validate_sequence(value, allow_zero)
}

fn checksum(sql: &str) -> String {
    format!("{:x}", Sha256::digest(sql.as_bytes()))
}

#[derive(Debug, Eq, PartialEq)]
struct ColumnDefinition {
    name: String,
    data_type: String,
    not_null: bool,
    primary_key_position: i64,
}

fn verify_migration_ledger_schema(connection: &Connection) -> Result<(), EventJournalError> {
    let expected = [
        ("version", "INTEGER", false, 1),
        ("applied_at", "TEXT", true, 0),
        ("checksum", "TEXT", true, 0),
    ];
    verify_columns(connection, "runtime_schema_migrations", &expected)
}

pub(crate) fn verify_schema_integrity(connection: &Connection) -> Result<(), EventJournalError> {
    verify_migration_ledger_schema(connection)?;
    for (object_type, name, migration) in [
        ("table", "runtime_events", MIGRATION_0002),
        ("index", "runtime_events_aggregate_replay", MIGRATION_0002),
        ("index", "runtime_events_run_type_order", MIGRATION_0002),
        ("trigger", "runtime_events_no_update", MIGRATION_0002),
        ("trigger", "runtime_events_no_delete", MIGRATION_0002),
        ("table", "workspace_events", MIGRATION_0004),
        ("index", "workspace_events_stream_replay", MIGRATION_0004),
        ("index", "workspace_events_type_order", MIGRATION_0004),
        ("trigger", "workspace_events_no_update", MIGRATION_0004),
        ("trigger", "workspace_events_no_delete", MIGRATION_0004),
    ] {
        verify_migration_object_sql(connection, object_type, name, migration)?;
    }
    let expected_columns = [
        ("run_id", "TEXT", true, 1),
        ("run_sequence", "INTEGER", true, 2),
        ("aggregate_type", "TEXT", true, 0),
        ("aggregate_id", "TEXT", true, 0),
        ("aggregate_sequence", "INTEGER", true, 0),
        ("message_id", "TEXT", true, 0),
        ("idempotency_key", "TEXT", true, 0),
        ("event_type", "TEXT", true, 0),
        ("event_version", "INTEGER", true, 0),
        ("payload_json", "TEXT", true, 0),
        ("created_at", "TEXT", true, 0),
    ];
    verify_columns(connection, "runtime_events", &expected_columns)?;

    let unique_indexes = list_unique_index_columns(connection, "runtime_events")?;
    let expected_unique = [
        vec!["run_id".to_owned(), "run_sequence".to_owned()],
        vec![
            "run_id".to_owned(),
            "aggregate_type".to_owned(),
            "aggregate_id".to_owned(),
            "aggregate_sequence".to_owned(),
        ],
        vec!["message_id".to_owned()],
        vec!["run_id".to_owned(), "idempotency_key".to_owned()],
    ];
    if unique_indexes.len() != expected_unique.len()
        || expected_unique
            .iter()
            .any(|expected| !unique_indexes.contains(expected))
    {
        return Err(EventJournalError::SchemaIntegrityFailed);
    }

    verify_named_index(
        connection,
        "runtime_events_aggregate_replay",
        &[
            "run_id",
            "aggregate_type",
            "aggregate_id",
            "aggregate_sequence",
        ],
    )?;
    verify_named_index(
        connection,
        "runtime_events_run_type_order",
        &["run_id", "aggregate_type", "run_sequence"],
    )?;
    verify_durable_global_schema(connection)?;
    Ok(())
}

fn verify_legacy_global_clock_schema(connection: &Connection) -> Result<(), EventJournalError> {
    for (object_type, name) in [
        ("table", "runtime_global_event_clock"),
        ("trigger", "runtime_events_advance_global_clock"),
        ("trigger", "workspace_events_advance_global_clock"),
        ("trigger", "runtime_global_event_clock_no_delete"),
    ] {
        verify_migration_object_sql(connection, object_type, name, MIGRATION_0005)?;
    }
    let row_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM runtime_global_event_clock WHERE singleton_id = 1 AND sequence >= 0",
        [],
        |row| row.get(0),
    )?;
    let total_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM runtime_global_event_clock",
        [],
        |row| row.get(0),
    )?;
    if row_count != 1 || total_count != 1 {
        return Err(EventJournalError::SchemaIntegrityFailed);
    }
    Ok(())
}

pub(crate) fn verify_durable_global_schema(
    connection: &Connection,
) -> Result<(), EventJournalError> {
    for (object_type, name) in [
        ("table", "runtime_database_identity"),
        ("table", "runtime_global_event_ordering"),
        ("table", "runtime_global_event_ledger"),
        ("table", "runtime_legacy_unordered_events"),
        ("trigger", "runtime_database_identity_no_insert"),
        ("trigger", "runtime_database_identity_no_update"),
        ("trigger", "runtime_database_identity_no_delete"),
        ("trigger", "runtime_global_event_ordering_no_insert"),
        ("trigger", "runtime_global_event_ordering_no_update"),
        ("trigger", "runtime_global_event_ordering_no_delete"),
        ("trigger", "runtime_legacy_unordered_events_no_insert"),
        ("trigger", "runtime_legacy_unordered_events_no_update"),
        ("trigger", "runtime_legacy_unordered_events_no_delete"),
        ("trigger", "runtime_events_safe_sequence_insert"),
        ("trigger", "workspace_events_safe_sequence_insert"),
        ("trigger", "runtime_global_event_ledger_validate_insert"),
        ("trigger", "runtime_events_record_global_order"),
        ("trigger", "workspace_events_record_global_order"),
        ("trigger", "runtime_global_event_ledger_no_update"),
        ("trigger", "runtime_global_event_ledger_no_delete"),
    ] {
        verify_migration_object_sql(connection, object_type, name, MIGRATION_0006)?;
    }
    for legacy_name in [
        "runtime_global_event_clock",
        "runtime_events_advance_global_clock",
        "workspace_events_advance_global_clock",
        "runtime_global_event_clock_no_delete",
    ] {
        let exists: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name = ?1",
                [legacy_name],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_some() {
            return Err(EventJournalError::SchemaIntegrityFailed);
        }
    }

    let _ = load_database_instance_id(connection)?;
    let identity_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM runtime_database_identity",
        [],
        |row| row.get(0),
    )?;
    let (ordering_count, version, base, legacy_runtime, legacy_workspace): (
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = connection.query_row(
        "SELECT COUNT(*), COALESCE(MAX(ordering_version), 0),\
         COALESCE(MAX(ordered_sequence_base), -1),\
         COALESCE(MAX(legacy_runtime_event_count), -1),\
         COALESCE(MAX(legacy_workspace_event_count), -1)\
         FROM runtime_global_event_ordering",
        [],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    let safe_base = validate_sql_sequence(base, true)?;
    let safe_legacy_runtime = validate_sql_sequence(legacy_runtime, true)?;
    let safe_legacy_workspace = validate_sql_sequence(legacy_workspace, true)?;
    if identity_count != 1
        || ordering_count != 1
        || version != 1
        || safe_legacy_runtime
            .checked_add(safe_legacy_workspace)
            .filter(|total| *total <= MAX_SAFE_SEQUENCE)
            != Some(safe_base)
    {
        return Err(EventJournalError::SchemaIntegrityFailed);
    }
    Ok(())
}

fn verify_deep_data_integrity(connection: &Connection) -> Result<(), EventJournalError> {
    verify_schema_integrity(connection)?;
    verify_persisted_event_sequence_bounds(connection)?;
    let (base, legacy_runtime, legacy_workspace): (i64, i64, i64) = connection.query_row(
        "SELECT ordered_sequence_base, legacy_runtime_event_count,\
         legacy_workspace_event_count FROM runtime_global_event_ordering WHERE singleton_id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let base = i64::try_from(validate_sql_sequence(base, true)?)
        .map_err(|_| EventJournalError::SequenceOutOfRange)?;
    validate_sql_sequence(legacy_runtime, true)?;
    validate_sql_sequence(legacy_workspace, true)?;

    let runtime_total: i64 =
        connection.query_row("SELECT COUNT(*) FROM runtime_events", [], |row| row.get(0))?;
    let workspace_total: i64 =
        connection.query_row("SELECT COUNT(*) FROM workspace_events", [], |row| {
            row.get(0)
        })?;
    let runtime_total_safe = validate_sql_sequence(runtime_total, true)?;
    let workspace_total_safe = validate_sql_sequence(workspace_total, true)?;
    if runtime_total_safe
        .checked_add(workspace_total_safe)
        .filter(|total| *total <= MAX_SAFE_SEQUENCE)
        .is_none()
    {
        return Err(EventJournalError::SequenceOutOfRange);
    }
    let runtime_unordered: i64 = connection.query_row(
        "SELECT COUNT(*) FROM runtime_events event \
         LEFT JOIN runtime_global_event_ledger ledger \
           ON ledger.event_kind = 'runtime' AND ledger.runtime_message_id = event.message_id \
         WHERE ledger.global_sequence IS NULL",
        [],
        |row| row.get(0),
    )?;
    let workspace_unordered: i64 = connection.query_row(
        "SELECT COUNT(*) FROM workspace_events event \
         LEFT JOIN runtime_global_event_ledger ledger \
           ON ledger.event_kind = 'workspace' AND ledger.workspace_message_id = event.message_id \
         WHERE ledger.global_sequence IS NULL",
        [],
        |row| row.get(0),
    )?;
    let legacy_runtime_rows: i64 = connection.query_row(
        "SELECT COUNT(*) FROM runtime_legacy_unordered_events legacy \
         INNER JOIN runtime_events event ON event.message_id = legacy.message_id \
         WHERE legacy.event_kind = 'runtime'",
        [],
        |row| row.get(0),
    )?;
    let legacy_workspace_rows: i64 = connection.query_row(
        "SELECT COUNT(*) FROM runtime_legacy_unordered_events legacy \
         INNER JOIN workspace_events event ON event.message_id = legacy.message_id \
         WHERE legacy.event_kind = 'workspace'",
        [],
        |row| row.get(0),
    )?;
    let legacy_marker_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM runtime_legacy_unordered_events",
        [],
        |row| row.get(0),
    )?;
    let (ledger_count, ledger_min, ledger_max): (i64, Option<i64>, Option<i64>) = connection
        .query_row(
            "SELECT COUNT(*), MIN(global_sequence), MAX(global_sequence)\
             FROM runtime_global_event_ledger",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
    validate_sql_sequence(runtime_unordered, true)?;
    validate_sql_sequence(workspace_unordered, true)?;
    validate_sql_sequence(legacy_runtime_rows, true)?;
    validate_sql_sequence(legacy_workspace_rows, true)?;
    validate_sql_sequence(legacy_marker_count, true)?;
    validate_sql_sequence(ledger_count, true)?;
    let expected_ledger_count = runtime_total
        .checked_add(workspace_total)
        .and_then(|total| total.checked_sub(base))
        .ok_or(EventJournalError::SchemaIntegrityFailed)?;
    if runtime_unordered != legacy_runtime
        || workspace_unordered != legacy_workspace
        || legacy_runtime_rows != legacy_runtime
        || legacy_workspace_rows != legacy_workspace
        || legacy_marker_count != base
        || ledger_count != expected_ledger_count
    {
        return Err(EventJournalError::SchemaIntegrityFailed);
    }
    if ledger_count == 0 {
        if ledger_min.is_some() || ledger_max.is_some() {
            return Err(EventJournalError::SchemaIntegrityFailed);
        }
    } else {
        let min = ledger_min.ok_or(EventJournalError::SchemaIntegrityFailed)?;
        let max = ledger_max.ok_or(EventJournalError::SchemaIntegrityFailed)?;
        validate_sql_sequence(min, false)?;
        validate_sql_sequence(max, false)?;
        if min
            != base
                .checked_add(1)
                .ok_or(EventJournalError::SequenceOutOfRange)?
            || max
                != base
                    .checked_add(ledger_count)
                    .ok_or(EventJournalError::SequenceOutOfRange)?
        {
            return Err(EventJournalError::SchemaIntegrityFailed);
        }
    }

    let foreign_key_violation: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM pragma_foreign_key_check LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if foreign_key_violation.is_some() {
        return Err(EventJournalError::SchemaIntegrityFailed);
    }
    Ok(())
}

fn verify_persisted_event_sequence_bounds(
    connection: &Connection,
) -> Result<(), EventJournalError> {
    let maximum =
        i64::try_from(MAX_SAFE_SEQUENCE).map_err(|_| EventJournalError::SequenceOutOfRange)?;
    let unsafe_sequence_exists: i64 = connection.query_row(
        "SELECT EXISTS(\
             SELECT 1 FROM runtime_events \
             WHERE run_sequence NOT BETWEEN 1 AND ?1 \
                OR aggregate_sequence NOT BETWEEN 1 AND ?1\
         ) OR EXISTS(\
             SELECT 1 FROM workspace_events \
             WHERE workspace_sequence NOT BETWEEN 1 AND ?1 \
                OR stream_sequence NOT BETWEEN 1 AND ?1\
         )",
        [maximum],
        |row| row.get(0),
    )?;
    if unsafe_sequence_exists != 0 {
        return Err(EventJournalError::SequenceOutOfRange);
    }
    Ok(())
}

fn verify_migration_object_sql(
    connection: &Connection,
    object_type: &str,
    name: &str,
    migration: &str,
) -> Result<(), EventJournalError> {
    let actual: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = ?1 AND name = ?2",
            params![object_type, name],
            |row| row.get(0),
        )
        .optional()?;
    let expected = extract_migration_object_sql(migration, object_type, name)
        .ok_or(EventJournalError::SchemaIntegrityFailed)?;
    if actual.as_deref().map(normalize_schema_sql).as_deref() != Some(expected.as_str()) {
        return Err(EventJournalError::SchemaIntegrityFailed);
    }
    Ok(())
}

fn extract_migration_object_sql(migration: &str, object_type: &str, name: &str) -> Option<String> {
    let marker = format!("CREATE {} {name}", object_type.to_ascii_uppercase());
    let start = migration.find(&marker)?;
    let tail = &migration[start..];
    let terminator = match object_type {
        "trigger" => "\nEND;",
        "table" => "\n) STRICT;",
        "index" => ";",
        _ => return None,
    };
    let end = tail.find(terminator)? + terminator.len();
    Some(normalize_schema_sql(&tail[..end]))
}

fn normalize_schema_sql(sql: &str) -> String {
    let mut source = sql.trim();
    while let Some(without_semicolon) = source.strip_suffix(';') {
        source = without_semicolon.trim_end();
    }
    let mut normalized = String::with_capacity(source.len());
    let mut characters = source.chars().peekable();
    let mut quote: Option<char> = None;
    let mut pending_space = false;
    while let Some(character) = characters.next() {
        if let Some(terminator) = quote {
            normalized.push(character);
            if character == terminator {
                if terminator != ']' && characters.peek() == Some(&terminator) {
                    normalized.push(characters.next().expect("peeked escaped quote"));
                } else {
                    quote = None;
                }
            }
            continue;
        }
        if character.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space && !normalized.is_empty() {
            normalized.push(' ');
        }
        pending_space = false;
        normalized.push(character);
        quote = match character {
            '\'' | '"' | '`' => Some(character),
            '[' => Some(']'),
            _ => None,
        };
    }
    normalized
}

fn verify_columns(
    connection: &Connection,
    table: &str,
    expected: &[(&str, &str, bool, i64)],
) -> Result<(), EventJournalError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| EventJournalError::SchemaIntegrityFailed)?;
    let actual = statement
        .query_map([], |row| {
            Ok(ColumnDefinition {
                name: row.get(1)?,
                data_type: row.get::<_, String>(2)?.to_ascii_uppercase(),
                not_null: row.get::<_, i64>(3)? != 0,
                primary_key_position: row.get(5)?,
            })
        })
        .map_err(|_| EventJournalError::SchemaIntegrityFailed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| EventJournalError::SchemaIntegrityFailed)?;
    let expected = expected
        .iter()
        .map(
            |(name, data_type, not_null, primary_key_position)| ColumnDefinition {
                name: (*name).to_owned(),
                data_type: (*data_type).to_owned(),
                not_null: *not_null,
                primary_key_position: *primary_key_position,
            },
        )
        .collect::<Vec<_>>();
    if actual != expected {
        return Err(EventJournalError::SchemaIntegrityFailed);
    }
    Ok(())
}

fn list_unique_index_columns(
    connection: &Connection,
    table: &str,
) -> Result<Vec<Vec<String>>, EventJournalError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA index_list({table})"))
        .map_err(|_| EventJournalError::SchemaIntegrityFailed)?;
    let names = statement
        .query_map([], |row| {
            let unique: i64 = row.get(2)?;
            let origin: String = row.get(3)?;
            Ok((row.get::<_, String>(1)?, unique != 0, origin))
        })
        .map_err(|_| EventJournalError::SchemaIntegrityFailed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| EventJournalError::SchemaIntegrityFailed)?;
    names
        .into_iter()
        .filter(|(_, unique, origin)| *unique && (origin == "u" || origin == "pk"))
        .map(|(name, _, _)| index_columns(connection, &name))
        .collect()
}

fn verify_named_index(
    connection: &Connection,
    name: &str,
    expected_columns: &[&str],
) -> Result<(), EventJournalError> {
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1 AND tbl_name = 'runtime_events'",
            [name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| EventJournalError::SchemaIntegrityFailed)?;
    let actual = exists
        .ok_or(EventJournalError::SchemaIntegrityFailed)
        .and_then(|_| index_columns(connection, name))?;
    if actual != expected_columns {
        return Err(EventJournalError::SchemaIntegrityFailed);
    }
    Ok(())
}

fn index_columns(connection: &Connection, name: &str) -> Result<Vec<String>, EventJournalError> {
    let escaped = name.replace('"', "\"\"");
    let mut statement = connection
        .prepare(&format!("PRAGMA index_info(\"{escaped}\")"))
        .map_err(|_| EventJournalError::SchemaIntegrityFailed)?;
    statement
        .query_map([], |row| row.get(2))
        .map_err(|_| EventJournalError::SchemaIntegrityFailed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| EventJournalError::SchemaIntegrityFailed)
}
