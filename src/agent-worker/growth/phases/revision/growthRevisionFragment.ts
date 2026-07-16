import { createHash } from "node:crypto";
import { Type } from "typebox";
import { z } from "zod";
import { assertCreativeRelationAllowed } from "../../../../domain/workspace/creativeRelationPolicy";
import type { CreativeObjectKind, ResourceDomain } from "../../../../domain/workspace/creativeObjectPolicy";
import {
  proposeChangeSetArgsSchema,
  type GrowthRevisionAuthority,
  type ProposeChangeSetArgs,
} from "../../../../shared/agentWorkerProtocol";
import { growthImpactBriefParameters, growthImpactBriefSchema } from "./growthImpactBrief";

const localId = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const evidenceId = z.string().trim().min(1).max(240);
const title = z.string().trim().min(1).max(500);
const content = z.string().max(80_000).refine((value) => value.trim().length > 0, "GROWTH_REVISION_FRAGMENT_INVALID");
const object = z.record(z.string().min(1).max(240), z.json());
const documentKind = z.enum([
  "prose", "setting", "character_profile", "location_profile", "faction_profile",
  "knowledge_note", "style_guide", "writing_constraints",
]);
const relationKind = z.enum(["uses_world", "uses_oc", "variant_of", "related_to"]);

export const growthRevisionFragmentSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  impact: growthImpactBriefSchema,
  resourceUpdates: z.array(z.object({ evidenceId, title }).strict()).max(100),
  documentUpdates: z.array(z.object({ evidenceId, title, content }).strict()).max(100),
  assertionUpdates: z.array(z.object({
    evidenceId, subject: title, predicate: z.string().trim().min(1).max(240), object,
    sourceDocumentRefs: z.array(evidenceId).min(1).max(100),
  }).strict()).max(100),
  relationRemovals: z.array(z.object({ evidenceId }).strict()).max(100),
  resourceAdditions: z.array(z.object({
    localId, kind: z.enum(["world", "location", "faction", "story", "oc"]), title,
    parentRef: z.string().trim().min(1).max(240).optional(),
  }).strict()).max(100),
  documentAdditions: z.array(z.object({
    localId, ownerRef: z.string().trim().min(1).max(240), kind: documentKind, title, content,
  }).strict()).max(100),
  assertionAdditions: z.array(z.object({
    localId, scopeRef: z.string().trim().min(1).max(240), subject: title,
    predicate: z.string().trim().min(1).max(240), object,
    sourceDocumentRefs: z.array(z.string().trim().min(1).max(240)).min(1).max(100),
  }).strict()).max(100),
  relationAdditions: z.array(z.object({
    localId, kind: relationKind, sourceRef: z.string().trim().min(1).max(240),
    targetRef: z.string().trim().min(1).max(240),
  }).strict()).max(100),
}).strict().superRefine((value, context) => {
  const localIds = [
    ...value.resourceAdditions.map((item) => item.localId),
    ...value.documentAdditions.map((item) => item.localId),
    ...value.assertionAdditions.map((item) => item.localId),
    ...value.relationAdditions.map((item) => item.localId),
  ];
  if (new Set(localIds).size !== localIds.length) {
    context.addIssue({ code: "custom", message: "GROWTH_REVISION_FRAGMENT_DUPLICATE_LOCAL_ID" });
  }
  const targetIds = [
    ...value.resourceUpdates.map((item) => item.evidenceId),
    ...value.documentUpdates.map((item) => item.evidenceId),
    ...value.assertionUpdates.map((item) => item.evidenceId),
    ...value.relationRemovals.map((item) => item.evidenceId),
  ];
  if (new Set(targetIds).size !== targetIds.length) {
    context.addIssue({ code: "custom", message: "GROWTH_REVISION_FRAGMENT_DUPLICATE_TARGET" });
  }
});

