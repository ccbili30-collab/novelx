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
    capabilityVersion: "hackathon-growth-dynamic-v2",
    strategy: "grow_world_story_oc_dynamic_v2",
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
  it("fails closed when restored guidance revision fields are incomplete", async () => {
    const { createGrowthPresentation } = await presentation();

    const complete = createGrowthPresentation(snapshot({
      currentRuleRevision: 2,
      activeCycleRuleRevision: 1,
      guidanceStatus: "persisted_pending_boundary",
    }));
    const missingActiveRevision = createGrowthPresentation(snapshot({
      currentRuleRevision: 2,
      guidanceStatus: "persisted_pending_boundary",
    }));

    expect(complete.guidance).toMatchObject({
      activeRevision: 1,
      latestSavedRevision: 2,
      pending: true,
      nextCycleSequence: 2,
      nextCycleKind: "revision",
      focusKinds: [],
    });
    expect(missingActiveRevision.guidance).toBeNull();
  });

  it("advances consecutive persisted guidance revisions and disables unsafe boundaries", async () => {
    const { createGrowthPresentation, getGrowthGuidanceAvailability, mergeGrowthSnapshot, recordGrowthGuidanceResponse } = await presentation();
    let state = createGrowthPresentation(snapshot({
      currentRuleRevision: 1,
      activeCycleRuleRevision: 1,
      guidanceStatus: "none",
    }));

    state = recordGrowthGuidanceResponse(state, {
      goalId,
      persistedRevision: 2,
      currentCycleRevision: 1,
      appliesAt: "next_cycle_boundary",
      nextCycleSequence: 2,
      nextCycleKind: "revision",
      focusKinds: ["world", "story", "oc"],
      status: "persisted_pending_boundary",
    });
    state = recordGrowthGuidanceResponse(state, {
      goalId,
      persistedRevision: 3,
      currentCycleRevision: 1,
      appliesAt: "next_cycle_boundary",
      nextCycleSequence: 2,
      nextCycleKind: "revision",
      focusKinds: ["world", "story", "oc"],
      status: "persisted_pending_boundary",
    });
    state = mergeGrowthSnapshot(state, snapshot({
      currentRuleRevision: 3,
      activeCycleRuleRevision: 1,
      guidanceStatus: "persisted_pending_boundary",
    }));

    expect(state.guidance).toMatchObject({
      activeRevision: 1, latestSavedRevision: 3, pending: true, focusKinds: ["world", "story", "oc"],
    });
    expect(getGrowthGuidanceAvailability(state)).toEqual({ canGuide: true, reason: null });

    const cycleThree = createGrowthPresentation(snapshot({
      goal: { id: goalId, status: "active", currentCycleSequence: 3 },
      currentRuleRevision: 3,
      activeCycleRuleRevision: 3,
      guidanceStatus: "none",
    }));
    expect(getGrowthGuidanceAvailability(cycleThree)).toEqual({ canGuide: true, reason: null });
    const awaiting = createGrowthPresentation(snapshot({
      coordinatorStatus: "awaiting_guidance",
      goal: { id: goalId, status: "active", currentCycleSequence: 3 },
      currentRuleRevision: 3,
      activeCycleRuleRevision: 1,
      guidanceStatus: "persisted_pending_boundary",
      cycles: [
        { id: cycleOne, sequence: 1, runId: "run-1", status: "committed" },
        { id: cycleTwo, sequence: 2, runId: "run-2", status: "committed" },
        { id: "cycle-3", sequence: 3, runId: "run-3", status: "committed" },
      ],
    }));
    expect(awaiting.running).toBe(false);
    expect(awaiting.terminalLabel).toBe("当前无 Agent 运行，等待追加指导");
    expect(getGrowthGuidanceAvailability(awaiting)).toEqual({ canGuide: true, reason: null });
    for (const coordinatorStatus of ["completed", "blocked", "failed", "reconciliation_required"] as const) {
      const terminal = createGrowthPresentation(snapshot({
        coordinatorStatus,
        currentRuleRevision: 1,
        activeCycleRuleRevision: 1,
        guidanceStatus: "none",
      }));
      expect(getGrowthGuidanceAvailability(terminal), coordinatorStatus).toEqual({
        canGuide: false,
        reason: "当前生长任务已结束，不能追加规则修订。",
      });
    }
  });

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

  it("suppresses consecutive duplicate activity while preserving repeated map lifecycle activity after an intervening event", async () => {
    const { appendGrowthAgentEvent, createGrowthPresentation } = await presentation();
    let state = createGrowthPresentation(snapshot());
    const outerGenerating: AgentRunEvent = {
      type: "run.activity",
      runId: "run-1",
      label: "生成世界地图",
      phase: "started",
      domains: ["asset"],
    };
    const sequence: AgentRunEvent[] = [
      outerGenerating,
      outerGenerating,
      { type: "run.activity", runId: "run-1", label: "世界地图排队中", phase: "started", domains: ["asset"] },
      outerGenerating,
      { type: "run.activity", runId: "run-1", label: "世界地图已生成", phase: "completed", domains: ["asset"] },
      { type: "run.activity", runId: "run-1", label: "生成世界地图", phase: "completed", domains: ["asset"] },
    ];

    for (const activity of sequence) state = appendGrowthAgentEvent(state, activity);

    expect(state.rows[0]?.activities.map((activity: { label: string }) => activity.label)).toEqual([
      "生成世界地图",
      "世界地图排队中",
      "生成世界地图",
      "世界地图已生成",
      "生成世界地图",
    ]);
    expect(state.rows[0]?.activities.map((activity: { phase: string }) => activity.phase)).toEqual([
      "started",
      "started",
      "started",
      "completed",
      "completed",
    ]);
  });

  it("keeps load and guidance identities independent while invalidating stale scope or guidance work", async () => {
    const { advanceGrowthRequestToken, isCurrentGrowthRequest } = await steward();
    const scopeA = "novelx:growth-goal:project-a:session-a";
    const scopeB = "novelx:growth-goal:project-b:session-b";
    let load = advanceGrowthRequestToken({ generation: 0, scopeKey: null }, scopeA);
    let guidance = advanceGrowthRequestToken({ generation: 0, scopeKey: null }, scopeA);
    const pendingGuide = advanceGrowthRequestToken(guidance, scopeA);
    guidance = pendingGuide;

    load = advanceGrowthRequestToken(load, scopeA);
    expect(isCurrentGrowthRequest(guidance, pendingGuide)).toBe(true);

    load = advanceGrowthRequestToken(load, scopeB);
    guidance = advanceGrowthRequestToken(guidance, scopeB);
    const newScopeGuide = advanceGrowthRequestToken(guidance, scopeB);
    guidance = newScopeGuide;
    let newScopeSaving = true;
    if (isCurrentGrowthRequest(guidance, pendingGuide)) newScopeSaving = false;

    expect(isCurrentGrowthRequest(load, pendingGuide)).toBe(false);
    expect(isCurrentGrowthRequest(guidance, pendingGuide)).toBe(false);
    expect(isCurrentGrowthRequest(guidance, newScopeGuide)).toBe(true);
    expect(newScopeSaving).toBe(true);
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
