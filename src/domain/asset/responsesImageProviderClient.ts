import type { ImageProviderRuntimeProfile } from "../../shared/imageProviderContract";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

export interface GeneratedImageResponse {
  bytes: Buffer;
  responseId: string | null;
}

export type ResponsesImageProviderErrorCode =
  | "IMAGE_PROVIDER_CONNECTION_FAILED"
  | "IMAGE_PROVIDER_GENERATION_FAILED"
  | "IMAGE_PROVIDER_PROTOCOL_FAILED";

export const responsesImageProviderFailureClasses = [
  "IMAGE_PROVIDER_CONNECTION_FAILED",
  "IMAGE_PROVIDER_PROTOCOL_FAILED",
  "IMAGE_PROVIDER_REQUEST_REJECTED",
  "IMAGE_PROVIDER_AUTH_FAILED",
  "IMAGE_PROVIDER_MODEL_UNAVAILABLE",
  "IMAGE_PROVIDER_RATE_LIMITED",
  "IMAGE_PROVIDER_SERVICE_UNAVAILABLE",
  "IMAGE_PROVIDER_GENERATION_FAILED",
] as const;

export type ResponsesImageProviderFailureClass = (typeof responsesImageProviderFailureClasses)[number];

export function isResponsesImageProviderFailureClass(value: unknown): value is ResponsesImageProviderFailureClass {
  return typeof value === "string"
    && (responsesImageProviderFailureClasses as readonly string[]).includes(value);
}

export class ResponsesImageProviderError extends Error {
  readonly failureClass: ResponsesImageProviderFailureClass;

  constructor(
    readonly code: ResponsesImageProviderErrorCode,
    readonly outcomeUnknown: boolean,
    readonly httpStatus?: number,
  ) {
    super(code);
    this.name = "ResponsesImageProviderError";
    this.failureClass = classifyImageProviderFailure(code, httpStatus);
  }
}

export function classifyImageProviderFailure(
  code: ResponsesImageProviderErrorCode,
  httpStatus?: number,
): ResponsesImageProviderFailureClass {
  if (code !== "IMAGE_PROVIDER_GENERATION_FAILED" || httpStatus === undefined) return code;
  if (httpStatus === 401 || httpStatus === 403) return "IMAGE_PROVIDER_AUTH_FAILED";
  if (httpStatus === 404) return "IMAGE_PROVIDER_MODEL_UNAVAILABLE";
  if (httpStatus === 429) return "IMAGE_PROVIDER_RATE_LIMITED";
  if (httpStatus >= 500 && httpStatus <= 599) return "IMAGE_PROVIDER_SERVICE_UNAVAILABLE";
  if (httpStatus >= 400 && httpStatus <= 499) return "IMAGE_PROVIDER_REQUEST_REJECTED";
  return "IMAGE_PROVIDER_GENERATION_FAILED";
}

export async function generateResponsesImage(
  profile: ImageProviderRuntimeProfile,
  prompt: string,
  signal?: AbortSignal,
): Promise<GeneratedImageResponse> {
  let response: Response;
  try {
    response = await fetch(resolveResponsesUrl(profile.baseUrl), {
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
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        tools: [{
          type: "image_generation",
          size: profile.defaultSize,
          quality: profile.defaultQuality,
          background: profile.defaultBackground,
          output_format: "png",
        }],
      }),
      signal,
    });
  } catch {
    throw new ResponsesImageProviderError("IMAGE_PROVIDER_CONNECTION_FAILED", true);
  }
  if (!response.ok) {
    throw new ResponsesImageProviderError("IMAGE_PROVIDER_GENERATION_FAILED", false, response.status);
  }
  let raw: string;
  try { raw = await readBoundedText(response); }
  catch { throw new ResponsesImageProviderError("IMAGE_PROVIDER_PROTOCOL_FAILED", false, response.status); }
  const extracted = extractImagePayload(raw);
  if (!extracted) throw new ResponsesImageProviderError("IMAGE_PROVIDER_PROTOCOL_FAILED", false, response.status);
  return { bytes: decodeBoundedBase64(extracted.base64), responseId: extracted.responseId };
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ResponsesImageProviderError("IMAGE_PROVIDER_PROTOCOL_FAILED", false, response.status);
  }
  if (!response.body) throw new ResponsesImageProviderError("IMAGE_PROVIDER_PROTOCOL_FAILED", false, response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ResponsesImageProviderError("IMAGE_PROVIDER_PROTOCOL_FAILED", false, response.status);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

export function resolveResponsesUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/, "");
  if (!path) path = "/v1";
  if (!path.endsWith("/v1")) path = `${path}/v1`;
  url.pathname = `${path}/responses`;
  return url;
}

function extractImagePayload(raw: string): { base64: string; responseId: string | null } | null {
  try { return findImageResult(JSON.parse(raw), null); }
  catch {
    let responseId: string | null = null;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as unknown;
        responseId = responseId ?? findResponseId(parsed);
        const result = findImageResult(parsed, responseId);
        if (result) return result;
      } catch {
        // A later complete SSE frame may still contain the image result.
      }
    }
    return null;
  }
}

function findImageResult(value: unknown, inheritedResponseId: string | null): { base64: string; responseId: string | null } | null {
  const responseId = inheritedResponseId ?? findResponseId(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findImageResult(item, responseId);
      if (result) return result;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.type === "image_generation_call" && typeof value.result === "string") {
    return { base64: stripDataUrl(value.result), responseId };
  }
  for (const key of ["b64_json", "image_base64"] as const) {
    if (typeof value[key] === "string") return { base64: stripDataUrl(value[key]), responseId };
  }
  for (const child of Object.values(value)) {
    const result = findImageResult(child, responseId);
    if (result) return result;
  }
  return null;
}

function findResponseId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.id === "string" && (value.object === "response" || value.type === "response.completed")) return value.id;
  if (isRecord(value.response) && typeof value.response.id === "string") return value.response.id;
  return null;
}

function stripDataUrl(value: string): string {
  return value.startsWith("data:image/") ? value.slice(value.indexOf(",") + 1) : value;
}

function decodeBoundedBase64(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    || encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16) {
    throw new ResponsesImageProviderError("IMAGE_PROVIDER_PROTOCOL_FAILED", false);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new ResponsesImageProviderError("IMAGE_PROVIDER_PROTOCOL_FAILED", false);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
