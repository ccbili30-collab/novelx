import path from "node:path";
import { GrowthRepository } from "../domain/growth/growthRepository";
import type { ApplicationRegistryRepository } from "../domain/application/applicationRegistryRepository";
import {
  growthCapabilityVersion,
  type GrowthCycle,
  type GrowthCycleIntent,
  type GrowthEvent,
  type GrowthGoal,
} from "../shared/growthContract";
import {
  agentRunEventSchema,
  growthGetResponseSchema,
  growthGuideResponseSchema,
  growthLiveEventSchema,
  growthStartResponseSchema,
  type AgentRunEvent,
  type GrowthGetRequest,
  type GrowthGetResponse,
  type GrowthGuideRequest,
  type GrowthGuideResponse,
  type GrowthLiveEvent,
  type GrowthStartRequest,
  type GrowthStartResponse,
} from "../shared/ipcContract";
import { GrowthRunLifecycle } from "./growthRunLifecycle";
import { estimateRevisionIntent, planGrowthFrontier, type GrowthFocusKind } from "./growthFrontierPlanner";
import type { AgentProcessSupervisor } from "./agentProcessSupervisor";
import type { WorkspaceSession } from "./workspaceIpc";
import { DocumentRepository } from "../domain/workspace/documentRepository";
import { ResourceRepository } from "../domain/workspace/resourceRepository";

interface GrowthWorkspaceContext {
  workspace: import("../domain/workspace/workspaceRepository").WorkspaceDatabase;
  rootPath: string;
  branchId: string;
  checkpointId: string;
  authorizedScopeResourceIds: string[];
}

interface GrowthAdvanceRequest {
  projectId: string;
  sessionId: string;
  seed: GrowthStartRequest["seed"];
}

const strategy = "grow_world_story_oc_dynamic_v2" as const;
interface DeliveryRoute {
  growth?: (event: GrowthLiveEvent) => void;
  agent?: (event: AgentRunEvent) => void;
}
/** Main-authoritative, persisted-Intent Growth orchestration. */
export class GrowthCoordinator {
  readonly #listeners = new Map<string, Map<string, DeliveryRoute>>();
  readonly #activeCycleRuns = new Map<string, string>();

  constructor(
    readonly workspaceSession: WorkspaceSession,
    readonly applicationRegistry: ApplicationRegistryRepository,
    readonly supervisor: AgentProcessSupervisor,
  ) {}

