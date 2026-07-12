# Runtime V2 Fenced Recovery Claim Foundation（第二版运行时带隔离令牌的恢复领取地基）

## Implemented

- Added SQLite migration 0005 with a shared mutation clock advanced by both Runtime events and Workspace events.
- Added guarded Workspace append using an expected global sequence. An intervening event in either journal fails closed with `GlobalSequenceConflict`.
- Added persisted `OperationalRecoveryClaim（运行恢复领取）` identity containing owner instance, fencing token, exact source fingerprint, executor version, action specification hash and lease timestamps.
- Claim identity is canonical SHA-256 and is strictly replay-validated.
- Only `RecoveryReady（恢复就绪）` operations without Waiting/Quarantined disposition are claimable.
- First ownership uses fencing token 1. A second owner cannot replace it, while an identical retry is semantically idempotent.
- Added ADR-0012 documenting source-snapshot CAS, fencing and side-effect restrictions.

## Verification

- Tests prove the global clock observes both event journals.
- Tests prove stale global snapshots cannot append a guarded event.
- Tests prove ready Claims survive replay, identical retries do not append, another owner conflicts, and non-ready operations cannot be claimed.
- Full Rust workspace tests pass after the migration and aggregate changes.

## Not Complete

- No Claim coordinator performs the required fresh structural and operational rescan yet.
- No Runtime supervisor automatically claims candidates.
- No lease renewal, release, transfer, stale, execution-started or terminal execution events exist yet.
- No executor consumes Claims, and no Provider or Tool side effect is enabled by this batch.
- Fencing is persisted but has not yet been enforced on executor write-back because the executor does not exist.
- Real two-process Claim races and kill/restart side-effect windows are not yet black-box tested.

This batch creates a safe ownership primitive and cross-journal mutation boundary. It does not complete claimed recovery execution or automatic Agent allocation.
