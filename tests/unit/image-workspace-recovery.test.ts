import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImageAssetRepository } from "../../src/domain/asset/imageAssetRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { WorkspaceSession } from "../../src/main/workspaceIpc";

let root = "";
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = ""; });

describe("Image job workspace recovery", () => {
  it("requeues only unsent work and quarantines possibly charged requests when a workspace opens", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-image-workspace-recovery-"));
    let workspace = openWorkspace(root);
    const repository = new ImageAssetRepository(workspace);
    const source = workspace.db.prepare(`
      SELECT resource_id, id FROM resource_revisions ORDER BY created_at, id LIMIT 1
    `).get() as { resource_id: string; id: string };
    const unsent = repository.createOrGetJob(job("unsent", source));
    repository.claim(unsent.id);
    const sent = repository.createOrGetJob(job("sent", source));
    repository.claim(sent.id);
    repository.markRequestSent(sent.id);
    workspace.close();

    const temporaryPath = path.join(root, ".novax", "assets", "tmp");
    fs.mkdirSync(temporaryPath, { recursive: true });
    fs.writeFileSync(path.join(temporaryPath, "interrupted.tmp"), "partial", "utf8");
    const session = new WorkspaceSession();
    session.openPath(root);
    session.close();

    workspace = openWorkspace(root);
    const recovered = new ImageAssetRepository(workspace);
    expect(recovered.getRequiredJob(unsent.id).status).toBe("queued");
    expect(recovered.getRequiredJob(sent.id)).toMatchObject({
      status: "reconciliation_required",
      errorCode: "IMAGE_PROVIDER_OUTCOME_UNKNOWN",
    });
    workspace.close();
    expect(fs.existsSync(path.join(temporaryPath, "interrupted.tmp"))).toBe(false);
  });
});

function job(suffix: string, source: { resource_id: string; id: string }) {
  return {
    idempotencyKey: `recovery-${suffix}`,
    providerId: "image-provider",
    modelId: "image-model",
    title: `恢复测试-${suffix}`,
    purpose: "scene" as const,
    prompt: "银湾海岸的月光场景",
    size: "1024x1024",
    quality: "auto" as const,
    background: "auto" as const,
    sourceResourceIds: [source.resource_id],
    sourceVersionIds: [source.id],
  };
}
