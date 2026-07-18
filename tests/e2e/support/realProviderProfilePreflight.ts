import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { imageProviderConfigSchema } from "../../../src/shared/imageProviderContract";
import { providerConfigSchema } from "../../../src/shared/providerContract";

const encryptedCredentialSchema = z.string().min(1).max(128_000).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const textStoreSchema = z.object({
  version: z.literal(1),
  config: providerConfigSchema,
  encryptedCredential: encryptedCredentialSchema,
}).strict();
const imageStoreSchema = z.object({
  version: z.literal(1),
  config: imageProviderConfigSchema,
  encryptedCredential: encryptedCredentialSchema,
}).strict();

export interface RealProviderProfilePreflightResult {
  text: { providerId: string; modelId: string; storeSha256: string };
  image: { providerId: string; modelId: string; storeSha256: string };
  localStateSha256: string;
}

/** Reads only public config and ciphertext presence. It never decrypts credentials. */
export function verifyRealProviderProfilePreflight(input: {
  textStorePath: string;
  imageStorePath: string;
  expectedText: { providerId: "openai-compatible"; modelId: "5.6luna" };
  expectedImageProviderId: "openai-compatible-image";
}): RealProviderProfilePreflightResult {
  const text = readStore(input.textStorePath, textStoreSchema, "REAL_PROVIDER_STORE_INVALID");
  const image = readStore(input.imageStorePath, imageStoreSchema, "REAL_IMAGE_PROVIDER_STORE_INVALID");
  if (text.config.providerId !== input.expectedText.providerId || text.config.modelId !== input.expectedText.modelId) {
    throw preflightError("REAL_PROVIDER_MODEL_ID_MISMATCH");
  }
  if (image.config.providerId !== input.expectedImageProviderId || image.config.endpoint !== "responses") {
    throw preflightError("REAL_IMAGE_PROVIDER_IDENTITY_MISMATCH");
  }
  const textLocalState = path.join(path.dirname(input.textStorePath), "Local State");
  const imageLocalState = path.join(path.dirname(input.imageStorePath), "Local State");
  if (!fs.existsSync(textLocalState) || !fs.existsSync(imageLocalState)) {
    throw preflightError("REAL_PROVIDER_LOCAL_STATE_MISSING");
  }
  const textLocalStateBytes = fs.readFileSync(textLocalState);
  const imageLocalStateBytes = fs.readFileSync(imageLocalState);
  if (!textLocalStateBytes.equals(imageLocalStateBytes)) {
    throw preflightError("REAL_PROVIDER_LOCAL_STATE_MISMATCH");
  }
  return {
    text: {
      providerId: text.config.providerId,
      modelId: text.config.modelId,
      storeSha256: sha256(fs.readFileSync(input.textStorePath)),
    },
    image: {
      providerId: image.config.providerId,
      modelId: image.config.modelId,
      storeSha256: sha256(fs.readFileSync(input.imageStorePath)),
    },
    localStateSha256: sha256(textLocalStateBytes),
  };
}

function readStore<T>(storePath: string, schema: z.ZodType<T>, code: string): T {
  try {
    return schema.parse(JSON.parse(fs.readFileSync(storePath, "utf8")));
  } catch {
    throw preflightError(code);
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function preflightError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
