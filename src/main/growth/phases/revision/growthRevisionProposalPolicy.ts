import { createHash } from "node:crypto";
import type {
  GrowthRevisionAuthority,
  ProposeChangeSetArgs,
} from "../../../../shared/agentWorkerProtocol";

/**
 * Main-side fail-closed authority check for the compiled Revision proposal.
 * It does not trust the Worker compiler: existing identities must come from the
 * pinned retrieval authority and new identities must belong to this Cycle's
 * deterministic namespace.
 */
export function assertGrowthRevisionProposalAllowed(input: {
  cycleId: string;
  domainRootResourceIds: { world: string; story: string; oc: string };
  authority: GrowthRevisionAuthority;
  proposal: ProposeChangeSetArgs;
}): void {
  const prefix = `growth-${createHash("sha256").update(`${input.cycleId}:revision`).digest("hex").slice(0, 20)}`;
  const resources = new Map(input.authority.targets
    .filter((target) => target.kind === "resource")
    .map((target) => [target.resourceId, target]));
  const documents = new Map(input.authority.targets
    .filter((target) => target.kind === "document")
    .map((target) => [target.documentId, target]));
  const assertions = new Map(input.authority.targets
    .filter((target) => target.kind === "assertion")
    .map((target) => [target.assertionId, target]));
  const relations = new Map(input.authority.targets
    .filter((target) => target.kind === "relation")
    .map((target) => [target.relationId, target]));
  const itemIds = new Set(input.proposal.items.map((item) => item.id));
  const authorityEvidenceIds = new Set(input.authority.targets.map((target) => target.evidenceId));
  const impact = input.proposal.growthRevisionImpact;
  if (itemIds.size !== input.proposal.items.length
    || input.proposal.items.some((item) => item.dependsOn.some((dependency) => !itemIds.has(dependency)))
    || !impact
    || [...impact.revisedEvidenceIds, ...impact.preservedEvidenceIds, ...impact.staleVisualEvidenceIds]
      .some((evidenceId) => !authorityEvidenceIds.has(evidenceId))
    || impact.revisedEvidenceIds.some((evidenceId) => !impact.staleVisualEvidenceIds.includes(evidenceId))
    || impact.preservedEvidenceIds.some((evidenceId) => impact.staleVisualEvidenceIds.includes(evidenceId))) {
    throw revisionProposalError();
  }
  const mutatedEvidenceIds = new Set<string>();

  const createdResources = new Map<string, { type: string; objectKind: string }>();
  const createdDocuments = new Map<string, string>();
  for (const item of input.proposal.items) {
    if (item.kind === "resource.put" && item.payload.create) {
      if (!item.payload.resourceId.startsWith(`${prefix}-resource-`)
        || item.payload.state !== "active"
        || item.payload.objectKind === undefined
        || item.payload.objectKind === "domain_root") throw revisionProposalError();
      createdResources.set(item.payload.resourceId, {
        type: item.payload.type,
        objectKind: item.payload.objectKind,
      });
    }
    if (item.kind === "creative_document.put" && item.payload.create) {
      if (!item.payload.documentId.startsWith(`${prefix}-document-`) || item.payload.state !== "active") {
        throw revisionProposalError();
      }
      createdDocuments.set(item.payload.documentId, item.payload.resourceId);
    }
  }

  const allowedResourceIds = new Set([
    ...resources.keys(),
    ...createdResources.keys(),
    ...Object.values(input.domainRootResourceIds),
  ]);
  const allowedDocumentEvidenceIds = new Set(input.authority.targets
    .filter((target) => target.kind === "document")
    .map((target) => target.evidenceId));
  const documentOutputEvidenceIds = new Set(input.proposal.items
    .filter((item) => item.kind === "document.put")
    .map((item) => `greenfield_document_output:${item.id}`));

  for (const item of input.proposal.items) {
    switch (item.kind) {
      case "resource.put": {
        if (item.payload.create) {
          if (!item.payload.parentId || !allowedResourceIds.has(item.payload.parentId)) throw revisionProposalError();
        } else {
          const target = resources.get(item.payload.resourceId);
          if (!target || item.payload.state !== "active" || item.payload.type !== target.type
            || item.payload.objectKind !== target.objectKind || item.payload.parentId !== target.parentId
            || item.payload.sortOrder !== target.sortOrder) throw revisionProposalError();
          mutatedEvidenceIds.add(target.evidenceId);
        }
        break;
      }
      case "creative_document.put": {
        if (!allowedResourceIds.has(item.payload.resourceId)) throw revisionProposalError();
        if (!item.payload.create) {
          const target = documents.get(item.payload.documentId);
          if (!target || item.payload.state !== "active" || item.payload.resourceId !== target.resourceId
            || item.payload.kind !== target.documentKind || item.payload.sortOrder !== target.sortOrder) {
            throw revisionProposalError();
          }
          mutatedEvidenceIds.add(target.evidenceId);
        }
        break;
      }
      case "document.put": {
        if (!item.payload.creativeDocumentId || item.payload.content.trim().length === 0) throw revisionProposalError();
        const owner = documents.get(item.payload.creativeDocumentId)?.resourceId
          ?? createdDocuments.get(item.payload.creativeDocumentId);
        if (!owner || owner !== item.payload.resourceId) throw revisionProposalError();
        const existingDocument = documents.get(item.payload.creativeDocumentId);
        if (existingDocument) mutatedEvidenceIds.add(existingDocument.evidenceId);
        break;
      }
      case "assertion.put": {
        const target = assertions.get(item.payload.assertionId);
        if (target) {
          if (item.payload.scopeType !== target.scopeType || item.payload.scopeId !== target.scopeId) {
            throw revisionProposalError();
          }
          mutatedEvidenceIds.add(target.evidenceId);
        } else if (!item.payload.assertionId.startsWith(`${prefix}-assertion-`)
          || !allowedResourceIds.has(item.payload.scopeId)) {
          throw revisionProposalError();
        }
        if (item.payload.evidenceIds.some((evidenceId) => (
          !allowedDocumentEvidenceIds.has(evidenceId) && !documentOutputEvidenceIds.has(evidenceId)
        ))) throw revisionProposalError();
        break;
      }
      case "creative_relation.put": {
        if (item.payload.create) {
          if (!item.payload.relationId.startsWith(`${prefix}-relation-`) || item.payload.state !== "active"
            || !allowedResourceIds.has(item.payload.sourceResourceId)
            || !allowedResourceIds.has(item.payload.targetResourceId)) throw revisionProposalError();
        } else {
          const target = relations.get(item.payload.relationId);
          if (!target || item.payload.state !== "deleted" || item.payload.relationKind !== target.relationKind
            || item.payload.sourceResourceId !== target.sourceResourceId
            || item.payload.targetResourceId !== target.targetResourceId) throw revisionProposalError();
          mutatedEvidenceIds.add(target.evidenceId);
        }
        break;
      }
      case "constraint_profile.put":
      case "project_file.put":
      case "project_file.delete":
        throw revisionProposalError();
    }
  }
  if (!sameSet([...mutatedEvidenceIds], impact.revisedEvidenceIds)) throw revisionProposalError();
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function revisionProposalError(): Error & { code: "GROWTH_BINDING_INVALID" } {
  return Object.assign(new Error("Growth revision proposal exceeds pinned authority."), {
    code: "GROWTH_BINDING_INVALID" as const,
  });
}
