import { AssertionRepository } from "../../../../domain/graph/assertionRepository";
import { assertCreativeRelationAllowed } from "../../../../domain/workspace/creativeRelationPolicy";
import { CreativeDocumentRepository } from "../../../../domain/workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../../../../domain/workspace/creativeRelationRepository";
import { ConstraintProfileRepository } from "../../../../domain/workspace/constraintProfileRepository";
import { ResourceRepository } from "../../../../domain/workspace/resourceRepository";
import type { WorkspaceDatabase } from "../../../../domain/workspace/workspaceRepository";
import type { ProposeChangeSetArgs } from "../../../../shared/agentWorkerProtocol";
import type { GrowthRetrievalReceiptLink } from "../../../../shared/growthContract";

type RepairEvidenceLink = Pick<GrowthRetrievalReceiptLink, "targetKind" | "targetId" | "targetVersionId">;

/**
 * Enforces the selected Closure finding boundary before the Change Set executor
 * can create any durable proposal record. Existing object identity always comes
 * from the pinned checkpoint, never from model-supplied owner or scope fields.
 */
export function assertGrowthRepairProposalAllowed(input: {
  workspace: WorkspaceDatabase;
  checkpointId: string;
  receiptLinks: readonly RepairEvidenceLink[];
  targetEvidenceIds: readonly string[];
  proposal: ProposeChangeSetArgs;
}): void {
  const requiredVersions = new Set(input.targetEvidenceIds);
  if (requiredVersions.size === 0 || requiredVersions.size !== input.targetEvidenceIds.length) {
    throw repairBindingError();
  }
  const targets = input.receiptLinks.filter((link) => requiredVersions.has(link.targetVersionId));
  if (targets.length !== requiredVersions.size) throw repairBindingError();

  const resourceIds = new Set(targets.filter((link) => link.targetKind === "resource").map((link) => link.targetId));
  const documentIds = new Set(targets.filter((link) => link.targetKind === "document").map((link) => link.targetId));
  const assertionIds = new Set(targets.filter((link) => link.targetKind === "assertion").map((link) => link.targetId));
  const relationIds = new Set(targets.filter((link) => link.targetKind === "relation").map((link) => link.targetId));

  const resources = new ResourceRepository(input.workspace).listAtCheckpoint(input.checkpointId);
  const documents = new CreativeDocumentRepository(input.workspace).listAtCheckpoint(input.checkpointId);
  const relations = new CreativeRelationRepository(input.workspace).listAtCheckpoint(input.checkpointId);
  const assertions = new AssertionRepository(input.workspace)
    .listCurrentInScopesAtCheckpoint(resources.map((resource) => resource.id), input.checkpointId);
  const profiles = new ConstraintProfileRepository(input.workspace).listAtCheckpoint(input.checkpointId);
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const assertionsById = new Map(assertions.map((assertion) => [assertion.assertionId, assertion]));
  const relationsById = new Map(relations.map((relation) => [relation.id, relation]));
  const profilesById = new Map(profiles.map((profile) => [profile.profileId, profile]));
  const newDocumentsById = new Map(input.proposal.items.flatMap((item) => (
    item.kind === "creative_document.put" && item.payload.create
      ? [[item.payload.documentId, item.payload] as const]
      : []
  )));

  const inBounds = input.proposal.items.every((item) => {
    switch (item.kind) {
      case "resource.put": {
        const current = resourcesById.get(item.payload.resourceId);
        return Boolean(current)
          && !item.payload.create
          && resourceIds.has(item.payload.resourceId)
          && current!.type === item.payload.type
          && current!.objectKind === item.payload.objectKind
          && current!.parentId === item.payload.parentId;
      }
      case "creative_document.put": {
        const current = documentsById.get(item.payload.documentId);
        if (current) {
          return !item.payload.create
            && current.resourceId === item.payload.resourceId
            && current.kind === item.payload.kind
            && (documentIds.has(current.id) || resourceIds.has(current.resourceId));
        }
        return item.payload.create && resourceIds.has(item.payload.resourceId);
      }
      case "document.put": {
        if (!item.payload.creativeDocumentId) return resourceIds.has(item.payload.resourceId);
        const current = documentsById.get(item.payload.creativeDocumentId);
        if (current) {
          return current.resourceId === item.payload.resourceId
            && (documentIds.has(current.id) || resourceIds.has(current.resourceId));
        }
        const created = newDocumentsById.get(item.payload.creativeDocumentId);
        return created?.resourceId === item.payload.resourceId && resourceIds.has(item.payload.resourceId);
      }
      case "assertion.put": {
        const current = assertionsById.get(item.payload.assertionId);
        if (!current) return resourceIds.has(item.payload.scopeId);
        return current.scopeType === item.payload.scopeType
          && current.scopeId === item.payload.scopeId
          && current.subject === item.payload.subject
          && (assertionIds.has(current.assertionId) || resourceIds.has(current.scopeId));
      }
      case "creative_relation.put": {
        const current = relationsById.get(item.payload.relationId);
        if (current) {
          return !item.payload.create
            && relationIds.has(current.id)
            && current.kind === item.payload.relationKind
            && current.sourceResourceId === item.payload.sourceResourceId
            && current.targetResourceId === item.payload.targetResourceId;
        }
        if (!item.payload.create
          || !resourceIds.has(item.payload.sourceResourceId)
          || !resourceIds.has(item.payload.targetResourceId)) return false;
        const source = resourcesById.get(item.payload.sourceResourceId);
        const target = resourcesById.get(item.payload.targetResourceId);
        if (!source || !target) return false;
        try {
          assertCreativeRelationAllowed({ kind: item.payload.relationKind, source, target });
          return true;
        } catch {
          return false;
        }
      }
      case "constraint_profile.put": {
        if (item.payload.scopeResourceId === null || !resourceIds.has(item.payload.scopeResourceId)) return false;
        const current = profilesById.get(item.payload.profileId);
        return current
          ? !item.payload.create && current.scopeResourceId === item.payload.scopeResourceId
          : item.payload.create;
      }
      case "project_file.put":
      case "project_file.delete":
        return false;
    }
  });
  if (!inBounds) throw repairBindingError();
}

function repairBindingError(): Error & { code: "GROWTH_BINDING_INVALID" } {
  return Object.assign(new Error("Growth Repair proposal exceeds its selected finding boundary."), {
    code: "GROWTH_BINDING_INVALID" as const,
  });
}
