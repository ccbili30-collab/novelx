import { describe, expect, it } from "vitest";
import { projectGrowthClosureSafeEvaluation } from "../e2e/support/growthClosureSafeEvidence";

describe("Growth closure safe evidence", () => {
  it("keeps only structural closure diagnostics and counts evidence links", () => {
    const projected = projectGrowthClosureSafeEvaluation({
      cycleSequence: 12,
      decision: "continue_growing",
      facetResults: [{
        facetId: "world_consistency",
        state: "missing",
        coverage: "partial",
        evidence: [{ receiptId: "secret-receipt", rank: 1 }],
        safeSummary: "must not be accepted by the projection input",
      } as never],
      adverseFindings: [{
        severity: "major",
        category: "evidence_gap",
        targetEvidence: [{ receiptId: "secret-receipt", rank: 2 }],
        repairObjective: "must not be accepted by the projection input",
      } as never],
    });

    expect(projected).toEqual({
      cycleSequence: 12,
      decision: "continue_growing",
      facetResults: [{
        facetId: "world_consistency",
        state: "missing",
        coverage: "partial",
        evidenceCount: 1,
      }],
      checkerFindings: [{
        severity: "major",
        category: "evidence_gap",
        targetEvidenceCount: 1,
      }],
    });
    expect(JSON.stringify(projected)).not.toContain("secret-receipt");
    expect(JSON.stringify(projected)).not.toContain("repairObjective");
    expect(JSON.stringify(projected)).not.toContain("safeSummary");
  });
});
