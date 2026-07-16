import { createHash } from "node:crypto";
import type { CompiledGrowthIllustrationPlan } from "../../../agent-worker/growth/growthIllustrationPlan";
import { ImageAssetRepository } from "../../../domain/asset/imageAssetRepository";
import type { ImageGenerationProgress } from "../../../domain/asset/imageGenerationService";
import { GrowthRepository } from "../../../domain/growth/growthRepository";
import type { WorkspaceDatabase } from "../../../domain/workspace/workspaceRepository";
import type { GenerateImageArgs } from "../../../shared/agentWorkerProtocol";
import type {
  GrowthIllustrationItem,
  GrowthIllustrationRequest,
} from "../../../shared/growthContract";
import type { AgentToolGateway, AgentToolInvocationContext } from "../../agentProcessSupervisor";
import { GrowthIllustrationRecovery } from "./growthIllustrationRecovery";

const BATCH_SIZE = 20;

export interface GrowthIllustrationSnapshotInput {
  id: string;
  kind: "working_text_snapshot" | "conversation_text_snapshot";
  text: string;
  textSha256: string;
}

export interface PersistGrowthIllustrationPlanInput {
  request: {
    id: string;
    goalId: string;
    cycleId: string;
    ruleRevision: number;
    closureProfileId: string | null;
    closureRevision: number | null;
    idempotencyKey: string;
  };
  plan: CompiledGrowthIllustrationPlan;
  snapshots?: GrowthIllustrationSnapshotInput[];
}

export interface ExecuteGrowthIllustrationPlanInput {
  requestId: string;
  plan: CompiledGrowthIllustrationPlan;
  signal: AbortSignal;
  onProgress?: (input: { itemId: string; progress: ImageGenerationProgress }) => void;
}

export interface GrowthIllustrationExecutionResult {
  request: GrowthIllustrationRequest;
  attemptedItemIds: string[];
  failedItemIds: string[];
}

/** Main-authoritative, serial Illustration Queue. It never calls an image Provider outside the existing Gateway. */
export class GrowthIllustrationCoordinator {
  readonly #growth: GrowthRepository;
  readonly #images: ImageAssetRepository;
  readonly #recovery: GrowthIllustrationRecovery;

  constructor(
    readonly workspace: WorkspaceDatabase,
    readonly gateway: Pick<AgentToolGateway, "generateImage">,
  ) {
    this.#growth = new GrowthRepository(workspace);
    this.#images = new ImageAssetRepository(workspace);
    this.#recovery = new GrowthIllustrationRecovery(workspace);
  }

  persist(input: PersistGrowthIllustrationPlanInput): GrowthIllustrationRequest {
    if (input.plan.items.length === 0) throw illustrationError("GROWTH_ILLUSTRATION_PLAN_INVALID");
    const materialized = materializePlan(input.request.id, input.plan, input.snapshots ?? []);
    return this.#growth.persistIllustrationPlan({
      request: {
        ...input.request,
        coverageMode: input.plan.coverageMode,
      },
      batches: materialized.batches,
    });
  }

  async execute(input: ExecuteGrowthIllustrationPlanInput): Promise<GrowthIllustrationExecutionResult> {
    this.#recovery.recover(input.requestId, { recoverInterruptedJobs: false });
    const request = this.#growth.getIllustrationRequest(input.requestId);
    if (!request) throw illustrationError("GROWTH_ILLUSTRATION_REQUEST_NOT_FOUND");
    if (request.coverageMode !== input.plan.coverageMode) throw illustrationError("GROWTH_ILLUSTRATION_PLAN_REPLAY_MISMATCH");
    const materialized = materializePlan(input.requestId, input.plan, [], false);
    const prompts = new Map(materialized.items.map((item) => [item.id, item]));
    const persisted = this.#growth.listIllustrationItems(input.requestId);
    if (persisted.length !== prompts.size || persisted.some((item) =>
      prompts.get(item.id)?.compiledPromptSha256 !== item.compiledPromptSha256)) {
      throw illustrationError("GROWTH_ILLUSTRATION_PLAN_REPLAY_MISMATCH");
    }

    const attemptedItemIds: string[] = [];
    const failedItemIds: string[] = [];
    for (const item of persisted) {
      if (input.signal.aborted) {
        this.#cancelRemaining(input.requestId);
        break;
      }
      const current = this.#growth.getIllustrationItem(item.id)!;
      if (["ready", "failed", "cancelled", "stale", "reconciliation_required"].includes(current.status)) continue;
      if (current.status === "running") {
        failedItemIds.push(current.id);
        continue;
      }
      const compiled = prompts.get(current.id);
      if (!compiled) throw illustrationError("GROWTH_ILLUSTRATION_PLAN_REPLAY_MISMATCH");
      const args = this.#generateArgs(current, compiled.promptText);
      attemptedItemIds.push(current.id);
      try {
        const result = await this.gateway.generateImage(args, this.#context(current.id, input));
        this.#growth.bindIllustrationImageJob({ itemId: current.id, imageJobId: result.jobId });
      } catch (error) {
        const job = this.#images.getJobByIdempotencyKey(`illustration:${args.idempotencyKey}`);
        let persistedStatus: GrowthIllustrationItem["status"] | null = null;
        if (job) {
          this.#growth.bindIllustrationImageJob({ itemId: current.id, imageJobId: job.id });
          persistedStatus = this.#growth.refreshIllustrationItemFromJob(current.id).status;
        }
        if (persistedStatus !== "ready") failedItemIds.push(current.id);
        if (input.signal.aborted) {
          this.#cancelRemaining(input.requestId);
          break;
        }
        if (readCode(error) === "IMAGE_GENERATION_RECONCILIATION_REQUIRED") continue;
      }
    }
    return {
      request: this.#growth.getIllustrationRequest(input.requestId) ?? illustrationFail("GROWTH_ILLUSTRATION_REQUEST_NOT_FOUND"),
      attemptedItemIds,
      failedItemIds,
    };
  }

  #generateArgs(item: GrowthIllustrationItem, prompt: string): GenerateImageArgs {
    const resourceIds: string[] = [];
    const versionIds: string[] = [];
    for (const source of item.sources) {
      versionIds.push(source.kind === "resource" ? source.resourceVersionId : source.documentVersionId);
      if (source.kind === "resource") {
        resourceIds.push(source.resourceId);
      } else {
        const owner = this.workspace.db.prepare(`
          SELECT resource_id FROM document_versions WHERE id = ? AND creative_document_id = ?
        `).get(source.documentVersionId, source.documentId) as { resource_id: string } | undefined;
        if (!owner) throw illustrationError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
        resourceIds.push(owner.resource_id);
      }
    }
    return {
      title: item.title,
      purpose: item.purpose as GenerateImageArgs["purpose"],
      prompt,
      sourceResourceIds: normalizeIds(resourceIds),
      sourceVersionIds: normalizeIds(versionIds),
      idempotencyKey: growthIllustrationItemIdempotencyKey(item.requestId, item.id),
    };
  }

  #context(itemId: string, input: ExecuteGrowthIllustrationPlanInput): AgentToolInvocationContext {
    return {
      runId: `illustration-request:${input.requestId}`,
      invocationId: `illustration-request:${input.requestId}`,
      requestId: itemId,
      mode: "free",
      illustrationQueueItemId: itemId,
      onImageProgress: (progress) => input.onProgress?.({ itemId, progress }),
      signal: input.signal,
    };
  }

  #cancelRemaining(requestId: string): void {
    for (const item of this.#growth.listIllustrationItems(requestId)) {
      if (item.status === "planned" && !item.imageJobId) this.#growth.cancelIllustrationItem(item.id);
    }
  }
}

