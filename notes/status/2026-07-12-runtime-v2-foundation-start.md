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

## Verification

- Rust formatting check passes.
- Rust workspace tests pass: 14 tests.
- Rust Clippy passes with warnings denied.
- TypeScript typecheck passes.
- Runtime V2 protocol and process-supervisor tests pass: 23 tests.
- `git diff --check` passes.
- Running the binary emits protocol version 1, `runtime.hello`, runtime version `0.1.0`, sequence 1 and the `handshake` capability.

## Not Completed

- The Electron application entry point does not launch the supervisor yet; the supervisor exists only as an independently tested module.
- The runtime does not read commands after the hello event.
- No event journal, SQLite schema, Run state machine, tool ledger, Provider call, context compiler, recovery controller or domain tool is implemented.
- Goal, Plan, branching, Agent communication, comments, model selector, history drawer and pet API are product contracts only.
- No production workflow uses Runtime V2.

This is a real compiled foundation, but it is not a usable Harness and must not be presented as one.
