import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const artifactReference = /^novax-artifact:\/\/growth-editorial\/sha256\/([a-f0-9]{64})\.(md|json)$/;

export interface GrowthEditorialStoredArtifact {
  storeRef: string;
  contentSha256: string;
}

/**
 * Content-addressed storage for model candidates and handoffs.
 * SQLite stores only the immutable reference and digest; downstream work
 * re-reads and verifies these bytes instead of depending on process memory.
 */
export class GrowthEditorialArtifactStore {
  readonly #artifactRoot: string;

  constructor(workspaceRoot: string) {
    this.#artifactRoot = path.resolve(workspaceRoot, ".novax", "artifacts", "growth-editorial", "sha256");
  }

  putMarkdown(content: string): GrowthEditorialStoredArtifact {
    return this.#put(content, "md");
  }

  putJson(value: unknown): GrowthEditorialStoredArtifact {
    return this.#put(`${JSON.stringify(sortJson(value))}\n`, "json");
  }

  readText(storeRef: string, expectedSha256?: string): string {
    const resolved = this.#resolve(storeRef);
    if (expectedSha256 !== undefined && expectedSha256 !== resolved.sha256) {
      throw artifactError("GROWTH_EDITORIAL_ARTIFACT_INTEGRITY_FAILED");
    }
    let content: string;
    try {
      content = fs.readFileSync(resolved.path, "utf8");
    } catch {
      throw artifactError("GROWTH_EDITORIAL_ARTIFACT_NOT_FOUND");
    }
    if (sha256(content) !== resolved.sha256) {
      throw artifactError("GROWTH_EDITORIAL_ARTIFACT_INTEGRITY_FAILED");
    }
    return content;
  }

  readJson(storeRef: string, expectedSha256?: string): unknown {
    const resolved = this.#resolve(storeRef);
    if (resolved.extension !== "json") throw artifactError("GROWTH_EDITORIAL_ARTIFACT_KIND_INVALID");
    try {
      return JSON.parse(this.readText(storeRef, expectedSha256)) as unknown;
    } catch (error) {
      if (readCode(error)) throw error;
      throw artifactError("GROWTH_EDITORIAL_ARTIFACT_JSON_INVALID");
    }
  }

  #put(content: string, extension: "md" | "json"): GrowthEditorialStoredArtifact {
    const contentSha256 = sha256(content);
    const fileName = `${contentSha256}.${extension}`;
    const destination = path.join(this.#artifactRoot, fileName);
    fs.mkdirSync(this.#artifactRoot, { recursive: true });
    if (fs.existsSync(destination)) {
      if (sha256(fs.readFileSync(destination, "utf8")) !== contentSha256) {
        throw artifactError("GROWTH_EDITORIAL_ARTIFACT_INTEGRITY_FAILED");
      }
      return { storeRef: storeRef(contentSha256, extension), contentSha256 };
    }

    const temporary = path.join(this.#artifactRoot, `.${fileName}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
      try {
        fs.renameSync(temporary, destination);
      } catch (error) {
        if (!fs.existsSync(destination)) throw error;
        fs.rmSync(temporary, { force: true });
      }
      if (sha256(fs.readFileSync(destination, "utf8")) !== contentSha256) {
        throw artifactError("GROWTH_EDITORIAL_ARTIFACT_INTEGRITY_FAILED");
      }
      return { storeRef: storeRef(contentSha256, extension), contentSha256 };
    } catch (error) {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      if (readCode(error)) throw error;
      throw artifactError("GROWTH_EDITORIAL_ARTIFACT_PERSISTENCE_FAILED");
    }
  }

  #resolve(reference: string): { path: string; sha256: string; extension: "md" | "json" } {
    const match = artifactReference.exec(reference);
    if (!match) throw artifactError("GROWTH_EDITORIAL_ARTIFACT_REF_INVALID");
    const sha = match[1]!;
    const extension = match[2] as "md" | "json";
    const resolved = path.resolve(this.#artifactRoot, `${sha}.${extension}`);
    if (path.dirname(resolved) !== this.#artifactRoot) throw artifactError("GROWTH_EDITORIAL_ARTIFACT_REF_INVALID");
    return { path: resolved, sha256: sha, extension };
  }
}

function storeRef(contentSha256: string, extension: "md" | "json"): string {
  return `novax-artifact://growth-editorial/sha256/${contentSha256}.${extension}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error ? String(error.code) : null;
}

function artifactError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
