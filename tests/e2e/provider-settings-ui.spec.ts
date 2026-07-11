import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopApi } from "../../src/shared/ipcContract";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("configures and clears a Provider without leaking the credential in Renderer state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-provider-settings-ui-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  const secret = "novax-ui-secret-8b7431";
  let app: ElectronApplication | null = null;

  try {
    app = await launch(userDataPath, workspacePath);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.getByTitle("设置").click();
    const dialog = page.getByRole("dialog", { name: "novelx 设置" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("尚未配置凭据")).toBeVisible();
    await page.screenshot({ path: "test-results/novax-provider-settings-1440x900.png", fullPage: true });

    await dialog.getByLabel("Base URL（服务地址）").fill("https://provider.example/v1");
    await dialog.getByLabel("Model ID（模型标识）").fill("novax-model");
    await dialog.getByLabel("Context Window（上下文窗口）").fill("128000");
    await dialog.getByLabel("Max Tokens（最大输出）").fill("16000");
    await dialog.getByLabel("Reasoning（推理）").check();
    await dialog.getByLabel("Image Input（图像输入）").check();
    await dialog.getByTestId("provider-api-key").fill(secret);
    await dialog.getByRole("button", { name: "安全保存" }).click();

    await expect(dialog.getByText("凭据已配置")).toBeVisible();
    await expect(dialog.getByText("配置已安全保存，尚未验证服务连接。")).toBeVisible();
    await expect(dialog.getByTestId("provider-api-key")).toHaveValue("");
    const rendererEvidence = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return {
        publicStatus: await desktop.provider.getStatus(),
        url: location.href,
        html: document.documentElement.outerHTML,
        text: document.body.textContent,
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
      };
    });
    expect(JSON.stringify(rendererEvidence)).not.toContain(secret);
    expect(JSON.stringify(rendererEvidence.publicStatus)).not.toContain("apiKey");
    expect(filesContain(workspacePath, secret)).toBe(false);

    await dialog.getByLabel("Max Tokens（最大输出）").fill("12000");
    await dialog.getByRole("button", { name: "安全保存" }).click();
    await expect(dialog.getByText("配置已安全保存，尚未验证服务连接。")).toBeVisible();
    await expect(dialog.getByTestId("provider-api-key")).toHaveValue("");

    await page.setViewportSize({ width: 1100, height: 700 });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: "test-results/novax-provider-settings-saved-1100x700.png", fullPage: true });

    await dialog.getByRole("button", { name: "清除凭据" }).click();
    await expect(dialog.getByText("确认清除已保存的凭据？")).toBeVisible();
    await dialog.getByRole("button", { name: "确认清除" }).click();
    await expect(dialog.getByText("尚未配置凭据")).toBeVisible();
    await expect(dialog.getByText("凭据已清除。模型配置参数仍保留在本机。")).toBeVisible();

    await dialog.getByLabel("Base URL（服务地址）").fill("http://provider.example/v1");
    await dialog.getByRole("button", { name: "安全保存" }).click();
    await expect(dialog.getByText("请输入 HTTPS 地址；本机服务仅允许 localhost、127.0.0.1 或 ::1。")).toBeVisible();
    await expect(dialog.getByText("请输入 API 密钥。")).toBeVisible();
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
