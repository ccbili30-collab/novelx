import { AssertionRepository } from "../graph/assertionRepository";
import { DocumentRepository } from "../workspace/documentRepository";
import { ResourceRepository } from "../workspace/resourceRepository";
import { CreativeDocumentRepository } from "../workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../workspace/creativeRelationRepository";
import { ConstraintProfileRepository } from "../workspace/constraintProfileRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import type {
  ChangeSetCandidate,
  ChangeSetItem,
  ChangeSetPolicyAssessment,
  ChangeSetPolicyEvaluator,
} from "./changeSetService";
import {
  isGreenfieldCreateOnlyCandidate,
  parseGreenfieldDocumentOutputEvidence,
} from "./changeSetService";
import type { ChangeSetConflictRecord } from "./changeSetRepository";

export function isGreenfieldWorkspaceEmpty(workspace: WorkspaceDatabase): boolean {
  const row = workspace.db.prepare(`
    SELECT (
      EXISTS(SELECT 1 FROM resource_revisions WHERE object_kind <> 'domain_root')
      OR EXISTS(SELECT 1 FROM assertion_versions)
      OR EXISTS(SELECT 1 FROM creative_document_revisions)
      OR EXISTS(SELECT 1 FROM creative_relation_versions)
      OR EXISTS(SELECT 1 FROM constraint_profile_versions)
      OR EXISTS(SELECT 1 FROM document_versions)
      OR EXISTS(SELECT 1 FROM working_documents)
      OR EXISTS(SELECT 1 FROM working_creative_documents)
      OR EXISTS(SELECT 1 FROM working_constraint_profiles)
    ) AS has_formal_content
  `).get() as { has_formal_content: number | bigint } | undefined;
  return !row || Number(row.has_formal_content) === 0;
}

