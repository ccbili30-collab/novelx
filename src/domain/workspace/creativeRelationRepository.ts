import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import { CheckpointRepository } from "../version/checkpointRepository";
import { ResourceRepository, type ResourceRecord } from "./resourceRepository";
import { assertCreativeRelationAllowed, type CreativeRelationKind } from "./creativeRelationPolicy";
import type { WorkspaceDatabase } from "./workspaceRepository";

export type { CreativeRelationKind } from "./creativeRelationPolicy";

export interface CreativeRelationRecord {
  id: string;
  kind: CreativeRelationKind;
  sourceResourceId: string;
  targetResourceId: string;
}

export interface PutCreativeRelationRevisionInput {
  relationId?: string;
  create?: boolean;
  checkpointId: string;
  kind: CreativeRelationKind;
  sourceResourceId: string;
  targetResourceId: string;
  state: "active" | "deleted";
}

export interface CreativeRelationRevisionReceipt {
  relationId: string;
  revisionId: string;
  revisionSha256: string;
}

export class CreativeRelationRepository {
  readonly #checkpoints: CheckpointRepository;
  readonly #resources: ResourceRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#checkpoints = new CheckpointRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
  }

  listCurrent(branchId = this.#checkpoints.getActiveBranch().id): CreativeRelationRecord[] {
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT head_checkpoint_id, 0 FROM branches WHERE id = ?
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT crv.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY crv.relation_id ORDER BY ancestry.depth ASC) AS revision_rank
        FROM creative_relation_versions crv
        JOIN ancestry ON ancestry.checkpoint_id = crv.created_checkpoint_id
      )
      SELECT relation_id AS id, kind, source_resource_id, target_resource_id
      FROM ranked
      WHERE revision_rank = 1 AND state = 'active'
      ORDER BY CASE kind
        WHEN 'uses_world' THEN 1 WHEN 'uses_oc' THEN 2 WHEN 'variant_of' THEN 3 ELSE 4 END,
        source_resource_id, target_resource_id
    `).all(branchId);
    return rows.map(mapRelation);
  }

  listAtCheckpoint(checkpointId: string): CreativeRelationRecord[] {
    requireRow(this.workspace.db.prepare("SELECT id FROM checkpoints WHERE id = ?").get(checkpointId), "CHECKPOINT_NOT_FOUND");
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT checkpoints.parent_checkpoint_id, ancestry.depth + 1
        FROM checkpoints JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
        WHERE checkpoints.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT versions.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY versions.relation_id ORDER BY ancestry.depth ASC) AS revision_rank
        FROM creative_relation_versions versions
        JOIN ancestry ON ancestry.checkpoint_id = versions.created_checkpoint_id
      )
      SELECT relation_id AS id, kind, source_resource_id, target_resource_id
      FROM ranked
      WHERE revision_rank = 1 AND state = 'active'
      ORDER BY CASE kind
        WHEN 'uses_world' THEN 1 WHEN 'uses_oc' THEN 2 WHEN 'variant_of' THEN 3 ELSE 4 END,
        source_resource_id, target_resource_id, relation_id
    `).all(checkpointId);
    return rows.map(mapRelation);
  }

  getCurrent(relationId: string, branchId = this.#checkpoints.getActiveBranch().id): CreativeRelationRecord | null {
    return this.listCurrent(branchId).find((relation) => relation.id === relationId) ?? null;
  }

  listIncoming(resourceId: string, branchId = this.#checkpoints.getActiveBranch().id): CreativeRelationRecord[] {
    return this.listCurrent(branchId).filter((relation) => relation.targetResourceId === resourceId);
  }

  listOutgoing(resourceId: string, branchId = this.#checkpoints.getActiveBranch().id): CreativeRelationRecord[] {
    return this.listCurrent(branchId).filter((relation) => relation.sourceResourceId === resourceId);
  }

  putRevision(input: PutCreativeRelationRevisionInput): string {
    return this.putRevisionWithReceipt(input).relationId;
  }

  putRevisionWithReceipt(input: PutCreativeRelationRevisionInput): CreativeRelationRevisionReceipt {
    requireRow(this.workspace.db.prepare("SELECT id FROM checkpoints WHERE id = ?").get(input.checkpointId), "CHECKPOINT_NOT_FOUND");
    const relationId = input.relationId ?? randomUUID();
    const existingIdentity = this.workspace.db.prepare("SELECT id FROM creative_relations WHERE id = ?").get(relationId);
    const current = input.relationId ? this.getCurrent(relationId) : null;

    if (input.relationId && !input.create && !existingIdentity) {
      throw relationError("RELATION_NOT_FOUND", "The creative relation does not exist.");
    }
    if (input.create && existingIdentity) {
      throw relationError("RELATION_ALREADY_EXISTS", "The creative relation already exists.");
    }
    if (input.state === "deleted" && !current) {
      throw relationError("RELATION_NOT_ACTIVE", "The creative relation is not active.");
    }
    if (current && (
      current.kind !== input.kind
      || current.sourceResourceId !== input.sourceResourceId
      || current.targetResourceId !== input.targetResourceId
    )) {
      throw relationError("RELATION_IDENTITY_IMMUTABLE", "Relation endpoints and kind cannot be changed.");
    }

    if (input.state === "active") {
      const source = this.requireCurrentResource(input.sourceResourceId, "RELATION_SOURCE_NOT_ACTIVE");
      const target = this.requireCurrentResource(input.targetResourceId, "RELATION_TARGET_NOT_ACTIVE");
      assertCreativeRelationAllowed({ kind: input.kind, source, target });
      const duplicate = this.listCurrent().find((relation) => (
        relation.id !== relationId
        && relation.kind === input.kind
        && relation.sourceResourceId === input.sourceResourceId
        && relation.targetResourceId === input.targetResourceId
      ));
      if (duplicate) throw relationError("RELATION_DUPLICATE", "The same active relation already exists.");
    }

    if (!existingIdentity) {
      this.workspace.db.prepare("INSERT INTO creative_relations (id) VALUES (?)").run(relationId);
    }
    const revisionId = randomUUID();
    this.workspace.db.prepare(`
      INSERT INTO creative_relation_versions (
        id, relation_id, source_resource_id, target_resource_id, kind,
        created_checkpoint_id, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revisionId,
      relationId,
      input.sourceResourceId,
      input.targetResourceId,
      input.kind,
      input.checkpointId,
      input.state,
      new Date().toISOString(),
    );
    return {
      relationId,
      revisionId,
      revisionSha256: canonicalAuditHash({ relationId, ...input }),
    };
  }

  private requireCurrentResource(resourceId: string, code: string): ResourceRecord {
    const resource = this.#resources.getCurrent(resourceId);
    if (!resource) throw relationError(code, "The relation endpoint is not active in the current branch.");
    return resource;
  }
}

function mapRelation(row: Record<string, SQLOutputValue>): CreativeRelationRecord {
  const kind = readString(row, "kind");
  if (!isRelationKind(kind)) throw relationError("RELATION_KIND_INVALID", "Creative relation kind is invalid.");
  return {
    id: readString(row, "id"),
    kind,
    sourceResourceId: readString(row, "source_resource_id"),
    targetResourceId: readString(row, "target_resource_id"),
  };
}

function isRelationKind(value: string): value is CreativeRelationKind {
  return ["uses_world", "uses_oc", "variant_of", "related_to"].includes(value);
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw relationError("WORKSPACE_DATA_INVALID", `Expected string column: ${key}`);
  return value;
}

function requireRow(row: unknown, code: string): void {
  if (!row) throw relationError(code, "Required workspace record was not found.");
}

function relationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
