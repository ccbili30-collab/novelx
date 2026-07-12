# Runtime V2 Tool Coordination Status

## Implemented

- Added a journal-backed `ToolCoordinationService` over `ToolRequest`, `RunAggregate`, `ToolCallAggregate` and `ArtifactStore`.
- Requests fail closed unless the Run is `running`, the project ID matches the pinned Run, source checkpoint/resource scope and scope SHA-256 match exactly, the permission mode/policy identity matches the Run, and the arguments artifact receipt exists under the same Run.
- `ToolRequest` and `ToolCallDefinition` now retain the original Provider tool-call ID such as `call_xxx` separately from NovelX's internal UUID. Aggregate replay rejects a changed Provider call identity.
- Only these `side_effect=none` tools are accepted: `list_project_directory`, `stat_project_file`, `glob_project_files`, `search_project_files`, and `read_project_file`.
- Free mode persists a domain-separated permission-lease artifact and automatically advances `requested -> authorized`.
- Assist mode persists `approval_required`; only the explicit `resolve_from_host` API can approve or deny it. Host resolution is idempotent by its authorization key.
- Authorized calls can advance to `running`, then `succeeded` or `failed`. Aggregate state, lease and successful result receipt are recoverable after reopening the workspace.
- Permission leases, completion manifests and failure manifests use separate domain-separated deterministic UUIDv5 addresses. Success persists a completion manifest containing the result artifact receipt before appending `tool.completed`; failure persists a structured error artifact receipt before `tool.failed`.
- Recovery calibrates partial persistence windows: a persisted lease completes missing authorization, and a persisted completion/failure manifest advances a still-running aggregate to its terminal state without redispatching the tool. Terminal state without its required manifest fails closed.
- The same ToolCall plus request idempotency key returns persisted state without duplicate events. Changing the request key or semantics for an existing ToolCall fails closed.

## Verification

- Focused Rust verification passes: 45 tests across coordination, aggregate replay, Provider materialization, context continuation/compiler and protocol validation.
- `cargo clippy -p novelx-runtime --all-targets -- -D warnings` passes.
- Coordination coverage includes Free authorization, Assist approval and denial, all five allowed tools, scope/policy/artifact rejection, request-key conflicts, original Provider call-ID replay, success/failure receipt recovery, manifest conflicts and lease/completion orphan calibration without redispatch.
- Full verification passes with 169 Rust tests and 396 TypeScript tests; 9 cross-process live ToolCall contracts remain explicitly skipped.

## Not Completed

- This service is not connected to `main.rs` and does not execute a filesystem tool.
- Host protocol routing for `tool.request` and `tool.authorization.resolve` is not connected.
- The dispatcher/executor must consume the lease and coordination snapshot before any real tool call is considered live.
- Completion-manifest-first persistence makes retries deterministic, but the journal and artifact store still use separate SQLite connections rather than one cross-store transaction.
