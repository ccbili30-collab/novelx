import type { SQLOutputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { WorkspaceDatabase } from "./workspaceRepository";
import { CheckpointRepository } from "../version/checkpointRepository";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import {
  assertCreativeObjectPlacement,
  type CreativeObjectKind,
  type ResourceDomain,
} from "./creativeObjectPolicy";

export type ResourceType = ResourceDomain;

export interface ResourceRecord {
  id: string;
  type: ResourceType;
  objectKind: CreativeObjectKind;
  title: string;
  parentId: string | null;
}

export interface PutResourceRevisionInput {
  resourceId?: string;
  create?: boolean;
  checkpointId: string;
  type: ResourceType;
  objectKind?: CreativeObjectKind;
  title: string;
  parentId: string | null;
  state: "active" | "deleted";
  sortOrder?: number;
}

export interface ResourceRevisionReceipt {
  resourceId: string;
  revisionId: string;
  revisionSha256: string;
}

export class ResourceRepository {
  readonly #checkpoints: CheckpointRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#checkpoints = new CheckpointRepository(workspace);
  }

  listCurrent(branchId = this.#checkpoints.getActiveBranch().id): ResourceRecord[] {
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT head_checkpoint_id, 0 FROM branches WHERE id = ?
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT rr.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY rr.resource_id ORDER BY ancestry.depth ASC) AS revision_rank
        FROM resource_revisions rr
        JOIN ancestry ON ancestry.checkpoint_id = rr.created_checkpoint_id
      )
      SELECT resource_id AS id, type, object_kind, title, parent_resource_id AS parent_id
      FROM ranked WHERE revision_rank = 1 AND state = 'active'
      ORDER BY CASE type
        WHEN 'world' THEN 1 WHEN 'oc' THEN 2 WHEN 'story' THEN 3
        WHEN 'graph' THEN 4 WHEN 'timeline' THEN 5 WHEN 'asset' THEN 6 ELSE 99 END,
        sort_order, title
    `).all(branchId);
    return rows.map(mapResource);
  }

  listAtCheckpoint(checkpointId: string): ResourceRecord[] {
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT rr.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY rr.resource_id ORDER BY ancestry.depth ASC) AS revision_rank
        FROM resource_revisions rr JOIN ancestry ON ancestry.checkpoint_id = rr.created_checkpoint_id
      )
      SELECT resource_id AS id, type, object_kind, title, parent_resource_id AS parent_id
      FROM ranked WHERE revision_rank = 1 AND state = 'active'
      ORDER BY CASE type
        WHEN 'world' THEN 1 WHEN 'oc' THEN 2 WHEN 'story' THEN 3
        WHEN 'graph' THEN 4 WHEN 'timeline' THEN 5 WHEN 'asset' THEN 6 ELSE 99 END,
        sort_order, title
    `).all(checkpointId);
    return rows.map(mapResource);
  }

  /**
   * Resolves a resource revision only when it is the current visible revision
   * at the pinned checkpoint. This is intentionally read-only: callers use it
   * to bind persisted Change Set outputs back to their formal resource.
   */
  getVisibleByRevisionIdAtCheckpoint(revisionId: string, checkpointId: string): ResourceRecord | null {
    const row = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT rr.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY rr.resource_id ORDER BY ancestry.depth ASC) AS revision_rank
        FROM resource_revisions rr
        JOIN ancestry ON ancestry.checkpoint_id = rr.created_checkpoint_id
      )
      SELECT resource_id AS id, type, object_kind, title, parent_resource_id AS parent_id
      FROM ranked
      WHERE revision_rank = 1 AND state = 'active' AND id = ?
    `).get(checkpointId, revisionId);
    return row ? mapResource(row) : null;
  }

  listVisibleCurrent(branchId = this.#checkpoints.getActiveBranch().id): ResourceRecord[] {
    return this.listCurrent(branchId).filter((resource) => !this.#isPristineDomainRoot(resource, branchId));
  }

  getCurrent(resourceId: string, branchId = this.#checkpoints.getActiveBranch().id): ResourceRecord | null {
    const row = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT head_checkpoint_id, 0 FROM branches WHERE id = ?
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT rr.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY rr.resource_id ORDER BY ancestry.depth ASC) AS revision_rank
        FROM resource_revisions rr
        JOIN ancestry ON ancestry.checkpoint_id = rr.created_checkpoint_id
        WHERE rr.resource_id = ?
      )
      SELECT resource_id AS id, type, object_kind, title, parent_resource_id AS parent_id
      FROM ranked WHERE revision_rank = 1 AND state = 'active'
    `).get(branchId, resourceId);
    return row ? mapResource(row) : null;
  }

  putRevision(input: PutResourceRevisionInput): string {
    return this.putRevisionWithReceipt(input).resourceId;
  }

  putRevisionWithReceipt(input: PutResourceRevisionInput): ResourceRevisionReceipt {
    const checkpoint = this.workspace.db.prepare("SELECT id FROM checkpoints WHERE id = ?").get(input.checkpointId);
    if (!checkpoint) throw repositoryError("CHECKPOINT_NOT_FOUND", "Checkpoint not found.");
    const resourceId = input.resourceId || randomUUID();
    const existing = this.workspace.db.prepare("SELECT id FROM resources WHERE id = ?").get(resourceId);
    const current = input.resourceId ? this.getCurrent(resourceId) : null;
    const objectKind = input.objectKind ?? current?.objectKind ?? inferLegacyObjectKind(input.type);
    if (current && objectKind !== current.objectKind) {
      throw repositoryError("RESOURCE_KIND_IMMUTABLE", "Resource object kind cannot be changed.");
    }
    if (current && input.type !== current.type) {
      throw repositoryError("RESOURCE_DOMAIN_IMMUTABLE", "Resource domain cannot be changed.");
    }
    if (input.state === "deleted") {
      if (!current) throw repositoryError("RESOURCE_NOT_ACTIVE", "Resource is not active in the current branch.");
      if (current.objectKind === "domain_root") {
        throw repositoryError("RESOURCE_DOMAIN_ROOT_PROTECTED", "Domain roots cannot be deleted.");
      }
      if (this.listCurrent().some((resource) => resource.parentId === resourceId)) {
        throw repositoryError("RESOURCE_CHILDREN_ACTIVE", "Remove or move owned child objects before deleting this object.");
      }
      if (this.#hasActiveRelation(resourceId)) {
        throw repositoryError("RESOURCE_RELATIONS_ACTIVE", "Remove active object relations before deleting this object.");
      }
    }
    if (input.state === "active") {
      assertCreativeObjectPlacement(
        { id: resourceId, domain: input.type, kind: objectKind, parentId: input.parentId },
        this.listCurrent()
          .filter((resource) => resource.id !== resourceId)
          .concat(current ? [current] : [])
          .map((resource) => ({
            id: resource.id,
            domain: resource.type,
            kind: resource.objectKind,
            parentId: resource.parentId,
          })),
      );
    }
    if (!input.resourceId) {
      this.workspace.db.prepare("INSERT INTO resources (id) VALUES (?)").run(resourceId);
    } else if (input.create) {
      if (existing) throw repositoryError("RESOURCE_ALREADY_EXISTS", "Resource already exists.");
      this.workspace.db.prepare("INSERT INTO resources (id) VALUES (?)").run(resourceId);
    } else if (!existing) {
      throw repositoryError("RESOURCE_NOT_FOUND", "Resource not found.");
    }
    const revisionId = randomUUID();
    const sortOrder = input.sortOrder || 0;
    this.workspace.db.prepare(`
      INSERT INTO resource_revisions (
        id, resource_id, type, object_kind, title, parent_resource_id, created_checkpoint_id, state, sort_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revisionId,
      resourceId,
      input.type,
      objectKind,
      input.title.trim(),
      input.parentId,
      input.checkpointId,
      input.state,
      sortOrder,
      new Date().toISOString(),
    );
    return {
      resourceId,
      revisionId,
      revisionSha256: canonicalAuditHash({
        resourceId,
        type: input.type,
        objectKind,
        title: input.title.trim(),
        parentId: input.parentId,
        checkpointId: input.checkpointId,
        state: input.state,
        sortOrder,
      }),
    };
  }

  #isPristineDomainRoot(resource: ResourceRecord, branchId: string): boolean {
    if (resource.objectKind !== "domain_root" || resource.parentId !== null || resource.title !== DOMAIN_ROOT_TITLES[resource.type]) return false;
    const row = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id) AS (
        SELECT head_checkpoint_id FROM branches WHERE id = ?
        UNION ALL
        SELECT c.parent_checkpoint_id FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      )
      SELECT
        (SELECT COUNT(*) FROM resource_revisions rr
          JOIN ancestry ON ancestry.checkpoint_id = rr.created_checkpoint_id
          WHERE rr.resource_id = ?) AS revision_count,
        (SELECT COUNT(*) FROM document_versions dv
          JOIN ancestry ON ancestry.checkpoint_id = dv.created_checkpoint_id
          WHERE dv.resource_id = ?) AS document_count,
        (SELECT COUNT(*) FROM working_documents wd
          WHERE wd.branch_id = ? AND wd.resource_id = ?) AS working_count
    `).get(branchId, resource.id, resource.id, branchId, resource.id) as {
      revision_count: number;
      document_count: number;
      working_count: number;
    };
    return row.revision_count === 1 && row.document_count === 0 && row.working_count === 0;
  }

  #hasActiveRelation(resourceId: string): boolean {
    const branch = this.#checkpoints.getActiveBranch();
    const row = this.workspace.db.prepare(`
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
      SELECT COUNT(*) AS count FROM ranked
      WHERE revision_rank = 1 AND state = 'active'
        AND (source_resource_id = ? OR target_resource_id = ?)
    `).get(branch.id, resourceId, resourceId) as { count: number };
    return row.count > 0;
  }
}

