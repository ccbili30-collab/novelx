# ADR-0014: Provider Retry Lineage and Agent Loop Rebinding（模型重试谱系与智能体循环重绑定）

Status: accepted foundation; live retry scheduling and dispatch integration incomplete
Date: 2026-07-13

## Context

A Provider Attempt（模型尝试）represents one network operation that may cross an external side-effect boundary. Reusing a terminal Attempt for a retry would erase whether a particular request was sent, charged or answered. Conversely, treating every retry as an unrelated inference would lose the shared deadline, retry budget, source context and Agent Loop（智能体循环）identity.

The existing Runtime assumed that one inference request had exactly one Attempt. That assumption existed in the Agent Loop checkpoint, recovery scanner and desktop Host（宿主）terminal-identity checks. A safe retry therefore requires a separate inference-level lineage and an explicit rebinding from the failed Attempt to the next Attempt.

HTTP failures also lacked durable waiting evidence. The Gateway discarded `Retry-After` and marked every 5xx plus malformed 200 responses retryable. That classification was too broad for automatic external side effects.

## Decision

1. One `provider_attempt` aggregate continues to represent exactly one possible Provider network operation. Its terminal state remains immutable.
2. A separate `provider_retry` aggregate, addressed by Run and inference ID, owns the multi-Attempt lineage, shared deadline, explicit retry policy, cumulative delay, deterministic schedule and terminal retry result.
3. The retry aggregate uses append-only states:
   - `FailureObserved`;
   - `Scheduled`;
   - `Materializing`;
   - `AwaitingAttempt`;
   - `Succeeded / FailedTerminal / OutcomeUnknown / Cancelled / Exhausted`.
4. Only a definite response failure can enter automatic scheduling in the current policy:
   - HTTP 429 with one syntactically valid `Retry-After`, including zero seconds;
   - HTTP 500, 502, 503 or 504;
   - 503 may carry a valid `Retry-After` minimum.
5. HTTP 501, 505 and other unlisted statuses are not automatically retryable. A malformed, oversized, incomplete or model-mismatched 200 response is also not automatically retryable. Timeout, disconnect and cancellation after `provider.sent` remain `OutcomeUnknown` and are never scheduled.
6. `Retry-After` accepts delta-seconds and all HTTP-date wire formats. NovelX stores only the exact value SHA-256, parsed kind and normalized delay milliseconds; it does not persist the raw header.
7. Duplicate, invalid, non-UTF-8, oversized or contradictory `Retry-After` headers do not authorize a rate-limit retry.
8. Schedules use an explicit `exponential_full_jitter_v1` policy, a shared absolute deadline, cumulative delay budget, deterministic full-jitter value, stable UUIDv5 schedule ID, stable UUIDv5 next Attempt ID and a canonical schedule SHA-256.
9. `selectedDelay = max(jitterDelay, retryAfterDelay)`. A schedule is exhausted instead of shortened when it exceeds maximum Attempts, total delay or the shared deadline.
10. The Agent Loop has one special same-phase event, `agent_loop.inference_retried`, which replaces the pending Attempt while remaining `AwaitingProvider`. It requires the same inference, request number and context compilation, exactly the next Attempt number, a new Attempt ID, a new idempotency key and exact schedule/parent-evidence hashes.
11. Ordinary same-phase Agent Loop transitions remain invalid. Retry rebinding persists the complete binding plus its own hash and strictly replays the previous checkpoint, binding and next checkpoint.
12. Old Attempt completion is rejected after rebinding; only the newly bound Attempt can complete the Agent Loop.
13. Provider Config schema v1 does not define an executable jitter policy. The presence of this aggregate does not silently enable automatic retry for existing profiles.

## Consequences

- NovelX can represent and audit multiple Attempts for one inference without weakening the one-Attempt/one-side-effect rule.
- A retry schedule and next Attempt identity are deterministic across process restarts.
- The model, UI and Provider response body cannot choose retryability or mutate the retry chain.
- Rate-limit guidance is auditable without retaining an unbounded raw header.
- The Runtime now has a safe Agent Loop rebinding primitive, but no live component invokes it yet.

## Explicitly Unfinished

- Provider Config schema v2 and settings UI for explicit retry strategy parameters.
- Provider Retry Service（模型重试服务）and Supervisor（监督器）that observe Attempts, create schedules and materialize new Requested Attempts.
- Operational Recovery gates, Claims and crash recovery for retry materialization.
- A one-shot Provider dispatch capability that prevents lower-level Gateway bypass.
- Absolute-deadline request-timeout reduction at the final send boundary.
- Runtime timer wake-up; `provider.bind` must not sleep through backoff.
- `provider.inference.retrying` Host protocol event and desktop active-identity update.
- Recovery scanner validation of legitimate multi-Attempt chains versus forks/orphans.
- Real 429-then-200, restart, crash-window and no-resend black-box tests.
- Verified Provider-side idempotency/result lookup. `Sent / OutcomeUnknown` therefore remains blocked from automatic resend.

## Rejected Alternatives

- Reusing the failed Attempt: it destroys per-network-operation delivery evidence.
- Writing retry facts only into Operational Recovery: orchestration claims are not the authority for retry budgets or lineage.
- Letting `provider.bind` authorize or immediately repeat requests: credentials are not side-effect permission.
- Treating all 5xx or malformed 200 responses as retryable: that silently invents Provider policy.
- Sleeping inside bind or command handling: it blocks the Runtime actor and is not restart-safe.
