import type { AgentRunEvent, AgentRunStartRequest } from "../shared/ipcContract";
import { createHash } from "node:crypto";
import { canonicalAuditHash } from "../domain/audit/canonicalAuditHash";
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
  submitGrowthInquiryArgsSchema,
  submitGrowthInquiryResultSchema,
  type SubmitGrowthInquiryArgs,
  type SubmitGrowthInquiryResult,
  type GenerateImageArgs,
  type GenerateImageResult,
} from "../shared/agentWorkerProtocol";
import { GrowthRepository, type GrowthPriorInquiryContext } from "../domain/growth/growthRepository";
import { GraphRetrievalService } from "../domain/retrieval/graphRetrievalService";
import { CheckpointRepository } from "../domain/version/checkpointRepository";
import { DocumentRepository } from "../domain/workspace/documentRepository";
import { ResourceRepository } from "../domain/workspace/resourceRepository";
import { isGreenfieldWorkspaceEmpty } from "../domain/changeSet/workspaceChangeSetPolicy";
import { ChangeSetRepository } from "../domain/changeSet/changeSetRepository";
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
    if (cycle.inputCheckpointId !== this.#activeCheckpoint(goal.branchId)) {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    try {
      const pinnedRule = repository.getRuleRevision(cycle.goalId, cycle.ruleRevision);
      if (pinnedRule.goalId !== cycle.goalId || pinnedRule.revision !== cycle.ruleRevision) {
        throw growthRunError("GROWTH_BINDING_INVALID");
      }
    } catch {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    const intent = repository.getCycleIntent(cycle.id);
    if (intent.kind === "closure_evaluation" || intent.kind === "repair") {
      const terminal = repository.terminalizeCycle({
        cycleId: cycle.id, status: "blocked", failureCode: "GROWTH_CLOSURE_EXECUTION_NOT_IMPLEMENTED",
      });
      const event = repairTerminalEvent(repository, goal, terminal, "Closure evaluation/repair 执行路径尚未接入，已安全阻塞。");
      if (event) notifyPersistedEvent(input.onPersistedEvent, event);
      throw growthRunError("GROWTH_CLOSURE_EXECUTION_NOT_IMPLEMENTED");
    }
    if (intent.kind === "expand" && intent.focusKinds.length !== 1) {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    if (intent.kind === "revision") {
      const terminal = repository.terminalizeCycle({
        cycleId: cycle.id, status: "blocked", failureCode: "GROWTH_REVISION_EXECUTION_NOT_IMPLEMENTED",
      });
      const event = repairTerminalEvent(repository, goal, terminal, "修订 Cycle 执行路径尚未接入，已安全阻塞。");
      if (event) notifyPersistedEvent(input.onPersistedEvent, event);
      throw growthRunError("GROWTH_REVISION_EXECUTION_NOT_IMPLEMENTED");
    }
    const intentAnchors = trustedIntentAnchors(this.workspace, repository, goal, cycle, intent.focusKinds[0]!);
    const priorInquiryAuthority = trustedPriorInquiryAuthority(repository, goal.id);
    const binding = growthRunBindingSchema.parse({
      capabilityVersion: growthCapabilityVersion,
      goalId: goal.id,
      cycleId: cycle.id,
      kind: intent.kind,
      focusKinds: intent.focusKinds,
      resumeFrontier: intent.resumeFrontier,
      inputCheckpointId: cycle.inputCheckpointId,
      ruleRevision: cycle.ruleRevision,
      authorizedScopeResourceIds: goal.authorizedScopeResourceIds,
      seedResourceIds: trustedSeedResourceIds(this.workspace, goal, cycle.inputCheckpointId),
      domainRootResourceIds: trustedDomainRoots(this.workspace, cycle.inputCheckpointId, goal.authorizedScopeResourceIds),
      greenfieldCreateAuthorized: input.request.mode === "free"
        && cycle.sequence === 1
        && intent.focusKinds[0] === "world"
        && isGreenfieldWorkspaceEmpty(this.workspace),
      priorInquiries: priorInquiryAuthority.map(({ inquiryId: _inquiryId, lifecycleSequence: _sequence, ...inquiry }) => inquiry),
    });
    const internal = new BoundGrowthRun(this.workspace, binding, goal.branchId, input.onPersistedEvent, intentAnchors, priorInquiryAuthority);
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
    if (cycle.status === "evaluated") {
      const event = repository.repairClosureEvaluationEvent(cycle.id);
      notifyPersistedEvent(input.onPersistedEvent, event);
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
  #inquirySelected = false;
  #proposalExecutionStarted = false;
  #imageExecutionStarted = false;
  readonly #evidenceRanks = new Map<string, number>();
  readonly #priorInquiries = new Map<string, GrowthPriorInquiryContext>();

  constructor(
    workspace: WorkspaceDatabase,
    readonly workerBinding: GrowthRunBinding,
    readonly branchId: string,
    readonly onPersistedEvent: ((event: GrowthEvent) => void) | undefined,
    readonly intentAnchors: TrustedIntentAnchor[],
    priorInquiryAuthority: Array<GrowthPriorInquiryContext & { localId: string }>,
  ) {
    this.#repository = new GrowthRepository(workspace);
    this.#graph = new GraphRetrievalService(workspace);
    for (const inquiry of priorInquiryAuthority) this.#priorInquiries.set(inquiry.localId, inquiry);
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
      submitGrowthInquiry: (args, context) => this.#submitInquiry(args, context),
      proposeChangeSet: (args, context) => this.#propose(input.gateway, args, context),
      generateImage: (args, context) => this.#generate(input.gateway, args, context),
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
        aliases: uniqueStrings([...retrievalArgs.aliases, ...this.intentAnchors.map((anchor) => anchor.title)]),
        seedResourceIds: uniqueStrings([...this.workerBinding.seedResourceIds, ...retrievalArgs.seedResourceIds, ...this.intentAnchors.map((anchor) => anchor.resourceId)]),
        requiredResourceIds: this.intentAnchors.map((anchor) => anchor.resourceId),
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
    const projectedEvidence = result.hits.map((hit) => projectEvidence(hit));
    if (projectedEvidence.length !== receipt.links.length
      || new Set(projectedEvidence.map((evidence) => evidence.evidenceId)).size !== projectedEvidence.length
      || projectedEvidence.some((evidence, index) => evidence.evidenceId !== receipt.links[index]?.targetVersionId)) {
      this.#terminalizeKnownFailure("GROWTH_INQUIRY_EVIDENCE_MAPPING_INVALID");
      throw growthRunError("GROWTH_INQUIRY_INVALID");
    }
    projectedEvidence.forEach((evidence, index) => this.#evidenceRanks.set(evidence.evidenceId, receipt.links[index]!.rank));
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
      evidence: projectedEvidence,
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

  async #submitInquiry(args: SubmitGrowthInquiryArgs, context: AgentToolInvocationContext): Promise<SubmitGrowthInquiryResult> {
    if (!this.#runMatches(context) || !this.#receiptRecorded) {
      throw growthRunError("GROWTH_INQUIRY_REQUIRED");
    }
    const parsed = submitGrowthInquiryArgsSchema.safeParse(args);
    if (!parsed.success) throw growthRunError("GROWTH_INQUIRY_INVALID");
    const cycle = this.#requiredInquiryCycle();
    let trusted;
    try {
      trusted = compileTrustedInquirySeal(parsed.data, cycle, this.#evidenceRanks, this.#priorInquiries);
    } catch {
      this.#terminalizeKnownFailure("GROWTH_INQUIRY_INVALID");
      throw growthRunError("GROWTH_INQUIRY_INVALID");
    }
    let batch;
    let existingBatch;
    try {
      existingBatch = this.#repository.getInquiryBatch(trusted.id);
      batch = this.#repository.sealInquiryBatch(trusted);
    } catch (error) {
      if (readErrorCode(error) !== "GROWTH_INQUIRY_STALLED") {
        this.#terminalizeKnownFailure("GROWTH_INQUIRY_INVALID");
        throw growthRunError("GROWTH_INQUIRY_INVALID");
      }
      throw growthRunError("GROWTH_INQUIRY_STALLED");
    }
    if (batch.contractVersion !== "v25") throw growthRunError("GROWTH_INQUIRY_INVALID");
    const frontierInquiryId = batch.creatorChoiceRequiredInquiryId ?? batch.selectedInquiryId;
    const frontier = batch.questions.find((question) => question.id === frontierInquiryId);
    const event = this.#repository.listEvents(cycle.goalId).find((candidate) => (
      candidate.cycleId === cycle.id
      && candidate.targetKind === "inquiry"
      && candidate.targetId === frontierInquiryId
      && (candidate.phase === "inquiry_selected" || candidate.phase === "creator_choice_required")
    ));
    if (!frontier || !event || event.safeSummary !== frontier.safeSummary) {
      this.#terminalizeReconciliation();
      throw growthRunError("GROWTH_RECONCILIATION_REQUIRED");
    }
    if (!existingBatch) notifyPersistedEvent(this.onPersistedEvent, event);
    if (batch.selectedInquiryId !== null) this.#inquirySelected = true;
    return submitGrowthInquiryResultSchema.parse({
      status: batch.creatorChoiceRequiredInquiryId === null ? "selected" : "creator_choice_required",
      safeSummary: frontier.safeSummary,
    });
  }

  async #propose(gateway: AgentToolGateway, args: ProposeChangeSetArgs, context: AgentToolInvocationContext): Promise<ProposeChangeSetResult> {
    if (!this.#runMatches(context) || !this.#receiptRecorded || !this.#inquirySelected) throw growthRunError("GROWTH_INQUIRY_REQUIRED");
    if (this.#proposalExecutionStarted) throw growthRunError("GROWTH_RUN_FAILED");
    this.#requiredCycle();
    this.#proposalExecutionStarted = true;
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

  async #generate(gateway: AgentToolGateway, args: GenerateImageArgs, context: AgentToolInvocationContext): Promise<GenerateImageResult> {
    if (!this.#runMatches(context) || !this.#receiptRecorded || !this.#inquirySelected) {
      throw growthRunError("GROWTH_INQUIRY_REQUIRED");
    }
    if (this.#imageExecutionStarted) throw growthRunError("GROWTH_RUN_FAILED");
    const cycle = this.#repository.getCycle(this.workerBinding.cycleId);
    if (this.workerBinding.focusKinds.length !== 1
      || this.workerBinding.focusKinds[0] !== "world"
      || args.purpose !== "world_map"
      || !cycle
      || cycle.runId !== this.#runId
      || cycle.status !== "committed"
      || cycle.changeSetId === null
      || cycle.outputCheckpointId === null) {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    this.#imageExecutionStarted = true;
    return gateway.generateImage(args, context);
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

  #requiredInquiryCycle(): GrowthCycle {
    const cycle = this.#repository.getCycle(this.workerBinding.cycleId);
    if (!cycle || cycle.runId !== this.#runId) throw growthRunError("GROWTH_BINDING_INVALID");
    if (cycle.status === "running") return cycle;
    if (cycle.status === "blocked" && cycle.failureCode === "GROWTH_CREATOR_CHOICE_REQUIRED") return cycle;
    throw growthRunError("GROWTH_BINDING_INVALID");
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
  if (cycle.status !== "blocked" && cycle.status !== "failed" && cycle.status !== "cancelled" && cycle.status !== "reconciliation_required") {
    throw growthRunError("GROWTH_BINDING_INVALID");
  }
  if (cycle.status === "blocked" && cycle.failureCode === "GROWTH_CREATOR_CHOICE_REQUIRED"
    && repository.listEvents(goal.id).some((event) => event.cycleId === cycle.id && event.phase === "creator_choice_required")) {
    return null;
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
  if (code === "GRAPH_RETRIEVAL_CHECKPOINT_BRANCH_MISMATCH" || code === "GRAPH_RETRIEVAL_SCOPE_NOT_VISIBLE" || code === "GRAPH_RETRIEVAL_CREATOR_LENS_REQUIRED" || code === "GRAPH_RETRIEVAL_REQUIRED_RESOURCE_INVALID") {
    return "GROWTH_BINDING_INVALID";
  }
  return "GROWTH_RUN_FAILED";
}

function nextGrowthEventSequence(repository: GrowthRepository, goalId: string): number {
  const events = repository.listEvents(goalId);
  const last = events.at(-1);
  return last ? last.sequence + 1 : 1;
}

interface TrustedIntentAnchor {
  resourceId: string;
  title: string;
}

function trustedPriorInquiryAuthority(
  repository: GrowthRepository,
  goalId: string,
): Array<GrowthPriorInquiryContext & { localId: string }> {
  const prior = repository.listUnresolvedInquiryContexts(goalId);
  if (prior.length > 100) throw growthRunError("GROWTH_BINDING_INVALID");
  return prior.map((inquiry, index) => ({ ...inquiry, localId: `prior_${index + 1}` }));
}

function compileTrustedInquirySeal(
  brief: SubmitGrowthInquiryArgs,
  cycle: GrowthCycle,
  evidenceRanks: ReadonlyMap<string, number>,
  priorInquiries: ReadonlyMap<string, GrowthPriorInquiryContext>,
) {
  const localIds = new Set<string>();
  const formalIds = new Map<string, string>();
  const questions = brief.inquiries.map((inquiry, index) => {
    if (localIds.has(inquiry.localId) || new Set(inquiry.evidenceIds).size !== inquiry.evidenceIds.length) {
      throw growthRunError("GROWTH_INQUIRY_INVALID");
    }
    localIds.add(inquiry.localId);
    const ranks = inquiry.evidenceIds.map((evidenceId) => {
      const rank = evidenceRanks.get(evidenceId);
      if (rank === undefined) throw growthRunError("GROWTH_INQUIRY_INVALID");
      return rank;
    }).sort((left, right) => left - right);
    if (inquiry.evidenceState !== "unknown" && ranks.length === 0) throw growthRunError("GROWTH_INQUIRY_INVALID");
    if (inquiry.evidenceState === "unknown" && !inquiry.requiresCreatorChoice && inquiry.provisionalAssumption === null) {
      throw growthRunError("GROWTH_INQUIRY_INVALID");
    }
    const id = `growth-inquiry:${sha256(`${cycle.id}:${index + 1}`).slice(0, 40)}`;
    formalIds.set(inquiry.localId, id);
    const question = normalizeInquiryText(inquiry.question);
    return {
      id,
      question,
      evidenceState: inquiry.evidenceState,
      safeSummary: normalizeInquiryText(inquiry.safeSummary),
      proposedAction: normalizeInquiryText(inquiry.proposedAction),
      provisionalAssumption: inquiry.provisionalAssumption === null ? null : normalizeInquiryText(inquiry.provisionalAssumption),
      requiresCreatorChoice: inquiry.requiresCreatorChoice,
      priority: inquiry.priority,
      fingerprint: canonicalAuditHash({ question, ranks, ruleRevision: cycle.ruleRevision }),
      evidenceRanks: ranks,
    };
  });
  if (new Set(questions.map((question) => question.fingerprint)).size !== questions.length) {
    throw growthRunError("GROWTH_INQUIRY_INVALID");
  }
  const highestPriority = Math.max(...questions.map((question) => question.priority));
  if (questions.filter((question) => question.priority === highestPriority).length !== 1) {
    throw growthRunError("GROWTH_INQUIRY_INVALID");
  }
  const choiceQuestions = questions.filter((question) => question.requiresCreatorChoice);
  const selectedInquiryId = brief.selectedLocalId === null ? null : formalIds.get(brief.selectedLocalId) ?? null;
  const selected = questions.find((question) => question.id === selectedInquiryId);
  let creatorChoiceRequiredInquiryId: string | null = null;
  if (brief.selectedLocalId === null) {
    if (choiceQuestions.length !== 1 || choiceQuestions[0]!.priority !== highestPriority) throw growthRunError("GROWTH_INQUIRY_INVALID");
    creatorChoiceRequiredInquiryId = choiceQuestions[0]!.id;
  } else if (!selected || selected.priority !== highestPriority || choiceQuestions.length !== 0) {
    throw growthRunError("GROWTH_INQUIRY_INVALID");
  }
  const transitioned = new Set<string>();
  const priorTransitions = brief.priorTransitions.map((transition) => {
    const prior = priorInquiries.get(transition.priorLocalId);
    if (!prior || transitioned.has(prior.inquiryId)) throw growthRunError("GROWTH_INQUIRY_INVALID");
    transitioned.add(prior.inquiryId);
    if (transition.phase === "promoted") {
      const successorInquiryId = formalIds.get(transition.successorLocalId);
      if (!successorInquiryId) throw growthRunError("GROWTH_INQUIRY_INVALID");
      return { inquiryId: prior.inquiryId, expectedSequence: prior.lifecycleSequence, phase: transition.phase, successorInquiryId } as const;
    }
    return transition.phase === "closed"
      ? { inquiryId: prior.inquiryId, expectedSequence: prior.lifecycleSequence, phase: transition.phase, reason: transition.reason } as const
      : { inquiryId: prior.inquiryId, expectedSequence: prior.lifecycleSequence, phase: transition.phase } as const;
  });
  return {
    id: `growth-inquiry-batch:${sha256(cycle.id).slice(0, 40)}`,
    cycleId: cycle.id,
    idempotencyKey: `growth-inquiry-seal:${sha256(cycle.id).slice(0, 40)}`,
    selectedInquiryId,
    creatorChoiceRequiredInquiryId,
    questions,
    priorTransitions,
  };
}

function normalizeInquiryText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readErrorCode(value: unknown): string | null {
  return value && typeof value === "object" && "code" in value && typeof value.code === "string" ? value.code : null;
}

/**
 * Intent prerequisites come from formal resources visible at the pinned
 * checkpoint. A preceding Cycle still has to expose a valid committed resource
 * output, but it no longer dictates a sequence-derived phase.
 */
function trustedIntentAnchors(
  workspace: WorkspaceDatabase,
  repository: GrowthRepository,
  goal: GrowthGoal,
  cycle: GrowthCycle,
  focusKind: "world" | "story" | "oc",
): TrustedIntentAnchor[] {
  if (focusKind === "world") return [];
  const prior = repository.listCycles(goal.id).find((candidate) => candidate.sequence === cycle.sequence - 1);
  const resources = new ResourceRepository(workspace);
  if (prior) {
    if (prior.status !== "committed" || !prior.changeSetId || !prior.outputCheckpointId
      || prior.outputCheckpointId !== cycle.inputCheckpointId) {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    const visibleOutputs = new ChangeSetRepository(workspace).listOutputs(prior.changeSetId)
      .filter((output) => output.kind === "resource_revision")
      .map((output) => resources.getVisibleByRevisionIdAtCheckpoint(output.outputId, cycle.inputCheckpointId))
      .filter((resource): resource is NonNullable<typeof resource> => Boolean(resource));
    if (visibleOutputs.length === 0) throw growthRunError("GROWTH_BINDING_INVALID");
  }
  const expected = focusKind === "story"
    ? { type: "world" as const, objectKind: "world" as const }
    : { type: "story" as const, objectKind: "story" as const };
  const allResources = resources.listAtCheckpoint(cycle.inputCheckpointId);
  const matches = allResources.filter((resource) => resource.type === expected.type && resource.objectKind === expected.objectKind)
    .filter((resource) => goal.authorizedScopeResourceIds.includes(resource.id)
      || isDescendantOfAuthorizedScope(resource.id, goal.authorizedScopeResourceIds, allResources));
  if (matches.length === 0) return [];
  if (matches.length !== 1) throw growthRunError("GROWTH_BINDING_INVALID");
  const anchor = matches[0]!;
  if (!goal.authorizedScopeResourceIds.some((scopeId) => scopeId === anchor.id)
    && !isDescendantOfAuthorizedScope(anchor.id, goal.authorizedScopeResourceIds, resources.listAtCheckpoint(cycle.inputCheckpointId))) {
    throw growthRunError("GROWTH_BINDING_INVALID");
  }
  return [{ resourceId: anchor.id, title: anchor.title }];
}

function isDescendantOfAuthorizedScope(resourceId: string, scopeIds: string[], resources: ReturnType<ResourceRepository["listAtCheckpoint"]>): boolean {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  let current = byId.get(resourceId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (scopeIds.includes(current.id)) return true;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
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

function trustedDomainRoots(workspace: WorkspaceDatabase, checkpointId: string, authorizedScopeResourceIds: string[]): { world: string; oc: string; story: string } {
  const roots = new ResourceRepository(workspace).listAtCheckpoint(checkpointId).filter((resource) => resource.objectKind === "domain_root");
  const select = (type: "world" | "oc" | "story"): string => {
    const matches = roots.filter((resource) => resource.type === type && authorizedScopeResourceIds.includes(resource.id));
    if (matches.length !== 1) throw growthRunError("GROWTH_BINDING_INVALID");
    return matches[0]!.id;
  };
  const result = { world: select("world"), oc: select("oc"), story: select("story") };
  if (new Set(Object.values(result)).size !== 3) throw growthRunError("GROWTH_BINDING_INVALID");
  return result;
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

function growthRunError(code: "GROWTH_BINDING_INVALID" | "GROWTH_RETRIEVAL_INPUT_INVALID" | "GROWTH_PERSISTENCE_FAILED" | "GROWTH_RETRIEVAL_REQUIRED" | "GROWTH_INQUIRY_REQUIRED" | "GROWTH_INQUIRY_INVALID" | "GROWTH_INQUIRY_STALLED" | "GROWTH_RECONCILIATION_REQUIRED" | "GROWTH_RUN_FAILED" | "GROWTH_REVISION_EXECUTION_NOT_IMPLEMENTED" | "GROWTH_CLOSURE_EXECUTION_NOT_IMPLEMENTED"): Error & { code: string } {
  return Object.assign(new Error("Growth Run bridge failed."), { code });
}
