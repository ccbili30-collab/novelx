use novelx_protocol::ProviderInferenceToolCall;
use novelx_runtime::{
    artifact_store::ArtifactStore, event_journal::EventJournal,
    provider_tool_materializer::ProviderToolMaterializer,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::tempdir;

#[test]
fn persists_chinese_arguments_and_replays_stable_internal_identities() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("workspace.db");
    EventJournal::open(&database).unwrap();
    let arguments = json!({"path": "世界观/海岸线.md", "offsetChars": 0, "maxChars": 120000});
    let arguments_sha256 = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&arguments).unwrap())
    );
    let call = ProviderInferenceToolCall {
        id: "call_deepseek_1".to_owned(),
        name: "read_project_file".to_owned(),
        arguments,
        arguments_sha256,
    };

    let first = {
        let mut artifacts = ArtifactStore::open(&database).unwrap();
        ProviderToolMaterializer::new(&mut artifacts)
            .materialize(
                "run-1",
                "invocation-1",
                "inference-1",
                std::slice::from_ref(&call),
            )
            .unwrap()
    };
    let replay = {
        let mut artifacts = ArtifactStore::open(&database).unwrap();
        ProviderToolMaterializer::new(&mut artifacts)
            .materialize("run-1", "invocation-1", "inference-1", &[call])
            .unwrap()
    };

    assert_eq!(replay, first);
    assert_ne!(first[0].tool_call_id, first[0].arguments.artifact_id);
    let artifacts = ArtifactStore::open(&database).unwrap();
    let stored = artifacts
        .get(first[0].arguments.artifact_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.content["path"], "世界观/海岸线.md");
}

#[test]
fn rejects_tampered_argument_hash_before_persisting_anything() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("workspace.db");
    EventJournal::open(&database).unwrap();
    let mut artifacts = ArtifactStore::open(&database).unwrap();
    let call = ProviderInferenceToolCall {
        id: "call-1".to_owned(),
        name: "stat_project_file".to_owned(),
        arguments: json!({"path": "角色.md"}),
        arguments_sha256: "0".repeat(64),
    };

    let error = ProviderToolMaterializer::new(&mut artifacts)
        .materialize("run-1", "invocation-1", "inference-1", &[call])
        .unwrap_err();
    assert!(error.to_string().contains("SHA-256"));
}

#[test]
fn separates_reused_provider_ids_across_inferences_and_tool_names() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("workspace.db");
    EventJournal::open(&database).unwrap();
    let arguments = json!({"path": "world.md"});
    let arguments_sha256 = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&arguments).unwrap())
    );
    let call = ProviderInferenceToolCall {
        id: "reused-call-id".to_owned(),
        name: "stat_project_file".to_owned(),
        arguments: arguments.clone(),
        arguments_sha256: arguments_sha256.clone(),
    };
    let mut artifacts = ArtifactStore::open(&database).unwrap();
    let first = ProviderToolMaterializer::new(&mut artifacts)
        .materialize(
            "run-1",
            "invocation-1",
            "inference-1",
            std::slice::from_ref(&call),
        )
        .unwrap();
    let second = ProviderToolMaterializer::new(&mut artifacts)
        .materialize(
            "run-1",
            "invocation-1",
            "inference-2",
            std::slice::from_ref(&call),
        )
        .unwrap();
    let renamed = ProviderInferenceToolCall {
        name: "read_project_file".to_owned(),
        ..call
    };
    let third = ProviderToolMaterializer::new(&mut artifacts)
        .materialize("run-1", "invocation-1", "inference-1", &[renamed])
        .unwrap();

    assert_ne!(first[0].tool_call_id, second[0].tool_call_id);
    assert_ne!(first[0].tool_call_id, third[0].tool_call_id);
}
