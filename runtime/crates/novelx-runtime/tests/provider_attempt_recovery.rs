use novelx_protocol::ProviderRunIdentity;
use novelx_runtime::event_journal::{EventJournal, NewRuntimeEvent};
use novelx_runtime::provider_attempt::{
    ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptError,
    ProviderAttemptFailure, ProviderAttemptMetadata, ProviderAttemptRecovery, ProviderAttemptState,
    ProviderDeliveryCertainty, ProviderResponseReceipt,
};
use rusqlite::{Connection, params};
use tempfile::TempDir;
use uuid::Uuid;

const CONTEXT_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAYLOAD_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn requested_sent_responded_persists_and_recovers() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        let mut attempt = ProviderAttemptAggregate::create(
            &mut journal,
            "run-1",
            "attempt-1",
            definition("run-1", CONTEXT_HASH),
            0,
            metadata("message-1", "request-key-1"),
        )
        .unwrap();
        assert_eq!(attempt.state(), ProviderAttemptState::Requested);
        attempt
            .mark_sent(
                &mut journal,
                1,
                "dispatch-1",
                metadata("message-2", "sent-key-1"),
            )
            .unwrap();
        attempt
            .respond_with_output(
                &mut journal,
                2,
                response_receipt(),
                "provider output".to_owned(),
                metadata("message-3", "response-key-1"),
            )
            .unwrap();
    }

    let journal = fixture.open();
    let recovered = ProviderAttemptAggregate::recover(&journal, "run-1", "attempt-1").unwrap();
    assert_eq!(recovered.state(), ProviderAttemptState::Responded);
    assert_eq!(recovered.recovery(), ProviderAttemptRecovery::Completed);
    assert_eq!(recovered.aggregate_sequence(), 3);
    assert_eq!(recovered.response_text(), Some("provider output"));
    assert_eq!(recovered.response_text_sha256().map(str::len), Some(64));
    assert_eq!(
        event_types(&journal, "run-1", "attempt-1"),
        vec!["provider.requested", "provider.sent", "provider.responded"]
    );
}

#[test]
fn requested_can_fail_only_with_not_sent_certainty() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut attempt = ProviderAttemptAggregate::create(
        &mut journal,
        "run-1",
        "attempt-1",
        definition("run-1", CONTEXT_HASH),
        0,
        metadata("message-1", "request-key-1"),
    )
    .unwrap();
    attempt
        .fail(
            &mut journal,
            1,
            failure(ProviderDeliveryCertainty::NotSent, true),
            metadata("message-2", "failure-key-1"),
        )
        .unwrap();

    assert_eq!(attempt.state(), ProviderAttemptState::Failed);
    assert_eq!(attempt.recovery(), ProviderAttemptRecovery::RetryEligible);
}

#[test]
fn sent_can_fail_with_a_definitive_provider_response() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut attempt = ProviderAttemptAggregate::create(
        &mut journal,
        "run-1",
        "attempt-1",
        definition("run-1", CONTEXT_HASH),
        0,
        metadata("message-1", "request-key-1"),
    )
    .unwrap();
    attempt
        .mark_sent(
            &mut journal,
            1,
            "dispatch-1",
            metadata("message-2", "sent-key-1"),
        )
        .unwrap();
    attempt
        .fail(
            &mut journal,
            2,
            failure(ProviderDeliveryCertainty::ResponseReceived, true),
            metadata("message-3", "failure-key-1"),
        )
        .unwrap();

    assert_eq!(attempt.state(), ProviderAttemptState::Failed);
    assert_eq!(attempt.recovery(), ProviderAttemptRecovery::RetryEligible);
}

#[test]
fn sent_without_terminal_recovers_as_outcome_unknown() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        let mut attempt = ProviderAttemptAggregate::create(
            &mut journal,
            "run-1",
            "attempt-1",
            definition("run-1", CONTEXT_HASH),
            0,
            metadata("message-1", "request-key-1"),
        )
        .unwrap();
        attempt
            .mark_sent(
                &mut journal,
                1,
                "dispatch-1",
                metadata("message-2", "sent-key-1"),
            )
            .unwrap();
    }

    let journal = fixture.open();
    let recovered = ProviderAttemptAggregate::recover(&journal, "run-1", "attempt-1").unwrap();
    assert_eq!(recovered.state(), ProviderAttemptState::Sent);
    assert_eq!(
        recovered.recovery(),
        ProviderAttemptRecovery::OutcomeUnknown
    );
}

