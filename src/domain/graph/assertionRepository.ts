import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { CheckpointRepository } from "../version/checkpointRepository";

export interface AssertionRecord {
  versionId: string;
  assertionId: string;
  checkpointId: string;
  scopeType: string;
  scopeId: string;
  subject: string;
  predicate: string;
  object: Record<string, unknown>;
  status: "current" | "conflict" | "superseded" | "rejected" | "draft";
}

export interface StoredAssertionSource {
  kind: string;
  ref: string;
}

export interface SourcedAssertionRecord extends AssertionRecord {
  sources: StoredAssertionSource[];
}

interface PutAssertionInput extends Omit<AssertionRecord, "versionId" | "object"> {
  object: Record<string, unknown>;
  source?: { kind: string; ref: string };
  sources?: Array<{ kind: string; ref: string }>;
}

export class AssertionRepository {
  readonly #checkpoints: CheckpointRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#checkpoints = new CheckpointRepository(workspace);
  }

  putVersion(input: PutAssertionInput): string {
    const checkpoint = this.workspace.db.prepare("SELECT id FROM checkpoints WHERE id = ?").get(input.checkpointId);
    if (!checkpoint) throw repositoryError("CHECKPOINT_NOT_FOUND", "Checkpoint not found.");
    const versionId = randomUUID();
    const sources = input.sources ?? (input.source ? [input.source] : []);
    if (sources.length === 0) throw repositoryError("ASSERTION_SOURCE_REQUIRED", "Assertion source is required.");
    const now = new Date().toISOString();
    this.workspace.db.prepare(`
      INSERT INTO assertion_versions (
        id, assertion_id, created_checkpoint_id, scope_type, scope_id,
        subject, predicate, object_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      versionId,
      input.assertionId,
      input.checkpointId,
      input.scopeType,
      input.scopeId,
      input.subject,
      input.predicate,
      JSON.stringify(input.object),
      input.status,
      now,
    );
    const insertSource = this.workspace.db.prepare("INSERT INTO source_records (id, kind, ref, created_at) VALUES (?, ?, ?, ?)");
    const linkSource = this.workspace.db.prepare("INSERT INTO assertion_sources (assertion_version_id, source_id) VALUES (?, ?)");
    for (const source of sources) {
      const sourceId = randomUUID();
      insertSource.run(sourceId, source.kind, source.ref, now);
      linkSource.run(versionId, sourceId);
    }
    return versionId;
  }

  listCurrent(branchId = this.#checkpoints.getActiveBranch().id): AssertionRecord[] {
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT head_checkpoint_id, 0 FROM branches WHERE id = ?
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1
        FROM checkpoints c JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT av.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY av.assertion_id ORDER BY ancestry.depth ASC) AS version_rank
        FROM assertion_versions av
        JOIN ancestry ON ancestry.checkpoint_id = av.created_checkpoint_id
      )
      SELECT * FROM ranked WHERE version_rank = 1 AND status = 'current' ORDER BY subject, predicate
    `).all(branchId);
    return rows.map(mapAssertion);
  }

  listCurrentInScopes(scopeResourceIds: readonly string[], branchId = this.#checkpoints.getActiveBranch().id): SourcedAssertionRecord[] {
    const scopeIds = [...new Set(scopeResourceIds.map((scopeId) => scopeId.trim()).filter(Boolean))];
    if (scopeIds.length === 0) return [];
    const placeholders = scopeIds.map(() => "?").join(", ");
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT head_checkpoint_id, 0 FROM branches WHERE id = ?
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1
        FROM checkpoints c JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT av.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY av.assertion_id ORDER BY ancestry.depth ASC) AS version_rank
        FROM assertion_versions av
        JOIN ancestry ON ancestry.checkpoint_id = av.created_checkpoint_id
      ), current_assertions AS (
        SELECT * FROM ranked
        WHERE version_rank = 1 AND status = 'current' AND scope_id IN (${placeholders})
      )
      SELECT current_assertions.*, sr.kind AS source_kind, sr.ref AS source_ref
      FROM current_assertions
      LEFT JOIN assertion_sources linked ON linked.assertion_version_id = current_assertions.id
      LEFT JOIN source_records sr ON sr.id = linked.source_id
      ORDER BY current_assertions.subject, current_assertions.predicate, current_assertions.assertion_id, sr.id
    `).all(branchId, ...scopeIds);
    return mapSourcedAssertions(rows);
  }

  listLatestForGraph(branchId = this.#checkpoints.getActiveBranch().id): SourcedAssertionRecord[] {
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT head_checkpoint_id, 0 FROM branches WHERE id = ?
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1
        FROM checkpoints c JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT av.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY av.assertion_id ORDER BY ancestry.depth ASC) AS version_rank
        FROM assertion_versions av
        JOIN ancestry ON ancestry.checkpoint_id = av.created_checkpoint_id
      ), graph_assertions AS (
        SELECT * FROM ranked
        WHERE version_rank = 1 AND status IN ('current', 'conflict')
      )
      SELECT graph_assertions.*, sr.kind AS source_kind, sr.ref AS source_ref
      FROM graph_assertions
      LEFT JOIN assertion_sources linked ON linked.assertion_version_id = graph_assertions.id
      LEFT JOIN source_records sr ON sr.id = linked.source_id
      ORDER BY graph_assertions.scope_type, graph_assertions.scope_id,
        graph_assertions.subject, graph_assertions.predicate, graph_assertions.assertion_id, sr.id
    `).all(branchId);
    return mapSourcedAssertions(rows);
  }

  listHistory(assertionId: string): AssertionRecord[] {
    const rows = this.workspace.db.prepare(`
      SELECT av.* FROM assertion_versions av
      JOIN checkpoints c ON c.id = av.created_checkpoint_id
      WHERE av.assertion_id = ? ORDER BY c.created_at, c.sequence
    `).all(assertionId);
    return rows.map(mapAssertion);
  }
}