export type GrowthRevisionFragment = z.infer<typeof growthRevisionFragmentSchema>;
export type GrowthRevisionFragmentErrorCode =
  | "GROWTH_REVISION_FRAGMENT_INVALID"
  | "GROWTH_REVISION_FRAGMENT_DUPLICATE_LOCAL_ID"
  | "GROWTH_REVISION_FRAGMENT_DUPLICATE_TARGET"
  | "GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID"
  | "GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH"
  | "GROWTH_REVISION_FRAGMENT_REFERENCE_INVALID"
  | "GROWTH_REVISION_FRAGMENT_REFERENCE_CYCLE"
  | "GROWTH_REVISION_FRAGMENT_RELATION_INVALID";

const refParameter = Type.String({ minLength: 1, maxLength: 240 });
const localIdParameter = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" });
const titleParameter = Type.String({ minLength: 1, maxLength: 500 });
const contentParameter = Type.String({ minLength: 1, maxLength: 80_000 });
const objectParameter = Type.Object({}, { additionalProperties: true });
const documentKindParameter = Type.Union([
  Type.Literal("prose"), Type.Literal("setting"), Type.Literal("character_profile"),
  Type.Literal("location_profile"), Type.Literal("faction_profile"), Type.Literal("knowledge_note"),
  Type.Literal("style_guide"), Type.Literal("writing_constraints"),
]);
const relationKindParameter = Type.Union([
  Type.Literal("uses_world"), Type.Literal("uses_oc"), Type.Literal("variant_of"), Type.Literal("related_to"),
]);

export const growthRevisionFragmentParameters = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  impact: growthImpactBriefParameters,
  resourceUpdates: Type.Array(Type.Object({ evidenceId: refParameter, title: titleParameter }, { additionalProperties: false }), { maxItems: 100 }),
  documentUpdates: Type.Array(Type.Object({ evidenceId: refParameter, title: titleParameter, content: contentParameter }, { additionalProperties: false }), { maxItems: 100 }),
  assertionUpdates: Type.Array(Type.Object({
    evidenceId: refParameter, subject: titleParameter, predicate: Type.String({ minLength: 1, maxLength: 240 }),
    object: objectParameter, sourceDocumentRefs: Type.Array(refParameter, { minItems: 1, maxItems: 100 }),
  }, { additionalProperties: false }), { maxItems: 100 }),
  relationRemovals: Type.Array(Type.Object({ evidenceId: refParameter }, { additionalProperties: false }), { maxItems: 100 }),
  resourceAdditions: Type.Array(Type.Object({
    localId: localIdParameter,
    kind: Type.Union([Type.Literal("world"), Type.Literal("location"), Type.Literal("faction"), Type.Literal("story"), Type.Literal("oc")]),
    title: titleParameter, parentRef: Type.Optional(refParameter),
  }, { additionalProperties: false }), { maxItems: 100 }),
  documentAdditions: Type.Array(Type.Object({
    localId: localIdParameter, ownerRef: refParameter, kind: documentKindParameter,
    title: titleParameter, content: contentParameter,
  }, { additionalProperties: false }), { maxItems: 100 }),
  assertionAdditions: Type.Array(Type.Object({
    localId: localIdParameter, scopeRef: refParameter, subject: titleParameter,
    predicate: Type.String({ minLength: 1, maxLength: 240 }), object: objectParameter,
    sourceDocumentRefs: Type.Array(refParameter, { minItems: 1, maxItems: 100 }),
  }, { additionalProperties: false }), { maxItems: 100 }),
  relationAdditions: Type.Array(Type.Object({
    localId: localIdParameter, kind: relationKindParameter, sourceRef: refParameter, targetRef: refParameter,
  }, { additionalProperties: false }), { maxItems: 100 }),
}, { additionalProperties: false });

