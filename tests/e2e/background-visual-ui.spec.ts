import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { closeTestElectronApp } from "./support/electronCleanup";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("uses centered Snow by default and persists custom or no background", async () => {
  test.setTimeout(60_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-background-visual-"));
  const userDataPath = path.join(root, "user-data");
  const projectPath = path.join(root, "background-project");
  fs.mkdirSync(projectPath, { recursive: true });
  openWorkspace(projectPath).close();
  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  const project = registry.registerProject(projectPath, "ready");
  registry.createSession(project.id, "Snow 背景验收");
  registry.selectProject(project.id);
  registry.close();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1100, height: 700 });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.background)).toBe("snow");
    const backgroundStyle = await page.locator(".workbench-grid--agent > .agent-conversation-panel").evaluate((element) => {
      const pseudo = getComputedStyle(element, "::before");
      return { position: pseudo.backgroundPosition, repeat: pseudo.backgroundRepeat, image: pseudo.backgroundImage };
    });
    expect(backgroundStyle.position).toBe("50% 50%");
    expect(backgroundStyle.repeat).toBe("no-repeat");
    expect(backgroundStyle.image).not.toBe("none");
    await page.screenshot({ path: "test-results/novelx-background-snow-1100x700.png", fullPage: false });

    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("background-snow")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("background-file-input").setInputFiles(path.resolve("src/renderer/src/assets/snow.svg"));
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.background)).toBe("custom");
    await expect(page.getByTestId("background-custom")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("background-none").click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.background)).toBe("none");
    await expect(page.getByTestId("background-none")).toHaveAttribute("aria-checked", "true");

    await closeTestElectronApp(app);
    app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath } });
    const reopened = await app.firstWindow();
    await expect.poll(() => reopened.evaluate(() => document.documentElement.dataset.background)).toBe("none");
  } finally {
    await closeTestElectronApp(app);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
