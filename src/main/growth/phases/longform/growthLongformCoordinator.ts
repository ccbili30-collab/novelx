import {
  GrowthLongformProgressResolver,
  type GrowthLongformProgress,
} from "../../../../domain/growth/growthLongformProgress";
import type { GrowthRepository } from "../../../../domain/growth/growthRepository";
import type { WorkspaceDatabase } from "../../../../domain/workspace/workspaceRepository";
import type {
  GrowthClosureEvaluationOutcome,
  GrowthClosureRevision,
  GrowthCycle,
  GrowthCycleIntent,
  GrowthGoal,
} from "../../../../shared/growthContract";

export type GrowthLongformCoordinatorProgress =
  | { status: "blocked"; reason: Extract<GrowthLongformProgress, { status: "blocked" }>["reason"] }
  | {
      status: "ready";
      completedSectionIds: string[];
      nextSectionId: string | null;
      totalCodePoints: number;
      complete: boolean;
    };

export type GrowthLongformStep = "outline" | "section" | "recheck" | "not_applicable";

export type GrowthLongformPlan =
  | {
      phase: "outline" | "section";
      inputCheckpointId: string;
      intent: { kind: "expand"; focusKinds: ["oc"]; resumeFrontier: [] };
    }
  | {
      phase: "recheck";
      inputCheckpointId: string;
      intent: { kind: "closure_evaluation"; profileId: string; revision: number; checkpointId: string };
    };

/** Phase-private Main coordinator for deterministic OC personal-story progress. */
export class GrowthLongformCoordinator {
  readonly #progress: GrowthLongformProgressResolver;

  constructor(
    readonly workspace: WorkspaceDatabase,
    readonly repository: GrowthRepository,
  ) {
    this.#progress = new GrowthLongformProgressResolver(workspace);
  }

  afterEvaluation(input: {
    goal: GrowthGoal;
    cycle: GrowthCycle;
    intent: GrowthCycleIntent;
    outcome: GrowthClosureEvaluationOutcome;
  }): GrowthLongformPlan | null {
    if (input.intent.kind !== "closure_evaluation" || input.outcome.decision !== "continue_growing") return null;
    if (input.goal.currentRuleRevision !== input.cycle.ruleRevision) return null;
    const profile = this.repository.getClosureProfile(input.intent.profileId);
    const revision = this.repository.getClosureRevision(input.intent.profileId, input.intent.revision);
    if (!profile || !revision || revision.contractGeneration !== "v26" || profile.goalId !== input.goal.id
      || revision.checkpointId !== input.cycle.inputCheckpointId
      || revision.ruleRevision !== input.cycle.ruleRevision
      || !revision.componentProfiles.includes("oc_saga")
      || !revision.focusOcResourceId) {
      return null;
    }
    const step = decideGrowthLongformStep({
      boundary: "evaluation",
      progress: projectGrowthLongformProgress(this.#progress.resolve({
        checkpointId: input.cycle.inputCheckpointId,
        focusOcResourceId: revision.focusOcResourceId,
      })),
    });
    return step === "outline" || step === "section"
      ? contentPlan(step, input.cycle.inputCheckpointId)
      : null;
  }

  afterCommitted(input: {
    goal: GrowthGoal;
    cycle: GrowthCycle;
    intent: GrowthCycleIntent;
  }): GrowthLongformPlan | null {
    if (input.intent.kind !== "expand" || input.intent.focusKinds.length !== 1
      || input.intent.focusKinds[0] !== "oc" || !input.cycle.outputCheckpointId
    ) {
      return null;
    }
    const context = this.#profileRevisionAt(input.goal.id, input.cycle.inputCheckpointId, input.cycle.ruleRevision);
    if (!context) return null;
    const before = projectGrowthLongformProgress(this.#progress.resolve({
      checkpointId: input.cycle.inputCheckpointId,
      focusOcResourceId: context.revision.focusOcResourceId!,
    }));
    const phase = phaseAtCommittedBoundary(before);
    if (!phase) return null;
    const after = projectGrowthLongformProgress(this.#progress.resolve({
      checkpointId: input.cycle.outputCheckpointId,
      focusOcResourceId: context.revision.focusOcResourceId!,
    }));
    const step = decideGrowthLongformStep({ boundary: "committed", phase, before, after });
    const nextRevision = this.repository.appendClosureRevision({
      profileId: context.profileId,
      expectedRevision: context.revision.revision,
      idempotencyKey: `closure-revision-after-longform:${input.cycle.id}`,
      checkpointId: input.cycle.outputCheckpointId,
      ruleRevision: input.cycle.ruleRevision,
      componentProfiles: context.revision.componentProfiles,
      focusOcResourceId: context.revision.focusOcResourceId,
      contractGeneration: "v26",
      facets: context.revision.facets,
    });
    if (input.goal.currentRuleRevision !== input.cycle.ruleRevision) return null;
    if (step === "section") return contentPlan("section", input.cycle.outputCheckpointId);
    if (step === "recheck") {
      return {
        phase: "recheck",
        inputCheckpointId: input.cycle.outputCheckpointId,
        intent: {
          kind: "closure_evaluation",
          profileId: context.profileId,
          revision: nextRevision.revision,
          checkpointId: input.cycle.outputCheckpointId,
        },
      };
    }
    throw coordinatorError("GROWTH_LONGFORM_PROGRESS_INVALID");
  }

  #profileRevisionAt(goalId: string, checkpointId: string, ruleRevision: number) {
    const profiles = this.repository.listClosureStates(goalId)
      .map((state) => this.repository.getClosureProfile(state.profileId))
      .filter((profile) => profile?.contractGeneration === "v26"
        && profile.profileKind === "mixed_birth"
        && profile.componentProfiles?.includes("oc_saga"));
    if (profiles.length === 0) return null;
    if (profiles.length !== 1) throw coordinatorError("GROWTH_LONGFORM_PROFILE_AMBIGUOUS");
    const profile = profiles[0]!;
    const candidates = [profile.currentRevision, profile.currentRevision - 1]
      .filter((revision) => revision >= 1)
      .map((revision) => this.repository.getClosureRevision(profile.id, revision))
      .filter((revision): revision is Extract<GrowthClosureRevision, { contractGeneration: "v26" }> =>
        revision?.contractGeneration === "v26"
        && revision.checkpointId === checkpointId
        && revision.ruleRevision === ruleRevision);
    if (candidates.length !== 1 || !candidates[0]!.focusOcResourceId) {
      throw coordinatorError("GROWTH_LONGFORM_REVISION_INVALID");
    }
    return { profileId: profile.id, revision: candidates[0]! };
  }
}

