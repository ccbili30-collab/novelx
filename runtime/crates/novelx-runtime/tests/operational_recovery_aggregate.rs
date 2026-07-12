use novelx_runtime::operational_recovery_action::OperationalRecoveryAction;
use novelx_runtime::operational_recovery_aggregate::{
    OPERATIONAL_RECOVERY_POLICY_VERSION, OperationalRecoveryAggregateError,
    OperationalRecoveryClaim, OperationalRecoveryDisposition, OperationalRecoveryEffectClass,
    OperationalRecoveryEventMetadata, OperationalRecoveryExecution, OperationalRecoveryObservation,
    OperationalRecoveryObservedGate, OperationalRecoveryOutcome, OperationalRecoveryRepository,
    OperationalRecoveryResume, OperationalRecoveryStale, OperationalRecoverySubject,
    OperationalRecoveryWaitingReason,
};
use novelx_runtime::workspace_runtime_lease::WorkspaceRuntimeLease;
use rusqlite::Connection;
use tempfile::TempDir;

#[test]
fn claim_rejects_a_typed_action_whose_hash_was_forged() {
    let observation = observation(
        &subject(),
        "a",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    let action = OperationalRecoveryAction::PersistedProviderResultProjection {
        invocation_id: "invocation-1".to_owned(),
        attempt_id: "attempt-1".to_owned(),
        expected_loop_checkpoint_sha256: "b".repeat(64),
        expected_attempt_sequence: 3,
        response_body_sha256: "c".repeat(64),
    };
    assert!(matches!(
        OperationalRecoveryClaim::derive(
            observation.operation_id,
            "runtime-1".to_owned(),
            1,
            observation.source_fingerprint,
            "2026-07-13T00:00:00Z".to_owned(),
            "2026-07-13T00:05:00Z".to_owned(),
            "runtime-v2-local-projection-v1".to_owned(),
            Some(action),
            "d".repeat(64),
        ),
        Err(OperationalRecoveryAggregateError::ActionSpecHashMismatch)
    ));
}

#[test]
fn a_new_exclusive_runtime_can_authorize_resume_of_a_started_local_projection() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "a",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), observation.clone(), metadata())
        .unwrap();
    let claim = claim(&observation, "old-runtime", 1);
    repository
        .claim(
            &subject.workspace_id,
            &subject.run_id,
            claim.clone(),
            fixture.clock(),
            metadata(),
        )
        .unwrap();
    let execution = OperationalRecoveryExecution::derive(
        &claim,
        OperationalRecoveryEffectClass::PersistedProviderResultProjection,
        "2026-07-13T00:01:00Z".to_owned(),
    )
    .unwrap();
    repository
        .start_execution(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            execution.clone(),
            fixture.clock(),
            event_metadata("2026-07-13T00:01:00Z"),
        )
        .unwrap();
    let new_lease = fixture.lease("new-runtime");
    let resume = OperationalRecoveryResume::derive(
        &execution,
        "new-runtime".to_owned(),
        "2026-07-13T00:02:00Z".to_owned(),
    )
    .unwrap();
    let resumed = repository
        .authorize_local_execution_resume(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            resume.clone(),
            &new_lease,
            fixture.clock(),
            event_metadata("2026-07-13T00:02:00Z"),
        )
        .unwrap();
    assert_eq!(
        resumed.operations[&observation.operation_id].resumes,
        std::slice::from_ref(&resume)
    );
    assert_eq!(
        repository
            .authorize_local_execution_resume(
                &subject.workspace_id,
                &subject.run_id,
                &observation.operation_id,
                resume,
                &new_lease,
                fixture.clock(),
                event_metadata("2026-07-13T00:02:00Z"),
            )
            .unwrap()
            .revision,
        resumed.revision
    );
}

#[test]
fn one_run_cannot_claim_two_unfinished_recovery_operations() {
    let fixture = Fixture::new();
    let subject = subject();
    let first = observation(
        &subject,
        "a",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    let second = observation(
        &subject,
        "c",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), first.clone(), metadata())
        .unwrap();
    repository
        .observe(subject.clone(), second.clone(), metadata())
        .unwrap();
    repository
        .claim(
            &subject.workspace_id,
            &subject.run_id,
            claim(&first, "runtime-1", 1),
            fixture.clock(),
            metadata(),
        )
        .unwrap();
    assert!(matches!(
        repository.claim(
            &subject.workspace_id,
            &subject.run_id,
            claim(&second, "runtime-1", 1),
            fixture.clock(),
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::ActiveOperationConflict)
    ));
}

