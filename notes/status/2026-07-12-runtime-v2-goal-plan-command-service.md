# Runtime V2 Goal/Plan Command Service

## Implemented

- Added strict Goal/Plan protocol DTOs for five Goal commands and five Plan commands.
- Added optional historical revision lookup to `GoalGet` and `PlanGet`.
- Added `GoalPlanCommandService` over the persisted workspace event journal.
- Goal commands derive workspace/project identity from the initialized `WorkspaceBinding`.
- Plan mutations verify that the referenced Goal revision exists exactly, belongs to the current workspace/project, and is not blocked, completed, or cancelled.
- Added typed domain failures with stable code, class, retryability, public message, stage, and diagnostic ID.
- Added persisted restart, historical revision, evidence, stale revision, foreign binding, missing Goal revision, terminal Goal, and child-Agent completion tests.
- Routed all ten commands through the live Rust Runtime process and TypeScript `RuntimeV2ProcessSupervisor`.
- Added exact Goal/Plan revision and SHA-256 pin validation before `run.created` is persisted.
- Replaced free-form Goal resource scope with a canonical, sorted resource identity set and its SHA-256.
- Preserved old `run.created` events whose Goal/Plan references predate the SHA-256 field, while requiring the hash for every new `run.start` command.
- Added real cross-process create, revise, historical read, restart recovery, invalid-pin rejection and valid pinned Run evidence.

## Verification

- `cargo fmt --all -- --check` passed.
- `cargo clippy --workspace --all-targets -- -D warnings` passed.
- `cargo test --workspace` passed, including `novelx-protocol` 14/14, Goal/Plan command service 3/3, Run pin validator 3/3 and legacy Run recovery 9/9.
- `npm run typecheck` passed.
- `npm test`: 401 passed, 10 skipped.
- Real Rust child-process handshake and Goal/Plan suite: 11/11 passed.
- Real cross-process ToolCall matrix, explicitly enabled: 10/10 passed.
- `git diff --check` passed.

## Not Complete

- Desktop projections do not consume Goal/Plan snapshots yet.
- Sessions do not automatically create or select a Goal.
- Child-Agent allocation, Handoff（任务交接）, Shared Memory（共享记忆）and parent synthesis are not implemented.
- Startup recovery does not yet resume every nonterminal phase of a multi-Agent Goal.
- Long-term memory and Canonical Assertion（权威断言）retrieval are not connected to Goal/Plan execution.

This batch completes the live Goal/Plan command and exact Run-pin boundary. It is not a complete user-visible Goal/Plan or multi-Agent workflow.