#[test]
fn unknown_version_duplicate_terminal_and_sequence_gap_are_rejected() {
    for case in ["unknown_version", "duplicate_terminal", "sequence_gap"] {
        let fixture = Fixture::new();
        {
            let mut journal = fixture.open();
            let mut attempt = ProviderAttemptAggregate::create(
                &mut journal,
                "run-1",
                "attempt-1",
                definition("run-1", CONTEXT_HASH),
                0,
                metadata("message-1", "request-key-1"),
            )
            .unwrap();
            if case != "sequence_gap" {
                attempt
                    .mark_sent(
                        &mut journal,
                        1,
                        "dispatch-1",
                        metadata("message-2", "sent-key-1"),
                    )
                    .unwrap();
            }
            match case {
                "unknown_version" => {
                    let payload = journal
                        .read_aggregate("run-1", "provider_attempt", "attempt-1", 0)
                        .unwrap()[1]
                        .payload
                        .clone();
                    journal
                        .append(
                            raw_event(
                                "provider.responded",
                                99,
                                payload,
                                "message-3",
                                "response-key-1",
                            ),
                            2,
                            2,
                        )
                        .unwrap();
                }
                "duplicate_terminal" => {
                    attempt
                        .respond_with_output(
                            &mut journal,
                            2,
                            response_receipt(),
                            "provider output".to_owned(),
                            metadata("message-3", "response-key-1"),
                        )
                        .unwrap();
                    let error = attempt
                        .fail(
                            &mut journal,
                            3,
                            failure(ProviderDeliveryCertainty::ResponseReceived, false),
                            metadata("message-4", "failure-key-1"),
                        )
                        .unwrap_err();
                    assert!(matches!(error, ProviderAttemptError::TerminalState { .. }));
                    continue;
                }
                "sequence_gap" => {}
                _ => unreachable!(),
            }
        }
        if case == "sequence_gap" {
            let connection = Connection::open(&fixture.path).unwrap();
            connection
                .execute(
                    "INSERT INTO runtime_events (
                        run_id, run_sequence, aggregate_type, aggregate_id, aggregate_sequence,
                        message_id, idempotency_key, event_type, event_version, payload_json, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        "run-1", 2_i64, "provider_attempt", "attempt-1", 3_i64,
                        "message-gap", "sent-gap-key", "provider.sent", 1_i64,
                        "{}", "2026-07-12T00:00:01Z"
                    ],
                )
                .unwrap();
        }

        let journal = fixture.open();
        assert!(
            ProviderAttemptAggregate::recover(&journal, "run-1", "attempt-1").is_err(),
            "{case} must fail closed"
        );
    }
}

#[test]
fn successful_response_requires_recoverable_bounded_output_and_response_identity() {
    for case in [
        "empty_output",
        "oversized_output",
        "missing_response_id",
        "empty_response_id",
    ] {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        let mut attempt = ProviderAttemptAggregate::create(
            &mut journal,
            "run-1",
            "attempt-1",
            definition("run-1", CONTEXT_HASH),
            0,
            metadata("message-1", "request-key-1"),
        )
        .unwrap();
        attempt
            .mark_sent(
                &mut journal,
                1,
                "dispatch-1",
                metadata("message-2", "sent-key-1"),
            )
            .unwrap();
        let mut receipt = response_receipt();
        let output = match case {
            "empty_output" => "   ".to_owned(),
            "oversized_output" => "x".repeat(1_048_577),
            "missing_response_id" => {
                receipt.response_id_sha256 = None;
                "provider output".to_owned()
            }
            "empty_response_id" => {
                receipt.response_id_sha256 = Some(String::new());
                "provider output".to_owned()
            }
            _ => unreachable!(),
        };
        assert!(matches!(
            attempt.respond_with_output(
                &mut journal,
                2,
                receipt,
                output,
                metadata("message-3", "response-key-1"),
            ),
            Err(ProviderAttemptError::ResponseInvalid)
        ));
        assert_eq!(attempt.state(), ProviderAttemptState::Sent);
        assert_eq!(event_types(&journal, "run-1", "attempt-1").len(), 2);
    }
}

#[test]
fn recovery_rejects_response_text_whose_independent_hash_does_not_match() {
    let fixture = Fixture::new();
    {
        let mut journal = fixture.open();
        let mut attempt = ProviderAttemptAggregate::create(
            &mut journal,
            "run-1",
            "attempt-1",
            definition("run-1", CONTEXT_HASH),
            0,
            metadata("message-1", "request-key-1"),
        )
        .unwrap();
        attempt
            .mark_sent(
                &mut journal,
                1,
                "dispatch-1",
                metadata("message-2", "sent-key-1"),
            )
            .unwrap();
        journal
            .append(
                raw_event(
                    "provider.responded",
                    1,
                    serde_json::json!({
                        "kind": "responded",
                        "definition": definition("run-1", CONTEXT_HASH),
                        "response": response_receipt(),
                        "response_text": "provider output",
                        "response_text_sha256": "0".repeat(64),
                    }),
                    "message-3",
                    "response-key-1",
                ),
                2,
                2,
            )
            .unwrap();
    }
    let journal = fixture.open();
    let result = ProviderAttemptAggregate::recover(&journal, "run-1", "attempt-1");
    assert!(
        matches!(result, Err(ProviderAttemptError::ResponseInvalid)),
        "unexpected recovery result: {result:?}"
    );
}

