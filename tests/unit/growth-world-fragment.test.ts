import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { compileGrowthWorldFragment, growthWorldFragmentParameters, growthWorldFragmentSchema, projectGrowthWorldFragmentScale } from "../../src/agent-worker/growth/growthWorldFragment";
import { evaluateWorldScaleClosure } from "../../src/domain/growth/closure/worldScaleClosureProfile";

const settingContent = "The tide governs the harbor, its history, its geography, its rules, and the cultural consequences carried by every voyage. Mariners record the changes in public ledgers, families plan their work by the moon, and the guild preserves warnings so the world remains coherent across seasons and stories.";

const scaleEntities = [
  { localId: "north", kind: "location", title: "North", scaleRole: "macro_region", sourceDocumentRefs: ["setting"] },
  { localId: "south", kind: "location", title: "South", scaleRole: "macro_region", sourceDocumentRefs: ["setting"] },
  { localId: "isles", kind: "location", title: "Isles", scaleRole: "macro_region", sourceDocumentRefs: ["setting"] },
  { localId: "mountains", kind: "location", title: "Mountains", scaleRole: "mountain_system", sourceDocumentRefs: ["setting"] },
  { localId: "sea", kind: "location", title: "Sea", scaleRole: "sea", sourceDocumentRefs: ["setting"] },
  { localId: "river", kind: "location", title: "River", scaleRole: "river", sourceDocumentRefs: ["setting"] },
  { localId: "road", kind: "location", title: "Road", scaleRole: "transport_network", sourceDocumentRefs: ["setting"] },
  { localId: "ore", kind: "location", title: "Ore Belt", scaleRole: "resource_distribution", sourceDocumentRefs: ["setting"] },
  { localId: "north_crown", kind: "faction", title: "North Crown", scaleRole: "polity", macroRegionRef: "north", sourceDocumentRefs: ["setting"] },
  { localId: "north_clans", kind: "faction", title: "North Clans", scaleRole: "civilization_group", macroRegionRef: "north", sourceDocumentRefs: ["setting"] },
  { localId: "south_league", kind: "faction", title: "South League", scaleRole: "polity", macroRegionRef: "south", sourceDocumentRefs: ["setting"] },
  { localId: "isle_people", kind: "faction", title: "Isle People", scaleRole: "civilization_group", macroRegionRef: "isles", sourceDocumentRefs: ["setting"] },
] as const;

const eras = ["dawn", "sail", "crown", "present"].map((localId) => ({ localId, title: localId, summary: `${localId} era`, sourceDocumentRefs: ["setting"] }));
const historicalTurningPoints = ["flood", "war", "treaty"].map((localId) => ({ localId, title: localId, summary: `${localId} changed the world`, sourceDocumentRefs: ["setting"] }));
const causalMechanisms = ["tide_trade", "trade_guild", "moon_work", "ledger_power"].map((localId, index) => ({
  localId, causeAssertionRef: ["tide", "ledger", "moon", "ledger"][index], effectAssertionRef: ["ledger", "moon", "tide", "tide"][index],
  systemRefs: index % 2 === 0 ? ["geography", "economy"] : ["culture", "polity"], relationKind: "causes",
  mechanism: `${localId} mechanism`, conditions: ["setting conditions"], temporalScope: "all eras",
  polarityStrengthSummary: "positive, bounded strength", epistemicStatus: "confirmed", sourceDocumentRefs: ["setting"],
}));

const fragment = {
  summary: "Create a source-bound world.",
  world: { localId: "world", title: "Tide World" },
  entities: scaleEntities,
  documents: [{ localId: "setting", ownerRef: "world", kind: "setting", title: "Setting", content: settingContent }],
  assertions: [
    { localId: "tide", scopeRef: "world", subject: "tide", predicate: "governs", object: { target: "harbor", wording: "  model bytes stay exact  " }, sourceDocumentRefs: ["setting"] },
    { localId: "ledger", scopeRef: "world", subject: "mariners", predicate: "record", object: { target: "public ledgers" }, sourceDocumentRefs: ["setting"] },
    { localId: "moon", scopeRef: "world", subject: "families", predicate: "plan_by", object: { target: "moon" }, sourceDocumentRefs: ["setting"] },
  ],
  eras,
  historicalTurningPoints,
  causalMechanisms,
  relations: [{ localId: "world-north", sourceRef: "world", targetRef: "north" }],
};

