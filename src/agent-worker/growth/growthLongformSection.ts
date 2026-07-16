import { createHash } from "node:crypto";
import { Type } from "typebox";
import { z } from "zod";
import { proposeChangeSetArgsSchema, type ProposeChangeSetArgs } from "../../shared/agentWorkerProtocol";
import type { GrowthLongformOutline } from "./growthLongformOutline";

const identifier = z.string().trim().min(1).max(240);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const localId = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/);

export const growthLongformSectionSchema = z.object({
  outlineSectionId: localId,
  candidateText: z.string().min(1).max(20_000),
  evidenceIds: z.array(identifier).min(1).max(200),
}).strict().superRefine((value, context) => {
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    context.addIssue({ code: "custom", message: "GROWTH_LONGFORM_SECTION_EVIDENCE_MISMATCH" });
  }
});

export const growthLongformSectionParameters = Type.Object({
  outlineSectionId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }),
  candidateText: Type.String({ minLength: 1, maxLength: 20_000 }),
  evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { minItems: 1, maxItems: 200 }),
}, { additionalProperties: false });

export interface GrowthLongformSectionAuthority {
  outline: GrowthLongformOutline;
  checkpointId: string;
  receiptId: string;
  availableEvidenceIds: readonly string[];
  priorProseEvidenceIds: readonly string[];
  completedSectionIds: readonly string[];
  priorContentSha256: readonly string[];
}

export interface GrowthLongformSectionChangeSetAuthority extends GrowthLongformSectionAuthority {
  storyResourceId: string;
  sectionDocumentId: string;
  sectionSortOrder: number;
}

export interface GrowthLongformSection {
  outlineId: string;
  outlineSectionId: string;
  checkpointId: string;
  receiptId: string;
  candidateText: string;
  evidenceIds: string[];
  codePoints: number;
  contentSha256: string;
}

export type GrowthLongformSectionErrorCode =
  | "GROWTH_LONGFORM_SECTION_INVALID"
  | "GROWTH_LONGFORM_SECTION_AUTHORITY_MISMATCH"
  | "GROWTH_LONGFORM_SECTION_OUTLINE_MISMATCH"
  | "GROWTH_LONGFORM_SECTION_EVIDENCE_MISMATCH"
  | "GROWTH_LONGFORM_SECTION_LENGTH_INVALID"
  | "GROWTH_LONGFORM_SECTION_PRIOR_PROSE_REQUIRED"
  | "GROWTH_LONGFORM_SECTION_PADDING_REJECTED"
  | "GROWTH_LONGFORM_SECTION_FILLER_REJECTED"
  | "GROWTH_LONGFORM_SECTION_REPLAY";

export function compileGrowthLongformSection(
  input: unknown,
  authority: GrowthLongformSectionAuthority,
): GrowthLongformSection {
  const parsed = growthLongformSectionSchema.safeParse(input);
  if (!parsed.success) {
    const code = parsed.error.issues.some((issue) => issue.message === "GROWTH_LONGFORM_SECTION_EVIDENCE_MISMATCH")
      ? "GROWTH_LONGFORM_SECTION_EVIDENCE_MISMATCH"
      : "GROWTH_LONGFORM_SECTION_INVALID";
    throw sectionError(code);
  }
  if (!identifier.safeParse(authority.checkpointId).success
    || !identifier.safeParse(authority.receiptId).success
    || authority.availableEvidenceIds.some((id) => !identifier.safeParse(id).success)
    || authority.priorProseEvidenceIds.some((id) => !identifier.safeParse(id).success)
    || authority.completedSectionIds.some((id) => !localId.safeParse(id).success)
    || authority.priorContentSha256.some((hash) => !sha256.safeParse(hash).success)
    || new Set(authority.availableEvidenceIds).size !== authority.availableEvidenceIds.length
    || new Set(authority.priorProseEvidenceIds).size !== authority.priorProseEvidenceIds.length
    || authority.priorProseEvidenceIds.some((id) => !authority.availableEvidenceIds.includes(id))) {
    throw sectionError("GROWTH_LONGFORM_SECTION_AUTHORITY_MISMATCH");
  }
  const outlineSection = authority.outline.sections.find((section) => section.localId === parsed.data.outlineSectionId);
  if (!outlineSection) throw sectionError("GROWTH_LONGFORM_SECTION_OUTLINE_MISMATCH");
  if (authority.completedSectionIds.includes(outlineSection.localId)) {
    throw sectionError("GROWTH_LONGFORM_SECTION_REPLAY");
  }
  if (!sameSet(outlineSection.evidenceIds, parsed.data.evidenceIds)
    || parsed.data.evidenceIds.some((id) => !authority.availableEvidenceIds.includes(id))) {
    throw sectionError("GROWTH_LONGFORM_SECTION_EVIDENCE_MISMATCH");
  }
  if (authority.completedSectionIds.length > 0 && authority.priorProseEvidenceIds.length === 0) {
    throw sectionError("GROWTH_LONGFORM_SECTION_PRIOR_PROSE_REQUIRED");
  }
  const rawPoints = Array.from(parsed.data.candidateText).length;
  const semanticPoints = Array.from(parsed.data.candidateText.trim()).length;
  if (rawPoints !== semanticPoints) throw sectionError("GROWTH_LONGFORM_SECTION_PADDING_REJECTED");
  if (semanticPoints < outlineSection.estimatedCodePoints.min
    || semanticPoints > outlineSection.estimatedCodePoints.max) {
    throw sectionError("GROWTH_LONGFORM_SECTION_LENGTH_INVALID");
  }
  if (hasRepeatedFiller(parsed.data.candidateText)) {
    throw sectionError("GROWTH_LONGFORM_SECTION_FILLER_REJECTED");
  }
  const contentSha256 = createHash("sha256").update(parsed.data.candidateText, "utf8").digest("hex");
  if (authority.priorContentSha256.includes(contentSha256)) throw sectionError("GROWTH_LONGFORM_SECTION_REPLAY");
  return {
    outlineId: authority.outline.outlineId,
    outlineSectionId: outlineSection.localId,
    checkpointId: authority.checkpointId,
    receiptId: authority.receiptId,
    candidateText: parsed.data.candidateText,
    evidenceIds: parsed.data.evidenceIds,
    codePoints: semanticPoints,
    contentSha256,
  };
}

