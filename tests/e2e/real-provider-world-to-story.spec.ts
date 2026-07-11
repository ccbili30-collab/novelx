import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { promptManifest } from "../../src/agent-worker/prompts/manifest";
import type { AgentRunEvent, DesktopApi } from "../../src/shared/ipcContract";
import { commitFixtureCheckpoint } from "../helpers/workspaceFixtures";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const apiKey = process.env.NOVAX_REAL_E2E_API_KEY?.trim() ?? "";
const activeStewardPromptVersion = promptManifest.find((entry) => (
  entry.role === "steward" && entry.status === "active"
))?.version;

if (!activeStewardPromptVersion) throw new Error("Active Steward Prompt is missing from the manifest.");

test.skip(!apiKey, "NOVAX_REAL_E2E_API_KEY is required for real Provider evidence.");

test("runs a real Assist World-to-Story change through review, restart, and provenance", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-real-world-to-story-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  const worldId = seedWorldEvidence(workspacePath);
  let app: ElectronApplication | null = null;

  try {
    app = await launch(userDataPath, workspacePath);
    let page = await app.firstWindow();
    await saveDeepSeekProvider(page, apiKey);

    const run = await runAssist(page, [
      `请在项目资源 ${worldId} 中先检索正式来源。`,
      "根据已有的银湾海岸形成原因，把内容整理成该世界资源的文档更新。",
      "必须建立待确认的 Change Set，只使用 document.put，不要创建资源或新断言，也不要直接提交。",
    ].join("\n"), [worldId]);
    await testInfo.attach("public-agent-events", {
      body: Buffer.from(JSON.stringify(run.events, null, 2), "utf8"),
      contentType: "application/json",
    });
    if (run.terminal.type === "run.failed") {
      await app.close();
      app = null;
      await testInfo.attach("safe-agent-audit", {
        body: Buffer.from(JSON.stringify(readSafeAudit(workspacePath, run.terminal.runId), null, 2), "utf8"),
        contentType: "application/json",
      });
      throw new Error(`Real Agent run failed: ${JSON.stringify(run.events)}`);
    }

    expect(run.terminal, JSON.stringify(run.events)).toMatchObject({
      type: "run.completed",
      outcome: "awaiting_confirmation",
      changeSetState: "pending_review",
    });
    expect(run.events.some((event) => event.type === "run.activity" && event.label === "检索项目事实")).toBe(true);
    expect(run.events.some((event) => event.type === "run.activity" && event.label === "生成候选变更")).toBe(true);
    expect(JSON.stringify(run.events)).not.toContain(apiKey);

    const reviewed = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const pending = await desktop.changeSet.listPending();
      if (!pending.ok || pending.changeSets.length !== 1) throw new Error("Expected one pending Change Set.");
      const changeSetId = pending.changeSets[0]!.id;
      let detail = await desktop.changeSet.get({ changeSetId });
      if (!detail.ok) throw new Error("Pending Change Set could not be read.");
      if (detail.changeSet.items.some((item) => item.kind !== "document")) {
        throw new Error("Real Steward proposed an unexpected item kind.");
      }
      for (const item of detail.changeSet.items) {
        detail = await desktop.changeSet.decide({ changeSetId, itemId: item.id, decision: "accepted" });
        if (!detail.ok) throw new Error("Change Set item review failed.");
      }
      const finalized = await desktop.changeSet.finalizeAssist({
        changeSetId,
        label: "真实 Provider 世界文档更新",
      });
      if (!finalized.ok) {
        throw new Error(`Change Set finalization failed: ${finalized.error.code}: ${finalized.error.message}`);
      }
      return { changeSetId, finalized: finalized.changeSet };
    });
    expect(reviewed.finalized).toMatchObject({ status: "committed", pendingCount: 0 });

    await app.close();
    app = await launch(userDataPath, workspacePath);
    page = await app.firstWindow();
    const restored = await page.evaluate(async ({ resourceId }) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const document = await desktop.document.get({ resourceId });
      const history = await desktop.workspace.listHistory();
      return { document, history };
    }, { resourceId: worldId });
    expect(restored.document.stableVersionId).not.toBeNull();
    expect(restored.document.content).toMatch(/银湾|海岸/);
    expect(restored.document.content).toMatch(/沉降|海水|峡湾/);
    expect(restored.history).toMatchObject({ ok: true });
    if (!restored.history.ok) throw new Error("Checkpoint history was not restored.");
    expect(restored.history.checkpoints.length).toBeGreaterThanOrEqual(3);

    await app.close();
    app = null;
    const workspace = openWorkspace(workspacePath);
    try {
      const stable = new DocumentRepository(workspace).getCurrentStable(worldId);
      expect(stable).toMatchObject({ authorKind: "agent" });
      const output = workspace.db.prepare(`
        SELECT output_kind, output_id FROM change_set_outputs
        WHERE change_set_id = ? AND output_kind = 'document_version'
      `).get(reviewed.changeSetId) as { output_kind: "document_version"; output_id: string } | undefined;
      expect(output).toBeDefined();
      const provenance = new AgentAuditRepository(workspace).getArtifactProvenance(
        output!.output_kind,
        output!.output_id,
      );
      expect(provenance).toMatchObject({
        changeSetId: reviewed.changeSetId,
        promptId: "novax.steward",
        promptVersion: activeStewardPromptVersion,
        providerId: "deepseek",
        requestedModelId: "deepseek-chat",
      });
      const actualModels = workspace.db.prepare(`
        SELECT DISTINCT actual_model_id FROM agent_audit_events
        WHERE run_id = ? AND actual_model_id IS NOT NULL
      `).all(provenance!.runId) as Array<{ actual_model_id: string }>;
      expect(actualModels.map((row) => row.actual_model_id)).toContain("deepseek-v4-flash");
      const stewardInvocation = workspace.db.prepare(`
        SELECT agent_profile_version, agent_profile_sha256 FROM agent_invocations
        WHERE run_id = ? AND role = 'steward'
      `).get(provenance!.runId) as {
        agent_profile_version: string;
        agent_profile_sha256: string;
      } | undefined;
      expect(stewardInvocation).toEqual({
        agent_profile_version: "1.14.0",
        agent_profile_sha256: "29af57fd84113a54a3ba19a6d87069fb12fe7952b3bba99785efed3d29d4c10b",
      });
    } finally {
      workspace.close();
    }

    expect(filesContain(workspacePath, apiKey)).toBe(false);
    expect(filesContain(userDataPath, apiKey)).toBe(false);
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function seedWorldEvidence(workspacePath: string): string {
  const workspace = openWorkspace(workspacePath);
  try {
    const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world");
    if (!world) throw new Error("Default world resource is missing.");
    commitFixtureCheckpoint(workspace, {
      idempotencyKey: "real-e2e-seed-world-source",
      summary: "确认银湾海岸地质来源",
      label: "真实 E2E 来源基线",
    }, (checkpointId, changeSetId) => {
      new AssertionRepository(workspace).putVersion({
        assertionId: "silver-bay-coast-origin",
        checkpointId,
        scopeType: "world",
        scopeId: world.id,
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { cause: "古代地壳沉降与海水倒灌形成连续峡湾" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: changeSetId },
      });
    });
    return world.id;
  } finally {
    workspace.close();
  }
}

