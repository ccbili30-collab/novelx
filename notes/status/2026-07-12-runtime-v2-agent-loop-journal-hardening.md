# 2026-07-12 Runtime V2 Agent loop journal hardening

Strengthened `AgentLoopJournalRepository`（智能体循环日志仓库） without modifying `main.rs` or the live runner.

## Implemented

- Added `StateTransitionKind`（状态转换类型） for state changes that do not produce an `AgentLoopDirective`.
- Added `append_state_transition` as the generic no-directive transition append API.
- Added `append_inference_started` as the strict wrapper for `AwaitingInferenceStart -> AwaitingProvider` after `acknowledge_inference_started`.
- Persisted no-directive transitions use the same checkpoint hash, aggregate ordering, command-key idempotency and stale-checkpoint gates as directive transitions.
- Replay recognizes `InferenceStarted` only when its restored phase is `AwaitingProvider`; it cannot be substituted for a created event or another phase transition.
- Added `AgentLoopService::checkpoint_sha256` for live adapters that need to audit the exact serialized checkpoint identity without reimplementing hashing.

## Tests

The journal suite now contains ten tests; eight were added in this hardening batch:

1. Persist and idempotently retry inference-start acknowledgement without fabricating a directive.
2. Reject a corrupted checkpoint SHA-256.
3. Reject an aggregate sequence gap.
4. Reject the same pending internal ToolCall ID across multiple active loops.
5. Reject conflicting reuse of a transition command key.
6. Reject a transition based on a stale checkpoint.
7. Reject invalid event metadata before any write.
8. Reject reuse of the create key with a different checkpoint.

The existing tests continue to cover Assist restart lookup by internal ToolCall ID and multiple active loops for one Run.

Verification completed after the concurrent live-runner edits settled:

- `cargo test --manifest-path runtime\Cargo.toml -p novelx-runtime --test agent_loop_journal`: 10 passed, 0 failed.
- `cargo clippy --manifest-path runtime\Cargo.toml -p novelx-runtime --lib --test agent_loop_journal -- -D warnings`: passed.
- `git diff --check`: passed for the journal, service helper, tests and this status note.

## Not completed

- This repository is not wired in `main.rs` by this change.
- It does not execute tools or dispatch Provider requests.
- Corruption tests deliberately remove and recreate SQLite's immutable-update trigger around a controlled test-only mutation; production code never mutates runtime events.
