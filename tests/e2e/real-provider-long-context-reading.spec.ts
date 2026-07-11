import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { PROVIDER_STORE_FILE_NAME } from "../../src/main/providerSecureStore";
import { closeTestElectronApp } from "./support/electronCleanup";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const providerStorePath = process.env.NOVAX_REAL_E2E_PROVIDER_STORE?.trim() ?? "";

test.skip(!providerStorePath || !fs.existsSync(providerStorePath), "A machine-local encrypted Provider store is required.");

test("reads a corpus larger than one request through durable source-linked notes", async () => {
  test.setTimeout(420_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-real-long-context-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "project");
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  const fixtures = [
    ["01-天文.md", "双月潮汐决定魔力周期"],
    ["02-地理.md", "银湾海岸由沉降与海水倒灌形成"],
    ["03-族群.md", "精灵源自世界树的记忆分枝"],
    ["04-历史.md", "碎潮战争终结了旧王国"],
    ["05-人物.md", "林雾负责保管潮源罗盘"],
    ["06-物品.md", "银贝指南针指向最近的潮源裂隙"],
  ] as const;
  for (const [fileName, marker] of fixtures) {
    const filler = `${marker}。这一条必须保留来源范围。\n`.repeat(250);
    fs.writeFileSync(path.join(workspacePath, fileName), `# ${fileName}\n${filler}`, "utf8");
  }
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
  let completed = false;
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
    await page.getByLabel("给大管家发送消息").fill([
      "阅读当前项目里的全部 Markdown 文档并提取完整世界观。",
      "这是一个长任务：必须读完每个文件的全部范围，逐块保存带来源的任务笔记，再根据全部笔记汇总。",
      "不要因为单次上下文放不下而让我缩小范围；最终列出六个文件名和各自的核心设定。",
    ].join("\n"));
    await page.getByTitle("发送").click();

    const reply = page.locator(".steward-message--assistant, .steward-message--error").last();
    await expect(reply).toBeVisible({ timeout: 360_000 });
    await expect(reply).not.toHaveClass(/steward-message--error/);
    for (const [fileName] of fixtures) {
      await expect(reply).toContainText(fileName);
    }
    await expect(reply).not.toContainText(/请缩小任务范围|超过模型的安全上下文预算/);
    completed = true;
  } finally {
    await closeTestElectronApp(app);
  }

  try {
    expect(completed).toBe(true);
    const workspace = openWorkspace(workspacePath);
    const notes = workspace.db.prepare(`
      SELECT source_path, source_sha256, start_char, end_char, content
      FROM agent_task_notes ORDER BY source_path, start_char
    `).all() as Array<Record<string, unknown>>;
    workspace.close();
    expect(notes.length).toBeGreaterThanOrEqual(fixtures.length);
    for (const [fileName, marker] of fixtures) {
      const fileNotes = notes.filter((note) => note.source_path === fileName);
      expect(fileNotes.length).toBeGreaterThan(0);
      expect(fileNotes.some((note) => String(note.content).includes(marker))).toBe(true);
      expect(Number(fileNotes[0]?.start_char)).toBe(0);
      for (let index = 1; index < fileNotes.length; index += 1) {
        expect(Number(fileNotes[index]?.start_char)).toBe(Number(fileNotes[index - 1]?.end_char));
      }
      expect(Number(fileNotes.at(-1)?.end_char)).toBe(fs.readFileSync(path.join(workspacePath, fileName), "utf8").length);
    }
    expect(notes.every((note) => Number(note.end_char) > Number(note.start_char))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
