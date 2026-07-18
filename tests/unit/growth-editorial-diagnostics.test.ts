import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SafeDiagnosticRepository } from "../../src/domain/audit/safeDiagnosticRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import {
  classifyGrowthEditorialFailure,
  ensureGrowthEditorialDiagnostic,
  growthEditorialDiagnosticCatalog,
} from "../../src/main/diagnostics/growthEditorialDiagnostics";

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("Growth editorial safe diagnostics", () => {
  it.each([
    ["WORLD_DIRECTOR_PACKET_OUTPUT_INVALID", "EDITORIAL_PLAN_INVALID"],
    ["EDITORIAL_PLAN_INVALID", "EDITORIAL_PLAN_INVALID"],
    ["GROWTH_EDITORIAL_DEPENDENCY_FAILED", "WORK_ORDER_STATE_DEPENDENCY_FAILED"],
    ["GROWTH_CANDIDATE_EVIDENCE_BINDING_MISSING", "SPECIALIST_PROTOCOL_EVIDENCE_INVALID"],
    ["GROWTH_CANDIDATE_CAUSAL_SUPPORT_REQUIRED", "GRAPH_CAUSAL_EVIDENCE_INVALID"],
    ["GROWTH_EDITORIAL_REVIEW_BINDING_INVALID", "EDITORIAL_REVIEW_BINDING_INVALID"],
    ["PROVIDER_RATE_LIMITED", "PROVIDER_RATE_LIMITED"],
    ["PROVIDER_PROTOCOL_STRUCTURED_RESULT_INVALID", "PROVIDER_PROTOCOL_FAILED"],
    ["DOMAIN_CAUSAL_SELF_EDGE_FORBIDDEN", "DOMAIN_CAUSAL_INVALID"],
    ["DOMAIN_ROOT_PROTECTED", "DOMAIN_ROOT_FORBIDDEN"],
    ["PERSISTENCE_FAILED", "PERSISTENCE_FAILED"],
    ["SAFE_DIAGNOSTIC_PERSISTENCE_FAILED", "PERSISTENCE_FAILED"],
    ["GROWTH_EDITORIAL_COMMIT_OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED"],
  ])("maps the allowlisted source %s to %s", (source, expected) => {
    expect(classifyGrowthEditorialFailure(source)).toBe(expected);
  });

  it("contains unknown and secret-bearing errors without retaining their source text", () => {
    const secret = "PROVIDER_TOKEN_sk-secret-response-body";
    expect(classifyGrowthEditorialFailure(secret)).toBe("WORK_ORDER_STATE_UNCLASSIFIED_FAILURE");
    expect(classifyGrowthEditorialFailure({ code: "PROVIDER_RATE_LIMITED", body: secret }))
      .toBe("WORK_ORDER_STATE_UNCLASSIFIED_FAILURE");
    expect(classifyGrowthEditorialFailure("PROVIDER_SECRET_UPSTREAM_CLASS"))
      .toBe("WORK_ORDER_STATE_UNCLASSIFIED_FAILURE");
    expect(classifyGrowthEditorialFailure("DOMAIN_CAUSAL_SECRET_INTERNAL_RULE"))
      .toBe("WORK_ORDER_STATE_UNCLASSIFIED_FAILURE");
    expect(JSON.stringify(growthEditorialDiagnosticCatalog.codes)).not.toContain(secret);
  });

  it("persists one classified envelope and never stores the raw source error", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-editorial-diagnostic-"));
    workspace = openWorkspace(root);
    const sourceCode = "UPSTREAM_secret-response-body";
    const input = {
      workspace,
      workOrderId: "work-order-1",
      sourceCode,
      occurredAt: "2026-07-18T00:00:00.000Z",
    };
    const first = ensureGrowthEditorialDiagnostic(input);
    const replay = ensureGrowthEditorialDiagnostic({ ...input, occurredAt: "2026-07-18T00:01:00.000Z" });
    const persisted = new SafeDiagnosticRepository(workspace).listOperation("tool_call", "work-order-1");

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      code: "WORK_ORDER_STATE_UNCLASSIFIED_FAILURE",
      owner: "growth_phase",
      boundary: "phase_compile",
      sideEffectState: "none",
      disposition: "terminal",
      retryability: "do_not_retry",
    });
    expect(persisted).toEqual([first]);
    expect(JSON.stringify(persisted)).not.toContain(sourceCode);
    expect(first).not.toHaveProperty("message");
    expect(first).not.toHaveProperty("details");
  });

  it("marks outcome-unknown commits as reconciliation instead of safe retry", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-editorial-reconciliation-"));
    workspace = openWorkspace(root);
    const value = ensureGrowthEditorialDiagnostic({
      workspace,
      workOrderId: "work-order-1",
      sourceCode: "GROWTH_EDITORIAL_COMMIT_OUTCOME_UNKNOWN",
      occurredAt: "2026-07-18T00:00:00.000Z",
    });
    expect(value).toMatchObject({
      code: "RECONCILIATION_REQUIRED",
      owner: "reconciliation",
      boundary: "recovery",
      sideEffectState: "outcome_unknown",
      disposition: "reconciliation_required",
      retryability: "restart_reconcile",
    });
  });
});
