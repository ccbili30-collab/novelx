# ADR-0012: Fenced Operational Recovery Claim（带隔离令牌的运行恢复领取）

Status: accepted foundation; execution integration incomplete
Date: 2026-07-13

## Context

`RecoveryReady（恢复就绪）` only proves that persisted evidence currently permits a continuation candidate. It does not grant execution ownership. A Provider bind handler, UI command or restarted process must not infer ownership from an in-memory gate and continue a Run directly.

Recovery evidence spans both `runtime_events` and `workspace_events`. A Claim written only against the recovery stream revision can race with a Run, ToolCall, ProviderAttempt or Assignment mutation and therefore authorize stale evidence.

## Decision

1. Recovery observations remain immutable operations identified by policy version and source fingerprint.
2. A Claim persists the operation, owner runtime instance, monotonic fencing token, source fingerprint, executor version, action specification hash and bounded lease timestamps.
3. Only a `RecoveryReady` operation with no Waiting/Quarantined disposition can be claimed. The first Claim uses fencing token `1`; later transfer/renewal semantics require a separate reviewed transition.
4. Migration `0005_global_event_clock.sql` advances one SQLite mutation clock for every append to either authoritative event table.
5. Claim append uses the caller-supplied global clock as a CAS boundary. Any intervening Runtime or Workspace event rejects the Claim and requires a fresh structural and operational scan.
6. A persisted Claim alone does not authorize Provider or Tool side effects. Executor lifecycle and effect-specific dispatch evidence must be added before automatic continuation.
7. Lease expiry never proves that an external side effect did not happen. Provider `Sent / OutcomeUnknown` and Tool `Running` without a verified terminal manifest remain reconciliation cases.

## Consequences

- A stale startup map cannot safely create a Claim.
- Concurrent claimers cannot both append against the same global event snapshot.
- Old executor write-back can later be rejected by fencing token.
- Automatic recovery remains intentionally disabled until a coordinator performs a fresh scan and an exclusive executor validates Claim ownership before every state transition.

## Rejected Alternatives

- Claiming inside `provider.bind`: binding is configuration availability, not execution ownership.
- Using only recovery stream sequence: it does not observe mutations in source aggregates.
- Retrying after lease timeout: timeout cannot distinguish “not sent” from “sent but result not persisted”.
- Treating function return as completion evidence: terminal recovery requires persisted, verifiable effect evidence.
