import type { GrowthRepository } from "../../../../domain/growth/growthRepository";
import type { GrowthFocusKind } from "../../../growthFrontierPlanner";

export type GrowthClosureContinuationPlan =
  | { state: "plan"; focusKinds: GrowthFocusKind[]; missingFacetIds: string[] }
  | { state: "stalled"; missingFacetIds: string[] };

/**
 * Converts persisted Closure gaps into one bounded content-revision Cycle.
 * Repeating the exact same gap set after a committed, gap-targeted revision
 * is treated as no progress so an autonomous Growth run cannot self-question
 * forever. Unrelated Longform/content work between evaluations is not a
 * Closure repair attempt and must not cause a premature stall.
 */
export function planGrowthClosureContinuation(input: {
  repository: GrowthRepository;
  goalId: string;
  profileId: string;
  currentCycleId: string;
}): GrowthClosureContinuationPlan | null {
  const currentCycle = input.repository.getCycle(input.currentCycleId);
  const currentOutcome = input.repository.getClosureEvaluationOutcomeForCycle(input.currentCycleId);
  if (!currentCycle || !currentOutcome || currentOutcome.profileId !== input.profileId
    || currentOutcome.decision !== "continue_growing") return null;
  const currentAssessment = input.repository.getClosureStewardSubmission(currentOutcome.stewardAssessmentId);
  if (!currentAssessment) return null;
  const missingFacetIds = missingFacets(currentAssessment.facetResults);
  if (missingFacetIds.length === 0) return null;
  const focusKinds = focusKindsFor(missingFacetIds);
  if (focusKinds.length === 0) return { state: "stalled", missingFacetIds };

  const cycles = input.repository.listCycles(input.goalId);
  const currentFingerprint = fingerprint(missingFacetIds);
  let previousMatchingEvaluation: (typeof cycles)[number] | null = null;
  for (const cycle of [...cycles].reverse()) {
    if (cycle.sequence >= currentCycle.sequence || cycle.status !== "evaluated") continue;
    const outcome = input.repository.getClosureEvaluationOutcomeForCycle(cycle.id);
    if (!outcome || outcome.profileId !== input.profileId) continue;
    if (outcome.decision !== "continue_growing") break;
    const assessment = input.repository.getClosureStewardSubmission(outcome.stewardAssessmentId);
    if (assessment && fingerprint(missingFacets(assessment.facetResults)) === currentFingerprint) {
      previousMatchingEvaluation = cycle;
    }
    break;
  }
  if (!previousMatchingEvaluation) return { state: "plan", focusKinds, missingFacetIds };

  const attemptedTargetedRevision = cycles.some((cycle) => {
    if (cycle.sequence <= previousMatchingEvaluation.sequence || cycle.sequence >= currentCycle.sequence
      || cycle.status !== "committed") return false;
    const intent = input.repository.getCycleIntent(cycle.id);
    return intent.kind === "revision" && focusKinds.every((kind) => intent.focusKinds.includes(kind));
  });
  return attemptedTargetedRevision
    ? { state: "stalled", missingFacetIds }
    : { state: "plan", focusKinds, missingFacetIds };
}

function missingFacets(results: Array<{ facetId: string; state: string }>): string[] {
  return results.filter((result) => result.state !== "satisfied").map((result) => result.facetId).sort();
}

function focusKindsFor(facetIds: string[]): GrowthFocusKind[] {
  return (["world", "story", "oc"] as const).filter((kind) => (
    facetIds.some((facetId) => facetId.startsWith(`closure.${kind}.`))
  ));
}

function fingerprint(facetIds: string[]): string {
  return [...facetIds].sort().join("\n");
}
