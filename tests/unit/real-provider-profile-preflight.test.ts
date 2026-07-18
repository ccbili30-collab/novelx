import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyRealProviderProfilePreflight } from "../e2e/support/realProviderProfilePreflight";

let root: string | undefined;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("real Provider profile preflight", () => {
  it("accepts exact 5.6luna and image identities without decrypting ciphertext", () => {
    const stores = createStores();
    const result = verifyRealProviderProfilePreflight({
      ...stores,
      expectedText: { providerId: "openai-compatible", modelId: "5.6luna" },
      expectedImageProviderId: "openai-compatible-image",
    });
    expect(result).toMatchObject({
      text: { providerId: "openai-compatible", modelId: "5.6luna" },
      image: { providerId: "openai-compatible-image", modelId: "gpt-image-2" },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-ciphertext");
  });

  it("fails before the authorized continuation for a wrong text model", () => {
    const stores = createStores({ textModelId: "gpt-5.4" });
    const continuation = vi.fn();
    expect(() => {
      verifyRealProviderProfilePreflight({
        ...stores,
        expectedText: { providerId: "openai-compatible", modelId: "5.6luna" },
        expectedImageProviderId: "openai-compatible-image",
      });
      continuation();
    }).toThrowError(expect.objectContaining({ code: "REAL_PROVIDER_MODEL_ID_MISMATCH" }));
    expect(continuation).not.toHaveBeenCalled();
  });

  it("rejects mismatched Local State and malformed ciphertext", () => {
    const stores = createStores({ distinctImageLocalState: true });
    expect(() => verifyRealProviderProfilePreflight({
      ...stores,
      expectedText: { providerId: "openai-compatible", modelId: "5.6luna" },
      expectedImageProviderId: "openai-compatible-image",
    })).toThrowError(expect.objectContaining({ code: "REAL_PROVIDER_LOCAL_STATE_MISMATCH" }));

    const invalid = createStores({ ciphertext: "not ciphertext!" });
    expect(() => verifyRealProviderProfilePreflight({
      ...invalid,
      expectedText: { providerId: "openai-compatible", modelId: "5.6luna" },
      expectedImageProviderId: "openai-compatible-image",
    })).toThrowError(expect.objectContaining({ code: "REAL_PROVIDER_STORE_INVALID" }));
  });
});

function createStores(options: {
  textModelId?: string;
  ciphertext?: string;
  distinctImageLocalState?: boolean;
} = {}) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-provider-preflight-"));
  const textRoot = path.join(root, "text");
  const imageRoot = path.join(root, "image");
  fs.mkdirSync(textRoot, { recursive: true });
  fs.mkdirSync(imageRoot, { recursive: true });
  const ciphertext = options.ciphertext ?? Buffer.from("synthetic-ciphertext").toString("base64");
  const textStorePath = path.join(textRoot, "provider-profile.v1.json");
  const imageStorePath = path.join(imageRoot, "image-provider-profile.v1.json");
  fs.writeFileSync(textStorePath, JSON.stringify({
    version: 1,
    config: {
      providerId: "openai-compatible", displayName: "Text", baseUrl: "https://example.invalid/v1",
      modelId: options.textModelId ?? "5.6luna", contextWindow: 200_000, maxTokens: null,
      reasoning: true, input: ["text"],
    },
    encryptedCredential: ciphertext,
  }));
  fs.writeFileSync(imageStorePath, JSON.stringify({
    version: 1,
    config: {
      providerId: "openai-compatible-image", displayName: "Image", baseUrl: "https://example.invalid/v1",
      modelId: "gpt-image-2", endpoint: "responses", defaultSize: "1024x1024",
      defaultQuality: "auto", defaultBackground: "auto",
    },
    encryptedCredential: ciphertext,
  }));
  fs.writeFileSync(path.join(textRoot, "Local State"), "same-state");
  fs.writeFileSync(path.join(imageRoot, "Local State"), options.distinctImageLocalState ? "other-state" : "same-state");
  return { textStorePath, imageStorePath };
}
