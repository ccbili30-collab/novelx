import { createHash } from "node:crypto";
import { Type } from "typebox";
import { z } from "zod";
import { proposeChangeSetArgsSchema, type ProposeChangeSetArgs } from "../../shared/agentWorkerProtocol";
import {
  WORLD_SCALE_SYSTEMS,
  type WorldScaleClosureProjection,
  type WorldScaleEntityRole,
} from "../../domain/growth/closure/worldScaleClosureProfile";

const localId = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const localRef = localId;
const scaleRole = z.enum([
  "macro_region", "mountain_system", "sea", "river", "transport_network", "resource_distribution",
  "polity", "civilization_group",
]);
const systemRef = z.enum(WORLD_SCALE_SYSTEMS);
const sourceDocumentRefs = z.array(localRef).min(1).max(20);
const documentContent = z.string().max(80_000).refine((value) => value.trim().length > 0, "GROWTH_FRAGMENT_INVALID");
const settingDocument = z.object({
  localId, ownerRef: localRef, kind: z.literal("setting"),
  title: z.string().trim().min(1).max(500), content: documentContent,
}).strict().superRefine((value, ctx) => {
  if (value.content.trim().length < 200) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_WORLD_SETTING_MIN_LENGTH" });
});
const otherDocument = z.object({
  localId, ownerRef: localRef, kind: z.enum(["location_profile", "faction_profile", "knowledge_note"]),
  title: z.string().trim().min(1).max(500), content: documentContent,
}).strict();

