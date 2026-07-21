import { createHash, randomUUID } from "node:crypto";
import { requireAgentCapability } from "../../../agent-worker/editorial/agentCapabilityRegistry";
import type { GrowthEditorialRoundSnapshot } from "../../../domain/growth/editorial/growthEditorialTypes";
import { GrowthEditorialRepository } from "../../../domain/growth/editorial/growthEditorialRepository";
import type { GrowthGoal } from "../../../shared/growthContract";
import {
  growthEditorialPromptSchema,
  type GrowthEditorialPrompt,
  type GrowthEditorialSpecialistPacket,
} from "../../../shared/growthEditorialWorkerProtocol";
import { canonicalAuditHash } from "../../../domain/audit/canonicalAuditHash";
import type { WorkspaceDatabase } from "../../../domain/workspace/workspaceRepository";
import type { AgentProcessSupervisor } from "../../agentProcessSupervisor";
import { GrowthEditorialArtifactStore } from "./growthEditorialArtifactStore";
import { GrowthRepository } from "../../../domain/growth/growthRepository";

export interface WorldDirectorGeographyDelegationOptions {
  requireEditorialPrompt(capabilityId: "geography_ecology_author"): GrowthEditorialPrompt;
}

export class WorldDirectorGeographyDelegation {
  readonly #repository: GrowthEditorialRepository;
  readonly #artifactStore: GrowthEditorialArtifactStore;
  readonly #active = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  constructor(
    readonly workspace: WorkspaceDatabase,
    readonly workspaceRoot: string,
    readonly supervisor: AgentProcessSupervisor,
    readonly options: WorldDirectorGeographyDelegationOptions,
  ) {
    this.#repository = new GrowthEditorialRepository(workspace);
    this.#artifactStore = new GrowthEditorialArtifactStore(workspaceRoot);
  }

  start(input: {
    goal: GrowthGoal;
    sourceCheckpointId: string;
  }): void {
    if (input.goal.seed.kind !== "text") {
      throw delegationError("GROWTH_EDITORIAL_TEXT_SEED_REQUIRED");
    }
    const roundId = roundIdFor(input.goal.id);
    let snapshot = this.#repository.getRoundSnapshot(roundId);
    if (!snapshot) {
      const orderId = workOrderIdFor(input.goal.id);
      snapshot = this.#repository.createRound({
        id: roundId,
        goalId: input.goal.id,
        sourceCheckpointId: input.sourceCheckpointId,
        ruleRevision: input.goal.currentRuleRevision,
        idempotencyKey: `${input.goal.id}:world-director-geography:v1`,
        workOrders: [{
          id: orderId,
          objective: "根据创作者种子与当前规则，建立原创大世界的地理与生态基本面貌；只生成地理 Handoff，不生成国家、人物、故事或图片。",
          sourceCheckpointId: input.sourceCheckpointId,
          scopeRefs: ["@resource1"],
          capability: "geography_ecology_author",
          acceptanceFacets: [
            { id: "macro_regions", description: "给出多个可区分的宏观区域及其空间关系。", required: true },
            { id: "physical_systems", description: "说明地形、气候、水系、资源与生态之间的作用机制。", required: true },
            { id: "downstream_handoff", description: "明确可约束后续国家与文明生成的地理因果输入。", required: true },
          ],
          dependencies: [],
        }],
      });
    }
    if (this.#active.has(roundId)) return;
    if (snapshot.round.status !== "active") return;
    const order = snapshot.workOrders[0];
    if (!order || order.capability !== "geography_ecology_author") {
      throw delegationError("GROWTH_EDITORIAL_GEOGRAPHY_ORDER_INVALID");
    }
    if (snapshot.attempts.some((attempt) => attempt.status === "running")) {
      this.#repository.reconcileInterruptedRound(roundId);
      return;
    }
    if (order.status !== "ready") return;

    const controller = new AbortController();
    const promise = this.#run({ goal: input.goal, snapshot, signal: controller.signal })
      .catch((error) => this.#terminalizeFailure(roundId, order.id, readFailureCode(error)))
      .finally(() => this.#active.delete(roundId));
    this.#active.set(roundId, { controller, promise });
  }

  dispose(): void {
    for (const run of this.#active.values()) run.controller.abort();
    this.#active.clear();
  }

  async #run(input: {
    goal: GrowthGoal;
    snapshot: GrowthEditorialRoundSnapshot;
    signal: AbortSignal;
  }): Promise<void> {
    const order = input.snapshot.workOrders[0]!;
    const capability = requireAgentCapability("geography_ecology_author");
    const prompt = growthEditorialPromptSchema.parse(this.options.requireEditorialPrompt("geography_ecology_author"));
    if (prompt.status !== "active" || !prompt.publicationEvidence) {
      throw delegationError("GROWTH_SPECIALIST_PROMPT_NOT_PUBLISHED");
    }
    const provider = this.supervisor.getEditorialProviderIdentity();
    if (!provider) throw delegationError("GROWTH_SPECIALIST_PROVIDER_REQUIRED");
    const attempt = this.#repository.startAttempt({
      id: `${order.id}:attempt:1`,
      workOrderId: order.id,
      idempotencyKey: `${order.id}:attempt:1`,
      sourceCheckpointId: order.sourceCheckpointId,
      ruleRevision: input.snapshot.round.ruleRevision,
      capability: "geography_ecology_author",
      capabilityProfile: capability.profile,
      prompt: { id: prompt.id, version: prompt.version, sha256: prompt.sha256 },
      model: provider,
    });
    const rule = new GrowthRepository(this.workspace).getRuleRevision(input.goal.id, input.snapshot.round.ruleRevision);
    if (input.goal.seed.kind !== "text") throw delegationError("GROWTH_EDITORIAL_TEXT_SEED_REQUIRED");
    const packet: GrowthEditorialSpecialistPacket = {
      capabilityId: "geography_ecology_author",
      sourceCheckpointId: order.sourceCheckpointId,
      workOrderId: order.id,
      objective: order.objective,
      scopeRefs: order.scopeRefs,
      acceptanceFacets: order.acceptanceFacets,
      evidence: [
        {
          ref: "@evidence1",
          kind: "goal_seed",
          stableLocator: `growth-goal:${shortHash(input.goal.id)}#seed`,
          content: input.goal.seed.text,
          contentSha256: sha256(input.goal.seed.text),
        },
        {
          ref: "@evidence2",
          kind: "user_rule",
          stableLocator: `growth-goal:${shortHash(input.goal.id)}#rule-${rule.revision}`,
          content: rule.ruleText,
          contentSha256: sha256(rule.ruleText),
        },
      ],
      artifactSlots: ["@artifact1"],
      revisionFeedback: [],
    };
    const event = await this.supervisor.runGrowthEditorialSpecialist({
      type: "growth.editorial.specialist.start",
      runId: randomUUID(),
      attemptId: attempt.id,
      profile: capability.profile,
      prompt,
      binding: {
        capabilityId: "geography_ecology_author",
        contractVersion: "1.0.0",
        inputContractId: "specialist_candidate_v1",
        sourceCheckpointId: order.sourceCheckpointId,
        workOrderId: order.id,
        packetSha256: canonicalAuditHash(packet),
      },
      outputContractId: "specialist_candidate_v1",
      packet,
    }, input.signal);
    if (event.type === "growth.editorial.specialist.evidence_requested") {
      throw delegationError("GROWTH_SPECIALIST_EVIDENCE_REQUIRED");
    }
    if (event.receipt.actualProviderId !== provider.providerId
      || event.receipt.actualModelId !== provider.modelId) {
      throw delegationError("GROWTH_SPECIALIST_PROVIDER_RECEIPT_MISMATCH");
    }

    const storedArtifacts = event.artifacts.map((artifact) => ({
      ref: artifact.ref,
      title: artifact.title,
      mediaType: artifact.mediaType,
      ...this.#artifactStore.putMarkdown(artifact.content),
    }));
    const handoff = {
      contract: "novax.growth-editorial-handoff@1.0.0",
      goalId: input.goal.id,
      workOrderId: order.id,
      attemptId: attempt.id,
      sourceCheckpointId: order.sourceCheckpointId,
      candidate: event.candidate,
      artifacts: storedArtifacts,
      receipt: event.receipt,
    };
    const storedHandoff = this.#artifactStore.putJson(handoff);
    this.#repository.recordCandidate({
      attemptId: attempt.id,
      outputSha256: storedHandoff.contentSha256,
      artifacts: [
        ...storedArtifacts.map((artifact, ordinal) => ({
          kind: "content_artifact" as const,
          ordinal,
          storeRef: artifact.storeRef,
          contentSha256: artifact.contentSha256,
        })),
        {
          kind: "specialist_candidate",
          ordinal: 0,
          storeRef: storedHandoff.storeRef,
          contentSha256: storedHandoff.contentSha256,
        },
      ],
    });
  }

  #terminalizeFailure(roundId: string, workOrderId: string, failureCode: string): void {
    const cancelled = failureCode === "AGENT_RUN_CANCELLED";
    const order = this.#repository.getWorkOrder(workOrderId);
    if (order && !["committed", "cancelled", "failed", "reconciliation_required"].includes(order.status)) {
      this.#repository.terminalizeWorkOrder({
        workOrderId,
        status: cancelled ? "cancelled" : "failed",
        failureCode,
      });
    }
    const round = this.#repository.getRound(roundId);
    if (round?.status === "active") {
      this.#repository.terminalizeRound({
        roundId,
        status: cancelled ? "cancelled" : "failed",
        failureCode,
      });
    }
  }
}

function roundIdFor(goalId: string): string {
  return `world_director_${shortHash(goalId)}`;
}

function workOrderIdFor(goalId: string): string {
  return `geography_foundation_${shortHash(goalId)}`;
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 16);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readFailureCode(error: unknown): string {
  const value = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "GROWTH_EDITORIAL_GEOGRAPHY_DELEGATION_FAILED";
  return /^[A-Z][A-Z0-9_]{2,119}$/.test(value)
    ? value
    : "GROWTH_EDITORIAL_GEOGRAPHY_DELEGATION_FAILED";
}

function delegationError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
