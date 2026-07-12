use novelx_protocol::ProviderRunIdentity;
use novelx_runtime::{
    event_journal::{EventJournal, EventJournalError, NewRuntimeEvent},
    provider_attempt::{ProviderAttemptFailure, ProviderDeliveryCertainty},
    provider_retry_after::{ProviderRetryAfterKind, ProviderRetryAfterReceipt},
    provider_retry_aggregate::{
        ExponentialFullJitterPolicy, ProviderRetryAggregate, ProviderRetryAttemptEvidence,
        ProviderRetryDefinition, ProviderRetryError, ProviderRetryExhaustion,
        ProviderRetryExhaustionReason, ProviderRetryFailureObservation, ProviderRetryMetadata,
        ProviderRetryPolicyAlgorithm, ProviderRetryState, derive_retry_schedule,
        provider_retry_definition_sha256, provider_retry_failure_observation_sha256,
        provider_retry_policy_sha256, provider_retry_schedule_sha256,
    },
};
use rusqlite::{Connection, params};
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn first_definite_failure_creates_a_durable_retry_aggregate() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let definition = definition();
    let failure = failure_observation(
        definition.first_attempt_id,
        definition.first_attempt_number,
        3,
        "2026-07-13T00:00:01Z",
    );

    let aggregate = ProviderRetryAggregate::create(
        &mut journal,
        definition.clone(),
        failure.clone(),
        0,
        metadata("message-1", "retry:create"),
    )
    .unwrap();

    assert_eq!(aggregate.state(), ProviderRetryState::FailureObserved);
    assert_eq!(aggregate.definition(), &definition);
    assert_eq!(aggregate.failure_observation(), Some(&failure));
    assert_eq!(aggregate.aggregate_sequence(), 1);

    drop(journal);
    let journal = fixture.open();
    let recovered =
        ProviderRetryAggregate::recover(&journal, &definition.run_id, &definition.inference_id)
            .unwrap();
    assert_eq!(recovered, aggregate);
}

#[test]
fn retry_cycles_through_schedule_materialization_and_a_new_attempt_to_success() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let definition = definition();
    let first_failure = failure_observation(
        definition.first_attempt_id,
        definition.first_attempt_number,
        3,
        "2026-07-13T00:00:01Z",
    );
    let mut aggregate = ProviderRetryAggregate::create(
        &mut journal,
        definition.clone(),
        first_failure.clone(),
        0,
        metadata("message-1", "retry:create"),
    )
    .unwrap();

    let first_schedule =
        derive_retry_schedule(&definition, &first_failure, 0, "2026-07-13T00:00:01Z").unwrap();
    aggregate
        .schedule_retry(
            &mut journal,
            first_schedule.clone(),
            1,
            metadata("message-2", "retry:schedule:2"),
        )
        .unwrap();
    assert_eq!(aggregate.state(), ProviderRetryState::Scheduled);
    aggregate
        .begin_materializing(
            &mut journal,
            &first_schedule.not_before,
            2,
            metadata("message-3", "retry:materialize:2"),
        )
        .unwrap();
    assert_eq!(aggregate.state(), ProviderRetryState::Materializing);
    aggregate
        .mark_awaiting_attempt(
            &mut journal,
            &first_schedule.not_before,
            3,
            metadata("message-4", "retry:await:2"),
        )
        .unwrap();
    assert_eq!(aggregate.state(), ProviderRetryState::AwaitingAttempt);

    let second_failure = failure_observation(
        first_schedule.next_attempt_id,
        first_schedule.next_attempt_number,
        3,
        "2026-07-13T00:00:10Z",
    );
    aggregate
        .observe_retryable_failure(
            &mut journal,
            second_failure.clone(),
            4,
            metadata("message-5", "retry:failure:2"),
        )
        .unwrap();
    assert_eq!(aggregate.state(), ProviderRetryState::FailureObserved);
    assert_eq!(
        aggregate.cumulative_delay_ms(),
        first_schedule.selected_delay_ms
    );

    let second_schedule = derive_retry_schedule(
        &definition,
        &second_failure,
        first_schedule.cumulative_delay_ms,
        "2026-07-13T00:00:10Z",
    )
    .unwrap();
    aggregate
        .schedule_retry(
            &mut journal,
            second_schedule.clone(),
            5,
            metadata("message-6", "retry:schedule:3"),
        )
        .unwrap();
    aggregate
        .begin_materializing(
            &mut journal,
            &second_schedule.not_before,
            6,
            metadata("message-7", "retry:materialize:3"),
        )
        .unwrap();
    aggregate
        .mark_awaiting_attempt(
            &mut journal,
            &second_schedule.not_before,
            7,
            metadata("message-8", "retry:await:3"),
        )
        .unwrap();
    aggregate
        .mark_succeeded(
            &mut journal,
            attempt_evidence(&second_schedule, &second_schedule.not_before),
            8,
            metadata("message-9", "retry:succeeded:3"),
        )
        .unwrap();

    assert_eq!(aggregate.state(), ProviderRetryState::Succeeded);
    assert_eq!(aggregate.aggregate_sequence(), 9);
    drop(journal);
    let journal = fixture.open();
    let recovered = ProviderRetryAggregate::recover(&journal, "run-1", "inference-1").unwrap();
    assert_eq!(recovered, aggregate);
}

