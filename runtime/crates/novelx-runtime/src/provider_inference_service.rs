use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use novelx_protocol::{ContextCompilationReceipt, ProviderRunIdentity};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::watch;
use uuid::Uuid;

use crate::context_compile_service::{ContextCompiledRecord, normalized_provider_input_sha256};
use crate::event_journal::{EventJournal, EventJournalError};
use crate::provider_attempt::{
    ProviderAttemptAggregate, ProviderAttemptDefinition, ProviderAttemptError,
    ProviderAttemptFailure, ProviderAttemptMetadata, ProviderAttemptRecovery, ProviderAttemptState,
    ProviderDeliveryCertainty, ProviderResponseReceipt,
};
use crate::provider_gateway::{
    BoundProvider, PreparedProviderInference, ProviderGateway, ProviderGatewayError,
    ProviderInferenceOutcome, ProviderInferenceReceipt, ProviderInferenceRequest, ProviderRegistry,
};
use crate::run_aggregate::{EventMetadata, RunAggregate, RunAggregateError};
use crate::run_state::RunState;

pub struct ProviderInferenceService<'a> {
    journal: &'a mut EventJournal,
    providers: &'a ProviderRegistry,
    gateway: &'a ProviderGateway,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderInferenceExecution {
    pub run_id: String,
    pub attempt_id: String,
    pub inference_id: String,
    pub invocation_id: String,
    pub inference_idempotency_key: String,
    pub attempt_number: u16,
    pub provider: ProviderRunIdentity,
    pub request: ProviderInferenceRequest,
}

pub enum PreparedProviderAttempt {
    Recovered(Box<ProviderInferenceOutcome>),
    Dispatch(Box<ProviderAttemptDispatch>),
}

pub struct ProviderAttemptDispatch {
    execution: ProviderInferenceExecution,
    attempt: ProviderAttemptAggregate,
    prepared: PreparedProviderInference,
    execution_guard: ProviderAttemptExecutionGuard,
}

pub struct DispatchedProviderAttempt {
    execution: ProviderInferenceExecution,
    attempt: ProviderAttemptAggregate,
    result: Result<ProviderInferenceOutcome, ProviderGatewayError>,
    execution_guard: ProviderAttemptExecutionGuard,
}

#[derive(Clone)]
pub(crate) struct ProviderAttemptExecutionGuard {
    lease: Arc<ProviderAttemptExecutionLease>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ProviderAttemptExecutionKey {
    database_path: PathBuf,
    run_id: String,
    attempt_id: String,
}

struct ProviderAttemptExecutionLease {
    key: ProviderAttemptExecutionKey,
}

static ACTIVE_PROVIDER_ATTEMPTS: OnceLock<Mutex<HashSet<ProviderAttemptExecutionKey>>> =
    OnceLock::new();

impl ProviderAttemptExecutionGuard {
    pub(crate) fn acquire(
        journal: &EventJournal,
        run_id: &str,
        attempt_id: &str,
    ) -> Result<Self, ProviderInferenceServiceError> {
        if run_id.trim().is_empty() || attempt_id.trim().is_empty() {
            return Err(ProviderInferenceServiceError::InvalidExecution);
        }
        let key = ProviderAttemptExecutionKey {
            database_path: journal.database_path().to_owned(),
            run_id: run_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
        };
        let mut active = ACTIVE_PROVIDER_ATTEMPTS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .map_err(|_| ProviderInferenceServiceError::AttemptGuardPoisoned)?;
        if !active.insert(key.clone()) {
            return Err(ProviderInferenceServiceError::AttemptInFlight {
                run_id: run_id.to_owned(),
                attempt_id: attempt_id.to_owned(),
            });
        }
        Ok(Self {
            lease: Arc::new(ProviderAttemptExecutionLease { key }),
        })
    }

