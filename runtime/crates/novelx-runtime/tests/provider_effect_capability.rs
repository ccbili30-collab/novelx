use std::{path::Path, sync::Arc};

use novelx_protocol::ProviderRunIdentity;
use novelx_runtime::event_journal::EventJournal;
use tempfile::TempDir;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

mod workspace_runtime_lease {
    pub use novelx_runtime::workspace_runtime_lease::*;
}

#[path = "../src/provider_effect_capability.rs"]
mod provider_effect_capability;

use provider_effect_capability::{
    AgentLoopContinuationAuthorityBinding, AgentLoopRetryAuthorityBinding, ArmedProviderEffect,
    ConsumedProviderEffect, DispatchedProviderEffect, InitialAgentLoopAuthorityBinding,
    OperationalRecoveryActorBinding, OperationalRecoveryAuthorityBinding,
    ProviderEffectAuthorityBinding, ProviderEffectCapability, ProviderEffectCapabilityError,
    ProviderEffectGrantMaterial, ProviderEffectGrantReceipt, ProviderEffectRetryScheduleBinding,
    canonical_database_path_sha256,
};
use workspace_runtime_lease::{
    BoundWorkspaceRuntimeLease, WorkspaceRuntimeLease, WorkspaceRuntimeLeaseError,
};

macro_rules! assert_not_impl {
    ($type:ty, $trait:path) => {
        const _: fn() = || {
            trait AmbiguousIfImpl<A> {
                fn marker() {}
            }
            impl<T: ?Sized> AmbiguousIfImpl<()> for T {}
            struct Invalid;
            impl<T: ?Sized + $trait> AmbiguousIfImpl<Invalid> for T {}
            let _ = <$type as AmbiguousIfImpl<_>>::marker;
        };
    };
}

assert_not_impl!(ProviderEffectCapability, Clone);
assert_not_impl!(ProviderEffectCapability, serde::Serialize);
assert_not_impl!(ConsumedProviderEffect, Clone);
assert_not_impl!(ConsumedProviderEffect, serde::Serialize);
assert_not_impl!(ArmedProviderEffect, Clone);
assert_not_impl!(ArmedProviderEffect, serde::Serialize);
assert_not_impl!(DispatchedProviderEffect, Clone);
assert_not_impl!(DispatchedProviderEffect, serde::Serialize);

#[test]
fn grant_hash_and_uuid_v5_dispatch_are_stable_and_contain_no_secret_material() {
    let fixture = Fixture::new("stable");
    let material = fixture.initial_material();
    let first = ProviderEffectGrantReceipt::derive(material.clone()).unwrap();
    let second = ProviderEffectGrantReceipt::derive(material).unwrap();

    assert_eq!(first, second);
    assert_eq!(first.material().workspace_id, "workspace-1");
    let ProviderEffectAuthorityBinding::InitialAgentLoop(authority) = &first.material().authority
    else {
        unreachable!();
    };
    assert_eq!(authority.requested_at, first.material().issued_at);
    assert_eq!(authority.requested_message_id, "attempt-requested-message");
    assert_eq!(first.grant_sha256().len(), 64);
    assert_eq!(first.dispatch_id(), second.dispatch_id());
    assert_eq!(first.dispatch_id().get_version_num(), 5);
    first.validate().unwrap();

    let serialized = serde_json::to_string(&first).unwrap().to_ascii_lowercase();
    for forbidden in [
        "apikey",
        "api_key",
        "credential",
        "bearer ",
        "authorizationheader",
        "rawheader",
    ] {
        assert!(!serialized.contains(forbidden), "leaked `{forbidden}`");
    }
}

#[test]
fn capability_rejects_replaced_payload_provider_and_database_identity() {
    let fixture = Fixture::new("replace");

    let capability = fixture.capability(fixture.initial_material());
    assert_eq!(capability.receipt().material().attempt_number, 1);
    let mut replaced_payload = fixture.initial_material();
    replaced_payload.transport_payload_sha256 = hash('b');
    assert!(matches!(
        capability.consume(&replaced_payload, &fixture.database),
        Err(ProviderEffectCapabilityError::MaterialMismatch)
    ));

    let capability = fixture.capability(fixture.initial_material());
    let mut replaced_provider = fixture.initial_material();
    replaced_provider.provider.model_id = "another-model".to_owned();
    assert!(matches!(
        capability.consume(&replaced_provider, &fixture.database),
        Err(ProviderEffectCapabilityError::MaterialMismatch)
    ));

    let mut replaced_database = fixture.initial_material();
    replaced_database.database_canonical_path_sha256 = hash('c');
    let receipt = ProviderEffectGrantReceipt::derive(replaced_database.clone()).unwrap();
    assert!(matches!(
        ProviderEffectCapability::activate(
            receipt,
            &replaced_database,
            &fixture.database,
            Arc::clone(&fixture.lease),
        ),
        Err(ProviderEffectCapabilityError::DatabasePathMismatch)
    ));
}

