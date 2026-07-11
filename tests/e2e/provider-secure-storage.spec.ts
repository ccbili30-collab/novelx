import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDER_STORE_FILE_NAME } from "../../src/main/providerSecureStore";
import type { AgentRunEvent, DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("encrypts Provider credentials, restores them after restart, and injects them only into Agent Worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-provider-e2e-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  const secret = "novax-e2e-provider-secret-4f9d";
  let app: ElectronApplication | null = null;

  try {
    app = await launch(userDataPath, workspacePath);
    let page = await app.firstWindow();
    const saved = await page.evaluate(async ({ apiKey }) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const before = await desktop.provider.getStatus();
      const saveResult = await desktop.provider.save({
        config: {
          providerId: "e2e-provider",
          displayName: "E2E Provider",
          baseUrl: "https://provider.example/v1",
          modelId: "e2e-model",
          contextWindow: 128_000,
          maxTokens: 16_000,
          reasoning: true,
          input: ["text"],
        },
        apiKey,
      });
      return { before, saveResult, providerApiKeys: Object.keys(desktop.provider).sort() };
    }, { apiKey: secret });

    expect(saved.before).toMatchObject({ ok: true, state: { hasCredential: false } });
    expect(saved.saveResult).toMatchObject({
      ok: true,
      state: {
        secureStorageAvailable: true,
        hasCredential: true,
        config: { providerId: "e2e-provider", modelId: "e2e-model" },
      },
    });
    expect(saved.providerApiKeys).toEqual(["clearCredential", "getStatus", "save", "test"]);
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(JSON.stringify(saved)).not.toContain("apiKey");

    const storePath = path.join(userDataPath, PROVIDER_STORE_FILE_NAME);
    expect(fs.existsSync(storePath)).toBe(true);
    expect(fs.readFileSync(storePath, "utf8")).not.toContain(secret);
    expect(filesContain(workspacePath, secret)).toBe(false);

    await app.close();
    app = await launch(userDataPath, workspacePath);
    page = await app.firstWindow();
    const restored = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.provider.getStatus();
    });
    expect(restored).toMatchObject({
      ok: true,
      state: { hasCredential: true, config: { providerId: "e2e-provider" } },
    });
    expect(JSON.stringify(restored)).not.toContain(secret);

    const events = await collectAgentFailure(page);
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      code: "PROVIDER_RUNTIME_FAILED",
    });
    expect(JSON.stringify(events)).not.toContain(secret);

    const cleared = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.provider.clearCredential();
    });
    expect(cleared).toMatchObject({ ok: true, state: { hasCredential: false } });
    expect(fs.readFileSync(storePath, "utf8")).not.toContain(secret);
    const blocked = await collectAgentFailure(page);
    expect(blocked.at(-1)).toMatchObject({ type: "run.failed", code: "REAL_GM_PROVIDER_REQUIRED" });
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

function collectAgentFailure(page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>): Promise<AgentRunEvent[]> {
  return page.evaluate(async () => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const project = (await desktop.project.list()).projects[0]!;
    const listed = await desktop.session.list({ projectId: project.id });
    const session = listed.sessions[0] ?? await desktop.session.create({ projectId: project.id });
    return new Promise<AgentRunEvent[]>((resolve, reject) => {
      const events: AgentRunEvent[] = [];
      const timer = globalThis.setTimeout(() => reject(new Error("Timed out waiting for Agent failure.")), 8_000);
      const unsubscribe = desktop.agent.subscribe((event) => {
        events.push(event);
        if (event.type === "run.failed") {
          globalThis.clearTimeout(timer);
          unsubscribe();
          resolve(events);
        }
      });
      void desktop.agent.start({
        projectId: project.id,
        sessionId: session.id,
        userInput: "检查模型配置注入",
        mode: "assist",
      });
    });
  });
}

function filesContain(root: string, text: string): boolean {
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
