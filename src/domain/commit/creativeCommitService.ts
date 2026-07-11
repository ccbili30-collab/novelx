import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { CreativeCommitRepository, type CreativeCommitEntry, type CreativeCommitRecord } from "./creativeCommitRepository";

type UnnumberedEntry = Omit<CreativeCommitEntry, "ordinal">;

export class CreativeCommitService {
  readonly #repository: CreativeCommitRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#repository = new CreativeCommitRepository(workspace);
  }

  sealCheckpoint(checkpointId: string): CreativeCommitRecord {
    const existing = this.#repository.getRequired(checkpointId);
    const entries = this.#discoverEntries(checkpointId, existing.sourceChangeSetId);
    const manifestSha256 = manifestHash(entries);
    if (existing.sealedAt) {
      if (existing.manifestSha256 !== manifestSha256 || manifestHash(existing.entries.map(withoutOrdinal)) !== manifestSha256) {
        throw serviceError("CREATIVE_COMMIT_MANIFEST_MISMATCH", "Sealed Creative Commit no longer matches canonical artifacts.");
      }
      return existing;
    }
    this.#repository.replaceUnsealedEntries(checkpointId, entries);
    this.#repository.seal(checkpointId, manifestSha256);
    return this.#repository.getRequired(checkpointId);
  }

  verify(commitId: string): { commit: CreativeCommitRecord; actualManifestSha256: string; matches: boolean } {
    const commit = this.#repository.getRequired(commitId);
    const actualManifestSha256 = manifestHash(this.#discoverEntries(commitId, commit.sourceChangeSetId));
    return {
      commit,
      actualManifestSha256,
      matches: commit.sealedAt !== null
        && commit.manifestSha256 === actualManifestSha256
        && manifestHash(commit.entries.map(withoutOrdinal)) === actualManifestSha256,
    };
  }

  #discoverEntries(checkpointId: string, changeSetId: string | null): UnnumberedEntry[] {
    const entries = new Map<string, UnnumberedEntry>();
    if (changeSetId) {
      const outputs = this.workspace.db.prepare(`
        SELECT item_id, output_kind, output_id, output_sha256
        FROM change_set_outputs WHERE change_set_id = ? ORDER BY item_id
      `).all(changeSetId) as Array<{ item_id: string; output_kind: string; output_id: string; output_sha256: string }>;
      for (const output of outputs) add(entries, {
        artifactKind: output.output_kind,
        artifactId: output.output_id,
        artifactSha256: output.output_sha256,
        sourceItemId: output.item_id,
      });
    }

    this.#addRows(entries, checkpointId, "resource_revisions", "resource_revision");
    this.#addRows(entries, checkpointId, "document_versions", "document_version", "content_hash");
    this.#addRows(entries, checkpointId, "assertion_versions", "assertion_version");
    this.#addRows(entries, checkpointId, "creative_document_revisions", "creative_document_revision");
    this.#addRows(entries, checkpointId, "creative_relation_versions", "creative_relation_revision");
    this.#addRows(entries, checkpointId, "constraint_profile_versions", "constraint_profile_version", "payload_hash");
    return [...entries.values()].sort(compareEntries);
  }

  #addRows(
    entries: Map<string, UnnumberedEntry>,
    checkpointId: string,
    table: string,
    artifactKind: string,
    storedHashColumn?: string,
  ): void {
    const rows = this.workspace.db.prepare(`SELECT * FROM ${table} WHERE created_checkpoint_id = ? ORDER BY id`).all(checkpointId) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const artifactId = row.id;
      if (typeof artifactId !== "string") throw serviceError("CREATIVE_COMMIT_ARTIFACT_INVALID", `Invalid artifact id in ${table}.`);
      const storedHash = storedHashColumn ? row[storedHashColumn] : null;
      const artifactSha256 = typeof storedHash === "string" ? storedHash : canonicalAuditHash(normalizeRow(row));
      add(entries, { artifactKind, artifactId, artifactSha256, sourceItemId: null });
    }
  }
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "created_at"));
}

function add(entries: Map<string, UnnumberedEntry>, entry: UnnumberedEntry): void {
  const key = `${entry.artifactKind}:${entry.artifactId}`;
  const existing = entries.get(key);
  if (existing?.sourceItemId) return;
  if (existing && existing.artifactSha256 !== entry.artifactSha256) {
    throw serviceError("CREATIVE_COMMIT_ARTIFACT_HASH_CONFLICT", "Artifact hashes conflict while sealing Creative Commit.");
  }
  entries.set(key, existing?.sourceItemId ? existing : entry);
}

function compareEntries(left: UnnumberedEntry, right: UnnumberedEntry): number {
  return left.artifactKind.localeCompare(right.artifactKind) || left.artifactId.localeCompare(right.artifactId);
}

function manifestHash(entries: readonly UnnumberedEntry[]): string {
  return canonicalAuditHash(entries.map((entry) => ({
    artifactKind: entry.artifactKind,
    artifactId: entry.artifactId,
    artifactSha256: entry.artifactSha256,
    sourceItemId: entry.sourceItemId,
  })));
}

function withoutOrdinal(entry: CreativeCommitEntry): UnnumberedEntry {
  return {
    artifactKind: entry.artifactKind,
    artifactId: entry.artifactId,
    artifactSha256: entry.artifactSha256,
    sourceItemId: entry.sourceItemId,
  };
}

function serviceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