#[test]
fn identical_observation_and_wait_are_idempotent_across_reopen() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "a",
        OperationalRecoveryObservedGate::AwaitingProviderBinding,
        vec!["exact_provider_binding_missing"],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    let observed = repository
        .observe(subject.clone(), observation.clone(), metadata())
        .unwrap();
    assert_eq!(observed.revision, 1);
    let waited = repository
        .wait(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            OperationalRecoveryWaitingReason::ProviderBinding,
            observation.source_fingerprint.clone(),
            metadata(),
        )
        .unwrap();
    assert_eq!(waited.revision, 2);
    drop(repository);

    let mut reopened = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    assert_eq!(
        reopened
            .observe(subject.clone(), observation.clone(), metadata())
            .unwrap()
            .revision,
        2
    );
    assert_eq!(
        reopened
            .wait(
                &subject.workspace_id,
                &subject.run_id,
                &observation.operation_id,
                OperationalRecoveryWaitingReason::ProviderBinding,
                observation.source_fingerprint.clone(),
                metadata(),
            )
            .unwrap()
            .revision,
        2
    );
    let loaded = reopened
        .load(&subject.workspace_id, &subject.run_id)
        .unwrap();
    assert!(matches!(
        loaded.operations[&observation.operation_id].disposition,
        Some(OperationalRecoveryDisposition::Waiting {
            reason: OperationalRecoveryWaitingReason::ProviderBinding,
            ..
        })
    ));
}

#[test]
fn changed_evidence_creates_a_new_deterministic_operation() {
    let fixture = Fixture::new();
    let subject = subject();
    let first = observation(
        &subject,
        "a",
        OperationalRecoveryObservedGate::AwaitingProviderBinding,
        vec![],
    );
    let second = observation(
        &subject,
        "b",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    assert_ne!(first.operation_id, second.operation_id);
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), first.clone(), metadata())
        .unwrap();
    let aggregate = repository
        .observe(subject.clone(), second.clone(), metadata())
        .unwrap();
    assert_eq!(aggregate.revision, 2);
    assert_eq!(aggregate.operations.len(), 2);
    assert_eq!(
        OperationalRecoveryObservation::derive(
            &subject,
            second.source_fingerprint.clone(),
            second.gate,
            vec![],
        )
        .unwrap()
        .operation_id,
        second.operation_id
    );
}

#[test]
fn quarantine_is_terminal_for_one_operation_and_requires_codes() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "c",
        OperationalRecoveryObservedGate::Quarantined,
        vec!["multiple_active_agent_loops"],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), observation.clone(), metadata())
        .unwrap();
    assert!(matches!(
        repository.quarantine(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            vec![],
            observation.source_fingerprint.clone(),
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::InvariantCodesRequired)
    ));
    let quarantined = repository
        .quarantine(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            vec!["multiple_active_agent_loops".to_owned()],
            observation.source_fingerprint.clone(),
            metadata(),
        )
        .unwrap();
    assert_eq!(quarantined.revision, 2);
    assert!(matches!(
        repository.wait(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            OperationalRecoveryWaitingReason::Reconciliation,
            observation.source_fingerprint,
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::DispositionConflict)
    ));
}

#[test]
fn forged_operation_and_subject_conflicts_fail_closed() {
    let fixture = Fixture::new();
    let subject = subject();
    let mut forged = observation(
        &subject,
        "d",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    forged.operation_id = "0".repeat(64);
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    assert!(matches!(
        repository.observe(subject.clone(), forged, metadata()),
        Err(OperationalRecoveryAggregateError::OperationConflict)
    ));
    let valid = observation(
        &subject,
        "d",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    repository
        .observe(subject.clone(), valid, metadata())
        .unwrap();
    let mut changed = subject;
    changed.project_id = "other-project".to_owned();
    let changed_observation = observation(
        &changed,
        "e",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    assert!(matches!(
        repository.observe(changed, changed_observation, metadata()),
        Err(OperationalRecoveryAggregateError::SubjectConflict)
    ));
}

#[test]
fn tampered_payload_breaks_the_hash_chain() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "f",
        OperationalRecoveryObservedGate::WaitingForApproval,
        vec![],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), observation, metadata())
        .unwrap();
    let connection = Connection::open(&fixture.path).unwrap();
    connection
        .execute_batch("DROP TRIGGER workspace_events_no_update;")
        .unwrap();
    connection
        .execute(
            "UPDATE workspace_events SET payload_json = json_set(payload_json, '$.aggregate_revision', 9) WHERE stream_type = 'operational_recovery'",
            [],
        )
        .unwrap();
    assert!(matches!(
        repository.load(&subject.workspace_id, &subject.run_id),
        Err(OperationalRecoveryAggregateError::HashChainInvalid)
    ));
}

