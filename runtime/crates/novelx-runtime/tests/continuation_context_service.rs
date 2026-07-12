mod support;

use novelx_protocol::{
    ContextCompile, ContextDisclosure, ContextItem, ContextMessageRole, ContextRuntimeExchangeKind,
    ProviderRunIdentity, RunPrepare, RunStart,
};
use novelx_runtime::agent_loop_service::{ContextCompileIntent, RuntimeExchangeIntent};
use novelx_runtime::context_compile_service::{ContextCompileService, ContextCompileServiceError};
use novelx_runtime::continuation_context_service::{
    ContinuationContextService, ContinuationContextServiceError,
};
use novelx_runtime::event_journal::EventJournal;
use novelx_runtime::provider_gateway::{
    ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderInputCapability,
    ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
};
use novelx_runtime::run_command_service::{RunCommandService, WorkspaceBinding};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn appends_multiple_chinese_tool_exchanges_and_persists_a_real_compilation() {
    let fixture = Fixture::new(1_000_000);
    let (run_id, providers, base) = fixture.seed();
    let mut journal = fixture.open();
    let base_receipt = ContextCompileService::new(&mut journal, &providers)
        .compile(run_id, Uuid::new_v4(), base)
        .unwrap();
    let intent = continuation_intent();

    let receipt = ContinuationContextService::new(&mut journal, &providers)
        .apply(run_id, Uuid::new_v4(), base_receipt.compilation_id, &intent)
        .unwrap();

    assert!(receipt.accepted);
    assert_eq!(receipt.request_number, 2);
    let event = context_event(&journal, run_id, 2);
    let messages = event.payload["normalizedInput"]["messages"]
        .as_array()
        .unwrap();
    let assistant = messages
        .iter()
        .find(|message| message.get("tool_calls").is_some())
        .unwrap();
    assert_eq!(assistant["tool_calls"].as_array().unwrap().len(), 2);
    assert_eq!(assistant["tool_calls"][0]["id"], "provider-call-1");
    assert_eq!(assistant["tool_calls"][1]["id"], "provider-call-2");
    let results = messages
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 2);
    assert!(
        results
            .iter()
            .any(|message| message["content"].as_str().unwrap().contains("银湾海岸"))
    );
    assert!(event.payload.get("sourceCommand").is_some());
}

#[test]
fn oversized_required_tool_result_fails_through_the_context_compiler_without_writing() {
    let fixture = Fixture::new(8_192);
    let (run_id, providers, base) = fixture.seed();
    let mut journal = fixture.open();
    let base_receipt = ContextCompileService::new(&mut journal, &providers)
        .compile(run_id, Uuid::new_v4(), base)
        .unwrap();
    let mut intent = continuation_intent();
    let huge = json!({ "content": "世界资料".repeat(20_000) });
    let result = intent
        .exchanges
        .iter_mut()
        .find(|exchange| exchange.kind == ContextRuntimeExchangeKind::ToolResult)
        .unwrap();
    result.content["result"] = huge.clone();
    result.content["resultSha256"] = Value::String(hash_json(&huge));
    result.content_sha256 = hash_json(&result.content);

    let error = ContinuationContextService::new(&mut journal, &providers)
        .apply(run_id, Uuid::new_v4(), base_receipt.compilation_id, &intent)
        .unwrap_err();

    assert!(matches!(
        error,
        ContinuationContextServiceError::Compile(ContextCompileServiceError::Compiler(_))
    ));
    assert!(context_events(&journal, run_id, 2).is_empty());
}

#[test]
fn retry_after_restart_returns_the_same_compilation_without_a_second_event() {
    let fixture = Fixture::new(1_000_000);
    let (run_id, providers, base) = fixture.seed();
    let base_receipt = {
        let mut journal = fixture.open();
        ContextCompileService::new(&mut journal, &providers)
            .compile(run_id, Uuid::new_v4(), base)
            .unwrap()
    };
    let intent = continuation_intent();
    let first = {
        let mut journal = fixture.open();
        ContinuationContextService::new(&mut journal, &providers)
            .apply(run_id, Uuid::new_v4(), base_receipt.compilation_id, &intent)
            .unwrap()
    };
    let (retried, count) = {
        let mut journal = fixture.open();
        let retried = ContinuationContextService::new(&mut journal, &providers)
            .apply(run_id, Uuid::new_v4(), base_receipt.compilation_id, &intent)
            .unwrap();
        (retried, context_events(&journal, run_id, 2).len())
    };

    assert_eq!(retried, first);
    assert_eq!(count, 1);
}

fn continuation_intent() -> ContextCompileIntent {
    let assistant_message_id = "22222222-2222-4222-8222-000000000001".to_owned();
    let calls = [
        (
            "provider-call-1",
            "read_project_file",
            json!({ "path": "世界.md" }),
        ),
        (
            "provider-call-2",
            "stat_project_file",
            json!({ "path": "世界.md" }),
        ),
    ];
    let mut exchanges = calls
        .iter()
        .map(|(id, name, arguments)| {
            exchange(
                ContextRuntimeExchangeKind::ToolCall,
                json!({
                    "assistantMessageId": assistant_message_id,
                    "providerToolCallId": id,
                    "toolName": name,
                    "arguments": arguments,
                    "argumentsSha256": hash_json(arguments),
                }),
            )
        })
        .collect::<Vec<_>>();
    exchanges.extend([
        exchange(
            ContextRuntimeExchangeKind::ToolResult,
            result(
                "provider-call-1",
                "read_project_file",
                json!({ "content": "银湾海岸", "complete": true }),
                false,
            ),
        ),
        exchange(
            ContextRuntimeExchangeKind::ToolResult,
            result(
                "provider-call-2",
                "stat_project_file",
                json!({ "kind": "file", "size": 18 }),
                false,
            ),
        ),
    ]);
    ContextCompileIntent {
        round: 1,
        request_number: 2,
        assistant_message_id,
        exchanges,
    }
}

