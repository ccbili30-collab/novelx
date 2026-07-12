# Runtime V2 Foundation Start

## Completed

- Accepted ADR-0003: keep Electron + React as the desktop host and build a focused Rust `novelx-runtime.exe` sidecar.
- Recorded the Runtime V2 product baseline, including Goal, Plan, session branching, bounded Agent allocation, inter-session handoff, comments, model selection, history drawer and pet extension boundary.
- Audited the current TypeScript/Pi Agent execution chain and identified split state ownership, non-atomic terminal writes, in-memory-only active runs, missing event sequence/re-attachment, and recovery gaps.
- Audited official `openai/codex` at commit `9e552e9d15ba52bed7077d5357f3e18e330f8f38` and recorded the concepts and limited Apache-2.0 code candidates suitable for NovelX.
- Defined Protocol V1 envelopes, handshake, durable run events, tool ledger rules, context receipts, typed errors, cancellation, recovery and Renderer projection boundaries.
- Created the Rust workspace with `novelx-protocol` and `novelx-runtime` crates.
- Implemented and verified a real `runtime.hello` JSON message and protocol-version rejection tests.
- Added a legal Run state machine, an immutable SQLite event journal, strict duplicate-message conflict detection, and a TypeScript/Zod protocol mirror.
- Added a real Rust handshake loop and matched Rust/TypeScript schemas for `runtime.hello`, `runtime.initialize` and `runtime.ready`.
- Added an isolated Electron Main process supervisor with strict handshake identity checks, bounded stderr, startup/stop timeouts and owned-PID-tree cleanup.
- Bound the Run state machine to the immutable journal through a recoverable Run Aggregate with optimistic sequence checks.
- Added a real TypeScript-to-Rust integration test that builds, launches, handshakes with and stops the exact Runtime V2 binary.
- Accepted the dual-order event addressing model: one global Run order plus aggregate type/id and local aggregate order.
- Added the pure ToolCall authorization/execution/terminal state machine with conservative retry and parallelism rules.
- Added a strict TypeScript protocol contract for typed Runtime errors instead of collapsing every failure into a planning error.
- Migrated the event journal to dual ordering: global Run sequence plus addressed aggregate type/id/local sequence.
- Added a checksum-verified migration ledger and a tested real 0001-to-0002 SQLite rebuild migration.
- Added a startup schema-integrity gate for migration columns, addressed-event constraints, indexes and immutable triggers.
- Added the event-backed ToolCall Aggregate with strict recovery, independent business idempotency keys and SHA-256 argument identity.
- Added a read-only Recovery Coordinator that classifies every persisted Run and fails the entire startup report if any Run cannot be replayed.
- Added the strict `runtime.initialization_failed` handshake contract for typed startup failures.
- Wired Rust initialization to the real workspace event journal and Recovery Coordinator; `runtime.ready` now reports the real nonterminal Run count.
- Added fail-closed structured initialization errors for migration, schema-integrity and replay failures, with internal diagnostics separated from public text.
- Added the post-ready continuous control loop for `runtime.status.get` and `runtime.shutdown`, with independently monotonic Host/Runtime connection sequences, correlated responses and fail-closed protocol errors.
- Added graceful `runtime.stopped` shutdown and strict Rust/TypeScript schemas for status and shutdown messages.
- Extended the Electron Main process supervisor to retain the post-ready NDJSON connection, allocate Host sequences, correlate status/shutdown responses, reject in-flight commands on a runtime crash and terminate only the owned process tree.
- Extended the real TypeScript-to-Rust integration test through `runtime.status.get` and graceful `runtime.shutdown`, rather than stopping at handshake readiness.
- Accepted ADR-0005 and added strict event-version-2 Run pinned identity covering project/workspace, session and project branches, user message, source checkpoint, Goal/Plan revisions, effective scope, Provider/model, Prompt/Agent/tool/context/runtime policies and input hashes.
- Separated Run start business idempotency from transport message identity; a retry after restart returns the journal-recovered current state, while changed identity under the same key fails without writing.
- Added fail-closed recovery for unknown Run event versions and validation for canonical sorted resource scopes and lowercase SHA-256 identities.
- Added real `run.start`, `run.get`, `run.snapshot` and typed `run.rejected` protocol paths backed by the retained SQLite Event Journal.
- Added project/workspace binding to initialization so a Run cannot be accepted into another workspace's runtime process.
- Extended the Electron Supervisor with typed Run start/get APIs and verified that domain rejection leaves the valid runtime connection usable.
- Added a real cross-process restart test: create a pinned Run, stop Rust, reopen the same database, recover one nonterminal Run and retrieve the identical snapshot.
- Extracted Run acceptance/query, snapshot projection and failure classification from the binary entry point into a dedicated `RunCommandService`; NDJSON transport no longer owns Run domain decisions.
- Added isolated service tests for restart recovery, nonfatal workspace rejection with zero writes and fatal corrupted-history classification.
- Added strict, journal-backed `run.cancel` with a stable business idempotency key, persisted reason, terminal snapshot and restart recovery; cancellation does not kill the Runtime process.
- Accepted ADR-0006: Rust owns Provider request policy, HTTP, response validation and receipts; Electron temporarily retains Windows `safeStorage` and may inject only a short-lived sensitive credential.
- Added a strict, secret-free Rust Provider configuration contract with schema/API/auth versions, Auto/fixed output policy, timeout/deadline/retry budgets, HTTPS/loopback URL restrictions and TypeScript-compatible canonical hashing.
- Added a zeroizing in-memory Provider registry that resolves only an exact profile/provider/model/config hash pinned by the Run; binding receipts cannot serialize credentials.
- Added an asynchronous Reqwest Provider Gateway with redirects disabled, bounded response size, total/request deadlines, optional `/models` capability discovery, configured-capability fallback and strict minimal chat ping validation.
- Added real loopback HTTP transport tests for a 1M Provider capability and a Provider that does not expose `/models`.
- Added a dedicated `sensitive_command` Provider binding path. Ordinary Runtime envelopes reject it; Rust consumes the credential only into zeroizing memory and returns a secret-free binding receipt.
- Extended the Electron Supervisor to send the sensitive frame from a Buffer that is overwritten after the pipe write callback, correlate `provider.bound`/`provider.rejected`, and never expose the credential in stderr or receipts.
- Added real TypeScript-to-Rust sensitive binding tests and output/stderr leak assertions.
- Added journal-backed `run.prepare`: the Runtime resolves the exact Provider identity pinned at `run.start`, persists `run.preparing` only for an exact live binding, and persists typed `REAL_GM_PROVIDER_REQUIRED` or `PROVIDER_PROFILE_MISMATCH` terminal failures otherwise.
- Added nullable structured `terminalError` to Run snapshots and event-version-2 `run.failed` replay so Provider prerequisite failures retain their public code, class, stage and diagnostic identity across Runtime restarts.
- Extended the Electron Supervisor with a typed `prepareRun` command path using the same sequence, correlation, timeout and schema enforcement as other Run commands.
- Accepted ADR-0007: Rust Runtime V2 owns final typed context normalization, token admission and the receipt that must precede a Provider request.
- Added strict Run-scoped `context.compile`, correlated `context.compilation` and typed `context.rejected` protocol paths.
- Added typed context items for system Prompt, tool protocol, session messages, retrieval sources, runtime exchanges and output reserve, including content hashes and disclosure classes.
- Added a journal-backed Context Compile Service that validates pinned Run/Provider/context-policy identities, preserves business idempotency and persists `context.compiled` before returning its receipt.
- Added per-request context compilation receipts with deterministic input hash, category budgets, included/omitted item identities, output/safety reserves and explicit tokenizer identity.
- Added the versioned conservative `novelx.unicode-mixed-v1` fallback estimator. Receipts explicitly report `fallback_estimate`; they do not claim exact token counts.

