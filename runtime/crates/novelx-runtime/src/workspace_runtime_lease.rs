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

mod database_file_identity;
mod database_identity_lock;

use database_file_identity::DatabaseFileIdentityGuard;
use database_identity_lock::DatabaseIdentityLock;

#[derive(Debug)]
pub struct WorkspaceRuntimeLease {
    file: File,
    lock_path: PathBuf,
    instance_label: String,
    lease_epoch: String,
    owner_id: String,
}

/// A workspace runtime lease bound to the exact operating-system file object currently used as
/// the SQLite main database.
///
/// Binding is deliberately a second phase: the sidecar lease can be acquired before SQLite has
/// created the database, but no database-authoritative service should start until this type exists.
pub struct BoundWorkspaceRuntimeLease {
    // Field order is deliberate: the file anchor and identity lock are dropped before the raw
    // sidecar lease, so a Bound lease never outlives its sidecar authority.
    database_file: DatabaseFileIdentityGuard,
    database_identity_lock: DatabaseIdentityLock,
    lease: WorkspaceRuntimeLease,
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
        reject_unsafe_sidecar_lock_path_if_present(&lock_path)?;
        let mut file = open_sidecar_lock_file(&lock_path)?;
        validate_open_sidecar_lock_file(&file, &lock_path)?;
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

    /// Bind this live sidecar lease to an already-existing SQLite main database.
    ///
    /// This consumes the raw lease. Once binding succeeds there is no API for recovering or
    /// downgrading to an unbound lease; callers share the returned value with `Arc` instead. The
    /// database is never created by this method, and unsupported file-identity platforms fail
    /// closed.
    ///
    /// ```compile_fail
    /// use novelx_runtime::workspace_runtime_lease::WorkspaceRuntimeLease;
    /// fn cannot_reuse_raw_lease(raw: WorkspaceRuntimeLease) {
    ///     let _bound = raw.bind_database("workspace.db");
    ///     let _ = raw.instance_id();
    /// }
    /// ```
    pub fn bind_database(
        self,
        database_path: impl AsRef<Path>,
    ) -> Result<BoundWorkspaceRuntimeLease, BoundWorkspaceRuntimeLeaseError> {
        let database_path = database_path.as_ref();
        if !self.protects_database(database_path) {
            return Err(
                BoundWorkspaceRuntimeLeaseError::WorkspaceLeasePathMismatch {
                    lock_path: self.lock_path.clone(),
                    database_path: database_path.to_owned(),
                },
            );
        }
        let database_file = DatabaseFileIdentityGuard::bind(database_path)?;
        let database_identity_lock =
            DatabaseIdentityLock::acquire(database_file.identity_sha256())?;
        database_file.verify_current()?;
        Ok(BoundWorkspaceRuntimeLease {
            database_file,
            database_identity_lock,
            lease: self,
        })
    }
}

impl BoundWorkspaceRuntimeLease {
    /// The canonical path captured when the database file identity was bound.
    pub fn database_path(&self) -> &Path {
        self.database_file.canonical_path()
    }

    pub fn lease_epoch(&self) -> &str {
        self.lease.lease_epoch()
    }

    pub fn owner_id(&self) -> &str {
        self.lease.instance_id()
    }

    pub fn instance_label(&self) -> &str {
        self.lease.instance_label()
    }

    pub fn proves_exclusive_owner(&self, owner_id: &str) -> bool {
        self.lease.proves_exclusive_owner(owner_id)
    }

