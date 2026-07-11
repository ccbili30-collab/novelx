import { expect, test, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunEvent, DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("fails closed through the real Electron IPC and Agent subprocess when Provider is missing", async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "novax-provider-env-e2e-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-provider-workspace-e2e-"));
  const app = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: {
      ...process.env,
      NOVAX_DESKTOP_E2E_USER_DATA: userDataPath,
      NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot,
      NOVAX_PROVIDER_ID: "legacy-provider",
      NOVAX_PROVIDER_NAME: "Legacy Provider",
      NOVAX_PROVIDER_BASE_URL: "https://provider.example/v1",
      NOVAX_PROVIDER_API_KEY: "legacy-environment-secret",
      NOVAX_PROVIDER_MODEL: "legacy-model",
      NOVAX_PROVIDER_CONTEXT_WINDOW: "128000",
      NOVAX_PROVIDER_MAX_TOKENS: "16000",
      NOVAX_PROVIDER_REASONING: "true",
    },
  });

  try {
    const page = await app.firstWindow();
    const events = await page.evaluate(async () => {
      const browserWindow = globalThis as typeof globalThis & { novaxDesktop: DesktopApi };
      const desktop = browserWindow.novaxDesktop;
      const project = (await desktop.project.list()).projects[0]!;
      const listed = await desktop.session.list({ projectId: project.id });
      const session = listed.sessions[0] ?? await desktop.session.create({ projectId: project.id });
      return await new Promise<AgentRunEvent[]>((resolve, reject) => {
        const received: AgentRunEvent[] = [];
        const timeout = globalThis.setTimeout(() => reject(new Error("Timed out waiting for provider failure.")), 8_000);
        const unsubscribe = desktop.agent.subscribe((event) => {
          received.push(event);
          if (event.type === "run.failed") {
            globalThis.clearTimeout(timeout);
            unsubscribe();
            resolve(received);
          }
        });

        void desktop.agent.start({
          projectId: project.id,
          sessionId: session.id,
          userInput: "讨论银湾海岸为何曲折",
          mode: "assist",
        });
      });
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "run.started" });
    expect(events[1]).toMatchObject({
      type: "run.failed",
      code: "REAL_GM_PROVIDER_REQUIRED",
      message: "需要先配置可用的模型服务。",
    });
    expect(JSON.stringify(events)).not.toMatch(/prompt|apiKey|debug|tool|thinking|path/i);
  } finally {
    await app.close();
    fs.rmSync(userDataPath, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
