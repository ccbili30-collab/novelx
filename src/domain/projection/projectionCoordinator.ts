import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import { CreativeCommitRepository, type CreativeCommitRecord } from "../commit/creativeCommitRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export interface ProjectionResult {
  outputSha256: string;
}

export interface CreativeProjector {
  readonly kind: string;
  inputSha256(commit: CreativeCommitRecord): string;
  project(commit: CreativeCommitRecord): ProjectionResult;
}

export interface ProjectionRunRecord {
  id: string;
  commitId: string;
  projectionKind: string;
  attempt: number;
  status: "running" | "succeeded" | "failed";
  inputSha256: string;
  outputSha256: string | null;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export class ProjectionCoordinator {
  readonly #commits: CreativeCommitRepository;

  constructor(readonly workspace: WorkspaceDatabase, readonly projectors: readonly CreativeProjector[]) {
    this.#commits = new CreativeCommitRepository(workspace);
  }

  runAll(commitId: string): ProjectionRunRecord[] {
    const commit = this.#commits.getRequired(commitId);
    if (!commit.sealedAt || !commit.manifestSha256) {
      throw projectionError("CREATIVE_COMMIT_UNSEALED", "Creative Commit must be sealed before projection.");
    }
    return this.projectors.map((projector) => this.#run(commit, projector));
  }

  replay(commitId: string, projectionKind: string): ProjectionRunRecord {
    const projector = this.projectors.find((candidate) => candidate.kind === projectionKind);
    if (!projector) throw projectionError("PROJECTION_KIND_NOT_REGISTERED", "Projection kind is not registered.");
    const commit = this.#commits.getRequired(commitId);
    if (!commit.sealedAt || !commit.manifestSha256) throw projectionError("CREATIVE_COMMIT_UNSEALED", "Creative Commit must be sealed before projection.");
    return this.#run(commit, projector);
  }

  listRuns(commitId: string): ProjectionRunRecord[] {
    return this.workspace.db.prepare(`
      SELECT * FROM projection_runs WHERE commit_id = ? ORDER BY projection_kind, attempt
    `).all(commitId).map(mapRun);
  }

  #run(commit: CreativeCommitRecord, projector: CreativeProjector): ProjectionRunRecord {
    const inputSha256 = projector.inputSha256(commit);
    const attemptRow = this.workspace.db.prepare(`
      SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
      FROM projection_runs WHERE commit_id = ? AND projection_kind = ?
    `).get(commit.id, projector.kind) as { attempt: number };
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    this.workspace.db.prepare(`
      INSERT INTO projection_runs (
        id, commit_id, projection_kind, attempt, status, input_sha256,
        output_sha256, error_code, started_at, finished_at
      ) VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, ?, NULL)
    `).run(id, commit.id, projector.kind, attemptRow.attempt, inputSha256, startedAt);
    try {
      const output = projector.project(commit);
      this.workspace.db.prepare(`
        UPDATE projection_runs SET status = 'succeeded', output_sha256 = ?, finished_at = ? WHERE id = ?
      `).run(output.outputSha256, new Date().toISOString(), id);
    } catch (error) {
      this.workspace.db.prepare(`
        UPDATE projection_runs SET status = 'failed', error_code = ?, finished_at = ? WHERE id = ?
      `).run(publicErrorCode(error), new Date().toISOString(), id);
    }
    return this.#getRun(id);
  }

  #getRun(id: string): ProjectionRunRecord {
    const row = this.workspace.db.prepare("SELECT * FROM projection_runs WHERE id = ?").get(id);
    if (!row) throw projectionError("PROJECTION_RUN_NOT_FOUND", "Projection run was not found.");
    return mapRun(row);
  }
}

export function projectionInputHash(input: unknown): string {
  return canonicalAuditHash(input);
}

function mapRun(row: Record<string, SQLOutputValue>): ProjectionRunRecord {
  const status = readString(row, "status");
  const attempt = row.attempt;
  if (!["running", "succeeded", "failed"].includes(status) || typeof attempt !== "number") {
    throw projectionError("PROJECTION_RUN_DATA_INVALID", "Projection run data is invalid.");
  }
  return {
    id: readString(row, "id"),
    commitId: readString(row, "commit_id"),
    projectionKind: readString(row, "projection_kind"),
    attempt,
    status: status as ProjectionRunRecord["status"],
    inputSha256: readString(row, "input_sha256"),
    outputSha256: readNullableString(row, "output_sha256"),
    errorCode: readNullableString(row, "error_code"),
    startedAt: readString(row, "started_at"),
    finishedAt: readNullableString(row, "finished_at"),
  };
}

function publicErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 120);
  }
  return "PROJECTION_EXECUTION_FAILED";
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw projectionError("PROJECTION_RUN_DATA_INVALID", `Expected string column: ${key}`);
  return value;
}

function readNullableString(row: Record<string, SQLOutputValue>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw projectionError("PROJECTION_RUN_DATA_INVALID", `Expected nullable string column: ${key}`);
  return value;
}

function projectionError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
