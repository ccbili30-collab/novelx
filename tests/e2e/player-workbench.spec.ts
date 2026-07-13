import { expect, test, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ImageAssetRepository } from "../../src/domain/asset/imageAssetRepository";
import { ImageAssetStore } from "../../src/domain/asset/imageAssetStore";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { PlaythroughRepository } from "../../src/domain/play/playthroughRepository";
import { StoryProfileRepository } from "../../src/domain/story/storyProfileRepository";
import { CreativeWorkspaceService } from "../../src/domain/workspace/creativeWorkspaceService";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("creates a real player save and shows the missing-Provider block without exposing GM internals", async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "novax-player-ui-user-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-player-ui-workspace-"));
  const app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot } });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      await desktop.workspace.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "潮汐世界", parentId: null });
      await desktop.workspace.mutate({ action: "create_resource", domain: "oc", objectKind: "oc", title: "拾潮者", parentId: null });
      await desktop.workspace.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "潮痕", parentId: null });
      const workspace = await desktop.workspace.getCurrent();
      if (!workspace) throw new Error("Fixture workspace was unavailable.");
      const story = workspace.resources.find((resource) => resource.title === "潮痕")!;
      const oc = workspace.resources.find((resource) => resource.title === "拾潮者")!;
      await desktop.workspace.mutate({ action: "create_relation", kind: "uses_oc", sourceResourceId: story.id, targetResourceId: oc.id });
    });
    await page.reload();
    await page.getByRole("radio", { name: "玩家模式" }).click();
    await page.getByLabel("故事").selectOption({ label: "潮痕" });
    await page.getByLabel("世界").selectOption({ label: "潮汐世界" });
    await page.getByRole("button", { name: "建立配置" }).click();
    await expect(page.getByLabel("故事配置")).toHaveValue(/.+/);
    const profileProjection = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const workspace = await desktop.workspace.getCurrent();
      const result = await desktop.play.listStoryProfiles();
      if (!workspace || !result.ok) throw new Error("Fixture profile projection was unavailable.");
      const profile = result.profiles[0];
      return profile.ocBindings.map((binding) => workspace.resources.find((resource) => resource.id === binding.ocResourceId)?.title);
    });
    expect(profileProjection).toEqual(["拾潮者"]);
    await page.getByTitle("新建存档").click();
    await expect(page.getByRole("button", { name: /存档 1/ })).toBeVisible();
    await page.getByLabel("玩家行动").fill("走向退潮后的海岸");
    await page.getByTitle("提交行动").click();
    await expect(page.getByRole("alert")).toContainText("需要先配置可用的模型服务");
    await expect(page.locator(".player-turn-card")).toHaveCount(0);
    await expect(page.getByRole("main")).not.toContainText(/resolutionId|stateDelta|evidenceIds|gmResolution/);
    await page.screenshot({ path: "test-results/novax-player-workbench-1440x900.png", fullPage: true });
  } finally {
    await app.close(); fs.rmSync(userDataPath, { recursive: true, force: true }); fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("shows only the latest ready scene image directly bound to the active story", async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "novax-player-scene-user-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-player-scene-workspace-"));
  seedPlayerSceneFixture(workspaceRoot);
  const app = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("radio", { name: "玩家模式" }).click();
    const turn = page.locator(".player-turn-card");
    await expect(turn).toHaveCount(1);
    const image = turn.getByRole("img", { name: "场景：银滩晨光" });
    await expect(image).toBeVisible();
    await expect(turn).toContainText("来源绑定场景 · 银滩晨光");
    await expect(turn).not.toContainText(/过期潮汐|旁支角色场景|角色肖像/);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.src.startsWith("novax-asset://image/"))).toBe(true);
    await expect(page.locator(".semantic-graph")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(userDataPath, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function seedPlayerSceneFixture(root: string): void {
  const workspace = openWorkspace(root);
  try {
    const creative = new CreativeWorkspaceService(workspace);
    creative.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "银滩世界", parentId: null });
    creative.mutate({ action: "create_resource", domain: "oc", objectKind: "oc", title: "拾潮者", parentId: null });
    creative.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "银滩晨歌", parentId: null });
    const resources = new ResourceRepository(workspace);
    const world = resources.listCurrent().find((resource) => resource.title === "银滩世界")!;
    const oc = resources.listCurrent().find((resource) => resource.title === "拾潮者")!;
    const story = resources.listCurrent().find((resource) => resource.title === "银滩晨歌")!;
    creative.mutate({ action: "create_relation", kind: "uses_world", sourceResourceId: story.id, targetResourceId: world.id });
    creative.mutate({ action: "create_relation", kind: "uses_oc", sourceResourceId: story.id, targetResourceId: oc.id });

    const profile = new StoryProfileRepository(workspace).create({
      storyResourceId: story.id,
      worldResourceId: world.id,
      canonCommitId: new CheckpointRepository(workspace).getActiveBranch().headCheckpointId,
      title: story.title,
      ocBindings: [{ ocResourceId: oc.id }],
    });
    const playthroughs = new PlaythroughRepository(workspace);
    const playthrough = playthroughs.create({ storyProfileId: profile.id });
    playthroughs.appendTurn({
      playthroughId: playthrough.id,
      playerAction: "踏上退潮后的银滩",
      gmResolution: { fixture: true },
      writerText: "晨光越过潮沟，照亮了通往旧灯塔的足迹。",
      stateSnapshot: { location: "银滩" },
    });

    const storyVersionId = latestResourceVersionId(workspace, story.id);
    const ocVersionId = latestResourceVersionId(workspace, oc.id);
    createFixtureImage(workspace, root, {
      key: "scene-old", title: "昨日银滩", purpose: "scene", sourceResourceId: story.id,
      sourceVersionId: storyVersionId, createdAt: "2026-07-14T01:00:00.000Z",
    });
    createFixtureImage(workspace, root, {
      key: "scene-current", title: "银滩晨光", purpose: "scene", sourceResourceId: story.id,
      sourceVersionId: storyVersionId, createdAt: "2026-07-14T02:00:00.000Z",
    });
    createFixtureImage(workspace, root, {
      key: "scene-stale", title: "过期潮汐", purpose: "scene", sourceResourceId: story.id,
      sourceVersionId: storyVersionId, createdAt: "2026-07-14T03:00:00.000Z", stale: true,
    });
    createFixtureImage(workspace, root, {
      key: "scene-oc", title: "旁支角色场景", purpose: "scene", sourceResourceId: oc.id,
      sourceVersionId: ocVersionId, createdAt: "2026-07-14T04:00:00.000Z",
    });
    createFixtureImage(workspace, root, {
      key: "portrait-story", title: "角色肖像", purpose: "character_portrait", sourceResourceId: story.id,
      sourceVersionId: storyVersionId, createdAt: "2026-07-14T05:00:00.000Z",
    });
  } finally {
    workspace.close();
  }
}

