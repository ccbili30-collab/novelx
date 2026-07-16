import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  growthRevisionPhaseHandler,
  revisionToolPresentation,
} from "../../src/agent-worker/growth/phases/revision/growthRevisionPhase";
import { growthRunBindingSchema, type GrowthRunBinding } from "../../src/shared/agentWorkerProtocol";
import { growthCapabilityVersion } from "../../src/shared/growthContract";

describe("Growth revision phase", () => {
  it("owns one retrieve-inquiry-propose sequence and exposes only high-level impact fields", () => {
    const binding = revisionBinding();
    expect(growthRevisionPhaseHandler.matches(binding)).toBe(true);
    expect(growthRevisionPhaseHandler.plan(binding)).toEqual({
      objective: "change_set",
      steps: ["retrieve_graph_evidence", "submit_growth_inquiry", "propose_change_set"],
    });
    const presentation = revisionToolPresentation(binding, "propose_change_set");
    expect(presentation).not.toBeNull();
    const visibleSchema = JSON.stringify(presentation!.parameters);
    expect(visibleSchema).toContain("impact");
    expect(visibleSchema).toContain("stale_visual");
    for (const forbidden of [
      "checkpointId", "branchId", "scopeResourceIds", "ruleRevision", "receiptId",
      "resourceId", "documentId", "dependsOn", "create", "state",
    ]) expect(visibleSchema).not.toContain(forbidden);
    expect(Value.Check(presentation!.parameters, { summary: "forged", items: [] })).toBe(false);
  });

  it("does not replace ordinary or unrelated tools", () => {
    expect(growthRevisionPhaseHandler.matches(revisionBinding({ kind: "expand", focusKinds: ["world"] }))).toBe(false);
    expect(revisionToolPresentation(revisionBinding(), "generate_image")).toBeNull();
  });
});

function revisionBinding(overrides: Partial<GrowthRunBinding> = {}): GrowthRunBinding {
  return growthRunBindingSchema.parse({
    capabilityVersion: growthCapabilityVersion,
    goalId: "goal", cycleId: "cycle", kind: "revision", focusKinds: ["world", "story", "oc"],
    resumeFrontier: [], inputCheckpointId: "checkpoint", ruleRevision: 2,
    authorizedScopeResourceIds: ["world-root", "story-root", "oc-root"], seedResourceIds: [],
    domainRootResourceIds: { world: "world-root", story: "story-root", oc: "oc-root" },
    greenfieldCreateAuthorized: false, priorInquiries: [], closureProfile: null, closureRepair: null,
    longformAuthority: null,
    ...overrides,
  });
}
