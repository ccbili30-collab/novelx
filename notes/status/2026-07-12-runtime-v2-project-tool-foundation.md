# Runtime V2 project tool foundation

Date: 2026-07-12  
Status: foundation complete; live Agent loop not complete

## Product baseline retained

The approved Codex-style capabilities remain recorded in `docs/runtime-v2/product-baseline.md`:

- right-side sliding history and non-destructive restore;
- automatic bounded Agent allocation;
- lower-right model selection for the next Run;
- session branches;
- presentation-only pet extension;
- durable Goal and versioned Plan;
- structured session and Agent communication;
- version-anchored comments.

They remain ordered behind the Runtime V2 reliability dependencies and are not labelled implemented.

## Completed in this batch

- Added explicit `projectRootPath` to the Rust/TypeScript initialization contract.
- Confirmed the authoritative root source is the registered project's `rootPath`; the Runtime does not infer it from the SQLite path.
- Added Windows path confinement including drive, UNC, parent traversal, managed-directory and Junction escape rejection.
- Added bounded Rust executors for list, read, stat, glob and literal search.
- Added strict UTF-8 reads, Unicode-scalar chunk continuity and stable SHA-256 file versions.
- Added explicit incomplete reasons for every search/glob/list budget truncation.
- Added an immutable SQLite JSON Artifact Store for future tool arguments and results.

## Verification evidence

- Rust workspace tests: 152 passed.
- Real Windows Junction tests passed.
- Chinese filename and Chinese content tests passed.
- The previous 120,000-character prefix-search false-completeness behavior has a regression test.
- TypeScript protocol, Supervisor and real Rust handshake tests passed in the project-root subtask.

## Not completed

- Provider tool calls are not dispatched to these executors.
- Free/Assist permission leases are not yet issued by a live coordinator.
- Tool arguments/results are not yet wired through the Artifact Store.
- Tool results are not yet added to the next authoritative Context Compilation.
- The Provider is not yet called for the continuation turn.
- Production Electron does not yet construct Runtime V2 from the registered project root.
- The three file modules still duplicate some root validation and must converge on one `ProjectRoot` authority.
- Handle-level open-time checks are still needed before any write tool to close TOCTOU risks.

Therefore this batch is not a complete Agent file-inspection loop and must not be presented as live.
