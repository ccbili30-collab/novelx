import { describe, expect, it } from "vitest";
import type { AgentArtifact, AgentRunEvent, GrowthStartResponse } from "../../src/shared/ipcContract";

const presentationModulePath = "../../src/renderer/src/features/agent/growthPresentation";
const stewardModulePath = "../../src/renderer/src/features/agent/StewardRuntimePanel";
const artifactListModulePath = "../../src/renderer/src/features/agent/AgentArtifactList";

async function presentation() {
  return import(presentationModulePath);
}

async function steward() {
  return import(stewardModulePath);
}

async function artifactList() {
  return import(artifactListModulePath);
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

function worldMapArtifact(
  status: Extract<AgentArtifact, { kind: "image" }>["status"],
  overrides: Partial<Extract<AgentArtifact, { kind: "image" }>> = {},
): Extract<AgentArtifact, { kind: "image" }> {
  return {
    kind: "image",
    assetId: "map-asset-1",
    title: "潮汐海港地图",
    status,
    purpose: "world_map",
    sourceLabel: "潮汐海港世界",
    thumbnailUrl: status === "ready" ? "novax-asset://image/map-asset-1" : null,
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

  it("selects the latest managed ready world map for a truthful preview", async () => {
    const { getGrowthWorldMapDisplay } = await presentation();
    const display = getGrowthWorldMapDisplay([
      worldMapArtifact("failed", { assetId: "map-asset-old" }),
      worldMapArtifact("ready"),
    ]);

    expect(display.artifact).toMatchObject({ assetId: "map-asset-1", title: "潮汐海港地图" });
    expect(display.canPreview).toBe(true);
    expect(display.canOpenShowcase).toBe(true);
  });

  it("keeps the world map machine identity selective and presents it in Chinese", async () => {
    const { getGrowthWorldMapDisplay } = await presentation();
    const { imagePurposeLabel } = await artifactList();
    const scene = worldMapArtifact("ready", { assetId: "scene-asset-1", purpose: "故事场景" });

    expect(getGrowthWorldMapDisplay([scene]).artifact).toBeNull();
    expect(imagePurposeLabel("world_map")).toBe("世界地图");
    expect(imagePurposeLabel("故事场景")).toBe("故事场景");
    expect(imagePurposeLabel("角色立绘")).toBe("角色立绘");
  });

  it("keeps queued, generating, failed, and stale world maps visibly non-ready", async () => {
    const { getGrowthWorldMapDisplay } = await presentation();
    for (const status of ["queued", "generating", "failed", "stale"] as const) {
      const display = getGrowthWorldMapDisplay([worldMapArtifact(status)]);
      expect(display.artifact?.status).toBe(status);
      expect(display.canPreview).toBe(false);
      expect(display.canOpenShowcase).toBe(false);
    }
  });

  it("opens a live observed Growth world map once only after navigation succeeds", async () => {
    const { advanceGrowthVisualClimax, createGrowthPresentation, settleGrowthVisualClimax } = await presentation();
    const map = worldMapArtifact("ready");
    const running = createGrowthPresentation(snapshot());
    const observed = advanceGrowthVisualClimax({
      observedRunningGoalIds: [],
      inFlightGoalAssetKeys: [],
      openedGoalAssetKeys: [],
    }, running, [map]);
    const completed = createGrowthPresentation(snapshot({ coordinatorStatus: "completed", goal: { id: goalId, status: "active", currentCycleSequence: 3 } }));
    const candidate = advanceGrowthVisualClimax(observed.state, completed, [map]);
    const duplicateInFlight = advanceGrowthVisualClimax(candidate.state, completed, [map]);
    const openedState = settleGrowthVisualClimax(candidate.state, candidate.key!, true);
    const duplicateOpened = advanceGrowthVisualClimax(openedState, completed, [map]);

    expect(observed.artifact).toBeNull();
    expect(candidate.artifact?.assetId).toBe("map-asset-1");
    expect(candidate.state.inFlightGoalAssetKeys).toEqual([`${goalId}:map-asset-1`]);
    expect(candidate.state.openedGoalAssetKeys).toEqual([]);
    expect(duplicateInFlight.artifact).toBeNull();
    expect(openedState).toMatchObject({
      inFlightGoalAssetKeys: [],
      openedGoalAssetKeys: [`${goalId}:map-asset-1`],
    });
    expect(duplicateOpened.artifact).toBeNull();
  });

  it("releases failed navigation for a later authoritative retry and ignores stale completion after reset", async () => {
    const { advanceGrowthVisualClimax, createGrowthPresentation, settleGrowthVisualClimax } = await presentation();
    const map = worldMapArtifact("ready");
    const initial = { observedRunningGoalIds: [], inFlightGoalAssetKeys: [], openedGoalAssetKeys: [] };
    const observed = advanceGrowthVisualClimax(initial, createGrowthPresentation(snapshot()), [map]);
    const completed = createGrowthPresentation(snapshot({ coordinatorStatus: "completed" }));
    const first = advanceGrowthVisualClimax(observed.state, completed, [map]);
    const released = settleGrowthVisualClimax(first.state, first.key!, false);
    const retried = advanceGrowthVisualClimax(released, completed, [map]);

    expect(released.inFlightGoalAssetKeys).toEqual([]);
    expect(released.openedGoalAssetKeys).toEqual([]);
    expect(retried.artifact?.assetId).toBe("map-asset-1");
    expect(settleGrowthVisualClimax(initial, first.key!, true)).toBe(initial);
  });

  it("does not auto-open restored completed, blocked, failed, or unrelated Growth goals", async () => {
    const { advanceGrowthVisualClimax, createGrowthPresentation } = await presentation();
    const map = worldMapArtifact("ready");
    const initial = { observedRunningGoalIds: [], inFlightGoalAssetKeys: [], openedGoalAssetKeys: [] };
    const restoredCompleted = createGrowthPresentation(snapshot({ coordinatorStatus: "completed", goal: { id: goalId, status: "active", currentCycleSequence: 3 } }));
    const observed = advanceGrowthVisualClimax(initial, createGrowthPresentation(snapshot()), [map]);
    const unrelatedCompleted = createGrowthPresentation(snapshot({
      coordinatorStatus: "completed",
      goal: { id: "goal-2", status: "active", currentCycleSequence: 3 },
      events: [],
    }));

    expect(advanceGrowthVisualClimax(initial, restoredCompleted, [map]).artifact).toBeNull();
    expect(advanceGrowthVisualClimax(observed.state, createGrowthPresentation(snapshot({ coordinatorStatus: "blocked" })), [map]).artifact).toBeNull();
    expect(advanceGrowthVisualClimax(observed.state, createGrowthPresentation(snapshot({ coordinatorStatus: "failed" })), [map]).artifact).toBeNull();
    expect(advanceGrowthVisualClimax(observed.state, unrelatedCompleted, [map]).artifact).toBeNull();
  });
});
