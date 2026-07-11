import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("renders GFM, Mermaid, blocked Markdown media, and structured Artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-rich-agent-ui-"));
  const userDataPath = path.join(root, "user-data");
  const projectPath = path.join(root, "rich-content-project");
  fs.mkdirSync(projectPath, { recursive: true });
  openWorkspace(projectPath).close();
  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  const project = registry.registerProject(projectPath, "ready");
  const session = registry.createSession(project.id, "结构化展示");
  registry.appendMessage({
    sessionId: session.id,
    role: "user",
    outcome: null,
    text: "typo message",
  });
  registry.appendMessage({
    sessionId: session.id,
    role: "assistant",
    outcome: "blocked",
    text: [
      "| 节点 | 状态 |",
      "| --- | --- |",
      "| 世界设定 | 已核验 |",
      "",
      "```mermaid",
      "flowchart LR",
      "  A[世界] --> B[故事]",
      "```",
      "",
      "![不可信远程图](https://tracker.invalid/pixel.png)",
    ].join("\n"),
    artifacts: [
      { kind: "activity", label: "整理项目资料", status: "succeeded", detail: "已完成公开资料整理。" },
      { kind: "tool_call", tool: "checker", label: "一致性检查", status: "succeeded" },
      { kind: "conflict", code: "conflicting_sources", message: "两个稳定来源存在冲突。", evidenceIds: ["version-1", "version-2"] },
      {
        kind: "image",
        assetId: "asset-preview-1",
        title: "角色立绘",
        status: "ready",
        purpose: "角色视觉预览",
        sourceLabel: "测试资产状态源",
        thumbnailUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      },
    ],
  });
  registry.selectProject(project.id);
  registry.close();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath } });
    const page = await app.firstWindow();
    await expect(page.getByRole("table")).toContainText("世界设定");
    const diagram = page.getByLabel("Mermaid 图表");
    await expect(diagram).toBeVisible();
    await expect(diagram.locator("svg")).toHaveCount(1);
    await expect(page.getByText("Markdown 图片已阻止：不可信远程图。请使用带来源的图片产物。", { exact: true })).toBeVisible();
    const processed = page.getByText("已处理 4 项", { exact: true });
    await expect(processed).toBeVisible();
    await processed.click();
    await expect(page.getByText("整理项目资料", { exact: true })).toBeVisible();
    await expect(page.getByText("一致性检查", { exact: true })).toBeVisible();
    await expect(page.getByText("两个稳定来源存在冲突。", { exact: true })).toBeVisible();
    await expect(page.getByText("角色立绘", { exact: true })).toBeVisible();
    await expect(page.locator("img[src^='data:image/gif']")).toHaveCount(1);
    await expect(page.locator("img[src^='https://tracker.invalid']")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "待审查变更" })).toHaveCount(0);

    const userMessage = page.locator(".steward-message--user").filter({ hasText: "typo message" });
    await userMessage.hover();
    await page.screenshot({ path: "test-results/novax-message-actions-hover.png", fullPage: true });
    await userMessage.getByTitle("复制").click();
    await expect(page.getByText("已复制", { exact: true })).toBeVisible();
    await userMessage.getByTitle("修改上一句").click();
    await expect(page.getByLabel("给大管家发送消息")).toHaveValue("typo message");
    await expect(page.locator(".steward-message--user").filter({ hasText: "typo message" })).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
