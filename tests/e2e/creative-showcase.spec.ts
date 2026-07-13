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
    await expect(showcase.locator(".showcase-toolbar__controls > span").first()).toHaveText("雾潮纪事");
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
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

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
    creative.mutate({ action: "create_resource", domain: "oc", objectKind: "oc", title: "洛弥", parentId: null });
    creative.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "雾潮纪事", parentId: null });

    const resources = new ResourceRepository(workspace);
    const world = resources.listCurrent().find((resource) => resource.title === "雾潮世界")!;
    const character = resources.listCurrent().find((resource) => resource.title === "洛弥")!;
    const story = resources.listCurrent().find((resource) => resource.title === "雾潮纪事")!;
    creative.mutate({ action: "create_relation", kind: "uses_world", sourceResourceId: story.id, targetResourceId: world.id });
    creative.mutate({ action: "create_relation", kind: "uses_oc", sourceResourceId: story.id, targetResourceId: character.id });

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
