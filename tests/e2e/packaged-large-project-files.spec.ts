import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { PROVIDER_STORE_FILE_NAME } from "../../src/main/providerSecureStore";
import { closeTestElectronApp } from "./support/electronCleanup";

const providerStorePath = process.env.NOVAX_REAL_E2E_PROVIDER_STORE?.trim() ?? "";
const packagedExecutable = path.resolve("release", "win-unpacked", "novelx.exe");

test.skip(!providerStorePath || !fs.existsSync(providerStorePath), "A machine-local encrypted Provider store is required.");
test.skip(!fs.existsSync(packagedExecutable), "The unpacked NovelX application must be built first.");

test("packaged Agent survives backpressure from a large real project overview", async () => {
  test.setTimeout(300_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-packaged-large-files-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "project");
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  const fixtures = {
    "01-力量体系.md": "潮汐术以记忆为代价。",
    "02-场景地图与世界观.md": "银湾海岸由古代沉降形成。",
    "03-人物关系图.md": "林雾与沈星共同调查异变。",
    "04-物品大全.md": "银贝指南针指向潮汐裂隙。",
  };
  for (const [fileName, marker] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(workspacePath, fileName), `# ${fileName}\n${marker}\n${"海岸记忆 ".repeat(7_000)}`, "utf8");
  }
  expect(fs.existsSync(path.join(workspacePath, "README.md"))).toBe(false);
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
  let passed = false;
  try {
    app = await electron.launch({
      executablePath: packagedExecutable,
      args: [`--user-data-dir=${userDataPath}`],
    });
    const page = await app.firstWindow();
    await page.getByLabel("给大管家发送消息").fill("检查当前项目文件，先看整个目录，再读取真实存在的 Markdown 并概括内容。");
    await page.getByTitle("发送").click();
    const reply = page.locator(".steward-message--assistant, .steward-message--error").last();
    await expect(reply).toBeVisible({ timeout: 240_000 });
    for (const fileName of Object.keys(fixtures)) await expect(reply).toContainText(fileName);
    await expect(reply).toContainText(/潮汐术|银湾海岸|林雾|银贝指南针/);
    await expect(reply).not.toContainText(/没有授权|无权限|需要.*README/i);
    await expect(reply).not.toContainText("工作进程已中断");
    await expect(reply).not.toHaveClass(/steward-message--error/);
    expect(fs.existsSync(path.join(userDataPath, "agent-worker-diagnostics.jsonl"))).toBe(false);
    passed = true;
  } finally {
    await closeTestElectronApp(app);
    if (passed) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`Packaged E2E failure retained at ${root}`);
  }
});
