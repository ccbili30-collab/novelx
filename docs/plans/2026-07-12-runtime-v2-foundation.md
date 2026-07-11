# NovelX Runtime V2 Foundation Implementation Plan

> **For Codex:** Execute this plan task-by-task. Do not reconnect domain features until the preceding runtime gates pass.

**Goal:** Build a Rust Runtime V2 foundation that provides versioned IPC, persistent run events, legal state transitions, crash recovery, and protocol-safe tool execution beside the existing Pi Agent runtime.

**Architecture:** Electron remains the desktop host and launches a Rust sidecar. The sidecar owns authoritative run state and emits versioned events. Runtime V2 begins behind a feature gate and migrates read-only operations before any canonical write or player behavior.

**Tech Stack:** Rust 1.95, Tokio, Serde, JSON-RPC over stdio, SQLite, Electron, TypeScript, Zod, Vitest, Cargo test, Playwright, Windows PowerShell.

---

## Delivery Gates

- No runtime event is accepted without schema version, run identity, sequence number, timestamp, and correlation identity.
- Invalid state transitions and unmatched tool results fail locally before a Provider request.
- Every accepted event is persisted before it is projected to Electron.
- Killing the Rust process during each durable state can be recovered without replaying a completed side effect.
- A production NovelX installation is never used for installer lifecycle tests.
- Runtime V2 cannot become the default until real-provider conformance evidence is stored and reviewable.

### Task 1: Freeze Product And Runtime Contracts

**Files:**
- Create: `docs/runtime-v2/product-baseline.md`
- Create: `docs/runtime-v2/current-runtime-audit.md`
- Create: `docs/runtime-v2/codex-reference-audit.md`
- Create: `docs/runtime-v2/protocol-v1.md`
- Modify: `docs/adr/ADR-0003-rust-runtime-v2-and-codex-reference.md`

**Steps:**
1. Record kernel, domain, projection, and extension boundaries.
2. Map every current execution owner and persistence boundary.
3. Pin the reviewed Codex commit and source paths.
4. Define command, event, error, cancellation, and recovery envelopes.
5. Review the documents for contradictions and run `git diff --check`.

### Task 2: Scaffold The Rust Workspace

**Files:**
- Create: `runtime/Cargo.toml`
- Create: `runtime/crates/novelx-protocol/Cargo.toml`
- Create: `runtime/crates/novelx-protocol/src/lib.rs`
- Create: `runtime/crates/novelx-runtime/Cargo.toml`
- Create: `runtime/crates/novelx-runtime/src/main.rs`
- Create: `runtime/rust-toolchain.toml`
- Modify: `.gitignore`
- Modify: `package.json`

**Steps:**
1. Add a failing protocol round-trip test.
2. Run `cargo test --manifest-path .\runtime\Cargo.toml` and verify failure.
3. Implement the smallest versioned command/event envelopes.
4. Add `runtime:check`, `runtime:test`, and `runtime:build` PowerShell-compatible scripts.
5. Run Cargo formatting, Clippy, tests, and `npm run typecheck`.

### Task 3: Implement Event Journal And State Machine

**Files:**
- Create: `runtime/crates/novelx-runtime/src/run_state.rs`
- Create: `runtime/crates/novelx-runtime/src/event_journal.rs`
- Create: `runtime/crates/novelx-runtime/tests/run_recovery.rs`
- Create: `runtime/crates/novelx-runtime/migrations/0001_runtime_events.sql`

**Steps:**
1. Write table-driven tests for every legal and illegal transition.
2. Write a recovery test that terminates after each durable event.
3. Persist events transactionally with monotonic per-run sequence numbers.
4. Rebuild state exclusively from the journal.
5. Verify duplicate command and event handling is idempotent.

### Task 4: Add Electron Sidecar Supervision

**Files:**
- Create: `src/main/runtimeV2ProcessSupervisor.ts`
- Create: `src/shared/runtimeV2Protocol.ts`
- Create: `tests/unit/runtime-v2-supervisor.test.ts`
- Modify: `src/main/index.ts`
- Modify: `electron-builder.yml`

**Steps:**
1. Write tests for launch, ready handshake, event ordering, malformed output, crash, restart, and cancellation.
2. Launch only the packaged runtime binary selected for the current platform.
3. Validate all Rust messages with Zod before use.
4. Persist diagnostic details internally while returning stable public error codes.
5. Verify no white window or orphan process remains after tests.

### Task 5: Build Tool Protocol Ledger

