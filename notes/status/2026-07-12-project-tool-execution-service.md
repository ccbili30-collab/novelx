# Runtime V2 Project Tool Execution Service

## Implemented

- Added one `ProjectToolExecutionService` that binds `databasePath`, `ProjectRoot` and `projectId` at construction. Per-call APIs cannot replace the project root.
- The service exclusively sequences the Provider tool-call materializer, Tool coordination/recovery service, project dispatcher and Artifact store for the five read-only project tools.
- Provider `tool_calls` become strict `ToolRequest` records with stable internal UUIDs, original Provider `call_xxx` identity, pinned Run source scope and pinned permission policy.
- Free mode advances through authorization, running and a real dispatcher call. JSON results are stored as deterministic Run-owned artifacts before the succeeded terminal event.
- Assist mode returns `approval_required` without dispatching. `resolve_assist_and_execute` re-materializes and verifies the same Provider call, accepts only the matching host resolution, then executes after approval.
- Dispatcher failures become structured `project_tool_failure_v1` artifacts and recoverable failed Tool snapshots. Missing files, rejected paths, malformed arguments and internal result failures have stable codes/classes.
- Recovery precedes dispatch. Succeeded/failed calls return their persisted manifest, while a Running call without a terminal manifest returns `PROJECT_TOOL_OUTCOME_UNKNOWN` and is not redispatched.
- Replaying an identical completed call returns the original result artifact even if the underlying file changed afterward.

## Verification

- `project_tool_execution_service`: 5/5 tests pass.
- Related dispatcher/materializer/coordinator tests: 12/12 pass.
- `cargo clippy -p novelx-runtime --all-targets -- -D warnings` passes.
- Rust formatting check passes.
- Full Rust workspace regression passes: 181 tests.

## Not Completed

- The service is not connected to `main.rs`, the Runtime Actor command router or the Provider continuation loop, so it is not a live desktop Agent path yet.
- No streaming/progress protocol is emitted while a tool is running.
- Assist approval has a service API but no Electron/Supervisor/UI routing in this module.
- Artifact and Event Journal writes still use separate SQLite connections; orphan reconciliation prevents duplicate dispatch, but a future shared transaction boundary would reduce recovery windows.
- Only the five read-only tools are supported. Writes remain forbidden and must continue through Change Set policy rather than this executor.
