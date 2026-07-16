import { canonicalAuditHash } from "../../../../domain/audit/canonicalAuditHash";
import type { GrowthRepository } from "../../../../domain/growth/growthRepository";
import type { GrowthCycle, GrowthCycleIntent, GrowthGoal } from "../../../../shared/growthContract";
import type { GrowthRunBinding } from "../../../../shared/agentWorkerProtocol";

/** Resolves persisted Closure evaluation and repair authority without mutating Cycle state. */
export class GrowthClosureAuthorityResolver {
  constructor(readonly repository: GrowthRepository) {}

  resolveEvaluation(input: {
    goal: GrowthGoal;
    cycle: GrowthCycle;
    profileId: string;
    revision: number;
    checkpointId: string;
  }): NonNullable<GrowthRunBinding["closureProfile"]> {
    const profile = this.repository.getClosureProfile(input.profileId);
    const revision = this.repository.getClosureRevision(input.profileId, input.revision);
    if (!profile || !revision || profile.contractGeneration !== "v26" || revision.contractGeneration !== "v26"
      || profile.goalId !== input.goal.id || profile.currentRevision !== input.revision
      || input.cycle.inputCheckpointId !== input.checkpointId || revision.checkpointId !== input.checkpointId
      || revision.ruleRevision !== input.cycle.ruleRevision
      || canonicalAuditHash(profile.componentProfiles) !== canonicalAuditHash(revision.componentProfiles)
      || profile.focusOcResourceId !== revision.focusOcResourceId) {
      throw bindingError();
    }
    const requiredContentFacetIds = revision.facets
      .filter((facet) => facet.kind === "content" && facet.required)
      .map((facet) => facet.id);
    if (requiredContentFacetIds.length === 0) throw bindingError();
    return {
      profileId: profile.id,
      revision: revision.revision,
      profileKind: profile.profileKind,
      subjectResourceId: profile.subjectResourceId,
      componentProfiles: [...revision.componentProfiles],
      focusOcResourceId: revision.focusOcResourceId,
      requiredContentFacetIds,
    };
  }

  resolveRepair(input: {
    goal: GrowthGoal;
    cycle: GrowthCycle;
    intent: Extract<GrowthCycleIntent, { kind: "repair" }>;
  }): NonNullable<GrowthRunBinding["closureRepair"]> {
    const profile = this.repository.getClosureProfile(input.intent.profileId);
    const revision = this.repository.getClosureRevision(input.intent.profileId, input.intent.revision);
    const review = this.repository.getClosureReviewV4(input.intent.originalReviewId);
    const checker = review ? this.repository.getClosureCheckerSubmission(review.checkerAssessmentId) : null;
    const finding = review?.adverseFindings.find((candidate) => candidate.id === input.intent.selectedFindingId) ?? null;
    const receipt = checker ? this.repository.getReceipt(checker.receiptId) : null;
    if (!profile || !revision || !review || !checker || !finding || !receipt
      || profile.goalId !== input.goal.id || profile.currentRevision !== input.intent.revision
      || profile.contractGeneration !== "v26" || revision.contractGeneration !== "v26"
      || revision.checkpointId !== input.cycle.inputCheckpointId || revision.ruleRevision !== input.cycle.ruleRevision
      || review.profileId !== profile.id || review.revision !== revision.revision || review.checkerDecision !== "repairs_required"
      || checker.decision !== "repairs_required" || checker.checkpointId !== input.cycle.inputCheckpointId
      || checker.receiptId !== receipt.id || receipt.checkpointId !== input.cycle.inputCheckpointId
      || finding.fingerprint !== input.intent.selectedFindingFingerprint || !["major", "blocking"].includes(finding.severity)) {
      throw bindingError();
    }
    const targetEvidenceIds = finding.targetEvidence.map((link) => {
      if (link.receiptId !== receipt.id) throw bindingError();
      const target = receipt.links[link.rank - 1];
      if (!target || target.rank !== link.rank) throw bindingError();
      return target.targetVersionId;
    });
    if (targetEvidenceIds.length === 0 || new Set(targetEvidenceIds).size !== targetEvidenceIds.length) {
      throw bindingError();
    }
    return {
      profileId: profile.id,
      revision: revision.revision,
      originalReviewId: review.id,
      selectedFindingId: finding.id,
      selectedFindingFingerprint: finding.fingerprint,
      safeSummary: finding.safeSummary,
      repairObjective: finding.repairObjective,
      targetEvidenceIds,
    };
  }
}

function bindingError(): Error & { code: "GROWTH_BINDING_INVALID" } {
  return Object.assign(new Error("Growth Closure authority is invalid."), { code: "GROWTH_BINDING_INVALID" as const });
}
