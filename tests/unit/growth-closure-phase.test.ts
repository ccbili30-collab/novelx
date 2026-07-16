import { describe, expect, it } from "vitest";
import {
  captureClosureCheckerOutput,
  closureToolPresentation,
  compileClosureCheckerInput,
  compileClosureCheckerSubmission,
  validateClosureCheckerReviewResult,
  type ClosureEvaluation,
} from "../../src/agent-worker/growth/phases/closure/growthClosurePhase";
import { growthCapabilityVersion } from "../../src/shared/growthContract";
import type { GrowthRunBinding } from "../../src/shared/agentWorkerProtocol";

describe("Growth Closure phase", () => {
  it("owns Closure evaluation and repair tool presentation", () => {
    expect(closureToolPresentation(closureBinding(), "checker")?.description).toContain("Independently review");
    expect(closureToolPresentation(closureBinding(), "submit_closure_checker_review")?.parameters).toMatchObject({
      additionalProperties: false,
    });
    expect(closureToolPresentation(repairBinding(), "propose_change_set")?.description).toContain("Add one source-bound causal bridge");
    expect(closureToolPresentation(closureBinding(), "propose_change_set")).toBeNull();
  });

  it("compiles Checker input only from pinned facet evidence", () => {
    const input = compileClosureCheckerInput({
      binding: closureBinding(),
      evaluation: evaluation(),
      evidenceById: new Map([["world-evidence", { evidenceId: "world-evidence", label: "Formal world" }]]),
    });
    expect(input).toMatchObject({
      evaluationKind: "closure_v4", profileKind: "mixed_birth", evidenceIds: ["world-evidence"],
    });
    expect(JSON.stringify(input)).not.toContain("checkpoint");
    expect(() => compileClosureCheckerInput({
      binding: closureBinding(), evaluation: evaluation(), evidenceById: new Map(),
    })).toThrow(expect.objectContaining({ code: "STEWARD_CLOSURE_EVIDENCE_MISMATCH" }));
  });

  it("accepts only evidence-scoped Checker output and matching recorded review", () => {
    const accepted = captureClosureCheckerOutput({
      evaluation: evaluation(), details: { status: "closure_review", decision: "accepted", adverseFindings: [] },
    });
    expect(compileClosureCheckerSubmission(accepted)).toEqual({ decision: "accepted", adverseFindings: [] });
    expect(() => validateClosureCheckerReviewResult({ status: "recorded", decision: "accepted" }, accepted)).not.toThrow();
    expect(() => validateClosureCheckerReviewResult({ status: "recorded", decision: "blocked" }, accepted))
      .toThrow(expect.objectContaining({ code: "STEWARD_TOOL_RESULT_INVALID" }));

    expect(() => captureClosureCheckerOutput({ evaluation: evaluation(), details: {
      status: "closure_review", decision: "repairs_required", adverseFindings: [{
        localId: "foreign", severity: "major", category: "evidence_gap",
        evidenceIds: ["foreign-evidence"], safeSummary: "Foreign evidence.", repairObjective: "Repair it.",
      }],
    } })).toThrow(expect.objectContaining({ code: "STEWARD_CLOSURE_EVIDENCE_MISMATCH" }));
  });
});

function closureBinding(): GrowthRunBinding {
  return {
    ...baseBinding(), kind: "closure_evaluation", focusKinds: [], resumeFrontier: [],
    closureProfile: {
      profileId: "profile", revision: 1, profileKind: "mixed_birth", subjectResourceId: null,
      componentProfiles: ["world_birth", "story_universe", "oc_saga"], focusOcResourceId: "oc-1",
      requiredContentFacetIds: ["closure.world.structure.resource"],
    },
    closureRepair: null,
  };
}

function repairBinding(): GrowthRunBinding {
  return {
    ...baseBinding(), kind: "repair", focusKinds: [], resumeFrontier: [], closureProfile: null,
    closureRepair: {
      profileId: "profile", revision: 1, originalReviewId: "review", selectedFindingId: "finding",
      selectedFindingFingerprint: "f".repeat(64), safeSummary: "One continuity edge is unsupported.",
      repairObjective: "Add one source-bound causal bridge.", targetEvidenceIds: ["world-evidence"],
    },
  };
}

function baseBinding(): Omit<GrowthRunBinding, "kind" | "focusKinds" | "resumeFrontier" | "closureProfile" | "closureRepair"> {
  return {
    capabilityVersion: growthCapabilityVersion,
    goalId: "goal",
    cycleId: "cycle",
    inputCheckpointId: "checkpoint",
    ruleRevision: 1,
    authorizedScopeResourceIds: ["world-root", "oc-root", "story-root"],
    seedResourceIds: [],
    domainRootResourceIds: { world: "world-root", oc: "oc-root", story: "story-root" },
    greenfieldCreateAuthorized: false,
    priorInquiries: [],
    longformAuthority: null,
  };
}

function evaluation(): ClosureEvaluation {
  return {
    profileId: "profile", revision: 1, profileKind: "mixed_birth", deterministicContentReady: true,
    facetResults: [{
      facetId: "closure.world.structure.resource", state: "satisfied", coverage: "complete",
      safeSummary: "The formal world is pinned.", evidenceIds: ["world-evidence"],
    }],
  };
}
