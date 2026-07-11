import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export interface ImportJobRecord {
  id: string;
  sourceId: string;
  kind: "parse" | "decompose";
  attempt: number;
  status: "running" | "succeeded" | "failed";
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export class ImportJobRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  start(sourceId: string, kind: ImportJobRecord["kind"]): ImportJobRecord {
    const attempt = this.workspace.db.prepare(`
      SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM import_jobs WHERE source_id = ? AND kind = ?
    `).get(sourceId, kind) as { attempt: number };
    const id = randomUUID();
    this.workspace.db.prepare(`
      INSERT INTO import_jobs (id, source_id, kind, attempt, status, error_code, started_at, finished_at)
      VALUES (?, ?, ?, ?, 'running', NULL, ?, NULL)
    `).run(id, sourceId, kind, attempt.attempt, new Date().toISOString());
    return this.getRequired(id);
  }

  succeed(id: string): ImportJobRecord { return this.finish(id, "succeeded", null); }
  fail(id: string, errorCode: string): ImportJobRecord { return this.finish(id, "failed", errorCode.slice(0, 120)); }

  getRequired(id: string): ImportJobRecord {
    const row = this.workspace.db.prepare("SELECT * FROM import_jobs WHERE id = ?").get(id);
    if (!row) throw jobError("IMPORT_JOB_NOT_FOUND");
    return mapJob(row);
  }

  private finish(id: string, status: "succeeded" | "failed", errorCode: string | null): ImportJobRecord {
    const result = this.workspace.db.prepare(`
      UPDATE import_jobs SET status = ?, error_code = ?, finished_at = ? WHERE id = ? AND status = 'running'
    `).run(status, errorCode, new Date().toISOString(), id);
    if (result.changes !== 1) throw jobError("IMPORT_JOB_NOT_RUNNING");
    return this.getRequired(id);
  }
}

function mapJob(row: Record<string, SQLOutputValue>): ImportJobRecord {
  return { id: String(row.id), sourceId: String(row.source_id), kind: String(row.kind) as ImportJobRecord["kind"], attempt: Number(row.attempt),
    status: String(row.status) as ImportJobRecord["status"], errorCode: row.error_code === null ? null : String(row.error_code),
    startedAt: String(row.started_at), finishedAt: row.finished_at === null ? null : String(row.finished_at) };
}

function jobError(code: string): Error & { code: string } { return Object.assign(new Error("Import job operation failed."), { code }); }
