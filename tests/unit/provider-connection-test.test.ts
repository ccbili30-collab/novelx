import { afterEach, describe, expect, it, vi } from "vitest";
import { testProviderConnection } from "../../src/main/providerConnectionTest";

describe("Provider connection test", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses Provider-declared context capability and sends only a minimal ping", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-1", context_window: 1_000_000 }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { role: "assistant", content: "pong" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testProviderConnection(profile());

    expect(result).toMatchObject({ ok: true, contextWindow: 1_000_000, contextWindowSource: "provider" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      model: "model-1",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 8,
      stream: false,
    });
  });

  it("fails closed when ping does not return an assistant response", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-1" }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [] })));
    await expect(testProviderConnection(profile())).resolves.toMatchObject({
      ok: false,
      error: { code: "PROVIDER_PROTOCOL_FAILED" },
    });
  });
});

function profile() {
  return {
    providerId: "provider-1",
    displayName: "Provider",
    baseUrl: "https://provider.example/v1",
    modelId: "model-1",
    contextWindow: 128_000,
    maxTokens: null,
    reasoning: false,
    input: ["text" as const],
    apiKey: "secret",
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
