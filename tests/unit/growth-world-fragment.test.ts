import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { compileGrowthWorldFragment, growthWorldFragmentParameters, growthWorldFragmentSchema } from "../../src/agent-worker/growth/growthWorldFragment";

const settingContent = "The tide governs the harbor, its history, its geography, its rules, and the cultural consequences carried by every voyage. Mariners record the changes in public ledgers, families plan their work by the moon, and the guild preserves warnings so the world remains coherent across seasons and stories.";

const fragment = {
  summary: "Create a source-bound world.",
  world: { localId: "world", title: "Tide World" },
  entities: [{ localId: "harbor", kind: "location", title: "Harbor" }, { localId: "guild", kind: "faction", title: "Guild" }],
  documents: [{ localId: "setting", ownerRef: "world", kind: "setting", title: "Setting", content: settingContent }],
  assertions: [{ localId: "tide", scopeRef: "world", subject: "tide", predicate: "governs", object: { target: "harbor" }, sourceDocumentRefs: ["setting"] }],
  relations: [{ localId: "world-harbor", sourceRef: "world", targetRef: "harbor" }],
};

describe("Growth world Fragment compiler", () => {
  it("requires at least two location or faction entities in both model contracts", () => {
    expect(growthWorldFragmentSchema.safeParse({ ...fragment, entities: [] }).success).toBe(false);
    expect(growthWorldFragmentSchema.safeParse({ ...fragment, entities: [fragment.entities[0]] }).success).toBe(false);
    expect(growthWorldFragmentSchema.safeParse(fragment).success).toBe(true);
    expect((growthWorldFragmentParameters.properties.entities as { minItems?: number }).minItems).toBe(2);
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
    const shortKnowledge = { ...fragment, documents: [{ ...fragment.documents[0], localId: "note", kind: "knowledge_note", title: "Note", content: "brief" }], assertions: [{ ...fragment.assertions[0], sourceDocumentRefs: ["note"] }] };
    expect(Value.Check(growthWorldFragmentParameters, shortSetting)).toBe(false);
    expect(Value.Check(growthWorldFragmentParameters, exactSetting)).toBe(true);
    expect(Value.Check(growthWorldFragmentParameters, shortKnowledge)).toBe(true);
  });

  it("rejects duplicate or missing local references without accepting low-level fields", () => {
    expect(growthWorldFragmentSchema.safeParse({ ...fragment, entities: [...fragment.entities, { localId: "world", kind: "location", title: "Duplicate" }] }).success).toBe(false);
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
    const assertion = first.items.find((item) => item.kind === "assertion.put");
    expect(assertion).toMatchObject({ payload: { subject: "tide", predicate: "governs", evidenceIds: [expect.stringMatching(/^greenfield_document_output:/)] } });
  });

  it("orders nested resources topologically regardless of model input order", () => {
    const outOfOrder = {
      ...fragment,
      entities: [
        { localId: "pier", kind: "location" as const, title: "Pier", parentRef: "harbor" },
        { localId: "harbor", kind: "location" as const, title: "Harbor", parentRef: "world" },
      ],
    };
    const compiled = compileGrowthWorldFragment(outOfOrder, { cycleId: "cycle-nested", worldRootResourceId: "world-root" });
    const resourceIds = compiled.items.filter((item) => item.kind === "resource.put").map((item) => item.id);
    expect(resourceIds.findIndex((id) => id.endsWith("-harbor"))).toBeLessThan(resourceIds.findIndex((id) => id.endsWith("-pier")));
    expectFragmentCode(() => compileGrowthWorldFragment({ ...outOfOrder, entities: [
      { localId: "a", kind: "location", title: "A", parentRef: "b" },
      { localId: "b", kind: "location", title: "B", parentRef: "a" },
    ], relations: [] }, { cycleId: "cycle-cycle", worldRootResourceId: "world-root" }), "GROWTH_FRAGMENT_REFERENCE_CYCLE");
  });

  it("maps structural failures to fixed codes without raw validation details", () => {
    expectFragmentCode(() => compileGrowthWorldFragment({ ...fragment, entities: [...fragment.entities, { localId: "world", kind: "location", title: "Duplicate" }] }, { cycleId: "cycle-duplicate", worldRootResourceId: "world-root" }), "GROWTH_FRAGMENT_DUPLICATE_LOCAL_ID");
    expectFragmentCode(() => compileGrowthWorldFragment({ ...fragment, documents: [{ ...fragment.documents[0], ownerRef: "missing" }] }, { cycleId: "cycle-reference", worldRootResourceId: "world-root" }), "GROWTH_FRAGMENT_REFERENCE_INVALID");
    expectFragmentCode(() => compileGrowthWorldFragment({ ...fragment, entities: [{ localId: "faction", kind: "faction", title: "Faction" }, { localId: "location", kind: "location", title: "Location", parentRef: "faction" }], relations: [] }, { cycleId: "cycle-cross-a", worldRootResourceId: "world-root" }), "GROWTH_FRAGMENT_PARENT_KIND_INVALID");
    expectFragmentCode(() => compileGrowthWorldFragment({ ...fragment, entities: [{ localId: "location", kind: "location", title: "Location" }, { localId: "faction", kind: "faction", title: "Faction", parentRef: "location" }], relations: [] }, { cycleId: "cycle-cross-b", worldRootResourceId: "world-root" }), "GROWTH_FRAGMENT_PARENT_KIND_INVALID");
  });
});

function expectFragmentCode(action: () => void, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error("Expected a Growth Fragment compiler error.");
}
