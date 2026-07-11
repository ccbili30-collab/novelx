import { expect, test, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { DecompositionCandidateRepository } from "../../src/domain/import/decompositionCandidateRepository";
import { ImportJobRepository } from "../../src/domain/import/importJobRepository";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { TextSourceParserService } from "../../src/domain/import/textSourceParserService";
import { StoryProfileRepository } from "../../src/domain/story/storyProfileRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url); const electronPath = require("electron") as string;

test("reviews source-bound candidates and creates a Start Profile through the visible import workbench", async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "novax-import-ui-user-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-import-ui-workspace-"));
  const fixture = seedWorkspace(workspaceRoot);
  const app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot } });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("radio", { name: "导入" }).click();
    await expect(page.getByRole("heading", { name: "银湾资料.md" })).toBeVisible();
    const rule = page.locator(".candidate-review").filter({ hasText: "银湾洞穴" });
    const future = page.locator(".candidate-review").filter({ hasText: "银湾沉没" });
    await future.getByLabel("类型").selectOption("range");
    await future.getByLabel("开始").fill("第三年春");
    await future.getByLabel("结束").fill("第三年冬");
    await future.getByTitle("保存修改").click();
    await rule.getByTitle("接受").click(); await future.getByTitle("接受").click();
    await page.locator(".candidate-use-list label").filter({ hasText: "银湾洞穴" }).getByRole("combobox").selectOption("seed");
    await page.locator(".candidate-use-list label").filter({ hasText: "银湾沉没" }).getByRole("combobox").selectOption("future");
    await page.getByLabel("起始模板名称").fill("退潮入口");
    await page.getByLabel("初始位置").fill("银湾海岸");
    await page.getByLabel("开场情境").fill("玩家在退潮时抵达银湾海岸。");
    await page.getByRole("button", { name: "创建起始模板" }).click();
    await expect(page.getByRole("status")).toContainText("已创建起始模板");

    const starts = await page.evaluate(async (storyProfileId) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.play.listStartProfiles({ storyProfileId });
    }, fixture.storyProfileId);
    expect(starts).toMatchObject({ ok: true, startProfiles: [{ title: "退潮入口", status: "active", startState: {
      initialState: { location: "银湾海岸" }, sourceCandidateIds: [fixture.ruleId], excludedFutureEventCandidateIds: [fixture.futureId],
    } }] });
    const candidates = await page.evaluate(async (sourceId) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.sourceLibrary.listCandidates({ sourceId });
    }, fixture.sourceId);
    expect(candidates).toMatchObject({ ok: true, candidates: expect.arrayContaining([expect.objectContaining({
      id: fixture.futureId,
      payload: expect.objectContaining({ temporal: { kind: "range", start: "第三年春", end: "第三年冬" } }),
    })]) });
    await expect(page.getByRole("main")).not.toContainText(/sourceChunkIds|payload_json|workspace\.db/);
    await page.screenshot({ path: "test-results/novax-import-workbench-1440x900.png", fullPage: true });
  } finally { await app.close(); fs.rmSync(userDataPath, { recursive: true, force: true }); fs.rmSync(workspaceRoot, { recursive: true, force: true }); }
});

function seedWorkspace(root: string) {
  const workspace = openWorkspace(root);
  try {
    const changes = new ChangeSetRepository(workspace); const resources = new ResourceRepository(workspace);
    const change = changes.propose({ idempotencyKey: "import-ui-story", mode: "assist", summary: "建立导入目标" }); let worldId = ""; let storyId = "";
    const commitId = changes.commit(change.id, "建立导入目标", (checkpointId) => { const roots = resources.listCurrent(); worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "银湾", parentId: roots.find((item) => item.type === "world")!.id, state: "active" }); storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "潮痕", parentId: roots.find((item) => item.type === "story")!.id, state: "active" }); });
    const storyProfileId = new StoryProfileRepository(workspace).create({ storyResourceId: storyId, worldResourceId: worldId, canonCommitId: commitId, title: "潮痕" }).id;
    const filePath = path.join(root, "银湾资料.md"); fs.writeFileSync(filePath, "# 世界规则\n银湾洞穴只在退潮时开放。\n# 原著未来\n三年后银湾沉没。", "utf8");
    const source = new SourceLibraryRepository(workspace).register({ filePath, rightsAttestation: "user_owned" }); const chunks = new TextSourceParserService(workspace).parse(source.id);
    const jobs = new ImportJobRepository(workspace); const job = jobs.start(source.id, "decompose");
    const [rule, future] = new DecompositionCandidateRepository(workspace).appendOutput({ sourceId: source.id, jobId: job.id, output: { candidates: [
      { kind: "world_rule", sourceChunkIds: [chunks[0]!.id], confidence: 0.96, payload: { subject: "银湾洞穴", predicate: "开放条件", value: "退潮" } },
      { kind: "event", sourceChunkIds: [chunks.at(-1)!.id], confidence: 0.9, payload: { subject: "银湾沉没", description: "三年后银湾沉没", temporal: { kind: "instant", value: "三年后" } } },
    ], unresolvedSourceChunkIds: [] } }); jobs.succeed(job.id);
    return { storyProfileId, sourceId: source.id, ruleId: rule!.id, futureId: future!.id };
  } finally { workspace.close(); }
}
