# Runtime V2 Recovery Provider Effect Issuer（恢复模型副作用签发器）

Date: 2026-07-13

## Implemented

- Added a dedicated Operational Recovery（运行恢复）issuer for a persisted `Requested` Provider Attempt（模型尝试）.
- Reconstructs and validates the Run, Agent Loop, current and initial Context, Provider config, recovery Operation/Claim/Execution/Action, Attempt evidence and workspace lease.
- Supports the persisted `OriginalOwner`（原所有者）and `ResumeAuthorized`（授权恢复者）authority paths.
- Binds the recovery revision/hash, fencing token, action hash and the complete canonical resume-authorization hash into the grant receipt.
- Reuses the original absolute Provider deadline instead of extending it from restart time.
- Validates retry parent evidence, schedule, binding, not-before and deadline for Attempt numbers above one.
- Retains the exact `Arc<WorkspaceRuntimeLease>` in the Provider Effect Capability（模型副作用能力凭证）.
- Keeps final authorization construction sealed inside the live-authorizer module; other Runtime modules cannot assemble a sendable authorization from crate-visible parts.

## Verification

- Recovery issuer tests: 6/6 passed.
- Covers original owner, persisted resume authorization, retry Attempt 2, wrong workspace lease, tampered action, non-Requested Attempt, expired deadline and missing action.
- Every successful issuer test observes zero new Attempt events; the issuer neither writes `provider.sent` nor performs HTTP.
- `cargo clippy -p novelx-runtime --all-targets -- -D warnings`: passed.
- `cargo fmt --all -- --check` and `git diff --check`: passed.

## Explicitly Unfinished

- `ProviderDispatchRecoveryService`（模型派发恢复服务）does not call this issuer yet.
- The legacy `execute_guarded -> mark_sent v1 -> infer_prepared` recovery bypass still exists and can still perform the recovery network effect.
- The recovery cancellation signal, authorized crash killpoints and no-duplicate HTTP pressure tests are not complete.
- Legacy Gateway and Provider service send entries are not sealed or removed.

## Completion Boundary

This batch proves that a recovery capability can be derived from durable evidence without sending or writing. It does not make Operational Recovery authorized until the recovery service is rewired and the old bypass is removed.
