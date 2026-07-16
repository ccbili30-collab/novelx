import { writerOutputSchema } from "../../../contracts/roleOutputs";
import type { GrowthRunBinding } from "../../../../shared/agentWorkerProtocol";
import {
  compileGrowthLongformOutlineChangeSet,
  type GrowthLongformOutline,
} from "../../growthLongformOutline";
import { compileGrowthLongformSectionChangeSet } from "../../growthLongformSection";

export interface GrowthLongformWriterCandidate {
  text: string;
  evidenceIds: string[];
}

type LongformAuthority = NonNullable<GrowthRunBinding["longformAuthority"]>;
type OutlineAuthority = Extract<LongformAuthority, { phase: "outline" }>;
type SectionAuthority = Extract<LongformAuthority, { phase: "section" }>;

export function compileLongformOutlineProposal(input: {
  binding: GrowthRunBinding;
  authority: OutlineAuthority;
  receiptId: string;
  availableEvidenceIds: readonly string[];
  params: unknown;
}): unknown {
  requireReceipt(input.receiptId);
  return compileGrowthLongformOutlineChangeSet(input.params, {
    outlineId: input.authority.outlineId,
    checkpointId: input.binding.inputCheckpointId,
    receiptId: input.receiptId,
    availableEvidenceIds: input.availableEvidenceIds,
    mainStoryResourceId: input.authority.mainStoryResourceId,
    worldResourceId: input.authority.worldResourceId,
    focusOcResourceId: input.authority.focusOcResourceId,
    personalStoryResourceId: input.authority.personalStoryResourceId,
  });
}

export function compileLongformWriterInput(input: {
  authority: SectionAuthority;
  receiptId: string;
  evidenceById: ReadonlyMap<string, unknown>;
}): Record<string, unknown> {
  requireReceipt(input.receiptId);
  const selected = selectedSection(input.authority, "STEWARD_LONGFORM_AUTHORITY_INVALID");
  const requiredEvidenceIds = [...selected.evidenceIds, ...input.authority.priorProseEvidenceIds];
  requireAvailableEvidence(requiredEvidenceIds, input.evidenceById);
  const sourceMaterial = JSON.stringify({
    storyTitle: input.authority.storyTitle,
    outlineSummary: input.authority.summary,
    section: selected,
    evidence: requiredEvidenceIds.map((id) => input.evidenceById.get(id)),
  });
  if (sourceMaterial.length > 160_000) throw longformError("STEWARD_LONGFORM_EVIDENCE_REQUIRED");
  return {
    instruction: "Write exactly this one bounded OC personal-story section. Preserve continuity with the supplied pinned evidence and prior prose. Return only a Writer candidate; do not claim Canon, project authority, or a committed Change Set.",
    sourceMaterial,
    evidenceIds: [...selected.evidenceIds],
    gmResolution: null,
    gmResolutionId: null,
    styleConstraints: [
      ...selected.continuityConstraints,
      `Unicode code point range: ${selected.estimatedCodePoints.min}-${selected.estimatedCodePoints.max}.`,
      "Do not pad, repeat filler, or add leading/trailing whitespace.",
    ],
  };
}

export function compileLongformSectionProposal(input: {
  binding: GrowthRunBinding;
  authority: SectionAuthority;
  receiptId: string;
  availableEvidenceIds: readonly string[];
  writerCandidate: GrowthLongformWriterCandidate | null;
  params: unknown;
}): unknown {
  requireReceipt(input.receiptId);
  const selection = readObject(input.params);
  if (!input.writerCandidate || selection?.outlineSectionId !== input.authority.selectedSectionId) {
    throw longformError("STEWARD_LONGFORM_AUTHORITY_INVALID");
  }
  const selected = selectedSection(input.authority, "STEWARD_LONGFORM_EVIDENCE_REQUIRED");
  if (!sameStringSets(input.writerCandidate.evidenceIds, selected.evidenceIds)) {
    throw longformError("STEWARD_LONGFORM_EVIDENCE_REQUIRED");
  }
  const outline: GrowthLongformOutline = {
    outlineId: input.authority.outlineId,
    checkpointId: input.binding.inputCheckpointId,
    receiptId: input.receiptId,
    storyTitle: input.authority.storyTitle,
    summary: input.authority.summary,
    sections: input.authority.sections,
  };
  return compileGrowthLongformSectionChangeSet({
    outlineSectionId: input.authority.selectedSectionId,
    candidateText: input.writerCandidate.text,
    evidenceIds: [...selected.evidenceIds],
  }, {
    outline,
    checkpointId: input.binding.inputCheckpointId,
    receiptId: input.receiptId,
    availableEvidenceIds: input.availableEvidenceIds,
    priorProseEvidenceIds: input.authority.priorProseEvidenceIds,
    completedSectionIds: input.authority.completedSectionIds,
    priorContentSha256: input.authority.priorContentSha256,
    storyResourceId: input.authority.storyResourceId,
    sectionSortOrder: input.authority.sectionSortOrder,
  });
}

export function captureLongformWriterCandidate(input: {
  authority: SectionAuthority;
  details: unknown;
}): GrowthLongformWriterCandidate | null {
  const output = writerOutputSchema.safeParse(input.details);
  if (!output.success) throw longformError("STEWARD_TOOL_RESULT_INVALID");
  if (output.data.status !== "candidate") return null;
  const selected = selectedSection(input.authority, "STEWARD_LONGFORM_EVIDENCE_REQUIRED");
  if (!sameStringSets(output.data.evidenceIds, selected.evidenceIds)) {
    throw longformError("STEWARD_LONGFORM_EVIDENCE_REQUIRED");
  }
  return { text: output.data.candidateText, evidenceIds: output.data.evidenceIds };
}

export function requireLongformWriterEvidence(
  authority: SectionAuthority,
  evidenceById: ReadonlyMap<string, unknown>,
): void {
  const selected = selectedSection(authority, "STEWARD_LONGFORM_EVIDENCE_REQUIRED");
  requireAvailableEvidence([...selected.evidenceIds, ...authority.priorProseEvidenceIds], evidenceById);
}

function selectedSection(
  authority: SectionAuthority,
  missingCode: "STEWARD_LONGFORM_AUTHORITY_INVALID" | "STEWARD_LONGFORM_EVIDENCE_REQUIRED",
): SectionAuthority["sections"][number] {
  const selected = authority.sections.find((section) => section.localId === authority.selectedSectionId);
  if (!selected) throw longformError(missingCode);
  return selected;
}

function requireAvailableEvidence(ids: readonly string[], evidenceById: ReadonlyMap<string, unknown>): void {
  if (ids.some((id) => !evidenceById.has(id))) throw longformError("STEWARD_LONGFORM_EVIDENCE_REQUIRED");
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameStringSets(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((value, index) => value === sortedRight[index]);
}

function requireReceipt(receiptId: string): void {
  if (receiptId.trim().length === 0) throw longformError("STEWARD_LONGFORM_AUTHORITY_INVALID");
}

function longformError(code: string): Error & { code: string } {
  return Object.assign(new Error("Steward Longform phase contract failed."), { code });
}
