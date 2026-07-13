import { z } from "zod";

const imageProviderBaseUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}, {
  message: "Image Provider baseUrl must use HTTPS unless it is an exact local loopback endpoint.",
});

export const imageProviderConfigSchema = z.object({
  providerId: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  displayName: z.string().trim().min(1).max(120),
  baseUrl: imageProviderBaseUrlSchema,
  modelId: z.string().trim().min(1).max(160),
  endpoint: z.literal("responses"),
  defaultSize: z.string().regex(/^\d{2,4}x\d{2,4}$/).refine((value) => {
    const [width, height] = value.split("x").map(Number);
    return width! >= 256 && width! <= 4096 && height! >= 256 && height! <= 4096;
  }, "Image dimensions must be between 256 and 4096 pixels."),
  defaultQuality: z.enum(["auto", "low", "medium", "high"]),
  defaultBackground: z.enum(["auto", "transparent", "opaque"]),
}).strict();

export const imageProviderApiKeySchema = z.string().trim().min(1).max(8_192);

export const imageProviderRuntimeProfileSchema = imageProviderConfigSchema.safeExtend({
  apiKey: imageProviderApiKeySchema,
}).strict();

export const imageProviderSaveRequestSchema = z.object({
  config: imageProviderConfigSchema,
  apiKey: imageProviderApiKeySchema.optional(),
}).strict();

export const imageProviderPublicStateSchema = z.object({
  secureStorageAvailable: z.boolean(),
  hasCredential: z.boolean(),
  config: imageProviderConfigSchema.nullable(),
}).strict();

export const imageProviderPublicErrorCodeSchema = z.enum([
  "IMAGE_PROVIDER_SECURE_STORAGE_UNAVAILABLE",
  "IMAGE_PROVIDER_CREDENTIAL_REQUIRED",
  "IMAGE_PROVIDER_CONFIG_INVALID",
  "IMAGE_PROVIDER_STORAGE_FAILED",
]);

export const imageProviderStatusResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), state: imageProviderPublicStateSchema }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: imageProviderPublicErrorCodeSchema,
      message: z.string().min(1).max(240),
    }).strict(),
  }).strict(),
]);

export const imageProviderTestRequestSchema = imageProviderSaveRequestSchema;

export const imageProviderTestResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    connection: z.literal("reachable"),
    generation: z.literal("completed"),
    latencyMs: z.number().int().min(0).max(600_000),
    modelId: z.string().min(1).max(160),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
    byteLength: z.number().int().positive().max(100_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum([
        "IMAGE_PROVIDER_CREDENTIAL_REQUIRED",
        "IMAGE_PROVIDER_CONNECTION_FAILED",
        "IMAGE_PROVIDER_GENERATION_FAILED",
        "IMAGE_PROVIDER_PROTOCOL_FAILED",
      ]),
      message: z.string().min(1).max(500),
    }).strict(),
  }).strict(),
]);

export type ImageProviderConfig = z.infer<typeof imageProviderConfigSchema>;
export type ImageProviderRuntimeProfile = z.infer<typeof imageProviderRuntimeProfileSchema>;
export type ImageProviderSaveRequest = z.infer<typeof imageProviderSaveRequestSchema>;
export type ImageProviderPublicState = z.infer<typeof imageProviderPublicStateSchema>;
export type ImageProviderPublicErrorCode = z.infer<typeof imageProviderPublicErrorCodeSchema>;
export type ImageProviderStatusResult = z.infer<typeof imageProviderStatusResultSchema>;
export type ImageProviderTestRequest = z.infer<typeof imageProviderTestRequestSchema>;
export type ImageProviderTestResult = z.infer<typeof imageProviderTestResultSchema>;