#[test]
fn idempotent_retry_returns_original_and_cross_run_or_context_conflicts() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let original = ProviderAttemptAggregate::create(
        &mut journal,
        "run-1",
        "attempt-1",
        definition("run-1", CONTEXT_HASH),
        0,
        metadata("message-1", "request-key-1"),
    )
    .unwrap();
    let retried = ProviderAttemptAggregate::create(
        &mut journal,
        "run-1",
        "attempt-1",
        definition("run-1", CONTEXT_HASH),
        0,
        metadata("message-retry", "request-key-1"),
    )
    .unwrap();
    assert_eq!(retried, original);
    assert_eq!(event_types(&journal, "run-1", "attempt-1").len(), 1);

    let changed_context = ProviderAttemptAggregate::create(
        &mut journal,
        "run-1",
        "attempt-1",
        definition("run-1", &"c".repeat(64)),
        0,
        metadata("message-2", "request-key-1"),
    )
    .unwrap_err();
    assert!(matches!(
        changed_context,
        ProviderAttemptError::IdentityConflict | ProviderAttemptError::Journal(_)
    ));

    let cross_run = ProviderAttemptAggregate::create(
        &mut journal,
        "run-2",
        "attempt-1",
        definition("run-1", CONTEXT_HASH),
        0,
        metadata("message-3", "request-key-1"),
    )
    .unwrap_err();
    assert!(matches!(cross_run, ProviderAttemptError::IdentityConflict));
}

fn definition(run_id: &str, context_hash: &str) -> ProviderAttemptDefinition {
    ProviderAttemptDefinition {
        run_id: run_id.to_owned(),
        inference_id: "inference-1".to_owned(),
        invocation_id: "run-1:steward".to_owned(),
        context_compilation_id: Uuid::parse_str("b9e9b829-ff90-4e16-b4ee-23ff66a7d9ce").unwrap(),
        canonical_context_sha256: context_hash.to_owned(),
        transport_payload_sha256: PAYLOAD_HASH.to_owned(),
        provider: ProviderRunIdentity {
            profile_id: "profile-1".to_owned(),
            provider_id: "deepseek".to_owned(),
            model_id: "deepseek-chat".to_owned(),
            config_sha256: "d".repeat(64),
        },
        request_number: 1,
        attempt_number: 1,
        output_reserve_tokens: 8_192,
        request_timeout_ms: 30_000,
        total_deadline_ms: 120_000,
        max_attempts: 3,
        max_total_delay_ms: 30_000,
    }
}

fn response_receipt() -> ProviderResponseReceipt {
    ProviderResponseReceipt {
        http_status: 200,
        actual_provider_id: "deepseek".to_owned(),
        actual_model_id: "deepseek-chat".to_owned(),
        response_id_sha256: Some("e".repeat(64)),
        response_body_sha256: "f".repeat(64),
        stop_reason: "stop".to_owned(),
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
    }
}

fn failure(certainty: ProviderDeliveryCertainty, retryable: bool) -> ProviderAttemptFailure {
    ProviderAttemptFailure {
        code: "PROVIDER_RATE_LIMITED".to_owned(),
        retryable,
        retry_after_ms: retryable.then_some(1_000),
        http_status: (certainty == ProviderDeliveryCertainty::ResponseReceived).then_some(429),
        delivery_certainty: certainty,
        diagnostic_id: Uuid::new_v4(),
    }
}

fn metadata<'a>(message_id: &'a str, idempotency_key: &'a str) -> ProviderAttemptMetadata<'a> {
    ProviderAttemptMetadata {
        message_id,
        idempotency_key,
        created_at: "2026-07-12T00:00:00Z",
        reason: None,
    }
}

fn raw_event(
    event_type: &str,
    event_version: u32,
    payload: serde_json::Value,
    message_id: &str,
    idempotency_key: &str,
) -> NewRuntimeEvent {
    NewRuntimeEvent {
        run_id: "run-1".to_owned(),
        aggregate_type: "provider_attempt".to_owned(),
        aggregate_id: "attempt-1".to_owned(),
        message_id: message_id.to_owned(),
        idempotency_key: idempotency_key.to_owned(),
        event_type: event_type.to_owned(),
        event_version,
        payload,
        created_at: "2026-07-12T00:00:01Z".to_owned(),
    }
}

fn event_types(journal: &EventJournal, run_id: &str, attempt_id: &str) -> Vec<String> {
    journal
        .read_aggregate(run_id, "provider_attempt", attempt_id, 0)
        .unwrap()
        .iter()
        .map(|event| event.event_type.clone())
        .collect()
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
}
