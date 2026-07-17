import type { GrowthRepository } from "../../../../domain/growth/growthRepository";
import { ResourceRepository } from "../../../../domain/workspace/resourceRepository";
import type { WorkspaceDatabase } from "../../../../domain/workspace/workspaceRepository";
import type { GrowthCycle, GrowthCycleIntent } from "../../../../shared/growthContract";
import { planGrowthClosureContinuation } from "./growthClosureContinuationPlanner";

export interface GrowthClosureContinuationAuthority {
  requiredAssertions: Array<{ facetId: string; scopeResourceId: string }>;
}

/**
 * Reconstructs the authority for an automatic post-evaluation Revision from
 * persisted Closure state. User-guidance revisions and unrelated expansions
 * deliberately receive no Closure requirements.
 */
export function resolveGrowthClosureContinuationAuthority(input: {
  workspace: WorkspaceDatabase;
  repository: GrowthRepository;
  goalId: string;
  cycle: GrowthCycle;
  intent: GrowthCycleIntent;
}): GrowthClosureContinuationAuthority | null {
  if (input.intent.kind !== "revision") return null;
  const previous = input.repository.listCycles(input.goalId)
    .find((candidate) => candidate.sequence === input.cycle.sequence - 1);
  if (!previous || previous.status !== "evaluated"
    || previous.inputCheckpointId !== input.cycle.inputCheckpointId
    || previous.ruleRevision !== input.cycle.ruleRevision) return null;
  const outcome = input.repository.getClosureEvaluationOutcomeForCycle(previous.id);
  if (!outcome || outcome.decision !== "continue_growing") return null;
  const assessment = input.repository.getClosureStewardSubmission(outcome.stewardAssessmentId);
  const profile = input.repository.getClosureProfile(outcome.profileId);
  if (!assessment || !profile) return null;
  const planned = planGrowthClosureContinuation({
    repository: input.repository,
    goalId: input.goalId,
    profileId: outcome.profileId,
    currentCycleId: previous.id,
  });
  if (planned?.state !== "plan" || !sameSet(planned.focusKinds, input.intent.focusKinds)) return null;

  const missingFactFacetIds = assessment.facetResults
    .filter((facet) => facet.state !== "satisfied" && facet.facetId.includes(".fact."))
    .map((facet) => facet.facetId)
    .sort();
  if (missingFactFacetIds.length === 0) return null;
  const resources = new ResourceRepository(input.workspace).listAtCheckpoint(input.cycle.inputCheckpointId);
  const worlds = resources.filter((resource) => resource.objectKind === "world");
  const stories = resources.filter((resource) => resource.objectKind === "story");
  const focusOc = profile.focusOcResourceId
    ? resources.find((resource) => resource.id === profile.focusOcResourceId && resource.objectKind === "oc")
    : null;
  if (worlds.length !== 1 || stories.length !== 1 || !focusOc) throw authorityError();
  return {
    requiredAssertions: missingFactFacetIds.map((facetId) => ({
      facetId,
      scopeResourceId: facetId.startsWith("closure.world.")
        ? worlds[0]!.id
        : facetId.startsWith("closure.story.")
        ? stories[0]!.id
        : facetId.startsWith("closure.oc.")
        ? focusOc.id
        : throwAuthorityError(),
    })),
  };
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function throwAuthorityError(): never { throw authorityError(); }

function authorityError(): Error & { code: "GROWTH_BINDING_INVALID" } {
  return Object.assign(new Error("Closure continuation authority is invalid."), { code: "GROWTH_BINDING_INVALID" as const });
}
