import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROVIDER_STORE_FILE_NAME,
  ProviderSecureStore,
  type SecureStorageAdapter,
} from "../../src/main/providerSecureStore";
import {
  providerPublicStateSchema,
  providerSaveRequestSchema,
} from "../../src/shared/providerContract";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ProviderSecureStore", () => {
  it("persists only encrypted credentials and restores a runtime profile after restart", () => {
    const root = createRoot();
    const secureStorage = new TestSecureStorage();
    const first = new ProviderSecureStore(root, secureStorage);
    const request = providerRequest("novax-secret-value");

    expect(first.save(request)).toEqual({
      secureStorageAvailable: true,
      hasCredential: true,
      config: request.config,
    });
    const stored = fs.readFileSync(path.join(root, PROVIDER_STORE_FILE_NAME), "utf8");
    expect(stored).not.toContain(request.apiKey);
    expect(stored).not.toContain("apiKey");

    const reopened = new ProviderSecureStore(root, secureStorage);
    expect(reopened.getPublicState()).toMatchObject({ hasCredential: true, config: request.config });
    expect(reopened.loadRuntimeProfile()).toEqual({ ...request.config, apiKey: request.apiKey });
  });

  it("clears the credential while retaining non-secret configuration", () => {
    const root = createRoot();
    const store = new ProviderSecureStore(root, new TestSecureStorage());
    const request = providerRequest("credential-to-clear");
    store.save(request);

    expect(store.clearCredential()).toEqual({
      secureStorageAvailable: true,
      hasCredential: false,
      config: request.config,
    });
    expect(store.loadRuntimeProfile()).toBeNull();
    expect(fs.readFileSync(path.join(root, PROVIDER_STORE_FILE_NAME), "utf8")).not.toContain(request.apiKey);
  });

  it("updates non-secret configuration without decrypting or replacing an existing credential", () => {
    const root = createRoot();
    const store = new ProviderSecureStore(root, new TestSecureStorage());
    const request = providerRequest("credential-to-retain");
    store.save(request);
    const before = JSON.parse(fs.readFileSync(path.join(root, PROVIDER_STORE_FILE_NAME), "utf8"));

    const nextConfig = { ...request.config, modelId: "novax-model-v2", maxTokens: 12_000 };
    expect(store.save({ config: nextConfig })).toMatchObject({ hasCredential: true, config: nextConfig });
    const after = JSON.parse(fs.readFileSync(path.join(root, PROVIDER_STORE_FILE_NAME), "utf8"));

    expect(after.encryptedCredential).toBe(before.encryptedCredential);
    expect(store.loadRuntimeProfile()).toEqual({ ...nextConfig, apiKey: request.apiKey });
    expect(() => new ProviderSecureStore(createRoot(), new TestSecureStorage()).save({ config: nextConfig }))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_CREDENTIAL_REQUIRED" }));
  });

  it("fails closed when system encryption is unavailable", () => {
    const store = new ProviderSecureStore(createRoot(), new TestSecureStorage(false));

    expect(store.getPublicState()).toEqual({
      secureStorageAvailable: false,
      hasCredential: false,
      config: null,
    });
    expect(() => store.save(providerRequest("not-written"))).toThrowError(expect.objectContaining({
      code: "PROVIDER_SECURE_STORAGE_UNAVAILABLE",
    }));
    expect(store.loadRuntimeProfile()).toBeNull();
  });

  it("allows credential clearing to recover from a corrupt encrypted store", () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, PROVIDER_STORE_FILE_NAME), "{not-valid-json", "utf8");
    const store = new ProviderSecureStore(root, new TestSecureStorage());

    expect(store.clearCredential()).toEqual({
      secureStorageAvailable: true,
      hasCredential: false,
      config: null,
    });
    expect(fs.existsSync(path.join(root, PROVIDER_STORE_FILE_NAME))).toBe(false);
  });

  it("rejects lookalike loopback URLs and public payloads cannot omit validation", () => {
    const request = providerRequest("secret");
    expect(providerSaveRequestSchema.safeParse({
      ...request,
      config: { ...request.config, baseUrl: "http://localhost.evil.example/v1" },
    }).success).toBe(false);
    expect(providerSaveRequestSchema.safeParse({ ...request, debug: true }).success).toBe(false);
    expect(providerPublicStateSchema.safeParse({
      secureStorageAvailable: true,
      hasCredential: true,
      config: request.config,
      apiKey: "must-not-project",
    }).success).toBe(false);
  });
});

class TestSecureStorage implements SecureStorageAdapter {
  constructor(readonly available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plainText: string): Buffer {
    if (!this.available) throw new Error("unavailable");
    return Buffer.from(`cipher:${[...plainText].reverse().join("")}`, "utf8");
  }

  decryptString(encrypted: Buffer): string {
    if (!this.available) throw new Error("unavailable");
    const value = encrypted.toString("utf8");
    if (!value.startsWith("cipher:")) throw new Error("invalid ciphertext");
    return [...value.slice("cipher:".length)].reverse().join("");
  }
}

function providerRequest(apiKey: string) {
  const request = providerSaveRequestSchema.parse({
    config: {
      providerId: "openai-compatible",
      displayName: "OpenAI Compatible",
      baseUrl: "https://provider.example/v1",
      modelId: "novax-model",
      contextWindow: 128_000,
      maxTokens: 16_000,
      reasoning: true,
      input: ["text"],
    },
    apiKey,
  });
  return { ...request, apiKey };
}

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-provider-store-"));
  roots.push(root);
  return root;
}
