import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ChangeSetService, type ChangeSetCandidate, type ChangeSetPolicyEvaluator } from "../../src/domain/changeSet/changeSetService";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("reviews and commits an Assist Change Set through the visible workbench", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-change-set-ui-"));
  let app: ElectronApplication | null = null;
  const workspace = openWorkspace(workspaceRoot);
  const worldRoot = new ResourceRepository(workspace).listCurrent()
    .find((resource) => resource.type === "world" && resource.objectKind === "domain_root");
  if (!worldRoot) throw new Error("World domain root is missing.");
  new ChangeSetService(workspace, new ContractLowRiskPolicy()).propose({
    idempotencyKey: "e2e-visible-review",
    expectedHeadCheckpointId: new CheckpointRepository(workspace).getActiveBranch().headCheckpointId,
    mode: "assist",
    summary: "记录银湾海岸成因",
    items: [
      {
        id: "silver-bay-world",
        kind: "resource.put",
        dependsOn: [],
        payload: {
          resourceId: "world.silver-bay.visible",
          create: true,
          type: "world",
          objectKind: "world",
          title: "银湾世界",
          parentId: worldRoot.id,
          state: "active",
          sortOrder: 0,
        },
      },
      {
        id: "silver-bay-document",
        kind: "creative_document.put",
        dependsOn: ["silver-bay-world"],
        payload: {
          documentId: "document.silver-bay.visible",
          create: true,
          resourceId: "world.silver-bay.visible",
          kind: "setting",
          title: "银湾开场",
          state: "active",
          sortOrder: 0,
        },
      },
      {
        id: "silver-bay-content",
        kind: "document.put",
        dependsOn: ["silver-bay-document"],
        payload: {
          resourceId: "world.silver-bay.visible",
          creativeDocumentId: "document.silver-bay.visible",
          content: "潮声越过曲折海岸，银湾的第一盏灯在沉降纪元的旧礁上亮起。",
          authorKind: "agent",
        },
      },
      {
        id: "coast-cause",
        kind: "assertion.put",
        dependsOn: ["silver-bay-world"],
        payload: {
          assertionId: "assertion.visible-coast",
          scopeType: "world",
          scopeId: "world.silver-bay.visible",
          subject: "银湾海岸",
          predicate: "形成原因",
          object: { text: "沉降纪元造成差异侵蚀与海水倒灌。" },
          status: "current",
          source: { kind: "agent_candidate", ref: "private-ui-source" },
        },
      },
    ],
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
    const pendingRegion = page.getByRole("region", { name: "待审查变更" });
    await pendingRegion.getByRole("button", { name: /记录银湾海岸成因/ }).click();
    await expect(page.getByRole("article", { name: "变更审查" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "记录银湾海岸成因" })).toBeVisible();
    await expect(page.getByText("沉降纪元造成差异侵蚀与海水倒灌。")).toBeVisible();
    await page.screenshot({ path: "test-results/novax-change-set-review-1440x900.png", fullPage: true });

    await page.getByRole("group", { name: "创建世界资料：银湾世界的决定" })
      .getByRole("button", { name: "接受" }).click();
    await page.getByRole("group", { name: "创建文档：银湾开场的决定" })
      .getByRole("button", { name: "接受" }).click();
    await page.getByRole("group", { name: "更新文档：银湾世界的决定" })
      .getByRole("button", { name: "接受" }).click();
    await page.getByRole("group", { name: "银湾海岸 · 形成原因的决定" })
      .getByRole("button", { name: "接受" }).click();
    await page.getByRole("button", { name: "提交已接受内容" }).click();
    await expect(page.getByText("已形成稳定版本")).toBeVisible();
    await expect(pendingRegion.getByRole("button", { name: /记录银湾海岸成因/ })).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return (await desktop.workspace.getCurrent())?.resources.map((resource) => resource.title) ?? [];
    })).toContain("银湾世界");
    await page.getByRole("radio", { name: "IDE 模式" }).click();
    await expect(page.getByRole("button", { name: /银湾世界/ })).toBeVisible();
    await page.getByRole("button", { name: "银湾开场" }).click();
    await expect(page.getByRole("textbox", { name: "银湾开场内容" })).toHaveValue(/潮声越过曲折海岸/);
    await page.getByRole("treeitem", { name: /图谱/ }).click();
    await expect(page.locator(".react-flow__node").filter({ hasText: "银湾海岸 · 形成原因" })).toBeVisible();
    await page.screenshot({ path: "test-results/novax-change-set-committed-1440x900.png", fullPage: true });
    expect(await page.locator("body").innerText()).not.toMatch(/private-ui-source|payload|rawJson|sourceRef|checkpoint/i);

    await app.close();
    app = null;
    const reopened = openWorkspace(workspaceRoot);
    expect(new AssertionRepository(reopened).listCurrent()).toEqual(expect.arrayContaining([
      expect.objectContaining({ assertionId: "assertion.visible-coast" }),
    ]));
    reopened.close();
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

class ContractLowRiskPolicy implements ChangeSetPolicyEvaluator {
  assess(candidate: ChangeSetCandidate) {
    return candidate.items.map((item) => ({ itemId: item.id, risk: "low" as const, conflicts: [] }));
  }
}
