import type { AgentArtifact, AgentRunEvent, GrowthStartResponse } from "../../../../shared/ipcContract";

type GrowthEvent = GrowthStartResponse["events"][number];
type GrowthCycle = GrowthStartResponse["cycles"][number];
type CoordinatorStatus = GrowthStartResponse["coordinatorStatus"];
export type GrowthImageArtifact = Extract<AgentArtifact, { kind: "image" }>;

export interface GrowthAgentActivity {
  runId: string;
  label: string;
  phase: "started" | "completed" | "failed";
  domains: Array<"world" | "oc" | "story" | "graph" | "timeline" | "asset">;
}

export interface GrowthTimelineRow {
  cycleId: string;
  sequence: number;
  runId: string | null;
  durableState: GrowthEvent["durableState"];
  summary: string;
  events: GrowthEvent[];
  activities: GrowthAgentActivity[];
}

export interface GrowthPresentation {
  goalId: string;
  coordinatorStatus: CoordinatorStatus;
  goalStatus: GrowthStartResponse["goal"]["status"];
  currentCycleSequence: number;
  cycles: GrowthCycle[];
  events: GrowthEvent[];
  agentActivities: GrowthAgentActivity[];
  rows: GrowthTimelineRow[];
  current: GrowthTimelineRow | null;
  running: boolean;
  terminalLabel: string | null;
}

export interface GrowthWorldMapDisplay {
  artifact: GrowthImageArtifact | null;
  canPreview: boolean;
  canOpenShowcase: boolean;
}

export interface GrowthVisualClimaxState {
  observedRunningGoalIds: string[];
  inFlightGoalAssetKeys: string[];
  openedGoalAssetKeys: string[];
}

export interface GrowthVisualClimaxDecision {
  state: GrowthVisualClimaxState;
  artifact: GrowthImageArtifact | null;
  key: string | null;
}

const terminalCoordinatorStates = new Set<CoordinatorStatus>(["completed", "blocked", "failed", "cancelled", "reconciliation_required"]);

export function createGrowthPresentation(snapshot: GrowthStartResponse): GrowthPresentation {
  return derive({
    goalId: snapshot.goal.id,
    coordinatorStatus: snapshot.coordinatorStatus,
    goalStatus: snapshot.goal.status,
    currentCycleSequence: snapshot.goal.currentCycleSequence,
    cycles: snapshot.cycles,
    events: uniqueEvents(snapshot.events),
    agentActivities: [],
  });
}

export function mergeGrowthSnapshot(current: GrowthPresentation | null, snapshot: GrowthStartResponse): GrowthPresentation {
  if (!current || current.goalId !== snapshot.goal.id) return createGrowthPresentation(snapshot);
  const coordinatorStatus = terminalCoordinatorStates.has(current.coordinatorStatus) && snapshot.coordinatorStatus === "running"
    ? current.coordinatorStatus
    : snapshot.coordinatorStatus;
  return derive({
    goalId: current.goalId,
    coordinatorStatus,
    goalStatus: snapshot.goal.status,
    currentCycleSequence: Math.max(current.currentCycleSequence, snapshot.goal.currentCycleSequence),
    cycles: snapshot.cycles,
    events: uniqueEvents([...current.events, ...snapshot.events]),
    agentActivities: current.agentActivities,
  });
}

export function mergeGrowthEvent(current: GrowthPresentation, event: GrowthEvent): GrowthPresentation {
  if (event.goalId !== current.goalId || current.events.some((item) => eventKey(item) === eventKey(event))) return current;
  return derive({ ...current, events: uniqueEvents([...current.events, event]) });
}

export function appendGrowthAgentEvent(current: GrowthPresentation, event: AgentRunEvent): GrowthPresentation {
  if (event.type !== "run.activity" || !isGrowthBoundRun(current, event.runId)) return current;
  const activity: GrowthAgentActivity = { runId: event.runId, label: event.label, phase: event.phase, domains: event.domains ?? [] };
  const previous = current.agentActivities.at(-1);
  if (previous && activityKey(previous) === activityKey(activity)) return current;
  return derive({ ...current, agentActivities: [...current.agentActivities, activity] });
}

export function mergeGrowthArtifacts(current: readonly AgentArtifact[], incoming: readonly AgentArtifact[]): AgentArtifact[] {
  const merged = [...current];
  for (const artifact of incoming) {
    const key = artifactKey(artifact);
    const index = merged.findIndex((candidate) => artifactKey(candidate) === key);
    if (index >= 0) merged.splice(index, 1);
    merged.push(artifact);
  }
  return merged;
}

export function getGrowthWorldMapDisplay(artifacts: readonly AgentArtifact[]): GrowthWorldMapDisplay {
  const artifact = [...artifacts].reverse().find((candidate): candidate is GrowthImageArtifact => (
    candidate.kind === "image" && candidate.purpose === "world_map"
  )) ?? null;
  const canPreview = artifact?.status === "ready" && artifact.thumbnailUrl !== null;
  return { artifact, canPreview, canOpenShowcase: canPreview };
}

