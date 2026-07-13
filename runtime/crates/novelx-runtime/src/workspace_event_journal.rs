use std::path::Path;

use novelx_protocol::MAX_SAFE_SEQUENCE;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use thiserror::Error;

use crate::event_journal::{EventJournal, EventJournalError, GlobalEventOrder};

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
    runtime_journal: EventJournal,
}

impl WorkspaceEventJournal {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, WorkspaceEventJournalError> {
        let runtime_journal = EventJournal::open(path).map_err(map_runtime_open_error)?;
        Ok(Self { runtime_journal })
    }

    pub fn append(
        &mut self,
        event: NewWorkspaceEvent,
        expected_workspace_sequence: u64,
        expected_stream_sequence: u64,
    ) -> Result<WorkspaceEvent, WorkspaceEventJournalError> {
        validate(&event)?;
        let transaction = self
            .runtime_journal
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        append_in_transaction(
            transaction,
            event,
            expected_workspace_sequence,
            expected_stream_sequence,
            None,
        )
    }

    pub fn append_at_global_sequence(
        &mut self,
        event: NewWorkspaceEvent,
        expected_workspace_sequence: u64,
        expected_stream_sequence: u64,
        expected_global_sequence: u64,
    ) -> Result<WorkspaceEvent, WorkspaceEventJournalError> {
        validate(&event)?;
        let transaction = self
            .runtime_journal
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        append_in_transaction(
            transaction,
            event,
            expected_workspace_sequence,
            expected_stream_sequence,
            Some(expected_global_sequence),
        )
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
        let mut statement = self.runtime_journal.connection().prepare(&format!(
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
        let value: i64 = self.runtime_journal.connection().query_row(
            "SELECT COALESCE(MAX(workspace_sequence), 0) FROM workspace_events WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )?;
        validate_sql_sequence(value, true)
    }

    pub fn current_global_sequence(&self) -> Result<u64, WorkspaceEventJournalError> {
        current_global_sequence(self.runtime_journal.connection())
    }

    pub fn database_instance_id(&self) -> &str {
        self.runtime_journal.database_instance_id()
    }

    pub fn verify_deep_data_integrity(&mut self) -> Result<(), WorkspaceEventJournalError> {
        self.runtime_journal.verify_deep_data_integrity()?;
        Ok(())
    }

    pub fn global_order_for_message(
        &self,
        message_id: &str,
    ) -> Result<Option<GlobalEventOrder>, WorkspaceEventJournalError> {
        require("message_id", message_id)?;
        global_order_for_workspace_message(self.runtime_journal.connection(), message_id)
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
        let value: i64 = self.runtime_journal.connection().query_row(
            "SELECT COALESCE(MAX(stream_sequence), 0) FROM workspace_events \
             WHERE workspace_id = ?1 AND stream_type = ?2 AND stream_id = ?3",
            params![workspace_id, stream_type, stream_id],
            |row| row.get(0),
        )?;
        validate_sql_sequence(value, true)
    }

    pub fn list_streams(
        &self,
        workspace_id: &str,
        stream_type: Option<&str>,
    ) -> Result<Vec<WorkspaceStreamAddress>, WorkspaceEventJournalError> {
        require("workspace_id", workspace_id)?;
        if let Some(stream_type) = stream_type {
            require("stream_type", stream_type)?;
            let mut statement = self.runtime_journal.connection().prepare(
                "SELECT DISTINCT workspace_id, stream_type, stream_id FROM workspace_events \
                 WHERE workspace_id = ?1 AND stream_type = ?2 ORDER BY stream_type, stream_id",
            )?;
            return statement
                .query_map(params![workspace_id, stream_type], map_address)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(Into::into);
        }
        let mut statement = self.runtime_journal.connection().prepare(
            "SELECT DISTINCT workspace_id, stream_type, stream_id FROM workspace_events \
             WHERE workspace_id = ?1 ORDER BY stream_type, stream_id",
        )?;
        statement
            .query_map([workspace_id], map_address)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }
}

fn map_runtime_open_error(error: EventJournalError) -> WorkspaceEventJournalError {
    match error {
        EventJournalError::MigrationChecksumMismatch { version: 4..=6 } => {
            WorkspaceEventJournalError::MigrationChecksumMismatch
        }
        other => WorkspaceEventJournalError::RuntimeJournal(other),
    }
}

fn append_in_transaction(
    transaction: Transaction<'_>,
    event: NewWorkspaceEvent,
    expected_workspace_sequence: u64,
    expected_stream_sequence: u64,
    expected_global_sequence: Option<u64>,
) -> Result<WorkspaceEvent, WorkspaceEventJournalError> {
    validate_sequence(expected_workspace_sequence, true)?;
    validate_sequence(expected_stream_sequence, true)?;
    if let Some(expected_global_sequence) = expected_global_sequence {
        validate_sequence(expected_global_sequence, true)?;
    }
    if let Some(existing) = find_by_message_id(&transaction, &event.message_id)? {
        if same_full_event(
            &existing,
            &event,
            expected_workspace_sequence,
            expected_stream_sequence,
        ) {
            validate_idempotent_global_order(
                &transaction,
                &existing.message_id,
                expected_global_sequence,
            )?;
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
        if same_idempotent_intent(
            &existing,
            &event,
            expected_workspace_sequence,
            expected_stream_sequence,
        ) {
            validate_idempotent_global_order(
                &transaction,
                &existing.message_id,
                expected_global_sequence,
            )?;
            transaction.commit()?;
            return Ok(existing);
        }
        return Err(WorkspaceEventJournalError::IdempotencyConflict {
            idempotency_key: event.idempotency_key,
        });
    }
    let actual_global = current_global_sequence(&transaction)?;
    if let Some(expected_global_sequence) = expected_global_sequence
        && actual_global != expected_global_sequence
    {
        return Err(WorkspaceEventJournalError::GlobalSequenceConflict {
            expected: expected_global_sequence,
            actual: actual_global,
        });
    }
    checked_next(actual_global)?;
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

#[derive(Debug, Error)]
pub enum WorkspaceEventJournalError {
    #[error("workspace event field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("workspace event sequence is outside the supported range")]
    SequenceOutOfRange,
    #[error("global event sequence conflict: expected {expected}, actual {actual}")]
    GlobalSequenceConflict { expected: u64, actual: u64 },
    #[error("workspace event `{message_id}` predates durable global ordering")]
    GlobalEventLegacyUnordered { message_id: String },
    #[error("workspace event `{message_id}` is missing its durable global order")]
    GlobalEventOrderMissing { message_id: String },
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
    #[error(transparent)]
    RuntimeJournal(#[from] EventJournalError),
}

fn current_global_sequence(connection: &Connection) -> Result<u64, WorkspaceEventJournalError> {
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

fn global_order_for_workspace_message(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<GlobalEventOrder>, WorkspaceEventJournalError> {
    let position: Option<(Option<i64>, i64)> = connection
        .query_row(
            "SELECT ledger.global_sequence, EXISTS(\
                 SELECT 1 FROM runtime_legacy_unordered_events legacy \
                 WHERE legacy.event_kind = 'workspace' AND legacy.message_id = event.message_id\
             ) FROM workspace_events event \
             LEFT JOIN runtime_global_event_ledger ledger \
               ON ledger.event_kind = 'workspace' AND ledger.workspace_message_id = event.message_id \
             WHERE event.message_id = ?1",
            [message_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    position
        .map(|(position, legacy)| match (position, legacy) {
            (Some(value), 0) => validate_sql_sequence(value, false).map(GlobalEventOrder::Ordered),
            (None, 1) => Ok(GlobalEventOrder::LegacyUnordered),
            (None, 0) => Err(WorkspaceEventJournalError::GlobalEventOrderMissing {
                message_id: message_id.to_owned(),
            }),
            _ => Err(WorkspaceEventJournalError::SchemaIntegrityFailed),
        })
        .transpose()
}

fn validate_idempotent_global_order(
    connection: &Connection,
    message_id: &str,
    expected_global_sequence: Option<u64>,
) -> Result<(), WorkspaceEventJournalError> {
    let Some(expected) = expected_global_sequence else {
        return Ok(());
    };
    match global_order_for_workspace_message(connection, message_id)? {
        Some(GlobalEventOrder::Ordered(sequence)) => {
            let actual = sequence
                .checked_sub(1)
                .ok_or(WorkspaceEventJournalError::SequenceOutOfRange)?;
            if actual != expected {
                return Err(WorkspaceEventJournalError::GlobalSequenceConflict {
                    expected,
                    actual,
                });
            }
            Ok(())
        }
        Some(GlobalEventOrder::LegacyUnordered) => {
            Err(WorkspaceEventJournalError::GlobalEventLegacyUnordered {
                message_id: message_id.to_owned(),
            })
        }
        None => Err(WorkspaceEventJournalError::GlobalEventOrderMissing {
            message_id: message_id.to_owned(),
        }),
    }
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
    validate_sql_sequence(value, true)
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
    validate_sql_sequence(value, true)
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

fn same_full_event(
    existing: &WorkspaceEvent,
    candidate: &NewWorkspaceEvent,
    expected_workspace_sequence: u64,
    expected_stream_sequence: u64,
) -> bool {
    same_idempotent_intent(
        existing,
        candidate,
        expected_workspace_sequence,
        expected_stream_sequence,
    ) && existing.message_id == candidate.message_id
        && existing.created_at == candidate.created_at
}

fn same_idempotent_intent(
    existing: &WorkspaceEvent,
    candidate: &NewWorkspaceEvent,
    expected_workspace_sequence: u64,
    expected_stream_sequence: u64,
) -> bool {
    existing.workspace_id == candidate.workspace_id
        && existing.stream_type == candidate.stream_type
        && existing.stream_id == candidate.stream_id
        && existing.idempotency_key == candidate.idempotency_key
        && existing.event_type == candidate.event_type
        && existing.event_version == candidate.event_version
        && existing.payload == candidate.payload
        && expected_workspace_sequence
            .checked_add(1)
            .is_some_and(|next| existing.workspace_sequence == next)
        && expected_stream_sequence
            .checked_add(1)
            .is_some_and(|next| existing.stream_sequence == next)
}

fn checked_next(value: u64) -> Result<u64, WorkspaceEventJournalError> {
    validate_sequence(value, true)?;
    let next = value
        .checked_add(1)
        .ok_or(WorkspaceEventJournalError::SequenceOutOfRange)?;
    validate_sequence(next, false)?;
    Ok(next)
}

fn to_sql(value: u64) -> Result<i64, WorkspaceEventJournalError> {
    validate_sequence(value, true)?;
    i64::try_from(value).map_err(|_| WorkspaceEventJournalError::SequenceOutOfRange)
}

fn validate_sequence(value: u64, allow_zero: bool) -> Result<u64, WorkspaceEventJournalError> {
    if value > MAX_SAFE_SEQUENCE || (!allow_zero && value == 0) {
        return Err(WorkspaceEventJournalError::SequenceOutOfRange);
    }
    Ok(value)
}

fn validate_sql_sequence(value: i64, allow_zero: bool) -> Result<u64, WorkspaceEventJournalError> {
    let value = u64::try_from(value).map_err(|_| WorkspaceEventJournalError::SequenceOutOfRange)?;
    validate_sequence(value, allow_zero)
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
        workspace_sequence: safe_row_sequence(workspace_sequence, 1)?,
        stream_type: row.get(2)?,
        stream_id: row.get(3)?,
        stream_sequence: safe_row_sequence(stream_sequence, 4)?,
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

fn safe_row_sequence(value: i64, column: usize) -> rusqlite::Result<u64> {
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
            Box::new(WorkspaceEventJournalError::SequenceOutOfRange),
        ));
    }
    Ok(value)
}
