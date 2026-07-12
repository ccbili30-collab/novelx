use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use thiserror::Error;

#[derive(Clone, Debug)]
pub struct VerifiedProjectRoot(PathBuf);

impl VerifiedProjectRoot {
    pub fn from_verified_path(path: impl AsRef<Path>) -> Result<Self, ProjectSearchError> {
        let root = fs::canonicalize(path).map_err(ProjectSearchError::Io)?;
        if !root.is_dir() {
            return Err(ProjectSearchError::RootNotDirectory);
        }
        Ok(Self(root))
    }
    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

#[derive(Clone, Debug)]
pub struct ScanBudget {
    pub max_files: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_file_chars: usize,
    pub max_results: usize,
    pub max_result_chars: usize,
    pub timeout: Duration,
}

impl ScanBudget {
    pub fn validate(&self) -> Result<(), ProjectSearchError> {
        if self.max_files == 0
            || self.max_total_bytes == 0
            || self.max_file_bytes == 0
            || self.max_file_chars == 0
            || self.max_results == 0
            || self.max_result_chars == 0
            || self.timeout.is_zero()
        {
            return Err(ProjectSearchError::InvalidBudget);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IncompleteReason {
    FileLimit,
    TotalByteLimit,
    FileByteLimit,
    FileCharacterLimit,
    ResultLimit,
    ResultCharacterLimit,
    Timeout,
    EntryReadFailed,
    FileReadFailed,
    SymlinkSkipped,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCompleteness {
    pub complete: bool,
    pub reasons: Vec<IncompleteReason>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatistics {
    pub files_considered: usize,
    pub files_read: usize,
    pub bytes_considered: u64,
    pub characters_read: usize,
    pub binary_files_skipped: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobResult {
    pub paths: Vec<String>,
    pub completeness: ScanCompleteness,
    pub statistics: ScanStatistics,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub preview: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub completeness: ScanCompleteness,
    pub statistics: ScanStatistics,
}

#[derive(Debug, Error)]
pub enum ProjectSearchError {
    #[error("verified project root is not a directory")]
    RootNotDirectory,
    #[error("scan budget is invalid")]
    InvalidBudget,
    #[error("glob pattern is invalid")]
    InvalidGlob,
    #[error("search query must not be empty")]
    EmptyQuery,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub fn glob_project_files(
    root: &VerifiedProjectRoot,
    pattern: &str,
    budget: &ScanBudget,
) -> Result<GlobResult, ProjectSearchError> {
    budget.validate()?;
    validate_glob(pattern)?;
    let started = Instant::now();
    let mut scan = scan_paths(root, budget, started);
    let mut paths = Vec::new();
    let mut result_chars = 0usize;
    for entry in &scan.files {
        if wildcard_match(pattern, &entry.relative) {
            let chars = entry.relative.chars().count();
            if paths.len() >= budget.max_results {
                scan.reasons.insert(IncompleteReason::ResultLimit);
                break;
            }
            if result_chars.saturating_add(chars) > budget.max_result_chars {
                scan.reasons.insert(IncompleteReason::ResultCharacterLimit);
                break;
            }
            result_chars += chars;
            paths.push(entry.relative.clone());
        }
    }
    Ok(GlobResult {
        paths,
        completeness: completeness(scan.reasons),
        statistics: scan.statistics,
    })
}

pub fn search_project_files(
    root: &VerifiedProjectRoot,
    query: &str,
    budget: &ScanBudget,
) -> Result<SearchResult, ProjectSearchError> {
    budget.validate()?;
    if query.is_empty() {
        return Err(ProjectSearchError::EmptyQuery);
    }
    let started = Instant::now();
    let mut scan = scan_paths(root, budget, started);
    let mut matches = Vec::new();
    let mut result_chars = 0usize;
    for entry in &scan.files {
        if started.elapsed() >= budget.timeout {
            scan.reasons.insert(IncompleteReason::Timeout);
            break;
        }
        if entry.bytes > budget.max_file_bytes {
            scan.reasons.insert(IncompleteReason::FileByteLimit);
            continue;
        }
        if scan.statistics.bytes_considered.saturating_add(entry.bytes) > budget.max_total_bytes {
            scan.reasons.insert(IncompleteReason::TotalByteLimit);
            break;
        }
        scan.statistics.bytes_considered += entry.bytes;
        let bytes = match fs::read(&entry.absolute) {
            Ok(value) => value,
            Err(_) => {
                scan.reasons.insert(IncompleteReason::FileReadFailed);
                continue;
            }
        };
        let text = match String::from_utf8(bytes) {
            Ok(value) => value,
            Err(_) => {
                scan.statistics.binary_files_skipped += 1;
                continue;
            }
        };
        let char_count = text.chars().count();
        if char_count > budget.max_file_chars {
            scan.reasons.insert(IncompleteReason::FileCharacterLimit);
            continue;
        }
        scan.statistics.files_read += 1;
        scan.statistics.characters_read += char_count;
        for (line_index, line) in text.lines().enumerate() {
            for (byte_column, _) in line.match_indices(query) {
                let column = line[..byte_column].chars().count() + 1;
                let preview = line.to_owned();
                let chars = entry.relative.chars().count() + preview.chars().count();
                if matches.len() >= budget.max_results {
                    scan.reasons.insert(IncompleteReason::ResultLimit);
                    break;
                }
                if result_chars.saturating_add(chars) > budget.max_result_chars {
                    scan.reasons.insert(IncompleteReason::ResultCharacterLimit);
                    break;
                }
                result_chars += chars;
                matches.push(SearchMatch {
                    path: entry.relative.clone(),
                    line: line_index + 1,
                    column,
                    preview,
                });
            }
            if scan.reasons.contains(&IncompleteReason::ResultLimit)
                || scan
                    .reasons
                    .contains(&IncompleteReason::ResultCharacterLimit)
            {
                break;
            }
        }
        if scan.reasons.contains(&IncompleteReason::ResultLimit)
            || scan
                .reasons
                .contains(&IncompleteReason::ResultCharacterLimit)
        {
            break;
        }
    }
    Ok(SearchResult {
        matches,
        completeness: completeness(scan.reasons),
        statistics: scan.statistics,
    })
}

struct FileEntry {
    absolute: PathBuf,
    relative: String,
    bytes: u64,
}
struct PathScan {
    files: Vec<FileEntry>,
    reasons: BTreeSet<IncompleteReason>,
    statistics: ScanStatistics,
}

fn scan_paths(root: &VerifiedProjectRoot, budget: &ScanBudget, started: Instant) -> PathScan {
    let mut pending = vec![root.0.clone()];
    let mut files = Vec::new();
    let mut reasons = BTreeSet::new();
    while let Some(directory) = pending.pop() {
        if started.elapsed() >= budget.timeout {
            reasons.insert(IncompleteReason::Timeout);
            break;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(value) => value,
            Err(_) => {
                reasons.insert(IncompleteReason::EntryReadFailed);
                continue;
            }
        };
        let mut paths = Vec::new();
        for entry in entries {
            match entry {
                Ok(value) => paths.push(value.path()),
                Err(_) => {
                    reasons.insert(IncompleteReason::EntryReadFailed);
                }
            }
        }
        paths.sort_by_key(|path| normalize_relative(&root.0, path));
        for path in paths.into_iter().rev() {
            let metadata = match fs::symlink_metadata(&path) {
                Ok(value) => value,
                Err(_) => {
                    reasons.insert(IncompleteReason::EntryReadFailed);
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                reasons.insert(IncompleteReason::SymlinkSkipped);
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            if files.len() >= budget.max_files {
                reasons.insert(IncompleteReason::FileLimit);
                pending.clear();
                break;
            }
            files.push(FileEntry {
                relative: normalize_relative(&root.0, &path),
                absolute: path,
                bytes: metadata.len(),
            });
        }
    }
    files.sort_by(|left, right| left.relative.cmp(&right.relative));
    let statistics = ScanStatistics {
        files_considered: files.len(),
        files_read: 0,
        bytes_considered: 0,
        characters_read: 0,
        binary_files_skipped: 0,
    };
    PathScan {
        files,
        reasons,
        statistics,
    }
}

fn normalize_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn completeness(reasons: BTreeSet<IncompleteReason>) -> ScanCompleteness {
    ScanCompleteness {
        complete: reasons.is_empty(),
        reasons: reasons.into_iter().collect(),
    }
}

fn validate_glob(pattern: &str) -> Result<(), ProjectSearchError> {
    if pattern.trim().is_empty()
        || pattern.contains('\\')
        || pattern.starts_with('/')
        || pattern.split('/').any(|part| part == "..")
    {
        return Err(ProjectSearchError::InvalidGlob);
    }
    Ok(())
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    if let Some(without_leading_directories) = pattern.strip_prefix("**/")
        && wildcard_match(without_leading_directories, value)
    {
        return true;
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let value: Vec<char> = value.chars().collect();
    let mut memo = vec![vec![None; value.len() + 1]; pattern.len() + 1];
    wildcard_match_at(&pattern, &value, 0, 0, &mut memo)
}

fn wildcard_match_at(
    pattern: &[char],
    value: &[char],
    pi: usize,
    vi: usize,
    memo: &mut [Vec<Option<bool>>],
) -> bool {
    if let Some(result) = memo[pi][vi] {
        return result;
    }
    let result = if pi == pattern.len() {
        vi == value.len()
    } else if pattern[pi] == '*' {
        let double = pi + 1 < pattern.len() && pattern[pi + 1] == '*';
        let next = pi + if double { 2 } else { 1 };
        wildcard_match_at(pattern, value, next, vi, memo)
            || (vi < value.len()
                && (double || value[vi] != '/')
                && wildcard_match_at(pattern, value, pi, vi + 1, memo))
    } else if vi < value.len()
        && (pattern[pi] == '?' && value[vi] != '/' || pattern[pi] == value[vi])
    {
        wildcard_match_at(pattern, value, pi + 1, vi + 1, memo)
    } else {
        false
    };
    memo[pi][vi] = Some(result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn budget() -> ScanBudget {
        ScanBudget {
            max_files: 100,
            max_total_bytes: 1_000_000,
            max_file_bytes: 100_000,
            max_file_chars: 100_000,
            max_results: 100,
            max_result_chars: 100_000,
            timeout: Duration::from_secs(2),
        }
    }

    #[test]
    fn glob_and_search_scan_complete_chinese_project_content() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join("世界观")).unwrap();
        fs::write(
            temp.path().join("世界观").join("海岸线.md"),
            "海岸线由沉降形成。\n精灵居住在曲折海湾。\n",
        )
        .unwrap();
        fs::write(temp.path().join("角色.txt"), "角色：林雾\n").unwrap();
        fs::write(temp.path().join("root.md"), "root").unwrap();
        let root = VerifiedProjectRoot::from_verified_path(temp.path()).unwrap();
        let glob = glob_project_files(&root, "**/*.md", &budget()).unwrap();
        assert_eq!(glob.paths, vec!["root.md", "世界观/海岸线.md"]);
        assert!(glob.completeness.complete);
        let search = search_project_files(&root, "精灵", &budget()).unwrap();
        assert_eq!(search.matches[0].path, "世界观/海岸线.md");
        assert_eq!((search.matches[0].line, search.matches[0].column), (2, 1));
        assert!(search.completeness.complete);
    }

    #[test]
    fn oversized_file_is_not_prefix_searched_or_reported_complete() {
        let temp = TempDir::new().unwrap();
        fs::write(
            temp.path().join("长篇.md"),
            format!("{}目标", "前".repeat(100)),
        )
        .unwrap();
        let root = VerifiedProjectRoot::from_verified_path(temp.path()).unwrap();
        let mut limits = budget();
        limits.max_file_chars = 50;
        let result = search_project_files(&root, "目标", &limits).unwrap();
        assert!(result.matches.is_empty());
        assert!(!result.completeness.complete);
        assert!(
            result
                .completeness
                .reasons
                .contains(&IncompleteReason::FileCharacterLimit)
        );
    }

    #[test]
    fn every_budget_truncation_is_explicitly_incomplete() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("一.md"), "命中\n命中\n").unwrap();
        fs::write(temp.path().join("二.md"), "命中\n").unwrap();
        let root = VerifiedProjectRoot::from_verified_path(temp.path()).unwrap();
        let mut limits = budget();
        limits.max_files = 1;
        assert!(
            !glob_project_files(&root, "**", &limits)
                .unwrap()
                .completeness
                .complete
        );
        let mut limits = budget();
        limits.max_results = 1;
        let result = search_project_files(&root, "命中", &limits).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(
            result.completeness.reasons,
            vec![IncompleteReason::ResultLimit]
        );
    }

    #[test]
    fn byte_character_and_timeout_budgets_never_claim_complete() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("alpha.md"), "coast target").unwrap();
        fs::write(temp.path().join("beta.md"), "second target").unwrap();
        let root = VerifiedProjectRoot::from_verified_path(temp.path()).unwrap();

        let mut limits = budget();
        limits.max_file_bytes = 3;
        let result = search_project_files(&root, "target", &limits).unwrap();
        assert!(result.matches.is_empty());
        assert!(
            result
                .completeness
                .reasons
                .contains(&IncompleteReason::FileByteLimit)
        );

        let mut limits = budget();
        limits.max_total_bytes = 15;
        assert!(
            search_project_files(&root, "target", &limits)
                .unwrap()
                .completeness
                .reasons
                .contains(&IncompleteReason::TotalByteLimit)
        );

        let mut limits = budget();
        limits.max_result_chars = 2;
        assert!(
            glob_project_files(&root, "**", &limits)
                .unwrap()
                .completeness
                .reasons
                .contains(&IncompleteReason::ResultCharacterLimit)
        );

        let mut limits = budget();
        limits.timeout = Duration::from_nanos(1);
        assert!(
            search_project_files(&root, "target", &limits)
                .unwrap()
                .completeness
                .reasons
                .contains(&IncompleteReason::Timeout)
        );
    }
}
