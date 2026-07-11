import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import {
  AssertionRepository,
  type SourcedAssertionRecord,
  type StoredAssertionSource,
} from "../graph/assertionRepository";
import { CheckpointRepository } from "../version/checkpointRepository";
import { DocumentRepository, type DocumentVersionRecord } from "../workspace/documentRepository";
import { CreativeDocumentRepository, type CreativeDocumentRecord } from "../workspace/creativeDocumentRepository";
import { ResourceRepository, type ResourceRecord } from "../workspace/resourceRepository";

export interface ContextPacketScope {
  resourceId: string;
  type: ResourceRecord["type"];
  title: string;
}

export interface StableDocumentEvidence {
  content: string;
  contentState: {
    complete: boolean;
    originalChars: number;
    returnedChars: number;
  };
  source: {
    type: "stable_document";
    resource: ContextPacketScope;
    document: { id: string; title: string } | null;
    version: {
      id: string;
      checkpointId: string;
      contentHash: string;
      authorKind: DocumentVersionRecord["authorKind"];
    };
  };
}

export type AssertionEvidenceSource =
  | {
      type: "stable_document";
      document: {
        resourceId: string;
        title: string;
        versionId: string;
      };
    }
  | {
      type: "change_set";
      changeSet: {
        id: string;
        summary: string;
        itemId?: string;
      };
    }
  | {
      type: "assertion";
      assertion: {
        assertionId: string;
        versionId: string;
        subject: string;
        predicate: string;
      };
    }
  | {
      type: "unresolved";
      reason: "unsupported_source" | "source_not_active";
    };

export interface AssertionEvidence {
  assertionId: string;
  versionId: string;
  scopeResourceId: string;
  scopeType: string;
  subject: string;
  predicate: string;
  object: Record<string, unknown>;
  sources: AssertionEvidenceSource[];
}

export interface ContextPacket {
  branch: {
    id: string;
    headCheckpointId: string;
  };
  scopes: ContextPacketScope[];
  assertions: AssertionEvidence[];
  documents: StableDocumentEvidence[];
  retrieval: ContextPacketRetrievalMetadata;
}

export interface ContextPacketBudget {
  maxDocuments: number;
  maxAssertions: number;
  maxDocumentChars: number;
  totalChars: number;
}

export interface ContextPacketRetrievalMetadata {
  budget: ContextPacketBudget;
  usage: {
    assertions: number;
    documents: number;
    assertionChars: number;
    documentChars: number;
    totalChars: number;
  };
  completeness: {
    incomplete: boolean;
    omittedAssertions: number;
    omittedDocuments: number;
    truncatedDocuments: number;
    limitsHit: Array<"max_assertions" | "max_documents" | "max_document_chars" | "total_chars">;
  };
  ordering: {
    assertions: "repository_subject_predicate_assertion_id";
    documents: "requested_scope_order";
    relevanceRanking: "not_applied";
  };
}

export const DEFAULT_CONTEXT_PACKET_BUDGET: Readonly<ContextPacketBudget> = Object.freeze({
  maxDocuments: 12,
  maxAssertions: 200,
  maxDocumentChars: 20_000,
  totalChars: 160_000,
});

