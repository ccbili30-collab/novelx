import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("persists the supported themes and keeps long rich content usable at the minimum window", async () => {
  test.setTimeout(60_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-theme-visual-"));
  const userDataPath = path.join(root, "user-data");
  const projectPath = path.join(root, "theme-project");
  fs.mkdirSync(projectPath, { recursive: true });
  openWorkspace(projectPath).close();
  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  const project = registry.registerProject(projectPath, "ready");
  const session = registry.createSession(project.id, "主题与长文本验收");
  registry.appendMessage({
    sessionId: session.id,
    role: "assistant",
    outcome: "blocked",
    text: [
      "## 世界结构审计",
      "这是一段用于验证最小窗口下自动换行的长文本。世界历史、人物动机、力量体系、地理环境和故事因果必须保持可读，不能覆盖右侧活动区，也不能迫使整个工作台产生横向滚动。".repeat(5),
      "",
      "```mermaid",
      "flowchart LR",
      "  A[世界基底] --> B[故事项目]",
      "  B --> C[角色变体]",
      "  C --> D[稳定正文]",
      "```",
    ].join("\n"),
    artifacts: [{ kind: "tool_call", tool: "checker", label: "世界一致性检查", status: "succeeded" }],
  });
  registry.selectProject(project.id);
  registry.close();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1100, height: 700 });
    const renderStarted = Date.now();
    const diagram = page.getByLabel("Mermaid 图表");
    await expect(diagram).toBeVisible();
    await expect(diagram.locator("svg")).toHaveCount(1);
    expect(Date.now() - renderStarted).toBeLessThan(5_000);
    const diagramBox = await diagram.boundingBox();
    expect(diagramBox?.width ?? 0).toBeGreaterThan(100);
    expect(diagramBox?.height ?? 0).toBeGreaterThan(40);
    await page.getByText("已处理 1 项", { exact: true }).click();
    await expect(page.getByText("世界一致性检查", { exact: true })).toBeVisible();

    const settingsButton = page.getByTestId("open-settings");
    await expect(settingsButton).toBeVisible();
    expect(await settingsButton.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return top === button || Boolean(top && button.contains(top));
    })).toBe(true);
    await page.screenshot({ path: "test-results/novax-theme-minimum-window-1100x700.png", fullPage: false });
    await settingsButton.click({ force: true });
    for (const theme of ["white", "dark", "high-contrast"] as const) {
      await page.getByTestId(`theme-${theme}`).click();
      await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/novax-theme-${theme}-1100x700.png`, fullPage: false });
    }

    await app.close();
    app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath } });
    const reopened = await app.firstWindow();
    await expect.poll(() => reopened.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("high-contrast");
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
