import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("configures and clears an independent image Provider without leaking its credential", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-image-provider-ui-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  const secret = "novax-image-ui-secret-1842";
  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      env: { ...process.env, NOVAX_DESKTOP_E2E_USER_DATA: userDataPath, NOVAX_DESKTOP_E2E_WORKSPACE: workspacePath },
    });
    const page = await app.firstWindow();
    await page.getByTitle("设置").click();
    const dialog = page.getByRole("dialog", { name: "novelx 设置" });
    await expect(dialog.getByRole("heading", { name: "图片模型" })).toBeVisible();
    await expect(dialog.getByLabel("Base URL（图片服务地址）")).toHaveValue("https://proxy3.qianc.ltd");
    await expect(dialog.getByLabel("Model ID（生图模型标识）")).toHaveValue("gpt-5.6-luna");

    await dialog.getByTestId("image-provider-api-key").fill(secret);
    await dialog.getByRole("button", { name: "保存图片模型" }).click();
    await expect(dialog.getByText("图片凭据已配置")).toBeVisible();
    await expect(dialog.getByText("图片模型配置已安全保存，尚未执行真实生成测试。")).toBeVisible();
    await expect(dialog.getByTestId("image-provider-api-key")).toHaveValue("");

    const publicEvidence = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return { status: await desktop.imageProvider.getStatus(), html: document.documentElement.outerHTML, storage: { ...localStorage } };
    });
    expect(JSON.stringify(publicEvidence)).not.toContain(secret);
    expect(filesContain(workspacePath, secret)).toBe(false);

    await dialog.getByRole("button", { name: "清除图片凭据" }).click();
    await dialog.getByRole("button", { name: "确认清除" }).click();
    await expect(dialog.getByText("尚未配置图片凭据")).toBeVisible();
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function filesContain(root: string, text: string): boolean {
  if (!fs.existsSync(root)) return false;
  const needle = Buffer.from(text, "utf8");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) { if (filesContain(target, text)) return true; }
    else if (fs.readFileSync(target).includes(needle)) return true;
  }
  return false;
}
