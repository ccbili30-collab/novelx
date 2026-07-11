import { createHash, randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { WorkspaceDatabase } from "./workspaceRepository";
import { CheckpointRepository } from "../version/checkpointRepository";

export interface DocumentVersionRecord {
  id: string;
  resourceId: string;
  creativeDocumentId: string | null;
  checkpointId: string;
  content: string;
  contentHash: string;
  authorKind: "user" | "agent" | "import";
}

export interface WorkingDocumentRecord {
  resourceId: string;
  baseVersionId: string | null;
  content: string;
  contentHash: string;
  editRevision: number;
  dirty: boolean;
}

export interface WorkingCreativeDocumentRecord {
  documentId: string;
  baseVersionId: string | null;
  content: string;
  contentHash: string;
  editRevision: number;
  dirty: boolean;
}

export interface SaveWorkingCopyInput {
  resourceId: string;
  content: string;
  expectedRevision?: number;
  expectedStableVersionId?: string | null;
}

export class DocumentRepository {
  readonly #checkpoints: CheckpointRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#checkpoints = new CheckpointRepository(workspace);
  }

  putVersion(input: {
    resourceId: string;
    creativeDocumentId?: string;
    checkpointId: string;
    content: string;
    authorKind: DocumentVersionRecord["authorKind"];
  }): string {
    requireRow(this.workspace.db.prepare("SELECT id FROM resources WHERE id = ?").get(input.resourceId), "RESOURCE_NOT_FOUND");
    if (input.creativeDocumentId) {
      const owner = this.workspace.db.prepare(`
        SELECT resource_id FROM creative_document_revisions
        WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(input.creativeDocumentId) as { resource_id: string } | undefined;
      requireRow(owner, "CREATIVE_DOCUMENT_NOT_FOUND");
      if (owner?.resource_id !== input.resourceId) {
        throw repositoryError("CREATIVE_DOCUMENT_OWNER_MISMATCH", "The document does not belong to the supplied resource.");
      }
    }
    requireRow(this.workspace.db.prepare("SELECT id FROM checkpoints WHERE id = ?").get(input.checkpointId), "CHECKPOINT_NOT_FOUND");
    const id = randomUUID();
    this.workspace.db.prepare(`
      INSERT INTO document_versions (
        id, resource_id, creative_document_id, created_checkpoint_id, content, content_hash, author_kind, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.resourceId,
      input.creativeDocumentId ?? null,
      input.checkpointId,
      input.content,
      hashContent(input.content),
      input.authorKind,
      new Date().toISOString(),
    );
    return id;
  }

  getCurrentStable(resourceId: string, branchId = this.#checkpoints.getActiveBranch().id): DocumentVersionRecord | null {
    const row = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT head_checkpoint_id, 0 FROM branches WHERE id = ?
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      )
      SELECT dv.* FROM document_versions dv
      JOIN ancestry ON ancestry.checkpoint_id = dv.created_checkpoint_id
      WHERE dv.resource_id = ?
      ORDER BY ancestry.depth ASC, dv.created_at DESC, dv.rowid DESC
      LIMIT 1
    `).get(branchId, resourceId);
    return row ? mapVersion(row) : null;
  }

  getStableAtCheckpoint(resourceId: string, checkpointId: string): DocumentVersionRecord | null {
    return this.getStableByAnchor("resource_id", resourceId, checkpointId);
  }

  getCurrentStableForCreativeDocument(
    documentId: string,
    branchId = this.#checkpoints.getActiveBranch().id,
  ): DocumentVersionRecord | null {
    const row = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT head_checkpoint_id, 0 FROM branches WHERE id = ?
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      )
      SELECT dv.* FROM document_versions dv
      JOIN ancestry ON ancestry.checkpoint_id = dv.created_checkpoint_id
      WHERE dv.creative_document_id = ?
      ORDER BY ancestry.depth ASC, dv.created_at DESC, dv.rowid DESC
      LIMIT 1
    `).get(branchId, documentId);
    return row ? mapVersion(row) : null;
  }

  getStableForCreativeDocumentAtCheckpoint(documentId: string, checkpointId: string): DocumentVersionRecord | null {
    return this.getStableByAnchor("creative_document_id", documentId, checkpointId);
  }

  private getStableByAnchor(column: "resource_id" | "creative_document_id", id: string, checkpointId: string): DocumentVersionRecord | null {
    const row = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id WHERE c.parent_checkpoint_id IS NOT NULL
      )
      SELECT dv.* FROM document_versions dv JOIN ancestry ON ancestry.checkpoint_id = dv.created_checkpoint_id
      WHERE dv.${column} = ? ORDER BY ancestry.depth ASC, dv.created_at DESC, dv.rowid DESC LIMIT 1
    `).get(checkpointId, id);
    return row ? mapVersion(row) : null;
  }

  saveWorkingCopy(input: SaveWorkingCopyInput): WorkingDocumentRecord {
    requireRow(this.workspace.db.prepare("SELECT id FROM resources WHERE id = ?").get(input.resourceId), "RESOURCE_NOT_FOUND");
    const branch = this.#checkpoints.getActiveBranch();
    const stable = this.getCurrentStable(input.resourceId, branch.id);
    const existing = this.getWorkingCopy(input.resourceId, branch.id);
    const currentRevision = existing?.editRevision ?? 0;
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw repositoryError("DOCUMENT_EDIT_CONFLICT", "The document changed after this editor snapshot was loaded.");
    }
    if (!existing
      && input.expectedStableVersionId !== undefined
      && input.expectedStableVersionId !== (stable?.id ?? null)) {
      throw repositoryError("DOCUMENT_BASE_CHANGED", "The stable document changed before the working copy was created.");
    }
    const baseVersionId = existing ? existing.baseVersionId : (stable?.id ?? null);
    const baseVersion = baseVersionId ? this.getVersion(baseVersionId) : null;
    const contentHash = hashContent(input.content);
    const dirty = baseVersion ? baseVersion.contentHash !== contentHash : true;
    const result = this.workspace.db.prepare(`
      INSERT INTO working_documents (
        branch_id, resource_id, base_version_id, content, content_hash, edit_revision, dirty, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(branch_id, resource_id) DO UPDATE SET
        content = excluded.content,
        content_hash = excluded.content_hash,
        edit_revision = working_documents.edit_revision + 1,
        dirty = excluded.dirty,
        updated_at = excluded.updated_at
      WHERE working_documents.edit_revision = ?
    `).run(
      branch.id,
      input.resourceId,
      baseVersionId,
      input.content,
      contentHash,
      dirty ? 1 : 0,
      new Date().toISOString(),
      input.expectedRevision ?? currentRevision,
    );
    if (result.changes !== 1) {
      throw repositoryError("DOCUMENT_EDIT_CONFLICT", "The document changed before the working copy could be saved.");
    }
    return this.getWorkingCopy(input.resourceId)!;
  }

  markWorkingCopyStable(input: {
    resourceId: string;
    versionId: string;
    expectedRevision: number;
  }): void {
    const branch = this.#checkpoints.getActiveBranch();
    const version = this.getVersion(input.versionId);
    requireRow(version, "DOCUMENT_VERSION_NOT_FOUND");
    if (version?.resourceId !== input.resourceId) {
      throw repositoryError("DOCUMENT_VERSION_RESOURCE_MISMATCH", "The stable version belongs to another resource.");
    }
    const result = this.workspace.db.prepare(`
      UPDATE working_documents
      SET base_version_id = ?, dirty = 0, updated_at = ?
      WHERE branch_id = ? AND resource_id = ? AND edit_revision = ?
    `).run(input.versionId, new Date().toISOString(), branch.id, input.resourceId, input.expectedRevision);
    if (result.changes !== 1) {
      throw repositoryError("DOCUMENT_EDIT_CONFLICT", "The document changed before it could be marked stable.");
    }
  }

  getWorkingCopy(resourceId: string, branchId = this.#checkpoints.getActiveBranch().id): WorkingDocumentRecord | null {
    const row = this.workspace.db.prepare("SELECT * FROM working_documents WHERE branch_id = ? AND resource_id = ?")
      .get(branchId, resourceId);
    if (!row) return null;
    return {
      resourceId: readString(row, "resource_id"),
      baseVersionId: readNullableString(row, "base_version_id"),
      content: readString(row, "content"),
      contentHash: readString(row, "content_hash"),
      editRevision: readNumber(row, "edit_revision"),
      dirty: readNumber(row, "dirty") === 1,
    };
  }

  saveWorkingCreativeCopy(input: {
    documentId: string;
    content: string;
    expectedRevision?: number;
    expectedStableVersionId?: string | null;
  }): WorkingCreativeDocumentRecord {
    requireRow(this.workspace.db.prepare("SELECT id FROM creative_documents WHERE id = ?").get(input.documentId), "CREATIVE_DOCUMENT_NOT_FOUND");
    const branch = this.#checkpoints.getActiveBranch();
    const stable = this.getCurrentStableForCreativeDocument(input.documentId, branch.id);
    const existing = this.getWorkingCreativeCopy(input.documentId, branch.id);
    const currentRevision = existing?.editRevision ?? 0;
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw repositoryError("DOCUMENT_EDIT_CONFLICT", "The document changed after this editor snapshot was loaded.");
    }
    if (!existing
      && input.expectedStableVersionId !== undefined
      && input.expectedStableVersionId !== (stable?.id ?? null)) {
      throw repositoryError("DOCUMENT_BASE_CHANGED", "The stable document changed before the working copy was created.");
    }
    const baseVersionId = existing ? existing.baseVersionId : (stable?.id ?? null);
    const baseVersion = baseVersionId ? this.getVersion(baseVersionId) : null;
    const contentHash = hashContent(input.content);
    const dirty = baseVersion ? baseVersion.contentHash !== contentHash : true;
    const result = this.workspace.db.prepare(`
      INSERT INTO working_creative_documents (
        branch_id, document_id, base_version_id, content, content_hash, edit_revision, dirty, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(branch_id, document_id) DO UPDATE SET
        content = excluded.content,
        content_hash = excluded.content_hash,
        edit_revision = working_creative_documents.edit_revision + 1,
        dirty = excluded.dirty,
        updated_at = excluded.updated_at
      WHERE working_creative_documents.edit_revision = ?
    `).run(
      branch.id,
      input.documentId,
      baseVersionId,
      input.content,
      contentHash,
      dirty ? 1 : 0,
      new Date().toISOString(),
      input.expectedRevision ?? currentRevision,
    );
    if (result.changes !== 1) {
      throw repositoryError("DOCUMENT_EDIT_CONFLICT", "The document changed before the working copy could be saved.");
    }
    return this.getWorkingCreativeCopy(input.documentId)!;
  }

  getWorkingCreativeCopy(
    documentId: string,
    branchId = this.#checkpoints.getActiveBranch().id,
  ): WorkingCreativeDocumentRecord | null {
    const row = this.workspace.db.prepare("SELECT * FROM working_creative_documents WHERE branch_id = ? AND document_id = ?")
      .get(branchId, documentId);
    if (!row) return null;
    return {
      documentId: readString(row, "document_id"),
      baseVersionId: readNullableString(row, "base_version_id"),
      content: readString(row, "content"),
      contentHash: readString(row, "content_hash"),
      editRevision: readNumber(row, "edit_revision"),
      dirty: readNumber(row, "dirty") === 1,
    };
  }

  discardWorkingCreativeCopy(input: { documentId: string; expectedRevision: number }): void {
    const branch = this.#checkpoints.getActiveBranch();
    const result = this.workspace.db.prepare(`
      DELETE FROM working_creative_documents
      WHERE branch_id = ? AND document_id = ? AND edit_revision = ?
    `).run(branch.id, input.documentId, input.expectedRevision);
    if (result.changes !== 1) {
      throw repositoryError("DOCUMENT_EDIT_CONFLICT", "The document changed before the working copy could be discarded.");
    }
  }

  markWorkingCreativeCopyStable(input: {
    documentId: string;
    versionId: string;
    expectedRevision: number;
  }): void {
    const branch = this.#checkpoints.getActiveBranch();
    const version = this.getVersion(input.versionId);
    requireRow(version, "DOCUMENT_VERSION_NOT_FOUND");
    if (version?.creativeDocumentId !== input.documentId) {
      throw repositoryError("DOCUMENT_VERSION_RESOURCE_MISMATCH", "The stable version belongs to another creative document.");
    }
    const result = this.workspace.db.prepare(`
      UPDATE working_creative_documents
      SET base_version_id = ?, dirty = 0, updated_at = ?
      WHERE branch_id = ? AND document_id = ? AND edit_revision = ?
    `).run(input.versionId, new Date().toISOString(), branch.id, input.documentId, input.expectedRevision);
    if (result.changes !== 1) {
      throw repositoryError("DOCUMENT_EDIT_CONFLICT", "The document changed before it could be marked stable.");
    }
  }

  getVersion(versionId: string): DocumentVersionRecord | null {
    const row = this.workspace.db.prepare("SELECT * FROM document_versions WHERE id = ?").get(versionId);
    return row ? mapVersion(row) : null;
  }
}

function mapVersion(row: Record<string, SQLOutputValue>): DocumentVersionRecord {
  const authorKind = readString(row, "author_kind");
  if (authorKind !== "user" && authorKind !== "agent" && authorKind !== "import") {
    throw repositoryError("DOCUMENT_AUTHOR_INVALID", "Document author kind is invalid.");
  }
  return {
    id: readString(row, "id"),
    resourceId: readString(row, "resource_id"),
    creativeDocumentId: readNullableString(row, "creative_document_id"),
    checkpointId: readString(row, "created_checkpoint_id"),
    content: readString(row, "content"),
    contentHash: readString(row, "content_hash"),
    authorKind,
  };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function requireRow(row: unknown, code: string): void {
  if (!row) throw repositoryError(code, "Required workspace record was not found.");
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

function readNumber(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw repositoryError("WORKSPACE_DATA_INVALID", `Expected number column: ${key}`);
  return value;
}

function repositoryError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
