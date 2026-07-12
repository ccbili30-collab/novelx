mod support;

use novelx_protocol::{
    ContextCompile, ContextDisclosure, ContextItem, ContextMessageRole, ContextRuntimeExchangeKind,
    ContextSourceKind, RunPrepare, RunStart, TokenizerKind,
};
use novelx_runtime::context_compile_service::{ContextCompileService, ContextCompileServiceError};
use novelx_runtime::event_journal::EventJournal;
use novelx_runtime::provider_gateway::{
    ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderInputCapability,
    ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
};
use novelx_runtime::run_command_service::{RunCommandService, WorkspaceBinding};
use sha2::{Digest, Sha256};
use support::pinned_identity;
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn exact_provider_and_pinned_policy_compile_persists_context_event() {
    let fixture = Fixture::new();
    let (run_id, providers, command) = fixture.seed();
    let mut journal = fixture.open();

    let receipt = ContextCompileService::new(&mut journal, &providers)
        .compile(run_id, Uuid::new_v4(), command.clone())
        .unwrap();

    assert!(receipt.accepted);
    assert_eq!(receipt.request_number, command.request_number);
    assert_eq!(receipt.context_window, command.context_window);
    assert_eq!(receipt.compiler_version, command.compiler_version);
    assert_eq!(receipt.tokenizer.kind, TokenizerKind::FallbackEstimate);
    assert_eq!(
        receipt.tokenizer.provider_id.as_deref(),
        Some(command.provider.provider_id.as_str())
    );
    assert_eq!(
        receipt.tokenizer.model_id.as_deref(),
        Some(command.provider.model_id.as_str())
    );

    let events = context_events(&journal, run_id, &command);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type, "context.compiled");
    assert_eq!(events[0].event_version, 1);
    assert_eq!(events[0].idempotency_key, command.compile_idempotency_key);
    assert_eq!(
        events[0].payload["receipt"]["compilationId"],
        receipt.compilation_id.to_string()
    );
    assert_eq!(
        events[0].payload["normalizedInput"]["messages"][0]["role"],
        "system"
    );
    assert_eq!(
        events[0].payload["normalizedInput"]["messages"][1]["content"],
        "Continue the coastline discussion."
    );
    assert_eq!(
        events[0].payload["normalizedInputSha256"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(journal.read_run(&run_id.to_string(), 0).unwrap().len(), 3);
}

#[test]
fn identical_retry_after_reopen_returns_same_receipt_without_new_event() {
    let fixture = Fixture::new();
    let (run_id, providers, command) = fixture.seed();
    let first = {
        let mut journal = fixture.open();
        ContextCompileService::new(&mut journal, &providers)
            .compile(run_id, Uuid::new_v4(), command.clone())
            .unwrap()
    };

    let (retried, context_count, run_count) = {
        let mut journal = fixture.open();
        let retried = ContextCompileService::new(&mut journal, &providers)
            .compile(run_id, Uuid::new_v4(), command.clone())
            .unwrap();
        (
            retried,
            context_events(&journal, run_id, &command).len(),
            journal.read_run(&run_id.to_string(), 0).unwrap().len(),
        )
    };

    assert_eq!(retried, first);
    assert_eq!(context_count, 1);
    assert_eq!(run_count, 3);
}

#[test]
fn same_aggregate_rejects_changed_input_or_idempotency_key_without_writing() {
    for mutation in ["input", "key"] {
        let fixture = Fixture::new();
        let (run_id, providers, command) = fixture.seed();
        let mut journal = fixture.open();
        ContextCompileService::new(&mut journal, &providers)
            .compile(run_id, Uuid::new_v4(), command.clone())
            .unwrap();
        let mut conflicting = command.clone();
        match mutation {
            "input" => {
                conflicting.items[1] = session_item("A different user turn");
            }
            "key" => conflicting.compile_idempotency_key = "compile-key-2".to_owned(),
            _ => unreachable!(),
        }

        let error = ContextCompileService::new(&mut journal, &providers)
            .compile(run_id, Uuid::new_v4(), conflicting)
            .unwrap_err();

        assert!(matches!(
            error,
            ContextCompileServiceError::IdempotencyConflict
        ));
        assert_eq!(context_events(&journal, run_id, &command).len(), 1);
        assert_eq!(journal.read_run(&run_id.to_string(), 0).unwrap().len(), 3);
    }
}

#[test]
fn provider_capability_or_context_policy_mismatch_writes_nothing() {
    for mutation in ["capability", "policy"] {
        let fixture = Fixture::new();
        let (run_id, providers, mut command) = fixture.seed();
        match mutation {
            "capability" => command.context_window -= 1,
            "policy" => command.context_policy.version = "2.0.0".to_owned(),
            _ => unreachable!(),
        }
        let mut journal = fixture.open();

        let error = ContextCompileService::new(&mut journal, &providers)
            .compile(run_id, Uuid::new_v4(), command.clone())
            .unwrap_err();

        match mutation {
            "capability" => assert!(matches!(
                error,
                ContextCompileServiceError::ProviderCapabilityMismatch
            )),
            "policy" => assert!(matches!(
                error,
                ContextCompileServiceError::PinnedIdentityMismatch
            )),
            _ => unreachable!(),
        }
        assert_no_context_write(&journal, run_id, &command);
    }
}

#[test]
fn content_hash_mismatch_writes_nothing() {
    let fixture = Fixture::new();
    let (run_id, providers, mut command) = fixture.seed();
    if let ContextItem::SystemPrompt { content_sha256, .. } = &mut command.items[0] {
        *content_sha256 = "0".repeat(64);
    } else {
        unreachable!();
    }
    let mut journal = fixture.open();

    let error = ContextCompileService::new(&mut journal, &providers)
        .compile(run_id, Uuid::new_v4(), command.clone())
        .unwrap_err();

    assert!(matches!(
        error,
        ContextCompileServiceError::InvalidInput("content_sha256")
    ));
    assert_no_context_write(&journal, run_id, &command);
}

#[test]
fn created_run_cannot_bypass_provider_preparation() {
    let fixture = Fixture::new();
    let (run_id, providers, command) = fixture.seed_created();
    let mut journal = fixture.open();

    let error = ContextCompileService::new(&mut journal, &providers)
        .compile(run_id, Uuid::new_v4(), command.clone())
        .unwrap_err();

    assert!(matches!(error, ContextCompileServiceError::RunStateInvalid));
    assert!(context_events(&journal, run_id, &command).is_empty());
    assert_eq!(journal.read_run(&run_id.to_string(), 0).unwrap().len(), 1);
}

#[test]
fn included_partial_source_marks_receipt_incomplete() {
    let fixture = Fixture::new();
    let (run_id, providers, mut command) = fixture.seed();
    let source = "Only the first stable range.";
    command.items.push(ContextItem::RetrievalSource {
        item_id: "source-partial".to_owned(),
        source_receipt_id: "source-receipt-1".to_owned(),
        source_kind: ContextSourceKind::Document,
        stable_version_id: "document-version-1".to_owned(),
        content: source.to_owned(),
        content_sha256: sha256(source.as_bytes()),
        complete: false,
        disclosure: ContextDisclosure::ProjectPrivate,
        required: true,
    });
    let mut journal = fixture.open();

    let receipt = ContextCompileService::new(&mut journal, &providers)
        .compile(run_id, Uuid::new_v4(), command)
        .unwrap();

    assert!(receipt.incomplete);
    assert!(receipt.omitted_item_ids.is_empty());
}

#[test]
fn persists_openai_compatible_assistant_tool_calls_and_correlated_tool_results() {
    let fixture = Fixture::new();
    let (run_id, providers, mut command) = fixture.seed();
    command.items.push(runtime_exchange(
        "optional-runtime-history-too-large",
        ContextRuntimeExchangeKind::AssistantMessage,
        serde_json::json!({ "text": "旧对话".repeat(400_000) }),
        false,
    ));
    command.items.push(runtime_exchange(
        "tool-call-1",
        ContextRuntimeExchangeKind::ToolCall,
        serde_json::json!({
            "assistantMessageId": "assistant-tool-turn-1",
            "providerToolCallId": "call-1",
            "toolName": "read_project_file",
            "arguments": { "path": "设定/海岸线.md", "offsetChars": 0, "maxChars": 4000 },
            "argumentsSha256": sha256(serde_json::to_string(&serde_json::json!({
                "path": "设定/海岸线.md", "offsetChars": 0, "maxChars": 4000
            })).unwrap().as_bytes()),
        }),
        false,
    ));
    command.items.push(runtime_exchange(
        "tool-call-2",
        ContextRuntimeExchangeKind::ToolCall,
        serde_json::json!({
            "assistantMessageId": "assistant-tool-turn-1",
            "providerToolCallId": "call-2",
            "toolName": "stat_project_file",
            "arguments": { "path": "设定/海岸线.md" },
            "argumentsSha256": sha256(serde_json::to_string(&serde_json::json!({
                "path": "设定/海岸线.md"
            })).unwrap().as_bytes()),
        }),
        false,
    ));
    command.items.push(runtime_exchange(
        "tool-result-1",
        ContextRuntimeExchangeKind::ToolResult,
        serde_json::json!({
            "providerToolCallId": "call-1",
            "toolName": "read_project_file",
            "result": { "content": "银湾海岸", "complete": true },
            "resultSha256": sha256(serde_json::to_string(&serde_json::json!({
                "content": "银湾海岸", "complete": true
            })).unwrap().as_bytes()),
            "isError": false,
        }),
        false,
    ));
    command.items.push(runtime_exchange(
        "tool-result-2",
        ContextRuntimeExchangeKind::ToolResult,
        serde_json::json!({
            "providerToolCallId": "call-2",
            "toolName": "stat_project_file",
            "result": { "kind": "file", "size": 18 },
            "resultSha256": sha256(serde_json::to_string(&serde_json::json!({
                "kind": "file", "size": 18
            })).unwrap().as_bytes()),
            "isError": false,
        }),
        false,
    ));
    let mut journal = fixture.open();

    ContextCompileService::new(&mut journal, &providers)
        .compile(run_id, Uuid::new_v4(), command.clone())
        .unwrap();

    let event = context_events(&journal, run_id, &command).remove(0);
    assert!(event.payload["receipt"]["incomplete"].as_bool().unwrap());
    assert!(
        event.payload["receipt"]["omittedItemIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "optional-runtime-history-too-large")
    );
    let messages = event.payload["normalizedInput"]["messages"]
        .as_array()
        .unwrap();
    let assistant = messages
        .iter()
        .find(|message| message["role"] == "assistant" && message.get("tool_calls").is_some())
        .unwrap();
    assert_eq!(assistant["content"], "");
    assert_eq!(assistant["tool_calls"][0]["id"], "call-1");
    assert_eq!(assistant["tool_calls"][0]["type"], "function");
    assert_eq!(
        assistant["tool_calls"][0]["function"]["name"],
        "read_project_file"
    );
    assert_eq!(
        assistant["tool_calls"][0]["function"]["arguments"],
        serde_json::to_string(&serde_json::json!({
            "path": "设定/海岸线.md", "offsetChars": 0, "maxChars": 4000
        }))
        .unwrap()
    );
    assert_eq!(assistant["tool_calls"][1]["id"], "call-2");
    assert_eq!(
        assistant["tool_calls"][1]["function"]["name"],
        "stat_project_file"
    );
    let results = messages
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 2);
    let result = results
        .iter()
        .find(|message| message["tool_call_id"] == "call-1")
        .unwrap();
    assert_eq!(result["tool_call_id"], "call-1");
    assert!(result.get("name").is_none());
    assert_eq!(
        result["content"],
        serde_json::to_string(&serde_json::json!({ "content": "银湾海岸", "complete": true }))
            .unwrap()
    );
    assert!(
        event.payload["receipt"]["includedItemIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "tool-call-1")
    );
    assert!(
        event.payload["receipt"]["includedItemIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "tool-result-1")
    );
    assert!(
        event.payload["receipt"]["includedItemIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "tool-call-2")
    );
    assert!(
        event.payload["receipt"]["includedItemIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "tool-result-2")
    );
}

#[test]
fn rejects_internal_tool_ids_when_the_persisted_provider_call_id_is_missing() {
    let fixture = Fixture::new();
    let (run_id, providers, mut command) = fixture.seed();
    command.items.push(runtime_exchange(
        "tool-call-without-provider-id",
        ContextRuntimeExchangeKind::ToolCall,
        serde_json::json!({
            "assistantMessageId": "assistant-tool-turn-1",
            "toolCallId": "internal-tool-aggregate-id",
            "toolName": "read_project_file",
            "arguments": { "path": "设定/海岸线.md" },
            "argumentsSha256": sha256(serde_json::to_string(&serde_json::json!({
                "path": "设定/海岸线.md"
            })).unwrap().as_bytes()),
        }),
        true,
    ));
    let mut journal = fixture.open();

    let error = ContextCompileService::new(&mut journal, &providers)
        .compile(run_id, Uuid::new_v4(), command.clone())
        .unwrap_err();

    assert!(matches!(
        error,
        ContextCompileServiceError::InvalidInput("providerToolCallId")
    ));
    assert!(context_events(&journal, run_id, &command).is_empty());
}

fn context_events(
    journal: &EventJournal,
    run_id: Uuid,
    command: &ContextCompile,
) -> Vec<novelx_runtime::event_journal::RuntimeEvent> {
    journal
        .read_aggregate(
            &run_id.to_string(),
            "context",
            &format!("{}:{}", command.invocation_id, command.request_number),
            0,
        )
        .unwrap()
}

fn assert_no_context_write(journal: &EventJournal, run_id: Uuid, command: &ContextCompile) {
    assert!(context_events(journal, run_id, command).is_empty());
    assert_eq!(journal.read_run(&run_id.to_string(), 0).unwrap().len(), 2);
}

fn session_item(content: &str) -> ContextItem {
    ContextItem::SessionMessage {
        item_id: "current-user-turn".to_owned(),
        message_id: "message-user-1".to_owned(),
        role: ContextMessageRole::User,
        content: content.to_owned(),
        content_sha256: sha256(content.as_bytes()),
        created_at: "2026-07-12T00:00:01Z".to_owned(),
        disclosure: ContextDisclosure::ProjectPrivate,
        required: true,
    }
}

fn runtime_exchange(
    item_id: &str,
    kind: ContextRuntimeExchangeKind,
    content: serde_json::Value,
    required: bool,
) -> ContextItem {
    ContextItem::RuntimeExchange {
        item_id: item_id.to_owned(),
        exchange_id: item_id.to_owned(),
        kind,
        content_sha256: sha256(serde_json::to_vec(&content).unwrap().as_slice()),
        content,
        disclosure: ContextDisclosure::AgentInternal,
        required,
    }
}

fn compile_command(identity: &novelx_protocol::RunPinnedIdentity) -> ContextCompile {
    let system_prompt = "Stay within the pinned project and cite stable sources.";
    ContextCompile {
        compile_idempotency_key: "compile-key-1".to_owned(),
        invocation_id: "run:steward".to_owned(),
        request_number: 1,
        provider: identity.provider.clone(),
        context_policy: identity.context_policy.clone(),
        compiler_version: "1.0.0".to_owned(),
        context_window: 1_000_000,
        configured_max_output_tokens: None,
        safety_reserve_tokens: 100_000,
        items: vec![
            ContextItem::SystemPrompt {
                item_id: "system-prompt".to_owned(),
                content: system_prompt.to_owned(),
                content_sha256: sha256(system_prompt.as_bytes()),
                disclosure: ContextDisclosure::AgentInternal,
                required: true,
            },
            session_item("Continue the coastline discussion."),
            ContextItem::OutputReserve {
                item_id: "output-reserve".to_owned(),
                requested_tokens: 32_768,
                policy_id: "auto-output-v1".to_owned(),
                disclosure: ContextDisclosure::AgentInternal,
            },
        ],
    }
}

fn provider_config() -> ProviderConfig {
    ProviderConfig {
        schema_version: 1,
        profile_id: "profile-1".to_owned(),
        provider_id: "deepseek".to_owned(),
        display_name: "DeepSeek".to_owned(),
        base_url: "https://api.deepseek.com/v1".to_owned(),
        model_id: "deepseek-chat".to_owned(),
        api_flavor: ProviderApiFlavor::OpenAiChatCompletions,
        auth_scheme: ProviderAuthScheme::Bearer,
        context_window: 1_000_000,
        max_tokens: None,
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

fn binding() -> WorkspaceBinding {
    WorkspaceBinding {
        project_id: "project-1".to_owned(),
        workspace_id: "workspace-1".to_owned(),
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct Fixture {
    _temp: TempDir,
    path: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        Self { _temp: temp, path }
    }

    fn open(&self) -> EventJournal {
        EventJournal::open(&self.path).unwrap()
    }

    fn seed(&self) -> (Uuid, ProviderRegistry, ContextCompile) {
        self.seed_with_prepare(true)
    }

    fn seed_created(&self) -> (Uuid, ProviderRegistry, ContextCompile) {
        self.seed_with_prepare(false)
    }

    fn seed_with_prepare(&self, prepare: bool) -> (Uuid, ProviderRegistry, ContextCompile) {
        let config = provider_config();
        let config_hash = provider_config_sha256(&config).unwrap();
        let mut identity = pinned_identity();
        identity.provider.config_sha256 = config_hash.clone();
        let run_id = Uuid::new_v4();
        let mut providers = ProviderRegistry::default();
        providers
            .bind(config, &config_hash, "secret".to_owned())
            .unwrap();
        let mut journal = Some(self.open());
        let workspace_binding = binding();
        let mut service = RunCommandService::new(&mut journal, Some(&workspace_binding));
        service
            .start(
                run_id,
                Uuid::new_v4(),
                RunStart {
                    start_idempotency_key: "start-key-1".to_owned(),
                    pinned_identity: identity.clone(),
                },
            )
            .unwrap();
        if prepare {
            service
                .prepare(
                    run_id,
                    Uuid::new_v4(),
                    RunPrepare {
                        prepare_idempotency_key: "prepare-key-1".to_owned(),
                    },
                    &providers,
                )
                .unwrap();
        }
        drop(journal);
        (run_id, providers, compile_command(&identity))
    }
}
