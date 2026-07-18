import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

async function installGrowthGuidanceMock(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & {
      __growthGuideCalls?: unknown[];
      __growthStartCalls?: unknown[];
      __growthSnapshotMode?: "same_revision" | "complete" | "cycle3" | "missing";
      __growthGetCalls?: unknown[];
      __growthUseSessionGoals?: boolean;
      __growthGuideResolvers?: Record<string, () => void>;
      __growthGuideResolved?: string[];
      __growthRuleRevisions?: Record<string, number>;
      __growthInspectCalls?: Array<{ goalId?: string }>;
      __growthInspectDelayFirst?: boolean;
      __growthInspectFirstResolver?: () => void;
      __growthInspectFirstCompleted?: boolean;
    };
    state.__growthGuideCalls = [];
    state.__growthStartCalls = [];
    state.__growthGetCalls = [];
    state.__growthUseSessionGoals = false;
    state.__growthGuideResolvers = {};
    state.__growthGuideResolved = [];
    state.__growthRuleRevisions = {};
    state.__growthInspectCalls = [];
    state.__growthInspectDelayFirst = false;
    state.__growthSnapshotMode = "same_revision";
    const snapshot = (goalId = "goal-guidance-ui") => {
      const mode = state.__growthSnapshotMode;
      const cycleSequence = mode === "cycle3" ? 3 : 1;
      const persistedRevision = state.__growthRuleRevisions?.[goalId] ?? 1;
      return {
        capabilityVersion: "hackathon-growth-closure-v4",
        strategy: "grow_world_story_oc_closure_v4",
        conversationRoute: {
          interlocutor: "world_director",
          operationalActor: "steward",
          operationalPresentation: "expandable_activity",
        },
        coordinatorStatus: "running",
        goal: { id: goalId, status: "active", currentCycleSequence: cycleSequence },
        ...(mode === "missing" ? {} : {
          currentRuleRevision: mode === "same_revision" ? persistedRevision : 3,
          activeCycleRuleRevision: mode === "cycle3" ? 3 : 1,
          guidanceStatus: mode === "cycle3" || (mode === "same_revision" && persistedRevision === 1)
            ? "none"
            : "persisted_pending_boundary",
        }),
        cycles: [
          { id: "cycle-1", sequence: 1, runId: "growth-run-1", status: cycleSequence === 1 ? "running" : "committed" },
          { id: "cycle-2", sequence: 2, runId: cycleSequence === 3 ? "growth-run-2" : null, status: cycleSequence === 3 ? "committed" : "planned" },
          { id: "cycle-3", sequence: 3, runId: cycleSequence === 3 ? "growth-run-3" : null, status: cycleSequence === 3 ? "running" : "planned" },
        ],
        events: [],
        diagnostics: [{
          diagnosticId: "diagnostic-growth-ui-1",
          operationKind: "growth_cycle",
          operationId: "cycle-1",
          runId: "growth-run-1",
          cycleId: "cycle-1",
          sequence: 1,
          owner: "reconciliation",
          boundary: "recovery",
          code: "GROWTH_RUN_INTERRUPTED",
          toolName: null,
          sideEffectState: "outcome_unknown",
          disposition: "reconciliation_required",
          retryability: "restart_reconcile",
        }],
      };
    };

    ipcMain.removeHandler("novax:growth-start");
    ipcMain.handle("novax:growth-start", (_event, request: { sessionId?: string }) => {
      state.__growthStartCalls?.push(request);
      return {
        ...snapshot(state.__growthUseSessionGoals ? `goal-${request.sessionId}` : undefined),
        currentRuleRevision: 1,
        activeCycleRuleRevision: 1,
        guidanceStatus: "none",
      };
    });
    ipcMain.removeHandler("novax:growth-get");
    ipcMain.handle("novax:growth-get", (_event, request: { goalId?: string }) => {
      state.__growthGetCalls?.push(request);
      return snapshot(request.goalId);
    });
    ipcMain.removeHandler("novax:growth-guide");
    ipcMain.handle("novax:growth-guide", async (_event, request: { goalId?: string; ruleText?: string; expectedRevision?: number }) => {
      state.__growthGuideCalls?.push(request);
      if (request.ruleText === "触发修订冲突") throw new Error("GROWTH_RULE_REVISION_MISMATCH");
      if (request.ruleText?.startsWith("延迟")) {
        await new Promise<void>((resolve) => { state.__growthGuideResolvers![request.ruleText!] = resolve; });
        state.__growthGuideResolved?.push(request.ruleText);
      }
      if (request.expectedRevision === 1) await new Promise((resolve) => setTimeout(resolve, 180));
      const persistedRevision = (request.expectedRevision ?? 0) + 1;
      if (request.goalId) state.__growthRuleRevisions![request.goalId] = persistedRevision;
      return {
        goalId: request.goalId,
        persistedRevision,
        currentCycleRevision: 1,
        appliesAt: "next_cycle_boundary",
        nextCycleSequence: 2,
        nextCycleKind: "revision",
        focusKinds: ["world", "story", "oc"],
        status: "persisted_pending_boundary",
      };
    });
    ipcMain.removeHandler("novax:growth-inspect");
    ipcMain.handle("novax:growth-inspect", async (_event, request: { goalId?: string }) => {
      const callIndex = state.__growthInspectCalls?.length ?? 0;
      state.__growthInspectCalls?.push(request);
      if (state.__growthInspectDelayFirst && callIndex === 0) {
        await new Promise<void>((resolve) => { state.__growthInspectFirstResolver = resolve; });
        state.__growthInspectFirstCompleted = true;
      }
      return {
        capabilityVersion: "growth-presentation-v1",
        goalId: request.goalId,
        currentRuleRevision: 1,
        activeCycleRuleRevision: 1,
        guidanceStatus: "none",
        impacts: [],
        inquirySummaries: [`projection:${request.goalId}`],
        closures: [],
        longform: { status: "unavailable" },
        illustrationRequests: [],
      };
    });
  });
}

