# Runtime V2 Operational Recovery Audit（第二版运行时执行恢复审计）

## Finding

The current runtime has a StructuralRecoveryBarrier（结构恢复屏障） but no Provider-bind OperationalRecoveryBarrier（模型绑定后执行恢复屏障）. `provider.bind` only updates the in-memory Provider registry and returns `provider.bound`; it does not enumerate or resume child Runs.

## First Safe Implementation Boundary

1. Add a read-only OperationalRecoveryScanner（执行恢复扫描器） after structural recovery. It classifies valid running Assignments, child Runs and active AgentLoops without calling a Provider or Tool.
2. Add per-Run gates: `awaiting_provider_binding`, `waiting_for_approval`, `waiting_for_reconciliation`, `recovery_ready`, `quarantined` and terminal projection only.
3. Recover durable evidence before resolving credentials. Persisted Provider responses and terminal Tool manifests must be consumable without a live API key.
4. Provider bind may mark only exact matching profile/config Runs as recovery candidates. The first batch still must not send network requests automatically.
5. Persist deterministic recovery operation events so repeated restarts do not append duplicate semantic events.

## Never Auto-Retry

- Provider `Sent` or `OutcomeUnknown`.
- Tool `Running` without a terminal manifest.
- Run `Committing` without a commit manifest.
- `AwaitingApproval` without a Host（宿主）decision.
- Any identity, hash, scope, lease or permission conflict.
- Multiple active AgentLoops for one Run.
- Legacy Started Assignment without a complete ChildRunSpec（子运行规格）.
- A terminal Run that still has unknown external side effects.

## Required Corrections Before Resume

- `ProviderInferenceService（模型调用服务）` currently resolves Provider credentials before consuming an already persisted response. The order must become evidence-first.
- `provider.sent` is currently persisted before the real HTTP transport handoff. This conservatively prevents duplicate charging but creates false unknown outcomes. The send boundary needs a narrower durable state transition.
- A Tool `Running` without a completion manifest must persist an unknown outcome exactly once and must never be redispatched.
- Recovery gates must be per Run; unrelated Runs may continue after their own recovery state is resolved.

## Acceptance Still Missing

- Startup enumeration and Provider-bind wakeup.
- Per-Run command gating.
- Durable operational recovery events.
- Real process kill/restart tests for Provider Requested/Sent/Responded and Tool Authorized/Running/manifest states.
- Proof that two consecutive restarts add no equivalent business events and repeat no side effects.

Operational recovery is not complete and must not be presented as live automatic Agent resumption.
