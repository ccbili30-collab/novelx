use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const MIGRATION_VERSION: u32 = 4;
const MIGRATION_SQL: &str = include_str!("../migrations/0004_workspace_event_journal.sql");

#[derive(Clone, Debug, PartialEq)]
pub struct NewWorkspaceEvent {
    pub workspace_id: String,
    pub stream_type: String,
    pub stream_id: String,
    pub message_id: String,
    pub idempotency_key: String,
    pub event_type: String,
    pub event_version: u32,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceEvent {
    pub workspace_id: String,
    pub workspace_sequence: u64,
    pub stream_type: String,
    pub stream_id: String,
    pub stream_sequence: u64,
    pub message_id: String,
    pub idempotency_key: String,
    pub event_type: String,
    pub event_version: u32,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceStreamAddress {
    pub workspace_id: String,
    pub stream_type: String,
    pub stream_id: String,
}

pub struct WorkspaceEventJournal {
    connection: Connection,
}

impl WorkspaceEventJournal {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, WorkspaceEventJournalError> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS runtime_schema_migrations (\
             version INTEGER PRIMARY KEY CHECK (version > 0),\
             applied_at TEXT NOT NULL, checksum TEXT NOT NULL CHECK (length(checksum) = 64)\
             ) STRICT;",
        )?;
        apply_migration(&mut connection)?;
        verify_schema(&connection)?;
        Ok(Self { connection })
    }

    pub fn append(
        &mut self,
        event: NewWorkspaceEvent,
        expected_workspace_sequence: u64,
        expected_stream_sequence: u64,
    ) -> Result<WorkspaceEvent, WorkspaceEventJournalError> {
        validate(&event)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = find_by_message_id(&transaction, &event.message_id)? {
            if same_event(
                &existing,
                &event,
                expected_workspace_sequence,
                expected_stream_sequence,
            ) {
                transaction.commit()?;
                return Ok(existing);
            }
            return Err(WorkspaceEventJournalError::MessageIdConflict {
                message_id: event.message_id,
            });
        }
        if let Some(existing) =
            find_by_idempotency_key(&transaction, &event.workspace_id, &event.idempotency_key)?
        {
            if same_event(
                &existing,
                &event,
                expected_workspace_sequence,
                expected_stream_sequence,
            ) {
                transaction.commit()?;
                return Ok(existing);
            }
            return Err(WorkspaceEventJournalError::IdempotencyConflict {
                idempotency_key: event.idempotency_key,
            });
        }
        let actual_workspace = current_workspace_sequence(&transaction, &event.workspace_id)?;
        if actual_workspace != expected_workspace_sequence {
            return Err(WorkspaceEventJournalError::WorkspaceSequenceConflict {
                expected: expected_workspace_sequence,
                actual: actual_workspace,
            });
        }
        let actual_stream = current_stream_sequence(
            &transaction,
            &event.workspace_id,
            &event.stream_type,
            &event.stream_id,
        )?;
        if actual_stream != expected_stream_sequence {
            return Err(WorkspaceEventJournalError::StreamSequenceConflict {
                expected: expected_stream_sequence,
                actual: actual_stream,
            });
        }
        let workspace_sequence = checked_next(actual_workspace)?;
        let stream_sequence = checked_next(actual_stream)?;
        transaction.execute(
            "INSERT INTO workspace_events (workspace_id, workspace_sequence, stream_type, \
             stream_id, stream_sequence, message_id, idempotency_key, event_type, event_version, \
             payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                event.workspace_id,
                to_sql(workspace_sequence)?,
                event.stream_type,
                event.stream_id,
                to_sql(stream_sequence)?,
                event.message_id,
                event.idempotency_key,
                event.event_type,
                i64::from(event.event_version),
                serde_json::to_string(&event.payload)?,
                event.created_at,
            ],
        )?;
        let stored = find_by_message_id(&transaction, &event.message_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        transaction.commit()?;
        Ok(stored)
    }

