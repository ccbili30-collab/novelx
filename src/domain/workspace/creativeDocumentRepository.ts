import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import { CheckpointRepository } from "../version/checkpointRepository";
import {
  assertCreativeDocumentOwnerAllowed,
  type CreativeDocumentKind,
} from "./creativeDocumentPolicy";
import { ResourceRepository } from "./resourceRepository";
import type { WorkspaceDatabase } from "./workspaceRepository";

export type { CreativeDocumentKind } from "./creativeDocumentPolicy";

export interface CreativeDocumentRecord {
  id: string;
  resourceId: string;
  kind: CreativeDocumentKind;
  title: string;
  sortOrder: number;
}

export interface PutCreativeDocumentRevisionInput {
  documentId?: string;
  create?: boolean;
  checkpointId: string;
  resourceId: string;
  kind: CreativeDocumentKind;
  title: string;
  state: "active" | "deleted";
  sortOrder?: number;
}

export interface CreativeDocumentRevisionReceipt {
  documentId: string;
  revisionId: string;
  revisionSha256: string;
}

export class CreativeDocumentRepository {
  readonly #checkpoints: CheckpointRepository;
  readonly #resources: ResourceRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#checkpoints = new CheckpointRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
  }

  listCurrent(resourceId?: string, branchId = this.#checkpoints.getActiveBranch().id): CreativeDocumentRecord[] {
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT head_checkpoint_id, 0 FROM branches WHERE id = ?
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT cdr.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY cdr.document_id ORDER BY ancestry.depth ASC) AS revision_rank
        FROM creative_document_revisions cdr
        JOIN ancestry ON ancestry.checkpoint_id = cdr.created_checkpoint_id
      )
      SELECT document_id AS id, resource_id, kind, title, sort_order
      FROM ranked
      WHERE revision_rank = 1 AND state = 'active'
        AND (? IS NULL OR resource_id = ?)
      ORDER BY sort_order,
        CASE kind WHEN 'prose' THEN 1 WHEN 'setting' THEN 2 WHEN 'character_profile' THEN 3
          WHEN 'location_profile' THEN 4 WHEN 'faction_profile' THEN 5 WHEN 'knowledge_note' THEN 6
          WHEN 'style_guide' THEN 7 ELSE 8 END,
        title
    `).all(branchId, resourceId ?? null, resourceId ?? null);
    return rows.map(mapCreativeDocument);
  }

  listAtCheckpoint(checkpointId: string, resourceId?: string): CreativeDocumentRecord[] {
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT cdr.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY cdr.document_id ORDER BY ancestry.depth ASC) AS revision_rank
        FROM creative_document_revisions cdr JOIN ancestry ON ancestry.checkpoint_id = cdr.created_checkpoint_id
      )
      SELECT document_id AS id, resource_id, kind, title, sort_order FROM ranked
      WHERE revision_rank = 1 AND state = 'active' AND (? IS NULL OR resource_id = ?)
      ORDER BY sort_order,
        CASE kind WHEN 'prose' THEN 1 WHEN 'setting' THEN 2 WHEN 'character_profile' THEN 3
          WHEN 'location_profile' THEN 4 WHEN 'faction_profile' THEN 5 WHEN 'knowledge_note' THEN 6
          WHEN 'style_guide' THEN 7 ELSE 8 END, title
    `).all(checkpointId, resourceId ?? null, resourceId ?? null);
    return rows.map(mapCreativeDocument);
  }

  getCurrent(documentId: string, branchId = this.#checkpoints.getActiveBranch().id): CreativeDocumentRecord | null {
    return this.listCurrent(undefined, branchId).find((document) => document.id === documentId) ?? null;
  }

  putRevision(input: PutCreativeDocumentRevisionInput): string {
    return this.putRevisionWithReceipt(input).documentId;
  }

  putRevisionWithReceipt(input: PutCreativeDocumentRevisionInput): CreativeDocumentRevisionReceipt {
    requireRow(this.workspace.db.prepare("SELECT id FROM checkpoints WHERE id = ?").get(input.checkpointId), "CHECKPOINT_NOT_FOUND");
    const documentId = input.documentId ?? randomUUID();
    const identity = this.workspace.db.prepare("SELECT id FROM creative_documents WHERE id = ?").get(documentId);
    const current = input.documentId ? this.getCurrent(documentId) : null;

    if (input.documentId && !input.create && !identity) {
      throw documentError("CREATIVE_DOCUMENT_NOT_FOUND", "The creative document does not exist.");
    }
    if (input.create && identity) {
      throw documentError("CREATIVE_DOCUMENT_ALREADY_EXISTS", "The creative document already exists.");
    }
    if (current && (current.resourceId !== input.resourceId || current.kind !== input.kind)) {
      throw documentError("CREATIVE_DOCUMENT_IDENTITY_IMMUTABLE", "Document owner and kind cannot be changed.");
    }
    if (input.state === "deleted" && !current) {
      throw documentError("CREATIVE_DOCUMENT_NOT_ACTIVE", "The creative document is not active.");
    }
    if (input.state === "active") {
      const owner = this.#resources.getCurrent(input.resourceId);
      if (!owner) throw documentError("DOCUMENT_OWNER_NOT_ACTIVE", "The document owner is not active.");
      assertCreativeDocumentOwnerAllowed(input.kind, owner.objectKind);
    }

    if (!identity) this.workspace.db.prepare("INSERT INTO creative_documents (id) VALUES (?)").run(documentId);
    const revisionId = randomUUID();
    const sortOrder = input.sortOrder ?? current?.sortOrder ?? 0;
    this.workspace.db.prepare(`
      INSERT INTO creative_document_revisions (
        id, document_id, resource_id, kind, title, created_checkpoint_id, state, sort_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revisionId,
      documentId,
      input.resourceId,
      input.kind,
      input.title.trim(),
      input.checkpointId,
      input.state,
      sortOrder,
      new Date().toISOString(),
    );
    return {
      documentId,
      revisionId,
      revisionSha256: canonicalAuditHash({ documentId, ...input, sortOrder }),
    };
  }
}

function mapCreativeDocument(row: Record<string, SQLOutputValue>): CreativeDocumentRecord {
  const kind = readString(row, "kind");
  if (!isCreativeDocumentKind(kind)) throw documentError("CREATIVE_DOCUMENT_KIND_INVALID", "Creative document kind is invalid.");
  return {
    id: readString(row, "id"),
    resourceId: readString(row, "resource_id"),
    kind,
    title: readString(row, "title"),
    sortOrder: readNumber(row, "sort_order"),
  };
}

function isCreativeDocumentKind(value: string): value is CreativeDocumentKind {
  return [
    "prose", "setting", "character_profile", "location_profile", "faction_profile",
    "knowledge_note", "style_guide", "writing_constraints",
  ].includes(value);
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw documentError("WORKSPACE_DATA_INVALID", `Expected string column: ${key}`);
  return value;
}

function readNumber(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw documentError("WORKSPACE_DATA_INVALID", `Expected number column: ${key}`);
  return value;
}

function requireRow(row: unknown, code: string): void {
  if (!row) throw documentError(code, "Required workspace record was not found.");
}

function documentError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
