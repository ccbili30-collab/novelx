import { createHash } from "node:crypto";
import { Type } from "typebox";
import { z } from "zod";
import { proposeChangeSetArgsSchema, type ProposeChangeSetArgs } from "../../shared/agentWorkerProtocol";

const localId = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const localRef = localId;
const text = z.string().trim().min(1).max(80_000);

export const growthWorldFragmentSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  world: z.object({ localId, title: z.string().trim().min(1).max(500) }).strict(),
  entities: z.array(z.object({
    localId, kind: z.enum(["location", "faction"]), title: z.string().trim().min(1).max(500), parentRef: localRef.optional(),
  }).strict()).max(100),
  documents: z.array(z.object({
    localId, ownerRef: localRef, kind: z.enum(["setting", "location_profile", "faction_profile", "knowledge_note"]),
    title: z.string().trim().min(1).max(500), content: text,
  }).strict()).min(1).max(100),
  assertions: z.array(z.object({
    localId, scopeRef: localRef, subject: z.string().trim().min(1).max(500), predicate: z.string().trim().min(1).max(240),
    object: z.record(z.string().min(1).max(240), z.json()), sourceDocumentRefs: z.array(localRef).min(1).max(20),
  }).strict()).min(1).max(200),
  relations: z.array(z.object({ localId, sourceRef: localRef, targetRef: localRef }).strict()).max(200),
}).strict().superRefine((value, ctx) => {
  const ids = [value.world.localId, ...value.entities.map((item) => item.localId), ...value.documents.map((item) => item.localId), ...value.assertions.map((item) => item.localId), ...value.relations.map((item) => item.localId)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_DUPLICATE_LOCAL_ID" });
  const resources = new Set([value.world.localId, ...value.entities.map((item) => item.localId)]);
  const resourceKinds = new Map<string, "world" | "location" | "faction">([[value.world.localId, "world"], ...value.entities.map((item) => [item.localId, item.kind] as const)]);
  const documents = new Set(value.documents.map((item) => item.localId));
  for (const entity of value.entities) {
    if (entity.parentRef && !resources.has(entity.parentRef)) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_REFERENCE_INVALID" });
    const parentKind = resourceKinds.get(entity.parentRef ?? value.world.localId);
    if (parentKind && ((entity.kind === "location" && !["world", "location"].includes(parentKind)) || (entity.kind === "faction" && !["world", "faction"].includes(parentKind)))) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_PARENT_KIND_INVALID" });
  }
  for (const document of value.documents) if (!resources.has(document.ownerRef)) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_REFERENCE_INVALID" });
  if (!value.documents.some((item) => item.ownerRef === value.world.localId && item.kind === "setting")) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_WORLD_SETTING_REQUIRED" });
  for (const assertion of value.assertions) {
    if (!resources.has(assertion.scopeRef) || assertion.sourceDocumentRefs.some((ref) => !documents.has(ref))) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_REFERENCE_INVALID" });
  }
  for (const relation of value.relations) if (!resources.has(relation.sourceRef) || !resources.has(relation.targetRef) || relation.sourceRef === relation.targetRef) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_RELATION_INVALID" });
});

export type GrowthWorldFragment = z.infer<typeof growthWorldFragmentSchema>;

export type GrowthWorldFragmentErrorCode =
  | "GROWTH_FRAGMENT_INVALID"
  | "GROWTH_FRAGMENT_DUPLICATE_LOCAL_ID"
  | "GROWTH_FRAGMENT_REFERENCE_INVALID"
  | "GROWTH_FRAGMENT_REFERENCE_CYCLE"
  | "GROWTH_FRAGMENT_PARENT_KIND_INVALID"
  | "GROWTH_FRAGMENT_WORLD_SETTING_REQUIRED"
  | "GROWTH_FRAGMENT_RELATION_INVALID";

export const growthWorldFragmentParameters = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  world: Type.Object({ localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }), title: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
  entities: Type.Array(Type.Object({ localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }), kind: Type.Union([Type.Literal("location"), Type.Literal("faction")]), title: Type.String({ minLength: 1, maxLength: 500 }), parentRef: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" })) }, { additionalProperties: false }), { maxItems: 100 }),
  documents: Type.Array(Type.Object({ localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }), ownerRef: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }), kind: Type.Union([Type.Literal("setting"), Type.Literal("location_profile"), Type.Literal("faction_profile"), Type.Literal("knowledge_note")]), title: Type.String({ minLength: 1, maxLength: 500 }), content: Type.String({ minLength: 1, maxLength: 80000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
  assertions: Type.Array(Type.Object({ localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }), scopeRef: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }), subject: Type.String({ minLength: 1, maxLength: 500 }), predicate: Type.String({ minLength: 1, maxLength: 240 }), object: Type.Object({}, { additionalProperties: true }), sourceDocumentRefs: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 200 }),
  relations: Type.Array(Type.Object({ localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }), sourceRef: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }), targetRef: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }) }, { additionalProperties: false }), { maxItems: 200 }),
}, { additionalProperties: false });

