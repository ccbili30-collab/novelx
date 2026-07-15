import { describe, expect, it } from "vitest";
import {
  compileGrowthWorldMapBrief,
  deriveGrowthWorldMapSources,
  growthWorldMapBriefParameters,
  growthWorldMapBriefSchema,
} from "../../src/agent-worker/growth/growthWorldMapBrief";
import { compileGrowthWorldFragment } from "../../src/agent-worker/growth/growthWorldFragment";

const worldFragment = {
  summary: "Create a tidal world.",
  world: { localId: "world", title: "Tidal World" },
  entities: [{ localId: "harbor", kind: "location" as const, title: "Harbor" }, { localId: "guild", kind: "faction" as const, title: "Guild" }],
  documents: [{ localId: "setting", ownerRef: "world", kind: "setting" as const, title: "Setting", content: "A stable world setting with tides, history, geography, rules, and cultural consequences. Mariners preserve the causal history in public records, map safe routes across changing coasts, and teach each generation why the rule remains binding when new conflicts emerge." }],
  assertions: [
    { localId: "fact", scopeRef: "world", subject: "Tide", predicate: "governs", object: { realm: "world" }, sourceDocumentRefs: ["setting"] },
    { localId: "record", scopeRef: "world", subject: "Mariners", predicate: "preserve", object: { target: "causal history" }, sourceDocumentRefs: ["setting"] },
    { localId: "route", scopeRef: "world", subject: "Maps", predicate: "show", object: { target: "safe routes" }, sourceDocumentRefs: ["setting"] },
  ],
  relations: [],
};

describe("Growth World Map Brief compiler", () => {
  it("exposes only creative fields and deterministically binds same-Change-Set world outputs", () => {
    const proposal = compileGrowthWorldFragment(worldFragment, { cycleId: "cycle-world", worldRootResourceId: "world-root" });
    const resource = proposal.items.find((item) => item.kind === "resource.put" && item.payload.objectKind === "world")!;
    const settingCreative = proposal.items.find((item) => item.kind === "creative_document.put" && item.payload.kind === "setting")!;
    const settingDocument = proposal.items.find((item) => item.kind === "document.put" && item.payload.creativeDocumentId === (settingCreative.payload as { documentId: string }).documentId)!;
    const sources = deriveGrowthWorldMapSources(proposal, {
      changeSetId: "change-world", mode: "free", status: "committed", gateStatus: "ready", blockedReason: null,
      itemCount: proposal.items.length,
      committedOutputs: [
        { itemId: resource.id, kind: "resource_revision", outputId: "world-revision" },
        { itemId: settingDocument.id, kind: "document_version", outputId: "setting-version" },
      ],
    });
    const compiled = compileGrowthWorldMapBrief({ title: "Tidal World Map", prompt: "A source-bound nautical world map." }, { cycleId: "cycle-world", sources });
    expect(compiled).toEqual(compileGrowthWorldMapBrief({ title: "Tidal World Map", prompt: "A source-bound nautical world map." }, { cycleId: "cycle-world", sources }));
    expect(compiled).toMatchObject({ purpose: "world_map", sourceResourceIds: [(resource.payload as { resourceId: string }).resourceId], sourceVersionIds: ["world-revision", "setting-version"] });
    const visible = JSON.stringify(growthWorldMapBriefParameters);
    for (const forbidden of ["purpose", "idempotencyKey", "resourceId", "versionId", "provider", "path", "sha256"]) expect(visible).not.toContain(forbidden);
  });

  it("rejects low-level input and incomplete or ambiguous committed-output mappings before Provider use", () => {
    expect(growthWorldMapBriefSchema.safeParse({ title: "Map", prompt: "Source-bound map", resourceId: "forged" }).success).toBe(false);
    const proposal = compileGrowthWorldFragment(worldFragment, { cycleId: "cycle-world", worldRootResourceId: "world-root" });
    expectCode(() => deriveGrowthWorldMapSources(proposal, {
      changeSetId: "change-world", mode: "free", status: "committed", gateStatus: "ready", blockedReason: null, itemCount: proposal.items.length, committedOutputs: [],
    }), "GROWTH_WORLD_MAP_SOURCE_INVALID");
    const resource = proposal.items.find((item) => item.kind === "resource.put" && item.payload.objectKind === "world")!;
    const settingCreative = proposal.items.find((item) => item.kind === "creative_document.put" && item.payload.kind === "setting")!;
    const settingDocument = proposal.items.find((item) => item.kind === "document.put" && item.payload.creativeDocumentId === (settingCreative.payload as { documentId: string }).documentId)!;
    expectCode(() => deriveGrowthWorldMapSources(proposal, {
      changeSetId: "change-world", mode: "free", status: "committed", gateStatus: "ready", blockedReason: null, itemCount: proposal.items.length,
      committedOutputs: [
        { itemId: resource.id, kind: "resource_revision", outputId: "world-revision-a" },
        { itemId: resource.id, kind: "resource_revision", outputId: "world-revision-b" },
        { itemId: settingDocument.id, kind: "document_version", outputId: "setting-version" },
      ],
    }), "GROWTH_WORLD_MAP_SOURCE_INVALID");
    expectCode(() => compileGrowthWorldMapBrief({ title: "Map", prompt: "Source-bound map" }, {
      cycleId: "cycle-world", sources: { worldResourceId: "", sourceVersionIds: [] },
    }), "GROWTH_WORLD_MAP_SOURCE_INVALID");
    expectCode(() => compileGrowthWorldMapBrief({ title: "Map", prompt: "Source-bound map" }, {
      cycleId: "cycle-world", sources: { worldResourceId: "world-id", sourceVersionIds: ["world-revision", "setting-version", "forged-third-version"] },
    }), "GROWTH_WORLD_MAP_SOURCE_INVALID");
  });
});

function expectCode(action: () => void, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error("Expected a Growth World Map Brief compiler error.");
}
