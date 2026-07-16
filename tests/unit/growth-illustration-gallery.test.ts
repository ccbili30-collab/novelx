import { describe, expect, it } from "vitest";
import type { GrowthPresentationSnapshot } from "../../src/shared/growthPresentationContract";

const viewsModulePath = "../../src/renderer/src/features/growth/growthPresentationViews";

function snapshot(): GrowthPresentationSnapshot {
  const now = "2026-07-16T00:00:00.000Z";
  return {
    capabilityVersion: "growth-presentation-v1", goalId: "goal-1", currentRuleRevision: 2,
    activeCycleRuleRevision: 2, guidanceStatus: "applied",
    impacts: [
      { cycleId: "cycle-1", sequence: 1, durableState: "committed", resourceCount: 2, documentCount: 1, assertionCount: 3, relationCount: 4 },
      { cycleId: "cycle-2", sequence: 2, durableState: "running", resourceCount: 99, documentCount: 99, assertionCount: 99, relationCount: 99 },
    ],
    inquirySummaries: ["正在推演潮汐魔法对港口贸易的影响。"], closures: [], longform: { status: "unavailable" },
    illustrationRequests: [{ id: "request-1", status: "running", coverageMode: "custom", itemCount: 2, readyCount: 1, createdAt: now, updatedAt: now, items: [
      { id: "failed", requestId: "request-1", purpose: "scene", title: "失败图", variantKey: "v1", status: "failed", source: { kind: "resource", sourceResourceId: "world-1", label: "潮汐世界", excerpt: null }, imageJobId: "job-1", assetId: null, thumbnailUrl: null, mimeType: null, width: null, height: null, createdAt: now, updatedAt: now },
      { id: "ready", requestId: "request-1", purpose: "scene", title: "港口", variantKey: "v2", status: "ready", source: { kind: "resource", sourceResourceId: "world-1", label: "潮汐世界", excerpt: null }, imageJobId: "job-2", assetId: "asset-2", thumbnailUrl: "novax-asset://image/asset-2", mimeType: "image/png", width: 1024, height: 1024, createdAt: now, updatedAt: "2026-07-16T00:00:01.000Z" },
    ] }],
  };
}

describe("GrowthIllustrationGallery", () => {
  it("opens only a truly ready managed asset and keeps failures visible", async () => {
    const { canOpenGrowthIllustration, flattenGrowthIllustrationItems } = await import(viewsModulePath);
    const items = flattenGrowthIllustrationItems(snapshot());
    expect(items.map((item: GrowthPresentationSnapshot["illustrationRequests"][number]["items"][number]) => item.id)).toEqual(["ready", "failed"]);
    expect(canOpenGrowthIllustration(items[0]!)).toBe(true);
    expect(canOpenGrowthIllustration(items[1]!)).toBe(false);
  });

  it("keeps the first gallery page bounded while allowing additional pages", async () => {
    const { growthIllustrationPageSize, visibleGrowthIllustrationItems } = await import(viewsModulePath);
    expect(growthIllustrationPageSize).toBe(100);
    const seed = flattenItems(snapshot());
    const items = Array.from({ length: 205 }, (_, index) => ({ ...seed[0]!, id: `item-${index}` }));
    expect(visibleGrowthIllustrationItems(items, 1)).toHaveLength(100);
    expect(visibleGrowthIllustrationItems(items, 200)).toHaveLength(200);
  });

  it("counts only committed impacts as completed changes", async () => {
    const { toGrowthImpactSummaryView } = await import(viewsModulePath);
    expect(toGrowthImpactSummaryView(snapshot())).toMatchObject({
      committedCycleCount: 1, changedResourceCount: 2, changedDocumentCount: 1, changedAssertionCount: 3, changedRelationCount: 4,
    });
  });
});

function flattenItems(value: GrowthPresentationSnapshot) {
  return value.illustrationRequests.flatMap((request) => request.items);
}
