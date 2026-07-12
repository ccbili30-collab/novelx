# Runtime V2 ChildRunSpec（第二版运行时子运行规格）

## Implemented

- `agent.assignment.start` now requires an immutable `ChildRunSpec（子运行规格）` instead of only a child Run ID.
- The specification persists the child Run ID, stable Run-start idempotency key, complete `RunPinnedIdentity（运行固定身份）` and canonical SHA-256.
- Child Runs pin Assignment allocation revision 1 and its event hash. They do not pin the Started event, so the identity hash has no self-reference cycle.
- Rust and TypeScript use recursively key-sorted canonical JSON and share a fixed golden hash vector.
- Start, terminal identity validation and reverse recovery scanning verify the same Goal, Plan, parent Run, scope, profile, checkpoint, delegation depth and complete pinned identity.
- Legacy Started events without a specification still replay, but a missing child is quarantined instead of guessed.
- A running Assignment with a valid specification and no child Run is classified as `ProvisionChildRun（可补建子运行）`. Structural recovery remains read-only.
- TypeScript Supervisor（监督器） sends the complete specification and parses both new and legacy Assignment snapshots.

## Verification

- Rust workspace tests: passed.
- Rust Clippy with `-D warnings`: passed.
- TypeScript tests: 406 passed, 10 skipped.
- TypeScript typecheck: passed.
- Protocol and Supervisor focused tests include tampered hashes, legacy snapshots, full DTO transport and the Rust/TypeScript golden hash.

## Not Complete

- No stable cross-journal Saga（事务链）operation ID has been persisted.
- `ProvisionChildRun` is a classification only; it does not create or prepare a child Run.
- Provider bind（模型绑定） operational recovery is not implemented.
- No Provider request, tool execution or project write is resumed by this batch.
- Bounded concurrency, budget enforcement, cancellation propagation, Artifact（产物）validation, parent synthesis, Plan advancement and serialized Change Set（变更集）commit remain incomplete.
- No real Provider child Run crash/restart acceptance has passed.

This is a complete recovery-credential and protocol wiring batch. It is not a complete automatic Agent allocation workflow.
