import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ImageAssetRepository } from "../../src/domain/asset/imageAssetRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let workspace: WorkspaceDatabase | null = null;
let root = "";
afterEach(() => { workspace?.close(); workspace = null; if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("ImageAssetRepository", () => {
  it("deduplicates the same request and rejects an idempotency-key payload conflict", () => {
    const repository = openRepository();
    const input = jobInput();
    const first = repository.createOrGetJob(input);
    const replay = repository.createOrGetJob({ ...input, sourceResourceIds: [...input.sourceResourceIds, ...input.sourceResourceIds] });
    expect(replay).toEqual(first);
    expect(() => repository.createOrGetJob({ ...jobInput(), prompt: "另一张图" }))
      .toThrowError(expect.objectContaining({ code: "IMAGE_JOB_IDEMPOTENCY_CONFLICT" }));
    expect(() => repository.createOrGetJob({ ...jobInput("missing-source"), sourceVersionIds: ["missing"] }))
      .toThrowError(expect.objectContaining({ code: "IMAGE_JOB_SOURCE_VERSION_NOT_FOUND" }));
  });

  it("recovers only definitely-unsent work and quarantines a possibly charged request", () => {
    const repository = openRepository();
    const unsent = repository.createOrGetJob(jobInput("unsent"));
    repository.claim(unsent.id);
    const sent = repository.createOrGetJob(jobInput("sent"));
    repository.claim(sent.id);
    repository.markRequestSent(sent.id);

    expect(repository.recoverInterruptedJobs()).toEqual({ requeued: 1, reconciliationRequired: 1 });
    expect(repository.getRequiredJob(unsent.id).status).toBe("queued");
    expect(repository.getRequiredJob(sent.id)).toMatchObject({
      status: "reconciliation_required",
      errorCode: "IMAGE_PROVIDER_OUTCOME_UNKNOWN",
    });
  });

  it("commits one ready asset only after a sent running request", () => {
    const repository = openRepository();
    const job = repository.createOrGetJob(jobInput());
    repository.claim(job.id);
    expect(() => repository.complete(job.id, assetInput())).toThrowError(expect.objectContaining({ code: "IMAGE_JOB_NOT_COMPLETABLE" }));
    repository.markRequestSent(job.id);
    expect(() => repository.complete(job.id, { ...assetInput(), relativePath: "../outside.png" }))
      .toThrowError(expect.objectContaining({ code: "IMAGE_ASSET_PATH_INVALID" }));
    const asset = repository.complete(job.id, assetInput());
    expect(asset).toMatchObject({ jobId: job.id, status: "ready", mimeType: "image/png" });
    expect(repository.getRequiredJob(job.id).status).toBe("succeeded");
    expect(repository.complete(job.id, assetInput())).toEqual(asset);
  });

  it("upgrades an existing v20 workspace to the image schema", () => {
    const repository = openRepository();
    expect(repository.createOrGetJob(jobInput()).status).toBe("queued");
    workspace!.db.exec("DROP TABLE image_assets; DROP TABLE image_generation_jobs; UPDATE schema_meta SET version = 20 WHERE singleton = 1;");
    workspace!.close(); workspace = openWorkspace(root);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 21 });
    expect(new ImageAssetRepository(workspace).createOrGetJob(jobInput("after-upgrade")).status).toBe("queued");
  });
});

function openRepository() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-image-asset-repository-"));
  workspace = openWorkspace(root);
  return new ImageAssetRepository(workspace);
}

function jobInput(idempotencyKey = "image-job-1") {
  const source = workspace!.db.prepare(`
    SELECT resource_id, id AS version_id FROM resource_revisions ORDER BY created_at, id LIMIT 1
  `).get() as { resource_id: string; version_id: string };
  return {
    idempotencyKey, providerId: "image-provider", modelId: "image-model", title: "银湾场景",
    purpose: "scene" as const, prompt: "银湾海岸的夜色", size: "1024x1024",
    quality: "auto" as const, background: "auto" as const,
    sourceResourceIds: [source.resource_id], sourceVersionIds: [source.version_id],
  };
}

function assetInput() {
  return {
    mimeType: "image/png" as const, width: 1024, height: 1024, byteLength: 128,
    sha256: "a".repeat(64), relativePath: `.novax/assets/images/${"a".repeat(64)}.png`,
    providerResponseIdSha256: "b".repeat(64),
  };
}