    fn protects(&self, journal: &EventJournal, run_id: &str, attempt_id: &str) -> bool {
        self.lease.key.database_path == journal.database_path()
            && self.lease.key.run_id == run_id
            && self.lease.key.attempt_id == attempt_id
    }
}

impl Drop for ProviderAttemptExecutionLease {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_PROVIDER_ATTEMPTS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
        {
            active.remove(&self.key);
        }
    }
}

impl<'a> ProviderInferenceService<'a> {
    pub const fn new(
        journal: &'a mut EventJournal,
        providers: &'a ProviderRegistry,
        gateway: &'a ProviderGateway,
    ) -> Self {
        Self {
            journal,
            providers,
            gateway,
        }
    }

    pub async fn execute(
        &mut self,
        execution: ProviderInferenceExecution,
    ) -> Result<ProviderInferenceOutcome, ProviderInferenceServiceError> {
        let prepared = self.prepare_attempt(execution)?;
        self.execute_prepared(prepared).await
    }

    pub(crate) async fn execute_guarded(
        &mut self,
        execution: ProviderInferenceExecution,
        execution_guard: ProviderAttemptExecutionGuard,
    ) -> Result<ProviderInferenceOutcome, ProviderInferenceServiceError> {
        let prepared = self.prepare_attempt_guarded(execution, execution_guard)?;
        self.execute_prepared(prepared).await
    }

    async fn execute_prepared(
        &mut self,
        prepared: PreparedProviderAttempt,
    ) -> Result<ProviderInferenceOutcome, ProviderInferenceServiceError> {
        let dispatch = match prepared {
            PreparedProviderAttempt::Recovered(outcome) => return Ok(*outcome),
            PreparedProviderAttempt::Dispatch(dispatch) => *dispatch,
        };
        let provider = self.providers.resolve(&dispatch.execution.provider)?;
        let dispatched = Self::dispatch_attempt(self.gateway, provider, dispatch).await;
        self.finalize_attempt(dispatched)
    }

    pub fn prepare_attempt(
        &mut self,
        execution: ProviderInferenceExecution,
    ) -> Result<PreparedProviderAttempt, ProviderInferenceServiceError> {
        validate_execution(&execution)?;
        let execution_guard = ProviderAttemptExecutionGuard::acquire(
            self.journal,
            &execution.run_id,
            &execution.attempt_id,
        )?;
        self.prepare_attempt_guarded(execution, execution_guard)
    }

    fn prepare_attempt_guarded(
        &mut self,
        execution: ProviderInferenceExecution,
        execution_guard: ProviderAttemptExecutionGuard,
    ) -> Result<PreparedProviderAttempt, ProviderInferenceServiceError> {
        validate_execution(&execution)?;
        if !execution_guard.protects(self.journal, &execution.run_id, &execution.attempt_id) {
            return Err(ProviderInferenceServiceError::AttemptGuardMismatch);
        }
        let run = RunAggregate::recover(self.journal, &execution.run_id)?;
        if run.state() != RunState::Running {
            if run.state() == RunState::WaitingForReconciliation
                && !self
                    .journal
                    .read_aggregate(
                        &execution.run_id,
                        "provider_attempt",
                        &execution.attempt_id,
                        0,
                    )?
                    .is_empty()
            {
                let existing = ProviderAttemptAggregate::recover(
                    self.journal,
                    &execution.run_id,
                    &execution.attempt_id,
                )?;
                return match existing.state() {
                    ProviderAttemptState::Sent | ProviderAttemptState::OutcomeUnknown => {
                        Err(ProviderInferenceServiceError::OutcomeUnknown)
                    }
                    ProviderAttemptState::Responded => recovered_outcome(&existing)
                        .map(Box::new)
                        .map(PreparedProviderAttempt::Recovered),
                    ProviderAttemptState::Failed => Err(
                        ProviderInferenceServiceError::ExistingTerminal(existing.recovery()),
                    ),
                    ProviderAttemptState::Requested => {
                        Err(ProviderInferenceServiceError::RunNotRunning(run.state()))
                    }
                };
            }
            return Err(ProviderInferenceServiceError::RunNotRunning(run.state()));
        }
        if run.pinned_identity().provider != execution.provider {
            return Err(ProviderInferenceServiceError::PinnedProviderMismatch);
        }
        if !self
            .journal
            .read_aggregate(
                &execution.run_id,
                "provider_attempt",
                &execution.attempt_id,
                0,
            )?
            .is_empty()
        {
            let existing = ProviderAttemptAggregate::recover(
                self.journal,
                &execution.run_id,
                &execution.attempt_id,
            )?;
            return match existing.state() {
                ProviderAttemptState::Responded => recovered_outcome(&existing)
                    .map(Box::new)
                    .map(PreparedProviderAttempt::Recovered),
                ProviderAttemptState::Sent | ProviderAttemptState::OutcomeUnknown => {
                    Err(ProviderInferenceServiceError::OutcomeUnknown)
                }
                ProviderAttemptState::Failed => Err(
                    ProviderInferenceServiceError::ExistingTerminal(existing.recovery()),
                ),
                ProviderAttemptState::Requested => {
                    self.prepare_requested_attempt(execution, existing, execution_guard)
                }
            };
        }
        self.prepare_new_attempt(execution, execution_guard)
    }