export class WorkspaceChangeSetPolicy implements ChangeSetPolicyEvaluator {
  readonly #assertions: AssertionRepository;
  readonly #documents: DocumentRepository;
  readonly #resources: ResourceRepository;
  readonly #creativeDocuments: CreativeDocumentRepository;
  readonly #creativeRelations: CreativeRelationRepository;
  readonly #constraintProfiles: ConstraintProfileRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#assertions = new AssertionRepository(workspace);
    this.#documents = new DocumentRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
    this.#creativeDocuments = new CreativeDocumentRepository(workspace);
    this.#creativeRelations = new CreativeRelationRepository(workspace);
    this.#constraintProfiles = new ConstraintProfileRepository(workspace);
  }

  assess(candidate: ChangeSetCandidate): ChangeSetPolicyAssessment[] {
    const resources = this.#resources.listCurrent();
    const resourceIds = new Set(resources.map((resource) => resource.id));
    const assertions = this.#assertions.listCurrent();
    const creativeDocuments = this.#creativeDocuments.listCurrent();
    const creativeRelations = this.#creativeRelations.listCurrent();
    const constraintProfiles = this.#constraintProfiles.listCurrent();
    const greenfieldCreateCandidate = candidate.mode === "free"
      && candidate.greenfieldCreateAuthorized === true
      && isGreenfieldWorkspaceEmpty(this.workspace)
      && isGreenfieldCreateOnlyCandidate(candidate.items);
    const greenfieldDocumentOutputItemIds = new Set(candidate.items
      .filter((item) => item.kind === "document.put")
      .map((item) => item.id));
    const evidenceIds = new Set(assertions.map((assertion) => assertion.versionId));
    const resourceCreateItems = new Map<string, string[]>();
    const documentCreateItems = new Map<string, string[]>();
    for (const item of candidate.items) {
      if (item.kind === "resource.put" && item.payload.create && item.payload.state === "active") {
        const itemIds = resourceCreateItems.get(item.payload.resourceId) ?? [];
        itemIds.push(item.id);
        resourceCreateItems.set(item.payload.resourceId, itemIds);
      }
      if (item.kind === "creative_document.put" && item.payload.create && item.payload.state === "active") {
        const itemIds = documentCreateItems.get(item.payload.documentId) ?? [];
        itemIds.push(item.id);
        documentCreateItems.set(item.payload.documentId, itemIds);
      }
    }
    for (const resource of resources) {
      const document = this.#documents.getCurrentStable(resource.id);
      if (document) evidenceIds.add(document.id);
    }
    const acceptedImportCandidates = this.workspace.db.prepare("SELECT id FROM decomposition_candidates WHERE status = 'accepted'").all() as Array<{ id: string }>;
    for (const candidate of acceptedImportCandidates) evidenceIds.add(candidate.id);

    return candidate.items.map((item) => this.#assessItem(item, {
      assertions,
      evidenceIds,
      resourceCreateItems,
      resourceIds,
      documentIds: new Set(creativeDocuments.map((document) => document.id)),
      documentCreateItems,
      relationIds: new Set(creativeRelations.map((relation) => relation.id)),
      profileIds: new Set(constraintProfiles.map((profile) => profile.profileId)),
      greenfieldCreateCandidate,
      greenfieldDocumentOutputItemIds,
    }));
  }

  #assessItem(
    item: ChangeSetItem,
    current: {
      assertions: ReturnType<AssertionRepository["listCurrent"]>;
      evidenceIds: ReadonlySet<string>;
      resourceCreateItems: ReadonlyMap<string, string[]>;
      resourceIds: ReadonlySet<string>;
      documentIds: ReadonlySet<string>;
      documentCreateItems: ReadonlyMap<string, string[]>;
      relationIds: ReadonlySet<string>;
      profileIds: ReadonlySet<string>;
      greenfieldCreateCandidate: boolean;
      greenfieldDocumentOutputItemIds: ReadonlySet<string>;
    },
  ): ChangeSetPolicyAssessment {
    switch (item.kind) {
      case "assertion.put":
        return assessAssertion(
          item,
          current.assertions,
          current.evidenceIds,
          current.resourceIds,
          current.resourceCreateItems,
          current.greenfieldCreateCandidate,
          current.greenfieldDocumentOutputItemIds,
        );
      case "resource.put":
        return assessResource(item, current.resourceIds, current.resourceCreateItems);
      case "document.put":
        return assessDocumentContent(
          item,
          current.resourceIds,
          current.resourceCreateItems,
          current.documentIds,
          current.documentCreateItems,
        );
      case "creative_document.put":
        return assessCreativeDocument(item, current.resourceIds, current.resourceCreateItems, current.documentIds);
      case "creative_relation.put":
        return assessCreativeRelation(item, current.resourceIds, current.resourceCreateItems, current.relationIds);
      case "constraint_profile.put":
        return assessConstraintProfile(item, current.resourceIds, current.resourceCreateItems, current.profileIds);
      case "project_file.put":
        return assessProjectFilePut(item);
      case "project_file.delete":
        return { itemId: item.id, risk: "elevated", conflicts: [] };
    }
  }
}

function assessProjectFilePut(item: Extract<ChangeSetItem, { kind: "project_file.put" }>): ChangeSetPolicyAssessment {
  return {
    itemId: item.id,
    risk: item.payload.expectedSha256 === null ? "low" : "elevated",
    conflicts: [],
  };
}

function assessDocumentContent(
  item: Extract<ChangeSetItem, { kind: "document.put" }>,
  activeResourceIds: ReadonlySet<string>,
  resourceCreateItems: ReadonlyMap<string, string[]>,
  activeDocumentIds: ReadonlySet<string>,
  documentCreateItems: ReadonlyMap<string, string[]>,
): ChangeSetPolicyAssessment {
  const conflicts: ChangeSetConflictRecord[] = [];
  if (item.payload.creativeDocumentId) {
    const createItems = documentCreateItems.get(item.payload.creativeDocumentId) ?? [];
    if (!activeDocumentIds.has(item.payload.creativeDocumentId)
      && !createItems.some((itemId) => item.dependsOn.includes(itemId))) {
      conflicts.push({ severity: "major", code: "CREATIVE_DOCUMENT_TARGET_NOT_ACTIVE" });
    }
  } else {
    requireActiveOrDependency(
      item,
      item.payload.resourceId,
      activeResourceIds,
      resourceCreateItems,
      "DOCUMENT_TARGET_NOT_ACTIVE",
      conflicts,
    );
  }
  return { itemId: item.id, risk: conflicts.length === 0 ? "low" : "elevated", conflicts };
}

