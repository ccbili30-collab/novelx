import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("creates the complete stage-three object hierarchy, relations, and writing constraints through the UI", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-stage3-lifecycle-"));
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("radio", { name: "IDE 模式" }).click();

    await createRoot(page, "世界", "群岛世界");
    await createChild(page, "群岛世界", "地点", "雾港");
    await page.getByText("群岛世界", { exact: true }).click();
    await createChild(page, "群岛世界", "势力", "潮汐议会");

    await createRoot(page, "OC", "槐");
    await createRoot(page, "故事", "潮痕");
    await createChild(page, "潮痕", "卷", "第一卷");
    await createChild(page, "第一卷", "章节", "潮声初醒");
    await page.getByText("潮痕", { exact: true }).click();
    await createChild(page, "潮痕", "角色变体", "槐·潮痕");

    await page.getByText("潮痕", { exact: true }).click();
    await createRelation(page, "使用世界 · 群岛世界");
    await createRelation(page, "使用角色 · 槐");
    await expect(page.getByText("使用世界 · 群岛世界", { exact: true })).toBeVisible();
    await expect(page.getByText("使用角色 · 槐", { exact: true })).toBeVisible();

    await page.getByText("槐·潮痕", { exact: true }).click();
    await createRelation(page, "基础角色 · 槐");
    await expect(page.getByText("基础角色 · 槐", { exact: true })).toBeVisible();

    await page.getByText("潮痕", { exact: true }).click();
    await page.getByTitle("创建约束").click();
    const constraint = page.getByRole("dialog", { name: "编辑写作约束" });
    await constraint.getByLabel("名称").fill("潮痕喜剧风格");
    await constraint.getByLabel("叙事视角").selectOption("third");
    await constraint.getByLabel("时态").selectOption("past");
    await constraint.getByLabel("语气").fill("轻快诙谐");
    await constraint.getByLabel("节奏").fill("紧凑");
    await constraint.getByLabel("幽默程度").fill("4");
    await constraint.getByLabel("禁止内容（每行一条）").fill("无来源复活\n人物性格突变");
    await constraint.getByLabel("必须遵守（每行一条）").fill("遵守世界规则\n保持人物一致性");
    await constraint.getByLabel("补充说明").fill("笑点不能破坏剧情因果。");
    await constraint.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("button", { name: /潮痕喜剧风格/ })).toBeVisible();

    await page.getByRole("button", { name: /潮痕喜剧风格/ }).click();
    const reopened = page.getByRole("dialog", { name: "编辑写作约束" });
    await expect(reopened.getByLabel("语气")).toHaveValue("轻快诙谐");
    await expect(reopened.getByLabel("必须遵守（每行一条）")).toHaveValue("遵守世界规则\n保持人物一致性");
    await reopened.getByLabel("语气").fill("未发布约束草稿");
    await reopened.getByRole("button", { name: "保存草稿" }).click();
    await expect(reopened.getByText("草稿已保存，尚未发布", { exact: true })).toBeVisible();
    await reopened.getByRole("button", { name: "取消" }).click();

    await page.getByRole("button", { name: /潮痕喜剧风格/ }).click();
    const draftReopened = page.getByRole("dialog", { name: "编辑写作约束" });
    await expect(draftReopened.getByLabel("语气")).toHaveValue("未发布约束草稿");
    await draftReopened.getByRole("button", { name: "放弃草稿" }).click();
    await expect(draftReopened.getByLabel("语气")).toHaveValue("轻快诙谐");
    await draftReopened.getByLabel("语气").fill("冷峻诙谐");
    await draftReopened.getByRole("button", { name: "发布稳定版本" }).click();
    await expect(draftReopened.getByText("稳定版本", { exact: true })).toBeVisible();
    await draftReopened.getByRole("button", { name: "取消" }).click();

    await page.getByRole("button", { name: /潮痕喜剧风格/ }).click();
    const publishedReopened = page.getByRole("dialog", { name: "编辑写作约束" });
    await expect(publishedReopened.getByLabel("语气")).toHaveValue("冷峻诙谐");
    await publishedReopened.getByRole("button", { name: "取消" }).click();

    await page.getByTitle("新建知识文档").click();
    const documentDialog = page.getByRole("dialog", { name: "创建文档" });
    await documentDialog.getByLabel("文档种类").selectOption({ label: "知识文档" });
    await documentDialog.getByLabel("标题").fill("潮汐纪年法");
    await documentDialog.getByRole("button", { name: "创建" }).click();
    const knowledgeEditor = page.getByRole("textbox", { name: "潮汐纪年法内容" });
    await knowledgeEditor.fill("一年分为十三个潮月，每次大潮标记新月的开始。");
    await page.getByTitle("保存稳定版本").click();
    await expect(page.getByText("稳定版本", { exact: true })).toBeVisible();

    const evidence = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const workspace = await desktop.workspace.getCurrent();
      const history = await desktop.workspace.listHistory();
      const knowledge = workspace?.documents.find((document) => document.title === "潮汐纪年法");
      const knowledgeDocument = knowledge ? await desktop.creativeDocument.get({ documentId: knowledge.id }) : null;
      return { workspace, history, knowledgeDocument };
    });
    expect(evidence.workspace?.resources.map((resource) => [resource.objectKind, resource.title])).toEqual(expect.arrayContaining([
      ["world", "群岛世界"],
      ["location", "雾港"],
      ["faction", "潮汐议会"],
      ["oc", "槐"],
      ["story", "潮痕"],
      ["volume", "第一卷"],
      ["chapter", "潮声初醒"],
      ["oc_variant", "槐·潮痕"],
    ]));
    expect(evidence.workspace?.relations.map((relation) => relation.kind)).toEqual(expect.arrayContaining(["uses_world", "uses_oc", "variant_of"]));
    expect(evidence.workspace?.constraintProfiles).toContainEqual(expect.objectContaining({
      title: "潮痕喜剧风格",
      payload: expect.objectContaining({
        narrativePerson: "third",
        tense: "past",
        tone: "冷峻诙谐",
        humorLevel: 4,
        prohibitedContent: ["无来源复活", "人物性格突变"],
        requiredContent: ["遵守世界规则", "保持人物一致性"],
      }),
    }));
    expect(evidence.workspace?.documents).toContainEqual(expect.objectContaining({
      kind: "knowledge_note",
      title: "潮汐纪年法",
    }));
    expect(evidence.knowledgeDocument).toMatchObject({
      content: "一年分为十三个潮月，每次大潮标记新月的开始。",
      dirty: false,
    });
    expect(evidence.history.ok).toBe(true);
    if (evidence.history.ok) expect(evidence.history.checkpoints.length).toBeGreaterThanOrEqual(12);
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

async function createRoot(page: Page, domain: "世界" | "OC" | "故事", title: string): Promise<void> {
  await page.getByTitle(`创建${domain}`).click();
  const dialog = page.getByRole("dialog", { name: "创建创作对象" });
  await dialog.getByLabel("名称").fill(title);
  await dialog.getByRole("button", { name: "创建" }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

async function createChild(page: Page, parentTitle: string, kind: string, title: string): Promise<void> {
  const line = page.locator(".domain-resource-line").filter({ hasText: parentTitle }).first();
  await line.hover();
  await line.getByTitle("创建下级对象").click();
  const dialog = page.getByRole("dialog", { name: "创建创作对象" });
  await dialog.getByLabel("对象种类").selectOption({ label: kind });
  await dialog.getByLabel("名称").fill(title);
  await dialog.getByRole("button", { name: "创建" }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

async function createRelation(page: Page, optionLabel: string): Promise<void> {
  await page.getByTitle("建立关联").click();
  const dialog = page.getByRole("dialog", { name: "建立对象关联" });
  await dialog.getByLabel("目标").selectOption({ label: optionLabel });
  await dialog.getByRole("button", { name: "建立" }).click();
}