    fn prepare_new_attempt(
        &mut self,
        execution: ProviderInferenceExecution,
        execution_guard: ProviderAttemptExecutionGuard,
    ) -> Result<PreparedProviderAttempt, ProviderInferenceServiceError> {
        let persisted = load_persisted_context(
            self.journal,
            &execution.run_id,
            &execution.request.compilation,
        )?;
        let actual_hash = normalized_provider_input_sha256(&persisted.normalized_input)
            .map_err(|_| ProviderInferenceServiceError::ContextNormalizedInputInvalid)?;
        if actual_hash != persisted.normalized_input_sha256 {
            return Err(ProviderInferenceServiceError::ContextNormalizedInputHashMismatch);
        }
        let authoritative_request = ProviderInferenceRequest {
            compilation: persisted.receipt,
            messages: persisted.normalized_input.messages,
            tools: persisted.normalized_input.tools,
        };
        let provider = self.providers.resolve(&execution.provider)?;
        let prepared = self
            .gateway
            .prepare_inference(provider, authoritative_request)?;
        let definition = ProviderAttemptDefinition {
            run_id: execution.run_id.clone(),
            inference_id: execution.inference_id.clone(),
            invocation_id: execution.invocation_id.clone(),
            context_compilation_id: prepared.compilation().compilation_id,
            canonical_context_sha256: prepared.compilation().canonical_context_sha256.clone(),
            transport_payload_sha256: prepared.transport_payload_sha256().to_owned(),
            provider: execution.provider.clone(),
            request_number: prepared.compilation().request_number,
            attempt_number: execution.attempt_number,
            output_reserve_tokens: prepared.compilation().output_reserve_tokens,
            request_timeout_ms: provider.config().request_timeout_ms,
            total_deadline_ms: provider.config().total_deadline_ms,
            max_attempts: provider.config().retry_policy.max_attempts,
            max_total_delay_ms: provider.config().retry_policy.max_total_delay_ms,
        };
        let requested_message_id = Uuid::new_v4().to_string();
        let requested_key = execution.inference_idempotency_key.clone();
        let requested_at = timestamp()?;
        let attempt = ProviderAttemptAggregate::create(
            self.journal,
            &execution.run_id,
            &execution.attempt_id,
            definition,
            current_run_sequence(self.journal, &execution.run_id)?,
            metadata(&requested_message_id, &requested_key, &requested_at),
        )?;
        self.arm_dispatch(execution, attempt, prepared, execution_guard)
    }

