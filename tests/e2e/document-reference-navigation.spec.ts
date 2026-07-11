import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { CreativeDocumentEditorService } from "../../src/domain/workspace/creativeDocumentEditorService";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { CreativeWorkspaceService } from "../../src/domain/workspace/creativeWorkspaceService";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("opens a persisted stable document reference at its structured line locator", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-document-reference-ui-"));
  const userDataPath = path.join(root, "user-data");
  const projectPath = path.join(root, "story-project");
  fs.mkdirSync(projectPath, { recursive: true });
  const reference = seedStableDocument(projectPath);
  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  const project = registry.registerProject(projectPath, "ready");
  const session = registry.createSession(project.id, "资料核验");
  registry.appendMessage({
    sessionId: session.id,
    role: "assistant",
    text: "已根据稳定资料完成核验。",
    outcome: "completed",
    artifacts: [{
      kind: "document_reference",
      documentId: reference.documentId,
      title: "潮汐纪年法",
      versionId: reference.versionId,
      locator: { kind: "line", start: 2, end: 2 },
      excerpt: "第二行：大潮标记新月。",
    }],
  });
  registry.selectProject(project.id);
  registry.close();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath },
    });
    const page = await app.firstWindow();
    await expect(page.getByText("已根据稳定资料完成核验。", { exact: true })).toBeVisible();
    await page.getByText("已处理 1 项", { exact: true }).click();
    const artifact = page.getByRole("button", { name: /潮汐纪年法.*第 2 行.*稳定版本/ });
    await expect(artifact).toBeVisible();
    await artifact.click();

    await expect(page.getByRole("radio", { name: "IDE 模式" })).toHaveAttribute("aria-checked", "true");
    const editor = page.getByRole("textbox", { name: "潮汐纪年法内容" });
    await expect(editor).toHaveValue("第一行：潮月开始。\n第二行：大潮标记新月。\n第三行：港口休市。");
    await expect.poll(async () => editor.evaluate((element) => ({
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
      selected: (element as HTMLTextAreaElement).value.slice(
        (element as HTMLTextAreaElement).selectionStart,
        (element as HTMLTextAreaElement).selectionEnd,
      ),
    }))).toMatchObject({ selected: "第二行：大潮标记新月。" });
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function seedStableDocument(projectPath: string): { documentId: string; versionId: string } {
  const workspace = openWorkspace(projectPath);
  try {
    const creative = new CreativeWorkspaceService(workspace);
    creative.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "潮痕", parentId: null });
    const story = new ResourceRepository(workspace).listVisibleCurrent().find((resource) => resource.title === "潮痕")!;
    creative.mutate({ action: "create_document", resourceId: story.id, kind: "knowledge_note", title: "潮汐纪年法" });
    const document = new CreativeDocumentRepository(workspace).listCurrent(story.id).find((item) => item.title === "潮汐纪年法")!;
    const editor = new CreativeDocumentEditorService(workspace);
    const draft = editor.saveWorkingCopy({
      documentId: document.id,
      content: "第一行：潮月开始。\n第二行：大潮标记新月。\n第三行：港口休市。",
      expectedRevision: 0,
      expectedStableVersionId: null,
    });
    const stable = editor.saveStable({ documentId: document.id, expectedRevision: draft.workingRevision });
    return { documentId: document.id, versionId: stable.stableVersionId! };
  } finally {
    workspace.close();
  }
}
