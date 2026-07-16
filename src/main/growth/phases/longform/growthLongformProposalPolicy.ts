import { canonicalAuditHash } from "../../../../domain/audit/canonicalAuditHash";
import type { GrowthRetrievalReceipt } from "../../../../shared/growthContract";
import type { GrowthRunBinding, ProposeChangeSetArgs } from "../../../../shared/agentWorkerProtocol";
import {
  compileGrowthLongformOutlineChangeSet,
  growthLongformPersistedOutlineSchema,
} from "../../../../agent-worker/growth/growthLongformOutline";
import { compileGrowthLongformSectionChangeSet } from "../../../../agent-worker/growth/growthLongformSection";

/** Recompiles model-authored Longform content against Main authority before any Gateway side effect. */
export function assertGrowthLongformProposalAllowed(input: {
  binding: GrowthRunBinding;
  receipt: GrowthRetrievalReceipt;
  proposal: ProposeChangeSetArgs;
}): void {
  const authority = input.binding.longformAuthority;
  if (!authority || input.receipt.checkpointId !== input.binding.inputCheckpointId) throw policyError();
  const availableEvidenceIds = [...new Set(input.receipt.links.map((link) => link.targetVersionId))];
  const documents = input.proposal.items.filter((item) => item.kind === "document.put");
  if (documents.length !== 1) throw policyError();

  let expected: ProposeChangeSetArgs;
  try {
    if (authority.phase === "outline") {
      const persisted = growthLongformPersistedOutlineSchema.parse(JSON.parse(documents[0]!.payload.content));
      if (persisted.outlineId !== authority.outlineId) throw policyError();
      expected = compileGrowthLongformOutlineChangeSet({
        storyTitle: persisted.storyTitle,
        summary: persisted.summary,
        sections: persisted.sections,
      }, {
        outlineId: authority.outlineId,
        checkpointId: input.binding.inputCheckpointId,
        receiptId: input.receipt.id,
        availableEvidenceIds,
        mainStoryResourceId: authority.mainStoryResourceId,
        worldResourceId: authority.worldResourceId,
        focusOcResourceId: authority.focusOcResourceId,
        personalStoryResourceId: authority.personalStoryResourceId,
      });
    } else {
      const selected = authority.sections.find((section) => section.localId === authority.selectedSectionId);
      if (!selected) throw policyError();
      expected = compileGrowthLongformSectionChangeSet({
        outlineSectionId: authority.selectedSectionId,
        candidateText: documents[0]!.payload.content,
        evidenceIds: selected.evidenceIds,
      }, {
        outline: {
          outlineId: authority.outlineId,
          checkpointId: input.binding.inputCheckpointId,
          receiptId: input.receipt.id,
          storyTitle: authority.storyTitle,
          summary: authority.summary,
          sections: authority.sections,
        },
        checkpointId: input.binding.inputCheckpointId,
        receiptId: input.receipt.id,
        availableEvidenceIds,
        priorProseEvidenceIds: authority.priorProseEvidenceIds,
        completedSectionIds: authority.completedSectionIds,
        priorContentSha256: authority.priorContentSha256,
        storyResourceId: authority.storyResourceId,
        sectionSortOrder: authority.sectionSortOrder,
      });
    }
  } catch {
    throw policyError();
  }
  if (canonicalAuditHash(expected) !== canonicalAuditHash(input.proposal)) throw policyError();
}

function policyError(): Error & { code: "GROWTH_BINDING_INVALID" } {
  return Object.assign(new Error("Growth Longform proposal is outside trusted authority."), {
    code: "GROWTH_BINDING_INVALID" as const,
  });
}
