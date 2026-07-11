# Project Files Panel, Cloude Theme, and Worker Repair Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make real project files visible and openable without Agent involvement, add the `cloude` visual theme, and diagnose and repair packaged Agent worker interruption with auditable evidence.

**Architecture:** Expose a read-only project-file listing and read contract through the existing workspace main-process boundary, then render it as an independent collapsible section beside the existing activity panel. Extend the existing design-token theme system rather than adding component-local colors. Reproduce worker failure through the packaged runtime, preserve child exit diagnostics without exposing internals in player UI, and lock the repaired path with tests.

**Tech Stack:** Electron, React, TypeScript, Zod, SQLite, Vitest, Playwright, electron-builder, PowerShell.

---

### Task 1: Real project-file renderer contract

**Files:**
- Modify: `src/shared/ipcContract.ts`
- Modify: `src/main/workspaceIpc.ts`
- Modify: `src/main/registerDesktopIpc.ts`
- Modify: `src/preload/desktopApi.ts`
- Test: `tests/unit/workspace-persistence.test.ts` or a focused IPC test

**Steps:** Add typed list/read requests and results, route them through `ProjectFileService`, verify project-root confinement and ignored internal directories, then run focused tests.

### Task 2: Right-side folder and activity sections

**Files:**
- Create or modify: `src/renderer/src/features/activity/ProjectFilesPanel.tsx`
- Modify: `src/renderer/src/features/activity/ProjectActivityPanel.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles/base.css`
- Test: focused renderer tests and Playwright E2E

**Steps:** Render `文件夹内容` open by default and `活动与产物` closed by default, allow both to be independently open or closed, persist state per project, support folder expansion and file opening, and verify empty/loading/error states.

### Task 3: Cloude design-token theme

**Files:**
- Modify: `src/shared/themePreference.ts`
- Modify: `src/renderer/src/features/provider/ProviderSettingsDialog.tsx`
- Modify: `src/renderer/src/styles/base.css`
- Test: theme preference and renderer tests

**Steps:** Register `cloude`, map supplied colors and typography into Novax design tokens, add a settings swatch, preserve white/dark/high-contrast behavior, and verify persistence.

### Task 4: Packaged Agent worker diagnosis and repair

**Files:**
- Modify as evidence requires: `src/main/agentProcessSupervisor.ts`
- Modify as evidence requires: worker packaging/build configuration
- Test: packaged Electron real-provider E2E or deterministic packaged-worker harness
- Document: `docs/project-file-panel-worker-repair-0.2.5.md`

**Steps:** Reproduce the interruption using the packaged worker path, capture exit code/signal/stderr into audit-safe diagnostics, rank and test causes, repair the proven cause, and ensure the UI remains user-facing while diagnostics remain auditable.

### Task 5: Full verification and release readiness

**Steps:** Run typecheck, focused tests, full unit suite, build, package verification, real Electron E2E, and screenshot checks at desktop dimensions. Record implemented scope, omissions, residual risks, and whether the change is a complete user-visible closure before publishing.
