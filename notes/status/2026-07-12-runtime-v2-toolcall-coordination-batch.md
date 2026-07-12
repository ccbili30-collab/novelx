# Runtime V2 ToolCall coordination batch

Date: 2026-07-12  
Status: project read-tool Free/Assist loop complete at the Runtime cross-process contract level

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
- Adds a reusable scripted multi-turn loopback Provider and ten explicit cross-process contract cases.
- Routes Provider ToolCalls through the Runtime Actor, project execution service and continuation compiler.
- Resumes the same persisted Assist AgentLoop after all approval or denial decisions are durable.
- Runs resumed Assist inference as a cancellable background Runtime task without duplicating the authorization response.

## Verification

- Cross-process ToolCall matrix: 10/10 passed, including Assist approval and denial.
- Runner tests: 2/2 passed.
- Runtime Actor tests: 5/5 passed.
- Rust workspace: 197 passed.
- TypeScript/Vitest default suite: 399 passed, 10 opt-in cross-process cases skipped by default.
- TypeScript typecheck, Rust format, Clippy with warnings denied and `git diff --check`: passed.
- Chinese tool arguments, original Provider call IDs and two-round HTTP continuation structure are covered.
- Test cleanup left no `novelx-toolcall-live-*` directory, Electron process or Runtime process behind.

## Not completed

- Artifact and event writes still use separate SQLite connections; recovery closes known orphan windows, but cross-store writes are not one transaction.
- Write tools are intentionally absent; formal mutations still require the future Change Set path.
- A real external DeepSeek acceptance run for this exact Runtime V2 path has not been executed in this batch; loopback evidence proves protocol behavior, not third-party availability.
- Automatic recovery of every possible active AgentLoop phase at process startup is not complete.
- Goal, Plan, Agent delegation and long-term memory remain downstream work.
