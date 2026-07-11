import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { PROVIDER_STORE_FILE_NAME } from "../../src/main/providerSecureStore";

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
  fs.writeFileSync(path.join(workspacePath, "README.md"), "# Large project\nThe marker is COASTLINE_BACKPRESSURE_OK.\n", "utf8");
  for (let index = 1; index <= 6; index += 1) {
    fs.writeFileSync(path.join(workspacePath, `archive-${index}.md`), `# Archive ${index}\n${"coastline memory ".repeat(2_100)}`, "utf8");
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
  let passed = false;
  try {
    app = await electron.launch({
      executablePath: packagedExecutable,
      args: [`--user-data-dir=${userDataPath}`],
    });
    const page = await app.firstWindow();
    await page.getByLabel("给大管家发送消息").fill("请读取当前项目的真实文件，只需告诉我 README.md 中的标记。");
    await page.getByTitle("发送").click();
    const reply = page.locator(".steward-message--assistant, .steward-message--error").last();
    await expect(reply).toBeVisible({ timeout: 240_000 });
    await expect(reply).toContainText("COASTLINE_BACKPRESSURE_OK");
    await expect(reply).not.toContainText("工作进程已中断");
    await expect(reply).not.toHaveClass(/steward-message--error/);
    expect(fs.existsSync(path.join(userDataPath, "agent-worker-diagnostics.jsonl"))).toBe(false);
    passed = true;
  } finally {
    if (app) await app.close();
    if (passed) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`Packaged E2E failure retained at ${root}`);
  }
});
