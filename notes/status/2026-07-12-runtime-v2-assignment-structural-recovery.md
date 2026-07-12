# Runtime V2 Assignment Structural Recovery Barrier（第二版运行时分配结构恢复屏障）

## Implemented

- Added a read-only Assignment recovery coordinator that scans all Workspace-scoped（工作区范围）Assignment streams and all Run streams before `runtime.ready`.
- Every Run is fully replayed before Assignment classification. Unknown event versions, invalid pinned identity, sequence gaps and damaged hash chains remain fatal initialization errors.
- Cross-aggregate conflicts do not prevent the project from opening. They produce stable Quarantined（隔离）records for missing child Runs, wrong Assignment pins, orphan child Runs, duplicate child Runs and terminal-state mismatches.
- Added stable classifications for awaiting dispatch, running child states, cancellation pending, ready-to-confirm cancellation, reconciliation required, terminal confirmed and quarantined.
- Recovery scans are pure read operations. Repeated scans do not append Workspace or Runtime events and do not create Runs, Provider attempts or ToolCalls（工具调用）.
- Integrated the structural barrier before `runtime.ready`.
- Quarantined Assignment `get` remains available for audit. Mutation commands are rejected with `ASSIGNMENT_RECOVERY_QUARANTINED`.

## Verification

- Assignment recovery coordinator: 5/5 passed.
- Real Rust process handshake suite: 10/10 passed.
- The real process test starts from a `running` Assignment whose child Run is missing, reaches `runtime.ready`, reads the Assignment, rejects cancellation mutation and proves the missing child Run was not created.
- Clippy strict checks passed.

## Important Finding

Current `agent_assignment.started` stores only `child_run_id`. It cannot recreate the complete immutable `RunPinnedIdentity`, because Provider/model configuration, Prompt bundle, tool/context/runtime policy, session/branch/user message identity, mode and input hash may differ from the parent Run.

Therefore startup recovery intentionally does not provision a missing child Run. Guessing these values would create an unauditable and potentially differently authorized Agent.

## Not Complete

- Immutable ChildRunSpec（子运行规格）is not persisted.
- No stable cross-journal Saga（长事务协调）operation ID can yet recreate the exact child Run.
- The structural report is not exposed as a desktop recovery projection.
- Provider binding occurs after `runtime.ready`; operational recovery after Provider bind is not implemented.
- No automatic cancellation propagation, Artifact（产物）acceptance, Plan evidence advancement or Change Set（变更集）commit occurs.
- No real Provider child Run kill/restart black-box test has passed.

This batch proves a fail-closed structural barrier and zero duplicate creation. It does not prove resumable automatic child execution.
