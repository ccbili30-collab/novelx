import { ipcMain } from "electron";
import {
  imageProviderPublicErrorCodeSchema,
  imageProviderSaveRequestSchema,
  imageProviderStatusResultSchema,
  imageProviderTestRequestSchema,
  imageProviderTestResultSchema,
  type ImageProviderPublicErrorCode,
  type ImageProviderPublicState,
  type ImageProviderStatusResult,
} from "../shared/imageProviderContract";
import { desktopIpcChannels } from "../shared/ipcContract";
import { testImageProviderConnection } from "./imageProviderConnectionTest";
import type { ImageProviderSecureStore } from "./imageProviderSecureStore";

export function registerImageProviderIpc(store: ImageProviderSecureStore): void {
  ipcMain.handle(desktopIpcChannels.imageProviderStatus, () => imageProviderResult(() => store.getPublicState()));
  ipcMain.handle(desktopIpcChannels.imageProviderSave, (_event, payload: unknown) => imageProviderResult(() => {
    return store.save(imageProviderSaveRequestSchema.parse(payload));
  }));
  ipcMain.handle(desktopIpcChannels.imageProviderClearCredential, () => imageProviderResult(() => store.clearCredential()));
  ipcMain.handle(desktopIpcChannels.imageProviderTest, async (_event, payload: unknown) => {
    try {
      const request = imageProviderTestRequestSchema.parse(payload);
      return await testImageProviderConnection(store.resolveRuntimeProfile(request));
    } catch (error) {
      const credentialMissing = readErrorCode(error) === "IMAGE_PROVIDER_CREDENTIAL_REQUIRED";
      return imageProviderTestResultSchema.parse({
        ok: false,
        error: {
          code: credentialMissing ? "IMAGE_PROVIDER_CREDENTIAL_REQUIRED" : "IMAGE_PROVIDER_PROTOCOL_FAILED",
          message: credentialMissing ? "请先输入图片模型 API Key（接口密钥）。" : "图片模型测试配置无效。",
        },
      });
    }
  });
}

function imageProviderResult(operation: () => ImageProviderPublicState): ImageProviderStatusResult {
  try {
    return imageProviderStatusResultSchema.parse({ ok: true, state: operation() });
  } catch (error) {
    const code = readErrorCode(error);
    return imageProviderStatusResultSchema.parse({
      ok: false,
      error: { code, message: ERROR_MESSAGES[code] },
    });
  }
}

function readErrorCode(error: unknown): ImageProviderPublicErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = imageProviderPublicErrorCodeSchema.safeParse((error as { code?: unknown }).code);
    if (parsed.success) return parsed.data;
  }
  if (typeof error === "object" && error !== null && "name" in error && error.name === "ZodError") {
    return "IMAGE_PROVIDER_CONFIG_INVALID";
  }
  return "IMAGE_PROVIDER_STORAGE_FAILED";
}

const ERROR_MESSAGES: Record<ImageProviderPublicErrorCode, string> = {
  IMAGE_PROVIDER_SECURE_STORAGE_UNAVAILABLE: "系统安全存储不可用，无法保存图片模型凭据。",
  IMAGE_PROVIDER_CREDENTIAL_REQUIRED: "首次配置图片模型时必须提供接口密钥。",
  IMAGE_PROVIDER_CONFIG_INVALID: "图片模型配置无效。",
  IMAGE_PROVIDER_STORAGE_FAILED: "图片模型安全配置读取或保存失败。",
};
