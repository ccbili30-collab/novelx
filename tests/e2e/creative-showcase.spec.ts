import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ImageAssetRepository } from "../../src/domain/asset/imageAssetRepository";
import { ImageAssetStore } from "../../src/domain/asset/imageAssetStore";
import { CreativeDocumentEditorService } from "../../src/domain/workspace/creativeDocumentEditorService";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { CreativeWorkspaceService } from "../../src/domain/workspace/creativeWorkspaceService";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import type { DesktopApi } from "../../src/shared/ipcContract";
import { commitFixtureCheckpoint } from "../helpers/workspaceFixtures";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("shows story, source-bound image, characters and event graph in one real workspace view", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-creative-showcase-"));
  let app: ElectronApplication | null = null;
  seedShowcaseWorkspace(workspaceRoot);
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("radio", { name: "作品预览" }).click();

    const showcase = page.getByRole("article", { name: "创作联合展台" });
    await expect(showcase).toBeVisible();
    const storySelect = showcase.getByRole("combobox", { name: "故事", exact: true });
    await storySelect.selectOption({ label: "雾潮纪事" });
    await expect(storySelect.locator("option:checked")).toHaveText("雾潮纪事");
    await expect(showcase.getByText("洛弥在退潮后的银滩上醒来。", { exact: false })).toBeVisible();
    await expect(showcase.getByRole("button", { name: /洛弥.*OC/ })).toBeVisible();
    await expect(showcase.getByText("雾潮列车 · 抵达", { exact: true })).toBeVisible();

    const image = showcase.getByRole("img", { name: "洛弥与雾潮列车" });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2);

    const projection = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.workspace.listImageAssets();
    });
    expect(projection).toMatchObject({ ok: true, assets: [{ title: "洛弥与雾潮列车", purpose: "scene" }] });
    expect(JSON.stringify(projection)).not.toMatch(/prompt|providerId|modelId|relativePath|sha256|workspace\.db/i);

    await page.screenshot({ path: "test-results/novax-creative-showcase-1440x900.png", fullPage: true });
    await expect(page.getByRole("article", { name: "语义图谱" })).toBeVisible();

    await expect(showcase.getByRole("button", { name: "进入玩家模式" })).toBeDisabled();
    await expect(showcase.getByText("游玩世界：等待选择", { exact: true })).toBeVisible();
    await showcase.getByLabel("游玩世界").selectOption({ label: "雾潮世界" });
    await showcase.getByRole("button", { name: "进入玩家模式" }).click();
    await expect(page.getByRole("region", { name: "玩家模式" })).toBeVisible();
    const firstLaunch = await inspectPlayerLaunch(page);
    expect(firstLaunch).toMatchObject({
      profiles: [{
        title: "雾潮纪事",
        storyTitle: "雾潮纪事",
        worldTitle: "雾潮世界",
        status: "active",
        ocTitles: ["洛弥", "雾鸢"],
      }],
      playthroughCounts: [1],
    });

    await page.getByRole("radio", { name: "作品预览" }).click();
    const reopenedShowcase = page.getByRole("article", { name: "创作联合展台" });
    await reopenedShowcase.getByLabel("游玩世界").selectOption({ label: "雾潮世界" });
    await reopenedShowcase.getByRole("button", { name: "进入玩家模式" }).click();
    await expect(page.getByRole("region", { name: "玩家模式" })).toBeVisible();
    const secondLaunch = await inspectPlayerLaunch(page);
    expect(secondLaunch).toEqual(firstLaunch);

    await page.getByRole("radio", { name: "作品预览" }).click();
    const noWorldShowcase = page.getByRole("article", { name: "创作联合展台" });
    await noWorldShowcase.getByRole("combobox", { name: "故事", exact: true }).selectOption({ label: "无界故事" });
    await expect(noWorldShowcase.getByText("这个故事尚未绑定世界，补充世界关系后才能进入玩家模式。")).toBeVisible();
    await expect(noWorldShowcase.getByRole("button", { name: "进入玩家模式" })).toBeDisabled();
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

async function inspectPlayerLaunch(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const workspace = await desktop.workspace.getCurrent();
    const result = await desktop.play.listStoryProfiles();
    if (!workspace || !result.ok) throw new Error("Fixture player launch projection was unavailable.");
    const byId = new Map(workspace.resources.map((resource) => [resource.id, resource.title]));
    const playthroughCounts: number[] = [];
    for (const profile of result.profiles) {
      const playthroughs = await desktop.play.listPlaythroughs({ storyProfileId: profile.id });
      if (!playthroughs.ok) throw new Error(playthroughs.error.message);
      playthroughCounts.push(playthroughs.playthroughs.length);
    }
    return {
      profiles: result.profiles.map((profile) => ({
        id: profile.id,
        title: profile.title,
        storyTitle: byId.get(profile.storyResourceId),
        worldTitle: byId.get(profile.worldResourceId),
        status: profile.status,
        ocTitles: profile.ocBindings.map((binding) => byId.get(binding.ocResourceId)).sort(),
      })),
      playthroughCounts,
    };
  });
}

