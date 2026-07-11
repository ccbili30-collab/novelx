# Long Context Project Reading Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Let the Steward read and synthesize projects larger than one model context without discarding sources or asking the user to shrink a normally decomposable task.

**Architecture:** Project files are read through bounded character ranges. After each range, the Steward persists a source-linked working note in the workspace database. Before later provider requests, raw file chunks that already have a persisted note are replaced by compact source receipts; final synthesis uses the notes and can re-read exact ranges when verification is needed. The run remains fail-closed when even the minimum request cannot fit or the provider is unavailable.

**Tech Stack:** Electron, TypeScript, SQLite, Pi Agent, Zod, Vitest, Playwright.

---

### Task 1: Range-based project reads

**Files:**
- Modify: `src/domain/workspace/projectFileService.ts`
- Modify: `src/shared/agentWorkerProtocol.ts`
- Modify: `src/agent-worker/tools/createAgentTools.ts`
- Modify: `src/main/workspaceAgentToolGateway.ts`
- Test: `tests/unit/project-file-service.test.ts`
- Test: `tests/unit/project-basic-file-tools.test.ts`

1. Add failing tests for `offsetChars` and `maxChars`, stable SHA-256, returned range metadata, and end-of-file behavior.
2. Implement bounded range reads without loading more content into the tool result than requested.
3. Verify unit tests.

### Task 2: Persistent source-linked working notes

**Files:**
- Modify: `src/domain/workspace/workspaceRepository.ts`
- Create: `src/domain/agent/agentTaskNoteRepository.ts`
- Modify: `src/shared/agentWorkerProtocol.ts`
- Modify: `src/agent-worker/tools/createAgentTools.ts`
- Modify: `src/main/workspaceAgentToolGateway.ts`
- Test: `tests/unit/agent-task-note-repository.test.ts`

1. Add schema migration and repository tests for run-scoped notes, source ranges, ordering, replacement, and recovery.
2. Add `save_task_note` and `list_task_notes` tools through the full Worker IPC boundary.
3. Ensure notes are auditable project metadata and never become canonical story facts automatically.

### Task 3: Context compaction after durable notes

**Files:**
- Modify: `src/agent-worker/pi/contextAdmissionPolicy.ts`
- Modify: `src/agent-worker/pi/NovaxPiRuntimeAdapter.ts`
- Test: `tests/unit/context-budget-policy.test.ts`
- Test: `tests/unit/pi-adapter.test.ts`

1. Add a failing test where several large read results exceed the context window after their notes are saved.
2. Compact only file chunks already covered by a successful `save_task_note` receipt.
3. Preserve paths, hashes and ranges in compact receipts; never silently truncate uncovered material.
4. Reject when the compacted request still cannot fit.

### Task 4: Steward long-task contract and progress

**Files:**
- Modify: `src/agent-worker/stewardExecutionStateMachine.ts`
- Modify: `src/shared/agentRuntimeProfiles.ts`
- Modify: `src/agent-worker/prompts/manifest.ts`
- Modify: `src/shared/ipcContract.ts`
- Modify: `src/main/agentProcessSupervisor.ts`
- Modify: `src/renderer/src/features/agent/StewardRuntimePanel.tsx`
- Test: `tests/unit/agent-worker-contract.test.ts`
- Test: `tests/unit/agent-process-supervisor.test.ts`

1. Permit bounded repeated read-note cycles rather than a five-step ceiling.
2. Require a durable note before moving away from an incomplete file range.
3. Emit progress with completed/total units and show it in the activity UI.
4. Replace the public budget message with a genuine non-decomposable-task error.

### Task 5: Real closure verification

**Files:**
- Create: `tests/e2e/packaged-long-context-reading.spec.ts`
- Create: `docs/long-context-reading-regression.md`
- Create: `notes/status/2026-07-12-long-context-reading.md`

1. Build a project whose combined Chinese text exceeds one configured context window.
2. Run a real Provider task that reads all files and produces a source-linked world summary.
3. Verify task notes survive the run, every source range is covered, the final response completes, and no Electron process remains.
4. Run full unit tests, typecheck, build, package verification and packaged E2E.

