import { expect, test, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("shows the same safe Project Doctor report in Agent and IDE modes", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-doctor-e2e-"));
  const app = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 760 });
    const activeProject = page.locator(".project-group").filter({ hasText: path.basename(workspaceRoot) });
    await activeProject.getByTitle("项目操作").click();
    await activeProject.getByRole("button", { name: "项目体检" }).click();

    const dialog = page.getByRole("dialog", { name: "项目体检" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("发现需要处理的问题")).toBeVisible();
    await expect(dialog.getByText("历史版本缺少第四阶段清单")).toBeVisible();
    await expect(dialog.getByText("自动修复尚未开放", { exact: false })).toBeVisible();
    await expect(dialog).not.toContainText("COMMIT_UNSEALED");
    await expect(dialog).not.toContainText("workspace.db");
    await expect(dialog).not.toContainText(workspaceRoot);
    await page.screenshot({ path: "test-results/novelx-project-doctor-agent.png", fullPage: true });
    await dialog.getByRole("button", { name: "完成" }).click();

    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await page.locator(".project-tool-list").getByRole("button", { name: "项目体检" }).click();
    await expect(page.getByRole("dialog", { name: "项目体检" })).toBeVisible();
    await expect(page.getByText("尚未实现的投影：", { exact: false })).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