#[test]
fn awaiting_attempt_can_finish_as_terminal_failure_outcome_unknown_or_cancelled() {
    for terminal in ["failed", "unknown", "cancelled"] {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        let (mut aggregate, schedule) = awaiting_aggregate(&mut journal);
        match terminal {
            "failed" => {
                let mut failure = failure_observation(
                    schedule.next_attempt_id,
                    schedule.next_attempt_number,
                    3,
                    &schedule.not_before,
                );
                failure.failure.retryable = false;
                failure.failure.retry_after_ms = None;
                failure.failure.retry_after = None;
                failure.failure.http_status = Some(400);
                aggregate
                    .mark_failed_terminal(
                        &mut journal,
                        failure,
                        4,
                        metadata("terminal-failed", "retry:terminal:failed"),
                    )
                    .unwrap();
                assert_eq!(aggregate.state(), ProviderRetryState::FailedTerminal);
                assert!(aggregate.terminal_failure().is_some());
            }
            "unknown" => {
                aggregate
                    .mark_outcome_unknown(
                        &mut journal,
                        attempt_evidence(&schedule, &schedule.not_before),
                        4,
                        metadata("terminal-unknown", "retry:terminal:unknown"),
                    )
                    .unwrap();
                assert_eq!(aggregate.state(), ProviderRetryState::OutcomeUnknown);
            }
            "cancelled" => {
                aggregate
                    .mark_cancelled(
                        &mut journal,
                        attempt_evidence(&schedule, &schedule.not_before),
                        4,
                        metadata("terminal-cancelled", "retry:terminal:cancelled"),
                    )
                    .unwrap();
                assert_eq!(aggregate.state(), ProviderRetryState::Cancelled);
            }
            _ => unreachable!(),
        }
        let recovered = ProviderRetryAggregate::recover(&journal, "run-1", "inference-1").unwrap();
        assert_eq!(recovered, aggregate);
    }
}

