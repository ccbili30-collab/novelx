import type { SQLOutputValue } from "node:sqlite";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export type CreativeCommitKind = "initialization" | "manual" | "change_set" | "import" | "retcon";

export interface CreativeCommitEntry {
  ordinal: number;
  artifactKind: string;
  artifactId: string;
  artifactSha256: string;
  sourceItemId: string | null;
}

export interface CreativeCommitRecord {
  id: string;
  branchId: string;
  parentCommitId: string | null;
  kind: CreativeCommitKind;
  actorKind: "user" | "agent" | "import";
  sourceChangeSetId: string | null;
  label: string;
  manifestSha256: string | null;
  sealedAt: string | null;
  createdAt: string;
  entries: CreativeCommitEntry[];
}

export class CreativeCommitRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  createEnvelope(input: Omit<CreativeCommitRecord, "manifestSha256" | "sealedAt" | "entries">): void {
    this.workspace.db.prepare(`
      INSERT INTO creative_commits (
        id, branch_id, parent_commit_id, kind, actor_kind, source_change_set_id,
        label, manifest_sha256, sealed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(
      input.id,
      input.branchId,
      input.parentCommitId,
      input.kind,
      input.actorKind,
      input.sourceChangeSetId,
      input.label,
      input.createdAt,
    );
  }

  get(commitId: string): CreativeCommitRecord | null {
    const row = this.workspace.db.prepare("SELECT * FROM creative_commits WHERE id = ?").get(commitId);
    if (!row) return null;
    return { ...mapCommit(row), entries: this.listEntries(commitId) };
  }

  getRequired(commitId: string): CreativeCommitRecord {
    const commit = this.get(commitId);
    if (!commit) throw repositoryError("CREATIVE_COMMIT_NOT_FOUND", "Creative Commit not found.");
    return commit;
  }

  listEntries(commitId: string): CreativeCommitEntry[] {
    return this.workspace.db.prepare(`
      SELECT ordinal, artifact_kind, artifact_id, artifact_sha256, source_item_id
      FROM creative_commit_entries WHERE commit_id = ? ORDER BY ordinal
    `).all(commitId).map(mapEntry);
  }

  replaceUnsealedEntries(commitId: string, entries: readonly Omit<CreativeCommitEntry, "ordinal">[]): void {
    const commit = this.getRequired(commitId);
    if (commit.sealedAt) throw repositoryError("CREATIVE_COMMIT_ALREADY_SEALED", "Creative Commit is already sealed.");
    this.workspace.db.prepare("DELETE FROM creative_commit_entries WHERE commit_id = ?").run(commitId);
    const insert = this.workspace.db.prepare(`
      INSERT INTO creative_commit_entries (
        commit_id, ordinal, artifact_kind, artifact_id, artifact_sha256, source_item_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    entries.forEach((entry, ordinal) => insert.run(
      commitId,
      ordinal,
      entry.artifactKind,
      entry.artifactId,
      entry.artifactSha256,
      entry.sourceItemId,
    ));
  }

  seal(commitId: string, manifestSha256: string, sealedAt = new Date().toISOString()): void {
    const result = this.workspace.db.prepare(`
      UPDATE creative_commits SET manifest_sha256 = ?, sealed_at = ?
      WHERE id = ? AND sealed_at IS NULL
    `).run(manifestSha256, sealedAt, commitId);
    if (result.changes !== 1) throw repositoryError("CREATIVE_COMMIT_ALREADY_SEALED", "Creative Commit is already sealed.");
  }

  listUnsealed(): CreativeCommitRecord[] {
    return this.workspace.db.prepare(`
      SELECT * FROM creative_commits WHERE sealed_at IS NULL ORDER BY created_at, id
    `).all().map((row) => ({ ...mapCommit(row), entries: [] }));
  }

  listAll(): CreativeCommitRecord[] {
    return this.workspace.db.prepare(`
      SELECT * FROM creative_commits ORDER BY created_at, id
    `).all().map((row) => ({ ...mapCommit(row), entries: [] }));
  }
}

function mapCommit(row: Record<string, SQLOutputValue>): Omit<CreativeCommitRecord, "entries"> {
  const kind = readString(row, "kind");
  const actorKind = readString(row, "actor_kind");
  if (!isCommitKind(kind) || !isActorKind(actorKind)) throw repositoryError("CREATIVE_COMMIT_DATA_INVALID", "Creative Commit data is invalid.");
  return {
    id: readString(row, "id"),
    branchId: readString(row, "branch_id"),
    parentCommitId: readNullableString(row, "parent_commit_id"),
    kind,
    actorKind,
    sourceChangeSetId: readNullableString(row, "source_change_set_id"),
    label: readString(row, "label"),
    manifestSha256: readNullableString(row, "manifest_sha256"),
    sealedAt: readNullableString(row, "sealed_at"),
    createdAt: readString(row, "created_at"),
  };
}

function mapEntry(row: Record<string, SQLOutputValue>): CreativeCommitEntry {
  const ordinal = row.ordinal;
  if (typeof ordinal !== "number") throw repositoryError("CREATIVE_COMMIT_DATA_INVALID", "Creative Commit ordinal is invalid.");
  return {
    ordinal,
    artifactKind: readString(row, "artifact_kind"),
    artifactId: readString(row, "artifact_id"),
    artifactSha256: readString(row, "artifact_sha256"),
    sourceItemId: readNullableString(row, "source_item_id"),
  };
}

function isCommitKind(value: string): value is CreativeCommitKind {
  return ["initialization", "manual", "change_set", "import", "retcon"].includes(value);
}

function isActorKind(value: string): value is CreativeCommitRecord["actorKind"] {
  return ["user", "agent", "import"].includes(value);
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw repositoryError("CREATIVE_COMMIT_DATA_INVALID", `Expected string column: ${key}`);
  return value;
}

function readNullableString(row: Record<string, SQLOutputValue>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw repositoryError("CREATIVE_COMMIT_DATA_INVALID", `Expected nullable string column: ${key}`);
  return value;
}

function repositoryError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
