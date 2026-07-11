import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { PROVIDER_STORE_FILE_NAME } from "../../src/main/providerSecureStore";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const providerStorePath = process.env.NOVAX_REAL_E2E_PROVIDER_STORE?.trim() ?? "";

test.skip(!providerStorePath || !fs.existsSync(providerStorePath), "A machine-local encrypted Provider store is required.");

test("reads real project files and exposes audited file activity", async () => {
  test.setTimeout(240_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-real-project-files-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "project");
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "README.md"), "# 星潮计划\n这是一个海岸幻想小说项目。\n", "utf8");
  fs.writeFileSync(path.join(workspacePath, "world.md"), "银湾海岸由古代沉降与海水倒灌形成。\n", "utf8");
  fs.writeFileSync(path.join(workspacePath, "src", "notes.ts"), "export const theme = 'tide';\n", "utf8");
  fs.copyFileSync(providerStorePath, path.join(userDataPath, PROVIDER_STORE_FILE_NAME));
  const localStatePath = path.join(path.dirname(providerStorePath), "Local State");
  if (fs.existsSync(localStatePath)) fs.copyFileSync(localStatePath, path.join(userDataPath, "Local State"));
  openWorkspace(workspacePath).close();

  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  const project = registry.registerProject(workspacePath, "ready");
  registry.ensureDefaultSession(project.id);
  registry.selectProject(project.id);
  registry.close();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: {
        ...process.env,
        NOVAX_DESKTOP_E2E_USER_DATA: userDataPath,
        NOVAX_DESKTOP_E2E_WORKSPACE: workspacePath,
      },
    });
    const page = await app.firstWindow();
    const composer = page.getByLabel("给大管家发送消息");
    await composer.fill("请完整总结当前项目文件夹，说明实际读取了哪些文件、哪些没有读取。");
    await page.getByTitle("发送").click();

    const reply = page.locator(".steward-message--assistant, .steward-message--error").last();
    await expect(reply).toBeVisible({ timeout: 180_000 });
    await expect(reply).toContainText("README.md");
    await expect(reply).toContainText("world.md");
    await expect(reply).toContainText(/星潮|银湾|海岸/);
    await expect(reply).not.toContainText("没有授权");
    await expect(reply).not.toContainText("六个项目");

    const processed = reply.locator(".agent-artifacts");
    await expect(processed).toBeVisible();
    await processed.locator("summary").click();
    await expect(processed).toContainText("检查项目文件");
    await expect(processed).toContainText("README.md");
    await expect(processed).toContainText("world.md");
    await expect(processed).not.toContainText(workspacePath);
    await expect(processed).not.toContainText(".novax");
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reviews a real Agent file update and restores the previous file checkpoint", async () => {
  test.setTimeout(300_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-real-project-file-write-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "project");
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  const original = "# 星潮计划\n旧简介：海岸幻想小说。\n";
  fs.writeFileSync(path.join(workspacePath, "README.md"), original, "utf8");
  fs.copyFileSync(providerStorePath, path.join(userDataPath, PROVIDER_STORE_FILE_NAME));
  const localStatePath = path.join(path.dirname(providerStorePath), "Local State");
  if (fs.existsSync(localStatePath)) fs.copyFileSync(localStatePath, path.join(userDataPath, "Local State"));
  const workspace = openWorkspace(workspacePath);
  const initialCheckpointId = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
  workspace.close();

  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  const project = registry.registerProject(workspacePath, "ready");
  registry.ensureDefaultSession(project.id);
  registry.selectProject(project.id);
  registry.close();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: {
        ...process.env,
        NOVAX_DESKTOP_E2E_USER_DATA: userDataPath,
        NOVAX_DESKTOP_E2E_WORKSPACE: workspacePath,
      },
    });
    const page = await app.firstWindow();
    const composer = page.getByLabel("给大管家发送消息");
    await composer.fill([
      "请先读取 README.md，然后把旧简介改成：这是一个围绕银湾海岸与潮汐文明展开的幻想小说项目。",
      "只能通过 project_file.put 建立待确认的 Change Set，不要修改其他文件，不要直接提交。",
    ].join("\n"));
    await page.getByTitle("发送").click();

    const reply = page.locator(".steward-message--assistant, .steward-message--error").last();
    await expect(reply).toBeVisible({ timeout: 180_000 });
    await expect(reply).toContainText(/等待|确认|审查|候选/);

    const reviewed = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const pending = await desktop.changeSet.listPending();
      if (!pending.ok || pending.changeSets.length !== 1) throw new Error("Expected one pending file Change Set.");
      const changeSetId = pending.changeSets[0]!.id;
      let detail = await desktop.changeSet.get({ changeSetId });
      if (!detail.ok) throw new Error("Pending file Change Set could not be read.");
      if (detail.changeSet.items.length !== 1 || detail.changeSet.items[0]!.kind !== "project_file") {
        throw new Error("Agent proposed an unexpected Change Set item.");
      }
      detail = await desktop.changeSet.decide({
        changeSetId,
        itemId: detail.changeSet.items[0]!.id,
        decision: "accepted",
      });
      if (!detail.ok) throw new Error("File Change Set review failed.");
      const finalized = await desktop.changeSet.finalizeAssist({ changeSetId, label: "更新 README 项目简介" });
      if (!finalized.ok) throw new Error(`File Change Set finalization failed: ${finalized.error.code}`);
      return finalized.changeSet;
    });
    expect(reviewed).toMatchObject({ status: "committed", pendingCount: 0 });
    expect(fs.readFileSync(path.join(workspacePath, "README.md"), "utf8"))
      .toContain("围绕银湾海岸与潮汐文明展开");

    const restored = await page.evaluate(async (checkpointId) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.workspace.restore({ checkpointId });
    }, initialCheckpointId);
    expect(restored.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspacePath, "README.md"), "utf8")).toBe(original);
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
