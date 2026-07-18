import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { growthConversationRoute, growthStartResponseSchema } from "../../src/shared/ipcContract";
import { growthPresentationSnapshotSchema, type GrowthPresentationSnapshot } from "../../src/shared/growthPresentationContract";

const timelineModulePath = "../../src/renderer/src/features/agent/RunActivityTimeline";
const targetModulePath = "../../src/renderer/src/features/activity/RunWorkTargetPane";
const graphModulePath = "../../src/renderer/src/features/graph/SemanticGraphView";
const presentationModulePath = "../../src/renderer/src/features/agent/growthPresentation";

const now = "2026-07-18T08:00:00.000Z";

function details(): GrowthPresentationSnapshot {
  return growthPresentationSnapshotSchema.parse({
    capabilityVersion: "growth-presentation-v2",
    goalId: "goal-editorial-ui",
    currentRuleRevision: 1,
    activeCycleRuleRevision: 1,
    guidanceStatus: "none",
    impacts: [{ cycleId: "cycle-1", sequence: 1, durableState: "committed", resourceCount: 1, documentCount: 1, assertionCount: 3, relationCount: 2 }],
    inquirySummaries: [],
    closures: [],
    longform: { status: "unavailable" },
    illustrationRequests: [],
    activityEvents: [
      { id: "activity-1", kind: "director_planning", actor: "world_director", workOrderId: null, safeSummary: "世界总编已安排 2 项工作。", occurredAt: now },
      { id: "activity-2", kind: "employee_assigned", actor: "graph_curator", workOrderId: "order-1", safeSummary: null, occurredAt: now },
      { id: "activity-3", kind: "checking", actor: "checker", workOrderId: "order-1", safeSummary: "因果桥梁需要补足。", occurredAt: now },
    ],
  });
}

describe("Growth editorial presentation", () => {
  it("renders only safe editorial activity labels and summaries", async () => {
    const { EditorialActivityTimeline } = await import(timelineModulePath);
    const html = renderToStaticMarkup(createElement(EditorialActivityTimeline, { events: details().activityEvents }));

    expect(html).toContain("世界总编编辑进度");
    expect(html).toContain("图谱策展人");
    expect(html).toContain("检查已记录");
    expect(html).toContain("因果桥梁需要补足。");
    expect(html).not.toMatch(/prompt|provider|sha256|@evidence|store-ref/i);
  });

  it("projects the latest editorial step and committed causal counts in the work pane", async () => {
    const { RunWorkTargetPane } = await import(targetModulePath);
    const { createGrowthPresentation } = await import(presentationModulePath);
    const presentation = createGrowthPresentation(growthStartResponseSchema.parse({
      capabilityVersion: "hackathon-growth-closure-v4",
      strategy: "grow_world_story_oc_closure_v4",
      conversationRoute: growthConversationRoute,
      coordinatorStatus: "completed",
      goal: { id: "goal-editorial-ui", status: "completed", currentCycleSequence: 1 },
      cycles: [{ id: "cycle-1", sequence: 1, runId: "run-1", status: "committed" }],
      events: [],
      diagnostics: [],
    }));
    const html = renderToStaticMarkup(createElement(RunWorkTargetPane, {
      presentation,
      details: details(),
      artifacts: [],
      workspace: null,
      onOpenResource: async () => {},
      onOpenDocument: async () => {},
      onOpenChangeSet: async () => {},
      onOpenGraph: async () => {},
      onOpenReadyImage: async () => {},
    }));

    expect(html).toContain("当前编辑工作");
    expect(html).toContain("检查员");
    expect(html).toContain("已提交 2 条因果关系 · 3 条断言");
  });

  it("summarizes causal graph progress without exposing internal identities", async () => {
    const { summarizeCausalGrowth } = await import(graphModulePath);

    expect(summarizeCausalGrowth(details())).toEqual({
      relationCount: 2,
      latestLabel: "检查员 · 检查已记录",
    });
    expect(summarizeCausalGrowth(null)).toBeNull();
  });
});
