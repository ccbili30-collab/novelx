import {
  providerSaveRequestSchema,
  type ProviderConfig,
  type ProviderSaveRequest,
  type ProviderStatusResult,
} from "./providerContract";

export interface ProviderSettingsForm {
  providerId: string;
  displayName: string;
  baseUrl: string;
  modelId: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  inputText: boolean;
  inputImage: boolean;
}

export type ProviderSettingsViewState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "configured"; displayName: string; modelId: string }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export type ProviderFormParseResult =
  | { ok: true; request: ProviderSaveRequest }
  | { ok: false; fieldErrors: Partial<Record<keyof ProviderSettingsForm | "apiKey", string>> };

export function createProviderSettingsForm(config: ProviderConfig | null): ProviderSettingsForm {
  return {
    providerId: config?.providerId ?? "openai-compatible",
    displayName: config?.displayName ?? "OpenAI Compatible",
    baseUrl: config?.baseUrl ?? "",
    modelId: config?.modelId ?? "",
    contextWindow: config ? String(config.contextWindow) : "",
    maxTokens: config?.maxTokens === null || !config ? "" : String(config.maxTokens),
    reasoning: config?.reasoning ?? false,
    inputText: config?.input.includes("text") ?? true,
    inputImage: config?.input.includes("image") ?? false,
  };
}

export function describeProviderStatus(result: ProviderStatusResult | null): ProviderSettingsViewState {
  if (!result) return { kind: "loading" };
  if (!result.ok) return { kind: "error", message: result.error.message };
  if (!result.state.secureStorageAvailable) return { kind: "unavailable" };
  if (!result.state.hasCredential) return { kind: "unconfigured" };
  return {
    kind: "configured",
    displayName: result.state.config?.displayName ?? "模型服务",
    modelId: result.state.config?.modelId ?? "未指定模型",
  };
}

export function parseProviderSettingsForm(
  form: ProviderSettingsForm,
  apiKey: string,
  hasCredential = false,
): ProviderFormParseResult {
  const normalizedApiKey = apiKey.trim();
  const credentialMissing = !normalizedApiKey && !hasCredential;
  const input: Array<"text" | "image"> = [];
  if (form.inputText) input.push("text");
  if (form.inputImage) input.push("image");
  const request = {
    config: {
      providerId: form.providerId,
      displayName: form.displayName,
      baseUrl: form.baseUrl,
      modelId: form.modelId,
      contextWindow: Number(form.contextWindow),
      maxTokens: form.maxTokens.trim() === "" ? null : Number(form.maxTokens),
      reasoning: form.reasoning,
      input,
    },
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
  };
  const result = providerSaveRequestSchema.safeParse(request);
  if (result.success) {
    return credentialMissing
      ? { ok: false, fieldErrors: { apiKey: "请输入 API 密钥。" } }
      : { ok: true, request: result.data };
  }

  const fieldErrors: Partial<Record<keyof ProviderSettingsForm | "apiKey", string>> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.at(-1);
    if (field === "input") {
      fieldErrors.inputText = "至少选择一种输入能力。";
    } else if (typeof field === "string" && isProviderFormField(field)) {
      fieldErrors[field] = readableFieldError(field);
    }
  }
  if (credentialMissing) fieldErrors.apiKey = "请输入 API 密钥。";
  return { ok: false, fieldErrors };
}

function isProviderFormField(field: string): field is keyof ProviderSettingsForm | "apiKey" {
  return [
    "providerId",
    "displayName",
    "baseUrl",
    "modelId",
    "contextWindow",
    "maxTokens",
    "reasoning",
    "inputText",
    "inputImage",
    "apiKey",
  ].includes(field);
}

function readableFieldError(field: keyof ProviderSettingsForm | "apiKey"): string {
  switch (field) {
    case "baseUrl": return "请输入 HTTPS 地址；本机服务仅允许 localhost、127.0.0.1 或 ::1。";
    case "contextWindow": return "请输入有效的正整数。";
    case "maxTokens": return "请输入不超过上下文窗口的正整数。";
    case "apiKey": return "请输入 API 密钥。";
    default: return "此项格式无效或不能为空。";
  }
}