#[test]
fn ready_operation_claim_is_fenced_idempotent_and_snapshot_guarded() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "7",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), observation.clone(), metadata())
        .unwrap();
    let clock = novelx_runtime::workspace_event_journal::WorkspaceEventJournal::open(&fixture.path)
        .unwrap()
        .current_global_sequence()
        .unwrap();
    let first_claim = claim(&observation, "runtime-instance-1", 1);
    let claimed = repository
        .claim(
            &subject.workspace_id,
            &subject.run_id,
            first_claim.clone(),
            clock,
            metadata(),
        )
        .unwrap();
    assert_eq!(
        claimed.operations[&observation.operation_id].claim,
        Some(first_claim.clone())
    );
    let current_clock =
        novelx_runtime::workspace_event_journal::WorkspaceEventJournal::open(&fixture.path)
            .unwrap()
            .current_global_sequence()
            .unwrap();
    assert_eq!(
        repository
            .claim(
                &subject.workspace_id,
                &subject.run_id,
                first_claim,
                current_clock,
                metadata(),
            )
            .unwrap()
            .revision,
        claimed.revision
    );
    assert!(matches!(
        repository.claim(
            &subject.workspace_id,
            &subject.run_id,
            claim(&observation, "runtime-instance-2", 1),
            current_clock,
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::ClaimConflict)
    ));
}

#[test]
fn claim_rejects_stale_global_snapshot_and_non_ready_operations() {
    let fixture = Fixture::new();
    let subject = subject();
    let ready = observation(
        &subject,
        "8",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), ready.clone(), metadata())
        .unwrap();
    let stale_clock =
        novelx_runtime::workspace_event_journal::WorkspaceEventJournal::open(&fixture.path)
            .unwrap()
            .current_global_sequence()
            .unwrap();
    repository
        .observe(
            subject.clone(),
            observation(
                &subject,
                "9",
                OperationalRecoveryObservedGate::TerminalProjectionOnly,
                vec![],
            ),
            metadata(),
        )
        .unwrap();
    assert!(matches!(
        repository.claim(
            &subject.workspace_id,
            &subject.run_id,
            claim(&ready, "runtime-instance-1", 1),
            stale_clock,
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::Journal(
            novelx_runtime::workspace_event_journal::WorkspaceEventJournalError::GlobalSequenceConflict { .. }
        ))
    ));

    let waiting = observation(
        &subject,
        "a",
        OperationalRecoveryObservedGate::AwaitingProviderBinding,
        vec![],
    );
    repository
        .observe(subject.clone(), waiting.clone(), metadata())
        .unwrap();
    let clock = novelx_runtime::workspace_event_journal::WorkspaceEventJournal::open(&fixture.path)
        .unwrap()
        .current_global_sequence()
        .unwrap();
    assert!(matches!(
        repository.claim(
            &subject.workspace_id,
            &subject.run_id,
            claim(&waiting, "runtime-instance-1", 1),
            clock,
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::OperationNotClaimable)
    ));
}

