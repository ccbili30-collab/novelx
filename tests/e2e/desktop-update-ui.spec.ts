import { expect, test, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("keeps project versions out of the titlebar and reports unconfigured desktop updates honestly", async () => {
  const app = await electron.launch({ executablePath: electronPath, args: ["."] });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTitle("检查点历史")).toHaveCount(0);
    await expect(page.getByTestId("open-settings")).toHaveAttribute("title", "设置");
    await expect(page.getByRole("button", { name: "软件更新" })).toHaveCount(0);

    await page.getByTestId("open-settings").click();
    await expect(page.getByRole("heading", { name: "novelx 设置" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /当前版本/ })).toBeVisible();
    await expect(page.getByText("开发模式不执行软件更新。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "检查更新" })).toBeDisabled();
    await page.screenshot({ path: "test-results/novax-desktop-update-settings-1100x700.png", fullPage: true });
  } finally {
    await app.close();
  }
});
