import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreativeWorkspaceService } from "../../src/domain/workspace/creativeWorkspaceService";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("switches creative document tabs, discards drafts, and restores unpublished work after restart", async () => {
  test.setTimeout(60_000);
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-creative-document-e2e-"));
  seedWorkspace(workspaceRoot);
  let app: ElectronApplication | null = null;
  try {
    app = await launch(workspaceRoot);
    let page = await app.firstWindow();
    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await page.getByText("潮痕", { exact: true }).click();
    const tabs = page.getByRole("navigation", { name: "对象文档" });
    await expect(tabs.getByRole("button", { name: "正文", exact: true })).toBeVisible();
    await expect(tabs.getByRole("button", { name: "设定笔记", exact: true })).toBeVisible();

    const prose = page.getByRole("textbox", { name: "正文内容" });
    await prose.fill("第一版稳定正文");
    await page.getByTitle("保存稳定版本").click();
    await expect(page.getByText("稳定版本", { exact: true })).toBeVisible();

    await prose.fill("应当放弃的草稿");
    await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTitle("放弃草稿并恢复稳定版本").click();
    await expect(prose).toHaveValue("第一版稳定正文");

    await prose.fill(`重启后恢复-${"长文档内容".repeat(10_000)}`);
    await tabs.getByRole("button", { name: "设定笔记", exact: true }).click();
    const note = page.getByRole("textbox", { name: "设定笔记内容" });
    await note.fill("独立的设定草稿");
    await tabs.getByRole("button", { name: "正文", exact: true }).click();
    await expect(prose).toHaveValue(/重启后恢复-/);

    await app.close();
    app = await launch(workspaceRoot);
    page = await app.firstWindow();
    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await page.getByText("潮痕", { exact: true }).click();
    await expect(page.getByRole("textbox", { name: "正文内容" })).toHaveValue(/重启后恢复-/);
    await page.getByRole("navigation", { name: "对象文档" }).getByRole("button", { name: "设定笔记", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "设定笔记内容" })).toHaveValue("独立的设定草稿");
    await page.screenshot({ path: "test-results/novax-creative-document-tabs-1100x700.png", fullPage: false });
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function launch(workspaceRoot: string): Promise<ElectronApplication> {
  return electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot } });
}

function seedWorkspace(root: string): void {
  const workspace = openWorkspace(root);
  const service = new CreativeWorkspaceService(workspace);
  const resources = new ResourceRepository(workspace);
  service.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "潮痕", parentId: null });
  const story = resources.listVisibleCurrent().find((item) => item.title === "潮痕")!;
  service.mutate({ action: "create_document", resourceId: story.id, kind: "knowledge_note", title: "设定笔记" });
  workspace.close();
}
