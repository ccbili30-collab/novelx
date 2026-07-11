import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreativeWorkspaceService } from "../../src/domain/workspace/creativeWorkspaceService";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("renames, moves, blocks invalid deletion, and renders a deep long-title tree at minimum width", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-object-operations-"));
  const longTitle = `第六层地点-${"曲折海岸线与古代潮汐观测站".repeat(9)}`;
  seedWorkspace(workspaceRoot, longTitle);
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.getByRole("radio", { name: "IDE 模式" }).click();

    const longRow = page.getByTitle(longTitle);
    await expect(longRow).toBeVisible();
    await expect(longRow).toHaveAttribute("title", longTitle);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.getByText("待移动地点", { exact: true }).click();
    await page.getByRole("button", { name: "移动", exact: true }).click();
    const moveDialog = page.getByRole("dialog", { name: "移动创作对象" });
    await moveDialog.getByLabel("新的上级对象").selectOption({ label: "第二世界 · 世界" });
    await moveDialog.getByRole("button", { name: "移动" }).click();
    await expect(moveDialog).toBeHidden();

    await page.getByText("待移动地点", { exact: true }).click();
    await page.getByRole("button", { name: "重命名", exact: true }).click();
    const renameDialog = page.getByRole("dialog", { name: "重命名创作对象" });
    await renameDialog.getByLabel("新的名称").fill("已重命名地点");
    await renameDialog.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("已重命名地点", { exact: true })).toBeVisible();

    await page.getByText("第一世界", { exact: true }).click();
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await page.getByRole("alertdialog", { name: "删除创作对象" }).getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByRole("alert")).toContainText("请先移动或删除下级对象");
    await expect(page.getByText("第一世界", { exact: true })).toBeVisible();
    await page.getByRole("alertdialog", { name: "删除创作对象" }).getByRole("button", { name: "取消" }).click();

    await page.getByText("可删除地点", { exact: true }).click();
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await page.getByRole("alertdialog", { name: "删除创作对象" }).getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText("可删除地点", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: "test-results/novax-deep-resource-tree-1100x700.png", fullPage: false });
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function seedWorkspace(root: string, longTitle: string): void {
  const workspace = openWorkspace(root);
  const service = new CreativeWorkspaceService(workspace);
  const resources = new ResourceRepository(workspace);
  service.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "第一世界", parentId: null });
  service.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "第二世界", parentId: null });
  const firstWorld = resources.listVisibleCurrent().find((item) => item.title === "第一世界")!;
  service.mutate({ action: "create_resource", domain: "world", objectKind: "location", title: "待移动地点", parentId: firstWorld.id });
  service.mutate({ action: "create_resource", domain: "world", objectKind: "location", title: "可删除地点", parentId: firstWorld.id });
  let parentId = firstWorld.id;
  for (let depth = 1; depth <= 6; depth += 1) {
    const title = depth === 6 ? longTitle : `第${depth}层地点`;
    service.mutate({ action: "create_resource", domain: "world", objectKind: "location", title, parentId });
    parentId = resources.listVisibleCurrent().find((item) => item.title === title)!.id;
  }
  workspace.close();
}