export function compileGrowthRevisionFragment(input: unknown, trusted: {
  cycleId: string;
  domainRootResourceIds: { world: string; story: string; oc: string };
  authority: GrowthRevisionAuthority;
}): ProposeChangeSetArgs {
  const parsed = growthRevisionFragmentSchema.safeParse(input);
  if (!parsed.success) {
    const messages = new Set(parsed.error.issues.map((issue) => issue.message));
    for (const code of [
      "GROWTH_REVISION_FRAGMENT_DUPLICATE_LOCAL_ID",
      "GROWTH_REVISION_FRAGMENT_DUPLICATE_TARGET",
    ] as const) if (messages.has(code)) throw revisionError(code);
    throw revisionError("GROWTH_REVISION_FRAGMENT_INVALID");
  }
  const fragment = parsed.data;
  const authorityByEvidence = new Map(trusted.authority.targets.map((target) => [target.evidenceId, target]));
  if (fragment.impact.targets.some((target) => !authorityByEvidence.has(target.evidenceId))) {
    throw revisionError("GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID");
  }
  const decisions = new Map(fragment.impact.targets.map((target) => [target.evidenceId, target.decision]));
  const updatedEvidenceIds = [
    ...fragment.resourceUpdates.map((item) => item.evidenceId),
    ...fragment.documentUpdates.map((item) => item.evidenceId),
    ...fragment.assertionUpdates.map((item) => item.evidenceId),
    ...fragment.relationRemovals.map((item) => item.evidenceId),
  ];
  const revised = fragment.impact.targets.filter((target) => target.decision === "revise").map((target) => target.evidenceId);
  if (!sameSet(updatedEvidenceIds, revised)) throw revisionError("GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH");
  const actualAdditionKinds = [
    ...fragment.resourceAdditions.map((item) => item.kind),
    ...fragment.documentAdditions.map(() => "document" as const),
    ...fragment.assertionAdditions.map(() => "assertion" as const),
    ...fragment.relationAdditions.map(() => "relation" as const),
  ];
  if (!sameMultiset(actualAdditionKinds, fragment.impact.additions.map((addition) => addition.kind))) {
    throw revisionError("GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH");
  }
  if ([...decisions.values()].some((decision) => decision === "preserve")
    && updatedEvidenceIds.some((id) => decisions.get(id) === "preserve")) {
    throw revisionError("GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH");
  }

  const prefix = `growth-${createHash("sha256").update(`${trusted.cycleId}:revision`).digest("hex").slice(0, 20)}`;
  const items: ProposeChangeSetArgs["items"] = [];
  const resources = new Map<string, ResolvedResource>();
  for (const target of trusted.authority.targets) {
    if (target.kind === "resource") resources.set(target.evidenceId, {
      resourceId: target.resourceId, type: target.type, objectKind: target.objectKind,
      itemId: null,
    });
  }
  const documents = new Map<string, { documentId: string; resourceId: string; itemId: string | null }>();
  for (const target of trusted.authority.targets) if (target.kind === "document") {
    documents.set(target.evidenceId, { documentId: target.documentId, resourceId: target.resourceId, itemId: null });
  }

  for (const update of fragment.resourceUpdates) {
    const target = authorityByEvidence.get(update.evidenceId);
    if (!target || target.kind !== "resource") throw revisionError("GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID");
    items.push({
      id: `${prefix}-resource-update-${items.length}`, dependsOn: [], kind: "resource.put",
      payload: {
        resourceId: target.resourceId, create: false, type: target.type, objectKind: target.objectKind,
        title: update.title, parentId: target.parentId, state: "active", sortOrder: target.sortOrder,
      },
    });
  }

  const pendingResources = [...fragment.resourceAdditions];
  while (pendingResources.length > 0) {
    const ready = pendingResources.filter((addition) => canResolveParent(addition, resources));
    if (ready.length === 0) throw revisionError("GROWTH_REVISION_FRAGMENT_REFERENCE_CYCLE");
    for (const addition of ready) {
      const resourceId = `${prefix}-resource-${addition.localId}`;
      const itemId = `${prefix}-resource-item-${addition.localId}`;
      const placement = resourcePlacement(addition.kind, addition.parentRef, resources, trusted.domainRootResourceIds);
      items.push({
        id: itemId, dependsOn: placement.parentItemId ? [placement.parentItemId] : [], kind: "resource.put",
        payload: {
          resourceId, create: true, type: placement.type, objectKind: addition.kind,
          title: addition.title, parentId: placement.parentId, state: "active", sortOrder: items.length,
        },
      });
      resources.set(addition.localId, { resourceId, type: placement.type, objectKind: addition.kind, itemId });
      pendingResources.splice(pendingResources.indexOf(addition), 1);
    }
  }

  for (const update of fragment.documentUpdates) {
    const target = authorityByEvidence.get(update.evidenceId);
    if (!target || target.kind !== "document") throw revisionError("GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID");
    const creativeItemId = `${prefix}-document-meta-update-${items.length}`;
    const documentItemId = `${prefix}-document-content-update-${items.length}`;
    items.push(
      { id: creativeItemId, dependsOn: [], kind: "creative_document.put", payload: {
        documentId: target.documentId, create: false, resourceId: target.resourceId,
        kind: target.documentKind, title: update.title, state: "active", sortOrder: target.sortOrder,
      } },
      { id: documentItemId, dependsOn: [creativeItemId], kind: "document.put", payload: {
        resourceId: target.resourceId, creativeDocumentId: target.documentId, content: update.content,
      } },
    );
  }

  for (const addition of fragment.documentAdditions) {
    const owner = resources.get(addition.ownerRef);
    if (!owner) throw revisionError("GROWTH_REVISION_FRAGMENT_REFERENCE_INVALID");
    const documentId = `${prefix}-document-${addition.localId}`;
    const creativeItemId = `${prefix}-creative-document-item-${addition.localId}`;
    const documentItemId = `${prefix}-document-item-${addition.localId}`;
    items.push(
      { id: creativeItemId, dependsOn: owner.itemId ? [owner.itemId] : [], kind: "creative_document.put", payload: {
        documentId, create: true, resourceId: owner.resourceId, kind: addition.kind,
        title: addition.title, state: "active", sortOrder: items.length,
      } },
      { id: documentItemId, dependsOn: [creativeItemId], kind: "document.put", payload: {
        resourceId: owner.resourceId, creativeDocumentId: documentId, content: addition.content,
      } },
    );
    documents.set(addition.localId, { documentId, resourceId: owner.resourceId, itemId: documentItemId });
  }

  for (const update of fragment.assertionUpdates) {
    const target = authorityByEvidence.get(update.evidenceId);
    if (!target || target.kind !== "assertion") throw revisionError("GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID");
    const sources = resolveDocumentSources(update.sourceDocumentRefs, documents);
    items.push({ id: `${prefix}-assertion-update-${items.length}`, dependsOn: sources.dependsOn, kind: "assertion.put", payload: {
      assertionId: target.assertionId, scopeType: target.scopeType, scopeId: target.scopeId,
      subject: update.subject, predicate: update.predicate, object: update.object, evidenceIds: sources.evidenceIds,
    } });
  }
  for (const addition of fragment.assertionAdditions) {
    const scope = resources.get(addition.scopeRef);
    if (!scope) throw revisionError("GROWTH_REVISION_FRAGMENT_REFERENCE_INVALID");
    const sources = resolveDocumentSources(addition.sourceDocumentRefs, documents);
    items.push({ id: `${prefix}-assertion-item-${addition.localId}`, dependsOn: [
      ...(scope.itemId ? [scope.itemId] : []), ...sources.dependsOn,
    ], kind: "assertion.put", payload: {
      assertionId: `${prefix}-assertion-${addition.localId}`, scopeType: scope.type, scopeId: scope.resourceId,
      subject: addition.subject, predicate: addition.predicate, object: addition.object, evidenceIds: sources.evidenceIds,
    } });
  }

  for (const removal of fragment.relationRemovals) {
    const target = authorityByEvidence.get(removal.evidenceId);
    if (!target || target.kind !== "relation") throw revisionError("GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID");
    items.push({ id: `${prefix}-relation-remove-${items.length}`, dependsOn: [], kind: "creative_relation.put", payload: {
      relationId: target.relationId, create: false, relationKind: target.relationKind,
      sourceResourceId: target.sourceResourceId, targetResourceId: target.targetResourceId, state: "deleted",
    } });
  }
  for (const addition of fragment.relationAdditions) {
    const source = resources.get(addition.sourceRef);
    const target = resources.get(addition.targetRef);
    if (!source || !target) throw revisionError("GROWTH_REVISION_FRAGMENT_REFERENCE_INVALID");
    try {
      assertCreativeRelationAllowed({
        kind: addition.kind,
        source: { id: source.resourceId, type: source.type, objectKind: source.objectKind },
        target: { id: target.resourceId, type: target.type, objectKind: target.objectKind },
      });
    } catch {
      throw revisionError("GROWTH_REVISION_FRAGMENT_RELATION_INVALID");
    }
    items.push({ id: `${prefix}-relation-item-${addition.localId}`, dependsOn: [
      ...(source.itemId ? [source.itemId] : []), ...(target.itemId ? [target.itemId] : []),
    ], kind: "creative_relation.put", payload: {
      relationId: `${prefix}-relation-${addition.localId}`, create: true, relationKind: addition.kind,
      sourceResourceId: source.resourceId, targetResourceId: target.resourceId, state: "active",
    } });
  }
  if (items.length === 0) throw revisionError("GROWTH_REVISION_FRAGMENT_INVALID");
  return proposeChangeSetArgsSchema.parse({
    summary: fragment.summary,
    items,
    growthRevisionImpact: {
      revisedEvidenceIds: fragment.impact.targets
        .filter((target) => target.decision === "revise")
        .map((target) => target.evidenceId),
      preservedEvidenceIds: fragment.impact.targets
        .filter((target) => target.decision === "preserve")
        .map((target) => target.evidenceId),
      staleVisualEvidenceIds: fragment.impact.targets
        .filter((target) => target.decision !== "preserve")
        .map((target) => target.evidenceId),
    },
  });
}

