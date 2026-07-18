import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  growthConversationRoute,
  growthStartResponseSchema,
} from "../../src/shared/ipcContract";

const stewardModulePath = "../../src/renderer/src/features/agent/StewardRuntimePanel";
const presentationModulePath = "../../src/renderer/src/features/agent/growthPresentation";

function snapshot() {
  return {
    capabilityVersion: "hackathon-growth-closure-v4",
    strategy: "grow_world_story_oc_closure_v4",
    conversationRoute: growthConversationRoute,
    coordinatorStatus: "running",
    goal: { id: "goal-route-1", status: "active", currentCycleSequence: 1 },
    cycles: [{ id: "cycle-route-1", sequence: 1, runId: "run-route-1", status: "running" }],
    events: [],
    diagnostics: [],
  } as const;
}

describe("Growth conversation route", () => {
  it("requires the fixed World Director route at the public IPC boundary", () => {
    const parsed = growthStartResponseSchema.parse(snapshot());

    expect(parsed.conversationRoute).toEqual({
      interlocutor: "world_director",
      operationalActor: "steward",
      operationalPresentation: "expandable_activity",
    });
    expect(() => growthStartResponseSchema.parse({ ...snapshot(), conversationRoute: undefined })).toThrow();
    expect(() => growthStartResponseSchema.parse({
      ...snapshot(),
      conversationRoute: { ...growthConversationRoute, interlocutor: "steward" },
    })).toThrow();
  });

  it("preserves the authoritative route in the Renderer projection", async () => {
    const { createGrowthPresentation } = await import(presentationModulePath);
    const presentation = createGrowthPresentation(growthStartResponseSchema.parse(snapshot()));

    expect(presentation.conversationRoute).toEqual(growthConversationRoute);
  });

  it("uses World Director copy only in Growth mode", async () => {
    const { resolveConversationIdentity } = await import(stewardModulePath);
    expect(resolveConversationIdentity("growth")).toEqual({
      interlocutorLabel: "世界总编",
      composerAriaLabel: "给世界总编发送消息",
      composerPlaceholder: "和世界总编讨论世界、OC 或故事",
      runningLabel: "世界总编正在组织创作",
    });
    expect(resolveConversationIdentity("assist").interlocutorLabel).toBe("大管家");
    expect(resolveConversationIdentity("free").composerAriaLabel).toBe("给大管家发送消息");
  });

  it("keeps Steward activity collapsed behind an operational disclosure", async () => {
    const { GrowthOperationalActivity } = await import(stewardModulePath);
    const html = renderToStaticMarkup(createElement(
      GrowthOperationalActivity,
      null,
      createElement("span", null, "已完成资料检索"),
    ));

    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("<summary>大管家运行活动</summary>");
    expect(html).toContain("已完成资料检索");
  });
});
