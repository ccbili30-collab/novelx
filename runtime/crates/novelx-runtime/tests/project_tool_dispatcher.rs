use std::fs;

use novelx_runtime::{
    project_path::ProjectRoot,
    project_tool_dispatcher::{ProjectToolDispatchError, ProjectToolDispatcher},
};
use serde_json::json;
use tempfile::tempdir;

#[tokio::test]
async fn dispatches_all_five_read_only_tools_against_real_chinese_content() {
    let fixture = tempdir().unwrap();
    fs::create_dir(fixture.path().join("世界观")).unwrap();
    fs::write(
        fixture.path().join("世界观").join("海岸线.md"),
        "海岸由地壳沉降形成。\n精灵居住在曲折海湾。\n",
    )
    .unwrap();
    let root = ProjectRoot::open(fixture.path().to_str().unwrap()).unwrap();
    let dispatcher = ProjectToolDispatcher::new(root).unwrap();

    let listed = dispatcher
        .dispatch("list_project_directory", json!({"path": ""}))
        .await
        .unwrap();
    assert!(listed["entries"].as_array().unwrap().len() >= 2);
    let stat = dispatcher
        .dispatch("stat_project_file", json!({"path": "世界观/海岸线.md"}))
        .await
        .unwrap();
    assert_eq!(stat["kind"], "file");
    let read = dispatcher
        .dispatch(
            "read_project_file",
            json!({"path": "世界观/海岸线.md", "offsetChars": 0, "maxChars": 8}),
        )
        .await
        .unwrap();
    assert_eq!(read["content"], "海岸由地壳沉降形");
    let search = dispatcher
        .dispatch(
            "search_project_files",
            json!({"path": "世界观", "query": "精灵"}),
        )
        .await
        .unwrap();
    assert_eq!(search["matches"][0]["line"], 2);
    let glob = dispatcher
        .dispatch(
            "glob_project_files",
            json!({"path": "世界观", "pattern": "**/*.md"}),
        )
        .await
        .unwrap();
    assert_eq!(glob["paths"][0], "海岸线.md");
}

#[tokio::test]
async fn rejects_unknown_tools_unknown_arguments_and_project_escape() {
    let fixture = tempdir().unwrap();
    fs::write(fixture.path().join("world.md"), "world").unwrap();
    let root = ProjectRoot::open(fixture.path().to_str().unwrap()).unwrap();
    let dispatcher = ProjectToolDispatcher::new(root).unwrap();

    assert!(matches!(
        dispatcher.dispatch("shell", json!({})).await.unwrap_err(),
        ProjectToolDispatchError::UnsupportedTool(_)
    ));
    assert!(matches!(
        dispatcher
            .dispatch(
                "read_project_file",
                json!({"path": "world.md", "unexpected": true})
            )
            .await
            .unwrap_err(),
        ProjectToolDispatchError::InvalidArguments(_)
    ));
    assert!(
        dispatcher
            .dispatch("stat_project_file", json!({"path": "../outside.md"}))
            .await
            .is_err()
    );
}
