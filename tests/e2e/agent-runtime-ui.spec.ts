import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("runs the visible Steward through real IPC and preserves fail-closed gates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-agent-ui-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  const secret = "novax-agent-ui-secret-5f824";
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
    await page.setViewportSize({ width: 1440, height: 900 });
    const composer = page.getByLabel("给大管家发送消息");
    await expect(composer).toBeEnabled();

    await composer.fill("请先检查银湾海岸的现有资料");
    await page.getByTitle("发送").click();
    await expect(page.getByText("请先检查银湾海岸的现有资料")).toBeVisible();
    await expect(page.locator(".steward-message--error > p", { hasText: "需要先配置可用的模型服务。" })).toBeVisible();
    const blockedTrace = page.getByText("已处理 1 项", { exact: true }).first();
    await expect(blockedTrace).toBeVisible();
    await blockedTrace.click();
    await expect(page.getByText("生成回复", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: "test-results/novax-agent-provider-blocked-1440x900.png", fullPage: true });

    const saved = await page.evaluate(async ({ apiKey }) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.provider.save({
        config: {
          providerId: "e2e-provider",
          displayName: "E2E Provider",
          baseUrl: "https://provider.example/v1",
          modelId: "e2e-model",
          contextWindow: 128_000,
          maxTokens: 16_000,
          reasoning: false,
          input: ["text"],
        },
        apiKey,
      });
    }, { apiKey: secret });
    expect(saved).toMatchObject({ ok: true, state: { hasCredential: true } });

    await page.getByRole("radio", { name: "自由" }).click();
    await expect(page.getByRole("radio", { name: "自由" })).toHaveAttribute("aria-checked", "true");
    await composer.fill("把刚才的讨论直接写入正式世界事实");
    await composer.press("Enter");
    await expect(page.locator(".steward-message--error > p", { hasText: "模型服务运行失败。" }).last()).toBeVisible();
    await expect(page.locator("body")).not.toContainText(secret);

    await page.setViewportSize({ width: 1100, height: 700 });
    await page.screenshot({ path: "test-results/novax-agent-provider-failed-1100x700.png", fullPage: true });
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
