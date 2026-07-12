# ADR-0007: Authoritative Context Compiler In Rust Runtime V2

## Status

Accepted

## Context

NovelX context is not only chat history. A Provider request can contain the published system Prompt, tool protocol, current session branch, collaboration inputs, project retrieval, graph assertions, task notes, tool calls and results, and output-token reservation. These inputs have different authority, visibility, ordering, compaction and truncation rules.

The legacy TypeScript/Pi path estimates a serialized Pi Context and reports useful budget categories, but classification still depends on message position and selected tool names. Durable file receipts are injected back as message-shaped JSON. This is sufficient for migration evidence, not for the final Runtime V2 authority boundary.

If Electron, a domain module and the Rust runtime can each normalize or trim context independently, the audited input can differ from the bytes sent to the Provider. That breaks token accounting, source disclosure, tool-call/result pairing, recovery and reproducibility. Runtime V2 therefore needs one owner for the final normalized Provider input and one durable receipt for every request.

## Decision

### Rust Owns Final Provider Input

The Rust Runtime V2 Context Compiler is authoritative for the final ordered, normalized and budget-admitted Provider input.

Electron and domain modules may supply typed candidate items and source references. They may not assemble the final Provider message list, silently remove items, reserve output tokens independently, or call the Provider around the compiler. The Provider Gateway accepts only a persisted compilation receipt and the exact compiled input identified by that receipt.

This decision does not move domain truth into the compiler. Domain modules remain authoritative for worlds, OC, stories, documents, graph assertions, task notes and source versions. The compiler decides how already-authorized typed inputs become one legal Provider request.

### Typed Context Items

The compiler consumes a versioned tagged union of `ContextItem` values rather than one concatenated string or an unclassified message array. The minimum item kinds are:

- `system_prompt`: published Prompt identity and content;
- `tool_protocol`: tool policy identity and complete tool schemas;
- `session_message`: message identity, branch, sequence, role and content;
- `retrieval_source`: stable source identity, version, locator, hash, completeness and content;
- `runtime_exchange`: assistant tool call, terminal tool result or continuation linked by tool-call identity;
- `output_reserve`: configured, Provider-default or dynamically resolved output reservation; this item is budget-visible but not model-visible.

Each item has a stable item identity, deterministic order, content hash, provenance, required/model-visible flags, token count and token-count mode. Audit-only fields do not become model-visible merely because they exist in the runtime journal.

### One Receipt Per Provider Request

Every Provider request receives one immutable `ContextCompilationReceipt`. The receipt records:

- Run and request number;
- compiler and context-policy versions;
- Provider/model/tokenizer identity;
- context window, safety reserve, resolved output reserve and available input budget;
- system Prompt, tool protocol, session history, retrieval, collaboration and runtime-conversation token categories;
- ordered item hash and final input hash;
- per-item inclusion state: `full`, `range`, `receipt_only` or `omitted`;
- truncation, omission and compaction disclosures;
- final admission decision.

The receipt stores hashes, identities, locators and counts needed for audit. Public projections do not expose Prompt text, private source text, credentials or raw tool schemas.

The following accounting must be mechanically verifiable:

```text
available input = context window - safety reserve - output reserve
estimated input = sum(model-visible included item tokens)
accepted = estimated input <= available input
```

UTF-8 byte counts may be retained as diagnostics. They must never be compared directly with a token-denominated context window.

### Tokenizer And Fallback

The compiler selects an exact tokenizer using the effective Provider and model when a maintained compatible tokenizer is available.

If an exact tokenizer is unavailable, the compiler may use a calibrated conservative estimator only when the receipt records:

- `mode: estimated`;
- estimator identity and version;
- applicable Provider/model family;
- configured safety margin or measured error bound.

Unknown models cannot inherit an unrelated tokenizer silently. If neither an exact tokenizer nor an approved conservative estimator is available, context admission fails with a typed `context_capacity` or protocol error before a Provider request.

### Persist Before Provider

The complete compilation receipt and the event referencing it must be committed before the Provider request is sent. The subsequent Provider request/response receipt references the context receipt identity.

If receipt persistence fails, the request is not sent. Recovery can therefore distinguish “compiled but not requested”, “requested with known response”, and “external outcome uncertain” without reconstructing context from UI state.

### Compaction, Pairing And Disclosure Invariants