  start(input: GrowthStartRequest, route?: DeliveryRoute): GrowthStartResponse {
    this.#assertProjectSession(input.projectId, input.sessionId);
    const context = this.#requiredContext(input.projectId);
    const repository = new GrowthRepository(context.workspace);
    const goalId = goalIdFor(input.requestId);
    const existing = repository.getGoal(goalId);
    if (existing && (existing.branchId !== context.branchId || !sameStrings(existing.authorizedScopeResourceIds, context.authorizedScopeResourceIds))) {
      throw coordinatorError("GROWTH_IDEMPOTENCY_KEY_REUSED");
    }
    const goal = repository.createGoal({
      id: goalId,
      idempotencyKey: `growth-start:${input.projectId}:${input.requestId}`,
      branchId: existing?.branchId ?? context.branchId,
      seed: input.seed,
      authorizedScopeResourceIds: existing?.authorizedScopeResourceIds ?? context.authorizedScopeResourceIds,
      initialRuleText: input.initialRuleText,
      sourceMessageId: null,
    });
    if (route) this.#addListener(goal.id, input.sessionId, route);
    this.#advance({ request: input, goal, context, repository });
    return growthStartResponseSchema.parse(this.#snapshot(repository, goal.id, context));
  }

  get(input: GrowthGetRequest, route?: DeliveryRoute): GrowthGetResponse {
    this.#assertProjectSession(input.projectId, input.sessionId);
    const context = this.#requiredContext(input.projectId);
    const repository = new GrowthRepository(context.workspace);
    const goal = repository.getGoal(input.goalId);
    if (!goal) throw coordinatorError("GROWTH_GOAL_NOT_FOUND");
    if (goal.branchId !== context.branchId || !sameStrings(goal.authorizedScopeResourceIds, context.authorizedScopeResourceIds)) {
      throw coordinatorError("GROWTH_GUIDANCE_AUTHORITY_MISMATCH");
    }
    if (route) this.#addListener(goal.id, input.sessionId, route);
    this.#advance({ request: { ...input, seed: goal.seed }, goal, context, repository });
    return growthGetResponseSchema.parse(this.#snapshot(repository, goal.id, context));
  }

  guide(input: GrowthGuideRequest): GrowthGuideResponse {
    const projectId = this.applicationRegistry.getActiveProjectId();
    if (!projectId || this.applicationRegistry.getProject(projectId).state !== "ready") {
      throw coordinatorError("GROWTH_PROJECT_NOT_ACTIVE");
    }
    const context = this.#requiredContext(projectId);
    const repository = new GrowthRepository(context.workspace);
    const goal = repository.getGoal(input.goalId);
    if (!goal) throw coordinatorError("GROWTH_GOAL_NOT_FOUND");
    if (goal.branchId !== context.branchId || !sameStrings(goal.authorizedScopeResourceIds, context.authorizedScopeResourceIds)) {
      throw coordinatorError("GROWTH_GUIDANCE_AUTHORITY_MISMATCH");
    }
    const cycles = repository.listCycles(goal.id);
    const current = cycles.at(-1);
    const replay = exactRuleReplay(repository, input);
    if (!current || (!["planned", "running", "committed"].includes(current.status) && !replay)) {
      throw coordinatorError("GROWTH_GUIDANCE_NO_NEXT_CYCLE");
    }
    const boundaryCycle = current;
    const currentIntent = repository.getCycleIntent(boundaryCycle.id);
    const estimated = estimateRevisionIntent({
      currentIntent,
      formalCoverageKinds: formalCoverageKinds(context, boundaryCycle.outputCheckpointId ?? boundaryCycle.inputCheckpointId),
    });
    const persisted = repository.appendRule({
      goalId: goal.id,
      expectedRevision: input.expectedRevision,
      ruleText: input.ruleText,
      sourceMessageId: input.sourceMessageId ?? `request:${input.requestId}`,
    });
    const response = growthGuideResponseSchema.parse({
      goalId: goal.id,
      persistedRevision: persisted.revision,
      currentCycleRevision: boundaryCycle.ruleRevision,
      appliesAt: "next_cycle_boundary",
      nextCycleSequence: boundaryCycle.sequence + 1,
      nextCycleKind: "revision",
      focusKinds: estimated.focusKinds,
      status: "persisted_pending_boundary",
    });
    return response;
  }

  #advance(input: {
    request: GrowthAdvanceRequest;
    goal: GrowthGoal;
    context: GrowthWorkspaceContext;
    repository: GrowthRepository;
  }): void {
    const cycles = input.repository.listCycles(input.goal.id);
    const current = cycles.at(-1);
    if (current?.status === "running") {
      if (this.#activeCycleRuns.has(current.id)) return;
      new GrowthRunLifecycle(input.context.workspace, this.supervisor).recoverCycle({
        goalId: input.goal.id, cycleId: current.id,
        onPersistedEvent: (event) => this.#publish(event),
      });
      this.#releaseListeners(input.goal.id);
      return;
    }
    if (current?.status === "committed" && this.#activeCycleRuns.has(current.id)) return;
    if (current && ["blocked", "failed", "cancelled", "reconciliation_required"].includes(current.status)) {
      this.#releaseListeners(input.goal.id);
      return;
    }
    if (current?.status === "planned") {
      this.#startPlanned(input, current);
      return;
    }
    const latestIntent = current?.status === "committed" ? input.repository.getCycleIntent(current.id) : null;
    const decision = planGrowthFrontier({
      seedKinds: seedKinds(input.context, input.goal),
      formalCoverageKinds: formalCoverageKinds(input.context, current?.outputCheckpointId ?? input.context.checkpointId),
      currentRuleRevision: input.goal.currentRuleRevision,
      latestCycle: current?.status === "committed" && latestIntent
        ? { status: "committed", ruleRevision: current.ruleRevision, intent: latestIntent }
        : null,
      closureStates: input.repository.listClosureStates(input.goal.id),
    });
    if (decision.state !== "plan") {
      if (decision.state === "content_closed") this.#releaseListeners(input.goal.id);
      return;
    }
    const cycle = this.#createPlannedCycle({
      goal: input.goal,
      repository: input.repository,
      intent: decision.intent,
      inputCheckpointId: current?.outputCheckpointId ?? input.context.checkpointId,
    });
    this.#startPlanned(input, cycle);
  }

