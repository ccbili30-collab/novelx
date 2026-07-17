import { describe, expect, it } from "vitest";
import {
  safeDiagnosticEnvelopeV1Schema,
  type SafeDiagnosticEnvelopeV1,
} from "../../src/shared/diagnostics/safeDiagnosticContract";
import { createSafeDiagnosticCatalog } from "../../src/shared/diagnostics/safeDiagnosticCatalog";
import { growthRevisionDiagnosticCatalog } from "../../src/agent-worker/growth/phases/revision/growthRevisionDiagnostics";
import { growthRevisionProposalDiagnosticCatalog } from "../../src/main/growth/phases/revision/growthRevisionProposalDiagnostics";

describe("Safe Diagnostic contract", () => {
  it("accepts one strict, correlation-safe diagnostic envelope", () => {
    expect(safeDiagnosticEnvelopeV1Schema.parse(validEnvelope())).toEqual(validEnvelope());
  });

  it.each(["message", "details", "metadata", "stack", "rawCause"])("rejects forbidden arbitrary field %s", (field) => {
    expect(safeDiagnosticEnvelopeV1Schema.safeParse({ ...validEnvelope(), [field]: "token=secret" }).success).toBe(false);
  });

  it("rejects invalid attempts, self-parenting and unconstrained codes", () => {
    expect(safeDiagnosticEnvelopeV1Schema.safeParse({ ...validEnvelope(), attempt: 3, maxAttempts: 2 }).success).toBe(false);
    expect(safeDiagnosticEnvelopeV1Schema.safeParse({ ...validEnvelope(), attempt: 1, maxAttempts: null }).success).toBe(false);
    expect(safeDiagnosticEnvelopeV1Schema.safeParse({ ...validEnvelope(), parentDiagnosticId: validEnvelope().diagnosticId }).success).toBe(false);
    expect(safeDiagnosticEnvelopeV1Schema.safeParse({ ...validEnvelope(), code: "raw provider message" }).success).toBe(false);
  });

  it("allows model correction only before side effects and requires reconciliation for unknown outcomes", () => {
    expect(safeDiagnosticEnvelopeV1Schema.safeParse({
      ...validEnvelope(), sideEffectState: "request_sent", retryability: "model_correction",
    }).success).toBe(false);
    expect(safeDiagnosticEnvelopeV1Schema.safeParse({
      ...validEnvelope(), sideEffectState: "outcome_unknown", disposition: "terminal", retryability: "do_not_retry",
    }).success).toBe(false);
    expect(safeDiagnosticEnvelopeV1Schema.safeParse({
      ...validEnvelope(), sideEffectState: "outcome_unknown", disposition: "reconciliation_required", retryability: "restart_reconcile",
    }).success).toBe(true);
  });

  it("builds one immutable module-local catalog and rejects duplicate codes", () => {
    const catalog = createSafeDiagnosticCatalog([{
      code: "GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH",
      owner: "growth_phase",
      boundary: "phase_compile",
      defaultRetryability: "model_correction",
      userSummaryKey: "growth.revision.impact_mismatch",
      modelCorrectionKey: "growth.revision.correct_impact",
    }]);
    expect(catalog.get("GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH")).toMatchObject({ owner: "growth_phase" });
    expect(catalog.codes).toEqual(["GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH"]);
    expect(() => createSafeDiagnosticCatalog([
      catalog.get("GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH")!,
      catalog.get("GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH")!,
    ])).toThrowError(expect.objectContaining({ code: "SAFE_DIAGNOSTIC_CATALOG_DUPLICATE_CODE" }));
  });

  it("keeps the revision phase diagnostic vocabulary local, complete and correction-safe", () => {
    expect(growthRevisionDiagnosticCatalog.codes).toEqual([
      "GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID",
      "GROWTH_REVISION_FRAGMENT_DOCUMENT_OWNER_KIND_INVALID",
      "GROWTH_REVISION_FRAGMENT_DOCUMENT_SOURCE_REF_INVALID",
      "GROWTH_REVISION_FRAGMENT_DUPLICATE_LOCAL_ID",
      "GROWTH_REVISION_FRAGMENT_DUPLICATE_TARGET",
      "GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH",
      "GROWTH_REVISION_FRAGMENT_INVALID",
      "GROWTH_REVISION_FRAGMENT_OWNER_REF_INVALID",
      "GROWTH_REVISION_FRAGMENT_PARENT_REF_INVALID",
      "GROWTH_REVISION_FRAGMENT_REFERENCE_CYCLE",
      "GROWTH_REVISION_FRAGMENT_REFERENCE_INVALID",
      "GROWTH_REVISION_FRAGMENT_RELATION_ENDPOINT_REF_INVALID",
      "GROWTH_REVISION_FRAGMENT_RELATION_INVALID",
      "GROWTH_REVISION_FRAGMENT_SCOPE_REF_INVALID",
    ]);
    for (const code of growthRevisionDiagnosticCatalog.codes) {
      expect(growthRevisionDiagnosticCatalog.get(code)).toMatchObject({
        owner: "growth_phase",
        boundary: "phase_compile",
        defaultRetryability: "model_correction",
      });
    }
  });

  it("keeps Main Revision proposal policy diagnostics local and side-effect free", () => {
    expect(growthRevisionProposalDiagnosticCatalog.codes).toEqual([
      "GROWTH_REVISION_POLICY_ASSERTION_SOURCE_INVALID",
      "GROWTH_REVISION_POLICY_CLOSURE_REQUIREMENT_INVALID",
      "GROWTH_REVISION_POLICY_CREATED_ID_INVALID",
      "GROWTH_REVISION_POLICY_EXISTING_TARGET_INVALID",
      "GROWTH_REVISION_POLICY_FORBIDDEN_MUTATION",
      "GROWTH_REVISION_POLICY_IMPACT_AUTHORITY_INVALID",
      "GROWTH_REVISION_POLICY_IMPACT_SET_CONFLICT",
      "GROWTH_REVISION_POLICY_ITEM_GRAPH_INVALID",
      "GROWTH_REVISION_POLICY_LONGFORM_DOCUMENT_FORBIDDEN",
      "GROWTH_REVISION_POLICY_MUTATION_SET_MISMATCH",
      "GROWTH_REVISION_POLICY_OWNER_INVALID",
      "GROWTH_REVISION_POLICY_RELATION_ENDPOINT_INVALID",
    ]);
    for (const code of growthRevisionProposalDiagnosticCatalog.codes) {
      expect(growthRevisionProposalDiagnosticCatalog.get(code)).toMatchObject({
        owner: "main_gateway",
        boundary: "tool_authorization",
        defaultRetryability: "do_not_retry",
        modelCorrectionKey: null,
      });
    }
  });
});

function validEnvelope(): SafeDiagnosticEnvelopeV1 {
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