#[test]
fn issued_at_must_equal_the_persisted_authority_time() {
    let fixture = Fixture::new("authority-time");

    let mut initial = fixture.initial_material();
    initial.issued_at = format_time(parse_time(&initial.issued_at) + Duration::seconds(1));
    assert!(matches!(
        ProviderEffectGrantReceipt::derive(initial),
        Err(ProviderEffectCapabilityError::AuthorityTimeMismatch)
    ));

    let mut continuation = fixture.continuation_material();
    continuation.issued_at =
        format_time(parse_time(&continuation.issued_at) + Duration::seconds(1));
    assert!(matches!(
        ProviderEffectGrantReceipt::derive(continuation),
        Err(ProviderEffectCapabilityError::AuthorityTimeMismatch)
    ));

    let mut retry = fixture.retry_material();
    retry.issued_at = format_time(parse_time(&retry.issued_at) + Duration::seconds(1));
    assert!(matches!(
        ProviderEffectGrantReceipt::derive(retry),
        Err(ProviderEffectCapabilityError::AuthorityTimeMismatch)
    ));

    let mut recovery = fixture.recovery_material(true);
    recovery.issued_at = format_time(parse_time(&recovery.issued_at) + Duration::seconds(1));
    assert!(matches!(
        ProviderEffectGrantReceipt::derive(recovery),
        Err(ProviderEffectCapabilityError::AuthorityTimeMismatch)
    ));
}

#[test]
fn lease_epoch_is_non_reusable_and_capability_arc_keeps_the_os_lock_alive() {
    let directory = TempDir::new().unwrap();
    let database = directory.path().join("workspace.db");
    EventJournal::open(&database).unwrap();
    let first = Arc::new(
        WorkspaceRuntimeLease::acquire(&database, "same-label")
            .unwrap()
            .bind_database(&database)
            .unwrap(),
    );
    let material = initial_material(&database, &first);
    let receipt = ProviderEffectGrantReceipt::derive(material.clone()).unwrap();
    let capability = ProviderEffectCapability::activate(
        receipt.clone(),
        &material,
        &database,
        Arc::clone(&first),
    )
    .unwrap();

    drop(first);
    assert!(matches!(
        WorkspaceRuntimeLease::acquire(&database, "same-label"),
        Err(WorkspaceRuntimeLeaseError::AlreadyHeld { .. })
    ));

    drop(capability);
    let replacement = Arc::new(
        WorkspaceRuntimeLease::acquire(&database, "same-label")
            .unwrap()
            .bind_database(&database)
            .unwrap(),
    );
    assert_ne!(replacement.lease_epoch(), material.lease_epoch);
    assert!(matches!(
        ProviderEffectCapability::activate(receipt, &material, &database, Arc::clone(&replacement),),
        Err(ProviderEffectCapabilityError::LeaseEpochMismatch)
    ));
}

#[test]
fn lease_stays_live_across_consumed_armed_and_dispatched_lifecycle() {
    let directory = TempDir::new().unwrap();
    let database = directory.path().join("workspace.db");
    EventJournal::open(&database).unwrap();
    let lease = Arc::new(
        WorkspaceRuntimeLease::acquire(&database, "lifecycle")
            .unwrap()
            .bind_database(&database)
            .unwrap(),
    );
    let material = initial_material(&database, &lease);
    let receipt = ProviderEffectGrantReceipt::derive(material.clone()).unwrap();
    let capability = ProviderEffectCapability::activate(
        receipt.clone(),
        &material,
        &database,
        Arc::clone(&lease),
    )
    .unwrap();
    assert_redacted_debug(&capability);
    drop(lease);

    assert_lock_held(&database, "lifecycle");
    let consumed = capability.consume(&material, &database).unwrap();
    assert_redacted_debug(&consumed);
    assert_eq!(consumed.receipt(), &receipt);
    assert_lock_held(&database, "lifecycle");
    let armed = consumed.arm(receipt.clone()).unwrap();
    assert_redacted_debug(&armed);
    assert_eq!(armed.receipt(), &receipt);
    assert_lock_held(&database, "lifecycle");
    let dispatched = armed.into_dispatched();
    assert_redacted_debug(&dispatched);
    assert_eq!(dispatched.receipt(), &receipt);
    assert_lock_held(&database, "lifecycle");
    drop(dispatched);

    WorkspaceRuntimeLease::acquire(&database, "lifecycle").unwrap();
}

