import { createHash } from "node:crypto";
import { deriveGrowthLongformOutlineDocumentId } from "../../../../agent-worker/growth/growthLongformOutline";
import { GROWTH_CLOSURE_FACETS, GrowthClosureEvaluator } from "../../../../domain/growth/growthClosureEvaluator";
import { GrowthLongformProgressResolver } from "../../../../domain/growth/growthLongformProgress";
import type { GrowthRepository } from "../../../../domain/growth/growthRepository";
import { CreativeDocumentRepository } from "../../../../domain/workspace/creativeDocumentRepository";
import { ResourceRepository } from "../../../../domain/workspace/resourceRepository";
import type { WorkspaceDatabase } from "../../../../domain/workspace/workspaceRepository";
import type { GrowthCycle, GrowthCycleIntent, GrowthGoal } from "../../../../shared/growthContract";
import type { GrowthRunBinding } from "../../../../shared/agentWorkerProtocol";

export type GrowthLongformPhase = "outline" | "section";

/** Resolves checkpoint-pinned Longform authority without starting a Worker or mutating Growth state. */
export class GrowthLongformAuthorityResolver {
  constructor(
    readonly workspace: WorkspaceDatabase,
    readonly repository: GrowthRepository,
  ) {}

  resolvePhase(goal: GrowthGoal, cycle: GrowthCycle, intent: GrowthCycleIntent): GrowthLongformPhase | null {
    if (intent.kind !== "expand" || intent.focusKinds.length !== 1 || intent.focusKinds[0] !== "oc") return null;
    const profiles = this.repository.listClosureStates(goal.id)
      .map((state) => this.repository.getClosureProfile(state.profileId))
      .filter((profile) => profile?.contractGeneration === "v26" && profile.profileKind === "mixed_birth"
        && profile.componentProfiles?.includes("oc_saga"));
    if (profiles.length === 0) return null;
    if (profiles.length !== 1) throw bindingError();
    const profile = profiles[0]!;
    const revision = this.repository.getClosureRevision(profile.id, profile.currentRevision);
    if (!revision || revision.checkpointId !== cycle.inputCheckpointId || revision.ruleRevision !== cycle.ruleRevision
      || !revision.focusOcResourceId) {
      throw bindingError();
    }
    const evaluation = new GrowthClosureEvaluator(this.workspace).evaluate({
      checkpointId: cycle.inputCheckpointId,
      profileKind: profile.profileKind,
      subjectResourceId: profile.subjectResourceId,
      componentProfiles: profile.componentProfiles ?? undefined,
      focusOcResourceId: revision.focusOcResourceId,
    });
    const facetState = new Map(evaluation.facetResults.map((facet) => [facet.facetId, facet.state]));
    if (facetState.get(GROWTH_CLOSURE_FACETS.oc.personalStoryBinding) === "missing") return "outline";
    if (facetState.get(GROWTH_CLOSURE_FACETS.oc.personalStory) === "missing") return "section";
    return null;
  }

  resolveAuthority(
    goal: GrowthGoal,
    cycle: GrowthCycle,
    intent: GrowthCycleIntent,
    phase: GrowthLongformPhase,
  ): NonNullable<GrowthRunBinding["longformAuthority"]> {
    if (intent.kind !== "expand" || intent.focusKinds.length !== 1 || intent.focusKinds[0] !== "oc") {
      throw bindingError();
    }
    const resources = new ResourceRepository(this.workspace).listAtCheckpoint(cycle.inputCheckpointId);
    const worlds = resources.filter((resource) => resource.type === "world" && resource.objectKind === "world");
    const mainStories = resources.filter((resource) => resource.type === "story" && resource.objectKind === "story");
    const ocs = resources.filter((resource) => resource.type === "oc" && resource.objectKind === "oc");
    const profileFocusIds = uniqueStrings(this.repository.listClosureStates(goal.id).flatMap((state) => {
      const profile = this.repository.getClosureProfile(state.profileId);
      if (!profile || profile.contractGeneration !== "v26" || profile.profileKind !== "mixed_birth"
        || !profile.componentProfiles?.includes("oc_saga")) return [];
      const revision = this.repository.getClosureRevision(profile.id, profile.currentRevision);
      return revision?.checkpointId === cycle.inputCheckpointId && revision.ruleRevision === cycle.ruleRevision
        && revision.focusOcResourceId ? [revision.focusOcResourceId] : [];
    }));
    const focusOcResourceId = profileFocusIds.length === 1 ? profileFocusIds[0]! : null;
    const focusOc = focusOcResourceId ? ocs.find((resource) => resource.id === focusOcResourceId) : null;
    if (worlds.length !== 1 || mainStories.length !== 1 || !focusOc) throw bindingError();

    const worldResourceId = worlds[0]!.id;
    const mainStoryResourceId = mainStories[0]!.id;
    const identity = createHash("sha256")
      .update(`${goal.id}:${mainStoryResourceId}:${focusOc.id}`, "utf8")
      .digest("hex").slice(0, 32);
    const personalStoryResourceId = `growth-longform-story-${identity}`;
    const outlineId = `growth-longform-${identity}`;
    const outlineDocumentId = deriveGrowthLongformOutlineDocumentId(personalStoryResourceId, outlineId);
    const documents = new CreativeDocumentRepository(this.workspace);

    if (phase === "outline") {
      if (resources.some((resource) => resource.id === personalStoryResourceId)
        || documents.listAtCheckpoint(cycle.inputCheckpointId).some((document) => document.id === outlineDocumentId)) {
        throw bindingError();
      }
      return {
        phase,
        outlineId,
        mainStoryResourceId,
        worldResourceId,
        focusOcResourceId: focusOc.id,
        personalStoryResourceId,
      };
    }

    const progress = new GrowthLongformProgressResolver(this.workspace).resolve({
      checkpointId: cycle.inputCheckpointId,
      focusOcResourceId: focusOc.id,
    });
    if (progress.status !== "ready" || progress.complete || !progress.nextSection
      || progress.mainStoryResourceId !== mainStoryResourceId
      || progress.worldResourceId !== worldResourceId
      || progress.personalStoryResourceId !== personalStoryResourceId
      || progress.outline.outlineId !== outlineId
      || progress.outline.documentId !== outlineDocumentId) {
      throw bindingError();
    }

    return {
      phase,
      outlineId,
      storyResourceId: personalStoryResourceId,
      outlineDocumentVersionId: progress.outline.documentVersionId,
      storyTitle: progress.outline.storyTitle,
      summary: progress.outline.summary,
      sections: progress.outline.sections,
      selectedSectionId: progress.nextSection.outlineSectionId,
      sectionSortOrder: progress.completedSections.length + 1,
      completedSectionIds: progress.completedSections.map((item) => item.outlineSectionId),
      priorProseEvidenceIds: progress.completedSections.map((item) => item.documentVersionId),
      priorContentSha256: progress.completedSections.map((item) => item.contentSha256),
    };
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function bindingError(): Error & { code: "GROWTH_BINDING_INVALID" } {
  return Object.assign(new Error("Growth Longform authority is invalid."), { code: "GROWTH_BINDING_INVALID" as const });
}
