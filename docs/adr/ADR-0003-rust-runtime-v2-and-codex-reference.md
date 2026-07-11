# ADR-0003: Rust Runtime V2 With Codex CLI As The Primary Reference

## Status

Accepted

## Context

NovelX currently combines Pi Agent, TypeScript state machines, Electron IPC, SQLite persistence, Prompt-driven tool ordering, context compaction, Free / Assist permissions, Change Sets, source tracking, and specialist Agents. Individual mechanisms work, but their composition has produced invalid tool-call histories, coarse error reporting, incomplete recovery, and excessive dependence on model-authored control flow.

The product requires long-running creative tasks, auditable world knowledge, crash recovery, multiple Agents, versioned writes, and model-provider portability. Development time is not the primary constraint; runtime correctness and maintainability are.

## Decision

1. Build `novelx-runtime.exe` as a Rust sidecar process and keep Electron + React + TypeScript as the desktop host and presentation layer.
2. Use the official `openai/codex` repository as the primary behavioral and architectural reference for event flow, context management, compaction, tool execution, policy, recovery, and app-server boundaries.
3. Do not fork the complete Codex CLI product. Reimplement NovelX-specific runtime boundaries and selectively port Apache-2.0 code only when the dependency and maintenance cost are justified and attribution is preserved.
4. Communicate through a versioned, bidirectional JSON-RPC event protocol over Windows-safe stdio initially. The protocol transport may later move to named pipes without changing domain messages.
5. Make the Rust runtime authoritative for run state, tool-call/result pairing, context compilation, retries, cancellation, checkpoints, recovery, Provider calls, and policy enforcement.
6. Keep domain resources, projections, editing UI, and migration adapters outside the kernel. No domain module may call a Provider or mutate canonical state while bypassing the runtime.
7. Preserve the current Pi Agent runtime as a legacy path until Runtime V2 passes conformance and real-provider migration gates.

## Consequences

### Positive

- Illegal runtime states can be represented with explicit Rust enums and validated transitions.
- Electron crashes and runtime crashes can be recovered from persisted events and checkpoints.
- UI state becomes a projection of authoritative events instead of inferred model prose.
- Provider, tool, memory, and domain modules receive stable versioned contracts.
- Codex reliability patterns can be adopted without importing code-editor product assumptions.

### Negative

- Two runtimes must coexist during migration.
- Rust and TypeScript protocol types require generation or cross-language contract tests.
- Initial delivery is slower because protocol, persistence, recovery, and conformance tests precede visible features.
- Packaging must include, launch, update, and diagnose a second executable.

### Neutral

- Rust is selected for correctness and process boundaries, not as a claim that language choice alone improves LLM latency or UI frame rate.
- SQLite remains the initial durable store; schema ownership and migrations must be explicit before Runtime V2 writes production data.

## Alternatives Considered

### Continue Extending The TypeScript/Pi Runtime

Rejected as the final architecture because deterministic orchestration, protocol validation, recovery, and domain policy are already tightly coupled. Pi Agent remains available only as the migration fallback.

### Fork The Complete Codex CLI

Rejected because Codex is Rust-first but code-domain-heavy. Shell execution, Git, patching, sandboxing, account services, and coding-specific context would create a larger long-term fork than a focused NovelX runtime.

### Rewrite The Entire Desktop Application In Rust

Rejected because React and Electron are not the source of the runtime protocol failures. Rewriting the editor and UI would increase scope without improving the core invariants.

## References

- https://github.com/openai/codex
- `docs/runtime-v2/product-baseline.md`
- `docs/runtime-v2/current-runtime-audit.md`
- `docs/runtime-v2/codex-reference-audit.md`