  #createPlannedCycle(input: {
    goal: GrowthGoal;
    repository: GrowthRepository;
    intent: { kind: "expand"; focusKinds: [GrowthFocusKind]; resumeFrontier: GrowthFocusKind[] };
    inputCheckpointId: string;
  }): GrowthCycle {
    const sequence = input.goal.currentCycleSequence + 1;
    const cycle = input.repository.beginCycle({
      id: `${input.goal.id}:cycle:${sequence}`,
      goalId: input.goal.id,
      idempotencyKey: `${input.goal.id}:cycle:${sequence}`,
      inputCheckpointId: input.inputCheckpointId,
      ruleRevision: input.goal.currentRuleRevision,
      intent: input.intent,
    });
    try {
      const event = input.repository.appendEvent({
        goalId: input.goal.id,
        cycleId: cycle.id,
        runId: null,
        sequence: nextEventSequence(input.repository, input.goal.id),
        safeSummary: "Growth Cycle 已计划，等待绑定 Agent Run。",
        phase: "cycle_planned",
        targetKind: "resource",
        targetId: input.goal.authorizedScopeResourceIds[0],
        targetVersionId: null,
        durableState: "planned",
        contentRef: null,
      });
      this.#publish(event);
    } catch {
      const terminal = input.repository.terminalizeCycle({ cycleId: cycle.id, status: "failed", failureCode: "GROWTH_PLAN_EVENT_PERSISTENCE_FAILED" });
      try {
        const repaired = input.repository.appendEvent({
          goalId: terminal.goalId, cycleId: terminal.id, runId: null,
          sequence: nextEventSequence(input.repository, terminal.goalId),
          safeSummary: "Growth Cycle 计划事件未持久化，已安全停止。",
          phase: "cycle_terminal", targetKind: "resource", targetId: input.goal.authorizedScopeResourceIds[0],
          targetVersionId: null, durableState: terminal.status, contentRef: null,
        });
        this.#publish(repaired);
      } catch { /* Terminal state remains authoritative even if delivery repair cannot persist. */ }
      this.#releaseListeners(input.goal.id);
      throw coordinatorError("GROWTH_PLAN_EVENT_PERSISTENCE_FAILED");
    }
    return cycle;
  }

  #startPlanned(input: {
    request: GrowthAdvanceRequest;
    goal: GrowthGoal;
    context: GrowthWorkspaceContext;
    repository: GrowthRepository;
  }, cycle: GrowthCycle): void {
    const lifecycle = new GrowthRunLifecycle(input.context.workspace, this.supervisor);
    const pinnedRule = input.repository.getRuleRevision(input.goal.id, cycle.ruleRevision);
    const intent = input.repository.getCycleIntent(cycle.id);
    const runId = lifecycle.start({
      goalId: input.goal.id,
      cycleId: cycle.id,
      request: {
        projectId: input.request.projectId,
        sessionId: input.request.sessionId,
        userInput: stagePrompt(cycle.sequence, intent, input.request.seed, pinnedRule.ruleText),
        mode: "free",
        scopeResourceIds: [],
      },
      emit: (event) => {
        try {
          this.#publishAgent(input.goal.id, event);
          this.#onAgentEvent(input, cycle.id, event);
        } catch {
          // Supervisor terminal cleanup must survive Coordinator advancement.
        }
      },
      sessionHistory: this.applicationRegistry.listRecentConversation(input.request.sessionId),
      collaborationContext: this.applicationRegistry.getCollaborationContext(input.request.projectId, input.request.sessionId),
      onPersistedEvent: (event) => this.#publish(event),
    });
    this.#activeCycleRuns.set(cycle.id, runId);
  }

  #onAgentEvent(input: {
    request: GrowthAdvanceRequest;
    goal: GrowthGoal;
    context: GrowthWorkspaceContext;
    repository: GrowthRepository;
  }, cycleId: string, event: AgentRunEvent): void {
    if (event.type !== "run.completed" && event.type !== "run.failed") return;
    const cycle = input.repository.getCycle(cycleId);
    this.#activeCycleRuns.delete(cycleId);
    if (!cycle) return;
    if (cycle.status === "planned") {
      const terminal = input.repository.terminalizeCycle({
        cycleId: cycle.id,
        status: "failed",
        failureCode: "GROWTH_RUN_START_FAILED",
      });
      try {
        const persisted = input.repository.appendEvent({
        goalId: terminal.goalId,
        cycleId: terminal.id,
        runId: terminal.runId,
        sequence: nextEventSequence(input.repository, terminal.goalId),
        safeSummary: "Growth Cycle 未能启动已绑定的 Agent Run。",
        phase: "cycle_terminal",
        targetKind: "resource",
        targetId: input.goal.authorizedScopeResourceIds[0],
        targetVersionId: null,
        durableState: terminal.status,
        contentRef: null,
      });
        this.#publish(persisted);
      } catch { /* Terminal state is authoritative even if event repair storage is unavailable. */ }
      this.#releaseListeners(input.goal.id);
      return;
    }
    if (cycle.status !== "committed") {
      this.#releaseListeners(input.goal.id);
      return;
    }
    this.#advance({ ...input, goal: input.repository.getGoal(input.goal.id) ?? input.goal });
  }

  #snapshot(repository: GrowthRepository, goalId: string, context: GrowthWorkspaceContext) {
    const goal = repository.getGoal(goalId);
    if (!goal) throw coordinatorError("GROWTH_GOAL_NOT_FOUND");
    const cycles = repository.listCycles(goal.id);
    const latestCycle = cycles.at(-1);
    const activeCycle = latestCycle;
    const activeCycleRuleRevision = activeCycle && ["planned", "running", "committed"].includes(activeCycle.status)
      ? activeCycle.ruleRevision
      : null;
    return {
      capabilityVersion: growthCapabilityVersion,
      strategy,
      coordinatorStatus: coordinatorStatus(repository, goal, context, cycles, Boolean(latestCycle && this.#activeCycleRuns.has(latestCycle.id))),
      goal: { id: goal.id, status: goal.status, currentCycleSequence: goal.currentCycleSequence },
      currentRuleRevision: goal.currentRuleRevision,
      activeCycleRuleRevision,
      guidanceStatus: latestCycle && ["planned", "running", "committed"].includes(latestCycle.status)
        && goal.currentRuleRevision > latestCycle.ruleRevision
        ? "persisted_pending_boundary" as const
        : "none" as const,
      cycles: cycles.slice(-100).map((cycle) => ({
        id: cycle.id, sequence: cycle.sequence, runId: cycle.runId, status: cycle.status,
      })),
      events: repository.listEvents(goal.id).slice(-100).map(projectEvent),
    };
  }

  #publish(event: GrowthEvent): void {
    for (const [sessionId, route] of this.#listeners.get(event.goalId)?.entries() ?? []) {
      try {
        const payload: GrowthLiveEvent = growthLiveEventSchema.parse({ sessionId, strategy, event: projectEvent(event) });
        route.growth?.(payload);
      } catch { /* Non-authoritative delivery failure. */ }
    }
  }

  #publishAgent(goalId: string, event: AgentRunEvent): void {
    for (const [sessionId, route] of this.#listeners.get(goalId)?.entries() ?? []) {
      try {
        const projected = agentRunEventSchema.parse({ ...event, sessionId });
        route.agent?.(projected);
      } catch { /* Non-authoritative delivery failure. */ }
    }
  }

  #addListener(goalId: string, sessionId: string, route: DeliveryRoute): void {
    const listeners = this.#listeners.get(goalId) ?? new Map<string, DeliveryRoute>();
    listeners.set(sessionId, route);
    this.#listeners.set(goalId, listeners);
  }

  #releaseListeners(goalId: string): void { this.#listeners.delete(goalId); }

  #assertProjectSession(projectId: string, sessionId: string): void {
    if (this.applicationRegistry.getSession(sessionId).projectId !== projectId) throw coordinatorError("GROWTH_SESSION_PROJECT_MISMATCH");
    if (this.applicationRegistry.getActiveProjectId() !== projectId || this.applicationRegistry.getProject(projectId).state !== "ready") {
      throw coordinatorError("GROWTH_PROJECT_NOT_ACTIVE");
    }
  }

  #requiredContext(projectId: string): GrowthWorkspaceContext {
    const context = this.workspaceSession.getGrowthCoordinatorContext();
    const project = this.applicationRegistry.getProject(projectId);
    if (!context || path.resolve(context.rootPath) !== path.resolve(project.rootPath) || context.authorizedScopeResourceIds.length === 0) {
      throw coordinatorError("GROWTH_WORKSPACE_REQUIRED");
    }
    return context;
  }
}

