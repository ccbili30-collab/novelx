import { ipcMain } from "electron";
import {
  desktopIpcChannels,
} from "../shared/ipcContract";
import {
  providerPublicErrorCodeSchema,
  providerSaveRequestSchema,
  providerStatusResultSchema,
  providerTestRequestSchema,
  providerTestResultSchema,
  type ProviderPublicErrorCode,
  type ProviderPublicState,
  type ProviderStatusResult,
} from "../shared/providerContract";
import type { ProviderSecureStore } from "./providerSecureStore";
import { testProviderConnection } from "./providerConnectionTest";

export function registerProviderIpc(store: ProviderSecureStore): void {
  ipcMain.handle(desktopIpcChannels.providerStatus, () => providerResult(() => store.getPublicState()));
  ipcMain.handle(desktopIpcChannels.providerSave, (_event, payload: unknown) => providerResult(() => {
    const request = providerSaveRequestSchema.parse(payload);
    return store.save(request);
  }));
  ipcMain.handle(desktopIpcChannels.providerClearCredential, () => providerResult(() => store.clearCredential()));
  ipcMain.handle(desktopIpcChannels.providerTest, async (_event, payload: unknown) => {
    try {
      const request = providerTestRequestSchema.parse(payload);
      return await testProviderConnection(store.resolveRuntimeProfile(request));
    } catch (error) {
      const credentialMissing = readProviderErrorCode(error) === "PROVIDER_CREDENTIAL_REQUIRED";
      return providerTestResultSchema.parse({
        ok: false,
        error: {
          code: credentialMissing ? "PROVIDER_CREDENTIAL_REQUIRED" : "PROVIDER_PROTOCOL_FAILED",
          message: credentialMissing ? "请先输入 API Key（接口密钥）。" : "Provider（提供方）测试配置无效。",
        },
      });
    }
  });
}

function providerResult(operation: () => ProviderPublicState): ProviderStatusResult {
  try {
    return providerStatusResultSchema.parse({ ok: true, state: operation() });
  } catch (error) {
    const code = readProviderErrorCode(error);
    return providerStatusResultSchema.parse({
      ok: false,
      error: { code, message: PROVIDER_ERROR_MESSAGES[code] },
    });
  }
}

function readProviderErrorCode(error: unknown): ProviderPublicErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = providerPublicErrorCodeSchema.safeParse((error as { code?: unknown }).code);
    if (parsed.success) return parsed.data;
  }
  if (typeof error === "object" && error !== null && "name" in error && error.name === "ZodError") {
    return "PROVIDER_CONFIG_INVALID";
  }
  return "PROVIDER_STORAGE_FAILED";
}

const PROVIDER_ERROR_MESSAGES: Record<ProviderPublicErrorCode, string> = {
  PROVIDER_SECURE_STORAGE_UNAVAILABLE: "系统安全存储不可用，无法保存模型凭据。",
  PROVIDER_CREDENTIAL_REQUIRED: "首次配置模型服务时必须提供接口密钥。",
  PROVIDER_CONFIG_INVALID: "模型服务配置无效。",
  PROVIDER_STORAGE_FAILED: "模型服务安全配置读取或保存失败。",
};