#[test]
fn zero_retry_after_and_schedule_identity_are_valid_but_schedule_tampering_is_rejected() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let definition = definition();
    let mut failure = failure_observation(
        definition.first_attempt_id,
        definition.first_attempt_number,
        3,
        "2026-07-13T00:00:01Z",
    );
    failure.failure.retry_after_ms = Some(0);
    failure.failure.retry_after.as_mut().unwrap().delay_ms = 0;
    let mut aggregate = ProviderRetryAggregate::create(
        &mut journal,
        definition.clone(),
        failure.clone(),
        0,
        metadata("zero-create", "retry:zero:create"),
    )
    .unwrap();

    let schedule_a = derive_retry_schedule(&definition, &failure, 0, &failure.observed_at).unwrap();
    let schedule_b = derive_retry_schedule(&definition, &failure, 0, &failure.observed_at).unwrap();
    assert_eq!(schedule_a.schedule_id, schedule_b.schedule_id);
    assert_eq!(schedule_a.next_attempt_id, schedule_b.next_attempt_id);
    assert_eq!(
        schedule_a.schedule_sha256,
        provider_retry_schedule_sha256(&schedule_a).unwrap()
    );
    assert!(
        schedule_a
            .schedule_sha256
            .bytes()
            .all(|byte| { byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) })
    );

    let mut tampered = schedule_a;
    tampered.schedule_sha256 = "F".repeat(64);
    assert!(matches!(
        aggregate.schedule_retry(
            &mut journal,
            tampered,
            1,
            metadata("zero-schedule", "retry:zero:schedule"),
        ),
        Err(ProviderRetryError::ScheduleInvalid)
    ));
}

#[test]
fn uppercase_hashes_and_mismatched_retry_after_receipts_are_rejected() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut invalid_definition = definition();
    invalid_definition.canonical_context_sha256 = "A".repeat(64);
    let failure = failure_observation(
        invalid_definition.first_attempt_id,
        invalid_definition.first_attempt_number,
        3,
        "2026-07-13T00:00:01Z",
    );
    assert!(matches!(
        ProviderRetryAggregate::create(
            &mut journal,
            invalid_definition,
            failure,
            0,
            metadata("uppercase", "retry:uppercase"),
        ),
        Err(ProviderRetryError::DefinitionInvalid)
    ));

    let definition = definition();
    let mut failure = failure_observation(
        definition.first_attempt_id,
        definition.first_attempt_number,
        3,
        "2026-07-13T00:00:01Z",
    );
    failure.failure.retry_after.as_mut().unwrap().delay_ms = 1_499;
    assert!(matches!(
        ProviderRetryAggregate::create(
            &mut journal,
            definition,
            failure,
            0,
            metadata("receipt", "retry:receipt"),
        ),
        Err(ProviderRetryError::FailureNotRetryable)
    ));
}

#[test]
fn retry_exhaustion_is_bound_to_the_failure_or_schedule_that_exhausted() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let mut limited_definition = definition();
    limited_definition.policy.max_attempts = 1;
    limited_definition.policy_sha256 =
        provider_retry_policy_sha256(&limited_definition.policy).unwrap();
    let failure = failure_observation(
        limited_definition.first_attempt_id,
        limited_definition.first_attempt_number,
        3,
        "2026-07-13T00:00:01Z",
    );
    let mut aggregate = ProviderRetryAggregate::create(
        &mut journal,
        limited_definition,
        failure.clone(),
        0,
        metadata("exhaust-create", "retry:exhaust:create"),
    )
    .unwrap();
    let valid = ProviderRetryExhaustion {
        reason: ProviderRetryExhaustionReason::MaxAttempts,
        evidence_sha256: provider_retry_failure_observation_sha256(&failure).unwrap(),
        exhausted_at: failure.observed_at.clone(),
    };
    let mut tampered = valid.clone();
    tampered.evidence_sha256 = "7".repeat(64);
    assert!(matches!(
        aggregate.mark_exhausted(
            &mut journal,
            tampered,
            1,
            metadata("exhaust-tampered", "retry:exhaust:tampered"),
        ),
        Err(ProviderRetryError::ExhaustionInvalid)
    ));
    aggregate
        .mark_exhausted(
            &mut journal,
            valid,
            1,
            metadata("exhaust-valid", "retry:exhaust:valid"),
        )
        .unwrap();
    assert_eq!(aggregate.state(), ProviderRetryState::Exhausted);

    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let definition = definition();
    let failure = failure_observation(
        definition.first_attempt_id,
        definition.first_attempt_number,
        3,
        "2026-07-13T00:00:01Z",
    );
    let mut aggregate = ProviderRetryAggregate::create(
        &mut journal,
        definition.clone(),
        failure.clone(),
        0,
        metadata("schedule-create", "retry:schedule:create"),
    )
    .unwrap();
    let schedule = derive_retry_schedule(&definition, &failure, 0, &failure.observed_at).unwrap();
    aggregate
        .schedule_retry(
            &mut journal,
            schedule.clone(),
            1,
            metadata("schedule-event", "retry:schedule:event"),
        )
        .unwrap();
    aggregate
        .mark_exhausted(
            &mut journal,
            ProviderRetryExhaustion {
                reason: ProviderRetryExhaustionReason::DeadlineExceeded,
                evidence_sha256: schedule.schedule_sha256.clone(),
                exhausted_at: schedule.attempt_deadline_at.clone(),
            },
            2,
            metadata("schedule-exhaust", "retry:schedule:exhaust"),
        )
        .unwrap();
    assert_eq!(aggregate.state(), ProviderRetryState::Exhausted);
}