function goalIdFor(requestId: string): string { return `growth-goal:${requestId}`; }
function nextEventSequence(repository: GrowthRepository, goalId: string): number {
  const last = repository.listEvents(goalId).at(-1);
  return last ? last.sequence + 1 : 1;
}
function projectEvent(event: GrowthEvent) {
  return {
    goalId: event.goalId, cycleId: event.cycleId, runId: event.runId, sequence: event.sequence,
    phase: event.phase, durableState: event.durableState, safeSummary: event.safeSummary,
    targetKind: event.targetKind, targetId: event.targetId, targetVersionId: event.targetVersionId, contentRef: event.contentRef,
  };
}
function stagePrompt(sequence: number, intent: GrowthCycleIntent, seed: GrowthStartRequest["seed"], initialRuleText: string): string {
  const seedText = seed.kind === "text" ? `\n用户种子：${seed.text}` : "\n用户种子已保存为授权资料；先检索后创作。";
  return `Growth 策略 ${strategy}，第 ${sequence} 个 Cycle。锁定规则：${initialRuleText}\n持久 Intent：${intent.kind}；有序 focus：${intent.focusKinds.join("、")}；后续 frontier：${intent.resumeFrontier.join("、") || "等待闭环证据"}。先使用 growth_v1 检索证据；本 Cycle 至多经一个现有 Change Set 持久化模型生成的内容。${seedText}`;
}
function coordinatorStatus(
  repository: GrowthRepository,
  goal: GrowthGoal,
  context: GrowthWorkspaceContext,
  cycles: GrowthCycle[],
  hasActiveRun: boolean,
): "running" | "awaiting_guidance" | "completed" | "blocked" | "failed" | "cancelled" | "reconciliation_required" {
  const current = cycles.at(-1);
  if (hasActiveRun || current?.status === "planned" || current?.status === "running") return "running";
  if (current && current.status !== "committed") return current.status;
  const latestIntent = current ? repository.getCycleIntent(current.id) : null;
  const decision = planGrowthFrontier({
    seedKinds: seedKinds(context, goal),
    formalCoverageKinds: formalCoverageKinds(context, current?.outputCheckpointId ?? context.checkpointId),
    currentRuleRevision: goal.currentRuleRevision,
    latestCycle: current && latestIntent
      ? { status: "committed", ruleRevision: current.ruleRevision, intent: latestIntent }
      : null,
    closureStates: repository.listClosureStates(goal.id),
  });
  if (decision.state === "content_closed") return "completed";
  if (decision.state === "awaiting_guidance") return "awaiting_guidance";
  return "running";
}
function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function coordinatorError(code: string): Error & { code: string } {
  return Object.assign(new Error("Growth coordinator request rejected."), { code });
}

