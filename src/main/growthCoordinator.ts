import path from "node:path";
import { createHash } from "node:crypto";
import { GrowthRepository } from "../domain/growth/growthRepository";
import { GROWTH_CLOSURE_FACETS } from "../domain/growth/growthClosureEvaluator";
import type { ApplicationRegistryRepository } from "../domain/application/applicationRegistryRepository";
import {
  growthCapabilityVersion,
  type GrowthCycle,
  type GrowthContentCycleIntent,
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
import type {
  GrowthIllustrationCancelRequest,
  GrowthIllustrationCreateRequest,
  GrowthPresentationInspectRequest,
  GrowthPresentationSnapshot,
} from "../shared/growthPresentationContract";
import { GrowthRunLifecycle, readGrowthRunStartDiagnosticCode } from "./growthRunLifecycle";
import { GrowthLongformCoordinator } from "./growth/phases/longform/growthLongformCoordinator";
import { planGrowthClosureContinuation } from "./growth/phases/closure/growthClosureContinuationPlanner";
import { syncClosureProfilesAfterRevision } from "./growth/phases/revision/growthRevisionClosureSync";
import { estimateRevisionIntent, planGrowthFrontier, type GrowthFocusKind } from "./growthFrontierPlanner";
import type { AgentProcessSupervisor } from "./agentProcessSupervisor";
import type { WorkspaceSession } from "./workspaceIpc";
import { DocumentRepository } from "../domain/workspace/documentRepository";
import { ResourceRepository } from "../domain/workspace/resourceRepository";
import { ChangeSetRepository, type ChangeSetItemRecord } from "../domain/changeSet/changeSetRepository";
import { GrowthPresentationProjector } from "./growth/growthPresentationProjector";
import { GrowthIllustrationApplicationService } from "./growth/illustration/growthIllustrationApplicationService";
import { SafeDiagnosticRepository } from "../domain/audit/safeDiagnosticRepository";
import { ensureGrowthCycleDiagnostic } from "./diagnostics/growthCycleDiagnostics";
import {
  GrowthEditorialSchedulerApplication,
  type GrowthEditorialScheduler,
  type GrowthEditorialSchedulerOptions,
} from "./growth/editorial/growthEditorialScheduler";
import type { GrowthWorkOrderRunnerDependencies } from "./growth/editorial/growthWorkOrderRunner";

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

type GrowthCycleIntentCreate<T = GrowthCycleIntent> = T extends GrowthCycleIntent
  ? Omit<T, "cycleId" | "provenance">
  : never;

const strategy = "grow_world_story_oc_closure_v4" as const;
interface DeliveryRoute {
  growth?: (event: GrowthLiveEvent) => void;
  agent?: (event: AgentRunEvent) => void;
}
/** Main-authoritative, persisted-Intent Growth orchestration. */
export class GrowthCoordinator {
  readonly #listeners = new Map<string, Map<string, DeliveryRoute>>();
  readonly #activeCycleRuns = new Map<string, string>();
  #illustrationApplication: { workspace: GrowthWorkspaceContext["workspace"]; service: GrowthIllustrationApplicationService } | null = null;
  readonly #editorialApplication = new GrowthEditorialSchedulerApplication();

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
    const creatorChoiceEvent = current?.status === "blocked" && current.failureCode === "GROWTH_CREATOR_CHOICE_REQUIRED"
      ? [...repository.listEvents(goal.id)].reverse().find((event) => event.cycleId === current.id
        && event.phase === "creator_choice_required" && event.targetKind === "inquiry")
      : undefined;
    if (!current || (!["planned", "running", "committed"].includes(current.status) && !creatorChoiceEvent && !replay)) {
      throw coordinatorError("GROWTH_GUIDANCE_NO_NEXT_CYCLE");
    }
    const boundaryCycle = current;
    const currentIntent = repository.getCycleIntent(boundaryCycle.id);
    const coverageKinds = formalCoverageKinds(context, boundaryCycle.outputCheckpointId ?? boundaryCycle.inputCheckpointId);
    const estimated = creatorChoiceEvent && isContentIntent(currentIntent)
      ? creatorChoiceSuccessorIntent(currentIntent, coverageKinds)
      : isContentIntent(currentIntent)
      ? estimateRevisionIntent({ currentIntent, formalCoverageKinds: coverageKinds })
      : { kind: "revision" as const, focusKinds: coverageKinds.length > 0 ? coverageKinds : ["world", "story", "oc"] as GrowthFocusKind[], resumeFrontier: [] };
    const sourceMessageId = input.sourceMessageId ?? `request:${input.requestId}`;
    const persisted = creatorChoiceEvent && !replay
      ? repository.answerCreatorInquiry({
          inquiryId: creatorChoiceEvent.targetId,
          idempotencyKey: `growth-inquiry-answer:${sourceMessageId}`,
          expectedRuleRevision: input.expectedRevision,
          expectedLifecycleSequence: repository.listInquiryLifecycle(creatorChoiceEvent.targetId).at(-1)?.sequence ?? 0,
          answerText: input.ruleText,
          sourceMessageId,
        })
      : repository.appendRule({
          goalId: goal.id,
          expectedRevision: input.expectedRevision,
          ruleText: input.ruleText,
          sourceMessageId,
        });
    const response = growthGuideResponseSchema.parse({
      goalId: goal.id,
      persistedRevision: "ruleRevision" in persisted ? persisted.ruleRevision : persisted.revision,
      currentCycleRevision: boundaryCycle.ruleRevision,
      appliesAt: "next_cycle_boundary",
      nextCycleSequence: boundaryCycle.sequence + 1,
      nextCycleKind: "revision",
      focusKinds: estimated.focusKinds,
      status: "persisted_pending_boundary",
    });
    return response;
  }

  inspect(input: GrowthPresentationInspectRequest): GrowthPresentationSnapshot {
    const context = this.#presentationContext(input.projectId, input.sessionId, input.goalId);
    return new GrowthPresentationProjector(context.workspace).project({ goalId: input.goalId, checkpointId: context.checkpointId });
  }

  illustrate(input: GrowthIllustrationCreateRequest): GrowthPresentationSnapshot {
    const context = this.#presentationContext(input.projectId, input.sessionId, input.goalId);
    this.#illustrationService(context).create(input, context);
    return new GrowthPresentationProjector(context.workspace).project({ goalId: input.goalId, checkpointId: context.checkpointId });
  }

  cancelIllustration(input: GrowthIllustrationCancelRequest): GrowthPresentationSnapshot {
    const context = this.#presentationContext(input.projectId, input.sessionId, input.goalId);
    this.#illustrationService(context).cancel(input);
    return new GrowthPresentationProjector(context.workspace).project({ goalId: input.goalId, checkpointId: context.checkpointId });
  }

  createEditorialScheduler(input: {
    projectId: string;
    sessionId: string;
    dependencies: GrowthWorkOrderRunnerDependencies;
    options?: GrowthEditorialSchedulerOptions;
  }): GrowthEditorialScheduler {
    this.#assertProjectSession(input.projectId, input.sessionId);
    const context = this.#requiredContext(input.projectId);
    return this.#editorialApplication.get(context.workspace, input.dependencies, input.options);
  }

  dispose(): void {
    this.#editorialApplication.dispose();
    this.#illustrationApplication?.service.dispose();
    this.#illustrationApplication = null;
    this.#listeners.clear();
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
    if (current?.status === "evaluated") {
      const outcome = input.repository.getClosureEvaluationOutcomeForCycle(current.id);
      if (!outcome) throw coordinatorError("GROWTH_CLOSURE_OUTCOME_MISSING");
      this.#advanceEvaluated(input, current, outcome);
      return;
    }
    if (current?.status === "blocked" && current.failureCode === "GROWTH_CREATOR_CHOICE_REQUIRED") {
      const choiceEvent = [...input.repository.listEvents(input.goal.id)].reverse().find((event) => event.cycleId === current.id
        && event.phase === "creator_choice_required" && event.targetKind === "inquiry");
      if (choiceEvent && input.repository.getInquiryCreatorAnswer(choiceEvent.targetId)) {
        const priorIntent = input.repository.getCycleIntent(current.id);
        const coverageKinds = formalCoverageKinds(input.context, current.inputCheckpointId);
        const successorIntent = isContentIntent(priorIntent)
          ? creatorChoiceSuccessorIntent(priorIntent, coverageKinds)
          : { kind: "revision" as const, focusKinds: coverageKinds.length > 0 ? coverageKinds : ["world", "story", "oc"] as GrowthFocusKind[], resumeFrontier: [] };
        const successor = this.#createPlannedCycle({
          goal: input.goal,
          repository: input.repository,
          inputCheckpointId: current.inputCheckpointId,
          intent: successorIntent,
        });
        this.#startPlanned(input, successor);
        return;
      }
    }
    if (current && ["blocked", "failed", "cancelled", "reconciliation_required"].includes(current.status)) {
      this.#releaseListeners(input.goal.id);
      return;
    }
    if (current?.status === "planned") {
      this.#startPlanned(input, current);
      return;
    }
    const projectedIntent = current?.status === "committed" ? input.repository.getCycleIntent(current.id) : null;
    if (current?.status === "committed" && projectedIntent?.kind === "repair") {
      this.#advanceCommittedRepair(input, current, projectedIntent);
      return;
    }
    if (current?.status === "committed" && projectedIntent?.kind === "revision") {
      syncClosureProfilesAfterRevision({ repository: input.repository, goal: input.goal, cycle: current, intent: projectedIntent });
    }
    if (current?.status === "committed" && projectedIntent) {
      const longformPlan = new GrowthLongformCoordinator(input.context.workspace, input.repository)
        .afterCommitted({ goal: input.goal, cycle: current, intent: projectedIntent });
      if (longformPlan) {
        const next = this.#createPlannedCycle({
          goal: input.goal,
          repository: input.repository,
          inputCheckpointId: longformPlan.inputCheckpointId,
          intent: longformPlan.intent,
        });
        this.#startPlanned(input, next);
        return;
      }
    }
    const latestIntent = projectedIntent && isContentIntent(projectedIntent) ? projectedIntent : null;
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
      if (decision.state === "awaiting_guidance"
        && current?.status === "committed"
        && current.ruleRevision === input.goal.currentRuleRevision) {
        const profile = ensureDefaultMixedClosureProfile(
          input.context.workspace,
          input.repository,
          input.goal,
          current.outputCheckpointId!,
        );
        if (profile) {
          const evaluation = this.#createPlannedCycle({
            goal: input.goal, repository: input.repository, inputCheckpointId: current.outputCheckpointId!,
            intent: { kind: "closure_evaluation", profileId: profile.id, revision: profile.currentRevision,
              checkpointId: current.outputCheckpointId! },
          });
          this.#startPlanned(input, evaluation);
          return;
        }
      }
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
    intent: GrowthCycleIntentCreate;
    inputCheckpointId: string;
  }): GrowthCycle {
    const sequence = input.goal.currentCycleSequence + 1;
    const isClosureEvaluation = input.intent.kind === "closure_evaluation";
    const isClosureRepair = input.intent.kind === "repair";
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
        safeSummary: isClosureEvaluation
          ? "闭环评估 Cycle 已计划，等待绑定独立检查 Run。"
          : isClosureRepair
          ? "闭环返工 Cycle 已计划，等待绑定修复 Run。"
          : input.intent.kind === "revision"
          ? "内容修订轮已计划，等待绑定 Agent Run。"
          : "Growth Cycle 已计划，等待绑定 Agent Run。",
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

  #advanceCommittedRepair(
    input: { request: GrowthAdvanceRequest; goal: GrowthGoal; context: GrowthWorkspaceContext; repository: GrowthRepository },
    cycle: GrowthCycle,
    intent: Extract<GrowthCycleIntent, { kind: "repair" }>,
  ): void {
    if (!cycle.outputCheckpointId || !input.repository.getClosureRepairLineageForCycle(cycle.id)) {
      throw coordinatorError("GROWTH_CLOSURE_REPAIR_LINEAGE_INVALID");
    }
    const profile = input.repository.getClosureProfile(intent.profileId);
    const revision = input.repository.getClosureRevision(intent.profileId, intent.revision);
    if (!profile || !revision || profile.goalId !== input.goal.id || profile.currentRevision < intent.revision) {
      throw coordinatorError("GROWTH_CLOSURE_REPAIR_LINEAGE_INVALID");
    }
    const nextRevision = input.repository.appendClosureRevision({
      profileId: profile.id,
      expectedRevision: intent.revision,
      idempotencyKey: `closure-revision-after:${cycle.id}`,
      checkpointId: cycle.outputCheckpointId,
      ruleRevision: cycle.ruleRevision,
      componentProfiles: revision.componentProfiles,
      focusOcResourceId: revision.focusOcResourceId,
      contractGeneration: "v26",
      facets: revision.facets,
    });
    const evaluation = this.#createPlannedCycle({
      goal: input.goal, repository: input.repository, inputCheckpointId: cycle.outputCheckpointId,
      intent: { kind: "closure_evaluation", profileId: profile.id, revision: nextRevision.revision,
        checkpointId: cycle.outputCheckpointId },
    });
    this.#startPlanned(input, evaluation);
  }

  #advanceEvaluated(
    input: { request: GrowthAdvanceRequest; goal: GrowthGoal; context: GrowthWorkspaceContext; repository: GrowthRepository },
    cycle: GrowthCycle,
    outcome: NonNullable<ReturnType<GrowthRepository["getClosureEvaluationOutcomeForCycle"]>>,
  ): void {
    const intent = input.repository.getCycleIntent(cycle.id);
    if (intent.kind !== "closure_evaluation" || intent.profileId !== outcome.profileId || intent.revision !== outcome.revision) {
      throw coordinatorError("GROWTH_CLOSURE_OUTCOME_MISSING");
    }
    this.#settlePriorRepair(input.repository, input.goal.id, cycle, outcome.decision, outcome.reviewId);
    if (input.goal.currentRuleRevision > cycle.ruleRevision) {
      const coverageKinds = formalCoverageKinds(input.context, cycle.inputCheckpointId);
      const revision = this.#createPlannedCycle({
        goal: input.goal,
        repository: input.repository,
        inputCheckpointId: cycle.inputCheckpointId,
        intent: {
          kind: "revision",
          focusKinds: coverageKinds.length > 0 ? coverageKinds : ["world", "story", "oc"],
          resumeFrontier: [],
        },
      });
      this.#startPlanned(input, revision);
      return;
    }
    if (input.goal.currentRuleRevision < cycle.ruleRevision) throw coordinatorError("GROWTH_FRONTIER_REVISION_INVALID");
    if (outcome.decision === "continue_growing") {
      const longformPlan = new GrowthLongformCoordinator(input.context.workspace, input.repository)
        .afterEvaluation({ goal: input.goal, cycle, intent, outcome });
      if (longformPlan) {
        const next = this.#createPlannedCycle({
          goal: input.goal,
          repository: input.repository,
          inputCheckpointId: longformPlan.inputCheckpointId,
          intent: longformPlan.intent,
        });
        this.#startPlanned(input, next);
        return;
      }
      const continuation = planGrowthClosureContinuation({
        repository: input.repository,
        goalId: input.goal.id,
        profileId: intent.profileId,
        currentCycleId: cycle.id,
      });
      if (continuation?.state === "plan") {
        const next = this.#createPlannedCycle({
          goal: input.goal,
          repository: input.repository,
          inputCheckpointId: cycle.inputCheckpointId,
          intent: { kind: "revision", focusKinds: continuation.focusKinds, resumeFrontier: [] },
        });
        this.#startPlanned(input, next);
        return;
      }
      if (continuation?.state === "stalled") {
        ensureGrowthCycleDiagnostic({
          workspace: input.context.workspace,
          cycleId: cycle.id,
          runId: cycle.runId,
          code: "GROWTH_CLOSURE_NO_PROGRESS",
        });
      }
    }
    if (outcome.decision === "accepted") {
      this.#illustrationService(input.context).ensureDefaultForAcceptedClosure({
        goalId: input.goal.id,
        cycleId: cycle.id,
      }, input.context);
      this.#releaseListeners(input.goal.id);
      return;
    }
    if (outcome.decision !== "repairs_required") {
      this.#releaseListeners(input.goal.id);
      return;
    }
    const review = outcome.reviewId ? input.repository.getClosureReviewV4(outcome.reviewId) : null;
    const selected = review?.adverseFindings.find((finding) => finding.severity === "blocking")
      ?? review?.adverseFindings.find((finding) => finding.severity === "major")
      ?? null;
    if (!review || !selected || review.profileId !== intent.profileId || review.revision !== intent.revision) {
      throw coordinatorError("GROWTH_CLOSURE_REPAIR_LINEAGE_INVALID");
    }
    const repairCycle = this.#createPlannedCycle({
      goal: input.goal, repository: input.repository, inputCheckpointId: cycle.inputCheckpointId,
      intent: {
        kind: "repair", profileId: review.profileId, revision: review.revision,
        originalReviewId: review.id, selectedFindingId: selected.id,
        selectedFindingFingerprint: selected.fingerprint,
      },
    });
    let lineage;
    try {
      lineage = input.repository.createClosureRepairLineage({
        id: stableCoordinatorId("repair-lineage", repairCycle.id),
        profileId: review.profileId, revision: review.revision, originalReviewId: review.id,
        selectedFindingId: selected.id, selectedFindingFingerprint: selected.fingerprint,
        repairCycleId: repairCycle.id,
        backlogFindingIds: review.adverseFindings.filter((finding) => finding.id !== selected.id).map((finding) => finding.id),
        idempotencyKey: stableCoordinatorId("repair-lineage-key", repairCycle.id),
      });
    } catch {
      const terminal = input.repository.terminalizeCycle({
        cycleId: repairCycle.id, status: "failed", failureCode: "GROWTH_CLOSURE_REPAIR_LINEAGE_INVALID",
      });
      this.#appendTerminalEvent(input, terminal, "Closure repair lineage could not be persisted.");
      this.#releaseListeners(input.goal.id);
      return;
    }
    if (lineage.resolutionState === "stalled") {
      const terminal = input.repository.terminalizeCycle({
        cycleId: repairCycle.id, status: "blocked", failureCode: "GROWTH_CLOSURE_REPAIR_STALLED",
      });
      this.#appendTerminalEvent(input, terminal, "Closure repair stopped after repeated no-progress findings.");
      this.#releaseListeners(input.goal.id);
      return;
    }
    this.#startPlanned(input, repairCycle);
  }

  #settlePriorRepair(
    repository: GrowthRepository,
    goalId: string,
    evaluationCycle: GrowthCycle,
    decision: "continue_growing" | "accepted" | "repairs_required" | "blocked",
    reviewId: string | null,
  ): void {
    const prior = repository.listCycles(goalId).find((candidate) => candidate.sequence === evaluationCycle.sequence - 1);
    if (!prior || repository.getCycleIntent(prior.id).kind !== "repair") return;
    const lineage = repository.getClosureRepairLineageForCycle(prior.id);
    if (!lineage) throw coordinatorError("GROWTH_CLOSURE_REPAIR_LINEAGE_INVALID");
    if (decision === "accepted") {
      if (lineage.resolutionState === "resolved") return;
      if (lineage.resolutionState === "planned") repository.markClosureRepairResolution(lineage.id, "committed");
      repository.markClosureRepairResolution(lineage.id, "resolved");
      return;
    }
    if (lineage.resolutionState !== "planned") return;
    if (decision === "repairs_required") {
      const review = reviewId ? repository.getClosureReviewV4(reviewId) : null;
      if (!review) throw coordinatorError("GROWTH_CLOSURE_REPAIR_LINEAGE_INVALID");
      const originalFindingStillPresent = review.adverseFindings
        .some((finding) => finding.fingerprint === lineage.selectedFindingFingerprint);
      repository.markClosureRepairResolution(lineage.id, originalFindingStillPresent ? "no_progress" : "committed");
      return;
    }
    repository.markClosureRepairResolution(lineage.id, "no_progress");
  }

  #appendTerminalEvent(
    input: { goal: GrowthGoal; repository: GrowthRepository },
    cycle: GrowthCycle,
    safeSummary: string,
  ): void {
    try {
      const event = input.repository.appendEvent({
        goalId: input.goal.id, cycleId: cycle.id, runId: cycle.runId,
        sequence: nextEventSequence(input.repository, input.goal.id), safeSummary,
        phase: "cycle_terminal", targetKind: "resource", targetId: input.goal.authorizedScopeResourceIds[0],
        targetVersionId: null, durableState: cycle.status, contentRef: null,
      });
      this.#publish(event);
    } catch { /* Cycle terminal state remains authoritative. */ }
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
    if (intent.kind === "repair") {
      const lineage = input.repository.getClosureRepairLineageForCycle(cycle.id);
      const lineageMatches = lineage
        && lineage.profileId === intent.profileId
        && lineage.revision === intent.revision
        && lineage.originalReviewId === intent.originalReviewId
        && lineage.selectedFindingId === intent.selectedFindingId
        && lineage.selectedFindingFingerprint === intent.selectedFindingFingerprint;
      if (!lineageMatches || !lineage || !["planned", "stalled"].includes(lineage.resolutionState)) {
        const failed = input.repository.terminalizeCycle({
          cycleId: cycle.id, status: "failed", failureCode: "GROWTH_CLOSURE_REPAIR_LINEAGE_INVALID",
        });
        this.#appendTerminalEvent(input, failed, "Closure repair lineage is missing or invalid; the Run was not started.");
        this.#releaseListeners(input.goal.id);
        return;
      }
      if (lineage.resolutionState === "stalled") {
        const blocked = input.repository.terminalizeCycle({
          cycleId: cycle.id, status: "blocked", failureCode: "GROWTH_CLOSURE_REPAIR_STALLED",
        });
        this.#appendTerminalEvent(input, blocked, "Closure repair remains stalled; the Run was not restarted.");
        this.#releaseListeners(input.goal.id);
        return;
      }
    }
    const repairBrief = intent.kind === "repair" ? requiredRepairBrief(input.repository, intent) : null;
    let runId: string;
    try {
      runId = lifecycle.start({
        goalId: input.goal.id,
        cycleId: cycle.id,
        request: {
          projectId: input.request.projectId,
          sessionId: input.request.sessionId,
          userInput: stagePrompt(cycle.sequence, intent, input.request.seed, pinnedRule.ruleText, repairBrief),
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
    } catch (error) {
      const diagnosticCode = readGrowthRunStartDiagnosticCode(error);
      if (diagnosticCode) {
        try {
          ensureGrowthCycleDiagnostic({
            workspace: input.context.workspace,
            cycleId: cycle.id,
            runId: null,
            code: diagnosticCode,
          });
        } catch {
          // A diagnostic write must never replace the original start failure.
        }
      }
      throw error;
    }
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
    if (cycle.status === "evaluated") {
      this.#advance({ ...input, goal: input.repository.getGoal(input.goal.id) ?? input.goal });
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
    const activeCycleRuleRevision = activeCycle && (["planned", "running", "committed"].includes(activeCycle.status)
      || (activeCycle.status === "blocked" && activeCycle.failureCode === "GROWTH_CREATOR_CHOICE_REQUIRED"))
      ? activeCycle.ruleRevision
      : null;
    const diagnosticRepository = new SafeDiagnosticRepository(context.workspace);
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
      diagnostics: cycles
        .flatMap((cycle) => diagnosticRepository.listCycle(cycle.id))
        .slice(-100)
        .map(projectDiagnostic),
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

  #presentationContext(projectId: string, sessionId: string, goalId: string): GrowthWorkspaceContext {
    this.#assertProjectSession(projectId, sessionId);
    const context = this.#requiredContext(projectId);
    const goal = new GrowthRepository(context.workspace).getGoal(goalId);
    if (!goal || goal.branchId !== context.branchId || !sameStrings(goal.authorizedScopeResourceIds, context.authorizedScopeResourceIds)) {
      throw coordinatorError("GROWTH_GUIDANCE_AUTHORITY_MISMATCH");
    }
    return context;
  }

  #illustrationService(context: GrowthWorkspaceContext): GrowthIllustrationApplicationService {
    if (this.#illustrationApplication?.workspace === context.workspace) return this.#illustrationApplication.service;
    this.#illustrationApplication?.service.dispose();
    const gateway = this.workspaceSession.createAgentToolGateway();
    if (!gateway) throw coordinatorError("GROWTH_WORKSPACE_REQUIRED");
    const service = new GrowthIllustrationApplicationService(context.workspace, gateway);
    this.#illustrationApplication = { workspace: context.workspace, service };
    return service;
  }
}

function goalIdFor(requestId: string): string { return `growth-goal:${requestId}`; }
function stableCoordinatorId(kind: string, value: string): string {
  return `growth-${kind}:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 40)}`;
}
function requiredRepairBrief(
  repository: GrowthRepository,
  intent: Extract<GrowthCycleIntent, { kind: "repair" }>,
): { safeSummary: string; repairObjective: string } {
  const review = repository.getClosureReviewV4(intent.originalReviewId);
  const finding = review?.adverseFindings.find((candidate) => candidate.id === intent.selectedFindingId);
  if (!review || !finding || review.profileId !== intent.profileId || review.revision !== intent.revision
    || finding.fingerprint !== intent.selectedFindingFingerprint) {
    throw coordinatorError("GROWTH_CLOSURE_REPAIR_LINEAGE_INVALID");
  }
  return { safeSummary: finding.safeSummary, repairObjective: finding.repairObjective };
}
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
function projectDiagnostic(diagnostic: import("../shared/diagnostics/safeDiagnosticContract").SafeDiagnosticEnvelopeV1) {
  return {
    diagnosticId: diagnostic.diagnosticId,
    operationKind: diagnostic.operationKind,
    operationId: diagnostic.operationId,
    runId: diagnostic.runId,
    cycleId: diagnostic.cycleId!,
    sequence: diagnostic.sequence,
    owner: diagnostic.owner,
    boundary: diagnostic.boundary,
    code: diagnostic.code,
    toolName: diagnostic.toolName,
    attempt: diagnostic.attempt,
    maxAttempts: diagnostic.maxAttempts,
    sideEffectState: diagnostic.sideEffectState,
    disposition: diagnostic.disposition,
    retryability: diagnostic.retryability,
  };
}
function stagePrompt(
  sequence: number,
  intent: GrowthCycleIntent,
  seed: GrowthStartRequest["seed"],
  initialRuleText: string,
  repairBrief: { safeSummary: string; repairObjective: string } | null,
): string {
  if (intent.kind === "closure_evaluation") {
    return `Growth 策略 ${strategy}，第 ${sequence} 个 Cycle。锁定规则：${initialRuleText}\n从固定 checkpoint 检索闭环证据，先提交 Steward 自检；仅在确定性内容维度全部满足时调用独立 Checker。不得修改项目内容。`;
  }
  if (intent.kind === "repair") {
    if (!repairBrief) throw coordinatorError("GROWTH_CLOSURE_REPAIR_LINEAGE_INVALID");
    return `Growth 策略 ${strategy}，第 ${sequence} 个 Cycle。锁定规则：${initialRuleText}\n闭环检查发现：${repairBrief.safeSummary}\n本轮只修复：${repairBrief.repairObjective}\n先检索固定 checkpoint 的目标证据，再提交恰好一个原子 Change Set；不得扩大到无关节点或生成图片。`;
  }
  const seedText = seed.kind === "text" ? `\n用户种子：${seed.text}` : "\n用户种子已保存为授权资料；先检索后创作。";
  return `Growth 策略 ${strategy}，第 ${sequence} 个 Cycle。锁定规则：${initialRuleText}\n持久 Intent：${intent.kind}；有序 focus：${intent.focusKinds.join("、")}；后续 frontier：${intent.resumeFrontier.join("、") || "等待闭环证据"}。先使用 growth_v1 检索证据，再提交一次 3–7 条证据化自询；只有 durable selected 后，本 Cycle 才可经一个现有 Change Set 持久化模型生成内容。需要创作者取舍时必须零 Change Set 并安全阻塞。${seedText}`;
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
  if (current?.status === "evaluated") {
    const outcome = repository.getClosureEvaluationOutcomeForCycle(current.id);
    if (!outcome) return "reconciliation_required";
    if (outcome.decision === "accepted") return "completed";
    if (outcome.decision === "blocked") return "blocked";
    return "awaiting_guidance";
  }
  if (current && current.status !== "committed") return current.status;
  const projectedIntent = current ? repository.getCycleIntent(current.id) : null;
  const latestIntent = projectedIntent && isContentIntent(projectedIntent) ? projectedIntent : null;
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

function creatorChoiceRevisionIntent(
  priorIntent: Pick<GrowthContentCycleIntent, "focusKinds" | "resumeFrontier">,
  coverageKinds: GrowthFocusKind[],
): { kind: "revision"; focusKinds: GrowthFocusKind[]; resumeFrontier: GrowthFocusKind[] } {
  return {
    kind: "revision",
    focusKinds: [...new Set(coverageKinds)],
    resumeFrontier: [...new Set([...priorIntent.focusKinds, ...priorIntent.resumeFrontier])],
  };
}

function creatorChoiceSuccessorIntent(
  priorIntent: Pick<GrowthContentCycleIntent, "focusKinds" | "resumeFrontier">,
  coverageKinds: GrowthFocusKind[],
) {
  if (coverageKinds.length === 0) {
    return {
      kind: "expand" as const,
      focusKinds: [...priorIntent.focusKinds],
      resumeFrontier: [...priorIntent.resumeFrontier],
    };
  }
  return creatorChoiceRevisionIntent(priorIntent, coverageKinds);
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

function isContentIntent(intent: GrowthCycleIntent): intent is GrowthContentCycleIntent {
  return intent.kind === "expand" || intent.kind === "revision";
}

function ensureDefaultMixedClosureProfile(
  workspace: GrowthWorkspaceContext["workspace"],
  repository: GrowthRepository,
  goal: GrowthGoal,
  checkpointId: string,
): ReturnType<GrowthRepository["getClosureProfile"]> {
  const currentProfiles = repository.listClosureStates(goal.id)
    .map((state) => repository.getClosureProfile(state.profileId))
    .filter((profile) => profile?.contractGeneration === "v26");
  if (currentProfiles.length > 1) throw coordinatorError("GROWTH_CLOSURE_PROFILE_AMBIGUOUS");
  if (currentProfiles[0]) return currentProfiles[0];
  const resources = new ResourceRepository(workspace).listAtCheckpoint(checkpointId);
  const worlds = resources.filter((resource) => resource.objectKind === "world");
  const stories = resources.filter((resource) => resource.objectKind === "story");
  const ocs = resources.filter((resource) => resource.objectKind === "oc");
  if (worlds.length !== 1 || stories.length !== 1 || ocs.length === 0) return null;
  const focusOcResourceId = resolveCommittedFocusOcResourceId(workspace, repository, goal.id, checkpointId);
  if (!focusOcResourceId) return null;
  const facets = [
    ...Object.values(GROWTH_CLOSURE_FACETS.world),
    ...Object.values(GROWTH_CLOSURE_FACETS.story),
    ...Object.values(GROWTH_CLOSURE_FACETS.oc),
  ].map((id) => ({ id, kind: "content" as const, required: true }));
  const identity = createHash("sha256").update(goal.id, "utf8").digest("hex").slice(0, 40);
  return repository.createClosureProfile({
    id: `growth-closure:${identity}`,
    idempotencyKey: `growth-closure-create:${identity}`,
    goalId: goal.id,
    profileKind: "mixed_birth",
    subjectResourceId: null,
    componentProfiles: ["world_birth", "story_universe", "oc_saga"],
    focusOcResourceId,
    contractGeneration: "v26",
    checkpointId,
    ruleRevision: goal.currentRuleRevision,
    facets,
  });
}

function resolveCommittedFocusOcResourceId(
  workspace: GrowthWorkspaceContext["workspace"],
  repository: GrowthRepository,
  goalId: string,
  checkpointId: string,
): string | null {
  const cycle = repository.listCycles(goalId).find((candidate) => {
    if (candidate.status !== "committed" || !candidate.changeSetId || candidate.outputCheckpointId !== checkpointId) return false;
    const intent = repository.getCycleIntent(candidate.id);
    return isContentIntent(intent) && intent.focusKinds.includes("oc");
  });
  if (!cycle?.changeSetId) return null;
  const changeSetRepository = new ChangeSetRepository(workspace);
  const changeSet = changeSetRepository.get(cycle.changeSetId);
  if (!changeSet || changeSet.status !== "committed" || changeSet.committedCheckpointId !== checkpointId) return null;
  const declaredOcItem = changeSet.items.find(isCreatedOcResourceItem);
  if (!declaredOcItem) return null;
  const revisionOutput = changeSetRepository.listOutputs(changeSet.id).find((output) => (
    output.itemId === declaredOcItem.id && output.kind === "resource_revision"
  ));
  if (!revisionOutput) return null;
  const resource = new ResourceRepository(workspace)
    .getVisibleByRevisionIdAtCheckpoint(revisionOutput.outputId, checkpointId);
  return resource?.type === "oc" && resource.objectKind === "oc" ? resource.id : null;
}

function isCreatedOcResourceItem(item: ChangeSetItemRecord): boolean {
  if (item.kind !== "resource.put" || !item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) return false;
  const payload = item.payload as Record<string, unknown>;
  return payload.create === true && payload.type === "oc" && payload.objectKind === "oc";
}
