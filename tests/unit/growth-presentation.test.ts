import { describe, expect, it } from "vitest";
import type { AgentRunEvent, GrowthStartResponse } from "../../src/shared/ipcContract";

const presentationModulePath = "../../src/renderer/src/features/agent/growthPresentation";
const stewardModulePath = "../../src/renderer/src/features/agent/StewardRuntimePanel";

async function presentation() {
  return import(presentationModulePath);
}

async function steward() {
  return import(stewardModulePath);
}

const goalId = "goal-1";
const cycleOne = "cycle-1";
const cycleTwo = "cycle-2";

function snapshot(overrides: Partial<GrowthStartResponse> = {}): GrowthStartResponse {
  return {
    capabilityVersion: "hackathon-growth-persistence-v1",
    strategy: "grow_world_story_oc_v1",
    coordinatorStatus: "running",
    goal: { id: goalId, status: "active", currentCycleSequence: 1 },
    cycles: [
      { id: cycleOne, sequence: 1, runId: "run-1", status: "running" },
      { id: cycleTwo, sequence: 2, runId: null, status: "planned" },
      { id: "cycle-3", sequence: 3, runId: null, status: "planned" },
    ],
    events: [event({ cycleId: cycleOne, sequence: 1, phase: "run_attached", durableState: "running", runId: "run-1" })],
    ...overrides,
  };
}

function event(overrides: Partial<GrowthStartResponse["events"][number]> = {}): GrowthStartResponse["events"][number] {
  return {
    goalId,
    cycleId: cycleOne,
    runId: "run-1",
    sequence: 2,
    phase: "receipt_recorded",
    durableState: "running",
    safeSummary: "正在检索项目事实",
    targetKind: "resource",
    targetId: "resource-1",
    targetVersionId: null,
    contentRef: null,
    ...overrides,
  };
}

describe("growth presentation", () => {
  it("dedupes and orders out-of-order repository events without regressing committed state", async () => {
    const { createGrowthPresentation, mergeGrowthEvent } = await presentation();
    const committed = event({ sequence: 3, phase: "change_set_committed", durableState: "committed", targetKind: "change_set", targetId: "change-set-1" });
    const older = event({ sequence: 2, safeSummary: "正在检索项目事实" });
    let state = createGrowthPresentation(snapshot({ events: [committed] }));
    state = mergeGrowthEvent(state, older);
    state = mergeGrowthEvent(state, committed);

    expect(state.events.map((item: GrowthStartResponse["events"][number]) => item.sequence)).toEqual([2, 3]);
    expect(state.rows[0]).toMatchObject({ sequence: 1, durableState: "committed", summary: "已提交" });
  });

  it("shows three cycles and keeps coordinator terminal status from regressing to running", async () => {
    const { createGrowthPresentation, mergeGrowthSnapshot } = await presentation();
    let state = createGrowthPresentation(snapshot({
      coordinatorStatus: "completed",
      goal: { id: goalId, status: "active", currentCycleSequence: 3 },
      cycles: [
        { id: cycleOne, sequence: 1, runId: "run-1", status: "committed" },
        { id: cycleTwo, sequence: 2, runId: "run-2", status: "committed" },
        { id: "cycle-3", sequence: 3, runId: "run-3", status: "committed" },
      ],
    }));
    state = mergeGrowthSnapshot(state, snapshot());

    expect(state.coordinatorStatus).toBe("completed");
    expect(state.rows).toHaveLength(3);
    expect(state.running).toBe(false);
  });

  it("keeps terminal failure and reconciliation visible instead of completed", async () => {
    const { createGrowthPresentation } = await presentation();
    const failed = createGrowthPresentation(snapshot({ coordinatorStatus: "failed", goal: { id: goalId, status: "blocked", currentCycleSequence: 1 } }));
    const reconciliation = createGrowthPresentation(snapshot({ coordinatorStatus: "reconciliation_required", goal: { id: goalId, status: "reconciliation_required", currentCycleSequence: 1 } }));

    expect(failed.terminalLabel).toBe("已失败");
    expect(reconciliation.terminalLabel).toBe("需要核对");
  });

  it("does not label planned, running, or receipt state as committed", async () => {
    const { createGrowthPresentation } = await presentation();
    const planned = createGrowthPresentation(snapshot({ events: [], cycles: [
      { id: cycleOne, sequence: 1, runId: null, status: "planned" },
      { id: cycleTwo, sequence: 2, runId: null, status: "planned" },
      { id: "cycle-3", sequence: 3, runId: null, status: "planned" },
    ] }));
    const receipt = createGrowthPresentation(snapshot({ events: [event({ phase: "receipt_recorded", durableState: "running", safeSummary: "正在检索项目事实" })] }));

    expect(planned.rows[0]?.summary).not.toBe("已提交");
    expect(receipt.rows[0]?.summary).not.toBe("已提交");
    expect(receipt.rows[0]?.durableState).toBe("running");
  });

  it("binds a Run immediately from an authoritative run_attached event before the cycle snapshot refreshes", async () => {
    const { createGrowthPresentation, isGrowthBoundRun, mergeGrowthEvent } = await presentation();
    let state = createGrowthPresentation(snapshot());
    state = mergeGrowthEvent(state, event({
      cycleId: cycleTwo,
      runId: "run-2",
      sequence: 4,
      phase: "run_attached",
      durableState: "running",
      targetId: "resource-2",
      safeSummary: "正在生成候选故事",
    }));

    expect(state.cycles.find((cycle: GrowthStartResponse["cycles"][number]) => cycle.id === cycleTwo)?.runId).toBeNull();
    expect(isGrowthBoundRun(state, "run-2")).toBe(true);
    expect(isGrowthBoundRun(state, "ordinary-run")).toBe(false);
  });

  it("only associates safe ordinary Agent activity with bound Growth Runs", async () => {
    const { appendGrowthAgentEvent, createGrowthPresentation } = await presentation();
    const state = createGrowthPresentation(snapshot());
    const related: AgentRunEvent = { type: "run.activity", runId: "run-1", label: "检索项目事实", phase: "started", domains: ["graph"] };
    const unrelated: AgentRunEvent = { type: "run.activity", runId: "ordinary-run", label: "生成候选变更", phase: "started", domains: ["story"] };

    expect(appendGrowthAgentEvent(state, related).agentActivities).toHaveLength(1);
    expect(appendGrowthAgentEvent(state, unrelated)).toBe(state);
  });

  it("makes stale Growth restore successes and rejections inert after scope or newer request wins", async () => {
    const { advanceGrowthRequestToken, isCurrentGrowthRequest } = await steward();
    const oldRestore = advanceGrowthRequestToken({ generation: 0, scopeKey: null }, "novelx:growth-goal:project-a:session-a");
    const switchedScope = advanceGrowthRequestToken(oldRestore, "novelx:growth-goal:project-b:session-b");
    const newerRestore = advanceGrowthRequestToken(switchedScope, "novelx:growth-goal:project-b:session-b");
    const applied: string[] = [];

    if (isCurrentGrowthRequest(newerRestore, oldRestore)) applied.push("old-success");
    if (isCurrentGrowthRequest(newerRestore, oldRestore)) applied.push("old-rejection-cleared-storage");
    if (isCurrentGrowthRequest(newerRestore, switchedScope)) applied.push("older-same-scope-success");
    if (isCurrentGrowthRequest(newerRestore, newerRestore)) applied.push("current-success");

    expect(applied).toEqual(["current-success"]);
  });
});