#[test]
fn create_replay_after_later_failure_returns_current_state_without_new_event() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let definition = definition();
    let initial_failure = failure_observation(
        definition.first_attempt_id,
        definition.first_attempt_number,
        3,
        "2026-07-13T00:00:01Z",
    );
    let (mut aggregate, schedule) = awaiting_aggregate(&mut journal);
    let later_failure = failure_observation(
        schedule.next_attempt_id,
        schedule.next_attempt_number,
        3,
        "2026-07-13T00:00:10Z",
    );
    aggregate
        .observe_retryable_failure(
            &mut journal,
            later_failure.clone(),
            4,
            metadata("later-failure", "retry:later:failure"),
        )
        .unwrap();
    let count_before = journal
        .read_aggregate("run-1", "provider_retry", "inference-1", 0)
        .unwrap()
        .len();

    let replayed = ProviderRetryAggregate::create(
        &mut journal,
        definition,
        initial_failure,
        0,
        metadata("different-message", "retry:await:create"),
    )
    .unwrap();
    assert_eq!(replayed, aggregate);
    assert_eq!(replayed.failure_observation(), Some(&later_failure));
    assert_eq!(
        journal
            .read_aggregate("run-1", "provider_retry", "inference-1", 0)
            .unwrap()
            .len(),
        count_before
    );
}

