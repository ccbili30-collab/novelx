# Agent Basic Project File Tools Implementation Plan

**Goal:** Give the Steward explicit, composable project file discovery tools and make missing-file recovery deterministic instead of treating a guessed `README.md` as the project entry point.

**Architecture:** Keep `inspect_project_files` for backward compatibility, but add five first-class read-only tools: `list_project_directory`, `stat_project_file`, `glob_project_files`, `search_project_files`, and `read_project_file`. Main remains the only process with filesystem access and preserves root confinement, ignored internal directories, audit records, and size limits. Real file mutations continue exclusively through Change Set operations.

**Failure contract:** Missing paths return `PROJECT_FILE_NOT_FOUND`; restricted or outside-root paths retain their specific codes. Safe file error codes cross Worker IPC unchanged. Prompt policy requires directory discovery and glob fallback after a missing guessed file, and forbids describing missing files as missing authorization.

**Verification:** Unit-test every tool and error path, add a no-README Chinese Markdown project fixture, run prompt contract tests and real Provider E2E against `C:\Users\16014\Desktop\诡秘之主完整解析`, then package and publish only after the installed flow succeeds.
