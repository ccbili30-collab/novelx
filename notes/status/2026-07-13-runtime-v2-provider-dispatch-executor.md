# Runtime V2 Provider Dispatch Executor Checkpoint

Date: 2026-07-13

## Completed in this checkpoint

- Added a typed `ProviderDispatchRecoveryService` for an already-claimed and already-started `ProviderDispatch` execution.
- A `Requested` Provider Attempt is reconstructed only from persisted Run, Agent Loop, Context Compilation, action and Provider Attempt evidence.
- The action pins and verifies invocation, inference, compilation, Provider identity, canonical context hash, transport payload hash, loop checkpoint and Attempt sequence.
- `Responded`, `Failed`, `Sent` and `OutcomeUnknown` are consumed evidence-first without requiring current Provider binding or network access.
- `Sent` and `OutcomeUnknown` are never automatically re-sent.
- A pre-transport failure leaves the Attempt `Requested` and leaves the recovery execution unfinished; it no longer creates the dead state `Requested + FailedSafe`.
- Provider dispatch completion writes a typed manifest hash, the Provider Attempt evidence hash and the pinned Agent Loop checkpoint as separate values.
- Existing outcomes are verified instead of being silently accepted.
- A process-local per-execution single-flight guard prevents a concurrent caller from marking an in-flight HTTP request `OutcomeUnknown` before the first caller persists its response.
- Added seven real SQLite plus local TCP tests covering successful dispatch and terminal re-entry, persisted Sent/Responded evidence, HTTP 401, missing binding before transport, lease/fence rejection and concurrent execution.

## Verification

- `cargo test --workspace`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `provider_dispatch_recovery_service`: 7/7 integration tests passed.

## Explicitly not completed

- A new Runtime instance cannot yet resume a `ProviderDispatch` execution owned by the previous process. A dedicated Provider-dispatch resume authorization is required; the local projection resume permission must not be reused.
- No Provider Dispatch Supervisor is connected to `provider.bind` or startup yet.
- `Failed(retryable=true)` has no durable backoff, new Attempt creation or retry scheduler.
- `Sent/OutcomeUnknown` cannot be reconciled automatically without a verified Provider-side idempotency or result-lookup capability.
- Pre-transport blocked diagnostics are typed in-process but are not yet persisted as auditable Artifact records.
- Tool dispatch recovery, oh-my-pi audit, NovelX domain agents, long-term memory, graph retrieval and desktop reconnection remain unfinished.

## Risk statement

This is a tested executor foundation, not a complete Provider recovery loop and not a complete Harness. Connecting it to live startup before dedicated cross-process resume authorization exists would strand executions after a crash, so live wiring remains intentionally blocked.
