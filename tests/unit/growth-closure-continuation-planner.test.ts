import { describe, expect, it } from "vitest";
import type { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { planGrowthClosureContinuation } from "../../src/main/growth/phases/closure/growthClosureContinuationPlanner";

describe("Growth Closure continuation planner", () => {
  it("routes persisted missing facets to the affected content capabilities", () => {
    const repository = repositoryWith([
      evaluation(5, ["closure.world.fact.history_timeline", "closure.story.fact.stage_resolution"]),
    ]);

    expect(planGrowthClosureContinuation({
      repository, goalId: "goal", profileId: "profile", currentCycleId: "cycle-5",
    })).toEqual({
      state: "plan",
      focusKinds: ["world", "story"],
      missingFacetIds: ["closure.story.fact.stage_resolution", "closure.world.fact.history_timeline"],
    });
  });

  it("stops when a committed targeted revision leaves the identical gap set", () => {
    const repository = repositoryWith([
      evaluation(5, ["closure.oc.fact.world_influence"]),
      revision(6, ["oc"]),
      evaluation(7, ["closure.oc.fact.world_influence"]),
    ]);

    expect(planGrowthClosureContinuation({
      repository, goalId: "goal", profileId: "profile", currentCycleId: "cycle-7",
    })).toEqual({ state: "stalled", missingFacetIds: ["closure.oc.fact.world_influence"] });
  });

  it("permits another bounded revision after the missing set makes progress", () => {
    const repository = repositoryWith([
      evaluation(5, ["closure.oc.fact.backstory", "closure.oc.fact.world_influence"]),
      revision(6, ["oc"]),
      evaluation(7, ["closure.oc.fact.world_influence"]),
    ]);

    expect(planGrowthClosureContinuation({
      repository, goalId: "goal", profileId: "profile", currentCycleId: "cycle-7",
    })).toEqual({
      state: "plan",
      focusKinds: ["oc"],
      missingFacetIds: ["closure.oc.fact.world_influence"],
    });
  });

  it("does not treat unrelated Longform work as an attempted Closure revision", () => {
    const repository = repositoryWith([
      evaluation(5, ["closure.world.fact.history_timeline", "closure.oc.fact.world_influence"]),
      expand(6, ["oc"]),
      expand(7, ["oc"]),
      evaluation(8, ["closure.world.fact.history_timeline", "closure.oc.fact.world_influence"]),
    ]);

    expect(planGrowthClosureContinuation({
      repository, goalId: "goal", profileId: "profile", currentCycleId: "cycle-8",
    })).toEqual({
      state: "plan",
      focusKinds: ["world", "oc"],
      missingFacetIds: ["closure.oc.fact.world_influence", "closure.world.fact.history_timeline"],
    });
  });
});

type Evaluation = {
  sequence: number;
  status: "evaluated" | "committed";
  missingFacetIds?: string[];
  intent: { kind: "closure_evaluation" } | { kind: "revision" | "expand"; focusKinds: Array<"world" | "story" | "oc"> };
};

function evaluation(sequence: number, missingFacetIds: string[]): Evaluation {
  return { sequence, status: "evaluated", missingFacetIds, intent: { kind: "closure_evaluation" } };
}

function revision(sequence: number, focusKinds: Array<"world" | "story" | "oc">): Evaluation {
  return { sequence, status: "committed", intent: { kind: "revision", focusKinds } };
}

function expand(sequence: number, focusKinds: Array<"world" | "story" | "oc">): Evaluation {
  return { sequence, status: "committed", intent: { kind: "expand", focusKinds } };
}

function repositoryWith(evaluations: Evaluation[]): GrowthRepository {
  const cycles = evaluations.map(({ sequence, status }) => ({ id: `cycle-${sequence}`, sequence, status }));
  return {
    listCycles: () => cycles,
    getCycle: (cycleId: string) => cycles.find((cycle) => cycle.id === cycleId) ?? null,
    getCycleIntent: (cycleId: string) => evaluations.find(({ sequence }) => `cycle-${sequence}` === cycleId)?.intent,
    getClosureEvaluationOutcomeForCycle: (cycleId: string) => {
      const found = evaluations.find(({ sequence, status }) => status === "evaluated" && `cycle-${sequence}` === cycleId);
      return found ? {
        profileId: "profile", decision: "continue_growing", stewardAssessmentId: `assessment-${found.sequence}`,
      } : null;
    },
    getClosureStewardSubmission: (assessmentId: string) => {
      const found = evaluations.find(({ sequence, status }) => status === "evaluated" && `assessment-${sequence}` === assessmentId);
      return found ? {
        facetResults: found.missingFacetIds!.map((facetId) => ({ facetId, state: "missing" })),
      } : null;
    },
  } as unknown as GrowthRepository;
}
