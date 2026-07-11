import { expect, test, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("creates a real player save and shows the missing-Provider block without exposing GM internals", async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "novax-player-ui-user-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-player-ui-workspace-"));
  const app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot } });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      await desktop.workspace.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "潮汐世界", parentId: null });
      await desktop.workspace.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "潮痕", parentId: null });
    });
    await page.reload();
    await page.getByRole("radio", { name: "玩家模式" }).click();
    await page.getByLabel("故事").selectOption({ label: "潮痕" });
    await page.getByLabel("世界").selectOption({ label: "潮汐世界" });
    await page.getByRole("button", { name: "建立配置" }).click();
    await expect(page.getByLabel("故事配置")).toHaveValue(/.+/);
    await page.getByTitle("新建存档").click();
    await expect(page.getByRole("button", { name: /存档 1/ })).toBeVisible();
    await page.getByLabel("玩家行动").fill("走向退潮后的海岸");
    await page.getByTitle("提交行动").click();
    await expect(page.getByRole("alert")).toContainText("需要先配置可用的模型服务");
    await expect(page.locator(".player-turn-card")).toHaveCount(0);
    await expect(page.getByRole("main")).not.toContainText(/resolutionId|stateDelta|evidenceIds|gmResolution/);
    await page.screenshot({ path: "test-results/novax-player-workbench-1440x900.png", fullPage: true });
  } finally {
    await app.close(); fs.rmSync(userDataPath, { recursive: true, force: true }); fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
