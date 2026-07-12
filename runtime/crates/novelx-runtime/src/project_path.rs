use std::path::{Component, Path, PathBuf};

use thiserror::Error;

const MANAGED_SEGMENTS: [&str; 3] = [".novax", ".git", "node_modules"];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectRoot {
    canonical_root: PathBuf,
}

#[derive(Debug, Error)]
pub enum ProjectPathError {
    #[error("project root is invalid")]
    RootInvalid,
    #[error("project path is not an allowed relative path")]
    PathRejected,
    #[error("project path escapes the bound project root")]
    EscapesProjectRoot,
    #[error("project path does not exist")]
    NotFound,
    #[error("project path could not be inspected")]
    Io(#[source] std::io::Error),
}

impl ProjectRoot {
    pub fn open(root: &str) -> Result<Self, ProjectPathError> {
        let root = Path::new(root);
        if root.as_os_str().is_empty() || !root.is_absolute() || !root.is_dir() {
            return Err(ProjectPathError::RootInvalid);
        }
        let canonical_root = std::fs::canonicalize(root).map_err(ProjectPathError::Io)?;
        if !canonical_root.is_dir() {
            return Err(ProjectPathError::RootInvalid);
        }
        Ok(Self { canonical_root })
    }

    pub fn canonical_path(&self) -> &Path {
        &self.canonical_root
    }

    pub fn resolve_existing(&self, relative: &str) -> Result<PathBuf, ProjectPathError> {
        let relative = validate_relative(relative)?;
        let candidate = self.canonical_root.join(relative);
        let resolved = std::fs::canonicalize(candidate).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ProjectPathError::NotFound
            } else {
                ProjectPathError::Io(error)
            }
        })?;
        self.require_confined(resolved)
    }

    pub fn resolve_for_create(&self, relative: &str) -> Result<PathBuf, ProjectPathError> {
        let relative = validate_relative(relative)?;
        let candidate = self.canonical_root.join(relative);
        let mut existing = candidate.as_path();
        while !existing.exists() {
            existing = existing
                .parent()
                .ok_or(ProjectPathError::EscapesProjectRoot)?;
        }
        let resolved_parent = std::fs::canonicalize(existing).map_err(ProjectPathError::Io)?;
        self.require_confined(resolved_parent)?;
        Ok(candidate)
    }

    fn require_confined(&self, resolved: PathBuf) -> Result<PathBuf, ProjectPathError> {
        if resolved.starts_with(&self.canonical_root) {
            Ok(resolved)
        } else {
            Err(ProjectPathError::EscapesProjectRoot)
        }
    }
}

fn validate_relative(value: &str) -> Result<&Path, ProjectPathError> {
    if value.trim().is_empty() {
        return Err(ProjectPathError::PathRejected);
    }
    let path = Path::new(value);
    for component in path.components() {
        match component {
            Component::Normal(segment) => {
                let segment = segment.to_string_lossy();
                if segment.contains(':')
                    || MANAGED_SEGMENTS
                        .iter()
                        .any(|managed| segment.eq_ignore_ascii_case(managed))
                {
                    return Err(ProjectPathError::PathRejected);
                }
            }
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err(ProjectPathError::PathRejected);
            }
        }
    }
    Ok(path)
}