export class ContextPacketService {
  readonly #assertions: AssertionRepository;
  readonly #checkpoints: CheckpointRepository;
  readonly #documents: DocumentRepository;
  readonly #creativeDocuments: CreativeDocumentRepository;
  readonly #resources: ResourceRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#assertions = new AssertionRepository(workspace);
    this.#checkpoints = new CheckpointRepository(workspace);
    this.#documents = new DocumentRepository(workspace);
    this.#creativeDocuments = new CreativeDocumentRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
  }

  build(input: { scopeResourceIds: readonly string[]; budget?: Partial<ContextPacketBudget>; checkpointId?: string }): ContextPacket {
    const branch = input.checkpointId ? this.#resolvePinnedCheckpoint(input.checkpointId) : this.#checkpoints.getActiveBranch();
    const checkpointId = input.checkpointId ?? branch.headCheckpointId;
    const budget = normalizeBudget(input.budget);
    const requestedScopeIds = normalizeScopeIds(input.scopeResourceIds);
    if (requestedScopeIds.length === 0) {
      throw serviceError("CONTEXT_SCOPE_REQUIRED", "At least one scope resource is required.");
    }

    const activeResources = new Map((input.checkpointId
      ? this.#resources.listAtCheckpoint(checkpointId)
      : this.#resources.listCurrent(branch.id)).map((resource) => [resource.id, resource]));
    const scopes = requestedScopeIds.map((resourceId) => {
      const resource = activeResources.get(resourceId);
      if (!resource) throw serviceError("CONTEXT_SCOPE_NOT_ACTIVE", "A requested scope is not active on the current branch.");
      return mapScope(resource);
    });
    const stableDocuments = new Map<string, { resource: ContextPacketScope; document: CreativeDocumentRecord | null; version: DocumentVersionRecord }>();
    const availableDocuments: Array<{ resource: ContextPacketScope; document: CreativeDocumentRecord | null; version: DocumentVersionRecord }> = [];
    for (const scope of scopes) {
      const creativeDocuments = input.checkpointId
        ? this.#creativeDocuments.listAtCheckpoint(checkpointId, scope.resourceId)
        : this.#creativeDocuments.listCurrent(scope.resourceId, branch.id);
      let foundCreativeStable = false;
      for (const document of creativeDocuments) {
        const version = input.checkpointId
          ? this.#documents.getStableForCreativeDocumentAtCheckpoint(document.id, checkpointId)
          : this.#documents.getCurrentStableForCreativeDocument(document.id, branch.id);
        if (!version) continue;
        foundCreativeStable = true;
        stableDocuments.set(version.id, { resource: scope, document, version });
        availableDocuments.push({ resource: scope, document, version });
      }
      if (foundCreativeStable) continue;
      const legacyVersion = input.checkpointId
        ? this.#documents.getStableAtCheckpoint(scope.resourceId, checkpointId)
        : this.#documents.getCurrentStable(scope.resourceId, branch.id);
      if (!legacyVersion) continue;
      stableDocuments.set(legacyVersion.id, { resource: scope, document: null, version: legacyVersion });
      availableDocuments.push({ resource: scope, document: null, version: legacyVersion });
    }

    const currentAssertions = input.checkpointId
      ? this.#assertions.listCurrentInScopesAtCheckpoint(requestedScopeIds, checkpointId)
      : this.#assertions.listCurrentInScopes(requestedScopeIds, branch.id);
    const activeAssertionVersions = new Map(currentAssertions.map((assertion) => [assertion.versionId, assertion]));
    const availableAssertions = currentAssertions.map((assertion) => ({
      assertionId: assertion.assertionId,
      versionId: assertion.versionId,
      scopeResourceId: assertion.scopeId,
      scopeType: assertion.scopeType,
      subject: assertion.subject,
      predicate: assertion.predicate,
      object: assertion.object,
      sources: assertion.sources.map((source) => this.#projectSource(
        source,
        checkpointId,
        stableDocuments,
        activeAssertionVersions,
      )),
    }));
    const selectedAssertions = selectAssertions(availableAssertions, budget);
    const selectedDocuments = selectDocuments(
      availableDocuments,
      budget,
      budget.totalChars - selectedAssertions.chars,
    );
    const limitsHit: ContextPacketRetrievalMetadata["completeness"]["limitsHit"] = [];
    if (selectedAssertions.hitCountLimit) limitsHit.push("max_assertions");
    if (selectedDocuments.hitCountLimit) limitsHit.push("max_documents");
    if (selectedDocuments.hitDocumentCharLimit) limitsHit.push("max_document_chars");
    if (selectedAssertions.hitTotalCharLimit || selectedDocuments.hitTotalCharLimit) limitsHit.push("total_chars");
    const omittedAssertions = availableAssertions.length - selectedAssertions.values.length;
    const omittedDocuments = availableDocuments.length - selectedDocuments.values.length;

    return {
      branch: { id: branch.id, headCheckpointId: checkpointId },
      scopes,
      assertions: selectedAssertions.values,
      documents: selectedDocuments.values,
      retrieval: {
        budget,
        usage: {
          assertions: selectedAssertions.values.length,
          documents: selectedDocuments.values.length,
          assertionChars: selectedAssertions.chars,
          documentChars: selectedDocuments.chars,
          totalChars: selectedAssertions.chars + selectedDocuments.chars,
        },
        completeness: {
          incomplete: omittedAssertions > 0 || omittedDocuments > 0 || selectedDocuments.truncatedCount > 0,
          omittedAssertions,
          omittedDocuments,
          truncatedDocuments: selectedDocuments.truncatedCount,
          limitsHit,
        },
        ordering: {
          assertions: "repository_subject_predicate_assertion_id",
          documents: "requested_scope_order",
          relevanceRanking: "not_applied",
        },
      },
    };
  }

  #projectSource(
    source: StoredAssertionSource,
    checkpointId: string,
    stableDocuments: ReadonlyMap<string, { resource: ContextPacketScope; document: CreativeDocumentRecord | null; version: DocumentVersionRecord }>,
    activeAssertionVersions: ReadonlyMap<string, SourcedAssertionRecord>,
  ): AssertionEvidenceSource {
    if (source.kind === "document_version") {
      const stable = stableDocuments.get(source.ref);
      if (!stable) return { type: "unresolved", reason: "source_not_active" };
      return {
        type: "stable_document",
        document: {
          resourceId: stable.resource.resourceId,
          title: stable.resource.title,
          versionId: stable.version.id,
        },
      };
    }
    if (source.kind === "evidence_version") {
      const stable = stableDocuments.get(source.ref);
      if (stable) {
        return {
          type: "stable_document",
          document: {
            resourceId: stable.resource.resourceId,
            title: stable.resource.title,
            versionId: stable.version.id,
          },
        };
      }
      const assertion = activeAssertionVersions.get(source.ref);
      if (assertion) {
        return {
          type: "assertion",
          assertion: {
            assertionId: assertion.assertionId,
            versionId: assertion.versionId,
            subject: assertion.subject,
            predicate: assertion.predicate,
          },
        };
      }
      return { type: "unresolved", reason: "source_not_active" };
    }
    if (source.kind === "confirmed_change_set") {
      const sourceIdentity = parseChangeSetSource(source.ref);
      if (!sourceIdentity) return { type: "unresolved", reason: "unsupported_source" };
      const changeSet = this.workspace.db.prepare(`
        WITH RECURSIVE ancestry(checkpoint_id) AS (
          SELECT ?
          UNION ALL
          SELECT checkpoints.parent_checkpoint_id FROM checkpoints
          JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
          WHERE checkpoints.parent_checkpoint_id IS NOT NULL
        )
        SELECT change_sets.id, change_sets.summary FROM change_sets
        JOIN ancestry ON ancestry.checkpoint_id = change_sets.committed_checkpoint_id
        LEFT JOIN change_set_items ON change_set_items.change_set_id = change_sets.id
          AND change_set_items.id = ?
        WHERE change_sets.id = ? AND change_sets.status = 'committed'
          AND (? IS NULL OR change_set_items.decision = 'accepted')
      `).get(
        checkpointId,
        sourceIdentity.itemId,
        sourceIdentity.changeSetId,
        sourceIdentity.itemId,
      ) as { id: string; summary: string } | undefined;
      if (!changeSet) return { type: "unresolved", reason: "source_not_active" };
      return {
        type: "change_set",
        changeSet: sourceIdentity.itemId
          ? { ...changeSet, itemId: sourceIdentity.itemId }
          : changeSet,
      };
    }
    return { type: "unresolved", reason: "unsupported_source" };
  }

  #resolvePinnedCheckpoint(checkpointId: string): { id: string; headCheckpointId: string } {
    const row = this.workspace.db.prepare(`
      SELECT checkpoints.branch_id, creative_commits.sealed_at
      FROM checkpoints JOIN creative_commits ON creative_commits.id = checkpoints.id
      WHERE checkpoints.id = ?
    `).get(checkpointId) as { branch_id: string; sealed_at: string | null } | undefined;
    if (!row) throw serviceError("CONTEXT_CHECKPOINT_NOT_FOUND", "Pinned context checkpoint was not found.");
    if (!row.sealed_at) throw serviceError("CONTEXT_CHECKPOINT_UNSEALED", "Pinned context checkpoint is not sealed.");
    return { id: row.branch_id, headCheckpointId: checkpointId };
  }
}