#[test]
fn mismatched_persisted_receipt_cannot_arm_the_effect() {
    let fixture = Fixture::new("receipt-mismatch");
    let material = fixture.initial_material();
    let capability = fixture.capability(material.clone());
    let consumed = capability.consume(&material, &fixture.database).unwrap();

    let mut different = material;
    different.transport_payload_sha256 = hash('0');
    let different_receipt = ProviderEffectGrantReceipt::derive(different).unwrap();
    assert!(matches!(
        consumed.arm(different_receipt),
        Err(ProviderEffectCapabilityError::PersistedReceiptMismatch)
    ));
}

#[test]
fn expired_capability_and_future_issue_are_rejected() {
    let fixture = Fixture::new("expired");
    let material = fixture.initial_material();
    let receipt = ProviderEffectGrantReceipt::derive(material.clone()).unwrap();
    let after_deadline = parse_time(&material.attempt_deadline_at) + Duration::seconds(1);
    assert!(matches!(
        ProviderEffectCapability::activate_at(
            receipt,
            &material,
            &fixture.database,
            Arc::clone(&fixture.lease),
            after_deadline,
        ),
        Err(ProviderEffectCapabilityError::Expired)
    ));

    let receipt = ProviderEffectGrantReceipt::derive(material.clone()).unwrap();
    let before_issue = parse_time(&material.issued_at) - Duration::seconds(1);
    assert!(matches!(
        ProviderEffectCapability::activate_at(
            receipt,
            &material,
            &fixture.database,
            Arc::clone(&fixture.lease),
            before_issue,
        ),
        Err(ProviderEffectCapabilityError::IssuedInFuture)
    ));
}

#[test]
fn attempt_two_requires_an_exact_retry_schedule() {
    let fixture = Fixture::new("retry-required");
    let mut material = fixture.initial_material();
    material.attempt_number = 2;
    material.attempt_id = Uuid::new_v4();
    assert!(matches!(
        ProviderEffectGrantReceipt::derive(material),
        Err(ProviderEffectCapabilityError::RetryScheduleRequired)
            | Err(ProviderEffectCapabilityError::AuthorityMismatch)
    ));
}

#[test]
fn typed_authorities_produce_distinct_grants_and_validate_exact_bindings() {
    let fixture = Fixture::new("authorities");
    let initial = ProviderEffectGrantReceipt::derive(fixture.initial_material()).unwrap();
    let continuation = ProviderEffectGrantReceipt::derive(fixture.continuation_material()).unwrap();

    let retry_material = fixture.retry_material();
    let retry = ProviderEffectGrantReceipt::derive(retry_material.clone()).unwrap();

    let recovery_material = fixture.recovery_material(false);
    let recovery = ProviderEffectGrantReceipt::derive(recovery_material).unwrap();
    let resumed = ProviderEffectGrantReceipt::derive(fixture.recovery_material(true)).unwrap();

    assert_ne!(initial.grant_sha256(), retry.grant_sha256());
    assert_ne!(initial.grant_sha256(), continuation.grant_sha256());
    assert_ne!(continuation.grant_sha256(), retry.grant_sha256());
    assert_ne!(initial.grant_sha256(), recovery.grant_sha256());
    assert_ne!(recovery.grant_sha256(), resumed.grant_sha256());

    let mut mismatched = retry_material;
    let ProviderEffectAuthorityBinding::AgentLoopRetry(binding) = &mut mismatched.authority else {
        unreachable!();
    };
    binding.schedule_sha256 = hash('d');
    assert!(matches!(
        ProviderEffectGrantReceipt::derive(mismatched),
        Err(ProviderEffectCapabilityError::AuthorityMismatch)
    ));
}

