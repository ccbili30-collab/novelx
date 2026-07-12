# Runtime V2 Stale Recovery Operation（第二版运行时过期恢复操作）

## Implemented

- Added immutable `StaleMarked（已标记过期）` recovery events.
- Stale evidence records expected and actual operation IDs/source fingerprints, current Claim ID/token when present, exclusive detector Runtime instance, detection time and the exact global scan sequence.
- Claim, renewal, transfer and execution start reject an operation after it becomes Stale.
- Claim/start/transfer services now use a stable scan even when the resulting gate is not `RecoveryReady`.
- If the fresh operation differs, the service atomically marks the old operation Stale using the scan global sequence and returns `OperationMarkedStale`.
- The Stale transition requires the workspace Runtime lock and is allowed only before `ExecutionStarted`.
- Evidence changes after execution starts fail the Stale transition and remain subject to outcome/reconciliation rules.

## Verification

- Service test changes exact Provider binding, proves the old operation is persisted Stale, and proves restoring the old binding cannot revive it.
- Aggregate tests cover claimed/unstarted Stale transition, semantic retry, subsequent execution rejection and rejection after execution has started.
- Hash-chain replay validates every Stale field and claim-fence pairing.

## Not Complete

- Recovery Supervisor（恢复监督器）does not yet automatically scan and schedule candidates.
- No local-only executor consumes `ExecutionStarted` operations.
- Stale projection is not yet exposed over Runtime RPC（运行时远程过程调用）or desktop UI（桌面界面）.
- Provider/Tool external side effects remain disabled and unretried.
- Full process-kill testing around execution/effect boundaries is still pending.

This batch closes pre-execution stale evidence handling. It does not complete automatic recovery or multi-Agent scheduling.
