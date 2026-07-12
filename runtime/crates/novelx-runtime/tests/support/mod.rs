use novelx_protocol::{
    ProviderRunIdentity, RunPermissionMode, RunPinnedIdentity, VersionedPolicyIdentity,
};
use sha2::{Digest, Sha256};

pub fn pinned_identity() -> RunPinnedIdentity {
    let policy = |id: &str, hash: char| VersionedPolicyIdentity {
        id: id.to_owned(),
        version: "1.0.0".to_owned(),
        sha256: hash.to_string().repeat(64),
    };
    let scope_resource_ids = vec!["resource-1".to_owned(), "resource-2".to_owned()];
    RunPinnedIdentity {
        project_id: "project-1".to_owned(),
        workspace_id: "workspace-1".to_owned(),
        session_id: "session-1".to_owned(),
        session_branch_id: "branch-1".to_owned(),
        user_message_id: "message-user-1".to_owned(),
        project_branch_id: "project-branch-1".to_owned(),
        goal: None,
        plan: None,
        assignment: None,
        parent_run_id: None,
        delegation_depth: 0,
        provider: ProviderRunIdentity {
            profile_id: "profile-1".to_owned(),
            provider_id: "deepseek".to_owned(),
            model_id: "deepseek-chat".to_owned(),
            config_sha256: "a".repeat(64),
        },
        prompt_bundle: policy("novelx.steward", 'b'),
        agent_profile: policy("novelx.agent.steward", 'c'),
        tool_policy: policy("novelx.tools", 'd'),
        context_policy: policy("novelx.context", 'e'),
        runtime_policy: policy("novelx.runtime", 'f'),
        runtime_contract_version: "1.0.0".to_owned(),
        mode: RunPermissionMode::Assist,
        source_checkpoint_id: "checkpoint-1".to_owned(),
        resource_scope_sha256: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&scope_resource_ids).unwrap())
        ),
        scope_resource_ids,
        user_input_sha256: "2".repeat(64),
    }
}
