import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  growthImpactBriefParameters,
  growthImpactBriefSchema,
} from "../../src/agent-worker/growth/phases/revision/growthImpactBrief";

describe("Growth revision impact brief", () => {
  const valid = {
    summary: "The revised rule changes the world's cultural framing while preserving unrelated facts.",
    targets: [
      { evidenceId: "world-version-1", decision: "revise", reasonSummary: "The setting text carries the old framing." },
      { evidenceId: "oc-version-1", decision: "preserve", reasonSummary: "This character history is unaffected." },
    ],
    additions: [{ kind: "relation", reasonSummary: "The revised story must explicitly retain its world link." }],
  } as const;

  it("accepts only an authority-free, bounded impact summary", () => {
    expect(growthImpactBriefSchema.parse(valid)).toEqual(valid);
    expect(Value.Check(growthImpactBriefParameters, valid)).toBe(true);
    for (const authority of ["checkpointId", "branchId", "scopeResourceIds", "ruleRevision", "receiptId", "resourceId"]) {
      expect(growthImpactBriefSchema.safeParse({ ...valid, [authority]: "forged" }).success).toBe(false);
      expect(Value.Check(growthImpactBriefParameters, { ...valid, [authority]: "forged" })).toBe(false);
    }
  });

  it("fails closed on empty summaries and duplicate target evidence", () => {
    expect(growthImpactBriefSchema.safeParse({ ...valid, summary: " " }).success).toBe(false);
    expect(growthImpactBriefSchema.safeParse({
      ...valid,
      targets: [valid.targets[0], { ...valid.targets[0], decision: "preserve" }],
    }).success).toBe(false);
  });
});
