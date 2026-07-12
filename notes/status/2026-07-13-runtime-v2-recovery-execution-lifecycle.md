# Runtime V2 Recovery Execution Lifecycle（第二版运行时恢复执行生命周期）

## Implemented

- Added persisted `LeaseRenewed（租约续期）`, `ExecutionStarted（执行开始）` and `ExecutionFinished（执行结束）` recovery events with strict hash-chain replay.
- Added three non-dispatch effect classes: local deterministic continuation, persisted Provider-result projection and verified Tool-result projection.
- Execution identity pins Claim ID, owner Runtime instance, fencing token, source fingerprint, action specification hash and effect class.
- Runtime-generated Claim time replaced caller-supplied timestamps. Initial lease duration is bounded to 1–300 seconds.
- Renewal requires the same Claim/owner/token, must happen before the old expiry, must extend the expiry and cannot exceed the five-minute policy window.
- Execution start requires a fresh structural/operational scan, matching operation, current Claim fence and global-clock CAS.
- Added immutable terminal outcomes:
  - `Succeeded（成功）` requires a result-manifest hash and final-checkpoint hash.
  - `FailedSafe（安全失败）` requires an error code and evidence hash.
  - `OutcomeUnknown（结果未知）` requires a reason code and evidence hash.
- Conflicting terminal write-back, wrong owner/fence, expired start and unverified success fail closed.

## Verification

- Focused aggregate tests cover Claim → renew → start → success, semantic terminal idempotency, wrong fence, expired renewal/start, missing manifest hash and immutable unknown outcome.
- Service tests cover server lease policy, fresh start scan and wrong-owner rejection.
- Existing Claim concurrency, global mutation clock and recovery scanner tests remain enabled.

## Not Complete

- Claim transfer is intentionally absent. It requires proof that the old owner is dead and is allowed only before execution starts.
- Stale operation terminalization before execution is not yet implemented.
- No background Recovery Supervisor（恢复监督器）claims or starts operations automatically.
- No local recovery executor consumes the execution record yet.
- `FailedSafe` stores an evidence hash but the dedicated no-side-effect proof manifest validator is not implemented.
- Provider and Tool dispatch remain disabled. A Provider `Sent` or Tool `Running` state still requires reconciliation and is never retried automatically.
- Real process-kill tests between execution events and effect evidence have not passed.

This batch completes the persisted lifecycle primitive and fresh start gate. It does not complete automatic recovery execution or multi-Agent allocation.