export const growthWorldFragmentSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  world: z.object({ localId, title: z.string().trim().min(1).max(500) }).strict(),
  entities: z.array(z.object({
    localId, kind: z.enum(["location", "faction"]), title: z.string().trim().min(1).max(500), parentRef: localRef.optional(),
    scaleRole, macroRegionRef: localRef.optional(), sourceDocumentRefs,
  }).strict()).min(12).max(100),
  documents: z.array(z.discriminatedUnion("kind", [settingDocument, otherDocument])).min(1).max(100),
  assertions: z.array(z.object({
    localId, scopeRef: localRef, subject: z.string().trim().min(1).max(500), predicate: z.string().trim().min(1).max(240),
    object: z.record(z.string().min(1).max(240), z.json()), sourceDocumentRefs,
  }).strict()).min(3).max(200),
  eras: z.array(z.object({
    localId, title: z.string().trim().min(1).max(500), summary: z.string().trim().min(1).max(2_000), sourceDocumentRefs,
  }).strict()).min(4).max(20),
  historicalTurningPoints: z.array(z.object({
    localId, title: z.string().trim().min(1).max(500), summary: z.string().trim().min(1).max(2_000), sourceDocumentRefs,
  }).strict()).min(3).max(50),
  causalMechanisms: z.array(z.object({
    localId, causeAssertionRef: localRef, effectAssertionRef: localRef,
    systemRefs: z.array(systemRef).min(2).max(10),
    relationKind: z.enum(["causes", "enables", "constrains", "prevents", "amplifies", "mitigates", "depends_on"]),
    mechanism: z.string().trim().min(1).max(2_000), conditions: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
    temporalScope: z.string().trim().min(1).max(1_000), polarityStrengthSummary: z.string().trim().min(1).max(1_000),
    epistemicStatus: z.enum(["confirmed", "disputed", "inferred"]), sourceDocumentRefs,
  }).strict()).min(4).max(100),
  relations: z.array(z.object({ localId, sourceRef: localRef, targetRef: localRef }).strict()).max(200),
}).strict().superRefine((value, ctx) => {
  const ids = [value.world.localId, ...value.entities.map((item) => item.localId), ...value.documents.map((item) => item.localId), ...value.assertions.map((item) => item.localId), ...value.eras.map((item) => item.localId), ...value.historicalTurningPoints.map((item) => item.localId), ...value.causalMechanisms.map((item) => item.localId), ...value.relations.map((item) => item.localId)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_DUPLICATE_LOCAL_ID" });
  const resources = new Set([value.world.localId, ...value.entities.map((item) => item.localId)]);
  const resourceKinds = new Map<string, "world" | "location" | "faction">([[value.world.localId, "world"], ...value.entities.map((item) => [item.localId, item.kind] as const)]);
  const documents = new Set(value.documents.map((item) => item.localId));
  const assertions = new Set(value.assertions.map((item) => item.localId));
  const macroRegions = new Set(value.entities.filter((item) => item.scaleRole === "macro_region").map((item) => item.localId));
  for (const entity of value.entities) {
    if (entity.parentRef && !resources.has(entity.parentRef)) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_REFERENCE_INVALID" });
    const parentKind = resourceKinds.get(entity.parentRef ?? value.world.localId);
    if (parentKind && ((entity.kind === "location" && !["world", "location"].includes(parentKind)) || (entity.kind === "faction" && !["world", "faction"].includes(parentKind)))) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_PARENT_KIND_INVALID" });
    const locationRole = !["polity", "civilization_group"].includes(entity.scaleRole);
    if ((entity.kind === "location") !== locationRole) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_SCALE_ROLE_INVALID" });
    const requiresRegion = entity.scaleRole === "polity" || entity.scaleRole === "civilization_group";
    if (requiresRegion !== (entity.macroRegionRef !== undefined) || (entity.macroRegionRef && !macroRegions.has(entity.macroRegionRef))) {
      ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_SCALE_REGION_INVALID" });
    }
    if (entity.sourceDocumentRefs.some((ref) => !documents.has(ref))) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_REFERENCE_INVALID" });
  }
  for (const document of value.documents) if (!resources.has(document.ownerRef)) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_REFERENCE_INVALID" });
  if (!value.documents.some((item) => item.ownerRef === value.world.localId && item.kind === "setting")) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_WORLD_SETTING_REQUIRED" });
  for (const assertion of value.assertions) {
    if (!resources.has(assertion.scopeRef) || assertion.sourceDocumentRefs.some((ref) => !documents.has(ref))) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_REFERENCE_INVALID" });
  }
  for (const item of [...value.eras, ...value.historicalTurningPoints]) {
    if (item.sourceDocumentRefs.some((ref) => !documents.has(ref))) ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_REFERENCE_INVALID" });
  }
  for (const mechanism of value.causalMechanisms) {
    if (!assertions.has(mechanism.causeAssertionRef) || !assertions.has(mechanism.effectAssertionRef)
      || mechanism.causeAssertionRef === mechanism.effectAssertionRef
      || new Set(mechanism.systemRefs).size !== mechanism.systemRefs.length
      || mechanism.sourceDocumentRefs.some((ref) => !documents.has(ref))) {
      ctx.addIssue({ code: "custom", message: "GROWTH_FRAGMENT_CAUSAL_MECHANISM_INVALID" });
    }
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
  | "GROWTH_FRAGMENT_WORLD_SETTING_MIN_LENGTH"
  | "GROWTH_FRAGMENT_SCALE_ROLE_INVALID"
  | "GROWTH_FRAGMENT_SCALE_REGION_INVALID"
  | "GROWTH_FRAGMENT_CAUSAL_MECHANISM_INVALID"
  | "GROWTH_FRAGMENT_RELATION_INVALID";

const localIdParameter = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" });
const sourceDocumentRefsParameter = Type.Array(localIdParameter, { minItems: 1, maxItems: 20, uniqueItems: true });
const scaleRoleParameter = Type.Union([
  Type.Literal("macro_region"), Type.Literal("mountain_system"), Type.Literal("sea"), Type.Literal("river"),
  Type.Literal("transport_network"), Type.Literal("resource_distribution"), Type.Literal("polity"), Type.Literal("civilization_group"),
]);
const systemRefParameter = Type.Union(WORLD_SCALE_SYSTEMS.map((system) => Type.Literal(system)));

export const growthWorldFragmentParameters = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  world: Type.Object({ localId: localIdParameter, title: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
  entities: Type.Array(Type.Object({ localId: localIdParameter, kind: Type.Union([Type.Literal("location"), Type.Literal("faction")]), title: Type.String({ minLength: 1, maxLength: 500 }), parentRef: Type.Optional(localIdParameter), scaleRole: scaleRoleParameter, macroRegionRef: Type.Optional(localIdParameter), sourceDocumentRefs: sourceDocumentRefsParameter }, { additionalProperties: false }), { minItems: 12, maxItems: 100 }),
  documents: Type.Array(Type.Union([
    Type.Object({ localId: localIdParameter, ownerRef: localIdParameter, kind: Type.Literal("setting"), title: Type.String({ minLength: 1, maxLength: 500 }), content: Type.String({ minLength: 200, maxLength: 80000 }) }, { additionalProperties: false }),
    Type.Object({ localId: localIdParameter, ownerRef: localIdParameter, kind: Type.Union([Type.Literal("location_profile"), Type.Literal("faction_profile"), Type.Literal("knowledge_note")]), title: Type.String({ minLength: 1, maxLength: 500 }), content: Type.String({ minLength: 1, maxLength: 80000 }) }, { additionalProperties: false }),
  ]), { minItems: 1, maxItems: 100 }),
  assertions: Type.Array(Type.Object({ localId: localIdParameter, scopeRef: localIdParameter, subject: Type.String({ minLength: 1, maxLength: 500 }), predicate: Type.String({ minLength: 1, maxLength: 240 }), object: Type.Object({}, { additionalProperties: true }), sourceDocumentRefs: sourceDocumentRefsParameter }, { additionalProperties: false }), { minItems: 3, maxItems: 200 }),
  eras: Type.Array(Type.Object({ localId: localIdParameter, title: Type.String({ minLength: 1, maxLength: 500 }), summary: Type.String({ minLength: 1, maxLength: 2000 }), sourceDocumentRefs: sourceDocumentRefsParameter }, { additionalProperties: false }), { minItems: 4, maxItems: 20 }),
  historicalTurningPoints: Type.Array(Type.Object({ localId: localIdParameter, title: Type.String({ minLength: 1, maxLength: 500 }), summary: Type.String({ minLength: 1, maxLength: 2000 }), sourceDocumentRefs: sourceDocumentRefsParameter }, { additionalProperties: false }), { minItems: 3, maxItems: 50 }),
  causalMechanisms: Type.Array(Type.Object({ localId: localIdParameter, causeAssertionRef: localIdParameter, effectAssertionRef: localIdParameter, systemRefs: Type.Array(systemRefParameter, { minItems: 2, maxItems: 10, uniqueItems: true }), relationKind: Type.Union([Type.Literal("causes"), Type.Literal("enables"), Type.Literal("constrains"), Type.Literal("prevents"), Type.Literal("amplifies"), Type.Literal("mitigates"), Type.Literal("depends_on")]), mechanism: Type.String({ minLength: 1, maxLength: 2000 }), conditions: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 20, uniqueItems: true }), temporalScope: Type.String({ minLength: 1, maxLength: 1000 }), polarityStrengthSummary: Type.String({ minLength: 1, maxLength: 1000 }), epistemicStatus: Type.Union([Type.Literal("confirmed"), Type.Literal("disputed"), Type.Literal("inferred")]), sourceDocumentRefs: sourceDocumentRefsParameter }, { additionalProperties: false }), { minItems: 4, maxItems: 100 }),
  relations: Type.Array(Type.Object({ localId: localIdParameter, sourceRef: localIdParameter, targetRef: localIdParameter }, { additionalProperties: false }), { maxItems: 200 }),
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
      "GROWTH_FRAGMENT_WORLD_SETTING_MIN_LENGTH",
      "GROWTH_FRAGMENT_SCALE_ROLE_INVALID",
      "GROWTH_FRAGMENT_SCALE_REGION_INVALID",
      "GROWTH_FRAGMENT_CAUSAL_MECHANISM_INVALID",
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
  const assertionItems = new Map<string, { assertionId: string; itemId: string }>();
  for (const assertion of fragment.assertions) {
    const scope = resources.get(assertion.scopeRef)!;
    const sources = assertion.sourceDocumentRefs.map((ref) => documents.get(ref)!);
    const itemId = `${prefix}-assertion-item-${assertion.localId}`;
    const assertionId = `${prefix}-assertion-${assertion.localId}`;
    assertionItems.set(assertion.localId, { assertionId, itemId });
    items.push({ id: itemId, dependsOn: [scope.itemId, ...sources.map((source) => source.documentItemId)], kind: "assertion.put", payload: { assertionId, scopeType: "world", scopeId: scope.resourceId, subject: assertion.subject, predicate: assertion.predicate, object: assertion.object, evidenceIds: sources.map((source) => `greenfield_document_output:${source.documentItemId}`) } });
  }
  const world = resources.get(fragment.world.localId)!;
  for (const entity of fragment.entities) {
    const target = resources.get(entity.localId)!;
    addScaleAssertion({
      suffix: `entity-role-${entity.localId}`,
      subject: target.resourceId,
      predicate: "closure.world.scale.entity_role",
      object: {
        role: entity.scaleRole,
        ...(entity.macroRegionRef ? { macroRegionId: resources.get(entity.macroRegionRef)!.resourceId } : {}),
      },
      sourceRefs: entity.sourceDocumentRefs,
      dependencies: [target.itemId],
    });
  }
  for (const era of fragment.eras) addScaleAssertion({
    suffix: `era-${era.localId}`, subject: world.resourceId, predicate: "closure.world.scale.era",
    object: { title: era.title, summary: era.summary }, sourceRefs: era.sourceDocumentRefs, dependencies: [world.itemId],
  });
  for (const turningPoint of fragment.historicalTurningPoints) addScaleAssertion({
    suffix: `turning-point-${turningPoint.localId}`, subject: world.resourceId, predicate: "closure.world.scale.historical_turning_point",
    object: { title: turningPoint.title, summary: turningPoint.summary }, sourceRefs: turningPoint.sourceDocumentRefs, dependencies: [world.itemId],
  });
  for (const mechanism of fragment.causalMechanisms) {
    const cause = assertionItems.get(mechanism.causeAssertionRef)!;
    const effect = assertionItems.get(mechanism.effectAssertionRef)!;
    const sources = mechanism.sourceDocumentRefs.map((ref) => ({ ref, document: documents.get(ref)! }));
    items.push({
      id: `${prefix}-causal-item-${mechanism.localId}`,
      dependsOn: [cause.itemId, effect.itemId, ...sources.map((source) => source.document.documentItemId)],
      kind: "causal_relation.put",
      payload: {
        relationId: `${prefix}-causal-${mechanism.localId}`,
        relationKind: mechanism.relationKind,
        causeAssertionId: cause.assertionId,
        causeAssertionItemId: cause.itemId,
        effectAssertionId: effect.assertionId,
        effectAssertionItemId: effect.itemId,
        mechanism: mechanism.mechanism,
        conditions: mechanism.conditions,
        temporalScope: mechanism.temporalScope,
        polarityStrengthSummary: mechanism.polarityStrengthSummary,
        epistemicStatus: mechanism.epistemicStatus,
        sourceBindings: sources.map((source) => ({
          evidenceId: `greenfield_document_output:${source.document.documentItemId}`,
          stableLocator: `growth-world-fragment:${source.ref}`,
        })),
      },
    });
  }
  for (const relation of fragment.relations) { const source = resources.get(relation.sourceRef)!; const target = resources.get(relation.targetRef)!; items.push({ id: `${prefix}-relation-item-${relation.localId}`, dependsOn: [source.itemId, target.itemId], kind: "creative_relation.put", payload: { relationId: `${prefix}-relation-${relation.localId}`, create: true, relationKind: "related_to", sourceResourceId: source.resourceId, targetResourceId: target.resourceId, state: "active" } }); }
  return proposeChangeSetArgsSchema.parse({ summary: fragment.summary, items });

  function addScaleAssertion(input: {
    suffix: string;
    subject: string;
    predicate: string;
    object: Record<string, string>;
    sourceRefs: string[];
    dependencies: string[];
  }): void {
    const sources = input.sourceRefs.map((ref) => documents.get(ref)!);
    items.push({
      id: `${prefix}-scale-assertion-item-${input.suffix}`,
      dependsOn: [...new Set([world.itemId, ...input.dependencies, ...sources.map((source) => source.documentItemId)])],
      kind: "assertion.put",
      payload: {
        assertionId: `${prefix}-scale-assertion-${input.suffix}`,
        scopeType: "world",
        scopeId: world.resourceId,
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        evidenceIds: sources.map((source) => `greenfield_document_output:${source.documentItemId}`),
      },
    });
  }
}

export function projectGrowthWorldFragmentScale(fragment: GrowthWorldFragment): WorldScaleClosureProjection {
  return {
    worldRefs: [fragment.world.localId],
    entityRoles: fragment.entities.map((entity) => ({
      entityRef: entity.localId,
      role: entity.scaleRole as WorldScaleEntityRole,
      macroRegionRef: entity.macroRegionRef ?? null,
      evidenceRefs: entity.sourceDocumentRefs,
    })),
    eras: fragment.eras.map((item) => ({ ref: item.localId, evidenceRefs: item.sourceDocumentRefs })),
    historicalTurningPoints: fragment.historicalTurningPoints.map((item) => ({ ref: item.localId, evidenceRefs: item.sourceDocumentRefs })),
    causalMechanisms: fragment.causalMechanisms.map((item) => ({ ref: item.localId, systemRefs: item.systemRefs, evidenceRefs: item.sourceDocumentRefs })),
  };
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fragmentError(code: GrowthWorldFragmentErrorCode): Error & { code: GrowthWorldFragmentErrorCode } {
  return Object.assign(new Error("Growth world Fragment is invalid."), { code });
}