function selectAssertions(
  assertions: AssertionEvidence[],
  budget: ContextPacketBudget,
): {
  values: AssertionEvidence[];
  chars: number;
  hitCountLimit: boolean;
  hitTotalCharLimit: boolean;
} {
  const values: AssertionEvidence[] = [];
  let chars = 0;
  let hitTotalCharLimit = false;
  for (const assertion of assertions) {
    if (values.length >= budget.maxAssertions) break;
    const assertionChars = JSON.stringify(assertion).length;
    if (chars + assertionChars > budget.totalChars) {
      hitTotalCharLimit = true;
      break;
    }
    values.push(assertion);
    chars += assertionChars;
  }
  return {
    values,
    chars,
    hitCountLimit: values.length < assertions.length && values.length >= budget.maxAssertions,
    hitTotalCharLimit,
  };
}

function selectDocuments(
  documents: Array<{ resource: ContextPacketScope; document: CreativeDocumentRecord | null; version: DocumentVersionRecord }>,
  budget: ContextPacketBudget,
  remainingTotalChars: number,
): {
  values: StableDocumentEvidence[];
  chars: number;
  truncatedCount: number;
  hitCountLimit: boolean;
  hitDocumentCharLimit: boolean;
  hitTotalCharLimit: boolean;
} {
  const values: StableDocumentEvidence[] = [];
  let chars = 0;
  let truncatedCount = 0;
  let hitDocumentCharLimit = false;
  let hitTotalCharLimit = false;
  for (const document of documents) {
    if (values.length >= budget.maxDocuments) break;
    const originalChars = document.version.content.length;
    if (remainingTotalChars - chars <= 0 && originalChars > 0) {
      hitTotalCharLimit = true;
      break;
    }
    const perDocumentChars = Math.min(originalChars, budget.maxDocumentChars);
    if (perDocumentChars < originalChars) hitDocumentCharLimit = true;
    const targetChars = Math.min(perDocumentChars, Math.max(0, remainingTotalChars - chars));
    if (targetChars < perDocumentChars) hitTotalCharLimit = true;
    const content = sliceWithoutDanglingSurrogate(document.version.content, targetChars);
    const returnedChars = content.length;
    const complete = returnedChars === originalChars;
    if (!complete) truncatedCount += 1;
    values.push({
      content,
      contentState: { complete, originalChars, returnedChars },
      source: {
        type: "stable_document",
        resource: document.resource,
        document: document.document ? { id: document.document.id, title: document.document.title } : null,
        version: {
          id: document.version.id,
          checkpointId: document.version.checkpointId,
          contentHash: document.version.contentHash,
          authorKind: document.version.authorKind,
        },
      },
    });
    chars += returnedChars;
    if (targetChars < perDocumentChars) break;
  }
  return {
    values,
    chars,
    truncatedCount,
    hitCountLimit: values.length < documents.length && values.length >= budget.maxDocuments,
    hitDocumentCharLimit,
    hitTotalCharLimit,
  };
}

