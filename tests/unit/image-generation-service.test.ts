import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ImageAssetRepository } from "../../src/domain/asset/imageAssetRepository";
import { ImageAssetStore } from "../../src/domain/asset/imageAssetStore";
import { ImageGenerationService } from "../../src/domain/asset/imageGenerationService";
import { ResponsesImageProviderError } from "../../src/domain/asset/responsesImageProviderClient";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
let workspace: WorkspaceDatabase | null = null;
let root = "";
afterEach(() => { workspace?.close(); workspace = null; if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("ImageGenerationService", () => {
  it("persists one real response-shaped asset and reuses it without a second charge", async () => {
    const client = vi.fn().mockResolvedValue({ bytes: ONE_PIXEL_PNG, responseId: "response-1" });
    const service = createService(client);
    const firstProgress: string[] = [];
    const replayProgress: string[] = [];
    const first = await service.generate(request(), profile(), undefined, (progress) => firstProgress.push(progress));
    const replay = await service.generate(request(), profile(), undefined, (progress) => replayProgress.push(progress));
    expect(client).toHaveBeenCalledTimes(1);
    expect(replay.asset).toEqual(first.asset);
    expect(first.job.status).toBe("succeeded");
    expect(fs.existsSync(path.join(root, first.asset.relativePath))).toBe(true);
    expect(firstProgress).toEqual(["queued", "generating", "ready"]);
    expect(replayProgress).toEqual(["ready"]);
  });

  it("requires reconciliation after an uncertain network outcome and never retries it", async () => {
    const client = vi.fn().mockRejectedValue(new ResponsesImageProviderError("IMAGE_PROVIDER_CONNECTION_FAILED", true));
    const service = createService(client);
    const progress: string[] = [];
    await expect(service.generate(request(), profile(), undefined, (state) => progress.push(state))).rejects.toMatchObject({ code: "IMAGE_PROVIDER_CONNECTION_FAILED" });
    const job = new ImageAssetRepository(workspace!).getJobByIdempotencyKey("visual-1")!;
    expect(job.status).toBe("reconciliation_required");
    await expect(service.generate(request(), profile())).rejects.toMatchObject({ code: "IMAGE_JOB_RECONCILIATION_REQUIRED" });
    expect(client).toHaveBeenCalledTimes(1);
    expect(progress).toEqual(["queued", "generating", "reconciliation_required"]);
  });

  it("records a definitive provider rejection as failed", async () => {
    const client = vi.fn().mockRejectedValue(new ResponsesImageProviderError("IMAGE_PROVIDER_GENERATION_FAILED", false, 400));
    const service = createService(client);
    const progress: string[] = [];
    await expect(service.generate(request(), profile(), undefined, (state) => progress.push(state))).rejects.toMatchObject({ code: "IMAGE_PROVIDER_GENERATION_FAILED" });
    expect(new ImageAssetRepository(workspace!).getJobByIdempotencyKey("visual-1")).toMatchObject({
      status: "failed", errorCode: "IMAGE_PROVIDER_REQUEST_REJECTED",
    });
    expect(progress).toEqual(["queued", "generating", "failed"]);
  });

  it.each([
    [400, "IMAGE_PROVIDER_REQUEST_REJECTED"],
    [401, "IMAGE_PROVIDER_AUTH_FAILED"],
    [404, "IMAGE_PROVIDER_MODEL_UNAVAILABLE"],
    [429, "IMAGE_PROVIDER_RATE_LIMITED"],
    [503, "IMAGE_PROVIDER_SERVICE_UNAVAILABLE"],
  ] as const)("persists the safe HTTP failure class for status %s", async (status, expectedCode) => {
    const client = vi.fn().mockRejectedValue(new ResponsesImageProviderError("IMAGE_PROVIDER_GENERATION_FAILED", false, status));
    const service = createService(client);

    await expect(service.generate(request(), profile())).rejects.toMatchObject({ code: "IMAGE_PROVIDER_GENERATION_FAILED" });
    expect(new ImageAssetRepository(workspace!).getJobByIdempotencyKey("visual-1"))
      .toMatchObject({ status: "failed", errorCode: expectedCode });
  });

  it("isolates observer failures from durable image completion", async () => {
    const service = createService(vi.fn().mockResolvedValue({ bytes: ONE_PIXEL_PNG, responseId: "response-observer" }));
    await expect(service.generate(request(), profile(), undefined, () => { throw new Error("observer"); })).resolves.toMatchObject({ job: { status: "succeeded" } });
  });

  it("serializes separate service instances for the same workspace", async () => {
    const client = vi.fn().mockResolvedValue({ bytes: ONE_PIXEL_PNG, responseId: "response-shared" });
    const first = createService(client);
    const second = new ImageGenerationService(
      new ImageAssetRepository(workspace!),
      new ImageAssetStore(root),
      client,
    );
    const [one, two] = await Promise.all([
      first.generate(request(), profile()),
      second.generate(request(), profile()),
    ]);
    expect(client).toHaveBeenCalledTimes(1);
    expect(two.asset.id).toBe(one.asset.id);
  });

  it("cancels before dispatch without calling or charging the Provider", async () => {
    const client = vi.fn().mockResolvedValue({ bytes: ONE_PIXEL_PNG, responseId: "must-not-run" });
    const service = createService(client);
    const controller = new AbortController();
    controller.abort();
    await expect(service.generate(request(), profile(), controller.signal))
      .rejects.toMatchObject({ code: "IMAGE_JOB_CANCELLED" });
    expect(client).not.toHaveBeenCalled();
    expect(new ImageAssetRepository(workspace!).getJobByIdempotencyKey("visual-1")).toMatchObject({
      status: "failed", errorCode: "IMAGE_JOB_CANCELLED",
    });
  });
});

function createService(client: ConstructorParameters<typeof ImageGenerationService>[2]) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-image-generation-service-"));
  workspace = openWorkspace(root);
  return new ImageGenerationService(new ImageAssetRepository(workspace), new ImageAssetStore(root), client);
}

function request() {
  const source = workspace!.db.prepare(`
    SELECT resource_id, id AS version_id FROM resource_revisions ORDER BY created_at, id LIMIT 1
  `).get() as { resource_id: string; version_id: string };
  return {
    idempotencyKey: "visual-1", title: "银湾海岸", purpose: "scene" as const,
    prompt: "夜色中的银湾海岸", sourceResourceIds: [source.resource_id], sourceVersionIds: [source.version_id],
  };
}

function profile() {
  return {
    providerId: "image-provider", displayName: "图片模型", baseUrl: "https://proxy.example",
    modelId: "image-model", endpoint: "responses" as const, defaultSize: "1024x1024",
    defaultQuality: "auto" as const, defaultBackground: "auto" as const, apiKey: "secret",
  };
}
