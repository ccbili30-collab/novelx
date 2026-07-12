# Runtime V2 Workspace Lease and Claim Transfer（第二版运行时工作区租约与领取转移）

## Implemented

- Added a database-adjacent OS-backed exclusive `WorkspaceRuntimeLease（工作区运行时租约）`.
- Runtime initialization acquires and retains the lease before opening recovery state. A second process for the same database emits `WORKSPACE_RUNTIME_LEASE_UNAVAILABLE` and never reaches `runtime.ready`.
- Lock metadata contains only Runtime instance ID, process ID and acquisition time. The lock file is retained after shutdown; OS lock ownership is authoritative.
- Claim creation and execution start now require a lease that protects the exact workspace database.
- Added persisted `ClaimTransferred（领取已转移）` events.
- Transfer requires:
  - a fresh structural and operational scan;
  - unchanged operation/source evidence;
  - old lease expiry;
  - no `ExecutionStarted` event;
  - exclusive ownership of the exact workspace lock;
  - unchanged executor/action identity;
  - fencing token increment by exactly one.
- Old owner write-back is rejected after transfer.

## Verification

- Real two-process handshake test proves only one Runtime reaches `runtime.ready`; after the first exits, a third process acquires the same workspace successfully.
- Lease tests prove second-owner rejection, release on drop, metadata persistence and invalid-parent rejection.
- Aggregate tests prove expired/unstarted transfer, exact token increment, old-fence rejection and permanent transfer rejection after execution starts.
- Service test performs a real one-second expiry and transfers to the newly locked Runtime owner.
- Full Rust workspace tests pass.

## Not Complete

- Evidence changes before execution return a typed stale error but are not yet persisted as a `Stale` terminal event.
- The retained lock metadata is diagnostic only; stale metadata must never be interpreted as a live owner.
- No automatic Recovery Supervisor（恢复监督器）claims, renews, transfers or starts operations.
- No local recovery executor consumes the execution lifecycle.
- Provider and Tool external effects remain disabled and unretried.
- Process termination between each lifecycle/effect boundary is not yet exhaustively tested.

This batch proves exclusive Runtime ownership and safe pre-execution transfer. It does not complete automatic recovery or multi-Agent scheduling.