    fn prepare_requested_attempt(
        &mut self,
        execution: ProviderInferenceExecution,
        attempt: ProviderAttemptAggregate,
        execution_guard: ProviderAttemptExecutionGuard,
    ) -> Result<PreparedProviderAttempt, ProviderInferenceServiceError> {
        let persisted = load_persisted_context(
            self.journal,
            &execution.run_id,
            &execution.request.compilation,
        )?;
        let actual_hash = normalized_provider_input_sha256(&persisted.normalized_input)
            .map_err(|_| ProviderInferenceServiceError::ContextNormalizedInputInvalid)?;
        if actual_hash != persisted.normalized_input_sha256 {
            return Err(ProviderInferenceServiceError::ContextNormalizedInputHashMismatch);
        }
        let provider = self.providers.resolve(&execution.provider)?;
        let prepared = self.gateway.prepare_inference(
            provider,
            ProviderInferenceRequest {
                compilation: persisted.receipt,
                messages: persisted.normalized_input.messages,
                tools: persisted.normalized_input.tools,
            },
        )?;
        let definition = attempt.definition();
        if definition.inference_id != execution.inference_id
            || definition.invocation_id != execution.invocation_id
            || definition.context_compilation_id != prepared.compilation().compilation_id
            || definition.canonical_context_sha256
                != prepared.compilation().canonical_context_sha256
            || definition.transport_payload_sha256 != prepared.transport_payload_sha256()
            || definition.provider != execution.provider
            || definition.attempt_number != execution.attempt_number
        {
            return Err(ProviderInferenceServiceError::PersistedAttemptMismatch);
        }
        self.arm_dispatch(execution, attempt, prepared, execution_guard)
    }

    fn arm_dispatch(
        &mut self,
        execution: ProviderInferenceExecution,
        mut attempt: ProviderAttemptAggregate,
        prepared: PreparedProviderInference,
        execution_guard: ProviderAttemptExecutionGuard,
    ) -> Result<PreparedProviderAttempt, ProviderInferenceServiceError> {
        let dispatch_id = Uuid::new_v4().to_string();
        let sent_message_id = Uuid::new_v4().to_string();
        let sent_key = format!("{}:sent", execution.attempt_id);
        let sent_at = timestamp()?;
        attempt.mark_sent(
            self.journal,
            current_run_sequence(self.journal, &execution.run_id)?,
            &dispatch_id,
            metadata(&sent_message_id, &sent_key, &sent_at),
        )?;
        #[cfg(feature = "runtime-test-failpoints")]
        crate::runtime_test_failpoint::hit("provider_attempt.sent_before_http");

        Ok(PreparedProviderAttempt::Dispatch(Box::new(
            ProviderAttemptDispatch {
                execution,
                attempt,
                prepared,
                execution_guard,
            },
        )))
    }

    pub async fn dispatch_attempt(
        gateway: &ProviderGateway,
        provider: &BoundProvider,
        dispatch: ProviderAttemptDispatch,
    ) -> DispatchedProviderAttempt {
        let ProviderAttemptDispatch {
            execution,
            attempt,
            prepared,
            execution_guard,
        } = dispatch;
        let result = gateway.infer_prepared(provider, prepared).await;
        #[cfg(feature = "runtime-test-failpoints")]
        crate::runtime_test_failpoint::hit("provider_attempt.response_before_terminal");
        DispatchedProviderAttempt {
            execution,
            attempt,
            result,
            execution_guard,
        }
    }

    pub async fn dispatch_attempt_cancellable(
        gateway: &ProviderGateway,
        provider: &BoundProvider,
        dispatch: ProviderAttemptDispatch,
        cancellation: &mut watch::Receiver<bool>,
    ) -> DispatchedProviderAttempt {
        let ProviderAttemptDispatch {
            execution,
            attempt,
            prepared,
            execution_guard,
        } = dispatch;
        let result = gateway
            .infer_prepared_cancellable(provider, prepared, cancellation)
            .await;
        DispatchedProviderAttempt {
            execution,
            attempt,
            result,
            execution_guard,
        }
    }

    pub fn finalize_attempt(
        &mut self,
        dispatched: DispatchedProviderAttempt,
    ) -> Result<ProviderInferenceOutcome, ProviderInferenceServiceError> {
        Self::finalize_attempt_in(self.journal, dispatched)
    }

