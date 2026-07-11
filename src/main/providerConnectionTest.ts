import {
  providerTestResultSchema,
  type ProviderRuntimeProfile,
  type ProviderTestResult,
} from "../shared/providerContract";

const TEST_TIMEOUT_MS = 20_000;

export async function testProviderConnection(profile: ProviderRuntimeProfile): Promise<ProviderTestResult> {
  const startedAt = Date.now();
  try {
    const modelsResponse = await providerFetch(profile, "models", { method: "GET" });
    if (!modelsResponse.ok) return failure("PROVIDER_CONNECTION_FAILED", modelsResponse.status);
    const modelsPayload = await readJson(modelsResponse);
    const model = findModel(modelsPayload, profile.modelId);
    if (!model) return failure("PROVIDER_MODEL_NOT_FOUND", modelsResponse.status);

    const pingResponse = await providerFetch(profile, "chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        model: profile.modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        stream: false,
      }),
    });
    if (!pingResponse.ok) return failure("PROVIDER_PING_FAILED", pingResponse.status);
    const pingPayload = await readJson(pingResponse);
    if (!hasAssistantResponse(pingPayload)) return failure("PROVIDER_PROTOCOL_FAILED", pingResponse.status);

    const providerContextWindow = readContextWindow(model);
    return providerTestResultSchema.parse({
      ok: true,
      connection: "reachable",
      ping: "completed",
      latencyMs: Date.now() - startedAt,
      modelId: profile.modelId,
      contextWindow: providerContextWindow ?? profile.contextWindow,
      contextWindowSource: providerContextWindow === null ? "configured" : "provider",
    });
  } catch {
    return failure("PROVIDER_CONNECTION_FAILED");
  }
}

async function providerFetch(
  profile: ProviderRuntimeProfile,
  relativePath: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const baseUrl = profile.baseUrl.endsWith("/") ? profile.baseUrl : `${profile.baseUrl}/`;
    return await fetch(new URL(relativePath, baseUrl), {
      ...init,
      headers: { Authorization: `Bearer ${profile.apiKey}`, ...init.headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("Provider did not return JSON.");
  return response.json();
}

function findModel(payload: unknown, modelId: string): Record<string, unknown> | null {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return null;
  const model = payload.data.find((item) => isRecord(item) && item.id === modelId);
  return isRecord(model) ? model : null;
}

function readContextWindow(model: Record<string, unknown>): number | null {
  for (const field of ["context_window", "contextWindow", "max_model_len", "max_context_length"]) {
    const value = model[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000) return value;
  }
  return null;
}

function hasAssistantResponse(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return false;
  return payload.choices.some((choice) => isRecord(choice) && isRecord(choice.message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
  code: "PROVIDER_CONNECTION_FAILED" | "PROVIDER_MODEL_NOT_FOUND" | "PROVIDER_PING_FAILED" | "PROVIDER_PROTOCOL_FAILED",
  status?: number,
): ProviderTestResult {
  const suffix = status === undefined ? "" : ` (HTTP ${status})`;
  const messages = {
    PROVIDER_CONNECTION_FAILED: `无法连接模型服务${suffix}。`,
    PROVIDER_MODEL_NOT_FOUND: `模型列表中没有配置的 Model ID（模型标识）${suffix}。`,
    PROVIDER_PING_FAILED: `连接成功，但最小 ping 请求失败${suffix}。`,
    PROVIDER_PROTOCOL_FAILED: `Provider（提供方）返回了无法识别的响应${suffix}。`,
  } as const;
  return providerTestResultSchema.parse({ ok: false, error: { code, message: messages[code] } });
}
