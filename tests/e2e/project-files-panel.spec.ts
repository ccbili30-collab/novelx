import { expect, test, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("shows real project files independently from the collapsed activity section", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-files-panel-"));
  const userDataPath = path.join(root, "user-data");
  const projectPath = path.join(root, "coastline-world");
  fs.mkdirSync(path.join(projectPath, "世界观"), { recursive: true });
  fs.writeFileSync(path.join(projectPath, "世界观", "海岸.md"), "海岸线由远古地壳沉降形成。", "utf8");
  fs.writeFileSync(path.join(projectPath, "README.md"), "# 潮汐世界", "utf8");
  openWorkspace(projectPath).close();
  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  const project = registry.registerProject(projectPath, "ready");
  registry.ensureDefaultSession(project.id);
  registry.selectProject(project.id);
  registry.close();

  const app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const files = page.locator("details.right-panel-section").filter({ hasText: "文件夹内容" });
    const activity = page.locator("details.right-panel-section--activity");
    await expect(files).toHaveAttribute("open", "");
    await expect(activity).not.toHaveAttribute("open", "");
    await expect(page.getByText("README.md", { exact: true })).toBeVisible();
    await expect(page.getByText("世界观", { exact: true })).toBeVisible();
    await page.getByText("海岸.md", { exact: true }).click();
    await expect(page.getByRole("region", { name: "文件预览" })).toContainText("海岸线由远古地壳沉降形成。");

    await activity.locator(":scope > summary").click();
    await expect(activity).toHaveAttribute("open", "");
    await files.locator(":scope > summary").click();
    await expect(files).not.toHaveAttribute("open", "");
    await expect(activity).toHaveAttribute("open", "");
    await page.reload();
    await expect(files).not.toHaveAttribute("open", "");
    await expect(activity).toHaveAttribute("open", "");
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