function sliceWithoutDanglingSurrogate(value: string, maxCodeUnits: number): string {
  let end = Math.min(value.length, maxCodeUnits);
  if (end > 0 && end < value.length) {
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    const splitsSurrogatePair = previous >= 0xD800 && previous <= 0xDBFF
      && next >= 0xDC00 && next <= 0xDFFF;
    if (splitsSurrogatePair) end -= 1;
  }
  return value.slice(0, end);
}

function normalizeBudget(input: Partial<ContextPacketBudget> | undefined): ContextPacketBudget {
  const budget = { ...DEFAULT_CONTEXT_PACKET_BUDGET, ...input };
  assertBudgetInteger("maxDocuments", budget.maxDocuments, 1, 50);
  assertBudgetInteger("maxAssertions", budget.maxAssertions, 1, 1_000);
  assertBudgetInteger("maxDocumentChars", budget.maxDocumentChars, 1, 100_000);
  assertBudgetInteger("totalChars", budget.totalChars, 1, 500_000);
  return budget;
}

function assertBudgetInteger(name: keyof ContextPacketBudget, value: number, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw serviceError("CONTEXT_BUDGET_INVALID", `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function normalizeScopeIds(scopeResourceIds: readonly string[]): string[] {
  return [...new Set(scopeResourceIds.map((resourceId) => resourceId.trim()).filter(Boolean))];
}

function mapScope(resource: ResourceRecord): ContextPacketScope {
  return { resourceId: resource.id, type: resource.type, title: resource.title };
}

function parseChangeSetSource(ref: string): { changeSetId: string; itemId: string | null } | null {
  const separator = ref.indexOf(":");
  if (separator < 0) return ref ? { changeSetId: ref, itemId: null } : null;
  const changeSetId = ref.slice(0, separator);
  const itemId = ref.slice(separator + 1);
  return changeSetId && itemId ? { changeSetId, itemId } : null;
}

function serviceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
