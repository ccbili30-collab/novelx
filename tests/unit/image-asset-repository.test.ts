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

  it("lists only committed assets with source attribution and without provider prompts", () => {
    const repository = openRepository();
    const job = repository.createOrGetJob(jobInput("published"));
    repository.claim(job.id);
    repository.markRequestSent(job.id);
    const asset = repository.complete(job.id, assetInput());
    repository.createOrGetJob(jobInput("still-queued"));

    const listed = repository.listPublishedAssets();
    expect(listed).toEqual([{
      asset,
      title: job.title,
      purpose: job.purpose,
      sourceResourceIds: job.sourceResourceIds,
      sourceVersionIds: job.sourceVersionIds,
    }]);
    expect(JSON.stringify(listed)).not.toContain(job.prompt);
    expect(() => repository.listPublishedAssets(0)).toThrowError(
      expect.objectContaining({ code: "IMAGE_ASSET_LIST_LIMIT_INVALID" }),
    );
  });

  it("upgrades an existing v20 workspace to the current image schema", () => {
    const repository = openRepository();
    expect(repository.createOrGetJob(jobInput()).status).toBe("queued");
    workspace!.db.exec("DROP TABLE image_assets; DROP TABLE image_generation_jobs; UPDATE schema_meta SET version = 20 WHERE singleton = 1;");
    workspace!.close(); workspace = openWorkspace(root);
    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 22 });
    expect(new ImageAssetRepository(workspace).createOrGetJob(jobInput("after-upgrade")).status).toBe("queued");
  });

  it("rebuilds v21 image tables without losing portrait or scene jobs and assets", () => {
    const repository = openRepository();
    const portrait = repository.createOrGetJob({ ...jobInput("portrait-v21"), purpose: "character_portrait" });
    repository.claim(portrait.id);
    repository.markRequestSent(portrait.id);
    const asset = repository.complete(portrait.id, assetInput());
    const scene = repository.createOrGetJob(jobInput("scene-v21"));

    workspace!.db.prepare("UPDATE schema_meta SET version = 21 WHERE singleton = 1").run();
    workspace!.close(); workspace = openWorkspace(root);
    const migrated = new ImageAssetRepository(workspace);

    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get()).toEqual({ version: 22 });
    expect(migrated.getRequiredJob(portrait.id)).toMatchObject({
      idempotencyKey: portrait.idempotencyKey,
      purpose: "character_portrait",
      status: "succeeded",
      sourceResourceIds: portrait.sourceResourceIds,
      sourceVersionIds: portrait.sourceVersionIds,
    });
    expect(migrated.getAssetByJob(portrait.id)).toEqual(asset);
    expect(migrated.getRequiredJob(scene.id)).toMatchObject({ purpose: "scene", status: "queued" });
  });

  it("accepts world_map and rejects an unknown purpose", () => {
    const repository = openRepository();
    expect(repository.createOrGetJob({ ...jobInput("world-map"), purpose: "world_map" }).purpose).toBe("world_map");
    expect(() => repository.createOrGetJob({ ...jobInput("invalid-purpose"), purpose: "unknown" as never }))
      .toThrowError(expect.objectContaining({ code: "IMAGE_JOB_PURPOSE_INVALID" }));
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
