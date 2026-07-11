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

## Verification

- Rust formatting check passes.
- Rust workspace tests pass: 39 tests.
- Rust Clippy passes with warnings denied.
- TypeScript typecheck passes.
- Runtime V2 protocol, process-supervisor and real cross-language integration tests pass: 31 tests.
- `git diff --check` passes.
- Running the binary emits protocol version 1, `runtime.hello`, runtime version `0.1.0`, sequence 1 and the `handshake` capability.

## Not Completed

- The Electron application entry point does not launch the supervisor yet; the supervisor exists only as an independently tested module.
- The runtime still does not open the supplied workspace database during initialization or process Run commands after readiness.
- The ToolCall state machine and event-backed aggregate exist, but the real tool executor, Provider call, context compiler, recovery execution policy and domain tools are not implemented.
- Startup verifies the required columns, constraints, indexes and immutable triggers, but does not yet prove every SQLite CHECK expression against external manual schema reconstruction.
- Goal, Plan, branching, Agent communication, comments, model selector, history drawer and pet API are product contracts only.
- No production workflow uses Runtime V2.

This is a real compiled foundation, but it is not a usable Harness and must not be presented as one.
