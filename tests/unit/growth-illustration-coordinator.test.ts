import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileGrowthIllustrationPlan } from "../../src/agent-worker/growth/growthIllustrationPlan";
import { ImageAssetRepository } from "../../src/domain/asset/imageAssetRepository";
import { ImageAssetStore } from "../../src/domain/asset/imageAssetStore";
import { ImageGenerationService, type ImageGenerationClient } from "../../src/domain/asset/imageGenerationService";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { GrowthIllustrationCoordinator, growthIllustrationItemIdempotencyKey } from "../../src/main/growth/illustration/growthIllustrationCoordinator";
import { GrowthIllustrationRecovery } from "../../src/main/growth/illustration/growthIllustrationRecovery";
import { createWorkspaceAgentToolGateway } from "../../src/main/workspaceAgentToolGateway";
import type { ChangeSetPolicyEvaluator } from "../../src/domain/changeSet/changeSetService";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const policy: ChangeSetPolicyEvaluator = { assess: () => [] };
let roots: string[] = [];
let opened: WorkspaceDatabase[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) { try { workspace.close(); } catch { /* already closed */ } }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Growth Illustration Coordinator", () => {
  it.each([10, 100, 105])("persists %i items without a product quota and paginates only by 20", (count) => {
    const setup = createSetup(`page-${count}`);
    const coordinator = createCoordinator(setup, vi.fn());
    const compiled = plan(setup, count);
    expect(coordinator.persist({ request: setup.request, plan: compiled }).itemCount).toBe(count);
    expect(new GrowthRepository(setup.workspace).listIllustrationBatches(setup.request.id).map((batch) => batch.itemCount))
      .toEqual(Array.from({ length: Math.ceil(count / 20) }, (_, index) => Math.min(20, count - index * 20)));
  });

  it("persists a complete 105-item plan before the first serial Gateway call and replays idempotently", async () => {
    const setup = createSetup();
    const compiled = plan(setup, 105);
    const client = vi.fn(async () => {
      expect(new GrowthRepository(setup.workspace).getIllustrationRequest(setup.request.id)).toMatchObject({ itemCount: 105 });
      return { bytes: ONE_PIXEL_PNG, responseId: "image" };
    });
    const coordinator = createCoordinator(setup, client);

    expect(coordinator.persist({ request: setup.request, plan: compiled })).toMatchObject({ itemCount: 105, status: "planned" });
    expect(new GrowthRepository(setup.workspace).listIllustrationBatches(setup.request.id).map((batch) => batch.itemCount))
      .toEqual([20, 20, 20, 20, 20, 5]);
    const unrelatedImages = new ImageAssetRepository(setup.workspace);
    const unrelated = unrelatedImages.createOrGetJob({
      idempotencyKey: "unrelated-running-image", providerId: "image-provider", modelId: "image-model",
      title: "Unrelated", purpose: "scene", prompt: "Unrelated image prompt", size: "1024x1024",
      quality: "auto", background: "auto", sourceResourceIds: [setup.source.resourceId], sourceVersionIds: [setup.source.revisionId],
    });
    unrelatedImages.claim(unrelated.id);
    const result = await coordinator.execute({ requestId: setup.request.id, plan: compiled, signal: new AbortController().signal });
    expect(result.request).toMatchObject({ status: "completed", readyCount: 105 });
    expect(client).toHaveBeenCalledTimes(105);
    expect(unrelatedImages.getRequiredJob(unrelated.id).status).toBe("running");

    await coordinator.execute({ requestId: setup.request.id, plan: compiled, signal: new AbortController().signal });
    expect(client).toHaveBeenCalledTimes(105);
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()).toEqual({ count: 106 });
  });

  it("continues after one failed item, preserves later items, and cancels only work not sent", async () => {
    const setup = createSetup();
    const compiled = plan(setup, 4);
    let call = 0;
    const client = vi.fn(async () => {
      call += 1;
      if (call === 2) throw Object.assign(new Error("safe failure"), { code: "IMAGE_PROVIDER_RUNTIME_FAILED" });
      return { bytes: ONE_PIXEL_PNG, responseId: `image-${call}` };
    });
    const coordinator = createCoordinator(setup, client);
    coordinator.persist({ request: setup.request, plan: compiled });
    const result = await coordinator.execute({ requestId: setup.request.id, plan: compiled, signal: new AbortController().signal });
    expect(result.failedItemIds).toHaveLength(1);
    expect(new GrowthRepository(setup.workspace).listIllustrationItems(setup.request.id).map((item) => item.status))
      .toEqual(["ready", "failed", "ready", "ready"]);

    const cancelledSetup = createSetup("cancel");
    const cancelledPlan = plan(cancelledSetup, 10);
    const cancelledClient = vi.fn();
    const cancelled = createCoordinator(cancelledSetup, cancelledClient);
    cancelled.persist({ request: cancelledSetup.request, plan: cancelledPlan });
    const controller = new AbortController();
    controller.abort();
    await cancelled.execute({ requestId: cancelledSetup.request.id, plan: cancelledPlan, signal: controller.signal });
    expect(new GrowthRepository(cancelledSetup.workspace).listIllustrationItems(cancelledSetup.request.id)
      .every((item) => item.status === "cancelled")).toBe(true);
    expect(cancelledClient).not.toHaveBeenCalled();

    const partialSetup = createSetup("partial-cancel");
    const partialPlan = plan(partialSetup, 3);
    const partialController = new AbortController();
    const partial = createCoordinator(
      partialSetup,
      vi.fn().mockResolvedValue({ bytes: ONE_PIXEL_PNG, responseId: "first-ready" }),
    );
    partial.persist({ request: partialSetup.request, plan: partialPlan });
    const partialResult = await partial.execute({
      requestId: partialSetup.request.id,
      plan: partialPlan,
      signal: partialController.signal,
      onProgress: ({ progress }) => { if (progress === "ready") partialController.abort(); },
    });
    expect(partialResult.request.status).toBe("cancelled");
    expect(new GrowthRepository(partialSetup.workspace).listIllustrationItems(partialSetup.request.id).map((item) => item.status))
      .toEqual(["ready", "cancelled", "cancelled"]);
  });

  it("reopens queued work, quarantines a sent unknown outcome, and never charges it again", async () => {
    const setup = createSetup();
    const compiled = plan(setup, 3);
    const coordinator = createCoordinator(setup, vi.fn());
    coordinator.persist({ request: setup.request, plan: compiled });
    const growth = new GrowthRepository(setup.workspace);
    const items = growth.listIllustrationItems(setup.request.id);
    const images = new ImageAssetRepository(setup.workspace);
    for (const [index, item] of items.slice(0, 2).entries()) {
      const prompt = compiled.items.find((candidate) => candidate.promptSha256 === item.compiledPromptSha256)!.promptText;
      const job = images.createOrGetJob({
        idempotencyKey: `illustration:${growthIllustrationItemIdempotencyKey(item.requestId, item.id)}`,
        providerId: "image-provider", modelId: "image-model", title: item.title,
        purpose: item.purpose as "scene", prompt, size: "1024x1024", quality: "auto", background: "auto",
        sourceResourceIds: [setup.source.resourceId], sourceVersionIds: [setup.source.revisionId],
      });
      growth.bindIllustrationImageJob({ itemId: item.id, imageJobId: job.id });
      images.claim(job.id);
      if (index === 1) images.markRequestSent(job.id);
    }
    setup.workspace.close();
    opened = opened.filter((workspace) => workspace !== setup.workspace);
    const reopened = openWorkspace(setup.root);
    opened.push(reopened);
    const recovery = new GrowthIllustrationRecovery(reopened).recover(setup.request.id);
    expect(recovery).toMatchObject({ requeuedJobs: 1, reconciliationRequiredJobs: 1 });
    const client = vi.fn().mockResolvedValue({ bytes: ONE_PIXEL_PNG, responseId: "recovered" });
    const resumed = createCoordinator({ ...setup, workspace: reopened }, client);
    const result = await resumed.execute({ requestId: setup.request.id, plan: compiled, signal: new AbortController().signal });
    expect(result.request.status).toBe("reconciliation_required");
    expect(client).toHaveBeenCalledTimes(2);
    expect(new GrowthRepository(reopened).listIllustrationItems(setup.request.id).map((item) => item.status))
      .toEqual(["ready", "reconciliation_required", "ready"]);
  });

  it("marks the old ready asset stale after its pinned resource version changes", async () => {
    const setup = createSetup();
    const compiled = plan(setup, 1);
    const coordinator = createCoordinator(setup, vi.fn().mockResolvedValue({ bytes: ONE_PIXEL_PNG, responseId: "ready" }));
    coordinator.persist({ request: setup.request, plan: compiled });
    await coordinator.execute({ requestId: setup.request.id, plan: compiled, signal: new AbortController().signal });
    const item = new GrowthRepository(setup.workspace).listIllustrationItems(setup.request.id)[0]!;
    const next = new CheckpointRepository(setup.workspace).appendCheckpoint(
      new CheckpointRepository(setup.workspace).getActiveBranch().id,
      "revise illustration source",
    );
    new ResourceRepository(setup.workspace).putRevisionWithReceipt({
      resourceId: setup.source.resourceId, checkpointId: next, type: "world", objectKind: "world",
      title: "Revised coast", parentId: setup.worldRootId, state: "active",
    });
    expect(new GrowthIllustrationRecovery(setup.workspace).recover(setup.request.id).staleItems).toBe(1);
    expect(new GrowthRepository(setup.workspace).getIllustrationItem(item.id)?.status).toBe("stale");
    expect(setup.workspace.db.prepare("SELECT status FROM image_assets WHERE job_id = ?").get(item.imageJobId!))
      .toEqual({ status: "stale" });
  });

  it("rolls back the whole multi-batch plan, preserves immutable text snapshots, and fails closed without a Provider", async () => {
    const rollback = createSetup("atomic");
    const rollbackCoordinator = createCoordinator(rollback, vi.fn());
    rollback.workspace.db.exec(`
      CREATE TEMP TRIGGER reject_second_illustration_batch BEFORE INSERT ON growth_illustration_items
      WHEN (SELECT COUNT(*) FROM growth_illustration_request_batches WHERE request_id = NEW.request_id) >= 2
      BEGIN SELECT RAISE(ABORT, 'reject second batch'); END;
    `);
    expect(() => rollbackCoordinator.persist({ request: rollback.request, plan: plan(rollback, 21) })).toThrow("reject second batch");
    expect(rollback.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_illustration_requests").get()).toEqual({ count: 0 });
    expect(rollback.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_illustration_items").get()).toEqual({ count: 0 });

    const snapshot = createSetup("snapshot");
    const snapshotText = "A selected, unpublished scene paragraph.";
    const textSha256 = createHash("sha256").update(snapshotText, "utf8").digest("hex");
    const compiled = snapshotPlan(snapshot, textSha256);
    const noProviderGateway = createWorkspaceAgentToolGateway(snapshot.workspace, policy, () => true);
    const coordinator = new GrowthIllustrationCoordinator(snapshot.workspace, noProviderGateway);
    coordinator.persist({
      request: snapshot.request,
      plan: compiled,
      snapshots: [{ id: "working-snapshot-1", kind: "working_text_snapshot", text: snapshotText, textSha256 }],
    });
    const result = await coordinator.execute({ requestId: snapshot.request.id, plan: compiled, signal: new AbortController().signal });
    expect(result.attemptedItemIds).toHaveLength(1);
    expect(result.request.status).toBe("planned");
    expect(snapshot.workspace.db.prepare("SELECT snapshot_text FROM growth_illustration_text_snapshots").get())
      .toEqual({ snapshot_text: snapshotText });
    expect(snapshot.workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()).toEqual({ count: 0 });
  });

  it("rejects any Main queue call whose prompt, source, purpose, or idempotency key differs from the persisted item", async () => {
    const setup = createSetup("authority");
    const compiled = plan(setup, 1);
    const client = vi.fn().mockResolvedValue({ bytes: ONE_PIXEL_PNG, responseId: "must-not-run" });
    const gateway = createGateway(setup, client);
    const coordinator = new GrowthIllustrationCoordinator(setup.workspace, gateway);
    coordinator.persist({ request: setup.request, plan: compiled });
    const item = new GrowthRepository(setup.workspace).listIllustrationItems(setup.request.id)[0]!;
    const base = {
      title: item.title, purpose: "scene" as const, prompt: compiled.items[0]!.promptText,
      sourceResourceIds: [setup.source.resourceId], sourceVersionIds: [setup.source.revisionId],
      idempotencyKey: growthIllustrationItemIdempotencyKey(item.requestId, item.id),
    };
    const context = {
      runId: "queue", invocationId: "queue", requestId: item.id, mode: "free" as const,
      illustrationQueueItemId: item.id, signal: new AbortController().signal,
    };
    for (const invalid of [
      { ...base, prompt: `${base.prompt}\nunauthorized` },
      { ...base, purpose: "character_portrait" as const },
      { ...base, sourceVersionIds: ["missing"] },
      { ...base, idempotencyKey: "wrong" },
    ]) {
      await expect(gateway.generateImage(invalid, context)).rejects.toMatchObject({ code: "GROWTH_ILLUSTRATION_QUEUE_ARGS_INVALID" });
    }
    expect(client).not.toHaveBeenCalled();
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()).toEqual({ count: 0 });
  });
});