describe("Growth world Fragment compiler", () => {
  it("requires the twelve-node default scale skeleton in both model contracts", () => {
    expect(growthWorldFragmentSchema.safeParse({ ...fragment, entities: [] }).success).toBe(false);
    expect(growthWorldFragmentSchema.safeParse({ ...fragment, entities: [fragment.entities[0]] }).success).toBe(false);
    expect(growthWorldFragmentSchema.safeParse(fragment).success).toBe(true);
    expect((growthWorldFragmentParameters.properties.entities as { minItems?: number }).minItems).toBe(12);
  });

  it("requires at least three model-supplied source-bound assertions in both model contracts", () => {
    for (const assertionCount of [0, 1, 2]) {
      const candidate = { ...fragment, assertions: fragment.assertions.slice(0, assertionCount), causalMechanisms: [] };
      expect(growthWorldFragmentSchema.safeParse(candidate).success).toBe(false);
      expect(Value.Check(growthWorldFragmentParameters, candidate)).toBe(false);
      expectFragmentCode(() => compileGrowthWorldFragment(candidate, {
        cycleId: `cycle-assertions-${assertionCount}`,
        worldRootResourceId: "world-root",
      }), "GROWTH_FRAGMENT_INVALID");
    }
    expect(growthWorldFragmentSchema.safeParse(fragment).success).toBe(true);
    expect(Value.Check(growthWorldFragmentParameters, fragment)).toBe(true);
    expect((growthWorldFragmentParameters.properties.assertions as { minItems?: number }).minItems).toBe(3);
  });

  it("requires 200 trimmed setting characters while preserving accepted model bytes", () => {
    expect(growthWorldFragmentSchema.safeParse({ ...fragment, documents: [{ ...fragment.documents[0], content: "x".repeat(199) }] }).success).toBe(false);
    expect(growthWorldFragmentSchema.safeParse({ ...fragment, documents: [{ ...fragment.documents[0], content: `${" ".repeat(100)}${"x".repeat(199)}` }] }).success).toBe(false);
    const exact = "x".repeat(200);
    const compiled = compileGrowthWorldFragment({ ...fragment, documents: [{ ...fragment.documents[0], content: exact }] }, { cycleId: "cycle-setting-minimum", worldRootResourceId: "world-root" });
    expect(compiled.items.find((item) => item.kind === "document.put")).toMatchObject({ payload: { content: exact } });
    expect(JSON.stringify(growthWorldFragmentParameters)).toContain('"minLength":200');
    expect(growthWorldFragmentSchema.safeParse({ ...fragment, documents: [{ ...fragment.documents[0], content: " ".repeat(200) }] }).success).toBe(false);
  });

  it("enforces the setting branch with the TypeBox value validator", () => {
    const shortSetting = { ...fragment, documents: [{ ...fragment.documents[0], content: "x".repeat(199) }] };
    const exactSetting = { ...fragment, documents: [{ ...fragment.documents[0], content: "x".repeat(200) }] };
    const shortKnowledge = { ...fragment, documents: [{ ...fragment.documents[0], localId: "note", kind: "knowledge_note", title: "Note", content: "brief" }], assertions: fragment.assertions.map((assertion) => ({ ...assertion, sourceDocumentRefs: ["note"] })) };
    expect(Value.Check(growthWorldFragmentParameters, shortSetting)).toBe(false);
    expect(Value.Check(growthWorldFragmentParameters, exactSetting)).toBe(true);
    expect(Value.Check(growthWorldFragmentParameters, shortKnowledge)).toBe(true);
  });

  it("rejects duplicate or missing local references without accepting low-level fields", () => {
    expect(growthWorldFragmentSchema.safeParse({ ...fragment, entities: [...fragment.entities, { localId: "world", kind: "location", title: "Duplicate", scaleRole: "river", sourceDocumentRefs: ["setting"] }] }).success).toBe(false);
    expect(growthWorldFragmentSchema.safeParse({ ...fragment, documents: [{ ...fragment.documents[0], ownerRef: "missing" }] }).success).toBe(false);
    expect(growthWorldFragmentSchema.safeParse({ ...fragment, resourceId: "forged" }).success).toBe(false);
  });

  it("deterministically compiles model creative fields into create-only source-bound items", () => {
    const trusted = { cycleId: "cycle-1", worldRootResourceId: "world-root" };
    const first = compileGrowthWorldFragment(fragment, trusted);
    expect(compileGrowthWorldFragment(fragment, trusted)).toEqual(first);
    expect(first.items.every((item) => item.kind !== "project_file.put" && item.kind !== "project_file.delete")).toBe(true);
    const world = first.items.find((item) => item.kind === "resource.put" && item.payload.objectKind === "world");
    expect(world).toMatchObject({ payload: { create: true, state: "active", parentId: "world-root", title: fragment.world.title } });
    const assertions = first.items.filter((item) => item.kind === "assertion.put" && !item.id.includes("-scale-assertion-item-"));
    expect(assertions).toHaveLength(fragment.assertions.length);
    for (const [index, assertion] of assertions.entries()) {
      expect(assertion).toMatchObject({
        payload: {
          subject: fragment.assertions[index]!.subject,
          predicate: fragment.assertions[index]!.predicate,
          object: fragment.assertions[index]!.object,
          evidenceIds: [expect.stringMatching(/^greenfield_document_output:/)],
        },
      });
      expect(JSON.stringify((assertion.payload as { object: unknown }).object)).toBe(JSON.stringify(fragment.assertions[index]!.object));
    }
    expect(first.items.filter((item) => item.kind === "causal_relation.put")).toHaveLength(4);
    expect(evaluateWorldScaleClosure(projectGrowthWorldFragmentScale(growthWorldFragmentSchema.parse(fragment))).ready).toBe(true);
  });

  it("orders nested resources topologically regardless of model input order", () => {
    const outOfOrder = {
      ...fragment,
      entities: [
        { localId: "pier", kind: "location" as const, title: "Pier", parentRef: "north", scaleRole: "transport_network" as const, sourceDocumentRefs: ["setting"] },
        ...scaleEntities,
      ],
    };
    const compiled = compileGrowthWorldFragment(outOfOrder, { cycleId: "cycle-nested", worldRootResourceId: "world-root" });
    const resourceIds = compiled.items.filter((item) => item.kind === "resource.put").map((item) => item.id);
    expect(resourceIds.findIndex((id) => id.endsWith("-north"))).toBeLessThan(resourceIds.findIndex((id) => id.endsWith("-pier")));
    const cyclic = scaleEntities.map((entity) => entity.localId === "north" ? { ...entity, parentRef: "south" } : entity.localId === "south" ? { ...entity, parentRef: "north" } : entity);
    expectFragmentCode(() => compileGrowthWorldFragment({ ...fragment, entities: cyclic, relations: [] }, { cycleId: "cycle-cycle", worldRootResourceId: "world-root" }), "GROWTH_FRAGMENT_REFERENCE_CYCLE");
  });

  it("maps structural failures to fixed codes without raw validation details", () => {
    expectFragmentCode(() => compileGrowthWorldFragment({ ...fragment, entities: [...fragment.entities, { localId: "world", kind: "location", title: "Duplicate", scaleRole: "river", sourceDocumentRefs: ["setting"] }] }, { cycleId: "cycle-duplicate", worldRootResourceId: "world-root" }), "GROWTH_FRAGMENT_DUPLICATE_LOCAL_ID");
    expectFragmentCode(() => compileGrowthWorldFragment({ ...fragment, documents: [{ ...fragment.documents[0], ownerRef: "missing" }] }, { cycleId: "cycle-reference", worldRootResourceId: "world-root" }), "GROWTH_FRAGMENT_REFERENCE_INVALID");
    expectFragmentCode(() => compileGrowthWorldFragment({ ...fragment, entities: scaleEntities.map((entity) => entity.localId === "mountains" ? { ...entity, parentRef: "north_crown" } : entity), relations: [] }, { cycleId: "cycle-cross-a", worldRootResourceId: "world-root" }), "GROWTH_FRAGMENT_PARENT_KIND_INVALID");
    expectFragmentCode(() => compileGrowthWorldFragment({ ...fragment, entities: scaleEntities.map((entity) => entity.localId === "north_crown" ? { ...entity, parentRef: "north" } : entity), relations: [] }, { cycleId: "cycle-cross-b", worldRootResourceId: "world-root" }), "GROWTH_FRAGMENT_PARENT_KIND_INVALID");
  });
});

function expectFragmentCode(action: () => void, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error("Expected a Growth Fragment compiler error.");
}
