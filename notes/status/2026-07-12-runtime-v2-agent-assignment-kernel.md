# Runtime V2 Agent Assignment Kernel（第二版运行时智能体分配内核）

## Implemented

- Added ADR-0011 for durable Child Agent Assignment（子智能体分配）, cancellation, recovery and write-authority boundaries.
- Added a Workspace-scoped（工作区范围）append-only `agent_assignment` aggregate.
- Persisted exact Goal（目标）, Plan（计划）, step, parent Run（父运行）, parent invocation, child profile, resource scope and lower-case SHA-256 bindings.
- Persisted bounded objective, source checkpoint, expected artifact and canonical capability set.
- Restricted child authority to `read_only` or `propose_change_set`; neither grants canonical project commit authority.
- Added `allocated`, `running`, `cancel_requested`, `cancelled`, `completed` and `failed` transitions with distinct event types.
- Bound each started assignment to one child Run identity.
- Added evidence-backed completion, cancellation race handling, immutable terminal states, event hash chaining and strict replay.
- Fixed `goal.complete` so callers can no longer submit a forged `actor.isChildAgent` value. Runtime derives the completing actor from the persisted Goal owner for the current Host command path.

## Verification

- Agent Assignment aggregate: 11/11 passed.
- Goal/Plan command service: 3/3 passed.
- `novelx-protocol`: 14/14 passed.
- TypeScript protocol and supervisor targeted tests: 75/75 passed.
- `cargo clippy -p novelx-runtime --all-targets -- -D warnings` passed.

Tests cover restart recovery, canonical scope and capability validation, lower-case hashes, semantic idempotency across changed transport IDs/timestamps, stale concurrent writers, event-type/data matching, unknown versions, sequence gaps, hash corruption, single child Run binding, cancellation idempotency, cancel/completion races and proof that child completion does not mutate the parent Goal.

## Not Complete

- No Agent Assignment Runtime protocol commands or TypeScript supervisor methods exist yet.
- No coordinator starts a real child Run from an assignment.
- No durable concurrency/cost reservation ledger exists.
- No startup recovery driver reconciles Assignment state with child Run state.
- `RunPinnedIdentity` does not yet pin Assignment identity, parent Run or delegation depth.
- Plan step start/completion is not yet restricted by a Runtime-issued Assignment identity.
- No project write lease serializes accepted child Change Set proposals.
- No real Provider multi-Agent black-box test or desktop projection exists.

This batch establishes the authoritative assignment ledger and closes a caller-forged Goal actor vulnerability. It is not automatic Agent allocation and must not be presented as live multi-Agent execution.