    pub fn finalize_attempt_in(
        journal: &mut EventJournal,
        dispatched: DispatchedProviderAttempt,
    ) -> Result<ProviderInferenceOutcome, ProviderInferenceServiceError> {
        let DispatchedProviderAttempt {
            execution,
            mut attempt,
            result,
            execution_guard: _execution_guard,
        } = dispatched;
        match result {
            Ok(outcome) => {
                let response = response_receipt(&execution.provider, &outcome.receipt);
                let responded_message_id = Uuid::new_v4().to_string();
                let responded_key = format!("{}:responded", execution.attempt_id);
                let responded_at = timestamp()?;
                attempt.respond_with_output(
                    journal,
                    current_run_sequence(journal, &execution.run_id)?,
                    response,
                    outcome.text.clone(),
                    outcome
                        .tool_calls
                        .iter()
                        .map(|call| novelx_protocol::ProviderInferenceToolCall {
                            id: call.id.clone(),
                            name: call.name.clone(),
                            arguments: call.arguments.clone(),
                            arguments_sha256: call.arguments_sha256.clone(),
                        })
                        .collect(),
                    metadata(&responded_message_id, &responded_key, &responded_at),
                )?;
                Ok(outcome)
            }
            Err(error) if response_was_received(&error) => {
                let failure = definitive_failure(&error);
                let failed_message_id = Uuid::new_v4().to_string();
                let failed_key = format!("{}:failed", execution.attempt_id);
                let failed_at = timestamp()?;
                attempt.fail(
                    journal,
                    current_run_sequence(journal, &execution.run_id)?,
                    failure,
                    metadata(&failed_message_id, &failed_key, &failed_at),
                )?;
                Err(error.into())
            }
            Err(error) => {
                let cancelled = matches!(error, ProviderGatewayError::Cancelled);
                let unknown_message_id = Uuid::new_v4().to_string();
                let unknown_key = format!("{}:outcome-unknown", execution.attempt_id);
                let unknown_at = timestamp()?;
                attempt.mark_outcome_unknown(
                    journal,
                    current_run_sequence(journal, &execution.run_id)?,
                    Uuid::new_v4(),
                    metadata(&unknown_message_id, &unknown_key, &unknown_at),
                )?;
                let mut run = RunAggregate::recover(journal, &execution.run_id)?;
                if run.state() != RunState::WaitingForReconciliation {
                    let reconciliation_message_id = Uuid::new_v4().to_string();
                    let reconciliation_key = format!("{}:run-reconciliation", execution.attempt_id);
                    run.wait_for_reconciliation(
                        journal,
                        EventMetadata {
                            message_id: &reconciliation_message_id,
                            idempotency_key: &reconciliation_key,
                            created_at: &unknown_at,
                            reason: Some("provider_outcome_unknown"),
                        },
                    )?;
                }
                if cancelled {
                    Err(ProviderInferenceServiceError::CancelledAfterDispatch)
                } else {
                    Err(ProviderInferenceServiceError::DeliveryUnknown(Box::new(
                        error,
                    )))
                }
            }
        }
    }
}

