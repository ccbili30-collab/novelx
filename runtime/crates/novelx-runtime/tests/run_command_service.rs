mod support;

use novelx_protocol::{RunCancel, RunPrepare, RunStart};
use novelx_runtime::event_journal::{EventJournal, NewRuntimeEvent};
use novelx_runtime::provider_gateway::{
    ProviderApiFlavor, ProviderAuthScheme, ProviderConfig, ProviderInputCapability,
    ProviderRegistry, ProviderRetryPolicy, provider_config_sha256,
};
use novelx_runtime::run_aggregate::{EventMetadata, RunAggregate};
use novelx_runtime::run_command_service::{RunCommandService, WorkspaceBinding};
use novelx_runtime::workspace_runtime_lease::{BoundWorkspaceRuntimeLease, WorkspaceRuntimeLease};
use serde_json::json;
use support::pinned_identity;
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn start_and_get_return_the_same_journal_snapshot_after_reopening() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4();
    let first = {
        let mut journal = Some(fixture.open());
        RunCommandService::new(&mut journal, Some(&binding()))
            .start(run_id, Uuid::new_v4(), start_payload())
            .unwrap()
    };
    let recovered = {
        let mut journal = Some(fixture.open());
        RunCommandService::new(&mut journal, Some(&binding()))
            .get(run_id)
            .unwrap()
    };
    assert_eq!(recovered, first);
}