    pub fn read_stream(
        &self,
        workspace_id: &str,
        stream_type: &str,
        stream_id: &str,
        after: u64,
    ) -> Result<Vec<WorkspaceEvent>, WorkspaceEventJournalError> {
        require("workspace_id", workspace_id)?;
        require("stream_type", stream_type)?;
        require("stream_id", stream_id)?;
        let mut statement = self.connection.prepare(&format!(
            "{} WHERE workspace_id = ?1 AND stream_type = ?2 AND stream_id = ?3 \
             AND stream_sequence > ?4 ORDER BY stream_sequence ASC",
            select_sql()
        ))?;
        statement
            .query_map(
                params![workspace_id, stream_type, stream_id, to_sql(after)?],
                map_row,
            )?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn current_workspace_sequence(
        &self,
        workspace_id: &str,
    ) -> Result<u64, WorkspaceEventJournalError> {
        require("workspace_id", workspace_id)?;
        let value: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(workspace_sequence), 0) FROM workspace_events WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )?;
        u64::try_from(value).map_err(|_| WorkspaceEventJournalError::SequenceOutOfRange)
    }

    pub fn current_stream_sequence(
        &self,
        workspace_id: &str,
        stream_type: &str,
        stream_id: &str,
    ) -> Result<u64, WorkspaceEventJournalError> {
        require("workspace_id", workspace_id)?;
        require("stream_type", stream_type)?;
        require("stream_id", stream_id)?;
        let value: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(stream_sequence), 0) FROM workspace_events \
             WHERE workspace_id = ?1 AND stream_type = ?2 AND stream_id = ?3",
            params![workspace_id, stream_type, stream_id],
            |row| row.get(0),
        )?;
        u64::try_from(value).map_err(|_| WorkspaceEventJournalError::SequenceOutOfRange)
    }

    pub fn list_streams(
        &self,
        workspace_id: &str,
        stream_type: Option<&str>,
    ) -> Result<Vec<WorkspaceStreamAddress>, WorkspaceEventJournalError> {
        require("workspace_id", workspace_id)?;
        if let Some(stream_type) = stream_type {
            require("stream_type", stream_type)?;
            let mut statement = self.connection.prepare(
                "SELECT DISTINCT workspace_id, stream_type, stream_id FROM workspace_events \
                 WHERE workspace_id = ?1 AND stream_type = ?2 ORDER BY stream_type, stream_id",
            )?;
            return statement
                .query_map(params![workspace_id, stream_type], map_address)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(Into::into);
        }
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT workspace_id, stream_type, stream_id FROM workspace_events \
             WHERE workspace_id = ?1 ORDER BY stream_type, stream_id",
        )?;
        statement
            .query_map([workspace_id], map_address)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }
}

#[derive(Debug, Error)]
pub enum WorkspaceEventJournalError {
    #[error("workspace event field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("workspace event sequence is outside the supported range")]
    SequenceOutOfRange,
    #[error("workspace event version must be greater than zero")]
    InvalidEventVersion,
    #[error("workspace event message_id `{message_id}` conflicts with another event")]
    MessageIdConflict { message_id: String },
    #[error("workspace event idempotency key `{idempotency_key}` conflicts with another event")]
    IdempotencyConflict { idempotency_key: String },
    #[error("workspace sequence conflict: expected {expected}, actual {actual}")]
    WorkspaceSequenceConflict { expected: u64, actual: u64 },
    #[error("workspace stream sequence conflict: expected {expected}, actual {actual}")]
    StreamSequenceConflict { expected: u64, actual: u64 },
    #[error("workspace migration checksum mismatch")]
    MigrationChecksumMismatch,
    #[error("workspace event journal schema integrity check failed")]
    SchemaIntegrityFailed,
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Storage(#[from] rusqlite::Error),
    #[error(transparent)]
    Time(#[from] time::error::Format),
}

fn apply_migration(connection: &mut Connection) -> Result<(), WorkspaceEventJournalError> {
    let checksum = format!("{:x}", Sha256::digest(MIGRATION_SQL.as_bytes()));
    let existing: Option<String> = connection
        .query_row(
            "SELECT checksum FROM runtime_schema_migrations WHERE version = ?1",
            [i64::from(MIGRATION_VERSION)],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing) = existing {
        return if existing == checksum {
            Ok(())
        } else {
            Err(WorkspaceEventJournalError::MigrationChecksumMismatch)
        };
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(MIGRATION_SQL)?;
    let applied_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
    transaction.execute(
        "INSERT INTO runtime_schema_migrations (version, applied_at, checksum) VALUES (?1, ?2, ?3)",
        params![i64::from(MIGRATION_VERSION), applied_at, checksum],
    )?;
    transaction.commit()?;
    Ok(())
}

fn verify_schema(connection: &Connection) -> Result<(), WorkspaceEventJournalError> {
    for name in [
        "workspace_events",
        "workspace_events_stream_replay",
        "workspace_events_type_order",
        "workspace_events_no_update",
        "workspace_events_no_delete",
    ] {
        let exists: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name = ?1",
                [name],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(WorkspaceEventJournalError::SchemaIntegrityFailed);
        }
    }
    Ok(())
}

fn validate(event: &NewWorkspaceEvent) -> Result<(), WorkspaceEventJournalError> {
    require("workspace_id", &event.workspace_id)?;
    require("stream_type", &event.stream_type)?;
    require("stream_id", &event.stream_id)?;
    require("message_id", &event.message_id)?;
    require("idempotency_key", &event.idempotency_key)?;
    require("event_type", &event.event_type)?;
    require("created_at", &event.created_at)?;
    if event.event_version == 0 {
        return Err(WorkspaceEventJournalError::InvalidEventVersion);
    }
    serde_json::to_vec(&event.payload)?;
    Ok(())
}

fn require(field: &'static str, value: &str) -> Result<(), WorkspaceEventJournalError> {
    if value.trim().is_empty() {
        Err(WorkspaceEventJournalError::EmptyField(field))
    } else {
        Ok(())
    }
}

fn current_workspace_sequence(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<u64, WorkspaceEventJournalError> {
    let value: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(workspace_sequence), 0) FROM workspace_events WHERE workspace_id = ?1",
        [workspace_id],
        |row| row.get(0),
    )?;
    u64::try_from(value).map_err(|_| WorkspaceEventJournalError::SequenceOutOfRange)
}

fn current_stream_sequence(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    stream_type: &str,
    stream_id: &str,
) -> Result<u64, WorkspaceEventJournalError> {
    let value: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(stream_sequence), 0) FROM workspace_events \
         WHERE workspace_id = ?1 AND stream_type = ?2 AND stream_id = ?3",
        params![workspace_id, stream_type, stream_id],
        |row| row.get(0),
    )?;
    u64::try_from(value).map_err(|_| WorkspaceEventJournalError::SequenceOutOfRange)
}

