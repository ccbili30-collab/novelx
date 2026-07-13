import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import {
  imageProviderTestResultSchema,
  type ImageProviderRuntimeProfile,
  type ImageProviderTestResult,
} from "../shared/imageProviderContract";

const TEST_TIMEOUT_MS = 180_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export async function testImageProviderConnection(
  profile: ImageProviderRuntimeProfile,
): Promise<ImageProviderTestResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const response = await fetch(resolveResponsesUrl(profile.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        model: profile.modelId,
        instructions: "Use the image_generation tool to create exactly the requested image. Do not add extra text.",
        stream: false,
        input: [{
          role: "user",
          content: [{ type: "input_text", text: "A small blue glass sphere on a plain white background, no text." }],
        }],
        tools: [{
          type: "image_generation",
          size: profile.defaultSize,
          quality: profile.defaultQuality,
          background: profile.defaultBackground,
          output_format: "png",
        }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return failure("IMAGE_PROVIDER_GENERATION_FAILED", response.status);
    const raw = await response.text();
    const encoded = extractImageBase64(raw);
    if (!encoded) return failure("IMAGE_PROVIDER_PROTOCOL_FAILED", response.status);
    const bytes = decodeBoundedBase64(encoded);
    const dimensions = imageSize(bytes);
    const mimeType = readMimeType(bytes);
    if (!dimensions.width || !dimensions.height || !mimeType) {
      return failure("IMAGE_PROVIDER_PROTOCOL_FAILED", response.status);
    }
    return imageProviderTestResultSchema.parse({
      ok: true,
      connection: "reachable",
      generation: "completed",
      latencyMs: Date.now() - startedAt,
      modelId: profile.modelId,
      mimeType,
      width: dimensions.width,
      height: dimensions.height,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } catch {
    return failure("IMAGE_PROVIDER_CONNECTION_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveResponsesUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/, "");
  if (!path) path = "/v1";
  if (!path.endsWith("/v1")) path = `${path}/v1`;
  url.pathname = `${path}/responses`;
  return url;
}

function extractImageBase64(raw: string): string | null {
  try {
    return findImageResult(JSON.parse(raw));
  } catch {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const result = findImageResult(JSON.parse(payload));
        if (result) return result;
      } catch {
        // Ignore malformed SSE frames; a later terminal frame may contain the result.
      }
    }
    return null;
  }
}

function findImageResult(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findImageResult(item);
      if (result) return result;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const type = value.type;
  if (type === "image_generation_call" && typeof value.result === "string") return stripDataUrl(value.result);
  for (const key of ["b64_json", "image_base64"] as const) {
    if (typeof value[key] === "string") return stripDataUrl(value[key]);
  }
  for (const child of Object.values(value)) {
    const result = findImageResult(child);
    if (result) return result;
  }
  return null;
}

function stripDataUrl(value: string): string {
  return value.startsWith("data:image/") ? value.slice(value.indexOf(",") + 1) : value;
}

function decodeBoundedBase64(encoded: string): Buffer {
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16) throw new Error("Image response is too large.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("Image response is invalid.");
  return bytes;
}

function readMimeType(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
  code: "IMAGE_PROVIDER_CONNECTION_FAILED" | "IMAGE_PROVIDER_GENERATION_FAILED" | "IMAGE_PROVIDER_PROTOCOL_FAILED",
  status?: number,
): ImageProviderTestResult {
  const suffix = status === undefined ? "" : ` (HTTP ${status})`;
  const messages = {
    IMAGE_PROVIDER_CONNECTION_FAILED: `无法连接图片模型服务${suffix}。`,
    IMAGE_PROVIDER_GENERATION_FAILED: `图片模型已连接，但测试生成失败${suffix}。`,
    IMAGE_PROVIDER_PROTOCOL_FAILED: `图片模型返回了无法识别的图片结果${suffix}。`,
  } as const;
  return imageProviderTestResultSchema.parse({ ok: false, error: { code, message: messages[code] } });
}
