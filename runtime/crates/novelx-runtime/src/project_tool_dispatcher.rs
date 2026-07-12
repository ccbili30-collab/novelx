use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

use crate::project_file_tools::{
    ProjectFileToolError, ProjectFileToolExecutor, ReadProjectFileRequest,
};
use crate::project_path::{ProjectPathError, ProjectRoot};
use crate::project_search_tools::{
    ProjectSearchError, ScanBudget, VerifiedProjectRoot, glob_project_files, search_project_files,
};

pub struct ProjectToolDispatcher {
    root: ProjectRoot,
    files: ProjectFileToolExecutor,
    scan_budget: ScanBudget,
}

impl ProjectToolDispatcher {
    pub fn new(root: ProjectRoot) -> Result<Self, ProjectToolDispatchError> {
        let files = ProjectFileToolExecutor::new(root.canonical_path())?;
        Ok(Self {
            root,
            files,
            scan_budget: ScanBudget {
                max_files: 2_000,
                max_total_bytes: 32_000_000,
                max_file_bytes: 4_000_000,
                max_file_chars: 1_000_000,
                max_results: 200,
                max_result_chars: 100_000,
                timeout: Duration::from_secs(10),
            },
        })
    }

    pub async fn dispatch(
        &self,
        tool_name: &str,
        arguments: Value,
    ) -> Result<Value, ProjectToolDispatchError> {
        match tool_name {
            "list_project_directory" => {
                let args: ListArguments = strict(arguments)?;
                Ok(serde_json::to_value(self.files.list(&args.path).await?)?)
            }
            "read_project_file" => {
                let args: ReadArguments = strict(arguments)?;
                Ok(serde_json::to_value(
                    self.files
                        .read(ReadProjectFileRequest {
                            path: args.path,
                            offset_chars: args.offset_chars,
                            max_chars: args.max_chars,
                            expected_sha256: args.expected_sha256,
                        })
                        .await?,
                )?)
            }
            "stat_project_file" => {
                let args: PathArguments = strict(arguments)?;
                Ok(serde_json::to_value(self.files.stat(&args.path).await?)?)
            }
            "search_project_files" => {
                let args: SearchArguments = strict(arguments)?;
                let root = self.search_root(&args.path)?;
                Ok(serde_json::to_value(search_project_files(
                    &root,
                    &args.query,
                    &self.scan_budget,
                )?)?)
            }
            "glob_project_files" => {
                let args: GlobArguments = strict(arguments)?;
                let root = self.search_root(&args.path)?;
                Ok(serde_json::to_value(glob_project_files(
                    &root,
                    &args.pattern,
                    &self.scan_budget,
                )?)?)
            }
            _ => Err(ProjectToolDispatchError::UnsupportedTool(
                tool_name.to_owned(),
            )),
        }
    }

    fn search_root(&self, path: &str) -> Result<VerifiedProjectRoot, ProjectToolDispatchError> {
        let resolved = if path.trim().is_empty() {
            self.root.canonical_path().to_path_buf()
        } else {
            self.root.resolve_existing(path)?
        };
        Ok(VerifiedProjectRoot::from_verified_path(resolved)?)
    }
}

fn strict<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, ProjectToolDispatchError> {
    serde_json::from_value(value).map_err(ProjectToolDispatchError::InvalidArguments)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArguments {
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathArguments {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadArguments {
    path: String,
    #[serde(default)]
    offset_chars: usize,
    #[serde(default = "default_read_chars")]
    max_chars: usize,
    #[serde(default)]
    expected_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArguments {
    query: String,
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GlobArguments {
    pattern: String,
    #[serde(default)]
    path: String,
}

const fn default_read_chars() -> usize {
    120_000
}

#[derive(Debug, Error)]
pub enum ProjectToolDispatchError {
    #[error("unsupported project tool `{0}`")]
    UnsupportedTool(String),
    #[error("project tool arguments are invalid: {0}")]
    InvalidArguments(serde_json::Error),
    #[error(transparent)]
    Path(#[from] ProjectPathError),
    #[error(transparent)]
    File(#[from] ProjectFileToolError),
    #[error(transparent)]
    Search(#[from] ProjectSearchError),
    #[error("project tool result could not be serialized: {0}")]
    ResultSerialization(#[from] serde_json::Error),
}