export function advanceGrowthVisualClimax(
  current: GrowthVisualClimaxState,
  presentation: GrowthPresentation | null,
  artifacts: readonly AgentArtifact[],
): GrowthVisualClimaxDecision {
  if (!presentation) return { state: current, artifact: null, key: null };
  const observedRunningGoalIds = presentation.coordinatorStatus === "running" && !current.observedRunningGoalIds.includes(presentation.goalId)
    ? [...current.observedRunningGoalIds, presentation.goalId]
    : current.observedRunningGoalIds;
  const display = getGrowthWorldMapDisplay(artifacts);
  const key = display.artifact ? `${presentation.goalId}:${display.artifact.assetId}` : null;
  const canOpen = presentation.coordinatorStatus === "completed"
    && observedRunningGoalIds.includes(presentation.goalId)
    && display.artifact?.status === "ready"
    && key !== null
    && !current.inFlightGoalAssetKeys.includes(key)
    && !current.openedGoalAssetKeys.includes(key);
  const inFlightGoalAssetKeys = canOpen ? [...current.inFlightGoalAssetKeys, key] : current.inFlightGoalAssetKeys;
  return {
    state: { ...current, observedRunningGoalIds, inFlightGoalAssetKeys },
    artifact: canOpen ? display.artifact : null,
    key: canOpen ? key : null,
  };
}

export function settleGrowthVisualClimax(
  current: GrowthVisualClimaxState,
  key: string,
  opened: boolean,
): GrowthVisualClimaxState {
  if (!current.inFlightGoalAssetKeys.includes(key)) return current;
  return {
    ...current,
    inFlightGoalAssetKeys: current.inFlightGoalAssetKeys.filter((candidate) => candidate !== key),
    openedGoalAssetKeys: opened && !current.openedGoalAssetKeys.includes(key)
      ? [...current.openedGoalAssetKeys, key]
      : current.openedGoalAssetKeys,
  };
}

export function isGrowthBoundRun(current: GrowthPresentation | null, runId: string): boolean {
  return Boolean(current?.cycles.some((cycle) => cycle.runId === runId)
    || current?.events.some((event) => event.runId === runId));
}

function derive(input: Omit<GrowthPresentation, "rows" | "current" | "running" | "terminalLabel">): GrowthPresentation {
  const cycles = [...input.cycles].sort((left, right) => left.sequence - right.sequence);
  const rows = cycles.map((cycle) => {
    const events = input.events.filter((event) => event.cycleId === cycle.id).sort((left, right) => left.sequence - right.sequence);
    const latest = events.at(-1) ?? null;
    const durableState = latest?.durableState ?? cycle.status;
    const activities = input.agentActivities.filter((activity) => activity.runId === cycle.runId);
    return {
      cycleId: cycle.id,
      sequence: cycle.sequence,
      runId: cycle.runId,
      durableState,
      summary: latest?.durableState === "committed" ? "已提交" : latest?.safeSummary ?? cycleSummary(cycle.status),
      events,
      activities,
    } satisfies GrowthTimelineRow;
  });
  const current = rows.find((row) => row.sequence === input.currentCycleSequence)
    ?? rows.find((row) => row.durableState === "running" || row.durableState === "planned")
    ?? rows.at(-1) ?? null;
  return {
    ...input,
    rows,
    current,
    running: input.coordinatorStatus === "running",
    terminalLabel: input.coordinatorStatus === "running" ? null : coordinatorLabel(input.coordinatorStatus),
  };
}

function uniqueEvents(events: readonly GrowthEvent[]): GrowthEvent[] {
  const byKey = new Map<string, GrowthEvent>();
  for (const event of events) byKey.set(eventKey(event), event);
  return [...byKey.values()].sort((left, right) => left.sequence - right.sequence);
}

function eventKey(event: GrowthEvent): string {
  return `${event.cycleId}:${event.sequence}`;
}

function activityKey(activity: GrowthAgentActivity): string {
  return `${activity.runId}:${activity.phase}:${activity.label}:${activity.domains.join(",")}`;
}

function artifactKey(artifact: AgentArtifact): string {
  return artifact.kind === "image" ? `image:${artifact.assetId}` : JSON.stringify(artifact);
}

function cycleSummary(status: GrowthCycle["status"]): string {
  return ({ planned: "等待开始", running: "正在处理", committed: "已提交", blocked: "已阻塞", failed: "已失败", cancelled: "已取消", reconciliation_required: "需要核对" })[status];
}

function coordinatorLabel(status: Exclude<CoordinatorStatus, "running">): string {
  return ({ completed: "本次生长已完成", blocked: "已阻塞", failed: "已失败", cancelled: "已取消", reconciliation_required: "需要核对" })[status];
}
