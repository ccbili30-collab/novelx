import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("creates and edits typed creative objects through the real desktop UI boundary", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-creative-ui-"));
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      let workspace = await desktop.workspace.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "潮汐世界", parentId: null });
      const world = workspace.resources.find((resource) => resource.title === "潮汐世界")!;
      workspace = await desktop.workspace.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "潮痕", parentId: null });
      const story = workspace.resources.find((resource) => resource.title === "潮痕")!;
      await desktop.workspace.mutate({ action: "create_relation", kind: "uses_world", sourceResourceId: story.id, targetResourceId: world.id });
    });
    await page.reload();
    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await expect(page.getByText("潮汐世界", { exact: true })).toBeVisible();
    await page.getByText("潮痕", { exact: true }).click();
    await expect(page.getByText("使用世界 · 潮汐世界", { exact: true })).toBeVisible();
    await page.getByLabel("创作资源").getByRole("button", { name: "正文", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "正文内容" });
    await editor.fill("潮声从旧城下醒来。");
    await page.getByTitle("保存稳定版本").click();
    await expect(page.getByText("稳定版本", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/novax-stage3-creative-workspace-1440x900.png", fullPage: true });

    const stable = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const workspace = await desktop.workspace.getCurrent();
      const document = workspace!.documents.find((item) => item.title === "正文")!;
      return desktop.creativeDocument.get({ documentId: document.id });
    });
    expect(stable).toMatchObject({ content: "潮声从旧城下醒来。", dirty: false });
    expect(stable.stableVersionId).not.toBeNull();
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
