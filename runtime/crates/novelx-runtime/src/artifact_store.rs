use std::path::Path;

use novelx_protocol::ToolArtifactReceipt;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const JSON_MEDIA_TYPE: &str = "application/json";

#[derive(Clone, Debug, PartialEq)]
pub struct StoredArtifact {
    pub receipt: ToolArtifactReceipt,
    pub run_id: String,
    pub content: Value,
    pub created_at: String,
}

/// Trusted internal storage boundary.
///
/// Writes currently rely on the calling Runtime service to verify its
/// [`BoundWorkspaceRuntimeLease`](crate::workspace_runtime_lease::BoundWorkspaceRuntimeLease)
/// immediately before entering this store. This is not yet crate-wide capability enforcement.
pub struct ArtifactStore {
    connection: Connection,
}

impl ArtifactStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, ArtifactStoreError> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        let table_exists: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_artifacts'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if table_exists.is_none() {
            return Err(ArtifactStoreError::SchemaMissing);
        }
        Ok(Self { connection })
    }

    pub fn put_json(
        &mut self,
        artifact_id: Uuid,
        run_id: &str,
        content: &Value,
    ) -> Result<StoredArtifact, ArtifactStoreError> {
        if run_id.trim().is_empty() {
            return Err(ArtifactStoreError::InvalidRunId);
        }
        let bytes = serde_json::to_vec(content)?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let utf8_bytes = u64::try_from(bytes.len()).map_err(|_| ArtifactStoreError::TooLarge)?;
        let receipt = ToolArtifactReceipt {
            artifact_id,
            media_type: JSON_MEDIA_TYPE.to_owned(),
            sha256,
            utf8_bytes,
        };
        let created_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let candidate = StoredArtifact {
            receipt,
            run_id: run_id.to_owned(),
            content: content.clone(),
            created_at,
        };
        if let Some(existing) = self.get(artifact_id)? {
            if same_identity_and_content(&existing, &candidate) {
                return Ok(existing);
            }
            return Err(ArtifactStoreError::ArtifactIdConflict(artifact_id));
        }
        self.connection.execute(
            "INSERT INTO runtime_artifacts (artifact_id, run_id, media_type, sha256, utf8_bytes, content_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                candidate.receipt.artifact_id.to_string(),
                candidate.run_id,
                candidate.receipt.media_type,
                candidate.receipt.sha256,
                i64::try_from(candidate.receipt.utf8_bytes).map_err(|_| ArtifactStoreError::TooLarge)?,
                String::from_utf8(bytes).map_err(|_| ArtifactStoreError::InvalidUtf8)?,
                candidate.created_at,
            ],
        )?;
        self.get(artifact_id)?.ok_or(ArtifactStoreError::WriteLost)
    }

    pub fn get(&self, artifact_id: Uuid) -> Result<Option<StoredArtifact>, ArtifactStoreError> {
        let row = self
            .connection
            .query_row(
                "SELECT run_id, media_type, sha256, utf8_bytes, content_json, created_at \
                 FROM runtime_artifacts WHERE artifact_id = ?1",
                [artifact_id.to_string()],
                |row| {
                    let utf8_bytes: i64 = row.get(3)?;
                    let content_json: String = row.get(4)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        u64::try_from(utf8_bytes).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                3,
                                rusqlite::types::Type::Integer,
                                Box::new(error),
                            )
                        })?,
                        content_json,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(ArtifactStoreError::from)?;
        let Some((run_id, media_type, stored_sha256, stored_bytes, content_json, created_at)) = row
        else {
            return Ok(None);
        };
        let bytes = content_json.as_bytes();
        let actual_sha256 = format!("{:x}", Sha256::digest(bytes));
        if actual_sha256 != stored_sha256
            || u64::try_from(bytes.len()).map_err(|_| ArtifactStoreError::TooLarge)? != stored_bytes
        {
            return Err(ArtifactStoreError::IntegrityMismatch(artifact_id));
        }
        let content = serde_json::from_str(&content_json)?;
        Ok(Some(StoredArtifact {
            receipt: ToolArtifactReceipt {
                artifact_id,
                media_type,
                sha256: stored_sha256,
                utf8_bytes: stored_bytes,
            },
            run_id,
            content,
            created_at,
        }))
    }
}

fn same_identity_and_content(left: &StoredArtifact, right: &StoredArtifact) -> bool {
    left.receipt.artifact_id == right.receipt.artifact_id
        && left.receipt.media_type == right.receipt.media_type
        && left.receipt.sha256 == right.receipt.sha256
        && left.receipt.utf8_bytes == right.receipt.utf8_bytes
        && left.run_id == right.run_id
        && left.content == right.content
}

#[derive(Debug, Error)]
pub enum ArtifactStoreError {
    #[error("runtime artifact store schema is missing")]
    SchemaMissing,
    #[error("runtime artifact run id must not be empty")]
    InvalidRunId,
    #[error("runtime artifact is too large")]
    TooLarge,
    #[error("runtime artifact JSON was not UTF-8")]
    InvalidUtf8,
    #[error("runtime artifact id `{0}` conflicts with stored content")]
    ArtifactIdConflict(Uuid),
    #[error("runtime artifact `{0}` failed its persisted integrity check")]
    IntegrityMismatch(Uuid),
    #[error("runtime artifact write was not observable after commit")]
    WriteLost,
    #[error(transparent)]
    Storage(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Time(#[from] time::error::Format),
}