#[test]
fn initial_continuation_and_retry_authorities_are_mutually_exclusive_and_stable() {
    let fixture = Fixture::new("exclusive-authorities");

    let initial_material = fixture.initial_material();
    assert_eq!(
        ProviderEffectGrantReceipt::derive(initial_material.clone()).unwrap(),
        ProviderEffectGrantReceipt::derive(initial_material).unwrap()
    );

    let continuation_material = fixture.continuation_material();
    assert_eq!(
        ProviderEffectGrantReceipt::derive(continuation_material.clone()).unwrap(),
        ProviderEffectGrantReceipt::derive(continuation_material).unwrap()
    );

    let retry_material = fixture.retry_material();
    assert_eq!(
        ProviderEffectGrantReceipt::derive(retry_material.clone()).unwrap(),
        ProviderEffectGrantReceipt::derive(retry_material).unwrap()
    );

    let mut initial_for_later_request = fixture.initial_material();
    initial_for_later_request.request_number = 2;
    assert!(matches!(
        ProviderEffectGrantReceipt::derive(initial_for_later_request),
        Err(ProviderEffectCapabilityError::AuthorityMismatch)
    ));

    let mut continuation_for_first_request = fixture.continuation_material();
    continuation_for_first_request.request_number = 1;
    assert!(matches!(
        ProviderEffectGrantReceipt::derive(continuation_for_first_request),
        Err(ProviderEffectCapabilityError::AuthorityMismatch)
    ));

    let mut continuation_for_retry_attempt = fixture.continuation_material();
    continuation_for_retry_attempt.attempt_number = 2;
    continuation_for_retry_attempt.attempt_id = Uuid::new_v4();
    continuation_for_retry_attempt.retry_schedule = Some(retry_schedule_for(
        &continuation_for_retry_attempt,
        Uuid::new_v4(),
        hash('0'),
    ));
    assert!(matches!(
        ProviderEffectGrantReceipt::derive(continuation_for_retry_attempt),
        Err(ProviderEffectCapabilityError::AuthorityMismatch)
    ));
}

struct Fixture {
    _directory: TempDir,
    database: std::path::PathBuf,
    lease: Arc<BoundWorkspaceRuntimeLease>,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("workspace.db");
        EventJournal::open(&database).unwrap();
        let lease = Arc::new(
            WorkspaceRuntimeLease::acquire(&database, label)
                .unwrap()
                .bind_database(&database)
                .unwrap(),
        );
        Self {
            _directory: directory,
            database,
            lease,
        }
    }

    fn initial_material(&self) -> ProviderEffectGrantMaterial {
        initial_material(&self.database, &self.lease)
    }

    fn capability(&self, material: ProviderEffectGrantMaterial) -> ProviderEffectCapability {
        let receipt = ProviderEffectGrantReceipt::derive(material.clone()).unwrap();
        ProviderEffectCapability::activate(
            receipt,
            &material,
            &self.database,
            Arc::clone(&self.lease),
        )
        .unwrap()
    }

    fn retry_material(&self) -> ProviderEffectGrantMaterial {
        let mut material = self.initial_material();
        material.attempt_number = 2;
        material.attempt_id = Uuid::new_v4();
        let schedule_id = Uuid::new_v4();
        let schedule_sha256 = hash('9');
        material.retry_schedule = Some(ProviderEffectRetryScheduleBinding {
            retry_definition_sha256: hash('8'),
            retry_aggregate_sequence: 3,
            schedule_id,
            schedule_sha256: schedule_sha256.clone(),
            parent_failure_evidence_sha256: hash('7'),
            parent_failure_observation_sha256: hash('6'),
            next_attempt_id: material.attempt_id,
            next_attempt_number: 2,
            not_before: material.issued_at.clone(),
            attempt_deadline_at: material.attempt_deadline_at.clone(),
        });
        material.authority =
            ProviderEffectAuthorityBinding::AgentLoopRetry(AgentLoopRetryAuthorityBinding {
                agent_loop_aggregate_sequence: 8,
                agent_loop_checkpoint_sha256: hash('5'),
                pending_inference_sha256: hash('4'),
                retry_binding_sha256: hash('3'),
                retry_awaiting_at: material.issued_at.clone(),
                schedule_id,
                schedule_sha256,
            });
        material
    }

    fn continuation_material(&self) -> ProviderEffectGrantMaterial {
        let mut material = self.initial_material();
        material.request_number = 2;
        material.inference_id = Uuid::new_v4();
        material.attempt_id = Uuid::new_v4();
        material.context_compilation_id = Uuid::new_v4();
        material.authority = ProviderEffectAuthorityBinding::AgentLoopContinuation(
            AgentLoopContinuationAuthorityBinding {
                agent_loop_aggregate_sequence: 7,
                agent_loop_checkpoint_sha256: hash('4'),
                pending_inference_sha256: hash('5'),
                inference_started_at: material.issued_at.clone(),
            },
        );
        material
    }

    fn recovery_material(&self, resumed: bool) -> ProviderEffectGrantMaterial {
        let mut material = self.initial_material();
        let actor = if resumed {
            OperationalRecoveryActorBinding::ResumeAuthorized {
                resumer_lease_epoch: self.lease.lease_epoch().to_owned(),
                authorization_id: hash('2'),
                authorization_sha256: hash('1'),
                authorization_generation: 2,
                authorized_at: material.issued_at.clone(),
            }
        } else {
            OperationalRecoveryActorBinding::OriginalOwner {
                owner_lease_epoch: self.lease.lease_epoch().to_owned(),
                execution_started_at: material.issued_at.clone(),
            }
        };
        material.authority = ProviderEffectAuthorityBinding::OperationalRecovery(
            OperationalRecoveryAuthorityBinding {
                operation_id: hash('a'),
                claim_id: hash('b'),
                execution_id: hash('c'),
                fencing_token: 7,
                action_spec_sha256: hash('d'),
                recovery_stream_sequence: 11,
                recovery_last_event_sha256: hash('e'),
                actor,
            },
        );
        material
    }
}