#[test]
fn raw_replay_rejects_forks_gaps_unknown_events_and_identity_changes() {
    for case in [
        "sequence_gap",
        "unknown_version",
        "unknown_type",
        "duplicate_parent",
        "illegal_parent",
        "definition_identity",
        "provider_identity",
        "context_identity",
        "payload_identity",
    ] {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        let definition = definition();
        let failure = failure_observation(
            definition.first_attempt_id,
            definition.first_attempt_number,
            3,
            "2026-07-13T00:00:01Z",
        );
        let mut aggregate = ProviderRetryAggregate::create(
            &mut journal,
            definition.clone(),
            failure.clone(),
            0,
            metadata("raw-create", "retry:raw:create"),
        )
        .unwrap();
        let schedule =
            derive_retry_schedule(&definition, &failure, 0, &failure.observed_at).unwrap();
        let valid_payload =
            scheduled_payload(&definition, aggregate.definition_sha256(), &schedule);

        match case {
            "sequence_gap" => {
                let payload_json = serde_json::to_string(&valid_payload).unwrap();
                drop(journal);
                let connection = Connection::open(fixture.path()).unwrap();
                connection
                    .execute(
                        "INSERT INTO runtime_events (
                            run_id, run_sequence, aggregate_type, aggregate_id, aggregate_sequence,
                            message_id, idempotency_key, event_type, event_version, payload_json, created_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                        params![
                            "run-1",
                            2_i64,
                            "provider_retry",
                            "inference-1",
                            3_i64,
                            "raw-gap",
                            "retry:raw:gap",
                            "provider.retry.scheduled",
                            1_i64,
                            payload_json,
                            "2026-07-13T00:00:01Z",
                        ],
                    )
                    .unwrap();
            }
            "unknown_version" => append_raw(
                &mut journal,
                "provider.retry.scheduled",
                99,
                valid_payload,
                "raw-version",
                "retry:raw:version",
                1,
                1,
            )
            .unwrap(),
            "unknown_type" => append_raw(
                &mut journal,
                "provider.retry.unrecognized",
                1,
                valid_payload,
                "raw-type",
                "retry:raw:type",
                1,
                1,
            )
            .unwrap(),
            "duplicate_parent" => {
                aggregate
                    .schedule_retry(
                        &mut journal,
                        schedule.clone(),
                        1,
                        metadata("raw-scheduled", "retry:raw:scheduled"),
                    )
                    .unwrap();
                let fork = raw_event(
                    "provider.retry.scheduled",
                    1,
                    valid_payload.clone(),
                    "raw-fork",
                    "retry:raw:fork",
                );
                assert!(matches!(
                    journal.append(fork, 2, 1),
                    Err(EventJournalError::AggregateSequenceConflict { .. })
                ));
                append_raw(
                    &mut journal,
                    "provider.retry.scheduled",
                    1,
                    valid_payload,
                    "raw-duplicate",
                    "retry:raw:duplicate",
                    2,
                    2,
                )
                .unwrap();
            }
            "illegal_parent" => {
                let mut payload = valid_payload;
                payload["schedule"]["parentFailureEvidenceSha256"] =
                    serde_json::Value::String("0".repeat(64));
                append_raw(
                    &mut journal,
                    "provider.retry.scheduled",
                    1,
                    payload,
                    "raw-parent",
                    "retry:raw:parent",
                    1,
                    1,
                )
                .unwrap();
            }
            identity_case => {
                let mut changed = definition.clone();
                match identity_case {
                    "definition_identity" => changed.invocation_id = "other-invocation".to_owned(),
                    "provider_identity" => changed.provider.model_id = "other-model".to_owned(),
                    "context_identity" => changed.canonical_context_sha256 = "1".repeat(64),
                    "payload_identity" => changed.transport_payload_sha256 = "2".repeat(64),
                    _ => unreachable!(),
                }
                let changed_hash = provider_retry_definition_sha256(&changed).unwrap();
                append_raw(
                    &mut journal,
                    "provider.retry.scheduled",
                    1,
                    scheduled_payload(&changed, &changed_hash, &schedule),
                    "raw-identity",
                    "retry:raw:identity",
                    1,
                    1,
                )
                .unwrap();
            }
        }

        let journal = fixture.open();
        assert!(
            ProviderRetryAggregate::recover(&journal, "run-1", "inference-1").is_err(),
            "{case} must fail closed"
        );
    }
}

