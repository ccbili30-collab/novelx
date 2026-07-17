# Safe Diagnostic Pipeline v1

Date: 2026-07-17
Status: accepted for hackathon implementation
Schema: workspace v27

## Decision

NovelX records operational failures through a strict `SafeDiagnosticEnvelopeV1`. The envelope carries only allowlisted identity, ownership, boundary, failure code, attempt, side-effect and retry fields. It never carries raw exception messages, Provider responses, Prompt text, tool arguments, document content, credentials, stack traces or arbitrary metadata.

Each capability owns its diagnostic catalog locally. The shared contract defines the stable envelope vocabulary, not every phase-specific code. Main persists validated envelopes in the append-only `safe_diagnostic_events` table. Existing public errors remain summaries; a later integration stage may correlate them to a diagnostic ID, but Renderer code must not infer a root cause from summary text.

Image Provider failures use a two-level contract. The Image Job and Main-only diagnostic may retain one allowlisted class derived from the HTTP status (`AUTH_FAILED`, `MODEL_UNAVAILABLE`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `REQUEST_REJECTED`, `PROTOCOL_FAILED` or the safe fallback). A connection failure remains an unknown outcome and enters reconciliation rather than a terminal retry. The Worker response and ordinary tool terminal remain the broad `IMAGE_GENERATION_FAILED` or the existing reconciliation code. Response bodies, headers, URLs and raw messages are discarded. An unknown diagnostic subcode is ignored and falls back to the broad code.

Revision reference failures are classified at the compiler that owns the rule: document owner, assertion scope, document source, relation endpoint and resource parent each have a stable code. The invalid identifier itself is never included in the code, fixed correction text or persisted envelope. Correction `attempt` and `maxAttempts` are projected together or both omitted.

## Persistence invariants

- Workspace v26 to v27 is additive: one table, five indexes and the schema version update in one transaction.
- Existing Agent, Growth, Change Set, document, assertion, relation, image and checkpoint rows are not rewritten.
- Old runs have no diagnostic rows; migration does not fabricate history.
- An operation starts at sequence 1 and advances contiguously.
- A diagnostic ID and an operation sequence support exact replay only. A different payload is rejected.
- Parent diagnostics must already exist in the same Run/Cycle context. A child may link a prior boundary operation; within the same operation, its parent sequence must precede the child.
- The repository exposes append/read/list operations only. It has no update or delete path.
- A diagnostic persistence failure produces one fixed local repository error. It never recursively attempts to persist another diagnostic.

## Safety and recovery

`model_correction` is legal only before side effects. `outcome_unknown` requires `reconciliation_required` and `restart_reconcile`. These rules are enforced by the shared Zod contract before persistence and again by constrained SQL columns where practical.

This ADR does not claim that Provider, Worker, Tool Bridge, Gateway, Domain, Growth or Renderer integration is complete. Those boundaries remain later stages in `docs/plans/2026-07-17-safe-diagnostic-pipeline-v1.md`.

## Verification route

```powershell
npx --no-install vitest run --config vitest.config.ts tests/unit/safe-diagnostic-contract.test.ts tests/unit/safe-diagnostic-repository.test.ts tests/unit/workspace-persistence.test.ts
npm run typecheck
git diff --check
```
