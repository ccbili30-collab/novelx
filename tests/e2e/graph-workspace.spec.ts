import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import type { DesktopApi } from "../../src/shared/ipcContract";
import { commitFixtureCheckpoint } from "../helpers/workspaceFixtures";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("reads and inspects the real Creator Lens graph through the preload API", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-graph-e2e-"));
  let app: ElectronApplication | null = null;
  const workspace = openWorkspace(workspaceRoot);
  const assertions = new AssertionRepository(workspace);
  const worldRootId = new ResourceRepository(workspace).listCurrent()
    .find((resource) => resource.type === "world")!.id;
  commitFixtureCheckpoint(workspace, {
    idempotencyKey: "graph-e2e-source",
    summary: "确认沉降纪元设定",
    label: "保存沉降纪元设定",
  }, (checkpointId, changeSetId) => {
    assertions.putVersion({
      assertionId: "assertion.graph.e2e",
      checkpointId,
      scopeType: "world",
      scopeId: worldRootId,
      subject: "沉降纪元",
      predicate: "塑造",
      object: { text: "海水倒灌塑造了银湾海岸。" },
      status: "current",
      source: { kind: "confirmed_change_set", ref: changeSetId },
    });
  });
  workspace.close();

  try {
    app = await launch(workspaceRoot);
    const page = await app.firstWindow();
    await waitForRendererReady(page);
    const result = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const apiKeys = Object.keys(desktop.graph).sort();
      const snapshotResult = await desktop.graph.getSnapshot();
      if (!snapshotResult.ok) throw new Error(snapshotResult.error.message);
      const fact = snapshotResult.graph.nodes.find((node) => node.kind === "fact");
      if (!fact) throw new Error("fact node missing");
      const inspector = await desktop.graph.inspectNode({ nodeId: fact.id });
      const missing = await desktop.graph.inspectNode({ nodeId: "graph-missing" });
      return { apiKeys, snapshot: snapshotResult.graph, inspector, missing };
    });

    expect(result.apiKeys).toEqual(["getSnapshot", "inspectNode"]);
    expect(result.snapshot.lens).toEqual({
      type: "creator",
      label: "创作者视角",
      characterLensAvailable: false,
      limitation: "角色认知视角尚未实现。",
    });
    expect(result.snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "subject", label: "沉降纪元" }),
      expect.objectContaining({ kind: "fact", label: "沉降纪元 · 塑造" }),
    ]));
    expect(result.inspector).toMatchObject({
      ok: true,
      inspector: {
        detail: {
          kind: "fact",
          sources: [{ type: "change_set", label: "已确认变更：确认沉降纪元设定" }],
        },
      },
    });
    expect(result.missing).toEqual({
      ok: false,
      error: { code: "GRAPH_NODE_NOT_FOUND", message: "当前版本中找不到这个图谱节点。" },
    });
    expect(JSON.stringify(result))
      .not.toMatch(/"(?:rawRef|ref|path|locator|checkpointId|payload|databasePath)"|workspace\.db/i);
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("returns a public graph error when no workspace is open", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  delete env.NOVAX_DESKTOP_E2E_WORKSPACE;
  const app = await electron.launch({ executablePath: electronPath, args: ["."], env });
  try {
    const page = await app.firstWindow();
    await waitForRendererReady(page);
    const result = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.graph.getSnapshot();
    });
    expect(result).toEqual({ ok: false, error: { code: "WORKSPACE_NOT_OPEN", message: "尚未打开工作区。" } });
  } finally {
    await app.close();
  }
});

function launch(workspaceRoot: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot },
  });
}

async function waitForRendererReady(page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>): Promise<void> {
  await expect(page.getByRole("main", { name: "novelx 桌面工作台" })).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}