#[test]
fn claimed_operation_renews_starts_and_succeeds_with_verified_hashes() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "1",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), observation.clone(), metadata())
        .unwrap();
    let first_claim = claim(&observation, "runtime-instance-1", 1);
    repository
        .claim(
            &subject.workspace_id,
            &subject.run_id,
            first_claim.clone(),
            fixture.clock(),
            metadata(),
        )
        .unwrap();
    let renewed = repository
        .renew_lease(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            &first_claim.claim_id,
            &first_claim.owner_instance_id,
            first_claim.fencing_token,
            "2026-07-13T00:04:00Z".to_owned(),
            "2026-07-13T00:09:00Z".to_owned(),
            fixture.clock(),
            event_metadata("2026-07-13T00:04:00Z"),
        )
        .unwrap();
    let current_claim = renewed.operations[&observation.operation_id]
        .claim
        .as_ref()
        .unwrap();
    assert_eq!(current_claim.lease_expires_at, "2026-07-13T00:09:00Z");
    let execution = OperationalRecoveryExecution::derive(
        current_claim,
        OperationalRecoveryEffectClass::LocalDeterministic,
        "2026-07-13T00:05:00Z".to_owned(),
    )
    .unwrap();
    repository
        .start_execution(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            execution.clone(),
            fixture.clock(),
            event_metadata("2026-07-13T00:05:00Z"),
        )
        .unwrap();
    let outcome = OperationalRecoveryOutcome::succeeded(
        &execution,
        "d".repeat(64),
        "e".repeat(64),
        "2026-07-13T00:06:00Z".to_owned(),
    )
    .unwrap();
    let finished = repository
        .finish_execution(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            outcome.clone(),
            fixture.clock(),
            event_metadata("2026-07-13T00:06:00Z"),
        )
        .unwrap();
    assert_eq!(
        finished.operations[&observation.operation_id].outcome,
        Some(outcome.clone())
    );
    assert_eq!(
        repository
            .finish_execution(
                &subject.workspace_id,
                &subject.run_id,
                &observation.operation_id,
                outcome,
                fixture.clock(),
                event_metadata("2026-07-13T00:06:00Z"),
            )
            .unwrap()
            .revision,
        finished.revision
    );
}

#[test]
fn expired_or_wrong_fence_cannot_renew_or_start_execution() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "2",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), observation.clone(), metadata())
        .unwrap();
    let first_claim = claim(&observation, "runtime-instance-1", 1);
    repository
        .claim(
            &subject.workspace_id,
            &subject.run_id,
            first_claim.clone(),
            fixture.clock(),
            metadata(),
        )
        .unwrap();
    assert!(matches!(
        repository.renew_lease(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            &first_claim.claim_id,
            "wrong-owner",
            1,
            "2026-07-13T00:01:00Z".to_owned(),
            "2026-07-13T00:06:00Z".to_owned(),
            fixture.clock(),
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::FenceMismatch)
    ));
    assert!(matches!(
        repository.renew_lease(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            &first_claim.claim_id,
            &first_claim.owner_instance_id,
            1,
            "2026-07-13T00:05:00Z".to_owned(),
            "2026-07-13T00:06:00Z".to_owned(),
            fixture.clock(),
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::LeaseRenewalInvalid)
    ));
    assert!(matches!(
        OperationalRecoveryExecution::derive(
            &first_claim,
            OperationalRecoveryEffectClass::LocalDeterministic,
            "2026-07-13T00:05:01Z".to_owned(),
        ),
        Err(OperationalRecoveryAggregateError::ClaimLeaseExpired)
    ));
}

#[test]
fn terminal_outcome_rejects_conflicting_writeback_and_unverified_success() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "3",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), observation.clone(), metadata())
        .unwrap();
    let first_claim = claim(&observation, "runtime-instance-1", 1);
    repository
        .claim(
            &subject.workspace_id,
            &subject.run_id,
            first_claim.clone(),
            fixture.clock(),
            metadata(),
        )
        .unwrap();
    let execution = OperationalRecoveryExecution::derive(
        &first_claim,
        OperationalRecoveryEffectClass::LocalDeterministic,
        "2026-07-13T00:01:00Z".to_owned(),
    )
    .unwrap();
    repository
        .start_execution(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            execution.clone(),
            fixture.clock(),
            metadata(),
        )
        .unwrap();
    let exclusive = WorkspaceRuntimeLease::acquire(&fixture.path, "runtime-instance-2").unwrap();
    let scan_sequence = fixture.clock();
    let stale = OperationalRecoveryStale::derive(
        observation.operation_id.clone(),
        observation.source_fingerprint.clone(),
        "8".repeat(64),
        "9".repeat(64),
        Some(first_claim.claim_id.clone()),
        Some(first_claim.fencing_token),
        exclusive.instance_id().to_owned(),
        "2026-07-13T00:02:00Z".to_owned(),
        scan_sequence,
    )
    .unwrap();
    assert!(matches!(
        repository.mark_stale(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            stale,
            &exclusive,
            scan_sequence,
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::StaleTransitionInvalid)
    ));
    drop(exclusive);
    assert!(
        OperationalRecoveryOutcome::succeeded(
            &execution,
            "not-a-hash".to_owned(),
            "e".repeat(64),
            "2026-07-13T00:02:00Z".to_owned(),
        )
        .is_err()
    );
    let unknown = OperationalRecoveryOutcome::outcome_unknown(
        &execution,
        "effect_result_missing".to_owned(),
        "f".repeat(64),
        "2026-07-13T00:02:00Z".to_owned(),
    )
    .unwrap();
    repository
        .finish_execution(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            unknown,
            fixture.clock(),
            metadata(),
        )
        .unwrap();
    let failed = OperationalRecoveryOutcome::failed_safe(
        &execution,
        "safe_failure".to_owned(),
        "a".repeat(64),
        "2026-07-13T00:03:00Z".to_owned(),
    )
    .unwrap();
    assert!(matches!(
        repository.finish_execution(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            failed,
            fixture.clock(),
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::OperationTerminal)
    ));
}

