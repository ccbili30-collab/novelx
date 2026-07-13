import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  IMAGE_PROVIDER_STORE_FILE_NAME,
  ImageProviderSecureStore,
} from "../../src/main/imageProviderSecureStore";
import type { SecureStorageAdapter } from "../../src/main/providerSecureStore";
import {
  imageProviderPublicStateSchema,
  imageProviderSaveRequestSchema,
} from "../../src/shared/imageProviderContract";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ImageProviderSecureStore", () => {
  it("persists only encrypted image credentials and restores the runtime profile", () => {
    const root = createRoot();
    const secureStorage = new TestSecureStorage();
    const request = imageProviderRequest("image-secret-value");
    const store = new ImageProviderSecureStore(root, secureStorage);

    expect(store.save(request)).toEqual({
      secureStorageAvailable: true,
      hasCredential: true,
      config: request.config,
    });
    const stored = fs.readFileSync(path.join(root, IMAGE_PROVIDER_STORE_FILE_NAME), "utf8");
    expect(stored).not.toContain(request.apiKey);
    expect(stored).not.toContain("apiKey");
    expect(new ImageProviderSecureStore(root, secureStorage).loadRuntimeProfile())
      .toEqual({ ...request.config, apiKey: request.apiKey });
  });

  it("keeps text and image Provider credentials in separate files", () => {
    const root = createRoot();
    const store = new ImageProviderSecureStore(root, new TestSecureStorage());
    store.save(imageProviderRequest("image-only-secret"));

    expect(fs.existsSync(path.join(root, IMAGE_PROVIDER_STORE_FILE_NAME))).toBe(true);
    expect(fs.existsSync(path.join(root, "provider-profile.v1.json"))).toBe(false);
  });

  it("updates config without replacing the credential and clears only the credential", () => {
    const root = createRoot();
    const store = new ImageProviderSecureStore(root, new TestSecureStorage());
    const request = imageProviderRequest("credential-to-retain");
    store.save(request);
    const before = JSON.parse(fs.readFileSync(path.join(root, IMAGE_PROVIDER_STORE_FILE_NAME), "utf8"));
    const nextConfig = { ...request.config, modelId: "gpt-image-next", defaultQuality: "high" as const };

    expect(store.save({ config: nextConfig })).toMatchObject({ hasCredential: true, config: nextConfig });
    const after = JSON.parse(fs.readFileSync(path.join(root, IMAGE_PROVIDER_STORE_FILE_NAME), "utf8"));
    expect(after.encryptedCredential).toBe(before.encryptedCredential);
    expect(store.clearCredential()).toMatchObject({ hasCredential: false, config: nextConfig });
    expect(store.loadRuntimeProfile()).toBeNull();
  });

  it("fails closed without secure storage and rejects unsafe base URLs", () => {
    const unavailable = new ImageProviderSecureStore(createRoot(), new TestSecureStorage(false));
    expect(() => unavailable.save(imageProviderRequest("not-written"))).toThrowError(expect.objectContaining({
      code: "IMAGE_PROVIDER_SECURE_STORAGE_UNAVAILABLE",
    }));
    const request = imageProviderRequest("secret");
    expect(imageProviderSaveRequestSchema.safeParse({
      ...request,
      config: { ...request.config, baseUrl: "http://localhost.evil.example" },
    }).success).toBe(false);
    expect(imageProviderPublicStateSchema.safeParse({
      secureStorageAvailable: true,
      hasCredential: true,
      config: request.config,
      apiKey: "must-not-project",
    }).success).toBe(false);
  });
});

class TestSecureStorage implements SecureStorageAdapter {
  constructor(readonly available = true) {}
  isEncryptionAvailable() { return this.available; }
  encryptString(value: string) {
    if (!this.available) throw new Error("unavailable");
    return Buffer.from(`cipher:${[...value].reverse().join("")}`, "utf8");
  }
  decryptString(value: Buffer) {
    if (!this.available) throw new Error("unavailable");
    const text = value.toString("utf8");
    if (!text.startsWith("cipher:")) throw new Error("invalid ciphertext");
    return [...text.slice(7)].reverse().join("");
  }
}

function imageProviderRequest(apiKey: string) {
  const request = imageProviderSaveRequestSchema.parse({
    config: {
      providerId: "openai-compatible-image",
      displayName: "NovelX 图片模型",
      baseUrl: "https://proxy.example",
      modelId: "gpt-5.6-luna",
      endpoint: "responses",
      defaultSize: "1024x1024",
      defaultQuality: "auto",
      defaultBackground: "auto",
    },
    apiKey,
  });
  return { ...request, apiKey };
}

function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-image-provider-store-"));
  roots.push(root);
  return root;
}
