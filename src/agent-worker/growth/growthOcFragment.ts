import { createHash } from "node:crypto";
import { Type } from "typebox";
import { z } from "zod";
import { proposeChangeSetArgsSchema, type ProposeChangeSetArgs } from "../../shared/agentWorkerProtocol";

const localId = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const title = z.string().trim().min(1).max(500);
const profileContent = z.string().max(20_000).superRefine((value, context) => {
  if (value.trim().length < 100) {
    context.addIssue({ code: "custom", message: "GROWTH_OC_FRAGMENT_INVALID" });
  }
});
const trustedIdentifier = z.string().trim().min(1).max(240);

export const growthOcFragmentSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  characters: z.array(z.object({
    localId,
    title,
    profile: z.object({ localId, title, content: profileContent }).strict(),
  }).strict()).min(2).max(8),
  relationships: z.array(z.object({ localId, sourceRef: localId, targetRef: localId }).strict()).max(50).optional(),
}).strict().superRefine((value, context) => {
  const relationships = value.relationships ?? [];
  const localIds = [
    ...value.characters.map((character) => character.localId),
    ...value.characters.map((character) => character.profile.localId),
    ...relationships.map((relationship) => relationship.localId),
  ];
  if (new Set(localIds).size !== localIds.length) {
    context.addIssue({ code: "custom", message: "GROWTH_OC_FRAGMENT_DUPLICATE_LOCAL_ID" });
  }
  const characters = new Set(value.characters.map((character) => character.localId));
  const directedPairs = new Set<string>();
  for (const relationship of relationships) {
    if (!characters.has(relationship.sourceRef) || !characters.has(relationship.targetRef)) {
      context.addIssue({ code: "custom", message: "GROWTH_OC_FRAGMENT_REFERENCE_INVALID" });
      continue;
    }
    const pair = `${relationship.sourceRef}\u0000${relationship.targetRef}`;
    if (relationship.sourceRef === relationship.targetRef || directedPairs.has(pair)) {
      context.addIssue({ code: "custom", message: "GROWTH_OC_FRAGMENT_RELATION_INVALID" });
    }
    directedPairs.add(pair);
  }
});

export type GrowthOcFragmentErrorCode =
  | "GROWTH_OC_FRAGMENT_INVALID"
  | "GROWTH_OC_FRAGMENT_DUPLICATE_LOCAL_ID"
  | "GROWTH_OC_FRAGMENT_REFERENCE_INVALID"
  | "GROWTH_OC_FRAGMENT_RELATION_INVALID"
  | "GROWTH_OC_FRAGMENT_STORY_INVALID";

export const growthOcFragmentParameters = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  characters: Type.Array(Type.Object({
    localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    profile: Type.Object({
      localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }),
      title: Type.String({ minLength: 1, maxLength: 500 }),
      content: Type.String({ minLength: 1, maxLength: 20_000 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }), { minItems: 2, maxItems: 8 }),
  relationships: Type.Optional(Type.Array(Type.Object({
    localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }),
    sourceRef: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }),
    targetRef: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }),
  }, { additionalProperties: false }), { maxItems: 50 })),
}, { additionalProperties: false });

export function compileGrowthOcFragment(input: unknown, trusted: {
  cycleId: string;
  ocRootResourceId: string;
  storyResourceId: string;
}): ProposeChangeSetArgs {
  const parsed = growthOcFragmentSchema.safeParse(input);
  if (!parsed.success) {
    const codes = new Set(parsed.error.issues.map((issue) => issue.message));
    for (const code of [
      "GROWTH_OC_FRAGMENT_DUPLICATE_LOCAL_ID",
      "GROWTH_OC_FRAGMENT_REFERENCE_INVALID",
      "GROWTH_OC_FRAGMENT_RELATION_INVALID",
    ] as const) if (codes.has(code)) throw fragmentError(code);
    throw fragmentError("GROWTH_OC_FRAGMENT_INVALID");
  }
  if (!trustedIdentifier.safeParse(trusted.cycleId).success
    || !trustedIdentifier.safeParse(trusted.ocRootResourceId).success
    || !trustedIdentifier.safeParse(trusted.storyResourceId).success) {
    throw fragmentError("GROWTH_OC_FRAGMENT_STORY_INVALID");
  }
  const fragment = parsed.data;
  const relationships = fragment.relationships ?? [];
  const prefix = `growth-${createHash("sha256").update(`${trusted.cycleId}:oc`).digest("hex").slice(0, 20)}`;
  const characters = new Map<string, { resourceId: string; resourceItemId: string }>();
  const items: ProposeChangeSetArgs["items"] = [];
  for (const [index, character] of fragment.characters.entries()) {
    const resourceId = `${prefix}-resource-${character.localId}`;
    const resourceItemId = `${prefix}-resource-item-${character.localId}`;
    const creativeDocumentId = `${prefix}-document-${character.profile.localId}`;
    const creativeItemId = `${prefix}-creative-document-item-${character.profile.localId}`;
    const documentItemId = `${prefix}-document-item-${character.profile.localId}`;
    const usesOcItemId = `${prefix}-relation-item-uses-oc-${character.localId}`;
    characters.set(character.localId, { resourceId, resourceItemId });
    items.push(
      { id: resourceItemId, dependsOn: [], kind: "resource.put", payload: { resourceId, create: true, type: "oc", objectKind: "oc", title: character.title, parentId: trusted.ocRootResourceId, state: "active", sortOrder: index } },
      { id: creativeItemId, dependsOn: [resourceItemId], kind: "creative_document.put", payload: { documentId: creativeDocumentId, create: true, resourceId, kind: "character_profile", title: character.profile.title, state: "active", sortOrder: index } },
      { id: documentItemId, dependsOn: [resourceItemId, creativeItemId], kind: "document.put", payload: { resourceId, creativeDocumentId, content: character.profile.content } },
      { id: usesOcItemId, dependsOn: [resourceItemId], kind: "creative_relation.put", payload: { relationId: `${prefix}-relation-uses-oc-${character.localId}`, create: true, relationKind: "uses_oc", sourceResourceId: trusted.storyResourceId, targetResourceId: resourceId, state: "active" } },
    );
  }
  for (const relationship of relationships) {
    const source = characters.get(relationship.sourceRef)!;
    const target = characters.get(relationship.targetRef)!;
    items.push({
      id: `${prefix}-relation-item-${relationship.localId}`,
      dependsOn: [source.resourceItemId, target.resourceItemId],
      kind: "creative_relation.put",
      payload: {
        relationId: `${prefix}-relation-${relationship.localId}`,
        create: true,
        relationKind: "related_to",
        sourceResourceId: source.resourceId,
        targetResourceId: target.resourceId,
        state: "active",
      },
    });
  }
  return proposeChangeSetArgsSchema.parse({ summary: fragment.summary, items });
}

function fragmentError(code: GrowthOcFragmentErrorCode): Error & { code: GrowthOcFragmentErrorCode } {
  return Object.assign(new Error("Growth OC Fragment is invalid."), { code });
}
