import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendPersistedFreePolicyConflictDiagnostic } from "../../src/main/diagnostics/changeSetPolicyDiagnostics";
import { ChangeSetService } from "../../src/domain/changeSet/changeSetService";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { SafeDiagnosticRepository } from "../../src/domain/audit/safeDiagnosticRepository";
import { createMainToolFailureDiagnostic, mainToolDiagnosticCatalog } from "../../src/main/diagnostics/mainToolDiagnostics";

describe("Main tool Safe Diagnostics", () => {
  it("classifies policy rejection before side effects", () => {
    expect(diagnostic("RESOURCE_PARENT_NOT_FOUND", "propose_change_set")).toMatchObject({
      owner: "domain_policy", boundary: "change_set_policy", sideEffectState: "none",
      disposition: "terminal", retryability: "do_not_retry",
    });
  });

  it("classifies timeout and known unknown outcomes as reconciliation required", () => {
    expect(diagnostic("AGENT_TOOL_TIMEOUT", "generate_image")).toMatchObject({
      owner: "reconciliation", boundary: "recovery", sideEffectState: "outcome_unknown",
      disposition: "reconciliation_required", retryability: "restart_reconcile",
    });
    expect(diagnostic("IMAGE_GENERATION_RECONCILIATION_REQUIRED", "generate_image"))
      .toMatchObject({ sideEffectState: "outcome_unknown", disposition: "reconciliation_required" });
  });

  it("covers every existing strict Main tool code exactly once", () => {
    expect(mainToolDiagnosticCatalog.codes.length).toBeGreaterThan(50);
    expect(new Set(mainToolDiagnosticCatalog.codes).size).toBe(mainToolDiagnosticCatalog.codes.length);
    expect(mainToolDiagnosticCatalog.codes).toContain("CHANGE_SET_APPLY_FAILED");
    expect(mainToolDiagnosticCatalog.codes).toContain("IMAGE_GENERATION_FAILED");
    expect(mainToolDiagnosticCatalog.codes).toContain("IMAGE_PROVIDER_RATE_LIMITED");
  });

  it("classifies stable image Provider subcodes without exposing response details", () => {
    expect(diagnostic("IMAGE_PROVIDER_AUTH_FAILED", "generate_image")).toMatchObject({
      owner: "provider", boundary: "provider_inference", sideEffectState: "request_sent",
      disposition: "terminal", retryability: "do_not_retry",
    });
    expect(diagnostic("IMAGE_PROVIDER_RATE_LIMITED", "generate_image")).toMatchObject({
      owner: "provider", boundary: "provider_inference", sideEffectState: "request_sent",
      disposition: "terminal", retryability: "user_action",
    });
    expect(diagnostic("IMAGE_PROVIDER_PROTOCOL_FAILED", "generate_image")).toMatchObject({
      owner: "provider", boundary: "provider_protocol", sideEffectState: "request_sent",
    });
    expect(diagnostic("IMAGE_PROVIDER_CONNECTION_FAILED", "generate_image")).toMatchObject({
      owner: "provider", boundary: "provider_connect", sideEffectState: "outcome_unknown",
      disposition: "reconciliation_required", retryability: "restart_reconcile",
    });
  });

  it("classifies module-local Revision policy reasons without exposing proposal data", () => {
    expect(diagnostic("GROWTH_REVISION_POLICY_MUTATION_SET_MISMATCH", "propose_change_set")).toMatchObject({
      owner: "main_gateway", boundary: "tool_authorization", sideEffectState: "none",
      disposition: "terminal", retryability: "do_not_retry",
    });
    expect(mainToolDiagnosticCatalog.codes).toContain("GROWTH_REVISION_POLICY_EXISTING_TARGET_INVALID");
  });

  it("persists the first allowlisted major conflict for a blocked Free Change Set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-policy-diagnostic-"));
    const workspace = openWorkspace(root);
    try {
      const service = new ChangeSetService(workspace, {
        assess: (candidate) => candidate.items.map((item) => ({
          itemId: item.id,
          risk: "elevated" as const,
          conflicts: [{ severity: "major" as const, code: "RESOURCE_PARENT_NOT_ACTIVE" }],
        })),
      });
      const changeSet = service.propose({
        idempotencyKey: "blocked-free-diagnostic",
        expectedHeadCheckpointId: new CheckpointRepository(workspace).getActiveBranch().headCheckpointId,
        mode: "free",
        summary: "Blocked without exposing content",
        items: [{
          id: "resource", dependsOn: [], kind: "resource.put",
          payload: {
            resourceId: "resource-1", create: true, type: "world", objectKind: "world",
            title: "Safe title", parentId: "missing-parent", state: "active", sortOrder: 0,
          },
        }],
      });

      expect(changeSet).toMatchObject({ mode: "free", status: "pending", gateStatus: "blocked" });
      expect(appendPersistedFreePolicyConflictDiagnostic({
        workspace, changeSetId: changeSet.id, runId: "run-1", cycleId: "cycle-1",
        toolInvocationId: "tool-1", occurredAt: "2026-07-17T00:00:00.000Z",
      })).toMatchObject({
        code: "RESOURCE_PARENT_NOT_ACTIVE", owner: "domain_policy", boundary: "change_set_policy",
        sideEffectState: "committed", disposition: "terminal", retryability: "do_not_retry",
      });
      expect(new SafeDiagnosticRepository(workspace).listRun("run-1")).toHaveLength(1);
    } finally {
      workspace.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function diagnostic(
  code: Parameters<typeof createMainToolFailureDiagnostic>[0]["code"],
  tool: Parameters<typeof createMainToolFailureDiagnostic>[0]["tool"],
) {
  return createMainToolFailureDiagnostic({
    diagnosticId: "diagnostic-1", runId: "run-1", cycleId: "cycle-1",
    requestId: "11111111-1111-4111-8111-111111111111", tool, code,
    occurredAt: "2026-07-17T00:00:00.000Z",
  });
}