## Verification

- Rust formatting check passes.
- Rust workspace tests pass: 76 tests, including 8 pure Context Compiler contract tests and 7 SQLite Context Compile Service persistence/lifecycle/completeness tests.
- Rust Clippy passes with warnings denied.
- TypeScript typecheck passes.
- Runtime V2 protocol, process-supervisor and real cross-language integration tests pass together: 54 tests, including strict typed context schemas and a real Electron-to-Rust `context.compile` restart/idempotency path.
- `git diff --check` passes.
- Running the binary emits protocol version 1, `runtime.hello`, runtime version `0.1.0`, sequence 1 and explicit `handshake`, `runtime_control`, `runs_v1` and `contexts_v1` capabilities.

## Not Completed

- The Electron application entry point does not launch the supervisor yet; the supervisor is a continuously connected, independently tested module but is not part of production startup.
- The runtime opens and recovers the supplied workspace database and processes durable Run acceptance/query plus status/shutdown controls, but it does not yet schedule Provider or tool execution.
- `run.start` durably creates a Run, `run.prepare` verifies its pinned Provider prerequisite, and `context.compile` can persist a typed receipt. No full inference request, tool scheduling or Provider attempt journal exists yet. Cancellation is connected only at the Run state level because no Provider/tool work exists yet to interrupt.
- The ToolCall state machine, event-backed aggregate and first Context Compiler service exist, but the real tool executor, full Provider inference pipeline, recovery execution policy and domain tools are not implemented.
- The Provider Gateway can bind/validate a profile, perform a real minimal connection ping and gate `run.prepare`; durable Provider attempt events, full inference requests and post-prepare Run scheduling are not connected.
- Exact Provider/model tokenizer integrations are not implemented; the compiler currently uses only the disclosed conservative fallback estimator.
- Context compaction, durable task-note replacement, source locator/range receipts and full truncation disclosure are not implemented. Current item inclusion/omission metadata is not a substitute for those capabilities.
- Electron production startup and the live Agent workflow do not route through `context.compile`; the compiler is protocol/service foundation only and has not sent a real Provider inference request.
- Startup verifies the required columns, constraints, indexes and immutable triggers, but does not yet prove every SQLite CHECK expression against external manual schema reconstruction.
- Goal, Plan, branching, Agent communication, comments, model selector, history drawer and pet API are product contracts only.
- No production workflow uses Runtime V2.

This is a real compiled foundation, but it is not a usable Harness and must not be presented as one.