fn result(id: &str, name: &str, value: Value, is_error: bool) -> Value {
    json!({
        "providerToolCallId": id,
        "toolName": name,
        "resultSha256": hash_json(&value),
        "result": value,
        "isError": is_error,
    })
}

fn exchange(kind: ContextRuntimeExchangeKind, content: Value) -> RuntimeExchangeIntent {
    RuntimeExchangeIntent {
        kind,
        content_sha256: hash_json(&content),
        content,
    }
}

fn hash_json(value: &Value) -> String {
    hash(&serde_json::to_vec(value).unwrap())
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn context_event(
    journal: &EventJournal,
    run_id: Uuid,
    request_number: u64,
) -> novelx_runtime::event_journal::RuntimeEvent {
    context_events(journal, run_id, request_number).remove(0)
}

fn context_events(
    journal: &EventJournal,
    run_id: Uuid,
    request_number: u64,
) -> Vec<novelx_runtime::event_journal::RuntimeEvent> {
    journal
        .read_aggregate(
            &run_id.to_string(),
            "context",
            &format!("steward-1:{request_number}"),
            0,
        )
        .unwrap()
}

struct Fixture {
    _temp: TempDir,
    database_path: std::path::PathBuf,
    context_window: u64,
}

impl Fixture {
    fn new(context_window: u64) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let database_path = temp.path().join("runtime.db");
        Self {
            _temp: temp,
            database_path,
            context_window,
        }
    }

    fn open(&self) -> EventJournal {
        EventJournal::open(&self.database_path).unwrap()
    }

    fn seed(&self) -> (Uuid, ProviderRegistry, ContextCompile) {
        let config = provider_config(self.context_window);
        let config_hash = provider_config_sha256(&config).unwrap();
        let mut identity = pinned_identity();
        identity.provider.config_sha256 = config_hash.clone();
        let run_id = Uuid::new_v4();
        let mut providers = ProviderRegistry::default();
        providers
            .bind(config, &config_hash, "secret".to_owned())
            .unwrap();
        let mut journal = Some(self.open());
        let binding = WorkspaceBinding {
            project_id: "project-1".to_owned(),
            workspace_id: "workspace-1".to_owned(),
        };
        let mut runs = RunCommandService::new(&mut journal, Some(&binding));
        runs.start(
            run_id,
            Uuid::new_v4(),
            RunStart {
                start_idempotency_key: "start-1".to_owned(),
                pinned_identity: identity.clone(),
            },
        )
        .unwrap();
        runs.prepare(
            run_id,
            Uuid::new_v4(),
            RunPrepare {
                prepare_idempotency_key: "prepare-1".to_owned(),
            },
            &providers,
        )
        .unwrap();
        drop(journal);
        (
            run_id,
            providers,
            base_command(
                identity.provider,
                identity.context_policy,
                self.context_window,
            ),
        )
    }
}

fn base_command(
    provider: ProviderRunIdentity,
    context_policy: novelx_protocol::VersionedPolicyIdentity,
    context_window: u64,
) -> ContextCompile {
    let system = "遵守世界规则并引用真实资料。";
    let user = "继续检查银湾海岸。";
    ContextCompile {
        compile_idempotency_key: "base-context-1".to_owned(),
        invocation_id: "steward-1".to_owned(),
        request_number: 1,
        provider,
        context_policy,
        compiler_version: "1.0.0".to_owned(),
        context_window,
        configured_max_output_tokens: Some(1_024),
        safety_reserve_tokens: 1_024,
        items: vec![
            ContextItem::SystemPrompt {
                item_id: "system-1".to_owned(),
                content: system.to_owned(),
                content_sha256: hash(system.as_bytes()),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            ContextItem::SessionMessage {
                item_id: "user-1".to_owned(),
                message_id: "message-1".to_owned(),
                role: ContextMessageRole::User,
                content: user.to_owned(),
                content_sha256: hash(user.as_bytes()),
                created_at: "2026-07-12T00:00:00Z".to_owned(),
                disclosure: ContextDisclosure::ProjectPrivate,
                required: true,
            },
            ContextItem::OutputReserve {
                item_id: "reserve-1".to_owned(),
                requested_tokens: 1_024,
                policy_id: "fixed".to_owned(),
                disclosure: ContextDisclosure::AgentInternal,
            },
        ],
    }
}

fn provider_config(context_window: u64) -> ProviderConfig {
    ProviderConfig {
        schema_version: 1,
        profile_id: "profile-1".to_owned(),
        provider_id: "deepseek".to_owned(),
        display_name: "DeepSeek".to_owned(),
        base_url: "https://api.deepseek.com/v1".to_owned(),
        model_id: "deepseek-chat".to_owned(),
        api_flavor: ProviderApiFlavor::OpenAiChatCompletions,
        auth_scheme: ProviderAuthScheme::Bearer,
        context_window,
        max_tokens: Some(1_024),
        reasoning: false,
        input: vec![ProviderInputCapability::Text],
        request_timeout_ms: 30_000,
        total_deadline_ms: 120_000,
        retry_policy: ProviderRetryPolicy {
            max_attempts: 3,
            max_total_delay_ms: 30_000,
        },
    }
}