export function compileGrowthLongformSectionChangeSet(
  input: unknown,
  authority: GrowthLongformSectionChangeSetAuthority,
): ProposeChangeSetArgs {
  const section = compileGrowthLongformSection(input, authority);
  const storyResourceId = identifier.safeParse(authority.storyResourceId);
  const sectionDocumentId = identifier.safeParse(authority.sectionDocumentId);
  const sectionSortOrder = z.number().int().min(0).max(2_147_483_647).safeParse(authority.sectionSortOrder);
  if (!storyResourceId.success || !sectionDocumentId.success || !sectionSortOrder.success) {
    throw sectionError("GROWTH_LONGFORM_SECTION_AUTHORITY_MISMATCH");
  }
  const outlineSection = authority.outline.sections.find((candidate) => candidate.localId === section.outlineSectionId)!;
  const prefix = `growth-${createHash("sha256").update(`${section.outlineId}:${section.outlineSectionId}`).digest("hex").slice(0, 20)}`;
  const creativeItemId = `${prefix}-creative-document`;
  const documentItemId = `${prefix}-document`;
  return proposeChangeSetArgsSchema.parse({
    summary: `写入长篇章节：${outlineSection.title}`,
    items: [
      {
        id: creativeItemId,
        dependsOn: [],
        kind: "creative_document.put",
        payload: {
          documentId: sectionDocumentId.data,
          create: true,
          resourceId: storyResourceId.data,
          kind: "prose",
          title: outlineSection.title,
          state: "active",
          sortOrder: sectionSortOrder.data,
        },
      },
      {
        id: documentItemId,
        dependsOn: [creativeItemId],
        kind: "document.put",
        payload: {
          resourceId: storyResourceId.data,
          creativeDocumentId: sectionDocumentId.data,
          content: section.candidateText,
        },
      },
    ],
  });
}

function hasRepeatedFiller(text: string): boolean {
  const paragraphs = text.split(/\r?\n\s*\r?\n/u).map(normalizeUnit).filter((value) => Array.from(value).length >= 20);
  if (new Set(paragraphs).size !== paragraphs.length) return true;
  const sentences = text.split(/[。！？!?\n]+/u).map(normalizeUnit).filter((value) => Array.from(value).length >= 8);
  const counts = new Map<string, number>();
  for (const sentence of sentences) {
    const count = (counts.get(sentence) ?? 0) + 1;
    if (count >= 3) return true;
    counts.set(sentence, count);
  }
  const points = Array.from(normalizeUnit(text));
  for (let unitLength = 8; unitLength <= Math.floor(points.length / 3); unitLength += 1) {
    if (points.length % unitLength !== 0) continue;
    const unit = points.slice(0, unitLength);
    if (points.every((point, index) => point === unit[index % unitLength])) return true;
  }
  return false;
}

function normalizeUnit(value: string): string { return value.trim().replace(/\s+/gu, " "); }
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sectionError(code: GrowthLongformSectionErrorCode): Error & { code: GrowthLongformSectionErrorCode } {
  return Object.assign(new Error("Growth longform section is invalid."), { code });
}
