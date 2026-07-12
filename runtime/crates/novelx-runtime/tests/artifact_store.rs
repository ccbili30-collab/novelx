use novelx_runtime::{artifact_store::ArtifactStore, event_journal::EventJournal};
use serde_json::json;
use tempfile::tempdir;
use uuid::Uuid;

#[test]
fn persists_unicode_json_and_returns_a_verified_receipt() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("workspace.db");
    EventJournal::open(&database).unwrap();
    let mut store = ArtifactStore::open(&database).unwrap();
    let artifact_id = Uuid::new_v4();
    let content = json!({"path": "世界观/海岸线.md", "query": "精灵为什么诞生"});

    let stored = store.put_json(artifact_id, "run-1", &content).unwrap();
    let recovered = store.get(artifact_id).unwrap().unwrap();

    assert_eq!(stored.receipt.media_type, "application/json");
    assert_eq!(stored.receipt.sha256.len(), 64);
    assert_eq!(stored.content, content);
    assert_eq!(recovered, stored);
}

#[test]
fn identical_replay_is_idempotent_but_conflicting_content_is_rejected() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("workspace.db");
    EventJournal::open(&database).unwrap();
    let mut store = ArtifactStore::open(&database).unwrap();
    let artifact_id = Uuid::new_v4();

    let first = store
        .put_json(artifact_id, "run-1", &json!({"path": "a.md"}))
        .unwrap();
    let replay = store
        .put_json(artifact_id, "run-1", &json!({"path": "a.md"}))
        .unwrap();
    assert_eq!(replay, first);

    let error = store
        .put_json(artifact_id, "run-1", &json!({"path": "b.md"}))
        .unwrap_err();
    assert!(error.to_string().contains("conflicts"));
}
