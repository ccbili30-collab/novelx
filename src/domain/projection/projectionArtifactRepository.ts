import type { SQLOutputValue } from "node:sqlite";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export interface ProjectionArtifactRecord {
  runId: string;
  artifactKey: string;
  payload: unknown;
  sourceRefs: string[];
  artifactSha256: string;
  createdAt: string;
}

export class ProjectionArtifactRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  append(input: { runId: string; artifactKey: string; payload: unknown; sourceRefs: readonly string[] }): ProjectionArtifactRecord {
    const artifactKey = input.artifactKey.trim();
    if (!artifactKey || artifactKey.length > 500) throw artifactError("PROJECTION_ARTIFACT_KEY_INVALID");
    const sourceRefs = [...new Set(input.sourceRefs.map((value) => value.trim()).filter(Boolean))].sort();
    const payloadJson = canonicalJson(input.payload);
    const sourceRefsJson = canonicalJson(sourceRefs);
    const artifactSha256 = canonicalAuditHash({ artifactKey, payload: input.payload, sourceRefs });
    const createdAt = new Date().toISOString();
    this.workspace.db.prepare(`
      INSERT INTO projection_artifacts (
        run_id, artifact_key, payload_json, source_refs_json, artifact_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.runId, artifactKey, payloadJson, sourceRefsJson, artifactSha256, createdAt);
    return { runId: input.runId, artifactKey, payload: input.payload, sourceRefs, artifactSha256, createdAt };
  }

  listForRun(runId: string): ProjectionArtifactRecord[] {
    return this.workspace.db.prepare(`
      SELECT * FROM projection_artifacts WHERE run_id = ? ORDER BY artifact_key
    `).all(runId).map(mapArtifact);
  }
}

function mapArtifact(row: Record<string, SQLOutputValue>): ProjectionArtifactRecord {
  return {
    runId: readString(row, "run_id"),
    artifactKey: readString(row, "artifact_key"),
    payload: JSON.parse(readString(row, "payload_json")) as unknown,
    sourceRefs: JSON.parse(readString(row, "source_refs_json")) as string[],
    artifactSha256: readString(row, "artifact_sha256"),
    createdAt: readString(row, "created_at"),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw artifactError("PROJECTION_ARTIFACT_PAYLOAD_INVALID");
  return encoded;
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw artifactError("PROJECTION_ARTIFACT_DATA_INVALID");
  return value;
}

function artifactError(code: string): Error & { code: string } {
  return Object.assign(new Error("Projection artifact operation failed."), { code });
}
