import type { GrowthFocusKind } from "../../../growthFrontierPlanner";
import { AssertionRepository } from "../../../../domain/graph/assertionRepository";
import type { GraphRetrievalEvidenceHit } from "../../../../domain/retrieval/graphRetrievalTypes";
import { CreativeDocumentRepository } from "../../../../domain/workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../../../../domain/workspace/creativeRelationRepository";
import { DocumentRepository } from "../../../../domain/workspace/documentRepository";
import { ResourceRepository, type ResourceRecord } from "../../../../domain/workspace/resourceRepository";
import type { WorkspaceDatabase } from "../../../../domain/workspace/workspaceRepository";
import {
  growthRevisionAuthoritySchema,
  type GrowthRevisionAuthority,
} from "../../../../shared/agentWorkerProtocol";

export interface GrowthRevisionPrerequisites {
  anchors: Array<{ resourceId: string; title: string }>;
  requiredTargetVersionIds: string[];
}

/**
 * Read-only authority resolver for one pinned Revision Cycle. It never writes a
 * Cycle or Change Set and never trusts model-supplied object identities.
 */
export class GrowthRevisionAuthorityResolver {
  readonly #resources: ResourceRepository;
  readonly #documents: CreativeDocumentRepository;
  readonly #stableDocuments: DocumentRepository;
  readonly #assertions: AssertionRepository;
  readonly #relations: CreativeRelationRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#resources = new ResourceRepository(workspace);
    this.#documents = new CreativeDocumentRepository(workspace);
    this.#stableDocuments = new DocumentRepository(workspace);
    this.#assertions = new AssertionRepository(workspace);
    this.#relations = new CreativeRelationRepository(workspace);
  }

  prerequisites(input: {
    checkpointId: string;
    authorizedScopeResourceIds: string[];
    focusKinds: GrowthFocusKind[];
  }): GrowthRevisionPrerequisites {
    const allResources = this.#resources.listAtCheckpoint(input.checkpointId);
    const selected = allResources.filter((resource) => input.focusKinds.includes(resource.type as GrowthFocusKind))
      .filter((resource) => resource.objectKind !== "domain_root")
      .filter((resource) => isAuthorized(resource.id, input.authorizedScopeResourceIds, allResources));
    for (const focusKind of input.focusKinds) {
      if (!selected.some((resource) => resource.type === focusKind)) throw revisionAuthorityError();
    }
    const selectedIds = new Set(selected.map((resource) => resource.id));
    const versions = new Set<string>();
    for (const document of this.#documents.listAtCheckpoint(input.checkpointId)
      .filter((candidate) => selectedIds.has(candidate.resourceId))) {
      const stable = this.#stableDocuments.getStableForCreativeDocumentAtCheckpoint(document.id, input.checkpointId);
      if (stable) versions.add(stable.id);
    }
    for (const assertion of this.#assertions.listCurrentInScopesAtCheckpoint([...selectedIds], input.checkpointId)) {
      versions.add(assertion.versionId);
    }
    for (const relation of this.#relations.listAtCheckpoint(input.checkpointId)) {
      if (!selectedIds.has(relation.sourceResourceId) && !selectedIds.has(relation.targetResourceId)) continue;
      versions.add(requiredCurrentRelationVersionId(this.workspace, input.checkpointId, relation.id));
    }
    if (selected.length === 0 || selected.length > 100 || versions.size > 100) throw revisionAuthorityError();
    return {
      anchors: selected.map((resource) => ({ resourceId: resource.id, title: resource.title })),
      requiredTargetVersionIds: [...versions],
    };
  }

  resolve(checkpointId: string, hits: GraphRetrievalEvidenceHit[]): GrowthRevisionAuthority {
    const resources = this.#resources.listAtCheckpoint(checkpointId);
    const documents = this.#documents.listAtCheckpoint(checkpointId);
    const relations = this.#relations.listAtCheckpoint(checkpointId);
    const targets: unknown[] = [];
    for (const hit of hits) {
      if (hit.targetKind === "resource") {
        const resource = this.#resources.getVisibleByRevisionIdAtCheckpoint(hit.targetVersionId, checkpointId);
        if (!resource || resource.id !== hit.targetId) throw revisionAuthorityError();
        const row = this.workspace.db.prepare("SELECT sort_order FROM resource_revisions WHERE id = ? AND resource_id = ?")
          .get(hit.targetVersionId, hit.targetId) as { sort_order: number } | undefined;
        if (!row || !Number.isInteger(row.sort_order) || row.sort_order < 0) throw revisionAuthorityError();
        targets.push({
          kind: "resource", evidenceId: hit.targetVersionId, resourceId: resource.id,
          type: resource.type, objectKind: resource.objectKind, title: resource.title,
          parentId: resource.parentId, sortOrder: row.sort_order,
        });
        continue;
      }
      if (hit.targetKind === "document") {
        const document = documents.find((candidate) => candidate.id === hit.targetId);
        const stable = document
          ? this.#stableDocuments.getStableForCreativeDocumentAtCheckpoint(document.id, checkpointId)
          : null;
        if (!document || !stable || stable.id !== hit.targetVersionId || stable.resourceId !== document.resourceId) {
          throw revisionAuthorityError();
        }
        const owner = resources.find((candidate) => candidate.id === document.resourceId);
        // Longform outlines and section prose remain retrievable evidence,
        // but only the Longform phase may mutate their managed identity,
        // length bounds and source chain.
        if (owner?.objectKind === "volume"
          && (document.kind === "writing_constraints" || document.kind === "prose")) continue;
        targets.push({
          kind: "document", evidenceId: hit.targetVersionId, documentId: document.id,
          resourceId: document.resourceId, documentKind: document.kind,
          title: document.title, sortOrder: document.sortOrder,
        });
        continue;
      }
      if (hit.targetKind === "assertion") {
        if (hit.assertion.status !== "current") continue;
        const assertion = this.#assertions.listCurrentInScopesAtCheckpoint([hit.assertion.scopeResourceId], checkpointId)
          .find((candidate) => candidate.assertionId === hit.targetId && candidate.versionId === hit.targetVersionId);
        if (!assertion) throw revisionAuthorityError();
        targets.push({
          kind: "assertion", evidenceId: assertion.versionId, assertionId: assertion.assertionId,
          scopeType: assertion.scopeType, scopeId: assertion.scopeId,
          subject: assertion.subject, predicate: assertion.predicate, object: assertion.object,
        });
        continue;
      }
      const relation = relations.find((candidate) => candidate.id === hit.targetId);
      const versionId = relation ? requiredCurrentRelationVersionId(this.workspace, checkpointId, relation.id) : null;
      if (!relation || versionId !== hit.targetVersionId) throw revisionAuthorityError();
      targets.push({
        kind: "relation", evidenceId: hit.targetVersionId, relationId: relation.id,
        relationKind: relation.kind, sourceResourceId: relation.sourceResourceId,
        targetResourceId: relation.targetResourceId,
      });
    }
    return growthRevisionAuthoritySchema.parse({ targets });
  }
}

function isAuthorized(resourceId: string, scopeIds: string[], resources: ResourceRecord[]): boolean {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  let current = byId.get(resourceId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (scopeIds.includes(current.id)) return true;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

function requiredCurrentRelationVersionId(
  workspace: WorkspaceDatabase,
  checkpointId: string,
  relationId: string,
): string {
  const row = workspace.db.prepare(`
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
    SELECT id FROM ranked WHERE revision_rank = 1 AND state = 'active' AND relation_id = ?
  `).get(checkpointId, relationId) as { id: string } | undefined;
  if (!row || typeof row.id !== "string") throw revisionAuthorityError();
  return row.id;
}

function revisionAuthorityError(): Error & { code: "GROWTH_BINDING_INVALID" } {
  return Object.assign(new Error("Growth revision authority is invalid."), { code: "GROWTH_BINDING_INVALID" as const });
}