**Files:**
- Create: `runtime/crates/novelx-runtime/src/tool_ledger.rs`
- Create: `runtime/crates/novelx-runtime/src/tool_policy.rs`
- Create: `runtime/crates/novelx-runtime/tests/tool_protocol.rs`

**Steps:**
1. Test missing, duplicated, reordered, timed-out, cancelled, and recovered tool results.
2. Enforce one terminal result for every accepted tool call.
3. Record arguments, authorization, attempt, side-effect class, result hash, and checkpoint.
4. Reject illegal Provider history before network transmission.
5. Add property tests that generate invalid event sequences.

### Task 6: Migrate Read-Only Project Operations

**Files:**
- Create: `runtime/crates/novelx-runtime/src/tools/project_files.rs`
- Create: `tests/e2e/runtime-v2-project-reading.spec.ts`
- Modify: `src/main/workspaceAgentToolGateway.ts`

**Steps:**
1. Define list, stat, glob, search, and range-read contracts.
2. Keep path authorization in the desktop workspace boundary.
3. Make offsets, chunk sizing, and coverage Runtime-controlled.
4. Compare Legacy and Runtime V2 results on the same project fixtures.
5. Run real-provider reading only after deterministic coverage tests pass.

### Task 7: Context, Memory, Goal, And Plan

**Files:**
- Create: `runtime/crates/novelx-runtime/src/context_compiler.rs`
- Create: `runtime/crates/novelx-runtime/src/task_memory.rs`
- Create: `runtime/crates/novelx-runtime/src/goal.rs`
- Create: `runtime/crates/novelx-runtime/src/plan.rs`
- Create: `runtime/crates/novelx-runtime/tests/context_recovery.rs`

**Steps:**
1. Separate active context, task memory, project knowledge, and archive.
2. Persist source receipts before compacting covered content.
3. Treat Goal and Plan as versioned runtime objects, not Prompt conventions.
4. Test context compilation against provider limits and forced compaction.
5. Verify no uncovered source range disappears after restart.

### Task 8: Add Writes, Approval, And Change Sets

**Files:**
- Create: `runtime/crates/novelx-runtime/src/change_set.rs`
- Create: `runtime/crates/novelx-runtime/src/approval.rs`
- Create: `runtime/crates/novelx-runtime/tests/change_set_recovery.rs`

**Steps:**
1. Test Free and Assist policies before implementing writes.
2. Stage all writes in a durable Change Set.
3. Require explicit approval identity in Assist mode.
4. Commit canonical writes atomically and record undo checkpoints.
5. Force crashes before and after commit to prove exactly-once behavior.

### Task 9: Add Agent Coordination And Session Features

**Files:**
- Create: `runtime/crates/novelx-runtime/src/agent_coordinator.rs`
- Create: `runtime/crates/novelx-runtime/src/session_branch.rs`
- Create: `runtime/crates/novelx-runtime/src/annotation.rs`
- Create: `runtime/crates/novelx-runtime/tests/agent_handoff.rs`

**Steps:**
1. Define structured Agent handoff and bounded child-run ownership.
2. Add private session memory and explicit project-shared memory writes.
3. Add session branches with immutable ancestry.
4. Add message and artifact annotations with stable source locations.
5. Test inter-session communication without shared hidden conversation state.

### Task 10: Reconnect Product Projections And Extensions

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/features/runtime/RunTimeline.tsx`
- Create: `src/renderer/src/features/runtime/ModelSelector.tsx`
- Create: `src/renderer/src/features/runtime/GoalPlanView.tsx`
- Create: `src/renderer/src/features/runtime/AnnotationView.tsx`

**Steps:**
1. Render the right-side sliding timeline from runtime events.
2. Make model selection a run configuration with capability validation.
3. Render Goal, Plan, child Agents, approvals, retries, and artifacts.
4. Expose a non-authoritative pet event API for future visual companions.
5. Keep internal Prompt, raw tool JSON, and private GM data out of player UI.

### Task 11: Conformance And Legacy Removal Gate

**Files:**
- Create: `tests/conformance/runtime-v2/`
- Create: `docs/runtime-v2/conformance-report.md`
- Modify: `package.json`

**Steps:**
1. Run 100 consecutive real tool tasks without protocol failure.
2. Run long-context tasks beyond the configured provider window.
3. Inject crashes, timeouts, rate limits, malformed tool requests, and disk errors.
4. Verify exact error classification and actionable recovery UI.
5. Remove Legacy Runtime only after all migrated workflows pass and rollback evidence exists.

