import path from "node:path";
import { GrowthRepository } from "../domain/growth/growthRepository";
import type { ApplicationRegistryRepository } from "../domain/application/applicationRegistryRepository";
import {
  growthCapabilityVersion,
  type GrowthCycle,
  type GrowthEvent,
  type GrowthGoal,
} from "../shared/growthContract";
import {
  agentRunEventSchema,
  growthGetResponseSchema,
  growthLiveEventSchema,
  growthStartResponseSchema,
  type AgentRunEvent,
  type GrowthGetRequest,
  type GrowthGetResponse,
  type GrowthLiveEvent,
  type GrowthStartRequest,
  type GrowthStartResponse,
} from "../shared/ipcContract";
import { GrowthRunLifecycle } from "./growthRunLifecycle";
import type { AgentProcessSupervisor } from "./agentProcessSupervisor";
import type { WorkspaceSession } from "./workspaceIpc";

interface GrowthWorkspaceContext {
  workspace: import("../domain/workspace/workspaceRepository").WorkspaceDatabase;
  rootPath: string;
  branchId: string;
  checkpointId: string;
  authorizedScopeResourceIds: string[];
}

const strategy = "grow_world_story_oc_v1" as const;
interface DeliveryRoute {
  growth?: (event: GrowthLiveEvent) => void;
  agent?: (event: AgentRunEvent) => void;
}
const cycleInstructions = [
  "从种子与检索证据建立或反推世界因果、地理与时空结构、历史、规则和关键关系。",
  "从最新世界与冲突证据生成正式故事或事件链，并建立必要的 uses_world 与 related_to。",
  "从最新故事事件生长主要 OC 的来历、动机与关系，并建立必要的 uses_oc 与 related_to。",
] as const;

/** Main-authoritative, bounded three-Cycle Growth orchestration. */
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
    this.#advance({ input, goal, context, repository });
    return growthStartResponseSchema.parse(this.#snapshot(repository, goal.id));
  }

  get(input: GrowthGetRequest): GrowthGetResponse {
    this.#assertProjectSession(input.projectId, input.sessionId);
    const context = this.#requiredContext(input.projectId);
    const repository = new GrowthRepository(context.workspace);
    const goal = repository.getGoal(input.goalId);
    if (!goal) throw coordinatorError("GROWTH_GOAL_NOT_FOUND");
    this.#recoverStaleCycle(context, goal, input.sessionId);
    return growthGetResponseSchema.parse(this.#snapshot(repository, goal.id));
  }

  #advance(input: {
    input: GrowthStartRequest;
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
      return;
    }
    if (current && ["blocked", "failed", "cancelled", "reconciliation_required"].includes(current.status)) {
      this.#releaseListeners(input.goal.id);
      return;
    }
    if (current?.status === "planned") {
      this.#startPlanned(input, current);
      return;
    }
    if (current?.status === "committed" && current.sequence >= cycleInstructions.length) {
      this.#releaseListeners(input.goal.id);
      return;
    }

    const sequence = (current?.sequence ?? 0) + 1;
    const cycle = input.repository.beginCycle({
      id: `${input.goal.id}:cycle:${sequence}`,
      goalId: input.goal.id,
      idempotencyKey: `${input.goal.id}:cycle:${sequence}`,
      inputCheckpointId: current?.outputCheckpointId ?? input.context.checkpointId,
      ruleRevision: input.goal.currentRuleRevision,
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
    this.#startPlanned(input, cycle);
  }

  #startPlanned(input: {
    input: GrowthStartRequest;
    goal: GrowthGoal;
    context: GrowthWorkspaceContext;
    repository: GrowthRepository;
  }, cycle: GrowthCycle): void {
    const lifecycle = new GrowthRunLifecycle(input.context.workspace, this.supervisor);
    const runId = lifecycle.start({
      goalId: input.goal.id,
      cycleId: cycle.id,
      request: {
        projectId: input.input.projectId,
        sessionId: input.input.sessionId,
        userInput: stagePrompt(cycle.sequence, input.input.seed, input.input.initialRuleText),
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
      sessionHistory: this.applicationRegistry.listRecentConversation(input.input.sessionId),
      collaborationContext: this.applicationRegistry.getCollaborationContext(input.input.projectId, input.input.sessionId),
      onPersistedEvent: (event) => this.#publish(event),
    });
    this.#activeCycleRuns.set(cycle.id, runId);
  }

  #onAgentEvent(input: {
    input: GrowthStartRequest;
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
    if (coordinatorStatus(input.repository.listCycles(input.goal.id)) === "completed") this.#releaseListeners(input.goal.id);
  }

  #snapshot(repository: GrowthRepository, goalId: string) {
    const goal = repository.getGoal(goalId);
    if (!goal) throw coordinatorError("GROWTH_GOAL_NOT_FOUND");
    return {
      capabilityVersion: growthCapabilityVersion,
      strategy,
      coordinatorStatus: coordinatorStatus(repository.listCycles(goal.id)),
      goal: { id: goal.id, status: goal.status, currentCycleSequence: goal.currentCycleSequence },
      cycles: repository.listCycles(goal.id).slice(-100).map((cycle) => ({
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

  #recoverStaleCycle(context: GrowthWorkspaceContext, goal: GrowthGoal, _sessionId: string): void {
    const repository = new GrowthRepository(context.workspace);
    const cycle = repository.listCycles(goal.id).at(-1);
    if (cycle?.status !== "running" || this.#activeCycleRuns.has(cycle.id)) return;
    new GrowthRunLifecycle(context.workspace, this.supervisor).recoverCycle({
      goalId: goal.id, cycleId: cycle.id, onPersistedEvent: (event) => this.#publish(event),
    });
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
function stagePrompt(sequence: number, seed: GrowthStartRequest["seed"], initialRuleText: string): string {
  const seedText = seed.kind === "text" ? `\n用户种子：${seed.text}` : "\n用户种子已保存为授权资料；先检索后创作。";
  return `Growth 策略 ${strategy}，第 ${sequence} 个 Cycle。锁定规则：${initialRuleText}\n${cycleInstructions[sequence - 1] ?? ""} 先使用 growth_v1 检索证据；仅经一个现有 Change Set 持久化模型生成的内容。${seedText}`;
}
function coordinatorStatus(cycles: GrowthCycle[]): "running" | "completed" | "blocked" | "failed" | "cancelled" | "reconciliation_required" {
  const current = cycles.at(-1);
  if (!current || current.status === "planned" || current.status === "running") return "running";
  if (current.status === "committed") return current.sequence >= cycleInstructions.length ? "completed" : "running";
  return current.status;
}
function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function coordinatorError(code: string): Error & { code: string } {
  return Object.assign(new Error("Growth coordinator request rejected."), { code });
}
