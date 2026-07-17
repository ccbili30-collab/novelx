import { describe, expect, it, vi } from "vitest";
import type { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { syncClosureProfilesAfterRevision } from "../../src/main/growth/phases/revision/growthRevisionClosureSync";
import type { GrowthCycle, GrowthCycleIntent, GrowthGoal } from "../../src/shared/growthContract";

describe("Growth revision Closure synchronization", () => {
  it("advances a Closure profile to a new checkpoint within the same rule revision", () => {
    const { repository, appendClosureRevision } = repositoryAt({ checkpointId: "checkpoint-before", ruleRevision: 3 });

    syncClosureProfilesAfterRevision({
      repository,
      goal: goalAt(3),
      cycle: committedRevision({ inputCheckpointId: "checkpoint-before", outputCheckpointId: "checkpoint-after", ruleRevision: 3 }),
      intent: revisionIntent(),
    });

    expect(appendClosureRevision).toHaveBeenCalledOnce();
    expect(appendClosureRevision).toHaveBeenCalledWith(expect.objectContaining({
      checkpointId: "checkpoint-after",
      ruleRevision: 3,
      expectedRevision: 4,
    }));
  });

  it("continues to advance across a newer persisted rule revision", () => {
    const { repository, appendClosureRevision } = repositoryAt({ checkpointId: "checkpoint-before", ruleRevision: 2 });

    syncClosureProfilesAfterRevision({
      repository,
      goal: goalAt(3),
      cycle: committedRevision({ inputCheckpointId: "checkpoint-before", outputCheckpointId: "checkpoint-after", ruleRevision: 3 }),
      intent: revisionIntent(),
    });

    expect(appendClosureRevision).toHaveBeenCalledWith(expect.objectContaining({ ruleRevision: 3 }));
  });

  it("fails closed for a discontinuous checkpoint or a rule revision rollback", () => {
    const mismatched = repositoryAt({ checkpointId: "other-checkpoint", ruleRevision: 3 });
    expect(() => syncClosureProfilesAfterRevision({
      repository: mismatched.repository,
      goal: goalAt(3),
      cycle: committedRevision({ inputCheckpointId: "checkpoint-before", outputCheckpointId: "checkpoint-after", ruleRevision: 3 }),
      intent: revisionIntent(),
    })).toThrow(expect.objectContaining({ code: "GROWTH_CLOSURE_REVISION_SYNC_INVALID" }));

    const newer = repositoryAt({ checkpointId: "checkpoint-before", ruleRevision: 4 });
    expect(() => syncClosureProfilesAfterRevision({
      repository: newer.repository,
      goal: goalAt(3),
      cycle: committedRevision({ inputCheckpointId: "checkpoint-before", outputCheckpointId: "checkpoint-after", ruleRevision: 3 }),
      intent: revisionIntent(),
    })).toThrow(expect.objectContaining({ code: "GROWTH_CLOSURE_REVISION_SYNC_INVALID" }));
  });
});

function repositoryAt(input: { checkpointId: string; ruleRevision: number }) {
  const appendClosureRevision = vi.fn();
  const repository = {
    listClosureStates: () => [{ profileId: "closure-profile" }],
    getClosureProfile: () => ({
      id: "closure-profile",
      goalId: "goal",
      currentRevision: 4,
      contractGeneration: "v26",
    }),
    getClosureRevision: () => ({
      revision: 4,
      checkpointId: input.checkpointId,
      ruleRevision: input.ruleRevision,
      contractGeneration: "v26",
      componentProfiles: ["world", "story", "oc"],
      focusOcResourceId: "oc-resource",
      facets: [{ id: "facet", kind: "fact", requirement: "requirement" }],
    }),
    appendClosureRevision,
  } as unknown as GrowthRepository;
  return { repository, appendClosureRevision };
}

function goalAt(currentRuleRevision: number): GrowthGoal {
  return { id: "goal", currentRuleRevision } as GrowthGoal;
}

function committedRevision(input: {
  inputCheckpointId: string;
  outputCheckpointId: string;
  ruleRevision: number;
}): GrowthCycle {
  return {
    id: "revision-cycle",
    inputCheckpointId: input.inputCheckpointId,
    outputCheckpointId: input.outputCheckpointId,
    ruleRevision: input.ruleRevision,
  } as GrowthCycle;
}

function revisionIntent(): GrowthCycleIntent {
  return {
    cycleId: "revision-cycle",
    provenance: "persisted_v26",
    kind: "revision",
    focusKinds: ["world"],
    resumeFrontier: [],
  };
}