interface ResolvedResource {
  resourceId: string;
  type: ResourceDomain;
  objectKind: CreativeObjectKind;
  itemId: string | null;
}

function canResolveParent(
  addition: GrowthRevisionFragment["resourceAdditions"][number],
  resources: Map<string, ResolvedResource>,
): boolean {
  if (["world", "story", "oc"].includes(addition.kind)) return true;
  if (addition.parentRef) return resources.has(addition.parentRef);
  return [...resources.values()].filter((resource) => resource.objectKind === "world").length === 1;
}

function resourcePlacement(
  kind: GrowthRevisionFragment["resourceAdditions"][number]["kind"],
  parentRef: string | undefined,
  resources: Map<string, ResolvedResource>,
  roots: { world: string; story: string; oc: string },
): { type: "world" | "story" | "oc"; parentId: string; parentItemId: string | null } {
  if (kind === "world" || kind === "story" || kind === "oc") {
    return { type: kind, parentId: roots[kind], parentItemId: null };
  }
  const parent = parentRef
    ? resources.get(parentRef)
    : [...resources.values()].find((resource) => resource.objectKind === "world");
  if (!parent || parent.type !== "world") throw revisionError("GROWTH_REVISION_FRAGMENT_REFERENCE_INVALID");
  if ((kind === "location" && !["world", "location"].includes(parent.objectKind))
    || (kind === "faction" && !["world", "faction"].includes(parent.objectKind))) {
    throw revisionError("GROWTH_REVISION_FRAGMENT_REFERENCE_INVALID");
  }
  return { type: "world", parentId: parent.resourceId, parentItemId: parent.itemId };
}

function resolveDocumentSources(
  refs: string[],
  documents: Map<string, { documentId: string; resourceId: string; itemId: string | null }>,
): { evidenceIds: string[]; dependsOn: string[] } {
  const evidenceIds: string[] = [];
  const dependsOn: string[] = [];
  for (const ref of refs) {
    const document = documents.get(ref);
    if (!document) throw revisionError("GROWTH_REVISION_FRAGMENT_REFERENCE_INVALID");
    if (document.itemId) {
      evidenceIds.push(`greenfield_document_output:${document.itemId}`);
      dependsOn.push(document.itemId);
    } else {
      evidenceIds.push(ref);
    }
  }
  return { evidenceIds, dependsOn };
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((item) => right.includes(item));
}

function sameMultiset(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((item, index) => item === sortedRight[index]);
}

function revisionError(code: GrowthRevisionFragmentErrorCode): Error & { code: GrowthRevisionFragmentErrorCode } {
  return Object.assign(new Error("Growth revision Fragment is invalid."), { code });
}
