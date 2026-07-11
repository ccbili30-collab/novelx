import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("manages project registration and Agent session lifecycle through visible menus", async () => {
  test.slow();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-project-session-ui-"));
  const userDataPath = path.join(root, "user-data");
  const projectPath = path.join(root, "lifecycle-project");
  fs.mkdirSync(projectPath, { recursive: true });
  openWorkspace(projectPath).close();
  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  const project = registry.registerProject(projectPath, "ready");
  const primary = registry.createSession(project.id, "世界讨论");
  const disposable = registry.createSession(project.id, "临时会话");
  registry.appendMessage({ sessionId: primary.id, role: "user", text: "讨论海岸线。", outcome: null });
  registry.appendMessage({ sessionId: primary.id, role: "assistant", text: "先核验世界资料。", outcome: "completed" });
  registry.selectProject(project.id);
  registry.close();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath } });
    const page = await app.firstWindow();
    await page.evaluate(() => {
      window.prompt = () => "世界设定讨论";
      window.confirm = () => true;
    });
    const rail = page.getByRole("complementary", { name: "项目与 Agent 会话" });

    await openSessionActions(page, "世界讨论");
    await page.getByRole("button", { name: "重命名" }).click();
    await expect(rail.getByText("世界设定讨论", { exact: true })).toBeVisible();

    await openSessionActions(page, "世界设定讨论");
    await page.getByRole("button", { name: "归档会话" }).click();
    const archived = rail.getByText("已归档（1）", { exact: true });
    await expect(archived).toBeVisible();
    await archived.click();
    await expect(rail.getByText("世界设定讨论", { exact: true })).toBeVisible();

    await openSessionActions(page, "世界设定讨论");
    await page.getByRole("button", { name: "恢复会话" }).click();
    await expect(rail.getByText("世界设定讨论", { exact: true })).toBeVisible();

    await rail.getByText("世界设定讨论", { exact: true }).click();
    await expect(page.getByText("先核验世界资料。", { exact: true })).toBeVisible();
    await openSessionActions(page, "世界设定讨论");
    await page.getByRole("button", { name: "清空对话" }).click();
    await expect.poll(() => page.evaluate(async (sessionId) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return (await desktop.session.messages({ sessionId })).messages.length;
    }, primary.id)).toBe(0);
    await expect(page.getByText("先核验世界资料。", { exact: true })).toHaveCount(0);
    await expect(rail.getByText("世界设定讨论", { exact: true })).toBeVisible();

    await openSessionActions(page, "临时会话");
    await page.getByRole("button", { name: "删除会话" }).click();
    await expect(rail.getByText("临时会话", { exact: true })).toHaveCount(0);

    const projectGroup = page.locator(".project-group").filter({ hasText: "lifecycle-project" });
    await projectGroup.getByTitle("项目操作").click();
    await page.getByRole("button", { name: "重新扫描" }).click();
    await expect(rail.getByText("lifecycle-project", { exact: true })).toBeVisible();

    await projectGroup.getByTitle("项目操作").click();
    await page.getByRole("button", { name: "移出列表" }).click();
    await expect(rail.getByText("已移除项目（1）", { exact: true })).toBeVisible();
    await rail.getByText("已移除项目（1）", { exact: true }).click();
    await rail.getByText("lifecycle-project", { exact: true }).click();
    await expect(rail.getByText("lifecycle-project", { exact: true })).toBeVisible();
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function openSessionActions(page: Page, title: string): Promise<void> {
  const row = page.locator(".session-row-wrap").filter({ hasText: title }).first();
  const details = row.locator("details.rail-actions");
  if (await details.getAttribute("open") === null) await row.getByTitle("会话操作").click();
}