/**
 * Pure orchestration decision. Persistence, Run start, and Change Set execution
 * remain owned by the caller; this module only validates Longform progress.
 */
export function decideGrowthLongformStep(input:
  | { boundary: "evaluation"; progress: GrowthLongformCoordinatorProgress }
  | {
      boundary: "committed";
      phase: "outline" | "section";
      before: GrowthLongformCoordinatorProgress;
      after: GrowthLongformCoordinatorProgress;
    }): GrowthLongformStep {
  if (input.boundary === "evaluation") return nextFromEvaluation(input.progress);
  if (input.after.status !== "ready") throw coordinatorError("GROWTH_LONGFORM_PROGRESS_INVALID");

  if (input.phase === "outline") {
    if (input.before.status !== "blocked"
      || input.before.reason !== "GROWTH_LONGFORM_PERSONAL_STORY_BINDING_MISSING"
      || input.after.completedSectionIds.length !== 0
      || input.after.totalCodePoints !== 0
      || input.after.nextSectionId === null
      || input.after.complete) {
      throw coordinatorError("GROWTH_LONGFORM_OUTLINE_TRANSITION_INVALID");
    }
    return "section";
  }

  if (input.before.status !== "ready" || input.before.nextSectionId === null || input.before.complete) {
    throw coordinatorError("GROWTH_LONGFORM_PROGRESS_INVALID");
  }
  const expectedCompleted = [...input.before.completedSectionIds, input.before.nextSectionId];
  if (input.after.totalCodePoints <= input.before.totalCodePoints) {
    throw coordinatorError("GROWTH_LONGFORM_NO_PROGRESS");
  }
  if (!sameStrings(input.after.completedSectionIds, expectedCompleted)) {
    throw coordinatorError("GROWTH_LONGFORM_SECTION_SEQUENCE_INVALID");
  }
  if (input.after.nextSectionId === null) {
    if (!input.after.complete || input.after.totalCodePoints < 10_000) {
      throw coordinatorError("GROWTH_LONGFORM_TARGET_NOT_REACHED");
    }
    return "recheck";
  }
  if (input.after.complete) throw coordinatorError("GROWTH_LONGFORM_PROGRESS_INVALID");
  return "section";
}

export function projectGrowthLongformProgress(progress: GrowthLongformProgress): GrowthLongformCoordinatorProgress {
  return progress.status === "blocked"
    ? { status: "blocked", reason: progress.reason }
    : {
        status: "ready",
        completedSectionIds: progress.completedSections.map((section) => section.outlineSectionId),
        nextSectionId: progress.nextSection?.outlineSectionId ?? null,
        totalCodePoints: progress.totalCodePoints,
        complete: progress.complete,
      };
}

function nextFromEvaluation(progress: GrowthLongformCoordinatorProgress): GrowthLongformStep {
  if (progress.status === "blocked") {
    if (progress.reason === "GROWTH_LONGFORM_PERSONAL_STORY_BINDING_MISSING") return "outline";
    throw coordinatorError("GROWTH_LONGFORM_PROGRESS_INVALID");
  }
  if (progress.nextSectionId !== null && !progress.complete) return "section";
  if (progress.nextSectionId === null && progress.complete && progress.totalCodePoints >= 10_000) {
    return "not_applicable";
  }
  if (progress.nextSectionId === null && progress.totalCodePoints < 10_000) {
    throw coordinatorError("GROWTH_LONGFORM_TARGET_NOT_REACHED");
  }
  throw coordinatorError("GROWTH_LONGFORM_PROGRESS_INVALID");
}

function phaseAtCommittedBoundary(progress: GrowthLongformCoordinatorProgress): "outline" | "section" | null {
  if (progress.status === "blocked") {
    if (progress.reason === "GROWTH_LONGFORM_PERSONAL_STORY_BINDING_MISSING") return "outline";
    return null;
  }
  return progress.nextSectionId !== null && !progress.complete ? "section" : null;
}

function contentPlan(phase: "outline" | "section", inputCheckpointId: string): GrowthLongformPlan {
  return {
    phase,
    inputCheckpointId,
    intent: { kind: "expand", focusKinds: ["oc"], resumeFrontier: [] },
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function coordinatorError(code: string): Error & { code: string } {
  return Object.assign(new Error("Growth Longform coordination failed."), { code });
}