function createSetup(suffix = "main") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `novax-growth-illustration-${suffix}-`));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  const checkpoints = new CheckpointRepository(workspace);
  const branch = checkpoints.getActiveBranch();
  const resources = new ResourceRepository(workspace);
  const worldRoot = resources.listCurrent().find((resource) => resource.type === "world")!;
  const source = resources.putRevisionWithReceipt({
    resourceId: `illustration-source-${suffix}`, create: true, checkpointId: branch.headCheckpointId,
    type: "world", objectKind: "world", title: "Tidal coast", parentId: worldRoot.id, state: "active",
  });
  const growth = new GrowthRepository(workspace);
  const goal = growth.createGoal({
    id: `illustration-goal-${suffix}`, idempotencyKey: `illustration-goal-key-${suffix}`,
    branchId: branch.id, seed: { kind: "text", text: "illustrate the coast" },
    authorizedScopeResourceIds: [worldRoot.id], initialRuleText: "use source-bound images", sourceMessageId: null,
  });
  const cycle = growth.beginCycle({
    id: `illustration-cycle-${suffix}`, goalId: goal.id, idempotencyKey: `illustration-cycle-key-${suffix}`,
    inputCheckpointId: branch.headCheckpointId, ruleRevision: 1,
    intent: { kind: "expand", focusKinds: ["world"], resumeFrontier: [] },
  });
  return {
    root, workspace, worldRootId: worldRoot.id, source,
    request: {
      id: `illustration-request-${suffix}`, goalId: goal.id, cycleId: cycle.id, ruleRevision: 1,
      closureProfileId: null, closureRevision: null, idempotencyKey: `illustration-request-key-${suffix}`,
    },
  };
}

