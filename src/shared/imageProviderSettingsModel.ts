import {
  imageProviderSaveRequestSchema,
  type ImageProviderConfig,
  type ImageProviderSaveRequest,
  type ImageProviderStatusResult,
} from "./imageProviderContract";

export interface ImageProviderSettingsForm {
  providerId: string;
  displayName: string;
  baseUrl: string;
  modelId: string;
  defaultSize: string;
  defaultQuality: "auto" | "low" | "medium" | "high";
  defaultBackground: "auto" | "transparent" | "opaque";
}

export type ImageProviderSettingsViewState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "configured"; displayName: string; modelId: string }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export type ImageProviderFormParseResult =
  | { ok: true; request: ImageProviderSaveRequest }
  | { ok: false; fieldErrors: Partial<Record<keyof ImageProviderSettingsForm | "apiKey", string>> };

export function createImageProviderSettingsForm(config: ImageProviderConfig | null): ImageProviderSettingsForm {
  return {
    providerId: config?.providerId ?? "openai-compatible-image",
    displayName: config?.displayName ?? "NovelX 图片模型",
    baseUrl: config?.baseUrl ?? "https://proxy3.qianc.ltd",
    modelId: config?.modelId ?? "gpt-5.6-luna",
    defaultSize: config?.defaultSize ?? "1024x1024",
    defaultQuality: config?.defaultQuality ?? "auto",
    defaultBackground: config?.defaultBackground ?? "auto",
  };
}

export function describeImageProviderStatus(result: ImageProviderStatusResult | null): ImageProviderSettingsViewState {
  if (!result) return { kind: "loading" };
  if (!result.ok) return { kind: "error", message: result.error.message };
  if (!result.state.secureStorageAvailable) return { kind: "unavailable" };
  if (!result.state.hasCredential) return { kind: "unconfigured" };
  return {
    kind: "configured",
    displayName: result.state.config?.displayName ?? "图片模型",
    modelId: result.state.config?.modelId ?? "未指定模型",
  };
}

export function parseImageProviderSettingsForm(
  form: ImageProviderSettingsForm,
  apiKey: string,
  hasCredential = false,
): ImageProviderFormParseResult {
  const normalizedApiKey = apiKey.trim();
  const credentialMissing = !normalizedApiKey && !hasCredential;
  const result = imageProviderSaveRequestSchema.safeParse({
    config: {
      ...form,
      endpoint: "responses",
    },
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
  });
  if (result.success) {
    return credentialMissing
      ? { ok: false, fieldErrors: { apiKey: "请输入图片模型 API 密钥。" } }
      : { ok: true, request: result.data };
  }

  const fieldErrors: Partial<Record<keyof ImageProviderSettingsForm | "apiKey", string>> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.at(-1);
    if (typeof field !== "string" || !isImageProviderFormField(field)) continue;
    fieldErrors[field] = field === "baseUrl"
      ? "请输入 HTTPS 地址；本机服务仅允许 localhost、127.0.0.1 或 ::1。"
      : field === "defaultSize"
        ? "请输入 256–4096 像素范围内的尺寸，例如 1024x1024。"
        : "此项格式无效或不能为空。";
  }
  if (credentialMissing) fieldErrors.apiKey = "请输入图片模型 API 密钥。";
  return { ok: false, fieldErrors };
}

function isImageProviderFormField(field: string): field is keyof ImageProviderSettingsForm | "apiKey" {
  return [
    "providerId", "displayName", "baseUrl", "modelId", "defaultSize",
    "defaultQuality", "defaultBackground", "apiKey",
  ].includes(field);
}
