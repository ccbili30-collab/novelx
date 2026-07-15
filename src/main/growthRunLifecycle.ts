import type { AgentRunEvent, AgentRunStartRequest } from "../shared/ipcContract";
import {
  growthCapabilityVersion,
  type GrowthCycle,
  type GrowthEvent,
  type GrowthGoal,
} from "../shared/growthContract";
import {
  growthRunBindingSchema,
  growthRetrieveGraphEvidenceArgsSchema,
  growthRetrieveGraphEvidenceResultSchema,
  type AgentCollaborationContext,
  type AgentSessionHistory,
  type AgentRetrieveGraphEvidenceArgs,
  type GrowthRunBinding,
  type GrowthRetrieveGraphEvidenceResult,
  type ProposeChangeSetArgs,
  type ProposeChangeSetResult,
} from "../shared/agentWorkerProtocol";
import { GrowthRepository } from "../domain/growth/growthRepository";
import { GraphRetrievalService } from "../domain/retrieval/graphRetrievalService";
import { CheckpointRepository } from "../domain/version/checkpointRepository";
import { DocumentRepository } from "../domain/workspace/documentRepository";
import { ResourceRepository } from "../domain/workspace/resourceRepository";
import type { WorkspaceDatabase } from "../domain/workspace/workspaceRepository";
import {
  AgentProcessSupervisor,
  type AgentRunInternalBinding,
  type GrowthAgentToolGateway,
  type AgentToolGateway,
  type AgentToolInvocationContext,
} from "./agentProcessSupervisor";

export interface GrowthRunLifecycleStart {
  goalId: string;
  cycleId: string;
  request: AgentRunStartRequest;
  emit(event: AgentRunEvent): void;
  sessionHistory?: AgentSessionHistory;
  collaborationContext?: AgentCollaborationContext;
  onPersistedEvent?(event: GrowthEvent): void;
}

/**
 * Main-authoritative entry point for one already-planned Growth Cycle. It is
 * deliberately not registered as Renderer IPC: callers must already possess a
 * validated planned Cycle and an Agent Process Supervisor.
 */
export class GrowthRunLifecycle {
  constructor(
    readonly workspace: WorkspaceDatabase,
    readonly supervisor: AgentProcessSupervisor,
  ) {}

  start(input: GrowthRunLifecycleStart): string {
    const repository = new GrowthRepository(this.workspace);
    const cycle = repository.getCycle(input.cycleId);
    const goal = repository.getGoal(input.goalId);
    if (!cycle || !goal || cycle.goalId !== goal.id || cycle.status !== "planned" || cycle.runId !== null) {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    if (cycle.inputCheckpointId !== this.#activeCheckpoint(goal.branchId) || cycle.ruleRevision !== goal.currentRuleRevision) {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    const binding = growthRunBindingSchema.parse({
      capabilityVersion: growthCapabilityVersion,
      goalId: goal.id,
      cycleId: cycle.id,
      inputCheckpointId: cycle.inputCheckpointId,
      ruleRevision: cycle.ruleRevision,
      authorizedScopeResourceIds: goal.authorizedScopeResourceIds,
      seedResourceIds: trustedSeedResourceIds(this.workspace, goal, cycle.inputCheckpointId),
    });
    const internal = new BoundGrowthRun(this.workspace, binding, goal.branchId, input.onPersistedEvent);
    return this.supervisor.start(
      { ...input.request, scopeResourceIds: binding.authorizedScopeResourceIds },
      input.emit,
      input.sessionHistory,
      input.collaborationContext,
      internal,
    );
  }

  /** Main recovery entry for a Cycle left by a previous Main process. */
  recoverCycle(input: { goalId: string; cycleId: string; onPersistedEvent?: (event: GrowthEvent) => void }): GrowthCycle {
    const repository = new GrowthRepository(this.workspace);
    const goal = repository.getGoal(input.goalId);
    const cycle = repository.getCycle(input.cycleId);
    if (!goal || !cycle || cycle.goalId !== goal.id) {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    if (cycle.status === "committed") {
      const event = repairTerminalEvent(repository, goal, cycle);
      if (event) notifyPersistedEvent(input.onPersistedEvent, event);
      return cycle;
    }
    if (cycle.status === "running") {
      const terminal = repository.terminalizeCycle({
        cycleId: cycle.id,
        status: "reconciliation_required",
        failureCode: "GROWTH_RUN_INTERRUPTED",
      });
      const event = repairTerminalEvent(repository, goal, terminal);
      if (event) notifyPersistedEvent(input.onPersistedEvent, event);
      return terminal;
    }
    if (["blocked", "failed", "cancelled", "reconciliation_required"].includes(cycle.status)) {
      const event = repairTerminalEvent(repository, goal, cycle);
      if (event) notifyPersistedEvent(input.onPersistedEvent, event);
      return cycle;
    }
    throw growthRunError("GROWTH_BINDING_INVALID");
  }

  #activeCheckpoint(branchId: string): string {
    const branch = new CheckpointRepository(this.workspace).getActiveBranch();
    if (branch.id !== branchId) throw growthRunError("GROWTH_BINDING_INVALID");
    return branch.headCheckpointId;
  }
}

