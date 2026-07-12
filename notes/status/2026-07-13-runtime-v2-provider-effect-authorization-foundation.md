# Runtime V2 Provider Effect Authorization Foundation（模型副作用授权地基）

Date: 2026-07-13

## Implemented Foundation

- Added an authoritative Agent Loop snapshot generated only by journal replay.
- Snapshot evidence includes the exact pending inference, canonical pending hash, persisted checkpoint hash, retry binding, producer event time and `PendingInferenceOrigin`（待推理来源）.
- `Created`, `InferenceStarted` and `InferenceRetried` origins are derived from validated event history. Ordinary transitions that leave `AwaitingProvider` clear the pending authority evidence.
- Agent Loop event timestamps used for authorization are validated as RFC 3339. A tampered invalid timestamp fails closed.
- Initial and new non-retry inference rounds must start at Attempt 1. Attempts above 1 require the last legal retry transition.
- Added the move-only Provider effect lifecycle: capability -> consumed -> armed -> dispatched. The live workspace lease is retained across the lifecycle.
- Added EventJournal append outcomes and atomic global/Run/aggregate CAS for the authorized Sent write.
- Added ProviderAttempt Sent event version 2 with the exact durable authorization receipt and strict replay validation.
- Added `LiveAgentLoopRunner::ensure_awaiting_provider`, including first-loop creation, restart-safe idempotency, authoritative identity checks and fail-closed handling for non-matching or non-awaiting loops.
- Runner tests prove that a pre-created loop can accept a persisted plain-text Provider outcome and persist Agent Loop `Completed` without creating a duplicate loop.

Targeted evidence from the completed constituent batches:

- Agent Loop journal tests: 19/19 passed.
- Live Agent Loop runner tests: 7/7 passed.
- Targeted Clippy with `-D warnings`: passed for those batches.
- Targeted diff checks: passed.

These are constituent-batch results, not a full integrated Runtime acceptance run.

## Implemented and Target-Verified Foundation

- `ProviderEffectCapability` material and structural validation.
- ProviderAttempt authorized Sent v2 append and replay.
- Live Provider Effect Issuer（实时模型副作用签发器）that reads Agent Loop, Attempt, Context, Provider and Retry evidence and prepares exact global/Run/Attempt CAS outputs.
- Initial / continuation / retry origin enforcement using validated `Created` / `InferenceStarted` / `InferenceRetried` history.
- Agent Loop project, source-scope and permission comparison against the Run pin.
- Current and initial Context source-command validation for invocation, request number, Provider and Context policy.
- Retry parent recovery against the real terminal Failed `ProviderAttempt`, including failure, sequence and definition/evidence hashes.
- Gateway Prebuild（网关预构建）of the complete HTTP request before Sent, including URL, headers, body and request timeout without exposing the credential.

These paths must not be described as a sealed live boundary until caller wiring and integrated network/restart tests pass.

## P0 Findings Closed in This Batch

1. Continuation authority now requires an event-derived `InferenceStarted` origin. A forged request-two `Created` checkpoint is rejected.
2. Retry authority now recovers and verifies the actual Failed parent `ProviderAttempt`; missing and fabricated parent evidence is rejected.
3. Issuance now binds Context source-command provenance and Agent Loop project/source-scope/permission to the current Run pins.

Targeted integrated evidence:

- Live Provider Effect Issuer tests: 9/9 passed.
- Provider Effect Capability tests: 10/10 passed.
- Provider Attempt legacy integration: 11/11 passed.
- Gateway transport and prebuild tests: 18/18 passed.
- Agent Loop journal tests: 19/19 passed.
- Live Agent Loop runner tests: 7/7 passed.
- Combined targeted Clippy with `-D warnings`: passed.

## Explicitly Unfinished

- Service / Gateway sealing（服务与网关封口）and removal or blocking of every legacy Provider send entry.
- `main.rs` wiring before the first Provider network request.
- Recovery Issuer（恢复签发器）and restarted Requested-attempt integration.
- Host multi-round identity（宿主多轮身份）for continuation and assist/resume paths.
- Real Provider network verification and exact-process kill tests around capability consumption, Sent v2, HTTP and terminal persistence.
- Provider Retry V2 configuration（第二版重试配置）with a versioned authoritative algorithm and delay policy.
- Bounded re-authorization after unrelated workspace-global CAS changes.
- Typed Host/UI errors for NotBefore, expired deadline, evidence change and authorization mismatch.
- Runtime subprocess tests and third-party Provider tests for the sealed live path.

## Combined Batch Verification

- `cargo test --workspace --no-fail-fast`: passed.
- `cargo fmt --all -- --check`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `npm run typecheck`: passed.
- Vitest: 85 files passed, 1 skipped; 406 tests passed, 10 skipped.
- `git diff --check`: passed.

The Rust workspace result verifies the current foundation and its compatibility with the existing
Runtime tests. It is not evidence that the unsealed legacy Gateway entries have disappeared, and it
does not substitute for a real Provider process-kill test.

## Completion Boundary

This checkpoint establishes the evidence types and durable Sent boundary needed to prevent an ordinary code path from sending a Provider request without explicit Runtime authority. It does not yet prove that every live or recovery network path uses that boundary. It does not close Provider retry lineage, recovery issuance, main-process wiring or crash-safe end-to-end transport.
