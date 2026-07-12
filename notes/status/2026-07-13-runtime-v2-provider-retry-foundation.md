# Runtime V2 Provider Retry Foundation

Date: 2026-07-13

## Implemented

- Added `ProviderRetryAfterReceipt` with bounded parsing for delta-seconds and HTTP-date, exact raw-value hash, parsed kind and normalized delay.
- Provider HTTP errors now carry a typed failure receipt instead of only a status integer.
- Duplicate or invalid `Retry-After` values are not treated as retry guidance.
- HTTP retry classification is now conservative:
  - 429 requires valid guidance;
  - only 500, 502, 503 and 504 are eligible definite server failures;
  - malformed 200 responses are not retryable;
  - unknown delivery remains nonretryable.
- Provider Attempt failure evidence persists the structured retry-after receipt and verifies that its hash and delay agree with the legacy `retryAfterMs` field. Old events without the optional receipt still replay.
- Added an append-only `provider_retry` aggregate with deterministic full-jitter scheduling, UUIDv5 schedule/Attempt identities, shared deadline and delay budget, strict failure allowlist, exact evidence hashes, terminal states and idempotent replay.
- Added an Agent Loop retry binding and the only legal `AwaitingProvider -> AwaitingProvider` event. It replaces only the pending Attempt identity and rejects old completion afterward.

## Safety boundaries retained

- This code does not send a retry request.
- `Sent / OutcomeUnknown` cannot enter automatic scheduling.
- Existing Provider Config v1 profiles do not silently gain a retry algorithm.
- The model and Host cannot construct retry events through a public Runtime command.
- No raw `Retry-After` header or Provider credential is stored in retry events.

## Verification

- Full Rust workspace tests passed.
- Full Rust workspace Clippy with `-D warnings` passed.
- Provider retry aggregate black-box matrix: 10/10 passed, including raw event corruption, identity changes, sequence gaps, unknown versions/types, attempt-number rollback/jumps, deadline and delay budgets, time rollback, invalid failure classes, second terminal writes and idempotency conflicts.
- Agent Loop retry service/journal tests: 22/22 passed.
- Provider inference transport tests: 15/15 passed.
- Provider inference service tests: 15/15 passed.
- Provider inference protocol tests: 7/7 passed.
- TypeScript typecheck passed.
- Vitest passed 85 files with 1 skipped; 406 tests passed with 10 skipped.

The first verification attempt ran the entire Rust suite, TypeScript compiler and all Vitest workers concurrently. Five unrelated JavaScript tests exceeded their fixed five-second limit and two workers timed out during shutdown. The same unmodified tree then passed with one Vitest worker and unchanged timeouts, so the recorded evidence is the serialized run rather than the overloaded run.

## Not completed

- No Provider Retry Service, timer, Operational Recovery claim, one-shot dispatch capability, Host retrying event, scanner chain validation or live black-box retry exists yet.
- The desktop Host still recognizes only the initially accepted Attempt.
- The recovery scanner still treats multiple Attempts for one inference as conflicting until the retry-chain validator is connected.
- No external Provider currently has verified POST idempotency or result lookup, so unknown delivery cannot be automatically resent.

## Completion boundary

This checkpoint is a persistence, classification and Agent Loop identity foundation. It must not be described as live automatic retry or a complete Provider recovery loop.