const DOMAIN_ROOT_TITLES: Record<ResourceType, string> = {
  world: "世界",
  oc: "OC",
  story: "故事",
  graph: "图谱",
  timeline: "时间线",
  asset: "资产",
};

function mapResource(row: Record<string, SQLOutputValue>): ResourceRecord {
  const type = readString(row, "type");
  if (!isResourceType(type)) throw repositoryError("RESOURCE_TYPE_INVALID", "Resource type is invalid.");
  const parent = row.parent_id;
  if (parent !== null && typeof parent !== "string") throw repositoryError("RESOURCE_PARENT_INVALID", "Resource parent is invalid.");
  return {
    id: readString(row, "id"),
    type,
    objectKind: readObjectKind(row),
    title: readString(row, "title"),
    parentId: parent,
  };
}

function readObjectKind(row: Record<string, SQLOutputValue>): CreativeObjectKind {
  const value = readString(row, "object_kind");
  if (!isCreativeObjectKind(value)) throw repositoryError("RESOURCE_OBJECT_KIND_INVALID", "Resource object kind is invalid.");
  return value;
}

function isCreativeObjectKind(value: string): value is CreativeObjectKind {
  return [
    "domain_root", "world", "oc", "story", "volume", "chapter", "location", "faction",
    "oc_variant", "graph_view", "timeline_view", "asset_collection",
  ].includes(value);
}

function inferLegacyObjectKind(type: ResourceType): CreativeObjectKind {
  switch (type) {
    case "world": return "world";
    case "oc": return "oc";
    case "story": return "story";
    case "graph": return "graph_view";
    case "timeline": return "timeline_view";
    case "asset": return "asset_collection";
  }
}

function isResourceType(value: string): value is ResourceType {
  return ["world", "oc", "story", "graph", "timeline", "asset"].includes(value);
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw repositoryError("WORKSPACE_DATA_INVALID", `Expected string column: ${key}`);
  return value;
}

function repositoryError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
