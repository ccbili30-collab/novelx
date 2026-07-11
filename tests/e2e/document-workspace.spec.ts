import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopApi } from "../../src/shared/ipcContract";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("persists document drafts through the real preload API and publishes a stable version", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-document-e2e-"));
  const seeded = openWorkspace(workspaceRoot);
  const resources = new ResourceRepository(seeded);
  const checkpoints = new CheckpointRepository(seeded);
  const worldRoot = resources.listCurrent().find((resource) => resource.type === "world")!;
  const checkpointId = checkpoints.appendCheckpoint(checkpoints.getActiveBranch().id, "创建世界设定文档");
  resources.putRevision({ checkpointId, type: "world", title: "世界设定", parentId: worldRoot.id, state: "active" });
  seeded.close();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(workspaceRoot);
    const firstPage = await app.firstWindow();
    const firstSave = await firstPage.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const workspace = await desktop.workspace.getCurrent();
      const resource = workspace!.resources.find((candidate) => candidate.type === "world")!;
      const initial = await desktop.document.get({ resourceId: resource.id });
      const saved = await desktop.document.saveWorking({
        resourceId: resource.id,
        content: "重启后仍应存在的世界草稿",
        expectedRevision: initial.workingRevision,
        expectedStableVersionId: initial.stableVersionId,
      });
      let staleErrorMessage: string | undefined;
      try {
        await desktop.document.saveWorking({
          resourceId: resource.id,
          content: "过期编辑器不应覆盖",
          expectedRevision: initial.workingRevision,
          expectedStableVersionId: initial.stableVersionId,
        });
      } catch (error) {
        staleErrorMessage = error instanceof Error ? error.message : undefined;
      }
      return { resourceId: resource.id, initial, saved, staleErrorMessage };
    });
    expect(firstSave.initial).toMatchObject({ content: "", workingRevision: 0, dirty: false });
    expect(firstSave.saved).toMatchObject({
      content: "重启后仍应存在的世界草稿",
      workingRevision: 1,
      dirty: true,
    });
    expect(firstSave.staleErrorMessage).toBe("文档已在其他操作中发生变化，请重新载入后再保存。");
    expect(JSON.stringify(firstSave)).not.toMatch(/rootPath|databasePath|machinePath|locatorJson|rawJson/i);

    await app.close();
    app = await launch(workspaceRoot);
    const secondPage = await app.firstWindow();
    const published = await secondPage.evaluate(async (resourceId) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const recovered = await desktop.document.get({ resourceId });
      const stable = await desktop.document.saveStable({
        resourceId,
        expectedRevision: recovered.workingRevision,
      });
      return { recovered, stable };
    }, firstSave.resourceId);
    expect(published.recovered).toMatchObject({
      content: "重启后仍应存在的世界草稿",
      workingRevision: 1,
      dirty: true,
    });
    expect(published.stable).toMatchObject({
      content: "重启后仍应存在的世界草稿",
      workingRevision: 1,
      dirty: false,
    });
    expect(published.stable.stableVersionId).not.toBeNull();
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function launch(workspaceRoot: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot },
  });
}
