use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const MIGRATION_0001: &str = include_str!("../migrations/0001_event_journal.sql");
const MIGRATION_0002: &str = include_str!("../migrations/0002_event_stream_addressing.sql");
const MIGRATION_0003: &str = include_str!("../migrations/0003_artifact_store.sql");

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
    #[error("runtime migration {version} checksum mismatch")]
    MigrationChecksumMismatch { version: u32 },
    #[error("runtime migration 0002 verification failed")]
    MigrationVerificationFailed,
    #[error("runtime event journal schema integrity check failed")]
    SchemaIntegrityFailed,
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
        verify_schema_integrity(&connection)?;
        let database_path = std::fs::canonicalize(path)?;
        Ok(Self {
            connection,
            database_path,
        })
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
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

        if let Some(expected_global_sequence) = expected_global_sequence {
            let actual_global = current_global_sequence(&transaction)?;
            if actual_global != expected_global_sequence {
                return Err(EventJournalError::GlobalSequenceConflict {
                    expected: expected_global_sequence,
                    actual: actual_global,
                });
            }
        }

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
    u64::try_from(value).map_err(|_| EventJournalError::SequenceOutOfRange)
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
    u64::try_from(value).map_err(|_| EventJournalError::SequenceOutOfRange)
}

fn current_global_sequence(transaction: &Transaction<'_>) -> Result<u64, EventJournalError> {
    let value: i64 = transaction.query_row(
        "SELECT sequence FROM runtime_global_event_clock WHERE singleton_id = 1",
        [],
        |row| row.get(0),
    )?;
    u64::try_from(value).map_err(|_| EventJournalError::SequenceOutOfRange)
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
    value
        .checked_add(1)
        .ok_or(EventJournalError::SequenceOutOfRange)
}

fn to_sql_integer(value: u64) -> Result<i64, EventJournalError> {
    i64::try_from(value).map_err(|_| EventJournalError::SequenceOutOfRange)
}

fn from_sql_integer(value: i64, column: usize) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
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

fn verify_schema_integrity(connection: &Connection) -> Result<(), EventJournalError> {
    verify_migration_ledger_schema(connection)?;
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
    verify_trigger(connection, "runtime_events_no_update", "update")?;
    verify_trigger(connection, "runtime_events_no_delete", "delete")?;
    Ok(())
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

fn verify_trigger(
    connection: &Connection,
    name: &str,
    operation: &str,
) -> Result<(), EventJournalError> {
    let sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1 AND tbl_name = 'runtime_events'",
            [name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| EventJournalError::SchemaIntegrityFailed)?;
    let normalized = sql
        .ok_or(EventJournalError::SchemaIntegrityFailed)?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let expected = format!(
        "create trigger {name} before {operation} on runtime_events begin select raise(abort, 'runtime_event_immutable'); end"
    );
    if normalized != expected {
        return Err(EventJournalError::SchemaIntegrityFailed);
    }
    Ok(())
}