class BoundGrowthRun implements AgentRunInternalBinding {
  readonly #repository: GrowthRepository;
  #runId: string | null = null;
  #mode: "free" | "assist" | null = null;
  #receiptRecorded = false;

  constructor(
    workspace: WorkspaceDatabase,
    readonly workerBinding: GrowthRunBinding,
    readonly branchId: string,
    readonly onPersistedEvent: ((event: GrowthEvent) => void) | undefined,
  ) {
    this.#repository = new GrowthRepository(workspace);
    this.#graph = new GraphRetrievalService(workspace);
  }

  readonly #graph: GraphRetrievalService;

  attach(input: { runId: string; gateway: AgentToolGateway; mode: "free" | "assist"; scopeResourceIds: string[] }): GrowthAgentToolGateway {
    if (this.#runId !== null || input.runId.length === 0 || !sameStrings(input.scopeResourceIds, this.workerBinding.authorizedScopeResourceIds)) {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    const attached = this.#repository.attachRun({ cycleId: this.workerBinding.cycleId, runId: input.runId });
    this.#runId = input.runId;
    this.#mode = input.mode;
    try {
      this.#appendEvent(attached, "run_attached", "Growth Cycle 已绑定本次 Agent Run。");
    } catch {
      this.#terminalizeKnownFailure("GROWTH_RUN_ATTACH_FAILED");
      throw growthRunError("GROWTH_PERSISTENCE_FAILED");
    }
    return {
      ...input.gateway,
      retrieveGraphEvidence: (args, context) => this.#retrieve(args, context),
      proposeChangeSet: (args, context) => this.#propose(input.gateway, args, context),
    };
  }

  terminalize(input: { kind: "completed" | "failed" | "cancelled" | "interrupted"; errorCode: string | null }): void {
    const cycle = this.#repository.getCycle(this.workerBinding.cycleId);
    if (!cycle) return;
    if (cycle.status === "committed" || ["blocked", "failed", "cancelled", "reconciliation_required"].includes(cycle.status)) {
      this.#repairTerminalEvent(cycle);
      return;
    }
    const terminal = input.kind === "cancelled"
      ? { status: "cancelled" as const, failureCode: "GROWTH_RUN_CANCELLED", summary: "Growth Cycle 已取消，未提交 Change Set。" }
      : input.kind === "interrupted"
        ? { status: "reconciliation_required" as const, failureCode: "GROWTH_RUN_INTERRUPTED", summary: "Growth Cycle 运行中断，结果需要核对。" }
        : input.kind === "completed"
          ? { status: "blocked" as const, failureCode: "GROWTH_CHANGE_SET_NOT_COMMITTED", summary: "Growth Cycle 未产生已提交的 Free Change Set。" }
          : { status: "failed" as const, failureCode: safeFailureCode(input.errorCode), summary: "Growth Cycle 在提交 Change Set 前失败。" };
    const terminalCycle = this.#repository.terminalizeCycle({ cycleId: cycle.id, status: terminal.status, failureCode: terminal.failureCode });
    this.#repairTerminalEvent(terminalCycle, terminal.summary);
  }

  async #retrieve(args: AgentRetrieveGraphEvidenceArgs, context: AgentToolInvocationContext): Promise<GrowthRetrieveGraphEvidenceResult> {
    const parsed = growthRetrieveGraphEvidenceArgsSchema.safeParse(args);
    if (!parsed.success) throw growthRunError("GROWTH_RETRIEVAL_INPUT_INVALID");
    if (!this.#runMatches(context) || this.#receiptRecorded) throw growthRunError("GROWTH_BINDING_INVALID");
    const { variant: _variant, ...retrievalArgs } = parsed.data;
    let result: ReturnType<GraphRetrievalService["retrieve"]>;
    try {
      result = this.#graph.retrieve({
        id: `growth-receipt-${context.requestId}`,
        cycleId: this.workerBinding.cycleId,
        runId: context.runId,
        toolInvocationId: context.requestId,
        branchId: this.branchId,
        checkpointId: this.workerBinding.inputCheckpointId,
        lens: "creator",
        authorizedScopeResourceIds: this.workerBinding.authorizedScopeResourceIds,
        ...retrievalArgs,
        seedResourceIds: uniqueStrings([...this.workerBinding.seedResourceIds, ...retrievalArgs.seedResourceIds]),
        validTime: null,
        recordedTime: null,
      });
    } catch (error) {
      throw growthRunError(mapGraphRetrievalFailure(error));
    }
    let receipt;
    try {
      receipt = this.#repository.recordReceipt(result.receipt);
    } catch {
      this.#terminalizeKnownFailure("GROWTH_PERSISTENCE_FAILED");
      throw growthRunError("GROWTH_PERSISTENCE_FAILED");
    }
    this.#receiptRecorded = true;
    const cycle = this.#requiredCycle();
    try {
      this.#appendEvent(cycle, "receipt_recorded", "Growth 检索凭证已持久化。", receipt.links[0]?.targetKind, receipt.links[0]?.targetId, receipt.links[0]?.targetVersionId);
    } catch {
      this.#terminalizeReconciliation();
      throw growthRunError("GROWTH_RECONCILIATION_REQUIRED");
    }
    return growthRetrieveGraphEvidenceResultSchema.parse({
      variant: "growth_v1",
      receiptRecorded: true,
      evidence: result.hits.map((hit) => projectEvidence(hit)),
      coverage: {
        state: result.diagnostics.coverage,
        searchedScopeCount: result.effectiveScopeResourceIds.length,
        omittedCount: result.receipt.coverage.omittedCount,
        truncated: result.diagnostics.truncated,
      },
      diagnostics: {
        expandedEdges: result.diagnostics.expandedEdges,
        consumedContentChars: result.diagnostics.consumedContentChars,
      },
    });
  }

  async #propose(gateway: AgentToolGateway, args: ProposeChangeSetArgs, context: AgentToolInvocationContext): Promise<ProposeChangeSetResult> {
    if (!this.#runMatches(context) || !this.#receiptRecorded) throw growthRunError("GROWTH_RETRIEVAL_REQUIRED");
    const result = await gateway.proposeChangeSet(args, context);
    if (result.mode !== context.mode) throw growthRunError("GROWTH_RUN_FAILED");
    if (result.mode === "free" && result.status === "committed") {
      try {
        const committed = this.#repository.attachCommittedChangeSet({ cycleId: this.workerBinding.cycleId, changeSetId: result.changeSetId });
        this.#appendEvent(committed, "change_set_committed", "Growth Cycle 的 Free Change Set 已提交。", "change_set", committed.changeSetId!, committed.outputCheckpointId);
      } catch {
        this.#terminalizeReconciliation();
        throw growthRunError("GROWTH_RECONCILIATION_REQUIRED");
      }
    }
    return result;
  }

  #terminalizeReconciliation(): void {
    const cycle = this.#repository.getCycle(this.workerBinding.cycleId);
    if (!cycle || cycle.status === "committed" || ["blocked", "failed", "cancelled", "reconciliation_required"].includes(cycle.status)) return;
    const terminal = this.#repository.terminalizeCycle({
      cycleId: cycle.id,
      status: "reconciliation_required",
      failureCode: "GROWTH_CHANGE_SET_OUTCOME_UNKNOWN",
    });
    this.#repairTerminalEvent(terminal);
  }

  #runMatches(context: AgentToolInvocationContext): boolean {
    return this.#runId === context.runId && this.#mode === context.mode;
  }

  #terminalizeKnownFailure(failureCode: string): void {
    const cycle = this.#repository.getCycle(this.workerBinding.cycleId);
    if (!cycle || cycle.status !== "running") return;
    try {
      const terminal = this.#repository.terminalizeCycle({ cycleId: cycle.id, status: "failed", failureCode });
      this.#repairTerminalEvent(terminal);
    } catch {
      // The Cycle was already terminalized if this was an event-only failure;
      // recoverCycle will safely repair the missing terminal event.
    }
  }

  #repairTerminalEvent(cycle: GrowthCycle, safeSummary?: string): void {
    const goal = this.#repository.getGoal(this.workerBinding.goalId);
    if (!goal) throw growthRunError("GROWTH_BINDING_INVALID");
    const event = repairTerminalEvent(this.#repository, goal, cycle, safeSummary);
    if (event) notifyPersistedEvent(this.onPersistedEvent, event);
  }

  #requiredCycle(): GrowthCycle {
    const cycle = this.#repository.getCycle(this.workerBinding.cycleId);
    if (!cycle || cycle.runId !== this.#runId || cycle.status !== "running") throw growthRunError("GROWTH_BINDING_INVALID");
    return cycle;
  }

  #appendEvent(
    cycle: GrowthCycle,
    phase: "run_attached" | "receipt_recorded" | "change_set_committed" | "cycle_terminal",
    safeSummary: string,
    targetKind: "resource" | "document" | "assertion" | "relation" | "change_set" = "resource",
    targetId: string = this.workerBinding.authorizedScopeResourceIds[0]!,
    targetVersionId: string | null = null,
  ): GrowthEvent {
    const goal = this.#repository.getGoal(this.workerBinding.goalId);
    if (!goal) throw growthRunError("GROWTH_BINDING_INVALID");
    const event = this.#repository.appendEvent({
      goalId: goal.id,
      cycleId: cycle.id,
      runId: cycle.runId,
      sequence: nextGrowthEventSequence(this.#repository, goal.id),
      safeSummary,
      phase,
      targetKind,
      targetId,
      targetVersionId,
      durableState: cycle.status,
      contentRef: null,
    });
    notifyPersistedEvent(this.onPersistedEvent, event);
    return event;
  }
}