    pub fn verify_owner(
        &self,
        expected_owner_id: &str,
    ) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
        if self.owner_id() != expected_owner_id {
            return Err(BoundWorkspaceRuntimeLeaseError::LeaseOwnerMismatch {
                expected: expected_owner_id.to_owned(),
                actual: self.owner_id().to_owned(),
            });
        }
        Ok(())
    }

    pub fn verify_lease_epoch(
        &self,
        expected_lease_epoch: &str,
    ) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
        if self.lease_epoch() != expected_lease_epoch {
            return Err(BoundWorkspaceRuntimeLeaseError::LeaseEpochMismatch {
                expected: expected_lease_epoch.to_owned(),
                actual: self.lease_epoch().to_owned(),
            });
        }
        Ok(())
    }

    /// Verify that the originally bound database path still resolves to the same open file object.
    pub fn verify_database_file_current(&self) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
        self.database_file.verify_current()
    }

    /// Verify that another path resolves to the same file object.
    ///
    /// This intentionally accepts a hard-link alias. It proves file identity only; it does not
    /// claim that the sidecar lease was acquired through the alias path.
    pub fn verify_database_path(
        &self,
        database_path: impl AsRef<Path>,
    ) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
        self.database_file.verify_path(database_path.as_ref())
    }

    /// Verify both the caller's database path and the originally bound path against the exact
    /// operating-system file object held by this lease.
    pub fn verify_database_authority(
        &self,
        database_path: impl AsRef<Path>,
    ) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
        self.verify_database_path(database_path)?;
        self.verify_database_file_current()
    }

    /// The authority hash of this lease-lifetime operating-system file identity.
    ///
    /// Proofs may bind this value together with the lease epoch. It is not a durable database UUID
    /// and must not be persisted or compared across legitimate offline database replacement.
    pub fn database_file_identity_sha256(&self) -> &str {
        self.database_file.identity_sha256()
    }

    pub fn database_identity_lock_path(&self) -> &Path {
        self.database_identity_lock.path()
    }
}

impl std::fmt::Debug for BoundWorkspaceRuntimeLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BoundWorkspaceRuntimeLease")
            .field("database_path", &self.database_path())
            .field(
                "database_file_identity_sha256",
                &self.database_file_identity_sha256(),
            )
            .field(
                "database_identity_lock_path",
                &self.database_identity_lock_path(),
            )
            .field("owner_id", &self.owner_id())
            .field("lease_epoch", &self.lease_epoch())
            .finish_non_exhaustive()
    }
}

impl Drop for WorkspaceRuntimeLease {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn reject_unsafe_sidecar_lock_path_if_present(
    lock_path: &Path,
) -> Result<(), WorkspaceRuntimeLeaseError> {
    match symlink_metadata(lock_path) {
        Ok(metadata)
            if metadata.file_type().is_symlink()
                || is_windows_reparse_point(&metadata)
                || !metadata.is_file() =>
        {
            Err(WorkspaceRuntimeLeaseError::SymbolicLinkRejected)
        }
        Ok(_) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(source.into()),
    }
}

fn validate_open_sidecar_lock_file(
    file: &File,
    lock_path: &Path,
) -> Result<(), WorkspaceRuntimeLeaseError> {
    let opened_metadata = file.metadata()?;
    let path_metadata = symlink_metadata(lock_path)?;
    if !opened_metadata.is_file()
        || is_windows_reparse_point(&opened_metadata)
        || path_metadata.file_type().is_symlink()
        || is_windows_reparse_point(&path_metadata)
    {
        return Err(WorkspaceRuntimeLeaseError::SymbolicLinkRejected);
    }
    Ok(())
}

#[cfg(windows)]
fn open_sidecar_lock_file(lock_path: &Path) -> Result<File, std::io::Error> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(lock_path)
}

#[cfg(unix)]
fn open_sidecar_lock_file(lock_path: &Path) -> Result<File, std::io::Error> {
    use std::os::unix::fs::OpenOptionsExt;

    // flock/fs2 is advisory on Unix and does not prevent an uncooperative process from renaming
    // the path. The database-identity lock acquired by BoundWorkspaceRuntimeLease closes the
    // cooperative alias/split-brain gap across NovelX processes.
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o600)
        .open(lock_path)
}

#[cfg(not(any(windows, unix)))]
fn open_sidecar_lock_file(_lock_path: &Path) -> Result<File, std::io::Error> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "workspace sidecar locking is unsupported on this platform",
    ))
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
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
    #[error("workspace runtime lock path must not be a symbolic link or reparse point")]
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

