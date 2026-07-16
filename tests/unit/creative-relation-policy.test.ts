import { describe, expect, it } from "vitest";
import { assertCreativeRelationAllowed } from "../../src/domain/workspace/creativeRelationPolicy";
import type { CreativeObjectKind } from "../../src/domain/workspace/creativeObjectPolicy";
import type { ResourceType } from "../../src/domain/workspace/resourceRepository";

const world = endpoint("world", "world", "world");
const oc = endpoint("oc", "oc", "oc");
const story = endpoint("story", "story", "story");
const volume = endpoint("volume", "story", "volume");
const chapter = endpoint("chapter", "story", "chapter");

describe("creative relation policy", () => {
  it("treats story and volume as narrative containers for world and OC bindings", () => {
    expect(() => assertCreativeRelationAllowed({ kind: "uses_world", source: story, target: world })).not.toThrow();
    expect(() => assertCreativeRelationAllowed({ kind: "uses_world", source: volume, target: world })).not.toThrow();
    expect(() => assertCreativeRelationAllowed({ kind: "uses_oc", source: story, target: oc })).not.toThrow();
    expect(() => assertCreativeRelationAllowed({ kind: "uses_oc", source: volume, target: oc })).not.toThrow();
  });

  it("does not silently extend narrative bindings to chapters or unrelated resource types", () => {
    expect(() => assertCreativeRelationAllowed({ kind: "uses_world", source: chapter, target: world }))
      .toThrow(expect.objectContaining({ code: "RELATION_SOURCE_KIND_INVALID" }));
    expect(() => assertCreativeRelationAllowed({ kind: "uses_oc", source: oc, target: oc }))
      .toThrow(expect.objectContaining({ code: "RELATION_SELF_REFERENCE" }));
    expect(() => assertCreativeRelationAllowed({ kind: "uses_oc", source: world, target: oc }))
      .toThrow(expect.objectContaining({ code: "RELATION_SOURCE_KIND_INVALID" }));
  });

  it("keeps target and OC-variant endpoint rules fail-closed", () => {
    expect(() => assertCreativeRelationAllowed({ kind: "uses_world", source: volume, target: oc }))
      .toThrow(expect.objectContaining({ code: "RELATION_TARGET_KIND_INVALID" }));
    expect(() => assertCreativeRelationAllowed({
      kind: "variant_of",
      source: endpoint("variant", "story", "oc_variant"),
      target: oc,
    })).not.toThrow();
  });
});

function endpoint(id: string, type: ResourceType, objectKind: CreativeObjectKind) {
  return { id, type, objectKind };
}
