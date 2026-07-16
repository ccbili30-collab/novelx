import type { AgentRunEvent, AgentRunStartRequest } from "../shared/ipcContract";
import { createHash } from "node:crypto";
import { canonicalAuditHash } from "../domain/audit/canonicalAuditHash";
import {
  growthCapabilityVersion,
  type GrowthClosureFacetResult,
  type GrowthCycle,
  type GrowthCycleIntent,
  type GrowthEvent,
  type GrowthGoal,
} from "../shared/growthContract";
import {
  growthRunBindingSchema,
  growthRetrieveGraphEvidenceArgsSchema,
  growthRetrieveGraphEvidenceResultSchema,
  submitClosureCheckerReviewArgsSchema,
  submitClosureCheckerReviewResultSchema,
  submitClosureSelfAssessmentArgsSchema,
  submitClosureSelfAssessmentResultSchema,
  type AgentCollaborationContext,
  type AgentSessionHistory,
  type AgentRetrieveGraphEvidenceArgs,
  type GrowthRunBinding,
  type GrowthRetrieveGraphEvidenceResult,
  type SubmitClosureCheckerReviewArgs,
  type SubmitClosureCheckerReviewResult,
  type SubmitClosureSelfAssessmentArgs,
  type SubmitClosureSelfAssessmentResult,
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
import { GROWTH_CLOSURE_FACETS, GrowthClosureEvaluator } from "../domain/growth/growthClosureEvaluator";
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
import { GrowthLongformAuthorityResolver } from "./growth/phases/longform/growthLongformAuthorityResolver";
import { assertGrowthLongformProposalAllowed } from "./growth/phases/longform/growthLongformProposalPolicy";
import { GrowthClosureAuthorityResolver } from "./growth/phases/closure/growthClosureAuthorityResolver";
import { assertGrowthRepairProposalAllowed } from "./growth/phases/closure/growthRepairTargetPolicy";
import { GrowthRevisionAuthorityResolver } from "./growth/phases/revision/growthRevisionAuthorityResolver";
import { assertGrowthRevisionProposalAllowed } from "./growth/phases/revision/growthRevisionProposalPolicy";

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
    if (intent.kind === "expand" && intent.focusKinds.length !== 1) {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    const isClosureEvaluation = intent.kind === "closure_evaluation";
    const isClosureRepair = intent.kind === "repair";
    if ((isClosureEvaluation || isClosureRepair) && input.request.mode !== "free") throw growthRunError("GROWTH_BINDING_INVALID");
    const closureResolver = new GrowthClosureAuthorityResolver(repository);
    const closureAuthority = isClosureEvaluation
      ? closureResolver.resolveEvaluation({
          goal, cycle, profileId: intent.profileId, revision: intent.revision, checkpointId: intent.checkpointId,
        })
      : null;
    const repairAuthority = isClosureRepair
      ? closureResolver.resolveRepair({ goal, cycle, intent })
      : null;
    const longformResolver = new GrowthLongformAuthorityResolver(this.workspace, repository);
    const longformPhase = longformResolver.resolvePhase(goal, cycle, intent);
    const revisionPrerequisites = intent.kind === "revision"
      ? new GrowthRevisionAuthorityResolver(this.workspace).prerequisites({
          checkpointId: cycle.inputCheckpointId,
          authorizedScopeResourceIds: goal.authorizedScopeResourceIds,
          focusKinds: intent.focusKinds,
        })
      : null;
    const priorInquiryAuthority = isClosureEvaluation || isClosureRepair ? [] : trustedPriorInquiryAuthority(repository, goal.id);
    const longformAuthority = longformPhase ? longformResolver.resolveAuthority(goal, cycle, intent, longformPhase) : null;
    const intentAnchors = revisionPrerequisites?.anchors ?? (isClosureEvaluation || isClosureRepair
      ? []
      : longformAuthority
      ? trustedLongformIntentAnchors(this.workspace, goal, cycle.inputCheckpointId, longformAuthority)
      : trustedIntentAnchors(this.workspace, repository, goal, cycle, intent.focusKinds[0]!));
    const longformSeedResourceIds = longformAuthority?.phase === "outline"
      ? [longformAuthority.mainStoryResourceId, longformAuthority.worldResourceId, longformAuthority.focusOcResourceId]
      : longformAuthority?.phase === "section" ? [longformAuthority.storyResourceId] : [];
    const binding = growthRunBindingSchema.parse({
      capabilityVersion: growthCapabilityVersion,
      goalId: goal.id,
      cycleId: cycle.id,
      kind: intent.kind,
      focusKinds: intent.kind === "closure_evaluation" || intent.kind === "repair" ? [] : intent.focusKinds,
      resumeFrontier: intent.kind === "closure_evaluation" || intent.kind === "repair" ? [] : intent.resumeFrontier,
      inputCheckpointId: cycle.inputCheckpointId,
      ruleRevision: cycle.ruleRevision,
      authorizedScopeResourceIds: goal.authorizedScopeResourceIds,
      seedResourceIds: uniqueStrings([
        ...trustedSeedResourceIds(this.workspace, goal, cycle.inputCheckpointId),
        ...longformSeedResourceIds,
      ]),
      domainRootResourceIds: trustedDomainRoots(this.workspace, cycle.inputCheckpointId, goal.authorizedScopeResourceIds),
      greenfieldCreateAuthorized: intent.kind === "expand" && input.request.mode === "free"
        && cycle.sequence === 1
        && intent.focusKinds[0] === "world"
        && isGreenfieldWorkspaceEmpty(this.workspace),
      priorInquiries: priorInquiryAuthority.map(({ inquiryId: _inquiryId, lifecycleSequence: _sequence, ...inquiry }) => inquiry),
      closureProfile: closureAuthority,
      closureRepair: repairAuthority,
      longformAuthority,
    });
    const internal = new BoundGrowthRun(
      this.workspace,
      binding,
      goal.branchId,
      input.onPersistedEvent,
      intentAnchors,
      revisionPrerequisites?.requiredTargetVersionIds ?? [],
      priorInquiryAuthority,
    );
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
  readonly #workspace: WorkspaceDatabase;
  readonly #repository: GrowthRepository;
  #runId: string | null = null;
  #mode: "free" | "assist" | null = null;
  #receiptRecorded = false;
  #inquirySelected = false;
  #proposalExecutionStarted = false;
  #imageExecutionStarted = false;
  #closureEvaluation: NonNullable<GrowthRetrieveGraphEvidenceResult["closureEvaluation"]> | null = null;
  #closureSelfAssessment: SubmitClosureSelfAssessmentArgs | null = null;
  #closureCheckerReview: SubmitClosureCheckerReviewArgs | null = null;
  #revisionAuthority: GrowthRetrieveGraphEvidenceResult["revisionAuthority"] = null;
  readonly #evidenceRanks = new Map<string, number>();
  readonly #priorInquiries = new Map<string, GrowthPriorInquiryContext>();

  constructor(
    workspace: WorkspaceDatabase,
    readonly workerBinding: GrowthRunBinding,
    readonly branchId: string,
    readonly onPersistedEvent: ((event: GrowthEvent) => void) | undefined,
    readonly intentAnchors: TrustedIntentAnchor[],
    readonly revisionRequiredTargetVersionIds: string[],
    priorInquiryAuthority: Array<GrowthPriorInquiryContext & { localId: string }>,
  ) {
    this.#workspace = workspace;
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
      submitClosureSelfAssessment: (args, context) => this.#submitClosureSelfAssessment(args, context),
      submitClosureCheckerReview: (args, context) => this.#submitClosureCheckerReview(args, context),
      proposeChangeSet: (args, context) => this.#propose(input.gateway, args, context),
      generateImage: (args, context) => this.#generate(input.gateway, args, context),
    };
  }

  terminalize(input: { kind: "completed" | "failed" | "cancelled" | "interrupted"; errorCode: string | null }): void {
    const cycle = this.#repository.getCycle(this.workerBinding.cycleId);
    if (!cycle) return;
    if (cycle.status === "evaluated") {
      const event = this.#repository.repairClosureEvaluationEvent(cycle.id);
      notifyPersistedEvent(this.onPersistedEvent, event);
      return;
    }
    if (cycle.status === "committed" || ["blocked", "failed", "cancelled", "reconciliation_required"].includes(cycle.status)) {
      this.#repairTerminalEvent(cycle);
      return;
    }
    if (this.workerBinding.kind === "closure_evaluation" && input.kind === "completed") {
      this.#sealClosureOutcome(cycle);
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
    const requiredTargetVersionIds = uniqueStrings([
      ...this.#requiredClosureTargetVersionIds(),
      ...this.revisionRequiredTargetVersionIds,
    ]);
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
        requiredTargetVersionIds,
        resultBudget: Math.max(retrievalArgs.resultBudget, requiredTargetVersionIds.length + this.intentAnchors.length),
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
    let closureEvaluation: GrowthRetrieveGraphEvidenceResult["closureEvaluation"] = null;
    if (this.workerBinding.kind === "closure_evaluation") {
      try {
        closureEvaluation = this.#projectClosureEvaluation(result);
        this.#closureEvaluation = closureEvaluation;
      } catch {
        this.#terminalizeKnownFailure("GROWTH_CLOSURE_SUBMISSION_INVALID");
        throw growthRunError("GROWTH_CLOSURE_SUBMISSION_INVALID");
      }
    }
    let revisionAuthority: GrowthRetrieveGraphEvidenceResult["revisionAuthority"] = null;
    if (this.workerBinding.kind === "revision") {
      try {
        revisionAuthority = new GrowthRevisionAuthorityResolver(this.#workspace)
          .resolve(this.workerBinding.inputCheckpointId, result.hits);
        this.#revisionAuthority = revisionAuthority;
      } catch {
        this.#terminalizeKnownFailure("GROWTH_BINDING_INVALID");
        throw growthRunError("GROWTH_BINDING_INVALID");
      }
    }
    const cycle = this.#requiredCycle();
    try {
      this.#appendEvent(
        cycle,
        "receipt_recorded",
        this.workerBinding.kind === "revision"
          ? "正在分析新规则会影响哪些已检索节点。"
          : "Growth 检索凭证已持久化。",
        receipt.links[0]?.targetKind,
        receipt.links[0]?.targetId,
        receipt.links[0]?.targetVersionId,
      );
    } catch {
      this.#terminalizeReconciliation();
      throw growthRunError("GROWTH_RECONCILIATION_REQUIRED");
    }
    return growthRetrieveGraphEvidenceResultSchema.parse({
      variant: "growth_v1",
      receiptRecorded: true,
      receiptId: receipt.id,
      revisionAuthority,
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
      closureEvaluation,
    });
  }

  #projectClosureEvaluation(
    retrieval: ReturnType<GraphRetrievalService["retrieve"]>,
  ): NonNullable<GrowthRetrieveGraphEvidenceResult["closureEvaluation"]> {
    const closure = this.workerBinding.closureProfile;
    if (this.workerBinding.kind !== "closure_evaluation" || closure === null) {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    const evaluated = new GrowthClosureEvaluator(this.#workspace).evaluate({
      checkpointId: this.workerBinding.inputCheckpointId,
      profileKind: closure.profileKind,
      subjectResourceId: closure.subjectResourceId,
      componentProfiles: closure.componentProfiles,
      focusOcResourceId: closure.focusOcResourceId,
    });
    const evaluatedById = new Map(evaluated.facetResults.map((facet) => [facet.facetId, facet]));
    const retrievalCoverage = retrieval.diagnostics.coverage === "complete" && !retrieval.diagnostics.truncated
      ? "complete" as const
      : retrieval.diagnostics.coverage === "unknown" ? "unknown" as const : "partial" as const;
    const facetResults = closure.requiredContentFacetIds.map((facetId) => {
      const facet = evaluatedById.get(facetId);
      if (!facet) {
        return {
          facetId,
          state: "missing" as const,
          coverage: "unknown" as const,
          safeSummary: `${facetId} is not available in the deterministic Closure evaluator.`,
          evidenceIds: [],
        };
      }
      const evidenceIds = facet.evidence.map((evidence) => evidence.targetVersionId);
      const evidencePinned = evidenceIds.length > 0
        && new Set(evidenceIds).size === evidenceIds.length
        && evidenceIds.every((evidenceId) => this.#evidenceRanks.has(evidenceId));
      const satisfied = facet.state === "satisfied" && evidencePinned;
      return {
        facetId,
        state: satisfied ? "satisfied" as const : "missing" as const,
        coverage: satisfied ? retrievalCoverage : facet.state === "missing" ? retrievalCoverage : "partial" as const,
        safeSummary: satisfied
          ? `${facetId} is supported by pinned Closure evidence.`
          : `${facetId} remains incomplete at this checkpoint.`,
        evidenceIds: satisfied ? evidenceIds : [],
      };
    });
    return {
      profileId: closure.profileId,
      revision: closure.revision,
      profileKind: closure.profileKind,
      deterministicContentReady: facetResults.every((facet) => facet.state === "satisfied"),
      facetResults,
    };
  }

  #requiredClosureTargetVersionIds(): string[] {
    if (this.workerBinding.longformAuthority?.phase === "section") {
      const authority = this.workerBinding.longformAuthority;
      const selected = authority.sections.find((section) => section.localId === authority.selectedSectionId);
      if (!selected) throw growthRunError("GROWTH_BINDING_INVALID");
      return uniqueStrings([
        authority.outlineDocumentVersionId,
        ...selected.evidenceIds,
        ...authority.priorProseEvidenceIds,
      ]);
    }
    if (this.workerBinding.kind === "repair") {
      const repair = this.workerBinding.closureRepair;
      if (!repair) throw growthRunError("GROWTH_BINDING_INVALID");
      return [...repair.targetEvidenceIds];
    }
    const closure = this.workerBinding.closureProfile;
    if (this.workerBinding.kind !== "closure_evaluation") return [];
    if (!closure) throw growthRunError("GROWTH_BINDING_INVALID");
    const evaluated = new GrowthClosureEvaluator(this.#workspace).evaluate({
      checkpointId: this.workerBinding.inputCheckpointId,
      profileKind: closure.profileKind,
      subjectResourceId: closure.subjectResourceId,
      componentProfiles: closure.componentProfiles,
      focusOcResourceId: closure.focusOcResourceId,
    });
    const required = new Set(closure.requiredContentFacetIds);
    return uniqueStrings(evaluated.facetResults
      .filter((facet) => required.has(facet.facetId))
      .flatMap((facet) => facet.evidence.map((evidence) => evidence.targetVersionId)));
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

  async #submitClosureSelfAssessment(
    args: SubmitClosureSelfAssessmentArgs,
    context: AgentToolInvocationContext,
  ): Promise<SubmitClosureSelfAssessmentResult> {
    const parsed = submitClosureSelfAssessmentArgsSchema.safeParse(args);
    if (!parsed.success || !this.#runMatches(context) || !this.#receiptRecorded
      || this.workerBinding.kind !== "closure_evaluation" || !this.#closureEvaluation
      || this.#closureSelfAssessment !== null) {
      throw growthRunError("GROWTH_CLOSURE_SUBMISSION_INVALID");
    }
    if (parsed.data.decision === "ready_for_checker" && !this.#closureEvaluation.deterministicContentReady) {
      throw growthRunError("GROWTH_CLOSURE_NOT_READY");
    }
    this.#requiredCycle();
    this.#closureSelfAssessment = parsed.data;
    return submitClosureSelfAssessmentResultSchema.parse({
      status: parsed.data.decision === "ready_for_checker" ? "checker_required" : "continue_growing",
      deterministicContentReady: this.#closureEvaluation.deterministicContentReady,
      facetResults: this.#closureEvaluation.facetResults,
    });
  }

  async #submitClosureCheckerReview(
    args: SubmitClosureCheckerReviewArgs,
    context: AgentToolInvocationContext,
  ): Promise<SubmitClosureCheckerReviewResult> {
    const parsed = submitClosureCheckerReviewArgsSchema.safeParse(args);
    if (!parsed.success || !this.#runMatches(context) || this.workerBinding.kind !== "closure_evaluation"
      || !this.#closureEvaluation?.deterministicContentReady
      || this.#closureSelfAssessment?.decision !== "ready_for_checker"
      || this.#closureCheckerReview !== null) {
      throw growthRunError("GROWTH_CLOSURE_SUBMISSION_INVALID");
    }
    const allowedEvidence = new Set(this.#closureEvaluation.facetResults.flatMap((facet) => facet.evidenceIds));
    if (parsed.data.adverseFindings.some((finding) => finding.evidenceIds.some((evidenceId) => !allowedEvidence.has(evidenceId)))) {
      throw growthRunError("GROWTH_CLOSURE_SUBMISSION_INVALID");
    }
    this.#requiredCycle();
    this.#closureCheckerReview = parsed.data;
    return submitClosureCheckerReviewResultSchema.parse({ status: "recorded", decision: parsed.data.decision });
  }

  #sealClosureOutcome(cycle: GrowthCycle): void {
    const closure = this.workerBinding.closureProfile;
    const receiptId = cycle.receiptId;
    if (this.workerBinding.kind !== "closure_evaluation" || !closure || !receiptId || !this.#closureEvaluation
      || !this.#closureSelfAssessment || (this.#closureSelfAssessment.decision === "ready_for_checker" && !this.#closureCheckerReview)
      || (this.#closureSelfAssessment.decision === "continue_growing" && this.#closureCheckerReview !== null)) {
      this.#terminalizeKnownFailure("GROWTH_CLOSURE_SUBMISSION_INVALID");
      return;
    }
    const facetResults: GrowthClosureFacetResult[] = this.#closureEvaluation.facetResults.map((facet) => ({
      facetId: facet.facetId,
      state: facet.state,
      coverage: facet.coverage,
      safeSummary: facet.safeSummary,
      evidence: facet.evidenceIds.map((evidenceId) => ({ receiptId, rank: this.#requiredEvidenceRank(evidenceId) })),
    }));
    let durableAssessmentWritten = false;
    try {
      const stewardInvocation = this.#requiredInvocationTerminal("steward");
      const stewardId = stableClosureId("steward", cycle.id);
      const steward = this.#repository.appendClosureStewardSubmission({
        id: stewardId,
        profileId: closure.profileId,
        revision: closure.revision,
        role: "steward",
        decision: this.#closureSelfAssessment.decision,
        cycleId: cycle.id,
        checkpointId: cycle.inputCheckpointId,
        ruleRevision: cycle.ruleRevision,
        receiptId,
        agentInvocationId: stewardInvocation.invocationId,
        outputSha256: stewardInvocation.outputSha256,
        idempotencyKey: stableClosureId("steward-key", cycle.id),
        facetResults,
      });
      durableAssessmentWritten = true;
      if (this.#closureSelfAssessment.decision === "continue_growing") {
        this.#repository.sealClosureEvaluationOutcome({
          id: stableClosureId("outcome", cycle.id),
          cycleId: cycle.id,
          profileId: closure.profileId,
          revision: closure.revision,
          receiptId,
          stewardAssessmentId: steward.id,
          checkerAssessmentId: null,
          reviewId: null,
          decision: "continue_growing",
          idempotencyKey: stableClosureId("outcome-key", cycle.id),
        });
      } else {
        const checkerArgs = this.#closureCheckerReview!;
        const checkerInvocation = this.#requiredInvocationTerminal("checker");
        if (checkerInvocation.invocationId === stewardInvocation.invocationId) {
          throw growthRunError("GROWTH_CLOSURE_SUBMISSION_INVALID");
        }
        const adverseFindings = checkerArgs.adverseFindings.map((finding, index) => {
          const targetEvidence = finding.evidenceIds
            .map((evidenceId) => ({ receiptId, rank: this.#requiredEvidenceRank(evidenceId) }))
            .sort((left, right) => left.rank - right.rank);
          const semantic = {
            severity: finding.severity,
            category: finding.category,
            targetEvidence,
            safeSummary: finding.safeSummary,
            repairObjective: finding.repairObjective,
          };
          return {
            id: stableClosureId(`finding-${index + 1}`, cycle.id),
            fingerprint: canonicalAuditHash(semantic),
            ...semantic,
          };
        });
        const checker = this.#repository.appendClosureCheckerSubmission({
          id: stableClosureId("checker", cycle.id),
          profileId: closure.profileId,
          revision: closure.revision,
          role: "checker",
          decision: checkerArgs.decision,
          cycleId: cycle.id,
          checkpointId: cycle.inputCheckpointId,
          ruleRevision: cycle.ruleRevision,
          receiptId,
          agentInvocationId: checkerInvocation.invocationId,
          outputSha256: checkerInvocation.outputSha256,
          idempotencyKey: stableClosureId("checker-key", cycle.id),
          adverseFindings,
        });
        const review = this.#repository.sealClosureReviewV4({
          id: stableClosureId("review", cycle.id),
          profileId: closure.profileId,
          revision: closure.revision,
          stewardAssessmentId: steward.id,
          checkerAssessmentId: checker.id,
          idempotencyKey: stableClosureId("review-key", cycle.id),
          facetResults,
          adverseFindings,
        });
        this.#repository.sealClosureEvaluationOutcome({
          id: stableClosureId("outcome", cycle.id),
          cycleId: cycle.id,
          profileId: closure.profileId,
          revision: closure.revision,
          receiptId,
          stewardAssessmentId: steward.id,
          checkerAssessmentId: checker.id,
          reviewId: review.id,
          decision: checkerArgs.decision,
          idempotencyKey: stableClosureId("outcome-key", cycle.id),
        });
      }
      const event = this.#repository.repairClosureEvaluationEvent(cycle.id);
      notifyPersistedEvent(this.onPersistedEvent, event);
    } catch {
      const current = this.#repository.getCycle(cycle.id);
      if (current?.status === "evaluated") {
        const event = this.#repository.repairClosureEvaluationEvent(cycle.id);
        notifyPersistedEvent(this.onPersistedEvent, event);
        return;
      }
      if (durableAssessmentWritten) {
        this.#terminalizeClosureReconciliation();
      } else {
        this.#terminalizeKnownFailure("GROWTH_CLOSURE_SUBMISSION_INVALID");
      }
    }
  }

  #requiredEvidenceRank(evidenceId: string): number {
    const rank = this.#evidenceRanks.get(evidenceId);
    if (rank === undefined) throw growthRunError("GROWTH_CLOSURE_SUBMISSION_INVALID");
    return rank;
  }

  #requiredInvocationTerminal(role: "steward" | "checker"): { invocationId: string; outputSha256: string } {
    if (!this.#runId) throw growthRunError("GROWTH_CLOSURE_SUBMISSION_INVALID");
    const rows = this.#workspace.db.prepare(`
      SELECT invocations.id AS invocation_id, events.output_sha256
      FROM agent_invocations invocations
      JOIN agent_audit_events events ON events.invocation_id = invocations.id
      WHERE invocations.run_id = ? AND invocations.role = ?
        AND events.entity_type = 'invocation' AND events.terminal = 1
        AND events.event_type = 'completed' AND events.error_code IS NULL
      ORDER BY invocations.id
    `).all(this.#runId, role) as Array<{ invocation_id: string; output_sha256: string | null }>;
    if (rows.length !== 1 || typeof rows[0]!.output_sha256 !== "string") {
      throw growthRunError("GROWTH_CLOSURE_SUBMISSION_INVALID");
    }
    return { invocationId: rows[0]!.invocation_id, outputSha256: rows[0]!.output_sha256 };
  }

  async #propose(gateway: AgentToolGateway, args: ProposeChangeSetArgs, context: AgentToolInvocationContext): Promise<ProposeChangeSetResult> {
    const contentInquiryRequired = this.workerBinding.kind === "expand" || this.workerBinding.kind === "revision";
    if (!this.#runMatches(context) || !this.#receiptRecorded || (contentInquiryRequired && !this.#inquirySelected)) {
      throw growthRunError(contentInquiryRequired ? "GROWTH_INQUIRY_REQUIRED" : "GROWTH_BINDING_INVALID");
    }
    if (this.#proposalExecutionStarted) throw growthRunError("GROWTH_RUN_FAILED");
    const cycle = this.#requiredCycle();
    if (this.workerBinding.kind === "repair") this.#assertBoundedRepairProposal(cycle, args);
    if (this.workerBinding.kind === "revision") this.#assertBoundedRevisionProposal(args);
    if (this.workerBinding.longformAuthority) {
      const receipt = cycle.receiptId ? this.#repository.getReceipt(cycle.receiptId) : null;
      if (!receipt) throw growthRunError("GROWTH_BINDING_INVALID");
      assertGrowthLongformProposalAllowed({ binding: this.workerBinding, receipt, proposal: args });
    }
    const { growthRevisionImpact, ...gatewayArgs } = args;
    this.#proposalExecutionStarted = true;
    const result = await gateway.proposeChangeSet(gatewayArgs, this.workerBinding.longformAuthority?.phase === "outline"
      ? { ...context, longformCreateAuthorized: true }
      : context);
    if (result.mode !== context.mode) throw growthRunError("GROWTH_RUN_FAILED");
    if (result.mode === "free" && result.status === "committed") {
      try {
        if (this.workerBinding.kind === "revision") {
          this.#markRevisionVisualsStale(growthRevisionImpact?.staleVisualEvidenceIds ?? []);
        }
        const committed = this.#repository.attachCommittedChangeSet({ cycleId: this.workerBinding.cycleId, changeSetId: result.changeSetId });
        this.#appendEvent(
          committed,
          "change_set_committed",
          this.workerBinding.kind === "revision"
            ? "新规则的影响分析已提交，受影响对象已修改。"
            : "Growth Cycle 的 Free Change Set 已提交。",
          "change_set",
          committed.changeSetId!,
          committed.outputCheckpointId,
        );
      } catch {
        this.#terminalizeReconciliation();
        throw growthRunError("GROWTH_RECONCILIATION_REQUIRED");
      }
    }
    return result;
  }

  #assertBoundedRepairProposal(cycle: GrowthCycle, args: ProposeChangeSetArgs): void {
    const repair = this.workerBinding.closureRepair;
    const receipt = cycle.receiptId ? this.#repository.getReceipt(cycle.receiptId) : null;
    if (!repair || !receipt) throw growthRunError("GROWTH_BINDING_INVALID");
    try {
      assertGrowthRepairProposalAllowed({
        workspace: this.#workspace,
        checkpointId: cycle.inputCheckpointId,
        receiptLinks: receipt.links,
        targetEvidenceIds: repair.targetEvidenceIds,
        proposal: args,
      });
    } catch {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
  }

  #assertBoundedRevisionProposal(args: ProposeChangeSetArgs): void {
    if (!this.#revisionAuthority) throw growthRunError("GROWTH_BINDING_INVALID");
    try {
      assertGrowthRevisionProposalAllowed({
        cycleId: this.workerBinding.cycleId,
        domainRootResourceIds: this.workerBinding.domainRootResourceIds,
        authority: this.#revisionAuthority,
        proposal: args,
      });
    } catch {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
  }

  #markRevisionVisualsStale(evidenceIds: string[]): void {
    if (evidenceIds.length === 0) return;
    const placeholders = evidenceIds.map(() => "?").join(", ");
    const rows = this.#workspace.db.prepare(`
      SELECT DISTINCT items.id, items.anchor_hash
      FROM growth_illustration_items items
      JOIN growth_illustration_requests requests ON requests.id = items.request_id
      JOIN growth_illustration_item_sources sources ON sources.item_id = items.id
      WHERE requests.goal_id = ? AND items.status <> 'stale'
        AND (sources.resource_version_id IN (${placeholders})
          OR sources.document_version_id IN (${placeholders}))
      ORDER BY items.id
    `).all(this.workerBinding.goalId, ...evidenceIds, ...evidenceIds) as Array<{ id: string; anchor_hash: string }>;
    for (const row of rows) {
      this.#repository.markIllustrationItemStale({ itemId: row.id, expectedAnchorHash: row.anchor_hash });
    }
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
    if (!cycle || cycle.status === "committed" || cycle.status === "evaluated"
      || ["blocked", "failed", "cancelled", "reconciliation_required"].includes(cycle.status)) return;
    const terminal = this.#repository.terminalizeCycle({
      cycleId: cycle.id,
      status: "reconciliation_required",
      failureCode: "GROWTH_CHANGE_SET_OUTCOME_UNKNOWN",
    });
    this.#repairTerminalEvent(terminal);
  }

  #terminalizeClosureReconciliation(): void {
    const cycle = this.#repository.getCycle(this.workerBinding.cycleId);
    if (!cycle || cycle.status === "committed" || cycle.status === "evaluated"
      || ["blocked", "failed", "cancelled", "reconciliation_required"].includes(cycle.status)) return;
    const terminal = this.#repository.terminalizeCycle({
      cycleId: cycle.id,
      status: "reconciliation_required",
      failureCode: "GROWTH_CLOSURE_OUTCOME_UNKNOWN",
    });
    this.#repairTerminalEvent(terminal, "Closure evaluation outcome requires reconciliation.");
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

function trustedLongformIntentAnchors(
  workspace: WorkspaceDatabase,
  goal: GrowthGoal,
  checkpointId: string,
  authority: NonNullable<GrowthRunBinding["longformAuthority"]>,
): TrustedIntentAnchor[] {
  const resourceIds = authority.phase === "outline"
    ? [authority.mainStoryResourceId, authority.worldResourceId, authority.focusOcResourceId]
    : [authority.storyResourceId];
  const visible = new ResourceRepository(workspace).listAtCheckpoint(checkpointId);
  const byId = new Map(visible.map((resource) => [resource.id, resource]));
  return uniqueStrings(resourceIds).map((resourceId) => {
    const resource = byId.get(resourceId);
    if (!resource || (!goal.authorizedScopeResourceIds.includes(resourceId)
      && !isDescendantOfAuthorizedScope(resourceId, goal.authorizedScopeResourceIds, visible))) {
      throw growthRunError("GROWTH_BINDING_INVALID");
    }
    return { resourceId, title: resource.title };
  });
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

function stableClosureId(kind: string, cycleId: string): string {
  return `growth-closure-${kind}:${sha256(cycleId).slice(0, 40)}`;
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

function growthRunError(code: "GROWTH_BINDING_INVALID" | "GROWTH_RETRIEVAL_INPUT_INVALID" | "GROWTH_PERSISTENCE_FAILED" | "GROWTH_RETRIEVAL_REQUIRED" | "GROWTH_INQUIRY_REQUIRED" | "GROWTH_INQUIRY_INVALID" | "GROWTH_INQUIRY_STALLED" | "GROWTH_RECONCILIATION_REQUIRED" | "GROWTH_RUN_FAILED" | "GROWTH_CLOSURE_NOT_READY" | "GROWTH_CLOSURE_SUBMISSION_INVALID"): Error & { code: string } {
  return Object.assign(new Error("Growth Run bridge failed."), { code });
}