#[derive(Debug, Error)]
pub enum BoundWorkspaceRuntimeLeaseError {
    #[error("workspace runtime lease does not protect the requested database path")]
    WorkspaceLeasePathMismatch {
        lock_path: PathBuf,
        database_path: PathBuf,
    },
    #[error("workspace database file does not exist: {path}", path = .path.display())]
    DatabaseFileMissing { path: PathBuf },
    #[error("workspace database path is not a regular file: {path}", path = .path.display())]
    DatabasePathNotRegularFile { path: PathBuf },
    #[error("workspace database file identity is unavailable: {path}", path = .path.display())]
    DatabaseFileIdentityUnavailable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "workspace database file was replaced: bound={bound}, actual={actual}",
        bound = .bound_path.display(),
        actual = .actual_path.display()
    )]
    DatabaseFileReplaced {
        bound_path: PathBuf,
        actual_path: PathBuf,
    },
    #[error("workspace database file identity hash is invalid")]
    DatabaseIdentityHashInvalid,
    #[error("workspace database identity is already bound by another runtime")]
    DatabaseIdentityAlreadyBound {
        database_file_identity_sha256: String,
        lock_path: PathBuf,
    },
    #[error("workspace database identity lock is unavailable: {path}", path = .path.display())]
    DatabaseIdentityLockUnavailable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("workspace database identity lock path is unsafe: {path}", path = .path.display())]
    DatabaseIdentityLockUnsafe { path: PathBuf },
    #[error("workspace global identity lock base is unavailable: {variable}")]
    GlobalIdentityLockBaseUnavailable { variable: &'static str },
    #[error("workspace global identity lock directory is unavailable: {path}", path = .path.display())]
    GlobalIdentityLockDirectoryUnavailable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("workspace global identity lock directory is unsafe: {path}", path = .path.display())]
    GlobalIdentityLockDirectoryUnsafe { path: PathBuf },
    #[error("workspace runtime lease owner does not match")]
    LeaseOwnerMismatch { expected: String, actual: String },
    #[error("workspace runtime lease epoch does not match")]
    LeaseEpochMismatch { expected: String, actual: String },
}

impl BoundWorkspaceRuntimeLeaseError {
    /// Stable Runtime protocol code for the exact failed workspace authority check.
    ///
    /// Keep this mapping exhaustive so callers cannot collapse file replacement, path,
    /// identity, owner, or epoch failures into a generic lease mismatch by accident.
    pub const fn protocol_code(&self) -> &'static str {
        match self {
            Self::WorkspaceLeasePathMismatch { .. } => "WORKSPACE_LEASE_PATH_MISMATCH",
            Self::DatabaseFileMissing { .. } => "WORKSPACE_DATABASE_FILE_MISSING",
            Self::DatabasePathNotRegularFile { .. } => "WORKSPACE_DATABASE_PATH_NOT_REGULAR_FILE",
            Self::DatabaseFileIdentityUnavailable { .. } => {
                "WORKSPACE_DATABASE_FILE_IDENTITY_UNAVAILABLE"
            }
            Self::DatabaseFileReplaced { .. } => "WORKSPACE_DATABASE_FILE_REPLACED",
            Self::DatabaseIdentityHashInvalid => "WORKSPACE_DATABASE_IDENTITY_HASH_INVALID",
            Self::DatabaseIdentityAlreadyBound { .. } => {
                "WORKSPACE_DATABASE_IDENTITY_ALREADY_BOUND"
            }
            Self::DatabaseIdentityLockUnavailable { .. } => {
                "WORKSPACE_DATABASE_IDENTITY_LOCK_UNAVAILABLE"
            }
            Self::DatabaseIdentityLockUnsafe { .. } => "WORKSPACE_DATABASE_IDENTITY_LOCK_UNSAFE",
            Self::GlobalIdentityLockBaseUnavailable { .. } => {
                "WORKSPACE_GLOBAL_IDENTITY_LOCK_BASE_UNAVAILABLE"
            }
            Self::GlobalIdentityLockDirectoryUnavailable { .. } => {
                "WORKSPACE_GLOBAL_IDENTITY_LOCK_DIRECTORY_UNAVAILABLE"
            }
            Self::GlobalIdentityLockDirectoryUnsafe { .. } => {
                "WORKSPACE_GLOBAL_IDENTITY_LOCK_DIRECTORY_UNSAFE"
            }
            Self::LeaseOwnerMismatch { .. } => "WORKSPACE_LEASE_OWNER_MISMATCH",
            Self::LeaseEpochMismatch { .. } => "WORKSPACE_LEASE_EPOCH_MISMATCH",
        }
    }
}