#[test]
fn expired_unstarted_claim_transfers_with_exclusive_owner_and_increments_fence() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "4",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), observation.clone(), metadata())
        .unwrap();
    let first_claim = claim(&observation, "runtime-instance-1", 1);
    repository
        .claim(
            &subject.workspace_id,
            &subject.run_id,
            first_claim.clone(),
            fixture.clock(),
            metadata(),
        )
        .unwrap();
    let exclusive = WorkspaceRuntimeLease::acquire(&fixture.path, "runtime-instance-2").unwrap();
    let second_claim = OperationalRecoveryClaim::derive(
        observation.operation_id.clone(),
        "runtime-instance-2".to_owned(),
        2,
        observation.source_fingerprint.clone(),
        "2026-07-13T00:05:00Z".to_owned(),
        "2026-07-13T00:10:00Z".to_owned(),
        first_claim.executor_version.clone(),
        first_claim.action_spec.clone(),
        first_claim.action_spec_sha256.clone(),
    )
    .unwrap();
    let transferred = repository
        .transfer_claim(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            &first_claim.claim_id,
            second_claim.clone(),
            &exclusive,
            fixture.clock(),
            event_metadata("2026-07-13T00:05:00Z"),
        )
        .unwrap();
    assert_eq!(
        transferred.operations[&observation.operation_id].claim,
        Some(second_claim.clone())
    );
    assert!(matches!(
        repository.start_execution(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            OperationalRecoveryExecution::derive(
                &first_claim,
                OperationalRecoveryEffectClass::LocalDeterministic,
                "2026-07-13T00:04:00Z".to_owned(),
            )
            .unwrap(),
            fixture.clock(),
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::FenceMismatch)
    ));
    let execution = OperationalRecoveryExecution::derive(
        &second_claim,
        OperationalRecoveryEffectClass::LocalDeterministic,
        "2026-07-13T00:06:00Z".to_owned(),
    )
    .unwrap();
    repository
        .start_execution(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            execution,
            fixture.clock(),
            event_metadata("2026-07-13T00:06:00Z"),
        )
        .unwrap();
    let third_claim = OperationalRecoveryClaim::derive(
        observation.operation_id.clone(),
        "runtime-instance-2".to_owned(),
        3,
        observation.source_fingerprint,
        "2026-07-13T00:10:00Z".to_owned(),
        "2026-07-13T00:15:00Z".to_owned(),
        second_claim.executor_version,
        second_claim.action_spec,
        second_claim.action_spec_sha256,
    )
    .unwrap();
    assert!(matches!(
        repository.transfer_claim(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            &second_claim.claim_id,
            third_claim,
            &exclusive,
            fixture.clock(),
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::ClaimTransferInvalid)
    ));
}

