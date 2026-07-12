# 2026-07-12 Runtime V2 project file read tools

Implemented an independent Rust Runtime V2 foundation for three read-only project file tools:

- `list_project_directory`（列出项目目录）
- `read_project_file`（读取项目文件）
- `stat_project_file`（查看文件信息）

The executor accepts an explicit project root because the authoritative `projectRootPath` initialization contract is not yet wired into this module. It canonicalizes the root and every resolved target, rejects absolute paths, drive paths, parent traversal and internal `.novax`, `.git`, and `node_modules` segments, and rejects links resolving outside the project.

File work runs through bounded `spawn_blocking` tasks guarded by a Tokio semaphore. Listing, read characters, file bytes, scanned entries, and concurrency are bounded. Text reads require strict UTF-8. Read offsets use Unicode scalar values and return stable contiguous ranges. A caller can pin the first block SHA-256 in later reads; changed content returns a version conflict instead of joining different file versions.

`list`, `read`, and `stat` return structured receipts with public relative paths and a deterministic receipt SHA-256. File receipts include content SHA-256, byte size, and modified time. Listing reports whether omitted-entry counts are exact.

Verification:

- `cargo test --manifest-path runtime\Cargo.toml -p novelx-runtime --test project_file_tools`
- 4 tests passed, covering real Chinese paths/content without README, strict UTF-8 failure, traversal/internal path rejection, Windows link escape when link creation is permitted, Unicode scalar chunk continuity, version conflict, deterministic receipts, and omission reporting.

The library passes `cargo clippy --manifest-path runtime\Cargo.toml -p novelx-runtime --lib -- -D warnings`. A full crate test run completed all suites up to `event_journal`; 56 tests passed before one unrelated concurrent artifact-migration expectation failed because migration 0003 is now present while the existing assertion still expects only migrations 0001 and 0002. The new directed tests remained green. Full verification must be rerun after that concurrent migration test is updated.

Not completed:

- The Provider `tool_calls` -> ToolCall Aggregate -> executor -> persisted terminal result -> Provider continuation path is not wired.
- The executor is not exposed by the Runtime protocol or UI and must not be described as live.
- `search_project_files` and `glob_project_files` are not implemented in Rust.
- Read cancellation cannot stop a blocking OS read after it has started; limits and concurrency prevent unbounded work, but cooperative file-operation cancellation remains future work.
- Write, delete, rename, Shell, process execution, DOCX, EPUB and binary-content tools are deliberately absent.
