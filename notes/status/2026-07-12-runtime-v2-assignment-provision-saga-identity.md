# Runtime V2 Assignment Provision Saga Identity（第二版运行时智能体分配补建事务链身份）

## Implemented

- Added a canonical `ChildRunSpec（子运行规格）` SHA-256 covering the complete persisted specification, including the Run start idempotency key and complete pinned identity.
- Added a versioned `AssignmentChildProvisionSagaIdentity（智能体分配子运行补建事务链身份）`. Its operation ID is the canonical JSON SHA-256 of the workspace ID, Assignment ID, allocation revision and event hash, child Run ID, complete ChildRunSpec hash and operation version.
- Added typed helpers for stable create, prepare, cancel and terminal idempotency keys. A terminal key additionally requires a valid child terminal event SHA-256.
- `ProvisionChildRun（可补建子运行）` recovery classifications now carry an auditable `AssignmentChildProvisionIntent（智能体分配子运行补建意图）` with the immutable Saga identity and nonterminal idempotency keys.
- Added a fixed canonical hash vector, mutation sensitivity checks, forged identity rejection and recovery intent assertions.

## Safety Boundary

This change is identity and recovery-description infrastructure only. Structural recovery remains read-only. It does not:

- create or prepare a child Run;
- call a Provider（模型服务）;
- execute a ToolCall（工具调用）;
- write project content;
- dispatch or resume an Agent（智能体）;
- infer a missing ChildRunSpec for a legacy Started event.

Legacy Started events without a ChildRunSpec remain replayable for audit and remain quarantined when their child Run is missing. A valid provision intent is not evidence that provisioning has occurred.

## Remaining Work

- Implement the durable provisioning Saga executor after the Provider binding boundary.
- Persist and reconcile each Saga phase without duplicate Run creation or duplicate external side effects.
- Bind cancellation and terminal Assignment transitions to actual child Run terminal event hashes.
- Add crash-window tests around create, prepare, Provider request and terminal reconciliation.

Until those items pass real recovery tests, automatic Agent allocation and missing child Run recovery are not complete.