function projectEvidence(hit: ReturnType<GraphRetrievalService["retrieve"]>["hits"][number]) {
  if (hit.targetKind === "resource") return {
    evidenceId: hit.targetVersionId, kind: hit.targetKind, label: hit.resource.title,
    excerpt: hit.stableDocument?.excerpt ?? null,
    resource: { resourceId: hit.resource.id, type: hit.resource.type, objectKind: hit.resource.objectKind },
  };
  if (hit.targetKind === "document") return {
    evidenceId: hit.targetVersionId, kind: hit.targetKind, label: hit.document.title,
    excerpt: hit.document.excerpt,
  };
  if (hit.targetKind === "assertion") return {
    evidenceId: hit.targetVersionId, kind: hit.targetKind, label: `${hit.assertion.subject} ${hit.assertion.predicate}`,
    subject: hit.assertion.subject, predicate: hit.assertion.predicate, object: hit.assertion.object,
  };
  return {
    evidenceId: hit.targetVersionId, kind: hit.targetKind, label: hit.relation.kind,
    relation: {
      kind: hit.relation.kind,
      sourceResourceId: hit.relation.sourceResourceId,
      targetResourceId: hit.relation.targetResourceId,
    },
  };
}

function repairTerminalEvent(repository: GrowthRepository, goal: GrowthGoal, cycle: GrowthCycle, safeSummary?: string): GrowthEvent | null {
  if (cycle.status === "committed") {
    if (!cycle.runId || !cycle.changeSetId || !cycle.outputCheckpointId) throw growthRunError("GROWTH_BINDING_INVALID");
    if (repository.listEvents(goal.id).some((event) => event.cycleId === cycle.id && event.phase === "change_set_committed")) return null;
    return repository.appendEvent({
      goalId: goal.id, cycleId: cycle.id, runId: cycle.runId,
      sequence: nextGrowthEventSequence(repository, goal.id),
      safeSummary: safeSummary ?? "Growth Change Set 已提交并完成恢复核对。",
      phase: "change_set_committed", targetKind: "change_set", targetId: cycle.changeSetId,
      targetVersionId: cycle.outputCheckpointId, durableState: cycle.status, contentRef: null,
    });
  }
  if (!cycle.runId || (cycle.status !== "blocked" && cycle.status !== "failed" && cycle.status !== "cancelled" && cycle.status !== "reconciliation_required")) {
    throw growthRunError("GROWTH_BINDING_INVALID");
  }
  if (repository.listEvents(goal.id).some((event) => event.cycleId === cycle.id && event.phase === "cycle_terminal")) return null;
  return repository.appendEvent({
    goalId: goal.id, cycleId: cycle.id, runId: cycle.runId,
    sequence: nextGrowthEventSequence(repository, goal.id),
    safeSummary: safeSummary ?? terminalSummary(cycle.status),
    phase: "cycle_terminal", targetKind: "resource", targetId: goal.authorizedScopeResourceIds[0]!,
    targetVersionId: null, durableState: cycle.status, contentRef: null,
  });
}