#[test]
fn retry_identity_time_and_budget_matrix_fails_closed() {
    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let (mut aggregate, schedule) = awaiting_aggregate(&mut journal);
    for attempt_number in [
        schedule.next_attempt_number - 1,
        schedule.next_attempt_number + 1,
    ] {
        let failure = failure_observation(
            schedule.next_attempt_id,
            attempt_number,
            3,
            &schedule.not_before,
        );
        assert!(matches!(
            aggregate.observe_retryable_failure(
                &mut journal,
                failure,
                4,
                metadata("number", "retry:number"),
            ),
            Err(ProviderRetryError::AttemptIdentityInvalid)
        ));
    }
    let rollback = failure_observation(
        schedule.next_attempt_id,
        schedule.next_attempt_number,
        3,
        "2026-07-13T00:00:00Z",
    );
    assert!(matches!(
        aggregate.observe_retryable_failure(
            &mut journal,
            rollback,
            4,
            metadata("rollback", "retry:rollback"),
        ),
        Err(ProviderRetryError::TimeInvalid)
    ));

    for case in ["max_attempts", "max_total_delay", "deadline"] {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        let mut definition = definition();
        let reason = match case {
            "max_attempts" => {
                definition.policy.max_attempts = 1;
                ProviderRetryExhaustionReason::MaxAttempts
            }
            "max_total_delay" => {
                definition.policy.max_total_delay_ms = 1_000;
                ProviderRetryExhaustionReason::MaxTotalDelay
            }
            "deadline" => {
                definition.deadline_at = "2026-07-13T00:00:31Z".to_owned();
                definition.total_deadline_ms = 31_000;
                ProviderRetryExhaustionReason::DeadlineExceeded
            }
            _ => unreachable!(),
        };
        definition.policy_sha256 = provider_retry_policy_sha256(&definition.policy).unwrap();
        let failure = failure_observation(
            definition.first_attempt_id,
            definition.first_attempt_number,
            3,
            "2026-07-13T00:00:01Z",
        );
        let mut aggregate = ProviderRetryAggregate::create(
            &mut journal,
            definition,
            failure.clone(),
            0,
            metadata("budget-create", "retry:budget:create"),
        )
        .unwrap();
        aggregate
            .mark_exhausted(
                &mut journal,
                ProviderRetryExhaustion {
                    reason,
                    evidence_sha256: provider_retry_failure_observation_sha256(&failure).unwrap(),
                    exhausted_at: failure.observed_at.clone(),
                },
                1,
                metadata("budget-exhausted", "retry:budget:exhausted"),
            )
            .unwrap();
        assert_eq!(aggregate.state(), ProviderRetryState::Exhausted, "{case}");
    }
}

#[test]
fn invalid_failures_terminal_forks_and_idempotency_conflicts_fail_closed() {
    for case in [
        "not_sent",
        "unknown",
        "malformed_200",
        "missing_retry_after",
    ] {
        let fixture = Fixture::new();
        let mut journal = fixture.open();
        let definition = definition();
        let mut failure = failure_observation(
            definition.first_attempt_id,
            definition.first_attempt_number,
            3,
            "2026-07-13T00:00:01Z",
        );
        match case {
            "not_sent" => failure.failure.delivery_certainty = ProviderDeliveryCertainty::NotSent,
            "unknown" => failure.failure.delivery_certainty = ProviderDeliveryCertainty::Unknown,
            "malformed_200" => failure.failure.http_status = Some(200),
            "missing_retry_after" => {
                failure.failure.retry_after_ms = None;
                failure.failure.retry_after = None;
            }
            _ => unreachable!(),
        }
        assert!(
            matches!(
                ProviderRetryAggregate::create(
                    &mut journal,
                    definition,
                    failure,
                    0,
                    metadata("invalid-create", "retry:invalid:create"),
                ),
                Err(ProviderRetryError::FailureNotRetryable)
            ),
            "{case}"
        );
    }

    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let (mut aggregate, schedule) = awaiting_aggregate(&mut journal);
    let evidence = attempt_evidence(&schedule, &schedule.not_before);
    aggregate
        .mark_succeeded(
            &mut journal,
            evidence.clone(),
            4,
            metadata("first-terminal", "retry:first:terminal"),
        )
        .unwrap();
    assert!(matches!(
        aggregate.mark_outcome_unknown(
            &mut journal,
            evidence,
            5,
            metadata("second-terminal", "retry:second:terminal"),
        ),
        Err(ProviderRetryError::TerminalState { .. })
    ));

    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let definition = definition();
    let failure = failure_observation(
        definition.first_attempt_id,
        definition.first_attempt_number,
        3,
        "2026-07-13T00:00:01Z",
    );
    let mut aggregate = ProviderRetryAggregate::create(
        &mut journal,
        definition.clone(),
        failure.clone(),
        0,
        metadata("idem-create", "retry:idem:create"),
    )
    .unwrap();
    let schedule = derive_retry_schedule(&definition, &failure, 0, &failure.observed_at).unwrap();
    aggregate
        .schedule_retry(
            &mut journal,
            schedule.clone(),
            1,
            metadata("idem-schedule", "retry:idem:operation"),
        )
        .unwrap();
    aggregate
        .schedule_retry(
            &mut journal,
            schedule.clone(),
            1,
            metadata("idem-repeat", "retry:idem:operation"),
        )
        .unwrap();
    assert_eq!(
        journal
            .read_aggregate("run-1", "provider_retry", "inference-1", 0)
            .unwrap()
            .len(),
        2
    );
    assert!(matches!(
        aggregate.begin_materializing(
            &mut journal,
            &schedule.not_before,
            2,
            metadata("idem-conflict", "retry:idem:operation"),
        ),
        Err(ProviderRetryError::IdempotencyConflict)
    ));

    let fixture = Fixture::new();
    let mut journal = fixture.open();
    let (mut aggregate, schedule) = awaiting_aggregate(&mut journal);
    let mut impossible_terminal = failure_observation(
        schedule.next_attempt_id,
        schedule.next_attempt_number,
        3,
        &schedule.not_before,
    );
    impossible_terminal.failure.retryable = false;
    assert!(matches!(
        aggregate.mark_failed_terminal(
            &mut journal,
            impossible_terminal,
            4,
            metadata("impossible-terminal", "retry:impossible:terminal"),
        ),
        Err(ProviderRetryError::FailureNotRetryable)
    ));
}

