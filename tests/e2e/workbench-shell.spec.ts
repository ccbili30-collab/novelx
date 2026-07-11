import { expect, test, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("opens a real local workspace and keeps its identity across Agent/IDE layout changes", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-e2e-workspace-"));
  const app = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".workspace-state")).toHaveText(path.basename(workspaceRoot));
    await expect(page.getByPlaceholder("和大管家讨论、检索或修改当前项目")).toBeVisible();
    await expect(page.getByText("Agent 提示词尚未发布", { exact: true })).toHaveCount(0);
    await expect(page.getByText("自动保存可用", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("main", { name: "novelx 桌面工作台" })).toHaveAttribute("data-mode", "agent");
    await page.screenshot({ path: "test-results/novax-agent-workspace-1440x900.png", fullPage: true });
    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await expect(page.getByRole("main", { name: "novelx 桌面工作台" })).toHaveAttribute("data-mode", "ide");
    await expect(page.locator(".workspace-state")).toHaveText(path.basename(workspaceRoot));
    await expect(page.locator(".domain-heading small")).toHaveText(["0", "0", "0", "0", "0", "0"]);
    await expect(page.getByRole("treeitem")).toHaveCount(6);
    await expect(page.locator(".domain-resource-row")).toHaveCount(0);
    await expect(page.getByText("暂无内容", { exact: true })).toHaveCount(6);
    const resourceRail = await page.locator(".domain-resource-rail").boundingBox();
    const canvas = await page.locator(".canvas").boundingBox();
    const steward = await page.locator(".agent-conversation-panel").boundingBox();
    expect(resourceRail).not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(steward).not.toBeNull();
    expect(resourceRail!.x + resourceRail!.width).toBeLessThanOrEqual(canvas!.x + 1);
    expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(steward!.x + 1);
    expect(steward!.width).toBeGreaterThanOrEqual(300);
    await page.screenshot({ path: "test-results/novax-ide-workspace-1440x900.png", fullPage: true });
    await page.setViewportSize({ width: 1100, height: 700 });
    await expect(page.getByRole("complementary", { name: "项目资源" })).toBeVisible();
    await expect(page.getByRole("region", { name: "大管家" })).toBeVisible();
    await page.screenshot({ path: "test-results/novax-ide-workspace-1100x700.png", fullPage: true });
    expect(fs.existsSync(path.join(workspaceRoot, ".novax", "workspace.db"))).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