export function growthIllustrationItemIdempotencyKey(requestId: string, itemId: string): string {
  return `queue-${sha256(`${requestId}:${itemId}`).slice(0, 48)}`;
}

function materializePlan(
  requestId: string,
  plan: CompiledGrowthIllustrationPlan,
  snapshots: GrowthIllustrationSnapshotInput[],
  requireSnapshots = true,
) {
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  if (snapshotById.size !== snapshots.length) throw illustrationError("GROWTH_ILLUSTRATION_PLAN_INVALID");
  const items = plan.items.map((item, index) => ({
    id: materializedItemId(requestId, item.variantKey, index),
    purpose: item.purpose,
    title: item.title,
    variantKey: item.variantKey,
    compiledPromptSha256: item.promptSha256,
    requiredForVisualClosure: plan.coverageMode !== "custom",
    anchor: item.targetAnchorInput,
    sources: item.normalizedSources.map((source) => source.kind === "resource"
      ? { kind: "resource" as const, resourceId: source.resourceId, resourceVersionId: source.resourceVersionId }
      : {
          kind: "document" as const, documentId: source.documentId,
          documentVersionId: source.documentVersionId, contentSha256: source.contentSha256,
        }),
    promptText: item.promptText,
  }));
  const batches = Array.from({ length: Math.ceil(items.length / BATCH_SIZE) }, (_, batchIndex) => {
    const offset = batchIndex * BATCH_SIZE;
    const batchItems = items.slice(offset, offset + BATCH_SIZE);
    const requiredSnapshotIds = new Set(batchItems.flatMap((item) =>
      item.anchor.kind === "working_text_snapshot" || item.anchor.kind === "conversation_text_snapshot"
        ? [item.anchor.sourceSnapshotId]
        : []));
    const batchSnapshots = [...requiredSnapshotIds].flatMap((id) => {
      const snapshot = snapshotById.get(id);
      if (snapshot) return [snapshot];
      if (requireSnapshots) illustrationFail("GROWTH_ILLUSTRATION_SNAPSHOT_REQUIRED");
      return [];
    });
    return {
      id: materializedBatchId(requestId, batchIndex + 1),
      requestId,
      sequence: batchIndex + 1,
      cursor: batchIndex === 0 ? null : String(offset),
      nextCursor: offset + batchItems.length < items.length ? String(offset + batchItems.length) : null,
      idempotencyKey: `illustration-batch-${sha256(`${requestId}:${batchIndex + 1}`).slice(0, 48)}`,
      snapshots: batchSnapshots,
      items: batchItems.map(({ promptText: _promptText, ...item }) => item),
    };
  });
  return { items, batches };
}

function materializedItemId(requestId: string, variantKey: string, index: number): string {
  return `illustration-item-${sha256(`${requestId}:${variantKey}:${index}`).slice(0, 48)}`;
}

function materializedBatchId(requestId: string, sequence: number): string {
  return `illustration-batch-${sha256(`${requestId}:${sequence}`).slice(0, 48)}`;
}

function normalizeIds(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function illustrationFail(code: string): never {
  throw illustrationError(code);
}

function illustrationError(code: string): Error & { code: string } {
  return Object.assign(new Error("Growth Illustration coordination failed."), { code });
}