async function saveDeepSeekProvider(page: Page, secret: string): Promise<void> {
  const result = await page.evaluate(async ({ credential }) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    return desktop.provider.save({
      config: {
        providerId: "deepseek",
        displayName: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        modelId: "deepseek-chat",
        contextWindow: 64_000,
        maxTokens: 4_096,
        reasoning: false,
        input: ["text"],
      },
      apiKey: credential,
    });
  }, { credential: secret });
  expect(result).toMatchObject({ ok: true, state: { hasCredential: true } });
}

function runAssist(page: Page, userInput: string, scopeResourceIds: string[] = []): Promise<{ events: AgentRunEvent[]; terminal: AgentRunEvent }> {
  return page.evaluate(async ({ input, scopes }) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const project = (await desktop.project.list()).projects[0]!;
    const listed = await desktop.session.list({ projectId: project.id });
    const session = listed.sessions[0] ?? await desktop.session.create({ projectId: project.id });
    return new Promise<{ events: AgentRunEvent[]; terminal: AgentRunEvent }>((resolve, reject) => {
      const events: AgentRunEvent[] = [];
      const timer = globalThis.setTimeout(() => reject(new Error("Timed out waiting for real Agent run.")), 180_000);
      const unsubscribe = desktop.agent.subscribe((event) => {
        if (event.sessionId !== session.id) return;
        events.push(event);
        if (event.type === "run.completed" || event.type === "run.failed") {
          globalThis.clearTimeout(timer);
          unsubscribe();
          resolve({ events, terminal: event });
        }
      });
      void desktop.agent.start({
        projectId: project.id,
        sessionId: session.id,
        userInput: input,
        mode: "assist",
        scopeResourceIds: scopes,
      }).catch(reject);
    });
  }, { input: userInput, scopes: scopeResourceIds });
}

function launch(userDataPath: string, workspacePath: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: {
      ...process.env,
      NOVAX_DESKTOP_E2E_USER_DATA: userDataPath,
      NOVAX_DESKTOP_E2E_WORKSPACE: workspacePath,
    },
  });
}

function filesContain(root: string, text: string): boolean {
  if (!fs.existsSync(root)) return false;
  const needle = Buffer.from(text, "utf8");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (filesContain(target, text)) return true;
    } else if (fs.readFileSync(target).includes(needle)) {
      return true;
    }
  }
  return false;
}

function readSafeAudit(workspacePath: string, runId: string) {
  const workspace = openWorkspace(workspacePath);
  try {
    const audit = new AgentAuditRepository(workspace);
    return {
      invocations: audit.listInvocations(runId).map((row) => ({
        id: row.id,
        role: row.role,
        promptVersion: row.prompt_version,
        requestedModelId: row.requested_model_id,
      })),
      tools: audit.listTools(runId).map((row) => ({
        id: row.id,
        invocationId: row.invocation_id,
        toolName: row.tool_name,
      })),
      events: audit.listEvents(runId).map((row) => ({
        entityType: row.entity_type,
        invocationId: row.invocation_id,
        toolInvocationId: row.tool_invocation_id,
        eventType: row.event_type,
        errorCode: row.error_code,
        actualModelId: row.actual_model_id,
        structuredSubmissionCount: row.structured_submission_count,
        correctionAttempts: row.correction_attempts,
      })),
    };
  } finally {
    workspace.close();
  }
}
