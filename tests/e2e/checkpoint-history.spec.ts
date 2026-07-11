import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("restores an older checkpoint through the visible history and keeps it after restart", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-history-e2e-"));
  const seeded = openWorkspace(workspaceRoot);
  const checkpoints = new CheckpointRepository(seeded);
  const resources = new ResourceRepository(seeded);
  const world = resources.listCurrent().find((resource) => resource.type === "world")!;
  const initialBranchId = checkpoints.getActiveBranch().id;
  const laterCheckpointId = checkpoints.appendCheckpoint(initialBranchId, "未来海岸设定");
  resources.putRevision({
    resourceId: world.id,
    checkpointId: laterCheckpointId,
    type: "world",
    title: "银湾世界",
    parentId: null,
    state: "active",
  });
  seeded.close();

  let app: ElectronApplication | null = null;
  try {
    app = await launch(workspaceRoot);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 720 });
    const activeProject = page.locator(".project-group").filter({ hasText: path.basename(workspaceRoot) });
    await activeProject.getByTitle("项目操作").click();
    await page.getByRole("button", { name: "版本与分支" }).click();
    await expect(page.getByRole("dialog", { name: "版本与分支" })).toBeVisible();
    await page.getByTitle("关闭版本与分支").click();
    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await expect(page.getByRole("treeitem", { name: "银湾世界" })).toBeVisible();
    const before = await currentWorkspace(page);

    await expect(page.getByTitle("检查点历史")).toHaveCount(0);
    await page.getByRole("button", { name: "版本与分支" }).click();
    await expect(page.getByRole("dialog", { name: "版本与分支" })).toBeVisible();
    await expect(page.getByText("未来海岸设定", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/novax-checkpoint-history-1280x720.png", fullPage: true });
    await page.getByRole("option", { name: /工作区初始化/ }).click();
    await page.getByRole("button", { name: "从所选版本继续创作" }).click();

    await expect(page.getByRole("dialog", { name: "版本与分支" })).toHaveCount(0);
    await expect(page.getByRole("treeitem", { name: "世界" })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "银湾世界" })).toHaveCount(0);
    const restored = await currentWorkspace(page);
    expect(restored.activeBranchId).not.toBe(before.activeBranchId);

    await app.close();
    app = await launch(workspaceRoot);
    const restartedPage = await app.firstWindow();
    await restartedPage.getByRole("radio", { name: "IDE 模式" }).click();
    await expect(restartedPage.getByRole("treeitem", { name: "世界" })).toBeVisible();
    expect((await currentWorkspace(restartedPage)).activeBranchId).toBe(restored.activeBranchId);
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function launch(workspaceRoot: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot },
  });
}

async function currentWorkspace(page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>) {
  return page.evaluate(async () => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    return (await desktop.workspace.getCurrent())!;
  });
}
