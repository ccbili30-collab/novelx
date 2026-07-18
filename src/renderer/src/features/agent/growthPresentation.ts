import type { AgentArtifact, AgentRunEvent, GrowthGuideResponse, GrowthStartResponse } from "../../../../shared/ipcContract";

type GrowthEvent = GrowthStartResponse["events"][number];
type GrowthCycle = GrowthStartResponse["cycles"][number];
type GrowthDiagnostic = GrowthStartResponse["diagnostics"][number];
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
  diagnostics: GrowthDiagnostic[];
}

export interface GrowthGuidancePresentation {
  activeRevision: number;
  latestSavedRevision: number;
  pending: boolean;
  nextCycleSequence: number | null;
  nextCycleKind: "revision" | null;
  focusKinds: Array<"world" | "story" | "oc">;
}

export interface GrowthGuidanceAvailability {
  canGuide: boolean;
  reason: string | null;
}

export interface GrowthPresentation {
  goalId: string;
  conversationRoute: GrowthStartResponse["conversationRoute"];
  coordinatorStatus: CoordinatorStatus;
  goalStatus: GrowthStartResponse["goal"]["status"];
  currentCycleSequence: number;
  cycles: GrowthCycle[];
  events: GrowthEvent[];
  diagnostics: GrowthDiagnostic[];
  agentActivities: GrowthAgentActivity[];
  rows: GrowthTimelineRow[];
  current: GrowthTimelineRow | null;
  guidance: GrowthGuidancePresentation | null;
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
    conversationRoute: snapshot.conversationRoute,
    coordinatorStatus: snapshot.coordinatorStatus,
    goalStatus: snapshot.goal.status,
    currentCycleSequence: snapshot.goal.currentCycleSequence,
    cycles: snapshot.cycles,
    events: uniqueEvents(snapshot.events),
    diagnostics: uniqueDiagnostics(snapshot.diagnostics),
    agentActivities: [],
    guidance: guidanceFromSnapshot(snapshot),
  });
}

export function mergeGrowthSnapshot(current: GrowthPresentation | null, snapshot: GrowthStartResponse): GrowthPresentation {
  if (!current || current.goalId !== snapshot.goal.id) return createGrowthPresentation(snapshot);
  const successorStarted = snapshot.goal.currentCycleSequence > current.currentCycleSequence;
  const coordinatorStatus = terminalCoordinatorStates.has(current.coordinatorStatus) && snapshot.coordinatorStatus === "running" && !successorStarted
    ? current.coordinatorStatus
    : snapshot.coordinatorStatus;
  const restoredGuidance = guidanceFromSnapshot(snapshot);
  const guidance = restoredGuidance?.pending && current.guidance?.pending
    && restoredGuidance.latestSavedRevision === current.guidance.latestSavedRevision
    ? {
        ...restoredGuidance,
        nextCycleSequence: current.guidance.nextCycleSequence,
        nextCycleKind: current.guidance.nextCycleKind,
        focusKinds: current.guidance.focusKinds,
      }
    : restoredGuidance;
  return derive({
    goalId: current.goalId,
    conversationRoute: snapshot.conversationRoute,
    coordinatorStatus,
    goalStatus: snapshot.goal.status,
    currentCycleSequence: Math.max(current.currentCycleSequence, snapshot.goal.currentCycleSequence),
    cycles: snapshot.cycles,
    events: uniqueEvents([...current.events, ...snapshot.events]),
    diagnostics: uniqueDiagnostics([...current.diagnostics, ...snapshot.diagnostics]),
    agentActivities: current.agentActivities,
    guidance,
  });
}

export function recordGrowthGuidanceResponse(
  current: GrowthPresentation,
  response: GrowthGuideResponse,
): GrowthPresentation {
  if (response.goalId !== current.goalId || response.persistedRevision < (current.guidance?.latestSavedRevision ?? 0)) return current;
  return derive({
    ...current,
    guidance: {
      activeRevision: response.currentCycleRevision,
      latestSavedRevision: response.persistedRevision,
      pending: response.status === "persisted_pending_boundary",
      nextCycleSequence: response.nextCycleSequence,
      nextCycleKind: response.nextCycleKind,
      focusKinds: response.focusKinds,
    },
  });
}