export function compileGrowthWorldFragment(input: unknown, trusted: { cycleId: string; worldRootResourceId: string }): ProposeChangeSetArgs {
  let fragment: GrowthWorldFragment;
  const parsed = growthWorldFragmentSchema.safeParse(input);
  if (!parsed.success) {
    const messages = new Set(parsed.error.issues.map((issue) => issue.message));
    for (const code of [
      "GROWTH_FRAGMENT_DUPLICATE_LOCAL_ID",
      "GROWTH_FRAGMENT_REFERENCE_INVALID",
      "GROWTH_FRAGMENT_PARENT_KIND_INVALID",
      "GROWTH_FRAGMENT_WORLD_SETTING_REQUIRED",
      "GROWTH_FRAGMENT_RELATION_INVALID",
    ] as const) if (messages.has(code)) throw fragmentError(code);
    throw fragmentError("GROWTH_FRAGMENT_INVALID");
  }
  fragment = parsed.data;
  const prefix = `growth-${digest(`${trusted.cycleId}:world`).slice(0, 20)}`;
  const resources = new Map<string, { resourceId: string; itemId: string }>();
  const items: ProposeChangeSetArgs["items"] = [];
  const addResource = (local: string, type: "world" | "location" | "faction", title: string, parentId: string, parentItem?: string) => {
    const resourceId = `${prefix}-resource-${local}`; const itemId = `${prefix}-resource-item-${local}`;
    resources.set(local, { resourceId, itemId });
    items.push({ id: itemId, dependsOn: parentItem ? [parentItem] : [], kind: "resource.put", payload: { resourceId, create: true, type: "world", objectKind: type, title, parentId, state: "active", sortOrder: items.length } });
  };
  addResource(fragment.world.localId, "world", fragment.world.title, trusted.worldRootResourceId);
  const pending = [...fragment.entities];
  while (pending.length > 0) {
    const ready = pending.filter((entity) => resources.has(entity.parentRef ?? fragment.world.localId));
    if (ready.length === 0) throw fragmentError("GROWTH_FRAGMENT_REFERENCE_CYCLE");
    for (const entity of ready) {
      const parent = resources.get(entity.parentRef ?? fragment.world.localId)!;
      addResource(entity.localId, entity.kind, entity.title, parent.resourceId, parent.itemId);
      pending.splice(pending.indexOf(entity), 1);
    }
  }
  const documents = new Map<string, { documentId: string; creativeItemId: string; documentItemId: string }>();
  for (const document of fragment.documents) { const owner = resources.get(document.ownerRef)!; const documentId = `${prefix}-document-${document.localId}`; const creativeItemId = `${prefix}-creative-document-item-${document.localId}`; const documentItemId = `${prefix}-document-item-${document.localId}`; documents.set(document.localId, { documentId, creativeItemId, documentItemId }); items.push({ id: creativeItemId, dependsOn: [owner.itemId], kind: "creative_document.put", payload: { documentId, create: true, resourceId: owner.resourceId, kind: document.kind, title: document.title, state: "active", sortOrder: items.length } }); items.push({ id: documentItemId, dependsOn: [owner.itemId, creativeItemId], kind: "document.put", payload: { resourceId: owner.resourceId, creativeDocumentId: documentId, content: document.content } }); }
  for (const assertion of fragment.assertions) { const scope = resources.get(assertion.scopeRef)!; const sources = assertion.sourceDocumentRefs.map((ref) => documents.get(ref)!); items.push({ id: `${prefix}-assertion-item-${assertion.localId}`, dependsOn: [scope.itemId, ...sources.map((source) => source.documentItemId)], kind: "assertion.put", payload: { assertionId: `${prefix}-assertion-${assertion.localId}`, scopeType: "world", scopeId: scope.resourceId, subject: assertion.subject, predicate: assertion.predicate, object: assertion.object, evidenceIds: sources.map((source) => `greenfield_document_output:${source.documentItemId}`) } }); }
  for (const relation of fragment.relations) { const source = resources.get(relation.sourceRef)!; const target = resources.get(relation.targetRef)!; items.push({ id: `${prefix}-relation-item-${relation.localId}`, dependsOn: [source.itemId, target.itemId], kind: "creative_relation.put", payload: { relationId: `${prefix}-relation-${relation.localId}`, create: true, relationKind: "related_to", sourceResourceId: source.resourceId, targetResourceId: target.resourceId, state: "active" } }); }
  return proposeChangeSetArgsSchema.parse({ summary: fragment.summary, items });
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fragmentError(code: GrowthWorldFragmentErrorCode): Error & { code: GrowthWorldFragmentErrorCode } {
  return Object.assign(new Error("Growth world Fragment is invalid."), { code });
}