#[test]
fn workspace_mismatch_is_nonfatal_and_writes_nothing() {
    let fixture = Fixture::new();
    let mut journal = Some(fixture.open());
    let run_id = Uuid::new_v4();
    let mut payload = start_payload();
    payload.pinned_identity.project_id = "other-project".to_owned();

    let error = RunCommandService::new(&mut journal, Some(&binding()))
        .start(run_id, Uuid::new_v4(), payload)
        .unwrap_err();

    assert_eq!(error.error.code, "RUN_WORKSPACE_BINDING_CONFLICT");
    assert!(!error.fatal);
    assert!(
        journal
            .as_ref()
            .unwrap()
            .read_run(&run_id.to_string(), 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn corrupted_run_history_returns_a_fatal_failure() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4();
    let mut journal = fixture.open();
    RunAggregate::create(
        &mut journal,
        &run_id.to_string(),
        pinned_identity(),
        EventMetadata {
            message_id: "create-message",
            idempotency_key: "create-key",
            created_at: "2026-07-12T00:00:00Z",
            reason: None,
        },
    )
    .unwrap();
    journal
        .append(
            NewRuntimeEvent {
                run_id: run_id.to_string(),
                aggregate_type: "run".to_owned(),
                aggregate_id: run_id.to_string(),
                message_id: "bad-message".to_owned(),
                idempotency_key: "bad-key".to_owned(),
                event_type: "run.preparing".to_owned(),
                event_version: 99,
                payload: json!({
                    "previousState": "created",
                    "currentState": "preparing",
                    "reason": null,
                }),
                created_at: "2026-07-12T00:00:01Z".to_owned(),
            },
            1,
            1,
        )
        .unwrap();
    let mut journal = Some(journal);

    let error = RunCommandService::new(&mut journal, Some(&binding()))
        .get(run_id)
        .unwrap_err();

    assert_eq!(error.error.code, "RUN_JOURNAL_INTEGRITY_FAILED");
    assert!(error.fatal);
}

#[test]
fn cancellation_is_persisted_and_idempotent_across_transport_retries() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4();
    let mut journal = Some(fixture.open());
    let lease = fixture.lease("run-command-cancel");
    let workspace_binding = binding();
    let (first, retried) = {
        let mut service = RunCommandService::new(&mut journal, Some(&workspace_binding));
        service
            .start(run_id, Uuid::new_v4(), start_payload())
            .unwrap();
        let cancel = RunCancel {
            cancel_idempotency_key: "cancel-key-1".to_owned(),
            reason: "用户停止任务".to_owned(),
        };
        let first = service
            .cancel(run_id, Uuid::new_v4(), cancel.clone(), &lease)
            .unwrap();
        let retried = service
            .cancel(run_id, Uuid::new_v4(), cancel, &lease)
            .unwrap();
        (first, retried)
    };

    assert_eq!(first.state, novelx_protocol::RunLifecycleState::Cancelled);
    assert_eq!(
        first.recovery_classification,
        novelx_protocol::RunRecoveryClassification::Terminal
    );
    assert_eq!(retried, first);
    assert_eq!(
        journal
            .as_ref()
            .unwrap()
            .read_run(&run_id.to_string(), 0)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn missing_provider_is_persisted_as_a_structured_terminal_failure() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4();
    let mut journal = Some(fixture.open());
    let workspace_binding = binding();
    let failed = {
        let mut service = RunCommandService::new(&mut journal, Some(&workspace_binding));
        service
            .start(run_id, Uuid::new_v4(), start_payload())
            .unwrap();
        service
            .prepare(
                run_id,
                Uuid::new_v4(),
                RunPrepare {
                    prepare_idempotency_key: "prepare-key-1".to_owned(),
                },
                &ProviderRegistry::default(),
            )
            .unwrap()
    };

    assert_eq!(failed.state, novelx_protocol::RunLifecycleState::Failed);
    assert_eq!(
        failed
            .terminal_error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("REAL_GM_PROVIDER_REQUIRED")
    );
    drop(journal);
    let mut reopened = Some(fixture.open());
    let recovered = RunCommandService::new(&mut reopened, Some(&workspace_binding))
        .get(run_id)
        .unwrap();
    assert_eq!(recovered, failed);
}

#[test]
fn exact_bound_provider_prepares_once_and_retry_returns_the_same_snapshot() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4();
    let config = provider_config();
    let hash = provider_config_sha256(&config).unwrap();
    let mut payload = start_payload();
    payload.pinned_identity.provider.config_sha256 = hash.clone();
    let mut providers = ProviderRegistry::default();
    providers.bind(config, &hash, "secret".to_owned()).unwrap();
    let mut journal = Some(fixture.open());
    let workspace_binding = binding();
    let mut service = RunCommandService::new(&mut journal, Some(&workspace_binding));
    service.start(run_id, Uuid::new_v4(), payload).unwrap();
    let prepare = RunPrepare {
        prepare_idempotency_key: "prepare-key-1".to_owned(),
    };

    let first = service
        .prepare(run_id, Uuid::new_v4(), prepare.clone(), &providers)
        .unwrap();
    let retried = service
        .prepare(run_id, Uuid::new_v4(), prepare, &providers)
        .unwrap();

    assert_eq!(first.state, novelx_protocol::RunLifecycleState::Preparing);
    assert!(first.terminal_error.is_none());
    assert_eq!(retried, first);
}

#[test]
fn snapshot_projects_persisted_waiting_for_reconciliation_as_nonterminal() {
    let fixture = Fixture::new();
    let run_id = Uuid::new_v4();
    {
        let mut journal = fixture.open();
        let mut run = RunAggregate::create(
            &mut journal,
            &run_id.to_string(),
            pinned_identity(),
            EventMetadata {
                message_id: "create-message",
                idempotency_key: "create-key",
                created_at: "2026-07-12T00:00:00Z",
                reason: None,
            },
        )
        .unwrap();
        run.prepare(
            &mut journal,
            EventMetadata {
                message_id: "prepare-message",
                idempotency_key: "prepare-key",
                created_at: "2026-07-12T00:00:01Z",
                reason: None,
            },
        )
        .unwrap();
        run.start(
            &mut journal,
            EventMetadata {
                message_id: "start-message",
                idempotency_key: "start-key",
                created_at: "2026-07-12T00:00:02Z",
                reason: None,
            },
        )
        .unwrap();
        run.wait_for_reconciliation(
            &mut journal,
            EventMetadata {
                message_id: "reconciliation-message",
                idempotency_key: "reconciliation-key",
                created_at: "2026-07-12T00:00:03Z",
                reason: Some("provider outcome unknown"),
            },
        )
        .unwrap();
    }
    let mut journal = Some(fixture.open());
    let snapshot = RunCommandService::new(&mut journal, Some(&binding()))
        .get(run_id)
        .unwrap();
    assert_eq!(
        snapshot.state,
        novelx_protocol::RunLifecycleState::WaitingForReconciliation
    );
    assert_eq!(
        snapshot.recovery_classification,
        novelx_protocol::RunRecoveryClassification::WaitingForReconciliation
    );
    assert!(snapshot.terminal_error.is_none());
}

fn start_payload() -> RunStart {
    RunStart {
        start_idempotency_key: "stable-start-1".to_owned(),
        pinned_identity: pinned_identity(),
    }
}

fn binding() -> WorkspaceBinding {
    WorkspaceBinding {
        project_id: "project-1".to_owned(),
        workspace_id: "workspace-1".to_owned(),
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

    fn lease(&self, owner: &str) -> BoundWorkspaceRuntimeLease {
        WorkspaceRuntimeLease::acquire(&self.path, owner)
            .unwrap()
            .bind_database(&self.path)
            .unwrap()
    }
}