function seedKinds(context: GrowthWorkspaceContext, goal: GrowthGoal): GrowthFocusKind[] {
  if (goal.seed.kind === "text") return [];
  const resources = new ResourceRepository(context.workspace);
  const resourceId = goal.seed.kind === "resource"
    ? goal.seed.resourceId
    : new DocumentRepository(context.workspace).getVersion(goal.seed.sourceVersionId)?.resourceId;
  if (!resourceId) throw coordinatorError("GROWTH_SEED_REFERENCE_INVALID");
  const resource = resources.listAtCheckpoint(context.checkpointId).find((candidate) => candidate.id === resourceId);
  return resource
    && (resource.type === "world" || resource.type === "story" || resource.type === "oc")
    && resource.objectKind === resource.type
    ? [resource.type]
    : [];
}

function formalCoverageKinds(context: GrowthWorkspaceContext, checkpointId: string): GrowthFocusKind[] {
  const resources = new ResourceRepository(context.workspace).listAtCheckpoint(checkpointId);
  return (["world", "story", "oc"] as const).filter((kind) => resources.some((resource) => (
    resource.type === kind && resource.objectKind === kind
  )));
}

function exactRuleReplay(repository: GrowthRepository, input: GrowthGuideRequest): boolean {
  try {
    const revision = repository.getRuleRevision(input.goalId, input.expectedRevision + 1);
    return revision.ruleText === input.ruleText
      && revision.sourceMessageId === (input.sourceMessageId ?? `request:${input.requestId}`);
  } catch {
    return false;
  }
}
