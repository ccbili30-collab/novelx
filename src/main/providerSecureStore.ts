import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  providerApiKeySchema,
  providerConfigSchema,
  providerPublicStateSchema,
  providerRuntimeProfileSchema,
  providerSaveRequestSchema,
  type ProviderPublicErrorCode,
  type ProviderPublicState,
  type ProviderRuntimeProfile,
  type ProviderSaveRequest,
} from "../shared/providerContract";

export const PROVIDER_STORE_FILE_NAME = "provider-profile.v1.json";

export interface SecureStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const storedProviderEnvelopeSchema = z.object({
  version: z.literal(1),
  config: providerConfigSchema,
  encryptedCredential: z.string().max(128_000).regex(/^[A-Za-z0-9+/]*={0,2}$/).nullable(),
}).strict();

type StoredProviderEnvelope = z.infer<typeof storedProviderEnvelopeSchema>;

export class ProviderSecureStore {
  readonly #storePath: string;

  constructor(
    userDataPath: string,
    readonly secureStorage: SecureStorageAdapter,
  ) {
    this.#storePath = path.join(path.resolve(userDataPath), PROVIDER_STORE_FILE_NAME);
  }

  getPublicState(): ProviderPublicState {
    const secureStorageAvailable = this.safeEncryptionAvailable();
    const envelope = this.readEnvelope();
    let hasCredential = false;
    if (secureStorageAvailable && envelope?.encryptedCredential) {
      const credential = this.decryptCredential(envelope.encryptedCredential);
      hasCredential = providerApiKeySchema.safeParse(credential).success;
    }
    return providerPublicStateSchema.parse({
      secureStorageAvailable,
      hasCredential,
      config: envelope?.config ?? null,
    });
  }

  save(input: ProviderSaveRequest): ProviderPublicState {
    const request = providerSaveRequestSchema.parse(input);
    if (!this.safeEncryptionAvailable()) {
      throw providerStoreError("PROVIDER_SECURE_STORAGE_UNAVAILABLE");
    }
    const current = this.readEnvelope();
    let encryptedCredential = current?.encryptedCredential ?? null;
    if (request.apiKey) {
      let encrypted: Buffer;
      try {
        encrypted = this.secureStorage.encryptString(request.apiKey);
      } catch {
        throw providerStoreError("PROVIDER_STORAGE_FAILED");
      }
      if (encrypted.length === 0) throw providerStoreError("PROVIDER_STORAGE_FAILED");
      encryptedCredential = encrypted.toString("base64");
    }
    if (!encryptedCredential) throw providerStoreError("PROVIDER_CREDENTIAL_REQUIRED");
    this.writeEnvelope({
      version: 1,
      config: request.config,
      encryptedCredential,
    });
    return this.getPublicState();
  }

  clearCredential(): ProviderPublicState {
    let envelope: StoredProviderEnvelope | null;
    try {
      envelope = this.readEnvelope();
    } catch {
      this.removeStoreFile();
      return this.getPublicState();
    }
    if (envelope) this.writeEnvelope({ ...envelope, encryptedCredential: null });
    return this.getPublicState();
  }

  loadRuntimeProfile(): ProviderRuntimeProfile | null {
    if (!this.safeEncryptionAvailable()) return null;
    let envelope: StoredProviderEnvelope | null;
    try {
      envelope = this.readEnvelope();
      if (!envelope?.encryptedCredential) return null;
      const apiKey = this.decryptCredential(envelope.encryptedCredential);
      const profile = providerRuntimeProfileSchema.safeParse({ ...envelope.config, apiKey });
      return profile.success ? profile.data : null;
    } catch {
      return null;
    }
  }

  resolveRuntimeProfile(input: ProviderSaveRequest): ProviderRuntimeProfile {
    const request = providerSaveRequestSchema.parse(input);
    const apiKey = request.apiKey ?? this.readStoredCredential();
    if (!apiKey) throw providerStoreError("PROVIDER_CREDENTIAL_REQUIRED");
    return providerRuntimeProfileSchema.parse({ ...request.config, apiKey });
  }

  private readStoredCredential(): string | null {
    if (!this.safeEncryptionAvailable()) return null;
    const envelope = this.readEnvelope();
    if (!envelope?.encryptedCredential) return null;
    const credential = this.decryptCredential(envelope.encryptedCredential);
    return providerApiKeySchema.safeParse(credential).success ? credential : null;
  }

  private safeEncryptionAvailable(): boolean {
    try {
      return this.secureStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private decryptCredential(encryptedCredential: string): string {
    try {
      return this.secureStorage.decryptString(Buffer.from(encryptedCredential, "base64"));
    } catch {
      throw providerStoreError("PROVIDER_STORAGE_FAILED");
    }
  }

  private readEnvelope(): StoredProviderEnvelope | null {
    if (!fs.existsSync(this.#storePath)) return null;
    try {
      const raw = fs.readFileSync(this.#storePath, "utf8");
      return storedProviderEnvelopeSchema.parse(JSON.parse(raw));
    } catch {
      throw providerStoreError("PROVIDER_STORAGE_FAILED");
    }
  }

  private writeEnvelope(input: StoredProviderEnvelope): void {
    const envelope = storedProviderEnvelopeSchema.parse(input);
    const directory = path.dirname(this.#storePath);
    const temporaryPath = `${this.#storePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporaryPath, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, this.#storePath);
    } catch {
      throw providerStoreError("PROVIDER_STORAGE_FAILED");
    } finally {
      try {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
      } catch {
        // A failed cleanup must not replace the original storage error or expose a path.
      }
    }
  }

  private removeStoreFile(): void {
    try {
      fs.rmSync(this.#storePath, { force: true });
    } catch {
      throw providerStoreError("PROVIDER_STORAGE_FAILED");
    }
  }
}

function providerStoreError(code: ProviderPublicErrorCode): Error & { code: ProviderPublicErrorCode } {
  return Object.assign(new Error("Provider secure storage operation failed."), { code });
}
