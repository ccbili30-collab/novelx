import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import {
  generateResponsesImage,
  resolveResponsesUrl,
  ResponsesImageProviderError,
} from "../domain/asset/responsesImageProviderClient";
import {
  imageProviderTestResultSchema,
  type ImageProviderRuntimeProfile,
  type ImageProviderTestResult,
} from "../shared/imageProviderContract";

const TEST_TIMEOUT_MS = 180_000;

export { resolveResponsesUrl };

export async function testImageProviderConnection(
  profile: ImageProviderRuntimeProfile,
): Promise<ImageProviderTestResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const generated = await generateResponsesImage(
      profile,
      "A small blue glass sphere on a plain white background, no text.",
      controller.signal,
    );
    const dimensions = imageSize(generated.bytes);
    const mimeType = readMimeType(generated.bytes);
    if (!dimensions.width || !dimensions.height || !mimeType) return failure("IMAGE_PROVIDER_PROTOCOL_FAILED");
    return imageProviderTestResultSchema.parse({
      ok: true,
      connection: "reachable",
      generation: "completed",
      latencyMs: Date.now() - startedAt,
      modelId: profile.modelId,
      mimeType,
      width: dimensions.width,
      height: dimensions.height,
      byteLength: generated.bytes.length,
      sha256: createHash("sha256").update(generated.bytes).digest("hex"),
    });
  } catch (error) {
    return error instanceof ResponsesImageProviderError
      ? failure(error.code, error.httpStatus)
      : failure("IMAGE_PROVIDER_CONNECTION_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

function readMimeType(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
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
