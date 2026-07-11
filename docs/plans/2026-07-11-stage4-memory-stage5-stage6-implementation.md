# Stage 4 Memory, Stage 5 Playthrough, and Stage 6 Import Implementation Plan

> **For Codex:** Use the executing-plans skill to implement this plan task-by-task and preserve fail-closed Agent behavior.

**Goal:** Complete the memory projection prerequisites, add immutable story/playthrough boundaries and the real GM chain, then add auditable local novel import and decomposition.

**Architecture:** Existing versioned workspace tables remain canonical. Memory views and import analyses are rebuildable projections. Playthroughs pin accepted canon commits and append immutable GM resolutions, while imported candidates enter canon only through the existing Change Set policy.

**Tech Stack:** TypeScript, Node.js SQLite, Electron IPC, React, Pi Agent runtime, Vitest, Playwright, Windows PowerShell.

---

## Completion Gates

- No projection, import candidate, or model fallback may be presented as canon.
- No GM/Writer result may be produced without a real configured Provider.
- Old Playthroughs must remain byte-for-byte reproducible after creator canon changes.
- Every imported candidate must retain source file hash and structured locator.
- Free/Assist behavior must use the existing Change Set policy.

### Task 1: Schema v11 projection catalog

**Files:**
- Modify: `src/domain/workspace/workspaceRepository.ts`
- Create: `src/domain/projection/projectionCatalog.ts`
- Test: `tests/unit/workspace-persistence.test.ts`
- Test: `tests/unit/projection-catalog.test.ts`

Add timeline, retrieval, summary, and character-knowledge projection records without pretending they have run. Make schema migration idempotent and crash recoverable.

### Task 2: Timeline and retrieval projections

**Files:**
- Create: `src/domain/projection/timelineProjector.ts`
- Create: `src/domain/projection/retrievalProjector.ts`
- Modify: `src/domain/projection/projectionCoordinator.ts`
- Modify: `src/domain/retrieval/contextPacketService.ts`
- Test: `tests/unit/timeline-projector.test.ts`
- Test: `tests/unit/retrieval-projector.test.ts`

Build deterministic, source-linked timeline entries and lexical retrieval documents. Use SQLite FTS5 when available and fail closed to a declared non-indexed state when unavailable; do not silently label ordered scans as ranked retrieval.

### Task 3: Summary and character-knowledge projections

**Files:**
- Create: `src/domain/projection/summaryProjector.ts`
- Create: `src/domain/projection/characterKnowledgeProjector.ts`
- Test: `tests/unit/summary-projector.test.ts`
- Test: `tests/unit/character-knowledge-projector.test.ts`

Create deterministic extractive summaries first. Character knowledge must distinguish observed, told, inferred, and unknown facts and retain evidence IDs.

### Task 4: Memory-aware context admission

**Files:**
- Modify: `src/agent-worker/pi/contextAdmissionPolicy.ts`
- Modify: `src/domain/retrieval/contextPacketService.ts`
- Modify: `src/main/workspaceAgentToolGateway.ts`
- Test: `tests/unit/context-admission-policy.test.ts`
- Test: `tests/unit/context-packet-service.test.ts`

Select evidence by scope, query relevance, recency, authority, and token budget. Expose omissions and stale projection state to the Agent so it must retrieve again or block.

### Task 5: Schema v12 story canon and playthroughs

**Files:**
- Modify: `src/domain/workspace/workspaceRepository.ts`
- Create: `src/domain/story/storyProfileRepository.ts`
- Create: `src/domain/play/playthroughRepository.ts`
- Test: `tests/unit/story-profile-repository.test.ts`
- Test: `tests/unit/playthrough-repository.test.ts`

Add version-pinned Story Profiles, OC Variant bindings, append-only Playthroughs, turns, state snapshots, and reconciliation decisions. SQLite triggers must prevent mutation of accepted turns.

### Task 6: Canon change reconciliation

**Files:**
- Create: `src/domain/play/playthroughReconciliationService.ts`
- Modify: `src/shared/ipcContract.ts`
- Modify: `src/main/workspaceIpc.ts`
- Modify: `src/preload/desktopApi.ts`
- Test: `tests/unit/playthrough-reconciliation-service.test.ts`

Detect when a playthrough baseline differs from current canon. Return only `continue_pinned` and `fork_from_current`; never auto-merge or generate bridging fiction.

### Task 7: Real GM, Writer, and Validator runtime

**Files:**
- Create: `src/agent-worker/play/gmTurnRuntime.ts`
- Create: `src/agent-worker/play/writerTurnRuntime.ts`
- Create: `src/agent-worker/play/turnValidator.ts`
- Create: versioned GM and Validator prompts under `src/agent-worker/prompts/`
- Modify: `src/agent-worker/prompts/manifest.ts`
- Modify: `src/shared/agentWorkerProtocol.ts`
- Test: contract tests, prompt evals, and real Provider E2E

GM produces a structured immutable resolution. Writer receives only that resolution and cited evidence. Validator rejects new outcomes, hidden-state leakage, unsupported facts, and player-visible internal fields.

### Task 8: Player mode UI

**Files:**
- Create: `src/renderer/src/features/player/`
- Modify: `src/renderer/src/App.tsx`
- Test: `tests/e2e/player-mode.spec.ts`

Add Story Profile selection, playthrough creation, card presentation, action input, blocked/error states, and the explicit old-save/new-branch reconciliation dialog.

### Task 9: Schema v13 source library and import jobs

**Files:**
- Modify: `src/domain/workspace/workspaceRepository.ts`
- Create: `src/domain/import/sourceLibraryRepository.ts`
- Create: `src/domain/import/importJobRepository.ts`
- Test: `tests/unit/source-library-repository.test.ts`

Store source identity, SHA-256, format, size, rights attestation, parse state, structured locators, immutable chunks, and job attempts. Do not duplicate large original files into SQLite.

### Task 10: TXT, Markdown, DOCX, EPUB, and image scanning

**Files:**
- Create: `src/domain/import/parsers/`
- Modify: `package.json`
- Test: parser fixtures under `tests/fixtures/import/`

Parse UTF-8/legacy text safely, preserve Markdown sections, extract DOCX paragraphs, EPUB spine/chapters, and register images as source assets. Unsupported or encrypted files must block with public error codes.

### Task 11: Decomposer pipeline

**Files:**
- Create: `src/agent-worker/import/decomposerRuntime.ts`
- Create: `src/domain/import/decompositionCandidateRepository.ts`
- Create: versioned Decomposer prompt and evals
- Test: `tests/unit/decomposition-candidate-repository.test.ts`
- Test: real Provider import E2E

Run staged extraction for characters, world rules, locations, factions, events, style, and unresolved ambiguity. Every candidate carries source locators and confidence; no candidate is canon yet.

### Task 12: Candidate review and Start Profiles

**Files:**
- Create: `src/domain/import/importReviewService.ts`
- Create: `src/domain/story/startProfileRepository.ts`
- Create: `src/renderer/src/features/import/`
- Test: `tests/e2e/import-review.spec.ts`

Allow accept, edit, reject, and batch review. Accepted candidates become Change Set items. Generate multiple Start Profiles while keeping original future events separate from player timelines.

### Task 13: Full verification and release

Run typecheck, all unit tests, prompt contract tests, prompt evals, production build, all Electron E2E, real Provider evidence, package verification, installer verification, version bump, and GitHub Release publication.

