# Runtime V2 ToolCall coordination batch

Date: 2026-07-12  
Status: coordination and continuation foundation complete; live automatic loop incomplete

## Completed

- Deterministically materializes Provider tool arguments into immutable artifacts.
- Separates internal Runtime ToolCall UUIDs from original Provider `call_xxx` identifiers.
- Includes inference identity and tool name in stable identity derivation to prevent cross-turn collisions.
- Persists the original Provider call ID in ToolRequest, ToolCall aggregate events and recovery.
- Enforces Run, project, source scope, policy mode and same-Run artifact ownership before authorization.
- Implements Free automatic authorization and Assist host-only approval/denial.
- Persists domain-separated permission lease, success manifest and failure manifest artifacts.
- Recovers orphaned lease/completion manifests and advances the aggregate without redispatch.
- Adds strict dispatch for list, read, stat, search and glob with unknown-field rejection.
- Emits OpenAI-compatible assistant `tool_calls[]` and tool-result messages with the original `tool_call_id`.
- Groups multiple calls from one assistant response and preserves every call/result pair during context omission.
- Adds a reusable scripted multi-turn loopback Provider and nine explicit live contract cases.

## Verification

- Rust workspace: 169 passed.
- TypeScript/Vitest: 396 passed, 9 live contracts skipped.
- TypeScript typecheck: passed.
- Rust Clippy with warnings denied: passed.
- Rust formatting and `git diff --check`: passed.
- Chinese tool arguments and two-round HTTP continuation structure are covered.

## Not completed

- `main.rs` does not yet route ToolCall commands or automatically process Provider tool-call outcomes.
- There is no single Execution Service that owns coordination, the bound ProjectRoot, dispatch, result persistence and terminal event production.
- Runtime Actor does not yet compile the continuation Context or issue the second Provider request.
- Artifact and event writes still use separate SQLite connections; recovery closes known orphan windows, but cross-store writes are not one transaction.
- The nine cross-process live acceptance tests remain skipped and therefore no live ToolCall claim is allowed.
- Goal, Plan, Agent delegation and long-term memory remain downstream work.
