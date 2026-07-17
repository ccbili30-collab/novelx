import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { SafeDiagnosticRepository } from "../../src/domain/audit/safeDiagnosticRepository";
import {
  ensureGrowthCycleDiagnostic,
  growthCycleDiagnosticCatalog,
  isGrowthCycleFailureCode,
  isGrowthRunStartDiagnosticCode,
} from "../../src/main/diagnostics/growthCycleDiagnostics";

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("Growth cycle safe diagnostics", () => {
  it("records reconciliation once with no raw diagnostic fields", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-diagnostic-"));
    workspace = openWorkspace(root);
    const input = {
      workspace,
      cycleId: "cycle-1",
      runId: "run-1",
      code: "GROWTH_CHANGE_SET_OUTCOME_UNKNOWN" as const,
      occurredAt: "2026-07-17T00:00:00.000Z",
    };
    const first = ensureGrowthCycleDiagnostic(input);
    const replay = ensureGrowthCycleDiagnostic({ ...input, occurredAt: "2026-07-17T00:01:00.000Z" });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      owner: "reconciliation",
      boundary: "recovery",
      sideEffectState: "outcome_unknown",
      disposition: "reconciliation_required",
      retryability: "restart_reconcile",
    });
    expect(first).not.toHaveProperty("message");
    expect(first).not.toHaveProperty("details");
    expect(new SafeDiagnosticRepository(workspace).listOperation("growth_cycle", "cycle-1")).toHaveLength(1);
  });

  it("keeps terminal failure ownership local and rejects unknown codes", () => {
    expect(growthCycleDiagnosticCatalog.get("GROWTH_PERSISTENCE_FAILED")).toMatchObject({
      owner: "persistence",
      boundary: "database_commit",
    });
    expect(growthCycleDiagnosticCatalog.get("GROWTH_PROVIDER_PROTOCOL_FAILED")).toMatchObject({
      owner: "provider",
      boundary: "provider_protocol",
    });
    expect(growthCycleDiagnosticCatalog.get("GROWTH_RUN_START_ANCHOR_INVALID")).toMatchObject({
      owner: "growth_phase",
      boundary: "phase_compile",
    });
    expect(isGrowthCycleFailureCode("GROWTH_TOOL_FAILED")).toBe(true);
    expect(isGrowthRunStartDiagnosticCode("GROWTH_RUN_START_LONGFORM_AUTHORITY_INVALID")).toBe(true);
    expect(isGrowthRunStartDiagnosticCode("GROWTH_BINDING_INVALID")).toBe(false);
    expect(isGrowthCycleFailureCode("PASSWORD=secret")).toBe(false);
  });
});
