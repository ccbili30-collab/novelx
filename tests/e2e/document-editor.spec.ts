import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("persists a stable document and recovers a later working copy after restart", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-e2e-editor-"));
  seedEditorResources(workspaceRoot);
  let app: ElectronApplication | null = null;

  try {
    app = await launch(workspaceRoot);
    let page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await page.getByRole("treeitem", { name: "世界设定" }).click();
    const editor = page.getByRole("textbox", { name: "世界设定内容" });
    await expect(editor).toBeEnabled();

    await editor.fill("银湾海岸由沉降纪元与海水倒灌塑造。");
    await expect(page.getByRole("status")).toHaveText("草稿已保存");
    await page.getByTitle("保存稳定版本").click();
    await expect(page.getByRole("status")).toHaveText("稳定版本");
    await page.screenshot({ path: "test-results/novax-editor-stable-1440x900.png", fullPage: true });
    await page.screenshot({ path: "test-results/novax-editor-ide-stable-1440x900.png", fullPage: true });

    await editor.fill("银湾海岸由沉降纪元与海水倒灌塑造。\n这行只存在于可恢复草稿中。");
    await expect(page.getByRole("status")).toHaveText("草稿已保存");
    await app.close();
    app = null;

    app = await launch(workspaceRoot);
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await page.getByRole("treeitem", { name: "世界设定" }).click();
    const recovered = page.getByRole("textbox", { name: "世界设定内容" });
    await expect(recovered).toHaveValue("银湾海岸由沉降纪元与海水倒灌塑造。\n这行只存在于可恢复草稿中。");
    await expect(page.getByRole("status")).toHaveText("草稿已保存");
    await page.screenshot({ path: "test-results/novax-editor-recovered-draft-1440x900.png", fullPage: true });
    await page.getByTitle("保存稳定版本").click();
    await expect(page.getByRole("status")).toHaveText("稳定版本");
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("serializes in-flight saves before resource switches and window close", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-e2e-editor-race-"));
  seedEditorResources(workspaceRoot);
  let app: ElectronApplication | null = null;

  try {
    app = await launch(workspaceRoot, 400);
    let page = await app.firstWindow();
    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await page.getByRole("treeitem", { name: "世界设定" }).click();
    let editor = page.getByRole("textbox", { name: "世界设定内容" });
    await editor.fill("第一份正在保存的草稿");
    await page.waitForTimeout(750);
    await editor.fill("切换资源前必须保留的最新草稿");
    await page.getByRole("treeitem", { name: "角色设定" }).click();
    await expect(page.getByRole("textbox", { name: "角色设定内容" })).toBeEnabled();

    await page.getByRole("treeitem", { name: "世界设定" }).click();
    editor = page.getByRole("textbox", { name: "世界设定内容" });
    await expect(editor).toHaveValue("切换资源前必须保留的最新草稿");
    await page.getByTitle("保存稳定版本").click();
    await editor.fill("稳定保存期间继续输入且切换资源的草稿");
    await page.getByRole("treeitem", { name: "角色设定" }).click();
    await expect(page.getByRole("textbox", { name: "角色设定内容" })).toBeEnabled();
    await page.getByRole("treeitem", { name: "世界设定" }).click();
    editor = page.getByRole("textbox", { name: "世界设定内容" });
    await expect(editor).toHaveValue("稳定保存期间继续输入且切换资源的草稿");
    await editor.fill("关闭窗口前 700ms 内输入的草稿");
    await closeMainWindow(app);
    app = null;

    app = await launch(workspaceRoot);
    page = await app.firstWindow();
    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await page.getByRole("treeitem", { name: "世界设定" }).click();
    await expect(page.getByRole("textbox", { name: "世界设定内容" }))
      .toHaveValue("关闭窗口前 700ms 内输入的草稿");
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function launch(workspaceRoot: string, saveDelayMs = 0): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: {
      ...process.env,
      NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot,
      NOVAX_DESKTOP_E2E_DOCUMENT_SAVE_DELAY_MS: String(saveDelayMs),
    },
  });
}

function seedEditorResources(workspaceRoot: string): void {
  const workspace = openWorkspace(workspaceRoot);
  const resources = new ResourceRepository(workspace);
  const checkpoints = new CheckpointRepository(workspace);
  const roots = resources.listCurrent();
  const checkpointId = checkpoints.appendCheckpoint(checkpoints.getActiveBranch().id, "创建编辑器测试资源");
  resources.putRevision({ checkpointId, type: "world", title: "世界设定", parentId: roots.find((item) => item.type === "world")!.id, state: "active" });
  resources.putRevision({ checkpointId, type: "oc", title: "角色设定", parentId: roots.find((item) => item.type === "oc")!.id, state: "active" });
  workspace.close();
}

async function closeMainWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await closed;
}