fn initial_material(
    database: &Path,
    lease: &BoundWorkspaceRuntimeLease,
) -> ProviderEffectGrantMaterial {
    let now = OffsetDateTime::now_utc();
    ProviderEffectGrantMaterial {
        schema_version: ProviderEffectGrantMaterial::schema_version(),
        workspace_id: "workspace-1".to_owned(),
        project_id: "project-1".to_owned(),
        database_canonical_path_sha256: canonical_database_path_sha256(database).unwrap(),
        lease_epoch: lease.lease_epoch().to_owned(),
        run_id: Uuid::new_v4(),
        invocation_id: "invocation-1".to_owned(),
        inference_id: Uuid::new_v4(),
        attempt_id: Uuid::new_v4(),
        request_number: 1,
        attempt_number: 1,
        attempt_aggregate_sequence: 1,
        attempt_definition_sha256: hash('a'),
        attempt_evidence_sha256: hash('b'),
        context_compilation_id: Uuid::new_v4(),
        canonical_context_sha256: hash('c'),
        transport_payload_sha256: hash('d'),
        provider: ProviderRunIdentity {
            profile_id: "profile-1".to_owned(),
            provider_id: "provider-1".to_owned(),
            model_id: "model-1".to_owned(),
            config_sha256: hash('e'),
        },
        inference_deadline_at: format_time(now + Duration::minutes(5)),
        attempt_deadline_at: format_time(now + Duration::minutes(2)),
        retry_schedule: None,
        authority: ProviderEffectAuthorityBinding::InitialAgentLoop(
            InitialAgentLoopAuthorityBinding {
                requested_message_id: "attempt-requested-message".to_owned(),
                requested_idempotency_key_sha256: hash('f'),
                requested_at: format_time(now - Duration::seconds(1)),
                agent_loop_aggregate_sequence: 1,
                agent_loop_checkpoint_sha256: hash('1'),
                pending_inference_sha256: hash('2'),
            },
        ),
        issued_at: format_time(now - Duration::seconds(1)),
    }
}

fn retry_schedule_for(
    material: &ProviderEffectGrantMaterial,
    schedule_id: Uuid,
    schedule_sha256: String,
) -> ProviderEffectRetryScheduleBinding {
    ProviderEffectRetryScheduleBinding {
        retry_definition_sha256: hash('8'),
        retry_aggregate_sequence: 3,
        schedule_id,
        schedule_sha256,
        parent_failure_evidence_sha256: hash('7'),
        parent_failure_observation_sha256: hash('6'),
        next_attempt_id: material.attempt_id,
        next_attempt_number: material.attempt_number,
        not_before: material.issued_at.clone(),
        attempt_deadline_at: material.attempt_deadline_at.clone(),
    }
}

fn assert_lock_held(database: &Path, label: &str) {
    assert!(matches!(
        WorkspaceRuntimeLease::acquire(database, label),
        Err(WorkspaceRuntimeLeaseError::AlreadyHeld { .. })
    ));
}

fn assert_redacted_debug(value: &impl std::fmt::Debug) {
    let debug = format!("{value:?}").to_ascii_lowercase();
    assert!(debug.contains("grant_sha256"));
    for forbidden in [
        "workspace-1",
        "project-1",
        "profile-1",
        "provider-1",
        "model-1",
        "lease_epoch",
        "requested_message",
    ] {
        assert!(!debug.contains(forbidden), "debug leaked `{forbidden}`");
    }
}

fn hash(character: char) -> String {
    std::iter::repeat_n(character, 64).collect()
}

fn format_time(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).unwrap()
}

fn parse_time(value: &str) -> OffsetDateTime {
    OffsetDateTime::parse(value, &Rfc3339).unwrap()
}
