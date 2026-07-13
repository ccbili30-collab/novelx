import { app, safeStorage } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ImageAssetRepository } from "../domain/asset/imageAssetRepository";
import { ImageAssetStore } from "../domain/asset/imageAssetStore";
import { ImageGenerationService } from "../domain/asset/imageGenerationService";
import { CheckpointRepository } from "../domain/version/checkpointRepository";
import { DocumentRepository } from "../domain/workspace/documentRepository";
import { ResourceRepository } from "../domain/workspace/resourceRepository";
import { openWorkspace } from "../domain/workspace/workspaceRepository";
import { ImageProviderSecureStore } from "./imageProviderSecureStore";

const userDataPath = path.resolve(
  process.env.NOVAX_IMAGE_LIVE_USER_DATA?.trim()
    || path.join(process.env.APPDATA || "", "novelx-desktop"),
);
app.setPath("userData", userDataPath);

async function main(): Promise<void> {
  await app.whenReady();
  const workspaceRoot = requiredPath("NOVAX_IMAGE_LIVE_WORKSPACE");
  const reportPath = requiredPath("NOVAX_IMAGE_LIVE_REPORT");
  const prompt = requiredText("NOVAX_IMAGE_LIVE_PROMPT", 50_000);
  const providerStore = new ImageProviderSecureStore(userDataPath, safeStorage);
  const publicState = providerStore.getPublicState();
  if (!publicState.secureStorageAvailable) throw smokeError("IMAGE_PROVIDER_SECURE_STORAGE_UNAVAILABLE");
  if (!publicState.hasCredential) throw smokeError("IMAGE_PROVIDER_CREDENTIAL_UNREADABLE");
  if (!publicState.config) throw smokeError("IMAGE_PROVIDER_CONFIG_INVALID");
  const profile = providerStore.loadRuntimeProfile();
  if (!profile) throw smokeError("IMAGE_PROVIDER_RUNTIME_PROFILE_INVALID");
  const workspace = openWorkspace(workspaceRoot);
  try {
    const source = createSourceDocument(workspace, prompt);
    const service = new ImageGenerationService(
      new ImageAssetRepository(workspace),
      new ImageAssetStore(workspace.rootPath),
    );
    const result = await service.generate({
      idempotencyKey: `live-smoke:${sha256(`${profile.providerId}\0${profile.modelId}\0${prompt}`)}`,
      title: "潮汐观测者",
      purpose: "character_portrait",
      prompt,
      sourceResourceIds: [source.resourceId],
      sourceVersionIds: [source.versionId],
    }, profile);
    const store = new ImageAssetStore(workspace.rootPath);
    const verifiedBytes = store.readVerified(result.asset.relativePath, result.asset.sha256);
    const report = {
      formatVersion: 1,
      classification: "live-image-provider-smoke",
      generatedAt: new Date().toISOString(),
      status: "passed",
      provider: { providerId: profile.providerId, modelId: profile.modelId },
      source: { resourceId: source.resourceId, versionId: source.versionId },
      job: { id: result.job.id, status: result.job.status, requestSentAt: result.job.requestSentAt },
      asset: {
        id: result.asset.id,
        mimeType: result.asset.mimeType,
        width: result.asset.width,
        height: result.asset.height,
        byteLength: result.asset.byteLength,
        sha256: result.asset.sha256,
        relativePath: result.asset.relativePath,
        verifiedByteLength: verifiedBytes.length,
      },
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify({
      type: "image-provider-live-smoke.completed",
      status: report.status,
      reportPath,
      asset: report.asset,
    })}\n`);
  } finally {
    profile.apiKey = "";
    workspace.close();
  }
}

function createSourceDocument(workspace: ReturnType<typeof openWorkspace>, prompt: string): {
  resourceId: string;
  versionId: string;
} {
  const resources = new ResourceRepository(workspace);
  const worldRoot = resources.listCurrent().find((resource) => (
    resource.type === "world" && resource.objectKind === "domain_root"
  ));
  if (!worldRoot) throw smokeError("WORLD_ROOT_NOT_FOUND");
  const checkpoints = new CheckpointRepository(workspace);
  const branch = checkpoints.getActiveBranch();
  const checkpointId = checkpoints.appendCheckpoint(branch.id, "真实图片 Provider 验证来源");
  const resource = resources.putRevisionWithReceipt({
    checkpointId,
    type: "world",
    objectKind: "world",
    title: "潮汐观测者验证世界",
    parentId: worldRoot.id,
    state: "active",
  });
  const versionId = new DocumentRepository(workspace).putVersion({
    resourceId: resource.resourceId,
    checkpointId,
    content: `图片生成验证来源：${prompt}`,
    authorKind: "user",
  });
  return { resourceId: resource.resourceId, versionId };
}

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw smokeError("IMAGE_LIVE_SMOKE_INPUT_REQUIRED");
  return path.resolve(value);
}

function requiredText(name: string, maximum: number): string {
  const value = process.env[name]?.trim();
  if (!value || value.length > maximum) throw smokeError("IMAGE_LIVE_SMOKE_INPUT_REQUIRED");
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function smokeError(code: string): Error & { code: string } {
  return Object.assign(new Error("Image Provider live smoke failed."), { code });
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "IMAGE_PROVIDER_LIVE_SMOKE_FAILED";
  process.stderr.write(`${JSON.stringify({ type: "image-provider-live-smoke.failed", code })}\n`);
  process.exitCode = 1;
}).finally(() => app.exit(typeof process.exitCode === "number" ? process.exitCode : 0));
