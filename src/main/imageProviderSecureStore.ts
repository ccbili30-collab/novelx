import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  imageProviderApiKeySchema,
  imageProviderConfigSchema,
  imageProviderPublicStateSchema,
  imageProviderRuntimeProfileSchema,
  imageProviderSaveRequestSchema,
  type ImageProviderPublicErrorCode,
  type ImageProviderPublicState,
  type ImageProviderRuntimeProfile,
  type ImageProviderSaveRequest,
} from "../shared/imageProviderContract";
import type { SecureStorageAdapter } from "./providerSecureStore";

export const IMAGE_PROVIDER_STORE_FILE_NAME = "image-provider-profile.v1.json";

const storedImageProviderEnvelopeSchema = z.object({
  version: z.literal(1),
  config: imageProviderConfigSchema,
  encryptedCredential: z.string().max(128_000).regex(/^[A-Za-z0-9+/]*={0,2}$/).nullable(),
}).strict();

type StoredImageProviderEnvelope = z.infer<typeof storedImageProviderEnvelopeSchema>;

export class ImageProviderSecureStore {
  readonly #storePath: string;

  constructor(userDataPath: string, readonly secureStorage: SecureStorageAdapter) {
    this.#storePath = path.join(path.resolve(userDataPath), IMAGE_PROVIDER_STORE_FILE_NAME);
  }

  getPublicState(): ImageProviderPublicState {
    const secureStorageAvailable = this.safeEncryptionAvailable();
    const envelope = this.readEnvelope();
    let hasCredential = false;
    if (secureStorageAvailable && envelope?.encryptedCredential) {
      hasCredential = imageProviderApiKeySchema.safeParse(this.decryptCredential(envelope.encryptedCredential)).success;
    }
    return imageProviderPublicStateSchema.parse({
      secureStorageAvailable,
      hasCredential,
      config: envelope?.config ?? null,
    });
  }

  save(input: ImageProviderSaveRequest): ImageProviderPublicState {
    const request = imageProviderSaveRequestSchema.parse(input);
    if (!this.safeEncryptionAvailable()) throw storeError("IMAGE_PROVIDER_SECURE_STORAGE_UNAVAILABLE");
    const current = this.readEnvelope();
    let encryptedCredential = current?.encryptedCredential ?? null;
    if (request.apiKey) {
      try {
        const encrypted = this.secureStorage.encryptString(request.apiKey);
        if (encrypted.length === 0) throw new Error("empty ciphertext");
        encryptedCredential = encrypted.toString("base64");
      } catch {
        throw storeError("IMAGE_PROVIDER_STORAGE_FAILED");
      }
    }
    if (!encryptedCredential) throw storeError("IMAGE_PROVIDER_CREDENTIAL_REQUIRED");
    this.writeEnvelope({ version: 1, config: request.config, encryptedCredential });
    return this.getPublicState();
  }

  clearCredential(): ImageProviderPublicState {
    let envelope: StoredImageProviderEnvelope | null;
    try {
      envelope = this.readEnvelope();
    } catch {
      this.removeStoreFile();
      return this.getPublicState();
    }
    if (envelope) this.writeEnvelope({ ...envelope, encryptedCredential: null });
    return this.getPublicState();
  }

  loadRuntimeProfile(): ImageProviderRuntimeProfile | null {
    if (!this.safeEncryptionAvailable()) return null;
    try {
      const envelope = this.readEnvelope();
      if (!envelope?.encryptedCredential) return null;
      const apiKey = this.decryptCredential(envelope.encryptedCredential);
      const parsed = imageProviderRuntimeProfileSchema.safeParse({ ...envelope.config, apiKey });
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  resolveRuntimeProfile(input: ImageProviderSaveRequest): ImageProviderRuntimeProfile {
    const request = imageProviderSaveRequestSchema.parse(input);
    const apiKey = request.apiKey ?? this.readStoredCredential();
    if (!apiKey) throw storeError("IMAGE_PROVIDER_CREDENTIAL_REQUIRED");
    return imageProviderRuntimeProfileSchema.parse({ ...request.config, apiKey });
  }

  private readStoredCredential(): string | null {
    if (!this.safeEncryptionAvailable()) return null;
    const envelope = this.readEnvelope();
    if (!envelope?.encryptedCredential) return null;
    const credential = this.decryptCredential(envelope.encryptedCredential);
    return imageProviderApiKeySchema.safeParse(credential).success ? credential : null;
  }

  private safeEncryptionAvailable(): boolean {
    try { return this.secureStorage.isEncryptionAvailable(); } catch { return false; }
  }

  private decryptCredential(encryptedCredential: string): string {
    try { return this.secureStorage.decryptString(Buffer.from(encryptedCredential, "base64")); }
    catch { throw storeError("IMAGE_PROVIDER_STORAGE_FAILED"); }
  }

  private readEnvelope(): StoredImageProviderEnvelope | null {
    if (!fs.existsSync(this.#storePath)) return null;
    try {
      return storedImageProviderEnvelopeSchema.parse(JSON.parse(fs.readFileSync(this.#storePath, "utf8")));
    } catch {
      throw storeError("IMAGE_PROVIDER_STORAGE_FAILED");
    }
  }

  private writeEnvelope(input: StoredImageProviderEnvelope): void {
    const envelope = storedImageProviderEnvelopeSchema.parse(input);
    const directory = path.dirname(this.#storePath);
    const temporaryPath = `${this.#storePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporaryPath, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, this.#storePath);
    } catch {
      throw storeError("IMAGE_PROVIDER_STORAGE_FAILED");
    } finally {
      try { if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true }); } catch { /* preserve the primary error */ }
    }
  }

  private removeStoreFile(): void {
    try { fs.rmSync(this.#storePath, { force: true }); }
    catch { throw storeError("IMAGE_PROVIDER_STORAGE_FAILED"); }
  }
}

function storeError(code: ImageProviderPublicErrorCode): Error & { code: ImageProviderPublicErrorCode } {
  return Object.assign(new Error("Image Provider secure storage operation failed."), { code });
}
