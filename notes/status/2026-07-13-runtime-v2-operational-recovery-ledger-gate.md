# Runtime V2 Operational Recovery Ledger and Gate（第二版运行时执行恢复账本与守卫）

## Implemented

- Added deterministic source fingerprints covering Run（运行）sequence/state, pinned identity, Assignment（智能体分配）revision/hash, active AgentLoop（智能体循环）checkpoint, ProviderAttempt（模型调用尝试）evidence, ToolCall（工具调用）state and exact Provider binding.
- Added a workspace-scoped append-only `operational_recovery` aggregate with hash-chain replay.
- The aggregate records deterministic `Observed（已观察）`, `Waiting（等待）` and `Quarantined（隔离）` events. Identical evidence across restarts writes no equivalent event.
- Startup now runs structural recovery, scans operational evidence and records the gate before `runtime.ready`.
- Successful `provider.bind（模型服务绑定）` rescans the workspace. Only a complete matching Provider identity changes that Run fingerprint; no inference is sent.
- Added a startup cohort guard for Assignment child Runs. Ordinary prepare/context/inference commands cannot bypass the recovery operation.
- A missing Provider during child recovery remains nonterminal and returns `RUN_RECOVERY_AWAITING_PROVIDER_BINDING`; it no longer becomes a false `REAL_GM_PROVIDER_REQUIRED` terminal failure.
- Terminal Run plus unknown external outcome is quarantined.
- Terminal Tool state without a verified Artifact Store manifest is not treated as recoverable evidence.

## Verification

- Aggregate tests cover deterministic identity, hash-chain tampering, semantic idempotency, evidence changes and terminal quarantine.
- Recording tests prove repeated identical observations add no events.
- Real Rust process tests prove two consecutive startups retain exactly one observed/waiting pair.
- Real Provider-bind process test proves a matching binding adds only a recovery observation and creates zero ProviderAttempt events.
- Real guarded-child process test proves `run.prepare` cannot terminalize a recovered child when credentials are absent.
- Existing root Run Provider inference remains functional; the current guard is intentionally limited to structurally identified Assignment child Runs.

## Not Complete

- `RecoveryReady（恢复就绪）` is only a recorded candidate. No Claim（领取权）or recovery executor exists.
- Persisted Provider responses are classified evidence-first, but the live Provider inference service still resolves credentials before consuming them.
- Provider `Sent / OutcomeUnknown` is never retried, but the transport handoff boundary still needs refinement.
- Tool completion/failure manifests are not yet read by the scanner; terminal Tool states therefore require reconciliation.
- Tool approval recovery still uses the legacy handler and lacks a fully typed atomic rejection path.
- Root Run operational recovery, actual missing child provisioning, cancellation propagation, Artifact validation, parent synthesis and serialized Change Set（变更集）commit remain incomplete.
- Real kill/restart tests at Provider HTTP and Tool execution crash windows have not passed.

This batch closes durable observation and startup guarding. It does not close automatic execution recovery or automatic Agent allocation.