#[derive(Debug, Error)]
pub enum ProviderInferenceServiceError {
    #[error("Provider inference execution is invalid")]
    InvalidExecution,
    #[error("Provider attempt `{attempt_id}` for Run `{run_id}` is already in flight")]
    AttemptInFlight { run_id: String, attempt_id: String },
    #[error("Provider attempt execution guard does not protect this database, Run, and Attempt")]
    AttemptGuardMismatch,
    #[error("Provider attempt execution guard is poisoned")]
    AttemptGuardPoisoned,
    #[error("Provider inference Context Compilation receipt is not persisted for this Run")]
    ContextReceiptNotPersisted,
    #[error("Provider inference identity does not match the provider pinned to this Run")]
    PinnedProviderMismatch,
    #[error("Provider inference requires a running Run, but the Run is {0:?}")]
    RunNotRunning(RunState),
    #[error("Persisted normalized Provider input is invalid")]
    ContextNormalizedInputInvalid,
    #[error("Persisted normalized Provider input hash does not match its content")]
    ContextNormalizedInputHashMismatch,
    #[error("Persisted Provider attempt does not match the reconstructed dispatch")]
    PersistedAttemptMismatch,
    #[error("Provider inference outcome is unknown and cannot be auto-retried")]
    OutcomeUnknown,
    #[error("Provider inference was dispatched but its terminal journal result is unknown")]
    FinalizationOutcomeUnknown,
    #[error("Provider inference was cancelled after dispatch")]
    CancelledAfterDispatch,
    #[error("Provider attempt already ended with {0:?}")]
    ExistingTerminal(ProviderAttemptRecovery),
    #[error("Provider delivery became uncertain: {0}")]
    DeliveryUnknown(Box<ProviderGatewayError>),
    #[error(transparent)]
    Gateway(#[from] ProviderGatewayError),
    #[error(transparent)]
    Attempt(#[from] ProviderAttemptError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    Run(#[from] RunAggregateError),
    #[error(transparent)]
    Time(#[from] time::error::Format),
}

fn validate_execution(
    execution: &ProviderInferenceExecution,
) -> Result<(), ProviderInferenceServiceError> {
    if execution.run_id.trim().is_empty()
        || execution.attempt_id.trim().is_empty()
        || execution.inference_id.trim().is_empty()
        || execution.invocation_id.trim().is_empty()
        || execution.inference_idempotency_key.trim().is_empty()
        || execution.attempt_number == 0
    {
        return Err(ProviderInferenceServiceError::InvalidExecution);
    }
    Ok(())
}

fn load_persisted_context(
    journal: &EventJournal,
    run_id: &str,
    expected: &ContextCompilationReceipt,
) -> Result<ContextCompiledRecord, ProviderInferenceServiceError> {
    let found = journal.read_run(run_id, 0)?.into_iter().find_map(|event| {
        if event.event_type != "context.compiled" || event.event_version != 1 {
            return None;
        }
        serde_json::from_value::<ContextCompiledRecord>(event.payload)
            .ok()
            .filter(|record| record.receipt == *expected)
    });
    found.ok_or(ProviderInferenceServiceError::ContextReceiptNotPersisted)
}

fn recovered_outcome(
    attempt: &ProviderAttemptAggregate,
) -> Result<ProviderInferenceOutcome, ProviderInferenceServiceError> {
    let receipt = attempt
        .response_receipt()
        .ok_or(ProviderInferenceServiceError::InvalidExecution)?;
    let text = attempt.response_text().map(str::to_owned);
    let response_id_sha256 = receipt
        .response_id_sha256
        .as_ref()
        .filter(|value| !value.is_empty())
        .ok_or(ProviderInferenceServiceError::InvalidExecution)?;
    Ok(ProviderInferenceOutcome {
        text,
        tool_calls: attempt
            .tool_calls()
            .iter()
            .map(|call| crate::provider_gateway::ProviderToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
                arguments_sha256: call.arguments_sha256.clone(),
            })
            .collect(),
        receipt: ProviderInferenceReceipt {
            context_compilation_id: attempt.definition().context_compilation_id,
            canonical_context_sha256: attempt.definition().canonical_context_sha256.clone(),
            requested_model_id: attempt.definition().provider.model_id.clone(),
            actual_model_id: receipt.actual_model_id.clone(),
            response_id_sha256: response_id_sha256.clone(),
            response_body_sha256: receipt.response_body_sha256.clone(),
            finish_reason: receipt.stop_reason.clone(),
            usage: crate::provider_gateway::ProviderUsageReceipt {
                input_tokens: receipt.input_tokens,
                output_tokens: receipt.output_tokens,
                total_tokens: receipt.total_tokens,
            },
            provider_request_count: 1,
        },
    })
}

fn response_receipt(
    provider: &ProviderRunIdentity,
    receipt: &ProviderInferenceReceipt,
) -> ProviderResponseReceipt {
    ProviderResponseReceipt {
        http_status: 200,
        actual_provider_id: provider.provider_id.clone(),
        actual_model_id: receipt.actual_model_id.clone(),
        response_id_sha256: Some(receipt.response_id_sha256.clone()),
        response_body_sha256: receipt.response_body_sha256.clone(),
        stop_reason: receipt.finish_reason.clone(),
        input_tokens: receipt.usage.input_tokens,
        output_tokens: receipt.usage.output_tokens,
        total_tokens: receipt.usage.total_tokens,
    }
}

fn response_was_received(error: &ProviderGatewayError) -> bool {
    matches!(
        error,
        ProviderGatewayError::AuthenticationRejected(_)
            | ProviderGatewayError::RateLimited(_)
            | ProviderGatewayError::RedirectRejected(_)
            | ProviderGatewayError::HttpRejected(_)
            | ProviderGatewayError::ResponseMalformed
            | ProviderGatewayError::ResponseTooLarge
            | ProviderGatewayError::ResponseModelMismatch
            | ProviderGatewayError::OutputIncomplete
    )
}

fn definitive_failure(error: &ProviderGatewayError) -> ProviderAttemptFailure {
    let (code, retryable, retry_after, http_status) = match error {
        ProviderGatewayError::AuthenticationRejected(status) => {
            ("PROVIDER_AUTH_REJECTED", false, None, Some(*status))
        }
        ProviderGatewayError::RateLimited(receipt) => {
            let retry_after_ms = receipt
                .retry_after
                .as_ref()
                .map(|retry_after| retry_after.delay_ms);
            (
                "PROVIDER_RATE_LIMITED",
                retry_after_ms.is_some(),
                receipt.retry_after.clone(),
                Some(receipt.status),
            )
        }
        ProviderGatewayError::RedirectRejected(status) => {
            ("PROVIDER_REDIRECT_REJECTED", false, None, Some(*status))
        }
        ProviderGatewayError::HttpRejected(receipt) => {
            let retryable = matches!(receipt.status, 500 | 502 | 503 | 504);
            let retry_after = if retryable {
                receipt.retry_after.clone()
            } else {
                None
            };
            (
                "PROVIDER_HTTP_REJECTED",
                retryable,
                retry_after,
                Some(receipt.status),
            )
        }
        ProviderGatewayError::ResponseMalformed => {
            ("PROVIDER_RESPONSE_MALFORMED", false, None, Some(200))
        }
        ProviderGatewayError::ResponseTooLarge => {
            ("PROVIDER_RESPONSE_TOO_LARGE", false, None, Some(200))
        }
        ProviderGatewayError::ResponseModelMismatch => {
            ("PROVIDER_MODEL_MISMATCH", false, None, Some(200))
        }
        ProviderGatewayError::OutputIncomplete => {
            ("PROVIDER_OUTPUT_INCOMPLETE", false, None, Some(200))
        }
        _ => unreachable!("only definitive response failures are converted"),
    };
    ProviderAttemptFailure {
        code: code.to_owned(),
        retryable,
        retry_after_ms: retry_after.as_ref().map(|value| value.delay_ms),
        retry_after,
        http_status,
        delivery_certainty: ProviderDeliveryCertainty::ResponseReceived,
        diagnostic_id: Uuid::new_v4(),
    }
}

fn current_run_sequence(journal: &EventJournal, run_id: &str) -> Result<u64, EventJournalError> {
    Ok(journal
        .read_run(run_id, 0)?
        .last()
        .map_or(0, |event| event.run_sequence))
}

fn metadata<'a>(
    message_id: &'a str,
    idempotency_key: &'a str,
    created_at: &'a str,
) -> ProviderAttemptMetadata<'a> {
    ProviderAttemptMetadata {
        message_id,
        idempotency_key,
        created_at,
        reason: None,
    }
}

fn timestamp() -> Result<String, time::error::Format> {
    OffsetDateTime::now_utc().format(&Rfc3339)
}