function createFixtureImage(workspace: WorkspaceDatabase, root: string, input: {
  key: string;
  title: string;
  purpose: "character_portrait" | "scene";
  sourceResourceId: string;
  sourceVersionId: string;
  createdAt: string;
  stale?: boolean;
}): void {
  const repository = new ImageAssetRepository(workspace);
  const job = repository.createOrGetJob({
    idempotencyKey: `player-fixture-${input.key}`,
    providerId: "fixture-provider",
    modelId: "fixture-model",
    title: input.title,
    purpose: input.purpose,
    prompt: "E2E Fixture only; this is not a Live image Provider result.",
    size: "1024x1024",
    quality: "auto",
    background: "auto",
    sourceResourceIds: [input.sourceResourceId],
    sourceVersionIds: [input.sourceVersionId],
  });
  repository.claim(job.id);
  repository.markRequestSent(job.id);
  const stored = new ImageAssetStore(root).save(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
    "base64",
  ));
  const asset = repository.complete(job.id, stored);
  workspace.db.prepare("UPDATE image_assets SET status = ?, created_at = ?, updated_at = ? WHERE id = ?")
    .run(input.stale ? "stale" : "ready", input.createdAt, input.createdAt, asset.id);
}

function latestResourceVersionId(workspace: WorkspaceDatabase, resourceId: string): string {
  const row = workspace.db.prepare(`
    SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(resourceId) as { id: string } | undefined;
  if (!row) throw new Error("Fixture resource version was unavailable.");
  return row.id;
}