function assessCreativeDocument(
  item: Extract<ChangeSetItem, { kind: "creative_document.put" }>,
  activeResourceIds: ReadonlySet<string>,
  resourceCreateItems: ReadonlyMap<string, string[]>,
  activeDocumentIds: ReadonlySet<string>,
): ChangeSetPolicyAssessment {
  const conflicts: ChangeSetConflictRecord[] = [];
  requireActiveOrDependency(item, item.payload.resourceId, activeResourceIds, resourceCreateItems, "DOCUMENT_TARGET_NOT_ACTIVE", conflicts);
  if (item.payload.create && activeDocumentIds.has(item.payload.documentId)) {
    conflicts.push({ severity: "major", code: "CREATIVE_DOCUMENT_ID_CONFLICT" });
  }
  if (!item.payload.create && !activeDocumentIds.has(item.payload.documentId)) {
    conflicts.push({ severity: "major", code: "CREATIVE_DOCUMENT_TARGET_NOT_ACTIVE" });
  }
  return { itemId: item.id, risk: conflicts.length === 0 ? "low" : "elevated", conflicts };
}

function assessCreativeRelation(
  item: Extract<ChangeSetItem, { kind: "creative_relation.put" }>,
  activeResourceIds: ReadonlySet<string>,
  resourceCreateItems: ReadonlyMap<string, string[]>,
  activeRelationIds: ReadonlySet<string>,
): ChangeSetPolicyAssessment {
  const conflicts: ChangeSetConflictRecord[] = [];
  requireActiveOrDependency(item, item.payload.sourceResourceId, activeResourceIds, resourceCreateItems, "RELATION_SOURCE_NOT_ACTIVE", conflicts);
  requireActiveOrDependency(item, item.payload.targetResourceId, activeResourceIds, resourceCreateItems, "RELATION_TARGET_NOT_ACTIVE", conflicts);
  if (item.payload.create && activeRelationIds.has(item.payload.relationId)) {
    conflicts.push({ severity: "major", code: "CREATIVE_RELATION_ID_CONFLICT" });
  }
  if (!item.payload.create && !activeRelationIds.has(item.payload.relationId)) {
    conflicts.push({ severity: "major", code: "CREATIVE_RELATION_TARGET_NOT_ACTIVE" });
  }
  return { itemId: item.id, risk: conflicts.length === 0 ? "low" : "elevated", conflicts };
}

function assessConstraintProfile(
  item: Extract<ChangeSetItem, { kind: "constraint_profile.put" }>,
  activeResourceIds: ReadonlySet<string>,
  resourceCreateItems: ReadonlyMap<string, string[]>,
  activeProfileIds: ReadonlySet<string>,
): ChangeSetPolicyAssessment {
  const conflicts: ChangeSetConflictRecord[] = [];
  if (item.payload.scopeResourceId) {
    requireActiveOrDependency(item, item.payload.scopeResourceId, activeResourceIds, resourceCreateItems, "CONSTRAINT_SCOPE_NOT_ACTIVE", conflicts);
  }
  if (item.payload.create && activeProfileIds.has(item.payload.profileId)) {
    conflicts.push({ severity: "major", code: "CONSTRAINT_PROFILE_ID_CONFLICT" });
  }
  if (!item.payload.create && !activeProfileIds.has(item.payload.profileId)) {
    conflicts.push({ severity: "major", code: "CONSTRAINT_PROFILE_TARGET_NOT_ACTIVE" });
  }
  return {
    itemId: item.id,
    risk: item.payload.create && item.payload.state === "active" && conflicts.length === 0 ? "low" : "elevated",
    conflicts,
  };
}

function requireActiveOrDependency(
  item: ChangeSetItem,
  resourceId: string,
  activeResourceIds: ReadonlySet<string>,
  resourceCreateItems: ReadonlyMap<string, string[]>,
  code: string,
  conflicts: ChangeSetConflictRecord[],
): void {
  if (activeResourceIds.has(resourceId)) return;
  const createItems = resourceCreateItems.get(resourceId) ?? [];
  if (!createItems.some((itemId) => item.dependsOn.includes(itemId))) {
    conflicts.push({ severity: "major", code });
  }
}