function mapSourcedAssertions(rows: Record<string, SQLOutputValue>[]): SourcedAssertionRecord[] {
  const byVersionId = new Map<string, SourcedAssertionRecord>();
  for (const row of rows) {
    const versionId = readString(row, "id");
    let assertion = byVersionId.get(versionId);
    if (!assertion) {
      assertion = { ...mapAssertion(row), sources: [] };
      byVersionId.set(versionId, assertion);
    }
    const kind = readNullableString(row, "source_kind");
    const ref = readNullableString(row, "source_ref");
    if (kind !== null && ref !== null) assertion.sources.push({ kind, ref });
  }
  return [...byVersionId.values()];
}

function mapAssertion(row: Record<string, SQLOutputValue>): AssertionRecord {
  const status = readString(row, "status");
  if (!isAssertionStatus(status)) throw repositoryError("ASSERTION_STATUS_INVALID", "Assertion status is invalid.");
  return {
    versionId: readString(row, "id"),
    assertionId: readString(row, "assertion_id"),
    checkpointId: readString(row, "created_checkpoint_id"),
    scopeType: readString(row, "scope_type"),
    scopeId: readString(row, "scope_id"),
    subject: readString(row, "subject"),
    predicate: readString(row, "predicate"),
    object: parseObject(readString(row, "object_json")),
    status,
  };
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw repositoryError("WORKSPACE_DATA_INVALID", `Expected string column: ${key}`);
  return value;
}

function readNullableString(row: Record<string, SQLOutputValue>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw repositoryError("WORKSPACE_DATA_INVALID", `Expected nullable string column: ${key}`);
  return value;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw repositoryError("ASSERTION_OBJECT_INVALID", "Assertion object is invalid.");
  }
  return parsed as Record<string, unknown>;
}

function isAssertionStatus(value: string): value is AssertionRecord["status"] {
  return ["current", "conflict", "superseded", "rejected", "draft"].includes(value);
}

function repositoryError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
