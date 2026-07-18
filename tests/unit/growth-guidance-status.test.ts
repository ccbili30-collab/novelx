import { describe, expect, it } from "vitest";
import type { GrowthPresentationSnapshot } from "../../src/shared/growthPresentationContract";

const viewsModulePath = "../../src/renderer/src/features/growth/growthPresentationViews";

function snapshot(overrides: Partial<GrowthPresentationSnapshot> = {}): GrowthPresentationSnapshot {
  return {
    capabilityVersion: "growth-presentation-v2", goalId: "goal-1", currentRuleRevision: 1,
    activeCycleRuleRevision: 1, guidanceStatus: "none", impacts: [], inquirySummaries: [], closures: [],
    longform: { status: "unavailable" }, illustrationRequests: [], activityEvents: [], ...overrides,
  };
}

describe("GrowthGuidanceStatus", () => {
  it("distinguishes persisted guidance from the revision fixed by the active cycle", async () => {
    const { toGrowthGuidanceStatusView } = await import(viewsModulePath);
    expect(toGrowthGuidanceStatusView(snapshot({ currentRuleRevision: 3, activeCycleRuleRevision: 2, guidanceStatus: "persisted_pending_boundary" }))).toEqual({
      tone: "pending", title: "规则修订 #3 已收到", detail: "当前原子轮仍使用 #2，新规则不会污染正在执行的提交。",
    });
  });

  it("does not claim a missing snapshot has been applied", async () => {
    const { toGrowthGuidanceStatusView } = await import(viewsModulePath);
    expect(toGrowthGuidanceStatusView(null).tone).toBe("idle");
    expect(toGrowthGuidanceStatusView(snapshot({ currentRuleRevision: 4, activeCycleRuleRevision: 4, guidanceStatus: "applied" }))).toMatchObject({ tone: "applied" });
  });

  it("projects persisted inquiry, checker repair and longform progress without inventing completion", async () => {
    const { toGrowthImpactSummaryView } = await import(viewsModulePath);
    const view = toGrowthImpactSummaryView(snapshot({
      inquirySummaries: ["潮汐规则会怎样改变继承制度？"],
      closures: [{
        profileId: "closure-1", profileKind: "oc", subjectResourceId: "oc-1", revision: 2,
        contentState: "growing", visualState: "generating", satisfiedCount: 4, missingCount: 1,
        checkerDecision: "repairs_required", lastProgressCycleSequence: 6,
        findings: [{ severity: "blocking", category: "continuity", safeSummary: "继承动机缺少来源。", repairObjective: "补齐继承冲突与世界规则的联系。" }],
      }],
      longform: {
        status: "ready", focusOcResourceId: "oc-1", personalStoryResourceId: "volume-1", storyTitle: "潮痕",
        completedSectionCount: 3, totalSectionCount: 8, totalCodePoints: 4_200, currentSectionTitle: "无月港", complete: false,
      },
    }));
    expect(view).toMatchObject({
      latestInquiry: "潮汐规则会怎样改变继承制度？",
      inquiryEvidenceLabel: "来自持久化自询事件",
      closureLabel: "Checker 要求返工",
      blockingFindingCount: 1,
      longformDetail: "下一节：无月港",
    });
    expect(view?.closureFindings[0]?.repairObjective).toContain("世界规则");
  });
});