function assessAssertion(
  item: Extract<ChangeSetItem, { kind: "assertion.put" }>,
  currentAssertions: ReturnType<AssertionRepository["listCurrent"]>,
  activeEvidenceIds: ReadonlySet<string>,
  activeResourceIds: ReadonlySet<string>,
  resourceCreateItems: ReadonlyMap<string, string[]>,
  greenfieldCreateCandidate: boolean,
  greenfieldDocumentOutputItemIds: ReadonlySet<string>,
): ChangeSetPolicyAssessment {
  const conflicts: ChangeSetConflictRecord[] = [];
  const scopeCreateItems = resourceCreateItems.get(item.payload.scopeId) ?? [];
  if (!activeResourceIds.has(item.payload.scopeId)
    && !scopeCreateItems.some((itemId) => item.dependsOn.includes(itemId))) {
    conflicts.push({ severity: "major", code: "ASSERTION_SCOPE_NOT_ACTIVE" });
  }
  if (item.payload.evidenceIds.length === 0) {
    conflicts.push({ severity: "major", code: "ASSERTION_EVIDENCE_REQUIRED" });
  } else if (item.payload.evidenceIds.some((id) => {
    const documentItemId = parseGreenfieldDocumentOutputEvidence(id);
    if (!documentItemId) return !activeEvidenceIds.has(id);
    return !greenfieldCreateCandidate
      || !greenfieldDocumentOutputItemIds.has(documentItemId)
      || !item.dependsOn.includes(documentItemId);
  })) {
    conflicts.push({ severity: "major", code: "ASSERTION_EVIDENCE_NOT_ACTIVE" });
  }
  if (item.payload.status !== "current") {
    conflicts.push({ severity: "warning", code: "ASSERTION_STATUS_REQUIRES_REVIEW" });
  }

  const sameIdentity = currentAssertions.find((assertion) => assertion.assertionId === item.payload.assertionId);
  const sameSemanticKey = currentAssertions.find((assertion) => (
    assertion.scopeType === item.payload.scopeType
    && assertion.scopeId === item.payload.scopeId
    && assertion.subject === item.payload.subject
    && assertion.predicate === item.payload.predicate
  ));
  if (sameIdentity) {
    const unchanged = sameIdentity.scopeType === item.payload.scopeType
      && sameIdentity.scopeId === item.payload.scopeId
      && sameIdentity.subject === item.payload.subject
      && sameIdentity.predicate === item.payload.predicate
      && stableStringify(sameIdentity.object) === stableStringify(item.payload.object);
    conflicts.push(unchanged
      ? { severity: "warning", code: "ASSERTION_DUPLICATE" }
      : { severity: "major", code: "ASSERTION_IDENTITY_CONFLICT" });
  } else if (sameSemanticKey && stableStringify(sameSemanticKey.object) !== stableStringify(item.payload.object)) {
    conflicts.push({ severity: "major", code: "ASSERTION_VALUE_CONFLICT" });
  }

  return {
    itemId: item.id,
    risk: conflicts.length === 0 ? "low" : "elevated",
    conflicts,
  };
}

function assessResource(
  item: Extract<ChangeSetItem, { kind: "resource.put" }>,
  activeResourceIds: ReadonlySet<string>,
  resourceCreateItems: ReadonlyMap<string, string[]>,
): ChangeSetPolicyAssessment {
  const conflicts: ChangeSetConflictRecord[] = [];
  if (item.payload.parentId && !activeResourceIds.has(item.payload.parentId)) {
    const parentCreateItems = resourceCreateItems.get(item.payload.parentId) ?? [];
    if (!parentCreateItems.some((itemId) => item.dependsOn.includes(itemId))) {
      conflicts.push({ severity: "major", code: "RESOURCE_PARENT_NOT_ACTIVE" });
    }
  }
  if (item.payload.create) {
    if ((resourceCreateItems.get(item.payload.resourceId)?.length ?? 0) > 1) {
      conflicts.push({ severity: "major", code: "RESOURCE_DUPLICATE_CREATE" });
    }
    if (activeResourceIds.has(item.payload.resourceId)) {
      conflicts.push({ severity: "major", code: "RESOURCE_ID_CONFLICT" });
    }
    if (item.payload.state !== "active") {
      conflicts.push({ severity: "warning", code: "RESOURCE_CREATE_NOT_ACTIVE" });
    }
  } else if (!activeResourceIds.has(item.payload.resourceId)) {
    conflicts.push({ severity: "major", code: "RESOURCE_TARGET_NOT_ACTIVE" });
  }

  return {
    itemId: item.id,
    risk: item.payload.create && item.payload.state === "active" && conflicts.length === 0 ? "low" : "elevated",
    conflicts,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
