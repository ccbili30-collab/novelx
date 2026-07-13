use std::{
    env,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use fs2::FileExt;

use super::BoundWorkspaceRuntimeLeaseError;

pub(super) struct DatabaseIdentityLock {
    file: File,
    path: PathBuf,
}

impl DatabaseIdentityLock {
    pub(super) fn acquire(
        database_file_identity_sha256: &str,
    ) -> Result<Self, BoundWorkspaceRuntimeLeaseError> {
        if !is_sha256(database_file_identity_sha256) {
            return Err(BoundWorkspaceRuntimeLeaseError::DatabaseIdentityHashInvalid);
        }
        let directory = global_identity_lock_directory()?;
        let path = directory.join(format!("{database_file_identity_sha256}.lock"));
        reject_unsafe_lock_path_if_present(&path)?;
        let file = open_identity_lock_file(&path).map_err(|source| {
            BoundWorkspaceRuntimeLeaseError::DatabaseIdentityLockUnavailable {
                path: path.clone(),
                source,
            }
        })?;
        validate_open_lock_file(&file, &path)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Self { file, path }),
            Err(source) if is_lock_contention(&source) => Err(
                BoundWorkspaceRuntimeLeaseError::DatabaseIdentityAlreadyBound {
                    database_file_identity_sha256: database_file_identity_sha256.to_owned(),
                    lock_path: path,
                },
            ),
            Err(source) => Err(
                BoundWorkspaceRuntimeLeaseError::DatabaseIdentityLockUnavailable { path, source },
            ),
        }
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for DatabaseIdentityLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn global_identity_lock_directory() -> Result<PathBuf, BoundWorkspaceRuntimeLeaseError> {
    let (base, descendants): (PathBuf, &[&str]) = global_lock_base()?;
    if !base.is_absolute() {
        return Err(
            BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnsafe { path: base },
        );
    }
    validate_existing_directory(&base)?;
    let mut current = fs::canonicalize(&base).map_err(|source| {
        BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnavailable {
            path: base.clone(),
            source,
        }
    })?;
    validate_existing_directory(&current)?;
    for descendant in descendants {
        current.push(descendant);
        ensure_secure_directory(&current)?;
    }
    Ok(current)
}

#[cfg(windows)]
fn global_lock_base() -> Result<(PathBuf, &'static [&'static str]), BoundWorkspaceRuntimeLeaseError>
{
    let base = env::var_os("LOCALAPPDATA").ok_or(
        BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockBaseUnavailable {
            variable: "LOCALAPPDATA",
        },
    )?;
    Ok((
        PathBuf::from(base),
        &["NovelX", "RuntimeV2", "DatabaseIdentityLocks"],
    ))
}

#[cfg(unix)]
fn global_lock_base() -> Result<(PathBuf, &'static [&'static str]), BoundWorkspaceRuntimeLeaseError>
{
    if let Some(base) = env::var_os("XDG_RUNTIME_DIR").filter(|value| !value.is_empty()) {
        return Ok((
            PathBuf::from(base),
            &["novelx", "runtime-v2", "database-identity-locks"],
        ));
    }
    let base = env::var_os("HOME").ok_or(
        BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockBaseUnavailable { variable: "HOME" },
    )?;
    Ok((
        PathBuf::from(base),
        &[".novelx-runtime", "runtime-v2", "database-identity-locks"],
    ))
}

#[cfg(not(any(windows, unix)))]
fn global_lock_base() -> Result<(PathBuf, &'static [&'static str]), BoundWorkspaceRuntimeLeaseError>
{
    Err(
        BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockBaseUnavailable {
            variable: "unsupported-platform",
        },
    )
}

fn ensure_secure_directory(path: &Path) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            if let Err(create_error) = fs::create_dir(path)
                && create_error.kind() != io::ErrorKind::AlreadyExists
            {
                return Err(
                    BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnavailable {
                        path: path.to_owned(),
                        source: create_error,
                    },
                );
            }
        }
        Err(source) => {
            return Err(
                BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnavailable {
                    path: path.to_owned(),
                    source,
                },
            );
        }
    }
    harden_directory_permissions(path)?;
    validate_existing_directory(path)
}

fn validate_existing_directory(path: &Path) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| {
        BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnavailable {
            path: path.to_owned(),
            source,
        }
    })?;
    if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
        return Err(
            BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnsafe {
                path: path.to_owned(),
            },
        );
    }
    if !metadata.is_dir() {
        return Err(
            BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnsafe {
                path: path.to_owned(),
            },
        );
    }
    Ok(())
}

#[cfg(unix)]
fn harden_directory_permissions(path: &Path) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|source| {
        BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnavailable {
            path: path.to_owned(),
            source,
        }
    })?;
    let mode = fs::symlink_metadata(path)
        .map_err(|source| {
            BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnavailable {
                path: path.to_owned(),
                source,
            }
        })?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        return Err(
            BoundWorkspaceRuntimeLeaseError::GlobalIdentityLockDirectoryUnsafe {
                path: path.to_owned(),
            },
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_directory_permissions(_path: &Path) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
    Ok(())
}

fn reject_unsafe_lock_path_if_present(path: &Path) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.file_type().is_symlink()
                || is_windows_reparse_point(&metadata)
                || !metadata.is_file() =>
        {
            Err(
                BoundWorkspaceRuntimeLeaseError::DatabaseIdentityLockUnsafe {
                    path: path.to_owned(),
                },
            )
        }
        Ok(_) => Ok(()),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(
            BoundWorkspaceRuntimeLeaseError::DatabaseIdentityLockUnavailable {
                path: path.to_owned(),
                source,
            },
        ),
    }
}

fn validate_open_lock_file(
    file: &File,
    path: &Path,
) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
    let metadata = file.metadata().map_err(|source| {
        BoundWorkspaceRuntimeLeaseError::DatabaseIdentityLockUnavailable {
            path: path.to_owned(),
            source,
        }
    })?;
    let path_metadata = fs::symlink_metadata(path).map_err(|source| {
        BoundWorkspaceRuntimeLeaseError::DatabaseIdentityLockUnavailable {
            path: path.to_owned(),
            source,
        }
    })?;
    if !metadata.is_file()
        || is_windows_reparse_point(&metadata)
        || path_metadata.file_type().is_symlink()
        || is_windows_reparse_point(&path_metadata)
    {
        return Err(
            BoundWorkspaceRuntimeLeaseError::DatabaseIdentityLockUnsafe {
                path: path.to_owned(),
            },
        );
    }
    Ok(())
}

#[cfg(windows)]
fn open_identity_lock_file(path: &Path) -> io::Result<File> {
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
        .open(path)
}

#[cfg(unix)]
fn open_identity_lock_file(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o600)
        .open(path)
}

#[cfg(not(any(windows, unix)))]
fn open_identity_lock_file(_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "database identity locking is unsupported on this platform",
    ))
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_lock_contention(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(windows)]
    {
        // ERROR_LOCK_VIOLATION. Rust normally maps it to WouldBlock, but retaining the raw code
        // makes the classification stable across standard-library implementations.
        if error.raw_os_error() == Some(33) {
            return true;
        }
    }
    #[cfg(unix)]
    {
        let raw = error.raw_os_error();
        if raw == Some(libc::EAGAIN) || raw == Some(libc::EWOULDBLOCK) {
            return true;
        }
    }
    false
}