export function getGrowthGuidanceAvailability(current: GrowthPresentation): GrowthGuidanceAvailability {
  const awaitingCreatorChoice = current.coordinatorStatus === "blocked"
    && current.events.some((event) => event.phase === "creator_choice_required"
      && event.cycleId === current.current?.cycleId && event.durableState === "blocked");
  if (current.coordinatorStatus !== "running" && current.coordinatorStatus !== "awaiting_guidance" && !awaitingCreatorChoice) {
    return { canGuide: false, reason: "当前生长任务已结束，不能追加规则修订。" };
  }
  if (current.currentCycleSequence < 1 || !current.guidance) {
    return { canGuide: false, reason: "规则修订状态不可用，无法安全保存指导。" };
  }
  return { canGuide: true, reason: null };
}

export function mergeGrowthEvent(current: GrowthPresentation, event: GrowthEvent): GrowthPresentation {
  if (event.goalId !== current.goalId || current.events.some((item) => eventKey(item) === eventKey(event))) return current;
  return derive({ ...current, events: uniqueEvents([...current.events, event]) });
}

export function growthEventSummary(event: GrowthEvent): string {
  if (event.phase === "inquiry_selected") return `正在推演：${event.safeSummary}`;
  if (event.phase === "creator_choice_required") return `需要你的取舍：${event.safeSummary}`;
  return event.safeSummary;
}

export function growthDiagnosticSummary(diagnostic: GrowthDiagnostic): string {
  const owner = ({
    provider: "模型服务",
    worker_schema: "Worker 结构校验",
    growth_phase: "生长阶段",
    tool_bridge: "工具桥",
    main_gateway: "主进程网关",
    domain_policy: "领域规则",
    persistence: "持久化",
    reconciliation: "结果核对",
    projection: "界面投影",
  } as const)[diagnostic.owner];
  const effect = ({
    none: "未产生外部副作用",
    request_sent: "请求已发出",
    outcome_unknown: "结果未知，必须核对",
    committed: "变更已提交",
  } as const)[diagnostic.sideEffectState];
  const attempt = diagnostic.attempt !== null && diagnostic.maxAttempts !== null
    ? ` · 第 ${diagnostic.attempt}/${diagnostic.maxAttempts} 次`
    : "";
  return `${owner} · ${diagnostic.code}${attempt} · ${effect}`;
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
    const diagnostics = input.diagnostics.filter((diagnostic) => diagnostic.cycleId === cycle.id);
    return {
      cycleId: cycle.id,
      sequence: cycle.sequence,
      runId: cycle.runId,
      durableState,
      summary: latest?.durableState === "committed" ? "已提交" : latest ? growthEventSummary(latest) : cycleSummary(cycle.status),
      events,
      activities,
      diagnostics,
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

function guidanceFromSnapshot(snapshot: GrowthStartResponse): GrowthGuidancePresentation | null {
  const latestSavedRevision = snapshot.currentRuleRevision;
  const activeRevision = snapshot.activeCycleRuleRevision;
  const status = snapshot.guidanceStatus;
  if (typeof latestSavedRevision !== "number" || typeof activeRevision !== "number" || status === undefined) return null;
  if (status === "none") {
    return { activeRevision, latestSavedRevision, pending: false, nextCycleSequence: null, nextCycleKind: null, focusKinds: [] };
  }
  const nextCycleSequence = snapshot.goal.currentCycleSequence + 1;
  if (nextCycleSequence < 2 || latestSavedRevision <= activeRevision) return null;
  return {
    activeRevision,
    latestSavedRevision,
    pending: true,
    nextCycleSequence,
    nextCycleKind: "revision",
    focusKinds: [],
  };
}

function uniqueEvents(events: readonly GrowthEvent[]): GrowthEvent[] {
  const byKey = new Map<string, GrowthEvent>();
  for (const event of events) byKey.set(eventKey(event), event);
  return [...byKey.values()].sort((left, right) => left.sequence - right.sequence);
}

function uniqueDiagnostics(diagnostics: readonly GrowthDiagnostic[]): GrowthDiagnostic[] {
  const byId = new Map<string, GrowthDiagnostic>();
  for (const diagnostic of diagnostics) byId.set(diagnostic.diagnosticId, diagnostic);
  return [...byId.values()];
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
  return ({ planned: "等待开始", running: "正在处理", committed: "已提交", evaluated: "闭环已评估", blocked: "已阻塞", failed: "已失败", cancelled: "已取消", reconciliation_required: "需要核对" })[status];
}

function coordinatorLabel(status: Exclude<CoordinatorStatus, "running">): string {
  return ({
    awaiting_guidance: "当前无 Agent 运行，等待追加指导",
    completed: "本次生长已完成",
    blocked: "已阻塞",
    failed: "已失败",
    cancelled: "已取消",
    reconciliation_required: "需要核对",
  })[status];
}
