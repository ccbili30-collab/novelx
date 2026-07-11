import { expect, test, _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { TextSourceParserService } from "../../src/domain/import/textSourceParserService";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url); const electronPath = require("electron") as string;
const apiKey = process.env.NOVAX_REAL_E2E_API_KEY?.trim() ?? "";
test.skip(!apiKey, "NOVAX_REAL_E2E_API_KEY is required for real Decomposer evidence.");

test("runs the visible Decomposer through the real Provider and persists terminal audit", async () => {
  test.setTimeout(240_000); const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-real-decomposer-")); const userData = path.join(root, "user-data"); const workspaceRoot = path.join(root, "workspace"); fs.mkdirSync(workspaceRoot, { recursive: true });
  const workspace = openWorkspace(workspaceRoot); const sourcePath = path.join(workspaceRoot, "银湾.md"); fs.writeFileSync(sourcePath, "# 世界规则\n银湾洞穴只在退潮时开放。\n\n# 原著未来\n三年后银湾沉没。", "utf8");
  const source = new SourceLibraryRepository(workspace).register({ filePath: sourcePath, rightsAttestation: "user_owned" }); new TextSourceParserService(workspace).parse(source.id); workspace.close();
  const app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userData, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot } });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async (key) => { const api = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop; await api.provider.save({ config: { providerId: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", modelId: "deepseek-chat", contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text"] }, apiKey: key }); }, apiKey);
    await page.getByRole("radio", { name: "导入" }).click(); await page.getByRole("button", { name: "开始拆解" }).click();
    await expect(page.getByRole("status")).toContainText("拆解完成", { timeout: 180_000 });
    await expect(page.locator(".candidate-review")).not.toHaveCount(0);
    const evidence = openWorkspace(workspaceRoot);
    try {
      expect(evidence.db.prepare("SELECT status, provider_id, requested_model_id, output_sha256 FROM decomposer_run_audits ORDER BY started_at DESC LIMIT 1").get()).toMatchObject({ status: "succeeded", provider_id: "deepseek", requested_model_id: "deepseek-chat", output_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(evidence.db.prepare("SELECT COUNT(*) AS count FROM decomposition_candidates WHERE source_id = ?").get(source.id)).toMatchObject({ count: expect.any(Number) });
    } finally { evidence.close(); }
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
