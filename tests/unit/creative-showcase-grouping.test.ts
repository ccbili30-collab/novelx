import { describe, expect, it } from "vitest";
import type { CreativeShowcaseSnapshot, WorkspaceSnapshot } from "../../src/shared/ipcContract";

const showcaseModulePath = "../../src/renderer/src/features/showcase/CreativeShowcase";

describe("CreativeShowcase image sections", () => {
  it("partitions maps, world scenery, story scenes, portraits, and details from real source identities", async () => {
    const { groupShowcaseImages } = await import(showcaseModulePath);
    const workspace = {
      resources: [
        { id: "world-1", type: "world", objectKind: "world" },
        { id: "story-1", type: "story", objectKind: "story" },
        { id: "oc-1", type: "oc", objectKind: "oc" },
      ],
    } as WorkspaceSnapshot;
    const images = [
      { assetId: "map", purpose: "world_map", sourceResourceIds: ["world-1"] },
      { assetId: "world", purpose: "scene", sourceResourceIds: ["world-1"] },
      { assetId: "story", purpose: "scene", sourceResourceIds: ["story-1"] },
      { assetId: "oc", purpose: "character_portrait", sourceResourceIds: ["oc-1"] },
      { assetId: "detail", purpose: "scene", sourceResourceIds: ["unknown"] },
    ] as CreativeShowcaseSnapshot["images"];

    expect(groupShowcaseImages(images, workspace).map((section: { label: string; images: Array<{ assetId: string }> }) => ({
      label: section.label, ids: section.images.map((image) => image.assetId),
    }))).toEqual([
      { label: "世界地图", ids: ["map"] },
      { label: "世界风貌", ids: ["world"] },
      { label: "故事场景", ids: ["story"] },
      { label: "OC 卡与立绘", ids: ["oc"] },
      { label: "重要细节", ids: ["detail"] },
    ]);
  });
});
