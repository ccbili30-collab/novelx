import type { GrowthRepository } from "../../../../domain/growth/growthRepository";
import type { GrowthCycle, GrowthCycleIntent, GrowthGoal } from "../../../../shared/growthContract";

/** Advances existing v26 Closure profiles across one committed content-revision checkpoint. */
export function syncClosureProfilesAfterRevision(input: {
  repository: GrowthRepository;
  goal: GrowthGoal;
  cycle: GrowthCycle;
  intent: GrowthCycleIntent;
}): void {
  if (input.intent.kind !== "revision") return;
  if (!input.cycle.outputCheckpointId || input.cycle.ruleRevision !== input.goal.currentRuleRevision) {
    throw syncError();
  }
  for (const state of input.repository.listClosureStates(input.goal.id)) {
    const profile = input.repository.getClosureProfile(state.profileId);
    if (!profile || profile.contractGeneration !== "v26" || profile.goalId !== input.goal.id) throw syncError();
    const current = input.repository.getClosureRevision(profile.id, profile.currentRevision);
    if (!current || current.contractGeneration !== "v26") throw syncError();
    if (current.checkpointId === input.cycle.outputCheckpointId
      && current.ruleRevision === input.cycle.ruleRevision) continue;
    if (current.checkpointId !== input.cycle.inputCheckpointId
      || current.ruleRevision > input.cycle.ruleRevision) throw syncError();
    input.repository.appendClosureRevision({
      profileId: profile.id,
      expectedRevision: current.revision,
      idempotencyKey: `closure-revision-after-rule:${input.cycle.id}:${profile.id}`,
      checkpointId: input.cycle.outputCheckpointId,
      ruleRevision: input.cycle.ruleRevision,
      componentProfiles: current.componentProfiles,
      focusOcResourceId: current.focusOcResourceId,
      contractGeneration: "v26",
      facets: current.facets,
    });
  }
}

function syncError(): Error & { code: "GROWTH_CLOSURE_REVISION_SYNC_INVALID" } {
  return Object.assign(new Error("Closure profile cannot advance across the committed content revision."), {
    code: "GROWTH_CLOSURE_REVISION_SYNC_INVALID" as const,
  });
}
