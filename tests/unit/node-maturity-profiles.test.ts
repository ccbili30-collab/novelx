import { describe, expect, it } from "vitest";
import {
  evaluateNodeMaturity,
  NODE_MATURITY_PROFILES,
  promoteNodeImportance,
  type NodeMaturityKind,
} from "../../src/domain/growth/closure/nodeMaturityProfiles";

describe("node maturity profiles", () => {
  it("keeps one executable dimension authority with the required profile sizes", () => {
    expect(Object.fromEntries(Object.entries(NODE_MATURITY_PROFILES).map(([kind, dimensions]) => [kind, dimensions.length]))).toEqual({
      oc: 14, nation: 16, organization: 12, geography: 12, species: 14, civilization: 16, story: 8, world: 8,
    });
    for (const dimensions of Object.values(NODE_MATURITY_PROFILES)) {
      expect(new Set(dimensions).size).toBe(dimensions.length);
    }
    expect(NODE_MATURITY_PROFILES.nation).toEqual(NODE_MATURITY_PROFILES.civilization);
  });

  it.each(["core", "major"] as const)("requires every sourced dimension for a %s node", (importanceTier) => {
    const input = complete("oc", importanceTier);
    input.coverage.pop();
    const result = evaluateNodeMaturity(input);
    expect(result).toMatchObject({
      policy: "coverage_criteria", fullDepthRequired: true, fullDepthReady: false, blocksConvergence: true,
      blockingMissingDimensionIds: ["personal_causal_history"],
    });
    expect(result.dimensions.at(-1)).toEqual({ dimensionId: "personal_causal_history", state: "missing", evidenceRefs: [] });

    input.coverage.push({ dimensionId: "personal_causal_history", evidenceRefs: ["assertion_personal_causality"] });
    expect(evaluateNodeMaturity(input)).toMatchObject({
      fullDepthReady: true, blocksConvergence: false, blockingMissingDimensionIds: [],
    });
  });

  it.each(["supporting", "background"] as const)("exposes gaps without inventing a blocking shallow threshold for a %s node", (importanceTier) => {
    const result = evaluateNodeMaturity({ nodeId: "node_1", nodeKind: "geography", importanceTier, coverage: [] });
    expect(result).toMatchObject({
      fullDepthRequired: false, fullDepthReady: false, blocksConvergence: false, blockingMissingDimensionIds: [],
    });
    expect(result.dimensions).toHaveLength(12);
    expect(result.dimensions.every((item) => item.state === "missing")).toBe(true);
  });

  it("re-evaluates all existing coverage as blocking when the user promotes a node", () => {
    const coverage = [{ dimensionId: "identity", evidenceRefs: ["assertion_identity"] }];
    expect(evaluateNodeMaturity({ nodeId: "oc_1", nodeKind: "oc", importanceTier: "supporting", coverage })).toMatchObject({
      fullDepthReady: false, blocksConvergence: false,
    });
    const importanceTier = promoteNodeImportance("supporting", "major");
    const promoted = evaluateNodeMaturity({ nodeId: "oc_1", nodeKind: "oc", importanceTier, coverage });
    expect(promoted.blocksConvergence).toBe(true);
    expect(promoted.blockingMissingDimensionIds).toHaveLength(13);
    expectCode(() => promoteNodeImportance("major", "supporting"), "NODE_MATURITY_PROMOTION_INVALID");
    expectCode(() => promoteNodeImportance("major", "major"), "NODE_MATURITY_PROMOTION_INVALID");
  });

  it("fails closed for cross-profile dimensions, duplicate coverage, duplicate evidence and extra authority fields", () => {
    expectCode(() => evaluateNodeMaturity({
      nodeId: "story_1", nodeKind: "story", importanceTier: "core",
      coverage: [{ dimensionId: "identity", evidenceRefs: ["evidence_1"] }],
    }), "NODE_MATURITY_DIMENSION_UNAUTHORIZED");
    expectCode(() => evaluateNodeMaturity({
      nodeId: "world_1", nodeKind: "world", importanceTier: "core",
      coverage: [
        { dimensionId: "origin", evidenceRefs: ["evidence_1"] },
        { dimensionId: "origin", evidenceRefs: ["evidence_2"] },
      ],
    }), "NODE_MATURITY_COVERAGE_DUPLICATED");
    expectCode(() => evaluateNodeMaturity({
      nodeId: "world_1", nodeKind: "world", importanceTier: "core",
      coverage: [{ dimensionId: "origin", evidenceRefs: ["evidence_1", "evidence_1"] }],
    }), "NODE_MATURITY_EVIDENCE_DUPLICATED");
    expectCode(() => evaluateNodeMaturity({
      ...complete("nation", "core"), modelGeneratedReady: true,
    }), "NODE_MATURITY_INPUT_INVALID");
  });
});

function complete(nodeKind: NodeMaturityKind, importanceTier: "core" | "major") {
  return {
    nodeId: `${nodeKind}_1`, nodeKind, importanceTier,
    coverage: NODE_MATURITY_PROFILES[nodeKind].map((dimensionId) => ({
      dimensionId, evidenceRefs: [`assertion_${dimensionId}`],
    })),
  };
}

function expectCode(action: () => unknown, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ${code}.`);
}