fn definition() -> ProviderRetryDefinition {
    let policy = ExponentialFullJitterPolicy {
        algorithm: ProviderRetryPolicyAlgorithm::ExponentialFullJitterV1,
        initial_delay_ms: 1_000,
        max_delay_ms: 8_000,
        max_attempts: 4,
        max_total_delay_ms: 20_000,
    };
    ProviderRetryDefinition {
        run_id: "run-1".to_owned(),
        invocation_id: "run-1:steward".to_owned(),
        inference_id: "inference-1".to_owned(),
        request_number: 1,
        context_compilation_id: Uuid::parse_str("b9e9b829-ff90-4e16-b4ee-23ff66a7d9ce").unwrap(),
        provider: ProviderRunIdentity {
            profile_id: "profile-1".to_owned(),
            provider_id: "deepseek".to_owned(),
            model_id: "deepseek-chat".to_owned(),
            config_sha256: "d".repeat(64),
        },
        canonical_context_sha256: "a".repeat(64),
        transport_payload_sha256: "b".repeat(64),
        first_attempt_id: Uuid::parse_str("30f4191d-207b-4cbd-9ea3-97601f32f6b5").unwrap(),
        first_attempt_number: 1,
        started_at: "2026-07-13T00:00:00Z".to_owned(),
        deadline_at: "2026-07-13T00:02:00Z".to_owned(),
        request_timeout_ms: 30_000,
        total_deadline_ms: 120_000,
        policy_sha256: provider_retry_policy_sha256(&policy).unwrap(),
        policy,
    }
}

fn failure_observation(
    attempt_id: Uuid,
    attempt_number: u16,
    aggregate_sequence: u64,
    observed_at: &str,
) -> ProviderRetryFailureObservation {
    ProviderRetryFailureObservation {
        attempt_id,
        attempt_number,
        attempt_aggregate_sequence: aggregate_sequence,
        attempt_definition_sha256: "c".repeat(64),
        evidence_sha256: "e".repeat(64),
        failure: ProviderAttemptFailure {
            code: "PROVIDER_RATE_LIMITED".to_owned(),
            retryable: true,
            retry_after_ms: Some(1_500),
            retry_after: Some(ProviderRetryAfterReceipt {
                value_sha256: "a".repeat(64),
                kind: ProviderRetryAfterKind::DeltaSeconds,
                delay_ms: 1_500,
            }),
            http_status: Some(429),
            delivery_certainty: ProviderDeliveryCertainty::ResponseReceived,
            diagnostic_id: Uuid::parse_str("8a703d7f-938c-4253-8e1c-b9279e59e803").unwrap(),
        },
        observed_at: observed_at.to_owned(),
    }
}

