use std::collections::VecDeque;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Semaphore;

const DEFAULT_MAX_LIST_ENTRIES: usize = 2_000;
const DEFAULT_MAX_READ_CHARS: usize = 120_000;
const DEFAULT_MAX_READ_BYTES: u64 = 4_000_000;
const DEFAULT_MAX_CONCURRENCY: usize = 4;
const MAX_SCANNED_ENTRIES: usize = 100_000;
const IGNORED_DIRECTORIES: [&str; 3] = [".git", ".novax", "node_modules"];

#[derive(Clone)]
pub struct ProjectFileToolExecutor {
    root: PathBuf,
    canonical_root: PathBuf,
    max_list_entries: usize,
    max_read_chars: usize,
    max_read_bytes: u64,
    permits: Arc<Semaphore>,
}

impl ProjectFileToolExecutor {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, ProjectFileToolError> {
        Self::with_limits(
            root,
            DEFAULT_MAX_LIST_ENTRIES,
            DEFAULT_MAX_READ_CHARS,
            DEFAULT_MAX_READ_BYTES,
            DEFAULT_MAX_CONCURRENCY,
        )
    }

    pub fn with_limits(
        root: impl AsRef<Path>,
        max_list_entries: usize,
        max_read_chars: usize,
        max_read_bytes: u64,
        max_concurrency: usize,
    ) -> Result<Self, ProjectFileToolError> {
        if max_list_entries == 0
            || max_read_chars == 0
            || max_read_bytes == 0
            || max_concurrency == 0
        {
            return Err(ProjectFileToolError::LimitsInvalid);
        }
        let root = root.as_ref().to_path_buf();
        let canonical_root = fs::canonicalize(&root).map_err(map_io)?;
        if !canonical_root.is_dir() {
            return Err(ProjectFileToolError::RootNotDirectory);
        }
        Ok(Self {
            root,
            canonical_root,
            max_list_entries,
            max_read_chars,
            max_read_bytes,
            permits: Arc::new(Semaphore::new(max_concurrency)),
        })
    }

