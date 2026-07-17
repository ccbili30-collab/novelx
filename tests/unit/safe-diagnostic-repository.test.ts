import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { SafeDiagnosticRepository } from "../../src/domain/audit/safeDiagnosticRepository";
import type { SafeDiagnosticEnvelopeV1 } from "../../src/shared/diagnostics/safeDiagnosticContract";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SafeDiagnosticRepository", () => {
  it("appends, replays and lists one strict diagnostic without storing arbitrary text", () => {
    const { repository, workspace } = setup();
    const diagnostic = envelope();

    expect(repository.append(diagnostic)).toEqual(diagnostic);
    expect(repository.append(diagnostic)).toEqual(diagnostic);
    expect(repository.get(diagnostic.diagnosticId)).toEqual(diagnostic);
    expect(repository.listOperation("growth_cycle", "cycle-1")).toEqual([diagnostic]);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM safe_diagnostic_events").get()).toEqual({ count: 1 });
    expect(workspace.db.prepare("PRAGMA table_info(safe_diagnostic_events)").all())
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "message" }),
        expect.objectContaining({ name: "details" }),
        expect.objectContaining({ name: "metadata" }),
      ]));
  });

  it("rejects a reused diagnostic id or sequence with a different payload", () => {
    const { repository } = setup();
    repository.append(envelope());

    expect(() => repository.append({ ...envelope(), code: "GROWTH_REVISION_FRAGMENT_INVALID" }))
      .toThrowError(expect.objectContaining({ code: "SAFE_DIAGNOSTIC_REPLAY_CONFLICT" }));
    expect(() => repository.append({ ...envelope(), diagnosticId: "diagnostic-other" }))
      .toThrowError(expect.objectContaining({ code: "SAFE_DIAGNOSTIC_SEQUENCE_CONFLICT" }));
  });

  it("requires contiguous per-operation sequence and an existing same-context parent", () => {
    const { repository } = setup();
    expect(() => repository.append({ ...envelope(), diagnosticId: "diagnostic-2", sequence: 2 }))
      .toThrowError(expect.objectContaining({ code: "SAFE_DIAGNOSTIC_SEQUENCE_INVALID" }));

    repository.append(envelope());
    expect(() => repository.append({
      ...envelope(), diagnosticId: "diagnostic-2", sequence: 2, parentDiagnosticId: "missing-parent",
    })).toThrowError(expect.objectContaining({ code: "SAFE_DIAGNOSTIC_PARENT_NOT_FOUND" }));

    expect(repository.append({
      ...envelope(), diagnosticId: "diagnostic-2", sequence: 2, parentDiagnosticId: "diagnostic-1",
      disposition: "corrected", retryability: "do_not_retry",
    })).toMatchObject({ diagnosticId: "diagnostic-2", parentDiagnosticId: "diagnostic-1" });
  });

  it("allows causal parents across operations but rejects links across Runs or Cycles", () => {
    const { repository } = setup();
    repository.append(envelope());

    expect(repository.append({
      ...envelope(), operationKind: "tool_call", operationId: "tool-2", diagnosticId: "diagnostic-tool-2",
      sequence: 1, parentDiagnosticId: "diagnostic-1",
    })).toMatchObject({ parentDiagnosticId: "diagnostic-1", operationId: "tool-2" });

    for (const change of [
      { runId: "run-2" },
      { cycleId: "cycle-2" },
    ]) {
      expect(() => repository.append({
        ...envelope(), ...change, diagnosticId: `diagnostic-${JSON.stringify(change)}`,
        operationKind: "tool_call", operationId: `tool-${JSON.stringify(change)}`,
        sequence: 1, parentDiagnosticId: "diagnostic-1",
      })).toThrowError(expect.objectContaining({ code: "SAFE_DIAGNOSTIC_PARENT_CONTEXT_INVALID" }));
    }
  });

  it("fails once with a stable persistence code and never recursively appends", () => {
    const { repository, workspace } = setup();
    workspace.db.exec(`
      CREATE TRIGGER reject_safe_diagnostics BEFORE INSERT ON safe_diagnostic_events
      BEGIN SELECT RAISE(ABORT, 'raw secret must not escape'); END;
    `);

    expect(() => repository.append(envelope()))
      .toThrowError(expect.objectContaining({ code: "SAFE_DIAGNOSTIC_PERSISTENCE_FAILED" }));
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM safe_diagnostic_events").get()).toEqual({ count: 0 });
  });
});

function setup(): { workspace: WorkspaceDatabase; repository: SafeDiagnosticRepository } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-safe-diagnostic-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  return { workspace, repository: new SafeDiagnosticRepository(workspace) };
}

function envelope(): SafeDiagnosticEnvelopeV1 {
  return {
    schemaVersion: 1,
    diagnosticId: "diagnostic-1",
    operationKind: "growth_cycle",
    operationId: "cycle-1",
    runId: "run-1",
    cycleId: "cycle-1",
    toolInvocationId: null,
    parentDiagnosticId: null,
    sequence: 1,
    owner: "growth_phase",
    boundary: "phase_compile",
    code: "GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH",
    toolName: "propose_change_set",
    attempt: 1,
    maxAttempts: 2,
    sideEffectState: "none",
    disposition: "correctable",
    retryability: "model_correction",
    occurredAt: "2026-07-17T00:00:00.000Z",
  };
}
