use std::fs;

use novelx_runtime::project_file_tools::{
    ProjectFileToolError, ProjectFileToolExecutor, ReadProjectFileRequest,
};
use tempfile::TempDir;

#[tokio::test]
async fn lists_stats_and_reads_real_chinese_files_without_a_readme() {
    let fixture = TempDir::new().unwrap();
    fs::create_dir(fixture.path().join("设定")).unwrap();
    fs::write(
        fixture.path().join("设定").join("海岸线.md"),
        "银湾海岸由地壳沉降形成。",
    )
    .unwrap();
    fs::create_dir(fixture.path().join(".novax")).unwrap();
    fs::write(fixture.path().join(".novax").join("workspace.db"), "secret").unwrap();

    let executor = ProjectFileToolExecutor::new(fixture.path()).unwrap();
    let listing = executor.list("").await.unwrap();
    assert_eq!(
        listing
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec!["设定", "设定/海岸线.md"]
    );
    assert!(!serde_json::to_string(&listing).unwrap().contains(".novax"));
    assert!(
        !serde_json::to_string(&listing)
            .unwrap()
            .contains(fixture.path().to_string_lossy().as_ref())
    );

    let stat = executor.stat("设定/海岸线.md").await.unwrap();
    assert_eq!(stat.path, "设定/海岸线.md");
    assert_eq!(stat.kind.as_str(), "file");
    assert_eq!(stat.version.as_ref().unwrap().sha256.len(), 64);

    let read = executor
        .read(ReadProjectFileRequest {
            path: "设定/海岸线.md".to_owned(),
            offset_chars: 0,
            max_chars: 120_000,
            expected_sha256: None,
        })
        .await
        .unwrap();
    assert_eq!(read.content, "银湾海岸由地壳沉降形成。");
    assert!(read.complete);
    assert!(!read.has_more);
    assert_eq!(read.start_char, 0);
    assert_eq!(read.end_char, read.total_chars);
    assert_eq!(read.version.sha256, stat.version.unwrap().sha256);
    assert_eq!(
        read,
        executor
            .read(ReadProjectFileRequest::whole("设定/海岸线.md"))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn reads_unicode_scalar_chunks_contiguously_and_rejects_a_changed_version() {
    let fixture = TempDir::new().unwrap();
    let file = fixture.path().join("长篇.md");
    fs::write(&file, "甲乙𠮷丁\n戊己").unwrap();
    let executor = ProjectFileToolExecutor::new(fixture.path()).unwrap();

    let first = executor
        .read(ReadProjectFileRequest {
            path: "长篇.md".to_owned(),
            offset_chars: 0,
            max_chars: 4,
            expected_sha256: None,
        })
        .await
        .unwrap();
    assert_eq!(first.content, "甲乙𠮷丁");
    assert_eq!((first.start_char, first.end_char), (0, 4));
    assert!(first.has_more);

    let second = executor
        .read(ReadProjectFileRequest {
            path: "长篇.md".to_owned(),
            offset_chars: first.end_char,
            max_chars: 3,
            expected_sha256: Some(first.version.sha256.clone()),
        })
        .await
        .unwrap();
    assert_eq!(second.content, "\n戊己");
    assert_eq!((second.start_char, second.end_char), (4, 7));
    assert!(second.complete);

    fs::write(&file, "文件已经变化").unwrap();
    let changed = executor
        .read(ReadProjectFileRequest {
            path: "长篇.md".to_owned(),
            offset_chars: second.end_char,
            max_chars: 3,
            expected_sha256: Some(first.version.sha256),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        changed,
        ProjectFileToolError::VersionConflict { .. }
    ));
}

#[tokio::test]
async fn fails_closed_for_invalid_utf8_traversal_and_internal_paths() {
    let fixture = TempDir::new().unwrap();
    fs::write(fixture.path().join("invalid.txt"), [0xff, 0xfe, 0xfd]).unwrap();
    fs::create_dir(fixture.path().join(".git")).unwrap();
    fs::write(fixture.path().join(".git").join("config"), "private").unwrap();
    let executor = ProjectFileToolExecutor::new(fixture.path()).unwrap();

    let invalid = executor
        .read(ReadProjectFileRequest::whole("invalid.txt"))
        .await
        .unwrap_err();
    assert!(matches!(invalid, ProjectFileToolError::InvalidUtf8 { .. }));

    let traversal = executor.stat("../outside.txt").await.unwrap_err();
    assert!(matches!(traversal, ProjectFileToolError::PathRestricted));
    let internal = executor.stat(".git/config").await.unwrap_err();
    assert!(matches!(internal, ProjectFileToolError::PathRestricted));

    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("secret.txt"), "secret").unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_dir(outside.path(), fixture.path().join("outside-link"))
        .is_ok()
    {
        let escaped = executor.stat("outside-link/secret.txt").await.unwrap_err();
        assert!(matches!(escaped, ProjectFileToolError::PathOutsideRoot));
    }
}

#[tokio::test]
async fn reports_list_omissions_instead_of_claiming_completeness() {
    let fixture = TempDir::new().unwrap();
    for index in 0..5 {
        fs::write(
            fixture.path().join(format!("{index}.md")),
            index.to_string(),
        )
        .unwrap();
    }
    let executor =
        ProjectFileToolExecutor::with_limits(fixture.path(), 2, 120_000, 4_000_000, 2).unwrap();
    let listing = executor.list("").await.unwrap();
    assert_eq!(listing.entries.len(), 2);
    assert!(listing.incomplete);
    assert_eq!(listing.omitted_entries, 3);
}
