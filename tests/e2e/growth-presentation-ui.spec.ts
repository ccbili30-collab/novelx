import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("starts explicit Growth mode once and visibly fails closed without a Provider", async () => {
  test.setTimeout(40_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-presentation-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });

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
    const growthMode = page.getByRole("radio", { name: "生长", exact: true });

    await expect(composer).toBeEnabled({ timeout: 8_000 });
    await expect(page.getByRole("radio", { name: "协助", exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole("radio", { name: "自由", exact: true })).toBeVisible({ timeout: 8_000 });
    await growthMode.click({ timeout: 8_000 });
    await expect(growthMode).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("当前创作", { exact: true })).toBeVisible();
    await expect(page.getByText("文件夹内容", { exact: true })).toBeVisible();

    await composer.fill("建立一个有潮汐禁令的海港世界");
    const send = page.getByTitle("发送");
    await expect(send).toBeEnabled({ timeout: 8_000 });
    await send.click({ timeout: 8_000 });
    await expect(page.locator(".steward-message--user").filter({ hasText: "建立一个有潮汐禁令的海港世界" })).toBeVisible();
    const timeline = page.getByRole("region", { name: "生长活动时间线" });
    await expect(timeline).toBeVisible({ timeout: 8_000 });
    await expect(timeline.locator(".growth-timeline__row").first()).toContainText("第 1/3 轮");
    await expect(page.locator(".project-files-panel")).toBeVisible();

    await expect.poll(async () => timeline.getAttribute("data-status"), { timeout: 15_000 }).toMatch(/^(blocked|failed)$/);
    await expect(timeline).not.toContainText("本次生长已完成");
    await expect(page.locator("body")).not.toContainText("thinking");
    await page.screenshot({ path: "test-results/novax-growth-presentation-fail-closed-1440x900.png", fullPage: true });
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
