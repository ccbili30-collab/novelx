import { createHash } from "node:crypto";
import { Type } from "typebox";
import { z } from "zod";
import { proposeChangeSetArgsSchema, type ProposeChangeSetArgs } from "../../shared/agentWorkerProtocol";

const localId = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const evidenceId = z.string().trim().min(1).max(240);
const title = z.string().trim().min(1).max(500);

export const growthStoryFragmentSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  story: z.object({ localId, title }).strict(),
  prose: z.object({ localId, title }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.story.localId === value.prose.localId) ctx.addIssue({ code: "custom", message: "GROWTH_STORY_FRAGMENT_DUPLICATE_LOCAL_ID" });
});

export const growthStoryFragmentParameters = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  story: Type.Object({ localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }), title: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
  prose: Type.Object({ localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }), title: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
}, { additionalProperties: false });

export function compileGrowthStoryFragment(input: unknown, trusted: {
  cycleId: string; storyRootResourceId: string; writerCandidateText: string; writerEvidenceIds: readonly string[]; worldEvidenceId: string; worldResourceId: string;
}): ProposeChangeSetArgs {
  const parsed = growthStoryFragmentSchema.safeParse(input);
  if (!parsed.success) throw storyError(parsed.error.issues.some((issue) => issue.message === "GROWTH_STORY_FRAGMENT_DUPLICATE_LOCAL_ID") ? "GROWTH_STORY_FRAGMENT_DUPLICATE_LOCAL_ID" : "GROWTH_STORY_FRAGMENT_INVALID");
  const fragment = parsed.data;
  if (!evidenceId.safeParse(trusted.worldEvidenceId).success || !evidenceId.safeParse(trusted.worldResourceId).success) {
    throw storyError("GROWTH_STORY_FRAGMENT_WORLD_EVIDENCE_INVALID");
  }
  if (!trusted.writerEvidenceIds.includes(trusted.worldEvidenceId)) throw storyError("GROWTH_STORY_FRAGMENT_WRITER_EVIDENCE_REQUIRED");
  const worldResourceId = trusted.worldResourceId;
  const prefix = `growth-${createHash("sha256").update(`${trusted.cycleId}:story`).digest("hex").slice(0, 20)}`;
  const storyId = `${prefix}-resource-${fragment.story.localId}`;
  const storyItem = `${prefix}-resource-item-${fragment.story.localId}`;
  const documentId = `${prefix}-document-${fragment.prose.localId}`;
  const creativeItem = `${prefix}-creative-document-item-${fragment.prose.localId}`;
  const documentItem = `${prefix}-document-item-${fragment.prose.localId}`;
  const relationItem = `${prefix}-relation-item-uses-world`;
  return proposeChangeSetArgsSchema.parse({ summary: fragment.summary, items: [
    { id: storyItem, dependsOn: [], kind: "resource.put", payload: { resourceId: storyId, create: true, type: "story", objectKind: "story", title: fragment.story.title, parentId: trusted.storyRootResourceId, state: "active", sortOrder: 0 } },
    { id: creativeItem, dependsOn: [storyItem], kind: "creative_document.put", payload: { documentId, create: true, resourceId: storyId, kind: "prose", title: fragment.prose.title, state: "active", sortOrder: 1 } },
    { id: documentItem, dependsOn: [storyItem, creativeItem], kind: "document.put", payload: { resourceId: storyId, creativeDocumentId: documentId, content: trusted.writerCandidateText } },
    { id: relationItem, dependsOn: [storyItem], kind: "creative_relation.put", payload: { relationId: `${prefix}-relation-uses-world`, create: true, relationKind: "uses_world", sourceResourceId: storyId, targetResourceId: worldResourceId, state: "active" } },
  ] });
}

function storyError(code: "GROWTH_STORY_FRAGMENT_INVALID" | "GROWTH_STORY_FRAGMENT_DUPLICATE_LOCAL_ID" | "GROWTH_STORY_FRAGMENT_WRITER_EVIDENCE_REQUIRED" | "GROWTH_STORY_FRAGMENT_WORLD_EVIDENCE_INVALID"): Error & { code: string } {
  return Object.assign(new Error("Growth Story Fragment is invalid."), { code });
}
