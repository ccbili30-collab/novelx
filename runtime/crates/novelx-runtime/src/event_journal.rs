use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use thiserror::Error;

const MIGRATION_0001: &str = include_str!("../migrations/0001_event_journal.sql");

#[derive(Clone, Debug, PartialEq)]
pub struct NewRuntimeEvent {
    pub run_id: String,
    pub message_id: String,
    pub event_type: String,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeEvent {
    pub run_id: String,
    pub sequence: u64,
    pub message_id: String,
    pub event_type: String,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Error)]
pub enum EventJournalError {
    #[error("runtime event field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("runtime event sequence is outside the supported range")]
    SequenceOutOfRange,
    #[error("runtime event message_id `{message_id}` already belongs to a different event")]
    MessageIdConflict { message_id: String },
    #[error("runtime event message_id `{message_id}` is duplicated")]
    DuplicateMessageId { message_id: String },
    #[error("runtime run sequence conflict: expected {expected}, actual {actual}")]
    RunSequenceConflict { expected: u64, actual: u64 },
    #[error("runtime event payload is not valid JSON: {0}")]
    InvalidPayload(#[from] serde_json::Error),
    #[error("runtime event journal storage failed: {0}")]
    Storage(#[from] rusqlite::Error),
}

pub struct EventJournal {
    connection: Connection,
}

impl EventJournal {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, EventJournalError> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        connection.execute_batch(MIGRATION_0001)?;
        Ok(Self { connection })
    }

    pub fn append(&mut self, event: NewRuntimeEvent) -> Result<RuntimeEvent, EventJournalError> {
        validate(&event)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(existing) = find_by_message_id(&transaction, &event.message_id)? {
            if !same_semantic_event(&existing, &event) {
                return Err(EventJournalError::MessageIdConflict {
                    message_id: event.message_id,
                });
            }
            transaction.commit()?;
            return Ok(existing);
        }

        let next_sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM runtime_events WHERE run_id = ?1",
            [&event.run_id],
            |row| row.get(0),
        )?;
        if next_sequence <= 0 {
            return Err(EventJournalError::SequenceOutOfRange);
        }
        let payload_json = serde_json::to_string(&event.payload)?;
        transaction.execute(
            "INSERT INTO runtime_events \
             (run_id, sequence, message_id, event_type, payload_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                event.run_id,
                next_sequence,
                event.message_id,
                event.event_type,
                payload_json,
                event.created_at,
            ],
        )?;
        let inserted = find_by_message_id(&transaction, &event.message_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        transaction.commit()?;
        Ok(inserted)
    }

    pub fn append_after(
        &mut self,
        event: NewRuntimeEvent,
        expected_previous_sequence: u64,
    ) -> Result<RuntimeEvent, EventJournalError> {
        validate(&event)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if find_by_message_id(&transaction, &event.message_id)?.is_some() {
            return Err(EventJournalError::DuplicateMessageId {
                message_id: event.message_id,
            });
        }
        let actual: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM runtime_events WHERE run_id = ?1",
            [&event.run_id],
            |row| row.get(0),
        )?;
        let actual = u64::try_from(actual).map_err(|_| EventJournalError::SequenceOutOfRange)?;
        if actual != expected_previous_sequence {
            return Err(EventJournalError::RunSequenceConflict {
                expected: expected_previous_sequence,
                actual,
            });
        }
        let next_sequence = actual
            .checked_add(1)
            .ok_or(EventJournalError::SequenceOutOfRange)?;
        let next_sequence =
            i64::try_from(next_sequence).map_err(|_| EventJournalError::SequenceOutOfRange)?;
        let payload_json = serde_json::to_string(&event.payload)?;
        transaction.execute(
            "INSERT INTO runtime_events \
             (run_id, sequence, message_id, event_type, payload_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                event.run_id,
                next_sequence,
                event.message_id,
                event.event_type,
                payload_json,
                event.created_at,
            ],
        )?;
        let inserted = find_by_message_id(&transaction, &event.message_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        transaction.commit()?;
        Ok(inserted)
    }

    pub fn read_run(&self, run_id: &str) -> Result<Vec<RuntimeEvent>, EventJournalError> {
        if run_id.trim().is_empty() {
            return Err(EventJournalError::EmptyField("run_id"));
        }
        let mut statement = self.connection.prepare(
            "SELECT run_id, sequence, message_id, event_type, payload_json, created_at \
             FROM runtime_events WHERE run_id = ?1 ORDER BY sequence ASC",
        )?;
        let rows = statement.query_map([run_id], map_event_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

fn same_semantic_event(existing: &RuntimeEvent, candidate: &NewRuntimeEvent) -> bool {
    existing.run_id == candidate.run_id
        && existing.message_id == candidate.message_id
        && existing.event_type == candidate.event_type
        && existing.payload == candidate.payload
        && existing.created_at == candidate.created_at
}

fn validate(event: &NewRuntimeEvent) -> Result<(), EventJournalError> {
    for (field, value) in [
        ("run_id", event.run_id.as_str()),
        ("message_id", event.message_id.as_str()),
        ("event_type", event.event_type.as_str()),
        ("created_at", event.created_at.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(EventJournalError::EmptyField(field));
        }
    }
    Ok(())
}

fn find_by_message_id(
    transaction: &Transaction<'_>,
    message_id: &str,
) -> Result<Option<RuntimeEvent>, EventJournalError> {
    transaction
        .query_row(
            "SELECT run_id, sequence, message_id, event_type, payload_json, created_at \
             FROM runtime_events WHERE message_id = ?1",
            [message_id],
            map_event_row,
        )
        .optional()
        .map_err(Into::into)
}

fn map_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeEvent> {
    let sequence: i64 = row.get(1)?;
    let payload_json: String = row.get(4)?;
    let payload = serde_json::from_str(&payload_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(RuntimeEvent {
        run_id: row.get(0)?,
        sequence: u64::try_from(sequence).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?,
        message_id: row.get(2)?,
        event_type: row.get(3)?,
        payload,
        created_at: row.get(5)?,
    })
}
