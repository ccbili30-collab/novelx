# Runtime V2 OperationalRecoveryScanner（第二版运行时执行恢复扫描器）

## Implemented

Added a read-only `OperationalRecoveryScanner（执行恢复扫描器）`. It reads the structural Assignment（智能体分配）report, Run（运行）, AgentLoop（智能体循环）, ProviderAttempt（模型调用尝试）, ToolCall（工具调用）and exact bound Provider identities.

It emits six typed per-Run gates:

- `awaiting_provider_binding`
- `waiting_for_approval`
- `waiting_for_reconciliation`
- `recovery_ready`
- `quarantined`
- `terminal_projection_only`

## Rules

1. A quarantined Assignment, a missing structural Assignment record for a child Run, or multiple active AgentLoops quarantines the Run.
2. Provider `Sent / OutcomeUnknown`, Tool `Running / unknown outcome` and Run `Committing / WaitingForReconciliation` require reconciliation and are never automatic retry candidates.
3. Host（宿主）approval remains a separate blocking gate.
4. Persisted Provider responses, terminal Provider failures and terminal Tool evidence are evidence-first. They do not require a live API key to be classified as recoverable.
5. A Provider binding matches only when the complete `ProviderRunIdentity（模型运行身份）` is equal, including profile, provider, model and config hash.
6. Terminal Runs are projection-only unless unknown external outcomes require reconciliation.
7. Aggregate addresses are indexed once per scan rather than rescanned for every Run.

## Safety Boundary

The scanner does not:

- call a Provider;
- execute a Tool;
- create or prepare a Run;
- write recovery events;
- approve pending work;
- resolve reconciliation;
- mutate project content.

It is not yet connected to `main.rs`, startup, `provider.bind` or TypeScript（类型化脚本）.

## Verification

Independent Rust tests cover:

- missing, exact and wrong Provider bindings;
- persisted Provider response without a live binding;
- Provider Sent requiring reconciliation;
- Tool Running without a terminal manifest;
- Tool approval waiting;
- terminal Tool evidence;
- multiple active AgentLoops;
- terminal Run projection;
- child Run missing its structural Assignment record.

## Not Complete

- Startup and `provider.bind` integration.
- Durable operational recovery events.
- Per-Run command gates.
- Provider/Tool/Run process kill and repeated restart tests.
- Proof of zero repeated side effects across consecutive restarts.

This is a read-only decision layer, not an automatic recovery workflow.