fn attempt_evidence(
    schedule: &novelx_runtime::provider_retry_aggregate::ProviderRetrySchedule,
    observed_at: &str,
) -> ProviderRetryAttemptEvidence {
    ProviderRetryAttemptEvidence {
        attempt_id: schedule.next_attempt_id,
        attempt_number: schedule.next_attempt_number,
        attempt_aggregate_sequence: 3,
        attempt_definition_sha256: "f".repeat(64),
        evidence_sha256: "9".repeat(64),
        observed_at: observed_at.to_owned(),
    }
}

fn awaiting_aggregate(
    journal: &mut EventJournal,
) -> (
    ProviderRetryAggregate,
    novelx_runtime::provider_retry_aggregate::ProviderRetrySchedule,
) {
    let definition = definition();
    let failure = failure_observation(
        definition.first_attempt_id,
        definition.first_attempt_number,
        3,
        "2026-07-13T00:00:01Z",
    );
    let mut aggregate = ProviderRetryAggregate::create(
        journal,
        definition.clone(),
        failure.clone(),
        0,
        metadata("await-create", "retry:await:create"),
    )
    .unwrap();
    let schedule = derive_retry_schedule(&definition, &failure, 0, "2026-07-13T00:00:01Z").unwrap();
    aggregate
        .schedule_retry(
            journal,
            schedule.clone(),
            1,
            metadata("await-schedule", "retry:await:schedule"),
        )
        .unwrap();
    aggregate
        .begin_materializing(
            journal,
            &schedule.not_before,
            2,
            metadata("await-materialize", "retry:await:materialize"),
        )
        .unwrap();
    aggregate
        .mark_awaiting_attempt(
            journal,
            &schedule.not_before,
            3,
            metadata("await-attempt", "retry:await:attempt"),
        )
        .unwrap();
    (aggregate, schedule)
}

fn scheduled_payload(
    definition: &ProviderRetryDefinition,
    definition_sha256: &str,
    schedule: &novelx_runtime::provider_retry_aggregate::ProviderRetrySchedule,
) -> serde_json::Value {
    serde_json::json!({
        "kind": "scheduled",
        "definition": definition,
        "definitionSha256": definition_sha256,
        "schedule": schedule,
    })
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
        aggregate_type: "provider_retry".to_owned(),
        aggregate_id: "inference-1".to_owned(),
        message_id: message_id.to_owned(),
        idempotency_key: idempotency_key.to_owned(),
        event_type: event_type.to_owned(),
        event_version,
        payload,
        created_at: "2026-07-13T00:00:01Z".to_owned(),
    }
}

#[allow(clippy::too_many_arguments)]
fn append_raw(
    journal: &mut EventJournal,
    event_type: &str,
    event_version: u32,
    payload: serde_json::Value,
    message_id: &str,
    idempotency_key: &str,
    expected_run_sequence: u64,
    expected_aggregate_sequence: u64,
) -> Result<(), EventJournalError> {
    journal
        .append(
            raw_event(
                event_type,
                event_version,
                payload,
                message_id,
                idempotency_key,
            ),
            expected_run_sequence,
            expected_aggregate_sequence,
        )
        .map(|_| ())
}

fn metadata<'a>(message_id: &'a str, idempotency_key: &'a str) -> ProviderRetryMetadata<'a> {
    ProviderRetryMetadata {
        message_id,
        idempotency_key,
        created_at: "2026-07-13T00:00:01Z",
    }
}

struct Fixture {
    _temp: TempDir,
    database: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let database = temp.path().join("workspace.db");
        drop(EventJournal::open(&database).unwrap());
        Self {
            _temp: temp,
            database,
        }
    }

    fn open(&self) -> EventJournal {
        EventJournal::open(&self.database).unwrap()
    }

    fn path(&self) -> &std::path::Path {
        &self.database
    }
}
