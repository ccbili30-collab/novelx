# Runtime V2 Search And Glob Tools

Implemented an independent Rust `project_search_tools` module for a caller-supplied, explicitly verified project root. It does not participate in Runtime initialization or permission wiring.

The scanner traverses deterministic normalized relative paths and returns explicit completeness metadata. File count, total read bytes, per-file bytes, per-file Unicode characters, elapsed time, result count and result-character budgets are bounded. Traversal/read failures, symlinks and every exhausted budget add an incomplete reason. Invalid UTF-8 files are counted as binary and excluded from text search.

Search reads and validates a complete file before matching. An oversized file is not prefix-searched, so a query missing from the prefix cannot be reported as a complete project-wide miss. Tests cover Chinese paths and content, tail-only matches in oversized files, and each primary truncation budget.

Not implemented: Runtime ToolCall dispatch, permission lease enforcement, cancellation token integration, ignore-file rules, archive/document parsing, or UI projection. This module alone is not a live Agent tool.
