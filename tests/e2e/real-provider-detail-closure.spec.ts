import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { PROVIDER_STORE_FILE_NAME } from "../../src/main/providerSecureStore";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const providerStorePath = process.env.NOVAX_REAL_E2E_PROVIDER_STORE?.trim() ?? "";

test.skip(!providerStorePath || !fs.existsSync(providerStorePath), "A machine-local encrypted Provider store is required.");

test("walks an empty current project with the real Provider without leaking internal scope language", async () => {
  test.setTimeout(240_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-real-detail-closure-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "empty-project");
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
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
      env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath, NOVAX_DESKTOP_E2E_WORKSPACE: workspacePath },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const providerStatus = await page.evaluate(() => (
        window as typeof window & { novaxDesktop: DesktopApi }
      ).novaxDesktop.provider.getStatus());
    if (!providerStatus.ok) throw new Error(`Provider status failed: ${providerStatus.error.code}: ${providerStatus.error.message}`);
    expect(providerStatus).toMatchObject({ ok: true, state: { secureStorageAvailable: true, hasCredential: true } });

    const composer = page.getByLabel("给大管家发送消息");
    await composer.fill("请查看当前项目里已经有什么内容，直接告诉我结果。");
    await page.getByTitle("发送").click();
    const reply = page.locator(".steward-message--assistant, .steward-message--error").last();
    await expect(reply).toBeVisible({ timeout: 180_000 });
    await expect(reply).not.toContainText("没有获得任何已授权");
    await expect(reply).not.toContainText("授权范围");
    await expect(reply).not.toContainText("资源 ID");
    await expect(page.getByRole("region", { name: "待审查变更" })).toHaveCount(0);
    await page.screenshot({
      path: "test-results/novax-real-empty-project-detail-closure.png",
      fullPage: false,
      animations: "disabled",
      timeout: 60_000,
    });
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
