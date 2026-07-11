import { expect, test, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("opens the isolated novelx workbench without demo content", async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "novax-shell-user-data-"));
  const app = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });

    await expect(page).toHaveTitle("novelx");
    await expect.poll(() => page.evaluate(() => {
      const browserWindow = globalThis as typeof globalThis & { novaxDesktop?: unknown };
      return typeof browserWindow.novaxDesktop;
    })).toBe("object");
    await expect(page.getByRole("main", { name: "novelx 桌面工作台" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "项目与 Agent 会话" })).toBeVisible();
    await expect(page.getByRole("region", { name: "大管家" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "项目活动与产物" })).toBeVisible();
    await expect(page.getByText("添加一个目录开始创作")).toBeVisible();

    await page.screenshot({ path: "test-results/novax-shell-1440x900.png", fullPage: true });
  } finally {
    await app.close();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
