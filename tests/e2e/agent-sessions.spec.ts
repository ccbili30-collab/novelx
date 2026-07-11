import { expect, test, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("keeps projects and independent Agent sessions across Agent and IDE modes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-agent-sessions-"));
  const userDataPath = path.join(root, "user-data");
  const coastlinePath = path.join(root, "coastline-world");
  const puppetPath = path.join(root, "puppet-story");
  fs.mkdirSync(coastlinePath, { recursive: true });
  fs.mkdirSync(puppetPath, { recursive: true });
  const coastlineWorkspace = openWorkspace(coastlinePath);
  const coastlineCheckpointId = new CheckpointRepository(coastlineWorkspace).getActiveBranch().headCheckpointId;
  coastlineWorkspace.close();
  openWorkspace(puppetPath).close();

  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  const coastline = registry.registerProject(coastlinePath, "ready");
  const puppet = registry.registerProject(puppetPath, "ready");
  const coastAgent = registry.createSession(coastline.id, "海岸线成因");
  const historyAgent = registry.createSession(coastline.id, "国家历史");
  const puppetAgent = registry.createSession(puppet.id, "木偶战斗场景");
  registry.appendMessage({ sessionId: coastAgent.id, role: "assistant", text: "海岸线资料已经整理。", outcome: "completed" });
  registry.appendMessage({ sessionId: puppetAgent.id, role: "assistant", text: "木偶技能演出仍在构思。", outcome: "completed" });
  registry.publishSharedMemory({
    projectId: coastline.id,
    sourceSessionId: historyAgent.id,
    title: "建国史资料索引",
    content: "正式资料位于世界领域，使用前需要检索。",
    scopeResourceIds: [],
    checkpointId: coastlineCheckpointId,
  });
  registry.createHandoff({
    projectId: coastline.id,
    senderSessionId: historyAgent.id,
    recipientSessionId: coastAgent.id,
    title: "核验国家建国史",
    instructions: "先检查建国时间线，再决定是否进入正文。",
    scopeResourceIds: [],
    checkpointId: coastlineCheckpointId,
  });
  registry.selectProject(coastline.id);
  registry.close();

  const app = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const projectRail = page.getByRole("complementary", { name: "项目与 Agent 会话" });
    await expect(projectRail.getByText("coastline-world", { exact: true })).toBeVisible();
    await expect(projectRail.getByText("puppet-story", { exact: true })).toBeVisible();
    await expect(projectRail.getByText("海岸线成因", { exact: true })).toBeVisible();
    await expect(projectRail.getByText("木偶战斗场景", { exact: true })).toBeVisible();
    await expect(page.getByText("海岸线资料已经整理。", { exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "项目活动与产物" })).toBeVisible();
    await expect(page.getByText("核验国家建国史", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "接受", exact: true }).click();
    await expect(page.getByText("正在处理", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/novax-agent-project-sessions-1440x900.png", fullPage: true });

    await projectRail.getByText("木偶战斗场景", { exact: true }).click();
    await expect(page.getByText("木偶技能演出仍在构思。", { exact: true })).toBeVisible();
    await expect(page.getByText("海岸线资料已经整理。", { exact: true })).toHaveCount(0);
    await expect(page.getByText("puppet-story", { exact: true }).first()).toBeVisible();

    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await expect(page.getByRole("complementary", { name: "项目资源" })).toBeVisible();
    await expect(page.getByRole("region", { name: "大管家" })).toContainText("木偶战斗场景");
    await expect(page.getByText("木偶技能演出仍在构思。", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/novax-ide-project-agent-1440x900.png", fullPage: true });

    await page.getByRole("radio", { name: "Agent 模式" }).click();
    await expect(projectRail.getByText("木偶战斗场景", { exact: true })).toBeVisible();
    await expect(page.getByText("木偶技能演出仍在构思。", { exact: true })).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rescans an existing-material project after restart instead of showing zero counts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-material-rescan-"));
  const userDataPath = path.join(root, "user-data");
  const projectPath = path.join(root, "existing-materials");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, "chapter.txt"), "source", "utf8");
  fs.writeFileSync(path.join(projectPath, "notes.bin"), "unsupported", "utf8");
  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  const project = registry.registerProject(projectPath, "materials_detected");
  registry.ensureDefaultSession(project.id);
  registry.selectProject(project.id);
  registry.close();

  const app = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath },
  });
  try {
    const page = await app.firstWindow();
    const dialog = page.getByRole("dialog", { name: "初始化 novelx 项目" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("检测到 2 个文件，其中 1 个可以建立来源索引");
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