function terminalSummary(status: "blocked" | "failed" | "cancelled" | "reconciliation_required"): string {
  switch (status) {
    case "cancelled": return "Growth Cycle 已取消，未提交 Change Set。";
    case "failed": return "Growth Cycle 在提交 Change Set 前失败。";
    case "blocked": return "Growth Cycle 未产生已提交的 Free Change Set。";
    case "reconciliation_required": return "Growth Cycle 结果需要核对。";
  }
}

function mapGraphRetrievalFailure(error: unknown): "GROWTH_RETRIEVAL_INPUT_INVALID" | "GROWTH_BINDING_INVALID" | "GROWTH_RUN_FAILED" {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
  if (code === "GRAPH_RETRIEVAL_INPUT_INVALID" || code === "GRAPH_RETRIEVAL_BUDGET_INVALID" || code === "GRAPH_RETRIEVAL_SEED_NOT_VISIBLE" || code === "GRAPH_RETRIEVAL_SEED_OUTSIDE_SCOPE") {
    return "GROWTH_RETRIEVAL_INPUT_INVALID";
  }
  if (code === "GRAPH_RETRIEVAL_CHECKPOINT_BRANCH_MISMATCH" || code === "GRAPH_RETRIEVAL_SCOPE_NOT_VISIBLE" || code === "GRAPH_RETRIEVAL_CREATOR_LENS_REQUIRED") {
    return "GROWTH_BINDING_INVALID";
  }
  return "GROWTH_RUN_FAILED";
}

