import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveResponsesUrl,
  testImageProviderConnection,
} from "../../src/main/imageProviderConnectionTest";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("Image Provider connection test", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds /v1/responses to a host-only proxy URL and performs one real generation-shaped request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      output: [{ type: "image_generation_call", result: ONE_PIXEL_PNG }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testImageProviderConnection(profile());

    expect(result).toMatchObject({
      ok: true,
      generation: "completed",
      modelId: "gpt-5.6-luna",
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://proxy.example/v1/responses");
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(request).toMatchObject({
      model: "gpt-5.6-luna",
      stream: false,
      tools: [{ type: "image_generation", size: "1024x1024", quality: "auto", background: "auto", output_format: "png" }],
    });
  });

  it("accepts an SSE image result and rejects responses without image bytes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response([
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result: ONE_PIXEL_PNG } })}`,
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } })));
    await expect(testImageProviderConnection(profile())).resolves.toMatchObject({ ok: true, generation: "completed" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ output: [] })));
    await expect(testImageProviderConnection(profile())).resolves.toMatchObject({
      ok: false,
      error: { code: "IMAGE_PROVIDER_PROTOCOL_FAILED" },
    });
  });

  it("keeps configured API path prefixes and fails closed on HTTP errors", async () => {
    expect(resolveResponsesUrl("https://proxy.example/custom/v1").toString())
      .toBe("https://proxy.example/custom/v1/responses");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream failed", { status: 502 })));
    await expect(testImageProviderConnection(profile())).resolves.toMatchObject({
      ok: false,
      error: { code: "IMAGE_PROVIDER_GENERATION_FAILED" },
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("too large", {
      status: 200,
      headers: { "content-length": String(41 * 1024 * 1024) },
    })));
    await expect(testImageProviderConnection(profile())).resolves.toMatchObject({
      ok: false,
      error: { code: "IMAGE_PROVIDER_PROTOCOL_FAILED" },
    });
  });
});

function profile() {
  return {
    providerId: "openai-compatible-image",
    displayName: "NovelX 图片模型",
    baseUrl: "https://proxy.example",
    modelId: "gpt-5.6-luna",
    endpoint: "responses" as const,
    defaultSize: "1024x1024",
    defaultQuality: "auto" as const,
    defaultBackground: "auto" as const,
    apiKey: "secret",
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
