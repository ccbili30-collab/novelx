import { z } from "zod";

const providerBaseUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}, {
  message: "Provider baseUrl must use HTTPS unless it is an exact local loopback endpoint.",
});

export const providerConfigSchema = z.object({
  providerId: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  displayName: z.string().trim().min(1).max(120),
  baseUrl: providerBaseUrlSchema,
  modelId: z.string().trim().min(1).max(160),
  contextWindow: z.number().int().positive().max(10_000_000),
  maxTokens: z.number().int().positive().max(1_000_000).nullable(),
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])).min(1).max(2),
}).strict().superRefine((config, context) => {
  if (config.maxTokens !== null && config.maxTokens > config.contextWindow) {
    context.addIssue({ code: "custom", path: ["maxTokens"], message: "maxTokens cannot exceed contextWindow." });
  }
  if (new Set(config.input).size !== config.input.length) {
    context.addIssue({ code: "custom", path: ["input"], message: "Provider input capabilities must be unique." });
  }
});

export const providerApiKeySchema = z.string().trim().min(1).max(8_192);

export const providerRuntimeProfileSchema = providerConfigSchema.safeExtend({
  apiKey: providerApiKeySchema,
}).strict();

export const providerSaveRequestSchema = z.object({
  config: providerConfigSchema,
  apiKey: providerApiKeySchema.optional(),
}).strict();

export const providerTestRequestSchema = providerSaveRequestSchema;

export const providerTestResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    connection: z.literal("reachable"),
    ping: z.literal("completed"),
    latencyMs: z.number().int().min(0).max(600_000),
    modelId: z.string().min(1).max(160),
    contextWindow: z.number().int().positive().max(10_000_000),
    contextWindowSource: z.enum(["provider", "configured"]),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum([
        "PROVIDER_CREDENTIAL_REQUIRED",
        "PROVIDER_CONNECTION_FAILED",
        "PROVIDER_MODEL_NOT_FOUND",
        "PROVIDER_PING_FAILED",
        "PROVIDER_PROTOCOL_FAILED",
      ]),
      message: z.string().min(1).max(500),
    }).strict(),
  }).strict(),
]);

export const providerPublicStateSchema = z.object({
  secureStorageAvailable: z.boolean(),
  hasCredential: z.boolean(),
  config: providerConfigSchema.nullable(),
}).strict();

export const providerPublicErrorCodeSchema = z.enum([
  "PROVIDER_SECURE_STORAGE_UNAVAILABLE",
  "PROVIDER_CREDENTIAL_REQUIRED",
  "PROVIDER_CONFIG_INVALID",
  "PROVIDER_STORAGE_FAILED",
]);

export const providerPublicErrorSchema = z.object({
  code: providerPublicErrorCodeSchema,
  message: z.string().min(1).max(240),
}).strict();

export const providerStatusResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), state: providerPublicStateSchema }).strict(),
  z.object({ ok: z.literal(false), error: providerPublicErrorSchema }).strict(),
]);

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderRuntimeProfile = z.infer<typeof providerRuntimeProfileSchema>;
export type ProviderSaveRequest = z.infer<typeof providerSaveRequestSchema>;
export type ProviderTestRequest = z.infer<typeof providerTestRequestSchema>;
export type ProviderTestResult = z.infer<typeof providerTestResultSchema>;
export type ProviderPublicState = z.infer<typeof providerPublicStateSchema>;
export type ProviderPublicErrorCode = z.infer<typeof providerPublicErrorCodeSchema>;
export type ProviderStatusResult = z.infer<typeof providerStatusResultSchema>;