#[test]
fn changed_source_marks_claimed_unstarted_operation_stale_and_blocks_progress() {
    let fixture = Fixture::new();
    let subject = subject();
    let observation = observation(
        &subject,
        "5",
        OperationalRecoveryObservedGate::RecoveryReady,
        vec![],
    );
    let mut repository = OperationalRecoveryRepository::open(&fixture.path).unwrap();
    repository
        .observe(subject.clone(), observation.clone(), metadata())
        .unwrap();
    let first_claim = claim(&observation, "runtime-instance-1", 1);
    repository
        .claim(
            &subject.workspace_id,
            &subject.run_id,
            first_claim.clone(),
            fixture.clock(),
            metadata(),
        )
        .unwrap();
    let exclusive = WorkspaceRuntimeLease::acquire(&fixture.path, "runtime-instance-2").unwrap();
    let scan_sequence = fixture.clock();
    let stale = OperationalRecoveryStale::derive(
        observation.operation_id.clone(),
        observation.source_fingerprint.clone(),
        "6".repeat(64),
        "7".repeat(64),
        Some(first_claim.claim_id.clone()),
        Some(first_claim.fencing_token),
        exclusive.instance_id().to_owned(),
        "2026-07-13T00:01:00Z".to_owned(),
        scan_sequence,
    )
    .unwrap();
    let marked = repository
        .mark_stale(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            stale.clone(),
            &exclusive,
            scan_sequence,
            event_metadata("2026-07-13T00:01:00Z"),
        )
        .unwrap();
    assert_eq!(
        marked.operations[&observation.operation_id].stale,
        Some(stale.clone())
    );
    assert_eq!(
        repository
            .mark_stale(
                &subject.workspace_id,
                &subject.run_id,
                &observation.operation_id,
                stale,
                &exclusive,
                fixture.clock(),
                event_metadata("2026-07-13T00:01:00Z"),
            )
            .unwrap()
            .revision,
        marked.revision
    );
    assert!(matches!(
        repository.start_execution(
            &subject.workspace_id,
            &subject.run_id,
            &observation.operation_id,
            OperationalRecoveryExecution::derive(
                &first_claim,
                OperationalRecoveryEffectClass::LocalDeterministic,
                "2026-07-13T00:02:00Z".to_owned(),
            )
            .unwrap(),
            fixture.clock(),
            metadata(),
        ),
        Err(OperationalRecoveryAggregateError::OperationTerminal)
    ));
}

fn subject() -> OperationalRecoverySubject {
    OperationalRecoverySubject {
        workspace_id: "workspace-1".to_owned(),
        project_id: "project-1".to_owned(),
        run_id: "run-1".to_owned(),
        policy_version: OPERATIONAL_RECOVERY_POLICY_VERSION.to_owned(),
    }
}

fn observation(
    subject: &OperationalRecoverySubject,
    digit: &str,
    gate: OperationalRecoveryObservedGate,
    reasons: Vec<&str>,
) -> OperationalRecoveryObservation {
    OperationalRecoveryObservation::derive(
        subject,
        digit.repeat(64),
        gate,
        reasons.into_iter().map(str::to_owned).collect(),
    )
    .unwrap()
}

fn metadata() -> OperationalRecoveryEventMetadata {
    OperationalRecoveryEventMetadata {
        created_at: "2026-07-13T00:00:00Z".to_owned(),
    }
}

fn event_metadata(created_at: &str) -> OperationalRecoveryEventMetadata {
    OperationalRecoveryEventMetadata {
        created_at: created_at.to_owned(),
    }
}

fn claim(
    observation: &OperationalRecoveryObservation,
    owner_instance_id: &str,
    fencing_token: u64,
) -> OperationalRecoveryClaim {
    OperationalRecoveryClaim::derive(
        observation.operation_id.clone(),
        owner_instance_id.to_owned(),
        fencing_token,
        observation.source_fingerprint.clone(),
        "2026-07-13T00:00:00Z".to_owned(),
        "2026-07-13T00:05:00Z".to_owned(),
        "recovery-executor-v1".to_owned(),
        None,
        "b".repeat(64),
    )
    .unwrap()
}

struct Fixture {
    _temp: TempDir,
    path: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        novelx_runtime::event_journal::EventJournal::open(&path).unwrap();
        Self { _temp: temp, path }
    }

    fn clock(&self) -> u64 {
        novelx_runtime::workspace_event_journal::WorkspaceEventJournal::open(&self.path)
            .unwrap()
            .current_global_sequence()
            .unwrap()
    }

    fn lease(&self, instance_id: &str) -> WorkspaceRuntimeLease {
        WorkspaceRuntimeLease::acquire(&self.path, instance_id).unwrap()
    }
}