1. The published system Prompt, complete tool protocol and current user message are required. They are not silently truncated. If the minimum legal request cannot fit, compilation fails closed.
2. Session history is selected from the current session branch in deterministic sequence order and is trimmed only at complete item/message boundaries.
3. Tool calls and their terminal results are an atomic protocol unit. Compaction cannot leave an orphan call or orphan result.
4. Source material is identified by stable version, locator and content hash. A range is truncated only at a valid character or logical boundary.
5. Raw source ranges may become `receipt_only` only after a durable task note and covering source receipt are committed. A model-authored summary without durable coverage is insufficient.
6. Compaction summaries are task state, not canonical truth. Current facts are re-retrieved from authoritative domain sources when needed.
7. Every range reduction, omission, duplicate removal or receipt replacement is recorded. Any such action marks the receipt incomplete and is visible to the Agent through a structured disclosure.
8. Output reservation is accounted separately from input and is resolved to a finite value. “Auto” is a policy mode, not an infinite number sent to a Provider.
9. Provider input order and hashing are deterministic for the same pinned inputs, compiler version and model profile.

## Alternatives Considered

### Keep TypeScript/Pi Context Assembly Authoritative

Rejected as the final boundary. It would preserve migration speed but leave final normalization coupled to Pi message shapes and split authority between Electron, Worker and Provider adapter. TypeScript remains a protocol mirror and legacy adapter, not the Runtime V2 source of truth.

### Let Each Provider Adapter Build Its Own Context

Rejected because adapters would make different truncation, schema and token decisions. Provider adapters translate one compiled request into wire format; they do not choose sources or rewrite context policy.

### Store Only The Final Serialized Prompt

Rejected because a blob cannot prove category accounting, source provenance, omission, branch selection or tool-call/result legality. It also increases secret exposure in audit storage.

### Use UTF-8 Bytes Or One Universal Character Ratio

Rejected because bytes and tokens are different units and Chinese, tool JSON, images and model tokenizers vary materially. Conservative estimation is permitted only as an explicit versioned fallback.

### Compact Everything Into One Model Summary

Rejected because a summary can lose source boundaries, conflicts and canon status. It cannot replace stable documents, graph assertions or committed task-note/source receipts.

### Persist The Receipt After The Provider Responds

Rejected because a crash between request and persistence would leave an external call with no authoritative input record and no reliable recovery classification.

## Migration Boundary

1. The existing TypeScript `contextAdmissionPolicy` remains on the legacy Pi Agent path during migration. Its token categories and long-context regression cases are input to conformance tests.
2. TypeScript defines and validates the Runtime V2 protocol mirror, but does not independently normalize the final Provider request.
3. Domain repositories expose versioned source candidates and locators. They do not perform token budgeting or Provider formatting.
4. The Rust compiler is introduced behind the Runtime V2 feature gate and initially runs in shadow/conformance mode against recorded project fixtures.
5. Legacy and Runtime V2 receipts are compared for required-item preservation, category totals, tool pairing, source coverage and disclosed omissions. Byte-for-byte Provider formatting is not required across different adapters, but the normalized semantic item set must match the pinned policy.
6. Runtime V2 cannot become the default until exact/fallback tokenizer behavior, persistence-before-request, crash recovery, Chinese long-source ranges, branch isolation and compaction pairing pass automated tests and real-Provider evidence.
7. Migration does not authorize Runtime V2 to mutate canon directly. Existing Free / Assist, Change Set, source, validation and project-version gates remain in force.

## Consequences

### Positive

- The audited context and actual Provider input have one authority.
- Token budgets and output reservation become explainable and testable per request.
- Context recovery no longer depends on Renderer memory or Pi message reconstruction.
- Compaction can reduce long tasks without silently discarding uncovered sources.
- Provider adapters remain replaceable without redefining source and truncation policy.

### Negative

- Typed item schemas and receipt persistence add implementation and storage cost.
- Tokenizer support must be maintained per Provider/model family.
- During migration, legacy and Runtime V2 context systems coexist and require conformance fixtures.
- Strict failure on unknown tokenizer or insufficient minimum context may block models that the legacy path attempted optimistically.

### Neutral

- The compiler does not decide creative truth or write canon.
- A receipt proves what was compiled and disclosed; it does not prove that a model understood every included fact.
- UI budget panels are projections of the receipt, not an independent calculator.

## References

- `docs/runtime-v2/protocol-v1.md`
- `docs/runtime-v2/current-runtime-audit.md`
- `docs/runtime-v2/codex-reference-audit.md`
- `docs/plans/2026-07-12-long-context-project-reading.md`
- `src/agent-worker/pi/contextAdmissionPolicy.ts`
