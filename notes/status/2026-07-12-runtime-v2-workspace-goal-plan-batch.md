# Runtime V2 Workspace Goal/Plan batch

Date: 2026-07-12
Status: kernel persistence completed; Runtime protocol and desktop projection incomplete

## Completed

- Added an append-only `WorkspaceEventJournal` with workspace-global and stream-local sequence ordering, optimistic concurrency, idempotency, immutable triggers and migration checksum verification.
- Added `GoalAggregate` with workspace/project/session/owner identity, versioned definition, required acceptance evidence, blockers, owner-only completion and fail-closed replay/hash validation.
- Added `PlanAggregate` with immutable revisions, Goal revision binding, ordered dependencies, Agent assignment fields, capability requirements, expected artifacts and evidence-backed step completion.
- Persisted exact Provider inference/attempt identity in the AgentLoop checkpoint before the next dispatch boundary.
- Added `resume_awaiting_provider` using the persisted identity; mismatched Provider completion is rejected.
- Added service-level interruption evidence proving the resumed Provider turn does not create an extra request.

## Verification

- Rust workspace: 216 passed.
- Goal aggregate: 6/6 passed.
- Plan aggregate: 5/5 passed.
- Workspace event journal: 6/6 passed.
- Runtime ToolCall cross-process matrix: 10/10 passed.
- TypeScript typecheck: passed.
- Default Vitest suite: 399 passed, 10 opt-in cross-process tests skipped by default.
- Rust format and Clippy with warnings denied: passed.

## Not completed

- Goal/Plan Runtime commands, TypeScript protocol, Supervisor methods, IPC and desktop UI are absent.
- `run.start` does not yet verify that pinned Goal/Plan revisions exist in the workspace journal.
- Plan evidence references are structurally validated but are not yet resolved against authoritative Run/Artifact records.
- Startup recovery does not enumerate and drive all active AgentLoop phases, and there is no recovery barrier.
- There is no real child Agent allocation, Handoff, Shared Memory or long-term memory extraction/retrieval loop yet.
- This batch is not a complete Goal/Plan product workflow and is not the completed NovelX Harness.
