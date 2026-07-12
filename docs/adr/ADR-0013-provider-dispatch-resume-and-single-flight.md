# ADR-0013: Provider Dispatch Resume Authorization and Single-Flight（模型派发恢复授权与单航班协调）

Status: accepted foundation; retry and external reconciliation incomplete  
Date: 2026-07-13

## Context

A persisted `ProviderAttempt` can be recovered in five states. Only `Requested（已请求、未发送）` proves that the transport boundary was not crossed. `Sent（已发送）` and `OutcomeUnknown（结果未知）` cannot be re-sent safely unless the selected Provider has a separately verified external idempotency or result-lookup contract.

An `OperationalRecoveryExecution` is owned by the Runtime instance that started it. A restarted process receives a new exclusive workspace lease and must not impersonate the previous owner. The existing local-projection resume permission cannot authorize a Provider side effect.

Within one process, the normal Provider path, Live Agent Loop（实时智能体循环）and recovery path could otherwise race on the same Attempt. A recovery caller that observes another caller's in-flight `Sent` state must wait; it must not prematurely persist `OutcomeUnknown`.

## Decision

1. Provider recovery uses a dedicated `ProviderDispatchResumeAuthorization`; it is not an extension of local deterministic resume.
2. An authorization binds operation, execution, Claim, original owner, new resumer, fencing token, action hash, Attempt ID/state/sequence, definition hash, evidence hash, derived capability, prior authorization, generation and authorization time.
3. Runtime derives the capability from persisted Attempt state. Host, UI and model cannot select it:
   - `Requested -> DispatchRequested`;
   - `Sent / OutcomeUnknown -> FinalizeOutcomeUnknown`;
   - `Responded -> FinalizeResponded`;
   - `Failed -> FinalizeFailed`.
4. Only the latest authorization generation is valid. Generations form a previous-ID chain, evidence sequence cannot move backward, terminal evidence cannot return to `Requested`, identical sequence cannot change evidence and authorization time cannot move backward.
5. The authorization service reads the exact persisted action and Attempt, validates all pinned hashes, checks one global event-clock snapshot and appends through CAS. An identical authorization may be returned only after the same stability check.
6. A new Runtime may dispatch only when its latest authorization still matches an exact `Requested` Attempt. Any evidence change invalidates the authorization and requires a new scan/authorization.
7. `Sent`, `OutcomeUnknown`, `Responded` and `Failed` recovery performs no Provider resolution, credential access or network request.
8. All in-process Provider execution entries share one RAII single-flight guard keyed by canonical database path, Run ID and Attempt ID. The guard spans preparation, `provider.sent`, HTTP, finalization and recovery outcome write-back.
9. A guard loser returns `PROVIDER_ATTEMPT_IN_FLIGHT`; it does not infer an unknown outcome from another caller's `Sent` state.
10. Cross-process exclusivity continues to rely on the operating-system workspace lease plus durable event CAS. Process-local single-flight is not presented as a distributed lock.
11. Provider dispatch Supervisor execution is separate from local projection execution. It may claim/start `ProviderDispatchReady`, authorize a new Runtime, wait for a current Attempt owner, or consume terminal Attempt evidence. It does not execute local projection or Tool effects.
12. Temporary missing Provider binding leaves `Requested` and its recovery execution unfinished. It must not create `Requested + FailedSafe` or mark the reusable deterministic operation stale.
13. Provider recovery crash tests use a debug-only `runtime-test-failpoints` feature. Release builds reject that feature at compile time, so a test pause point cannot enter a distributable Runtime.
14. The crash matrix kills the exact Runtime child process after ExecutionStarted/Requested, after durable `provider.sent` but before HTTP, after a real HTTP response but before terminal evidence, and after all recovery writes but before the Host receives `provider.bound`.

## Consequences

- A crash before `provider.sent` can be resumed once by a newly authorized Runtime.
- A crash after `provider.sent` is conservatively reconciled as unknown unless durable response evidence already exists.
- The normal inference path and recovery path cannot both own one Attempt in the same process.
- A Provider bind can safely trigger the effect-specific recovery Supervisor, followed by the local persisted-result projection Supervisor.
- False-unknown remains possible when a process dies after writing `provider.sent` but before the HTTP request actually leaves, or after receiving a response but before persisting it. Avoiding that requires Provider-side idempotency/result lookup, not local guessing.

## Explicitly Unfinished

- `Failed(retryable=true)` durable backoff and new Attempt creation.
- Provider-specific external idempotency and result lookup capability registry.
- Tool dispatch ownership and recovery.

## Rejected Alternatives

- Reusing local projection resume: it would silently expand a no-new-effect permission into a network permission.
- Retrying every nonterminal Attempt: `Sent` does not prove that the Provider did not charge or execute.
- Recovery-only in-memory lock: normal and Live Agent paths could still race it.
- Treating Provider timeout as not sent: timeout gives no delivery certainty.