    pub async fn list(
        &self,
        path: &str,
    ) -> Result<ListProjectDirectoryReceipt, ProjectFileToolError> {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ProjectFileToolError::ExecutorClosed)?;
        let executor = self.clone();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            executor.list_blocking(&path)
        })
        .await
        .map_err(|_| ProjectFileToolError::TaskFailed)?
    }

    pub async fn stat(&self, path: &str) -> Result<StatProjectFileReceipt, ProjectFileToolError> {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ProjectFileToolError::ExecutorClosed)?;
        let executor = self.clone();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            executor.stat_blocking(&path)
        })
        .await
        .map_err(|_| ProjectFileToolError::TaskFailed)?
    }

    pub async fn read(
        &self,
        request: ReadProjectFileRequest,
    ) -> Result<ReadProjectFileReceipt, ProjectFileToolError> {
        if request.max_chars == 0 || request.max_chars > self.max_read_chars {
            return Err(ProjectFileToolError::RangeInvalid);
        }
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ProjectFileToolError::ExecutorClosed)?;
        let executor = self.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            executor.read_blocking(request)
        })
        .await
        .map_err(|_| ProjectFileToolError::TaskFailed)?
    }

    fn list_blocking(
        &self,
        path: &str,
    ) -> Result<ListProjectDirectoryReceipt, ProjectFileToolError> {
        let start = self.resolve_existing(path)?;
        let metadata = fs::metadata(&start).map_err(map_io)?;
        let mut entries = Vec::new();
        let mut omitted_entries = 0usize;
        let mut scanned_entries = 0usize;
        let mut scan_complete = true;
        let mut queue = VecDeque::from([start]);

        while let Some(directory) = queue.pop_front() {
            if !fs::metadata(&directory).map_err(map_io)?.is_dir() {
                let entry = self.entry(&directory)?;
                if entries.len() < self.max_list_entries {
                    entries.push(entry);
                } else {
                    omitted_entries += 1;
                }
                continue;
            }
            let mut children = fs::read_dir(&directory)
                .map_err(map_io)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(map_io)?;
            children.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
            for child in children {
                if scanned_entries >= MAX_SCANNED_ENTRIES {
                    scan_complete = false;
                    break;
                }
                let file_type = child.file_type().map_err(map_io)?;
                let name = child.file_name();
                if file_type.is_dir() && is_ignored(name.to_string_lossy().as_ref()) {
                    continue;
                }
                let canonical = fs::canonicalize(child.path()).map_err(map_io)?;
                self.assert_inside(&canonical)?;
                scanned_entries += 1;
                let entry = self.entry(&canonical)?;
                if entries.len() < self.max_list_entries {
                    entries.push(entry);
                } else {
                    omitted_entries += 1;
                }
                if file_type.is_dir() {
                    queue.push_back(canonical);
                }
            }
            if !scan_complete {
                break;
            }
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        let mut receipt = ListProjectDirectoryReceipt {
            root: if path.trim().is_empty() {
                ".".to_owned()
            } else {
                normalize_display(path)
            },
            entries,
            incomplete: omitted_entries > 0 || !scan_complete,
            omitted_entries,
            omitted_entries_exact: scan_complete,
            receipt_sha256: String::new(),
        };
        receipt.receipt_sha256 = hash_receipt(&receipt)?;
        if !metadata.is_dir() && receipt.entries.is_empty() {
            return Err(ProjectFileToolError::NotFound);
        }
        Ok(receipt)
    }

    fn stat_blocking(&self, path: &str) -> Result<StatProjectFileReceipt, ProjectFileToolError> {
        let target = self.resolve_existing(path)?;
        let metadata = fs::metadata(&target).map_err(map_io)?;
        let kind = if metadata.is_dir() {
            FileEntryKind::Directory
        } else {
            FileEntryKind::File
        };
        let version = if metadata.is_file() {
            Some(file_version(&target, &metadata, self.max_read_bytes, true)?)
        } else {
            None
        };
        let mut receipt = StatProjectFileReceipt {
            path: self.relative(&target)?,
            kind,
            size: metadata.is_file().then_some(metadata.len()),
            modified_unix_nanos: modified_nanos(&metadata)?,
            version,
            receipt_sha256: String::new(),
        };
        receipt.receipt_sha256 = hash_receipt(&receipt)?;
        Ok(receipt)
    }

    fn read_blocking(
        &self,
        request: ReadProjectFileRequest,
    ) -> Result<ReadProjectFileReceipt, ProjectFileToolError> {
        let target = self.resolve_existing(&request.path)?;
        let before = fs::metadata(&target).map_err(map_io)?;
        if !before.is_file() {
            return Err(ProjectFileToolError::NotAFile);
        }
        if before.len() > self.max_read_bytes {
            return Err(ProjectFileToolError::FileTooLarge {
                size: before.len(),
                maximum: self.max_read_bytes,
            });
        }
        let bytes = fs::read(&target).map_err(map_io)?;
        if bytes.len() as u64 > self.max_read_bytes {
            return Err(ProjectFileToolError::FileTooLarge {
                size: bytes.len() as u64,
                maximum: self.max_read_bytes,
            });
        }
        let after = fs::metadata(&target).map_err(map_io)?;
        if before.len() != after.len() || modified_nanos(&before)? != modified_nanos(&after)? {
            return Err(ProjectFileToolError::FileChangedDuringRead);
        }
        let sha256 = hash_bytes(&bytes);
        if let Some(expected) = &request.expected_sha256
            && expected != &sha256
        {
            return Err(ProjectFileToolError::VersionConflict {
                expected: expected.clone(),
                actual: sha256,
            });
        }
        let content = String::from_utf8(bytes).map_err(|_| ProjectFileToolError::InvalidUtf8 {
            path: normalize_display(&request.path),
        })?;
        let total_chars = content.chars().count();
        if request.offset_chars > total_chars {
            return Err(ProjectFileToolError::RangeInvalid);
        }
        let returned: String = content
            .chars()
            .skip(request.offset_chars)
            .take(request.max_chars)
            .collect();
        let returned_chars = returned.chars().count();
        let end_char = request.offset_chars + returned_chars;
        let version = FileVersionReceipt {
            sha256: hash_bytes(content.as_bytes()),
            size: after.len(),
            modified_unix_nanos: modified_nanos(&after)?,
        };
        let mut receipt = ReadProjectFileReceipt {
            path: self.relative(&target)?,
            content: returned,
            start_char: request.offset_chars,
            end_char,
            returned_chars,
            total_chars,
            has_more: end_char < total_chars,
            complete: end_char == total_chars,
            offset_unit: "unicode_scalar_value".to_owned(),
            version,
            receipt_sha256: String::new(),
        };
        receipt.receipt_sha256 = hash_receipt(&receipt)?;
        Ok(receipt)
    }

    fn entry(&self, target: &Path) -> Result<ProjectFileEntry, ProjectFileToolError> {
        let metadata = fs::metadata(target).map_err(map_io)?;
        Ok(ProjectFileEntry {
            path: self.relative(target)?,
            kind: if metadata.is_dir() {
                FileEntryKind::Directory
            } else {
                FileEntryKind::File
            },
            size: metadata.is_file().then_some(metadata.len()),
            modified_unix_nanos: modified_nanos(&metadata)?,
        })
    }

    fn resolve_existing(&self, value: &str) -> Result<PathBuf, ProjectFileToolError> {
        let normalized = normalize_relative(value)?;
        let candidate = self.root.join(normalized);
        let canonical = fs::canonicalize(candidate).map_err(map_io)?;
        self.assert_inside(&canonical)?;
        Ok(canonical)
    }

    fn assert_inside(&self, target: &Path) -> Result<(), ProjectFileToolError> {
        if target == self.canonical_root || target.starts_with(&self.canonical_root) {
            Ok(())
        } else {
            Err(ProjectFileToolError::PathOutsideRoot)
        }
    }

    fn relative(&self, target: &Path) -> Result<String, ProjectFileToolError> {
        let relative = target
            .strip_prefix(&self.canonical_root)
            .map_err(|_| ProjectFileToolError::PathOutsideRoot)?;
        Ok(relative.to_string_lossy().replace('\\', "/"))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadProjectFileRequest {
    pub path: String,
    pub offset_chars: usize,
    pub max_chars: usize,
    pub expected_sha256: Option<String>,
}

impl ReadProjectFileRequest {
    pub fn whole(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            offset_chars: 0,
            max_chars: DEFAULT_MAX_READ_CHARS,
            expected_sha256: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileEntryKind {
    File,
    Directory,
}

impl FileEntryKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersionReceipt {
    pub sha256: String,
    pub size: u64,
    pub modified_unix_nanos: u128,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileEntry {
    pub path: String,
    pub kind: FileEntryKind,
    pub size: Option<u64>,
    pub modified_unix_nanos: u128,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectDirectoryReceipt {
    pub root: String,
    pub entries: Vec<ProjectFileEntry>,
    pub incomplete: bool,
    pub omitted_entries: usize,
    pub omitted_entries_exact: bool,
    pub receipt_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatProjectFileReceipt {
    pub path: String,
    pub kind: FileEntryKind,
    pub size: Option<u64>,
    pub modified_unix_nanos: u128,
    pub version: Option<FileVersionReceipt>,
    pub receipt_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadProjectFileReceipt {
    pub path: String,
    pub content: String,
    pub start_char: usize,
    pub end_char: usize,
    pub returned_chars: usize,
    pub total_chars: usize,
    pub has_more: bool,
    pub complete: bool,
    pub offset_unit: String,
    pub version: FileVersionReceipt,
    pub receipt_sha256: String,
}

#[derive(Debug, Error)]
pub enum ProjectFileToolError {
    #[error("project file tool limits are invalid")]
    LimitsInvalid,
    #[error("project root is not a directory")]
    RootNotDirectory,
    #[error("project path is restricted")]
    PathRestricted,
    #[error("project path resolves outside the project root")]
    PathOutsideRoot,
    #[error("project file or directory was not found")]
    NotFound,
    #[error("project path is not a file")]
    NotAFile,
    #[error("project file is not strict UTF-8: {path}")]
    InvalidUtf8 { path: String },
    #[error("project read range is invalid")]
    RangeInvalid,
    #[error("project file exceeds the read limit: {size} > {maximum}")]
    FileTooLarge { size: u64, maximum: u64 },
    #[error("project file version changed: expected {expected}, actual {actual}")]
    VersionConflict { expected: String, actual: String },
    #[error("project file changed while it was being read")]
    FileChangedDuringRead,
    #[error("project file tool executor is closed")]
    ExecutorClosed,
    #[error("project file tool task failed")]
    TaskFailed,
    #[error("project file receipt could not be serialized")]
    ReceiptInvalid,
    #[error("project file operation failed: {0}")]
    Io(#[source] std::io::Error),
}

fn normalize_relative(value: &str) -> Result<PathBuf, ProjectFileToolError> {
    let trimmed = value.trim().replace('\\', "/");
    if trimmed.is_empty() || trimmed == "." || trimmed == "/" {
        return Ok(PathBuf::from("."));
    }
    if trimmed.starts_with('/') || trimmed.starts_with("//") || has_windows_prefix(&trimmed) {
        return Err(ProjectFileToolError::PathOutsideRoot);
    }
    let path = Path::new(&trimmed);
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => {
                let segment = segment.to_string_lossy();
                if is_ignored(&segment) {
                    return Err(ProjectFileToolError::PathRestricted);
                }
                normalized.push(segment.as_ref());
            }
            Component::CurDir => {}
            Component::ParentDir => return Err(ProjectFileToolError::PathRestricted),
            Component::RootDir | Component::Prefix(_) => {
                return Err(ProjectFileToolError::PathOutsideRoot);
            }
        }
    }
    Ok(normalized)
}

fn normalize_display(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_owned()
}

fn has_windows_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn is_ignored(value: &str) -> bool {
    IGNORED_DIRECTORIES
        .iter()
        .any(|ignored| value.eq_ignore_ascii_case(ignored))
}

fn modified_nanos(metadata: &fs::Metadata) -> Result<u128, ProjectFileToolError> {
    metadata
        .modified()
        .map_err(map_io)?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|_| ProjectFileToolError::ReceiptInvalid)
}

fn file_version(
    path: &Path,
    metadata: &fs::Metadata,
    maximum: u64,
    enforce_limit: bool,
) -> Result<FileVersionReceipt, ProjectFileToolError> {
    if enforce_limit && metadata.len() > maximum {
        return Err(ProjectFileToolError::FileTooLarge {
            size: metadata.len(),
            maximum,
        });
    }
    let bytes = fs::read(path).map_err(map_io)?;
    let after = fs::metadata(path).map_err(map_io)?;
    if metadata.len() != after.len() || modified_nanos(metadata)? != modified_nanos(&after)? {
        return Err(ProjectFileToolError::FileChangedDuringRead);
    }
    Ok(FileVersionReceipt {
        sha256: hash_bytes(&bytes),
        size: after.len(),
        modified_unix_nanos: modified_nanos(&after)?,
    })
}

fn hash_bytes(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn hash_receipt<T: Serialize>(receipt: &T) -> Result<String, ProjectFileToolError> {
    serde_json::to_vec(receipt)
        .map(|bytes| hash_bytes(&bytes))
        .map_err(|_| ProjectFileToolError::ReceiptInvalid)
}

fn map_io(error: std::io::Error) -> ProjectFileToolError {
    if error.kind() == std::io::ErrorKind::NotFound {
        ProjectFileToolError::NotFound
    } else {
        ProjectFileToolError::Io(error)
    }
}
