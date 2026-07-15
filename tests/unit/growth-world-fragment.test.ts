import { describe, expect, it } from "vitest";
import { compileGrowthWorldFragment, growthWorldFragmentSchema } from "../../src/agent-worker/growth/growthWorldFragment";

const fragment = {
  summary: "Create a source-bound world.",
  world: { localId: "world", title: "Tide World" },
  entities: [{ localId: "harbor", kind: "location", title: "Harbor" }],
  documents: [{ localId: "setting", ownerRef: "world", kind: "setting", title: "Setting", content: "The tide governs the harbor." }],
  assertions: [{ localId: "tide", scopeRef: "world", subject: "tide", predicate: "governs", object: { target: "harbor" }, sourceDocumentRefs: ["setting"] }],
  relations: [{ localId: "world-harbor", sourceRef: "world", targetRef: "harbor" }],
};

describe("Growth world Fragment compiler", () => {
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