function plan(setup: ReturnType<typeof createSetup>, count: number) {
  return compileGrowthIllustrationPlan({
    coverageMode: "custom",
    items: Array.from({ length: count }, (_, index) => ({
      targetEvidenceRef: "coast", evidenceRefs: ["coast"], purpose: "scene",
      title: `Coast variant ${index + 1}`, compositionDescription: `Source-bound composition variant ${index + 1}`,
      variantKey: `coast_${String(index + 1).padStart(4, "0")}`,
    })),
  }, {
    authorizedScopeResourceIds: [setup.worldRootId], currentRuleRevision: { revision: 1 },
    evidenceBindings: [{
      evidenceRef: "coast", scopeResourceId: setup.worldRootId, defaultCoverageRole: "supporting",
      source: { kind: "resource", resourceId: setup.source.resourceId, resourceVersionId: setup.source.revisionId },
      authorizedFacts: "The current source defines a tidal coast.",
      targetAnchorInput: { kind: "resource", resourceId: setup.source.resourceId, resourceVersionId: setup.source.revisionId },
    }],
  });
}

function snapshotPlan(setup: ReturnType<typeof createSetup>, textSha256: string) {
  return compileGrowthIllustrationPlan({
    coverageMode: "custom",
    items: [{
      targetEvidenceRef: "selection", evidenceRefs: ["selection"], purpose: "scene",
      title: "Selected paragraph", compositionDescription: "Illustrate only the selected paragraph.", variantKey: "selected_scene",
    }],
  }, {
    authorizedScopeResourceIds: [setup.worldRootId], currentRuleRevision: { revision: 1 },
    evidenceBindings: [{
      evidenceRef: "selection", scopeResourceId: setup.worldRootId, defaultCoverageRole: "supporting",
      source: { kind: "resource", resourceId: setup.source.resourceId, resourceVersionId: setup.source.revisionId },
      authorizedFacts: "The selected paragraph is the only compositional fact source.",
      targetAnchorInput: { kind: "working_text_snapshot", sourceSnapshotId: "working-snapshot-1", textSha256 },
    }],
  });
}

function createCoordinator(
  setup: Pick<ReturnType<typeof createSetup>, "root" | "workspace">,
  client: ImageGenerationClient,
) {
  return new GrowthIllustrationCoordinator(setup.workspace, createGateway(setup, client));
}

function createGateway(
  setup: Pick<ReturnType<typeof createSetup>, "root" | "workspace">,
  client: ImageGenerationClient,
) {
  return createWorkspaceAgentToolGateway(setup.workspace, policy, () => true, {
    getImageProviderProfile: () => ({
      providerId: "image-provider", displayName: "Image Provider", baseUrl: "https://image.invalid",
      modelId: "image-model", endpoint: "responses", defaultSize: "1024x1024",
      defaultQuality: "auto", defaultBackground: "auto", apiKey: "secret",
    }),
    createImageGenerationService: () => new ImageGenerationService(
      new ImageAssetRepository(setup.workspace), new ImageAssetStore(setup.root), client,
    ),
  });
}