test("fails closed when image assets are requested without an open workspace", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  delete env.NOVAX_DESKTOP_E2E_WORKSPACE;
  const app = await electron.launch({ executablePath: electronPath, args: ["."], env });
  try {
    const page = await app.firstWindow();
    const result = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.workspace.listImageAssets();
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "WORKSPACE_NOT_OPEN", message: "尚未打开工作区。" },
    });
  } finally {
    await app.close();
  }
});

function seedShowcaseWorkspace(root: string): void {
  const workspace = openWorkspace(root);
  try {
    const creative = new CreativeWorkspaceService(workspace);
    creative.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "雾潮世界", parentId: null });
    creative.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "镜潮世界", parentId: null });
    creative.mutate({ action: "create_resource", domain: "oc", objectKind: "oc", title: "洛弥", parentId: null });
    creative.mutate({ action: "create_resource", domain: "oc", objectKind: "oc", title: "雾鸢", parentId: null });
    creative.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "雾潮纪事", parentId: null });
    creative.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "无界故事", parentId: null });

    const resources = new ResourceRepository(workspace);
    const world = resources.listCurrent().find((resource) => resource.title === "雾潮世界")!;
    const secondWorld = resources.listCurrent().find((resource) => resource.title === "镜潮世界")!;
    const character = resources.listCurrent().find((resource) => resource.title === "洛弥")!;
    const secondCharacter = resources.listCurrent().find((resource) => resource.title === "雾鸢")!;
    const story = resources.listCurrent().find((resource) => resource.title === "雾潮纪事")!;
    creative.mutate({ action: "create_relation", kind: "uses_world", sourceResourceId: story.id, targetResourceId: world.id });
    creative.mutate({ action: "create_relation", kind: "uses_world", sourceResourceId: story.id, targetResourceId: secondWorld.id });
    creative.mutate({ action: "create_relation", kind: "uses_oc", sourceResourceId: story.id, targetResourceId: character.id });
    creative.mutate({ action: "create_relation", kind: "uses_oc", sourceResourceId: story.id, targetResourceId: secondCharacter.id });

    const prose = new CreativeDocumentRepository(workspace).listCurrent()
      .find((document) => document.resourceId === story.id && document.kind === "prose")!;
    const editor = new CreativeDocumentEditorService(workspace);
    const draft = editor.saveWorkingCopy({
      documentId: prose.id,
      content: "# 第一幕\n\n洛弥在退潮后的银滩上醒来。远处的雾潮列车正驶入废弃站台。",
      expectedRevision: 0,
      expectedStableVersionId: null,
    });
    editor.saveStable({ documentId: prose.id, expectedRevision: draft.workingRevision });

    const assertions = new AssertionRepository(workspace);
    commitFixtureCheckpoint(workspace, {
      idempotencyKey: "showcase-event",
      summary: "确认雾潮列车抵达事件",
      label: "记录第一幕事件",
    }, (checkpointId, changeSetId) => assertions.putVersion({
      assertionId: "assertion.showcase.arrival",
      checkpointId,
      scopeType: "story",
      scopeId: story.id,
      subject: "雾潮列车",
      predicate: "抵达",
      object: { text: "列车在退潮时抵达废弃站台。", entityRef: { resourceId: character.id, relation: "被洛弥目击" } },
      status: "current",
      source: { kind: "confirmed_change_set", ref: changeSetId },
    }));

    const sourceVersion = workspace.db.prepare(`
      SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(character.id) as { id: string };
    const imageRepository = new ImageAssetRepository(workspace);
    const job = imageRepository.createOrGetJob({
      idempotencyKey: "showcase-image",
      providerId: "fixture-provider",
      modelId: "fixture-model",
      title: "洛弥与雾潮列车",
      purpose: "scene",
      prompt: "E2E fixture only; not a Live provider result.",
      size: "1024x1024",
      quality: "auto",
      background: "auto",
      sourceResourceIds: [character.id],
      sourceVersionIds: [sourceVersion.id],
    });
    imageRepository.claim(job.id);
    imageRepository.markRequestSent(job.id);
    const stored = new ImageAssetStore(root).save(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
      "base64",
    ));
    imageRepository.complete(job.id, stored);
  } finally {
    workspace.close();
  }
}
