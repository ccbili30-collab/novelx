import { describe, expect, it } from "vitest";
import {
  assertCreativeObjectPlacement,
  domainForObjectKind,
  type CreativeObjectDescriptor,
} from "../../src/domain/workspace/creativeObjectPolicy";

const root = (domain: CreativeObjectDescriptor["domain"]): CreativeObjectDescriptor => ({
  id: `${domain}-root`,
  domain,
  kind: "domain_root",
  parentId: null,
});

describe("creative object placement policy", () => {
  it("maps object kinds to their visible domains", () => {
    expect(domainForObjectKind("world")).toBe("world");
    expect(domainForObjectKind("location")).toBe("world");
    expect(domainForObjectKind("faction")).toBe("world");
    expect(domainForObjectKind("oc")).toBe("oc");
    expect(domainForObjectKind("story")).toBe("story");
    expect(domainForObjectKind("volume")).toBe("story");
    expect(domainForObjectKind("chapter")).toBe("story");
    expect(domainForObjectKind("oc_variant")).toBe("story");
  });

  it("accepts the supported ownership hierarchy", () => {
    const world: CreativeObjectDescriptor = { id: "world-1", domain: "world", kind: "world", parentId: "world-root" };
    const story: CreativeObjectDescriptor = { id: "story-1", domain: "story", kind: "story", parentId: "story-root" };
    const volume: CreativeObjectDescriptor = { id: "volume-1", domain: "story", kind: "volume", parentId: story.id };
    const objects = [root("world"), root("story"), world, story, volume];

    expect(() => assertCreativeObjectPlacement(world, objects)).not.toThrow();
    expect(() => assertCreativeObjectPlacement(
      { id: "location-1", domain: "world", kind: "location", parentId: world.id },
      objects,
    )).not.toThrow();
    expect(() => assertCreativeObjectPlacement(
      { id: "faction-1", domain: "world", kind: "faction", parentId: world.id },
      objects,
    )).not.toThrow();
    expect(() => assertCreativeObjectPlacement(volume, objects)).not.toThrow();
    expect(() => assertCreativeObjectPlacement(
      { id: "chapter-1", domain: "story", kind: "chapter", parentId: volume.id },
      objects,
    )).not.toThrow();
    expect(() => assertCreativeObjectPlacement(
      { id: "variant-1", domain: "story", kind: "oc_variant", parentId: story.id },
      objects,
    )).not.toThrow();
  });

  it("rejects domain mismatch, illegal ownership, and cycles", () => {
    const story: CreativeObjectDescriptor = { id: "story-1", domain: "story", kind: "story", parentId: "story-root" };
    const volume: CreativeObjectDescriptor = { id: "volume-1", domain: "story", kind: "volume", parentId: story.id };
    const chapter: CreativeObjectDescriptor = { id: "chapter-1", domain: "story", kind: "chapter", parentId: volume.id };
    const world: CreativeObjectDescriptor = { id: "world-1", domain: "world", kind: "world", parentId: "world-root" };
    const region: CreativeObjectDescriptor = { id: "region-1", domain: "world", kind: "location", parentId: world.id };
    const city: CreativeObjectDescriptor = { id: "city-1", domain: "world", kind: "location", parentId: region.id };
    const objects = [root("world"), root("story"), story, volume, chapter, world, region, city];

    expect(() => assertCreativeObjectPlacement(
      { id: "wrong-domain", domain: "oc", kind: "location", parentId: "world-root" },
      objects,
    )).toThrowError(expect.objectContaining({ code: "RESOURCE_DOMAIN_KIND_MISMATCH" }));
    expect(() => assertCreativeObjectPlacement(
      { id: "bad-parent", domain: "story", kind: "chapter", parentId: "world-root" },
      objects,
    )).toThrowError(expect.objectContaining({ code: "RESOURCE_PARENT_KIND_INVALID" }));
    expect(() => assertCreativeObjectPlacement(
      { ...region, parentId: city.id },
      objects,
    )).toThrowError(expect.objectContaining({ code: "RESOURCE_OWNERSHIP_CYCLE" }));
  });
});
