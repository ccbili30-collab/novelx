# 2026-07-12 Long-context reading status

Implemented range reads, durable task notes, source receipts, active-context compaction, Harness-controlled offsets, adaptive 4K/8K chunks, Provider retries, and deterministic final tool-outcome injection.

Unit coverage verifies token admission, protocol-safe compaction, removal of completed tool pairs, stale model source correction by tool-call identity, Pi runtime behavior, and Steward state transitions.

The real DeepSeek run has demonstrated complete six-file reading and durable range coverage. The final E2E assertion now separates Harness correctness from stochastic prose: file names are checked in the UI; exact source markers and gap-free ranges are checked in SQLite.

Not included in this closure: Checker validation that final prose faithfully represents every saved note, visible per-file progress counters, task restart/resume after a fully exhausted Provider failure, prompt publication refresh, packaging, or release.