fn find_by_message_id(
    transaction: &Transaction<'_>,
    message_id: &str,
) -> Result<Option<WorkspaceEvent>, WorkspaceEventJournalError> {
    transaction
        .query_row(
            &format!("{} WHERE message_id = ?1", select_sql()),
            [message_id],
            map_row,
        )
        .optional()
        .map_err(Into::into)
}

fn find_by_idempotency_key(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    key: &str,
) -> Result<Option<WorkspaceEvent>, WorkspaceEventJournalError> {
    transaction
        .query_row(
            &format!(
                "{} WHERE workspace_id = ?1 AND idempotency_key = ?2",
                select_sql()
            ),
            params![workspace_id, key],
            map_row,
        )
        .optional()
        .map_err(Into::into)
}

fn same_event(
    existing: &WorkspaceEvent,
    candidate: &NewWorkspaceEvent,
    expected_workspace_sequence: u64,
    expected_stream_sequence: u64,
) -> bool {
    existing.workspace_id == candidate.workspace_id
        && existing.stream_type == candidate.stream_type
        && existing.stream_id == candidate.stream_id
        && existing.message_id == candidate.message_id
        && existing.idempotency_key == candidate.idempotency_key
        && existing.event_type == candidate.event_type
        && existing.event_version == candidate.event_version
        && existing.payload == candidate.payload
        && existing.created_at == candidate.created_at
        && expected_workspace_sequence
            .checked_add(1)
            .is_some_and(|next| existing.workspace_sequence == next)
        && expected_stream_sequence
            .checked_add(1)
            .is_some_and(|next| existing.stream_sequence == next)
}

fn checked_next(value: u64) -> Result<u64, WorkspaceEventJournalError> {
    value
        .checked_add(1)
        .ok_or(WorkspaceEventJournalError::SequenceOutOfRange)
}

fn to_sql(value: u64) -> Result<i64, WorkspaceEventJournalError> {
    i64::try_from(value).map_err(|_| WorkspaceEventJournalError::SequenceOutOfRange)
}

fn select_sql() -> &'static str {
    "SELECT workspace_id, workspace_sequence, stream_type, stream_id, stream_sequence, \
     message_id, idempotency_key, event_type, event_version, payload_json, created_at \
     FROM workspace_events"
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceEvent> {
    let workspace_sequence: i64 = row.get(1)?;
    let stream_sequence: i64 = row.get(4)?;
    let event_version: i64 = row.get(8)?;
    let payload_json: String = row.get(9)?;
    Ok(WorkspaceEvent {
        workspace_id: row.get(0)?,
        workspace_sequence: u64::try_from(workspace_sequence).map_err(sql_conversion)?,
        stream_type: row.get(2)?,
        stream_id: row.get(3)?,
        stream_sequence: u64::try_from(stream_sequence).map_err(sql_conversion)?,
        message_id: row.get(5)?,
        idempotency_key: row.get(6)?,
        event_type: row.get(7)?,
        event_version: u32::try_from(event_version).map_err(sql_conversion)?,
        payload: serde_json::from_str(&payload_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                9,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        created_at: row.get(10)?,
    })
}

fn map_address(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceStreamAddress> {
    Ok(WorkspaceStreamAddress {
        workspace_id: row.get(0)?,
        stream_type: row.get(1)?,
        stream_id: row.get(2)?,
    })
}

fn sql_conversion(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Integer, Box::new(error))
}
