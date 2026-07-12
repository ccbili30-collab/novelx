use std::{
    ffi::OsString,
    fs::{File, OpenOptions, symlink_metadata},
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use fs2::FileExt;
use serde::Serialize;
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

#[derive(Debug)]
pub struct WorkspaceRuntimeLease {
    file: File,
    lock_path: PathBuf,
    instance_label: String,
    lease_epoch: String,
    owner_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseOwner<'a> {
    schema_version: u32,
    instance_id: &'a str,
    instance_label: &'a str,
    lease_epoch: &'a str,
    process_id: u32,
    acquired_at: &'a str,
}

impl WorkspaceRuntimeLease {
    pub fn acquire(
        database_path: impl AsRef<Path>,
        instance_id: impl Into<String>,
    ) -> Result<Self, WorkspaceRuntimeLeaseError> {
        let database_path = database_path.as_ref();
        let instance_label = instance_id.into();
        if instance_label.trim().is_empty() {
            return Err(WorkspaceRuntimeLeaseError::InstanceIdRequired);
        }
        let parent = database_path
            .parent()
            .ok_or(WorkspaceRuntimeLeaseError::DatabaseParentRequired)?;
        if !parent.is_dir() {
            return Err(WorkspaceRuntimeLeaseError::DatabaseParentMissing);
        }
        let lock_path = lock_path(database_path);
        if symlink_metadata(&lock_path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(WorkspaceRuntimeLeaseError::SymbolicLinkRejected);
        }
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)?;
        file.try_lock_exclusive()
            .map_err(|source| WorkspaceRuntimeLeaseError::AlreadyHeld { source })?;
        let lease_epoch = Uuid::new_v4().to_string();
        let owner_id = lease_epoch.clone();
        let acquired_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let payload = serde_json::to_vec(&LeaseOwner {
            schema_version: 2,
            instance_id: &owner_id,
            instance_label: &instance_label,
            lease_epoch: &lease_epoch,
            process_id: std::process::id(),
            acquired_at: &acquired_at,
        })?;
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&payload)?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok(Self {
            file,
            lock_path,
            instance_label,
            lease_epoch,
            owner_id,
        })
    }

    pub fn instance_id(&self) -> &str {
        &self.owner_id
    }

    pub fn instance_label(&self) -> &str {
        &self.instance_label
    }

    pub fn lease_epoch(&self) -> &str {
        &self.lease_epoch
    }

    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }

    pub fn proves_exclusive_owner(&self, instance_id: &str) -> bool {
        self.owner_id == instance_id
    }

    pub fn protects_database(&self, database_path: impl AsRef<Path>) -> bool {
        self.lock_path == lock_path(database_path.as_ref())
    }
}

impl Drop for WorkspaceRuntimeLease {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn lock_path(database_path: &Path) -> PathBuf {
    let mut value: OsString = database_path.as_os_str().to_owned();
    value.push(".runtime.lock");
    PathBuf::from(value)
}

#[derive(Debug, Error)]
pub enum WorkspaceRuntimeLeaseError {
    #[error("workspace runtime instance id is required")]
    InstanceIdRequired,
    #[error("workspace database parent path is required")]
    DatabaseParentRequired,
    #[error("workspace database parent directory does not exist")]
    DatabaseParentMissing,
    #[error("workspace runtime lock path must not be a symbolic link")]
    SymbolicLinkRejected,
    #[error("workspace runtime lease is already held by another process")]
    AlreadyHeld { source: std::io::Error },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Time(#[from] time::error::Format),
}
