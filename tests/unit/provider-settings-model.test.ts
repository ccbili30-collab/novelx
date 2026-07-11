import { describe, expect, it } from "vitest";
import {
  createProviderSettingsForm,
  describeProviderStatus,
  parseProviderSettingsForm,
} from "../../src/shared/providerSettingsModel";

describe("Provider Settings model", () => {
  it("maps only public Provider state into user-facing status", () => {
    expect(describeProviderStatus(null)).toEqual({ kind: "loading" });
    expect(describeProviderStatus({
      ok: true,
      state: { secureStorageAvailable: false, hasCredential: false, config: null },
    })).toEqual({ kind: "unavailable" });
    expect(describeProviderStatus({
      ok: false,
      error: { code: "PROVIDER_STORAGE_FAILED", message: "安全配置读取失败。" },
    })).toEqual({ kind: "error", message: "安全配置读取失败。" });
    expect(describeProviderStatus({
      ok: true,
      state: {
        secureStorageAvailable: true,
        hasCredential: true,
        config: providerConfig(),
      },
    })).toEqual({ kind: "configured", displayName: "Provider", modelId: "model-1" });
  });

  it("builds a strict save request without adding secret persistence fields", () => {
    const form = createProviderSettingsForm(providerConfig());
    const parsed = parseProviderSettingsForm(form, "unit-provider-secret");

    expect(parsed).toEqual({
      ok: true,
      request: { config: providerConfig(), apiKey: "unit-provider-secret" },
    });
    if (parsed.ok) {
      expect(Object.keys(parsed.request)).toEqual(["config", "apiKey"]);
      expect(Object.keys(parsed.request.config).sort()).toEqual([
        "baseUrl",
        "contextWindow",
        "displayName",
        "input",
        "maxTokens",
        "modelId",
        "providerId",
        "reasoning",
      ]);
    }
  });

  it("rejects unsafe endpoints, missing credentials, and empty capabilities", () => {
    const form = {
      ...createProviderSettingsForm(providerConfig()),
      baseUrl: "http://provider.example/v1",
      inputText: false,
      inputImage: false,
    };
    const parsed = parseProviderSettingsForm(form, "");

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.fieldErrors).toMatchObject({
        baseUrl: expect.any(String),
        apiKey: expect.any(String),
        inputText: expect.any(String),
      });
    }
  });

  it("allows non-secret configuration updates only when a credential already exists", () => {
    const form = createProviderSettingsForm(providerConfig());
    const parsed = parseProviderSettingsForm({ ...form, maxTokens: "12000" }, "", true);

    expect(parsed).toEqual({
      ok: true,
      request: { config: { ...providerConfig(), maxTokens: 12_000 } },
    });
    expect(parseProviderSettingsForm(form, "", false)).toEqual({
      ok: false,
      fieldErrors: { apiKey: "请输入 API 密钥。" },
    });
  });

  it("uses Auto output mode when Max Tokens is left empty", () => {
    const parsed = parseProviderSettingsForm({
      ...createProviderSettingsForm(providerConfig()),
      maxTokens: "",
    }, "unit-provider-secret");
    expect(parsed).toEqual({
      ok: true,
      request: { config: { ...providerConfig(), maxTokens: null }, apiKey: "unit-provider-secret" },
    });
  });
});

function providerConfig() {
  return {
    providerId: "provider-1",
    displayName: "Provider",
    baseUrl: "https://provider.example/v1",
    modelId: "model-1",
    contextWindow: 128_000,
    maxTokens: 16_000,
    reasoning: true,
    input: ["text" as const, "image" as const],
  };
}
