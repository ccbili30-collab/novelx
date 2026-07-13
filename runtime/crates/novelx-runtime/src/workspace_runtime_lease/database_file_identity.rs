use std::{
    fs::{File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use super::BoundWorkspaceRuntimeLeaseError;

const IDENTITY_HASH_SCHEME: &[u8] = b"novelx.database-file-identity/v1\0";

pub(super) struct DatabaseFileIdentityGuard {
    canonical_path: PathBuf,
    _anchor: File,
    identity: PlatformFileIdentity,
    identity_sha256: String,
}

impl DatabaseFileIdentityGuard {
    pub(super) fn bind(database_path: &Path) -> Result<Self, BoundWorkspaceRuntimeLeaseError> {
        let canonical_path = std::fs::canonicalize(database_path)
            .map_err(|source| classify_io(database_path, source))?;
        let metadata = std::fs::metadata(&canonical_path)
            .map_err(|source| classify_io(&canonical_path, source))?;
        if !metadata.is_file() {
            return Err(
                BoundWorkspaceRuntimeLeaseError::DatabasePathNotRegularFile {
                    path: canonical_path,
                },
            );
        }
        let anchor = open_database_file(&canonical_path)
            .map_err(|source| classify_io(&canonical_path, source))?;
        ensure_regular_file(&anchor, &canonical_path)?;
        let identity = platform_file_identity(&anchor).map_err(|source| {
            BoundWorkspaceRuntimeLeaseError::DatabaseFileIdentityUnavailable {
                path: canonical_path.clone(),
                source,
            }
        })?;
        let identity_sha256 = identity.sha256();
        Ok(Self {
            canonical_path,
            _anchor: anchor,
            identity,
            identity_sha256,
        })
    }

    pub(super) fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }

    pub(super) fn identity_sha256(&self) -> &str {
        &self.identity_sha256
    }

    pub(super) fn verify_current(&self) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
        self.verify_path(&self.canonical_path)
    }

    pub(super) fn verify_path(
        &self,
        database_path: &Path,
    ) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
        let candidate = open_database_file(database_path)
            .map_err(|source| classify_io(database_path, source))?;
        ensure_regular_file(&candidate, database_path)?;
        let candidate_identity = platform_file_identity(&candidate).map_err(|source| {
            BoundWorkspaceRuntimeLeaseError::DatabaseFileIdentityUnavailable {
                path: database_path.to_owned(),
                source,
            }
        })?;
        if candidate_identity != self.identity {
            return Err(BoundWorkspaceRuntimeLeaseError::DatabaseFileReplaced {
                bound_path: self.canonical_path.clone(),
                actual_path: database_path.to_owned(),
            });
        }
        Ok(())
    }
}

fn classify_io(path: &Path, source: io::Error) -> BoundWorkspaceRuntimeLeaseError {
    if source.kind() == io::ErrorKind::NotFound {
        BoundWorkspaceRuntimeLeaseError::DatabaseFileMissing {
            path: path.to_owned(),
        }
    } else {
        BoundWorkspaceRuntimeLeaseError::DatabaseFileIdentityUnavailable {
            path: path.to_owned(),
            source,
        }
    }
}

fn ensure_regular_file(file: &File, path: &Path) -> Result<(), BoundWorkspaceRuntimeLeaseError> {
    let metadata = file
        .metadata()
        .map_err(|source| classify_io(path, source))?;
    if !metadata.is_file() {
        return Err(
            BoundWorkspaceRuntimeLeaseError::DatabasePathNotRegularFile {
                path: path.to_owned(),
            },
        );
    }
    Ok(())
}

#[cfg(windows)]
fn open_database_file(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
}

#[cfg(not(windows))]
fn open_database_file(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PlatformFileIdentity {
    #[cfg(windows)]
    Windows {
        volume_serial_number: u64,
        file_id: [u8; 16],
    },
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
}

impl PlatformFileIdentity {
    fn sha256(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(IDENTITY_HASH_SCHEME);
        match self {
            #[cfg(windows)]
            Self::Windows {
                volume_serial_number,
                file_id,
            } => {
                digest.update(b"windows\0");
                digest.update(volume_serial_number.to_le_bytes());
                digest.update(file_id);
            }
            #[cfg(unix)]
            Self::Unix { device, inode } => {
                digest.update(b"unix\0");
                digest.update(device.to_le_bytes());
                digest.update(inode.to_le_bytes());
            }
        }
        format!("{:x}", digest.finalize())
    }
}

#[cfg(windows)]
fn platform_file_identity(file: &File) -> io::Result<PlatformFileIdentity> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx},
    };

    let mut information = FILE_ID_INFO::default();
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileIdInfo,
            (&raw mut information).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(PlatformFileIdentity::Windows {
        volume_serial_number: information.VolumeSerialNumber,
        file_id: information.FileId.Identifier,
    })
}

#[cfg(unix)]
fn platform_file_identity(file: &File) -> io::Result<PlatformFileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(PlatformFileIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(any(windows, unix)))]
fn platform_file_identity(_file: &File) -> io::Result<PlatformFileIdentity> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "database file identity is unsupported on this platform",
    ))
}