test("starts explicit Growth mode once and visibly fails closed without a Provider", async () => {
  test.setTimeout(40_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-presentation-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: {
        ...process.env,
        NOVAX_DESKTOP_E2E_USER_DATA: userDataPath,
        NOVAX_DESKTOP_E2E_WORKSPACE: workspacePath,
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const stewardComposer = page.getByLabel("给大管家发送消息");
    const growthMode = page.getByRole("radio", { name: "生长", exact: true });

    await expect(stewardComposer).toBeEnabled({ timeout: 8_000 });
    await expect(page.getByRole("radio", { name: "协助", exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole("radio", { name: "自由", exact: true })).toBeVisible({ timeout: 8_000 });
    await growthMode.click({ timeout: 8_000 });
    await expect(growthMode).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel("当前对话对象")).toContainText("世界总编");
    await page.getByRole("radio", { name: "协助", exact: true }).click();
    await expect(page.getByLabel("当前对话对象")).toHaveCount(0);
    await expect(page.getByLabel("给大管家发送消息")).toBeVisible();
    await growthMode.click();
    const composer = page.getByLabel("给世界总编发送消息");
    await expect(page.getByRole("region", { name: "世界总编" }).locator(".steward-state")).toContainText("世界总编");
    await expect(page.getByLabel("给大管家发送消息")).toHaveCount(0);
    await expect(page.getByText("当前创作", { exact: true })).toBeVisible();
    await expect(page.getByText("图文图鉴", { exact: true })).toBeVisible();
    await expect(page.getByText("文件夹内容", { exact: true })).toBeVisible();

    await composer.fill("建立一个有潮汐禁令的海港世界");
    const send = page.getByTitle("发送");
    await expect(send).toBeEnabled({ timeout: 8_000 });
    await send.click({ timeout: 8_000 });
    await expect(page.locator(".steward-message--user").filter({ hasText: "建立一个有潮汐禁令的海港世界" })).toBeVisible();
    const operationalActivity = page.getByText("大管家运行活动", { exact: true });
    await expect(operationalActivity).toBeVisible();
    const timeline = page.getByRole("region", { name: "生长活动时间线" });
    await expect(timeline).toBeHidden();
    await operationalActivity.click();
    await expect(timeline).toBeVisible({ timeout: 8_000 });
    await expect(timeline.locator(".growth-timeline__row").first()).toContainText("第 1 轮");
    await expect(page.locator(".project-files-panel")).toBeVisible();

    await expect.poll(async () => timeline.getAttribute("data-status"), { timeout: 15_000 }).toMatch(/^(blocked|failed)$/);
    await expect(timeline).not.toContainText("本次生长已完成");
    await expect(page.locator("body")).not.toContainText("thinking");
    await expect(page.locator(".run-work-target-pane__world-map")).toHaveCount(0);
    const gallery = page.getByRole("region", { name: "图文图鉴" });
    await expect(gallery).toBeVisible();
    await expect(gallery.locator("img")).toHaveCount(0);
    await expect(gallery).not.toContainText("已就绪");
    await expect(gallery.getByRole("button", { name: "生成配图" })).toBeDisabled();
    await expect(page.getByLabel("Growth 规则状态")).toBeVisible();
    await expect(page.locator("main.workbench")).toHaveClass(/workbench--agent/);
    await expect(page.locator(".creative-showcase")).toHaveCount(0);
    await page.screenshot({ path: "test-results/novax-growth-presentation-fail-closed-1440x900.png", fullPage: true });
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a newer scope guide saving when the previous scope resolves", async () => {
  test.setTimeout(45_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-guidance-scope-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  openWorkspace(workspacePath).close();
  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  const project = registry.registerProject(workspacePath, "ready");
  registry.createSession(project.id, "旧规则会话");
  registry.createSession(project.id, "新规则会话");
  registry.selectProject(project.id);
  registry.close();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath },
    });
    await installGrowthGuidanceMock(app);
    await app.evaluate(() => {
      const state = globalThis as typeof globalThis & { __growthUseSessionGoals?: boolean; __growthInspectDelayFirst?: boolean };
      state.__growthUseSessionGoals = true;
      state.__growthInspectDelayFirst = true;
    });
    const page = await app.firstWindow();
    const rail = page.getByRole("complementary", { name: "项目与 Agent 会话" });
    let composer = page.getByLabel("给大管家发送消息");

    const oldSession = rail.getByRole("button", { name: "旧规则会话", exact: true });
    await expect(oldSession).toBeVisible({ timeout: 8_000 });
    await oldSession.click();
    await expect(oldSession).toHaveAttribute("data-selected", "true");
    await page.getByRole("radio", { name: "生长", exact: true }).click();
    composer = page.getByLabel("给世界总编发送消息");
    await composer.fill("建立旧会话世界");
    await page.getByTitle("发送").click();
    let guidance = page.getByRole("textbox", { name: "追加世界规则或指导" });
    await expect(guidance).toBeEnabled({ timeout: 8_000 });
    await guidance.fill("延迟旧会话指导");
    await page.getByRole("button", { name: "保存规则修订" }).click();
    await expect(page.getByRole("button", { name: "保存中" })).toBeVisible();

    const newSession = rail.getByRole("button", { name: "新规则会话", exact: true });
    await newSession.click();
    await expect(newSession).toHaveAttribute("data-selected", "true", { timeout: 8_000 });
    await expect(composer).toBeEnabled({ timeout: 8_000 });
    await composer.fill("建立新会话世界");
    await page.getByTitle("发送").click();
    await expect(page.locator(".growth-timeline__diagnostic")).toContainText("GROWTH_RUN_INTERRUPTED", { timeout: 8_000 });
    await expect(page.locator(".growth-timeline__diagnostic")).toContainText("结果未知，必须核对");
    await expect(page.locator("body")).not.toContainText("unsafe-secret");
    const startCalls = await app.evaluate(() => (globalThis as typeof globalThis & { __growthStartCalls?: Array<{ sessionId?: string }> }).__growthStartCalls ?? []);
    const newGoalId = `goal-${startCalls.at(-1)?.sessionId}`;
    const growthSummary = page.locator(".growth-impact-summary");
    await expect(growthSummary).toContainText(`projection:${newGoalId}`, { timeout: 8_000 });
    await app.evaluate(() => { (globalThis as typeof globalThis & { __growthInspectFirstResolver?: () => void }).__growthInspectFirstResolver?.(); });
    guidance = page.getByRole("textbox", { name: "追加世界规则或指导" });
    await expect(guidance).toBeEnabled({ timeout: 8_000 });
    await guidance.fill("延迟新会话指导");
    await page.getByRole("button", { name: "保存规则修订" }).click();
    await expect(page.getByRole("button", { name: "保存中" })).toBeVisible();

    await app.evaluate(() => { (globalThis as typeof globalThis & { __growthGuideResolvers?: Record<string, () => void> }).__growthGuideResolvers?.["延迟旧会话指导"]?.(); });
    await expect.poll(async () => app?.evaluate(() => (
      (globalThis as typeof globalThis & { __growthGuideResolved?: string[] }).__growthGuideResolved ?? []
    ))).toContain("延迟旧会话指导");
    await expect(page.getByRole("button", { name: "保存中" })).toBeVisible();
    await expect(guidance).toHaveValue("延迟新会话指导");
    await expect(page.getByText(/已保存为规则修订/)).toHaveCount(0);

    await app.evaluate(() => { (globalThis as typeof globalThis & { __growthGuideResolvers?: Record<string, () => void> }).__growthGuideResolvers?.["延迟新会话指导"]?.(); });
    await expect(page.getByText("已保存为规则修订 #2，等待安全修订轮；第 2 轮仅为候选边界，不承诺一定执行。预计范围：世界、故事、OC", { exact: true })).toBeVisible();
    await expect(guidance).toHaveValue("");
    await expect(page.getByRole("button", { name: "保存中" })).toHaveCount(0);
    const oldGoalId = `goal-${startCalls[0]?.sessionId}`;
    await expect.poll(() => app?.evaluate(() => Boolean((globalThis as typeof globalThis & { __growthInspectFirstCompleted?: boolean }).__growthInspectFirstCompleted))).toBe(true);
    await expect(growthSummary).not.toContainText(`projection:${oldGoalId}`);
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persists cycle-boundary guidance without Provider calls or renderer rule storage", async () => {
  test.setTimeout(45_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-guidance-ui-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: {
        ...process.env,
        NOVAX_DESKTOP_E2E_USER_DATA: userDataPath,
        NOVAX_DESKTOP_E2E_WORKSPACE: workspacePath,
      },
    });
    await installGrowthGuidanceMock(app);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    let composer = page.getByLabel("给大管家发送消息");
    await expect(composer).toBeEnabled({ timeout: 8_000 });
    await expect(page.getByRole("radio", { name: "协助", exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: "自由", exact: true })).toBeVisible();
    await page.getByRole("radio", { name: "生长", exact: true }).click();
    composer = page.getByLabel("给世界总编发送消息");
    await composer.fill("建立潮汐海港世界");
    await page.getByTitle("发送").click();

    const guidance = page.getByRole("textbox", { name: "追加世界规则或指导" });
    const save = page.getByRole("button", { name: "保存规则修订" });
    await expect(guidance).toBeEnabled({ timeout: 8_000 });
    await expect(composer).toBeDisabled();
    await guidance.fill("港口钟声必须服从双月潮汐");
    await save.click();
    await expect(page.getByRole("button", { name: "保存中" })).toBeVisible();
    await expect(page.getByText(/已保存为规则修订/)).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("novax:growth-event", {
        sessionId: (globalThis as typeof globalThis & { __growthStartCalls?: Array<{ sessionId?: string }> }).__growthStartCalls?.[0]?.sessionId,
        strategy: "grow_world_story_oc_closure_v4",
        event: {
          goalId: "goal-guidance-ui",
          cycleId: "cycle-1",
          runId: "growth-run-1",
          sequence: 1,
          phase: "receipt_recorded",
          targetKind: "resource",
          targetId: "resource-guidance-race",
          targetVersionId: null,
          durableState: "running",
          safeSummary: "同 scope live refresh",
          contentRef: null,
        },
      });
    });
    await expect.poll(async () => app?.evaluate(() => (
      (globalThis as typeof globalThis & { __growthGetCalls?: unknown[] }).__growthGetCalls?.length ?? 0
    ))).toBe(1);
    await expect(page.getByText("已保存为规则修订 #2，等待安全修订轮；第 2 轮仅为候选边界，不承诺一定执行。预计范围：世界、故事、OC", { exact: true })).toBeVisible();
    await expect(guidance).toHaveValue("");
    await expect(page.getByRole("button", { name: "保存中" })).toHaveCount(0);
    await expect(page.locator(".growth-guidance-card")).toContainText("规则修订 #2");
    await expect(page.locator(".growth-guidance-card")).toContainText("等待安全修订轮");
    await expect(page.getByLabel("Growth 规则修订")).toContainText("当前轮使用 #1");
    await expect(page.getByLabel("Growth 规则修订")).toContainText("最新已保存 #2");
    await expect(page.getByLabel("Growth 规则修订")).toContainText("已保存，等待安全修订轮");

    await guidance.fill("OC 必须携带退潮印记");
    await save.click();
    await expect(page.getByText("已保存为规则修订 #3，等待安全修订轮；第 2 轮仅为候选边界，不承诺一定执行。预计范围：世界、故事、OC", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Growth 规则修订")).toContainText("最新已保存 #3");

    await app.evaluate(() => { (globalThis as typeof globalThis & { __growthSnapshotMode?: string }).__growthSnapshotMode = "complete"; });
    await guidance.fill("触发修订冲突");
    await save.click();
    await expect(page.getByRole("alert")).toContainText("未自动重试");
    await expect(guidance).toHaveValue("触发修订冲突");

    const calls = await app.evaluate(() => (globalThis as typeof globalThis & { __growthGuideCalls?: unknown[] }).__growthGuideCalls ?? []);
    expect(calls).toHaveLength(3);
    expect(calls).toEqual([
      expect.objectContaining({ goalId: "goal-guidance-ui", expectedRevision: 1, ruleText: "港口钟声必须服从双月潮汐" }),
      expect.objectContaining({ goalId: "goal-guidance-ui", expectedRevision: 2, ruleText: "OC 必须携带退潮印记" }),
      expect.objectContaining({ goalId: "goal-guidance-ui", expectedRevision: 3, ruleText: "触发修订冲突" }),
    ]);
    for (const call of calls as Array<Record<string, unknown>>) {
      expect(Object.keys(call).sort()).toEqual(["expectedRevision", "goalId", "requestId", "ruleText"]);
      expect(call.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      for (const forbidden of ["branchId", "checkpointId", "scopeResourceIds", "cycleId", "runId"]) expect(call).not.toHaveProperty(forbidden);
    }
    const rendererStorage = await page.evaluate(() => Object.entries(window.localStorage));
    expect(JSON.stringify(rendererStorage)).not.toContain("港口钟声必须服从双月潮汐");
    expect(JSON.stringify(rendererStorage)).not.toContain("OC 必须携带退潮印记");
    expect(JSON.stringify(rendererStorage)).not.toContain("触发修订冲突");

    await app.evaluate(() => { (globalThis as typeof globalThis & { __growthSnapshotMode?: string }).__growthSnapshotMode = "cycle3"; });
    await page.reload();
    await expect(page.getByRole("textbox", { name: "追加世界规则或指导" })).toBeEnabled({ timeout: 8_000 });
    await expect(page.getByText("第 3 轮之后没有安全的下一轮边界。", { exact: true })).toHaveCount(0);

    await app.evaluate(() => { (globalThis as typeof globalThis & { __growthSnapshotMode?: string }).__growthSnapshotMode = "missing"; });
    await page.reload();
    await expect(page.getByRole("textbox", { name: "追加世界规则或指导" })).toHaveCount(0, { timeout: 8_000 });
    await expect(page.getByText("规则修订状态不可用，无法安全保存指导。", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Growth 规则修订")).toHaveCount(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