function nextGrowthEventSequence(repository: GrowthRepository, goalId: string): number {
  const events = repository.listEvents(goalId);
  const last = events.at(-1);
  return last ? last.sequence + 1 : 1;
}

function trustedSeedResourceIds(workspace: WorkspaceDatabase, goal: GrowthGoal, checkpointId: string): string[] {
  const seed = goal.seed;
  if (seed.kind === "text") return [];
  if (seed.kind === "resource") return [seed.resourceId];
  const document = new DocumentRepository(workspace).getVersion(seed.sourceVersionId);
  if (!document || document.creativeDocumentId !== seed.sourceDocumentId) throw growthRunError("GROWTH_BINDING_INVALID");
  if (!new ResourceRepository(workspace).listAtCheckpoint(checkpointId).some((resource) => resource.id === document.resourceId)) {
    throw growthRunError("GROWTH_BINDING_INVALID");
  }
  return [document.resourceId];
}

function uniqueStrings(values: string[]): string[] { return [...new Set(values)]; }
function notifyPersistedEvent(listener: ((event: GrowthEvent) => void) | undefined, event: GrowthEvent): void {
  try { listener?.(event); } catch { /* Delivery is non-authoritative after persistence. */ }
}

export function safeFailureCode(value: string | null): string {
  switch (value) {
    case "AGENT_RUN_CANCELLED":
      return "GROWTH_RUN_CANCELLED";
    case "REAL_GM_PROVIDER_REQUIRED":
      return "GROWTH_PROVIDER_CONFIGURATION_FAILED";
    case "PROVIDER_RUNTIME_FAILED":
      return "GROWTH_PROVIDER_RUNTIME_FAILED";
    case "PROVIDER_PROTOCOL_FAILED":
    case "PROVIDER_OUTPUT_INCOMPLETE":
      return "GROWTH_PROVIDER_PROTOCOL_FAILED";
    case "AGENT_TOOLS_REQUIRED":
    case "AGENT_TOOL_UNKNOWN":
    case "AGENT_TOOL_PROTOCOL_FAILED":
    case "AGENT_TOOL_TIMEOUT":
    case "AGENT_TOOL_FAILED":
      return "GROWTH_TOOL_FAILED";
    case "PROMPT_SET_NOT_PUBLISHED":
    case "AGENT_AUDIT_REQUIRED":
    case "AGENT_CONTEXT_BUDGET_EXCEEDED":
    case "AGENT_RUN_FAILED":
    case "AGENT_WORKER_INTERRUPTED":
      return "GROWTH_AGENT_RUNTIME_FAILED";
    default:
      return "GROWTH_RUN_FAILED";
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function growthRunError(code: "GROWTH_BINDING_INVALID" | "GROWTH_RETRIEVAL_INPUT_INVALID" | "GROWTH_PERSISTENCE_FAILED" | "GROWTH_RETRIEVAL_REQUIRED" | "GROWTH_RECONCILIATION_REQUIRED" | "GROWTH_RUN_FAILED"): Error & { code: string } {
  return Object.assign(new Error("Growth Run bridge failed."), { code });
}
