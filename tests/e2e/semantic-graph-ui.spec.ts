import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { commitFixtureCheckpoint } from "../helpers/workspaceFixtures";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("explores the real current-branch semantic graph and safe source inspector", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-graph-ui-"));
  let app: ElectronApplication | null = null;
  const workspace = openWorkspace(workspaceRoot);
  const resources = new ResourceRepository(workspace);
  const assertions = new AssertionRepository(workspace);
  const worldRootId = resources.listCurrent().find((resource) => resource.type === "world")!.id;
  commitFixtureCheckpoint(workspace, {
    idempotencyKey: "graph-ui-fixture",
    summary: "确认银湾海岸图谱事实",
    label: "建立图谱实机证据",
  }, (checkpointId, changeSetId) => {
    const coastResourceId = resources.putRevision({
      checkpointId,
      type: "world",
      title: "银湾海岸",
      parentId: worldRootId,
      state: "active",
    });
    assertions.putVersion({
      assertionId: "assertion.graph-ui-cause",
      checkpointId,
      scopeType: "world",
      scopeId: worldRootId,
      subject: "沉降纪元",
      predicate: "塑造",
      object: {
        text: "沉降与海水倒灌共同塑造银湾海岸。",
        entityRef: { resourceId: coastResourceId, relation: "影响地点" },
      },
      status: "current",
      source: { kind: "confirmed_change_set", ref: changeSetId },
    });
    assertions.putVersion({
      assertionId: "assertion.graph-ui-conflict",
      checkpointId,
      scopeType: "world",
      scopeId: worldRootId,
      subject: "银湾海岸",
      predicate: "古代成因",
      object: { text: "现有资料对古代成因存在冲突。" },
      status: "conflict",
      source: { kind: "confirmed_change_set", ref: changeSetId },
    });
  });
  workspace.close();

  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await page.getByRole("treeitem", { name: "图谱" }).click();
    await expect(page.getByRole("article", { name: "语义图谱" })).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(5);

    await page.locator(".react-flow__node").filter({ hasText: "沉降纪元 · 塑造" }).click();
    const inspector = page.getByRole("complementary", { name: "图谱检查器" });
    await expect(inspector.getByRole("heading", { name: "沉降纪元 · 塑造" })).toBeVisible();
    await expect(inspector.getByText("已确认变更：确认银湾海岸图谱事实")).toBeVisible();
    await expect(inspector.getByRole("button", { name: /影响地点.*银湾海岸/ })).toBeVisible();

    await page.getByRole("textbox", { name: "搜索图谱" }).fill("古代成因");
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await page.getByRole("textbox", { name: "搜索图谱" }).fill("");
    await page.getByLabel("仅冲突").check();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await page.getByLabel("仅冲突").uncheck();
    await page.getByLabel("邻域").check();
    await page.screenshot({ path: "test-results/novax-semantic-graph-ide-1440x900.png", fullPage: true });
    await page.getByRole("radio", { name: "Agent 模式" }).click();
    await page.setViewportSize({ width: 1100, height: 700 });
    await expect(page.getByRole("complementary", { name: "项目活动与产物" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "图谱检查器" })).toHaveCount(0);
    await page.screenshot({ path: "test-results/novax-semantic-graph-agent-1100x700.png", fullPage: true });
    expect(await page.locator("body").innerText()).not.toMatch(/payload|rawJson|sourceRef|checkpoint|workspace\.db/i);
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
