use std::fs;
use std::process::Command;

use novelx_runtime::project_path::{ProjectPathError, ProjectRoot};

#[test]
fn resolves_existing_project_files_beneath_the_bound_root() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("project");
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::write(root.join("docs").join("story.txt"), "story").unwrap();

    let project = ProjectRoot::open(root.to_str().unwrap()).unwrap();
    assert_eq!(
        project.resolve_existing("docs\\story.txt").unwrap(),
        fs::canonicalize(root.join("docs").join("story.txt")).unwrap()
    );
}

#[test]
fn rejects_absolute_parent_prefixed_and_managed_paths() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("project");
    fs::create_dir_all(&root).unwrap();
    let project = ProjectRoot::open(root.to_str().unwrap()).unwrap();

    for candidate in [
        "C:\\Windows\\win.ini",
        "\\\\server\\share\\file.txt",
        "\\rooted.txt",
        "..\\outside.txt",
        "docs\\..\\outside.txt",
        ".novax\\workspace.db",
        ".git\\config",
        "node_modules\\package\\index.js",
        "DOCS\\.GIT\\config",
    ] {
        assert!(
            matches!(
                project.resolve_existing(candidate),
                Err(ProjectPathError::PathRejected)
            ),
            "{candidate} must be rejected before filesystem access"
        );
    }
}

#[test]
fn rejects_junction_escape_outside_the_project_root() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("project");
    let outside = fixture.path().join("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "secret").unwrap();
    let junction = root.join("escape");
    let status = Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            junction.to_str().unwrap(),
            outside.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(status.success(), "Windows junction fixture must be created");

    let project = ProjectRoot::open(root.to_str().unwrap()).unwrap();
    assert!(matches!(
        project.resolve_existing("escape\\secret.txt"),
        Err(ProjectPathError::EscapesProjectRoot)
    ));
    assert!(matches!(
        project.resolve_for_create("escape\\new.txt"),
        Err(ProjectPathError::EscapesProjectRoot)
    ));
}
