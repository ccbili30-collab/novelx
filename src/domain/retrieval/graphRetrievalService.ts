import type { SQLOutputValue } from "node:sqlite";
import { CreativeDocumentRepository } from "../workspace/creativeDocumentRepository";
import { DocumentRepository } from "../workspace/documentRepository";
import { ResourceRepository } from "../workspace/resourceRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { graphRetrievalRequestSchema, type GraphRetrievalAssertionSource, type GraphRetrievalEvidenceHit, type GraphRetrievalReasonCode, type GraphRetrievalRequest, type GraphRetrievalResult } from "./graphRetrievalTypes";

type TargetKind = "resource" | "document" | "assertion" | "relation";
type Row = Record<string, SQLOutputValue>;
type ReasonCode = GraphRetrievalReasonCode;

interface Candidate {
  key: string;
  targetKind: TargetKind;
  targetId: string;
  targetVersionId: string;
  resourceIds: string[];
  graphNodeIds?: string[];
  text: string;
  subject?: string;
  predicate?: string;
  conflict: boolean;
  locator: { locator: string; versionId: string; hash: string } | null;
  evidence: Record<string, unknown>;
}

interface Edge { from: string; to: string; }

const retrievalCaches = new WeakMap<WorkspaceDatabase, Map<string, GraphRetrievalResult>>();
const MAX_CACHE_ENTRIES = 64;

export class GraphRetrievalService {
  readonly #resources: ResourceRepository;
  readonly #documents: DocumentRepository;
  readonly #creativeDocuments: CreativeDocumentRepository;
  readonly #now: () => number;

  constructor(readonly workspace: WorkspaceDatabase, options: { now?: () => number } = {}) {
    this.#resources = new ResourceRepository(workspace);
    this.#documents = new DocumentRepository(workspace);
    this.#creativeDocuments = new CreativeDocumentRepository(workspace);
    this.#now = options.now ?? Date.now;
  }

  retrieve(input: unknown): GraphRetrievalResult {
    if (isRecord(input) && input.lens === "player") throw retrievalError("GRAPH_RETRIEVAL_CREATOR_LENS_REQUIRED");
    const parsed = graphRetrievalRequestSchema.safeParse(input);
    if (!parsed.success) {
      const hasBudgetIssue = parsed.error.issues.some((issue) => issue.path[0] === "cpuBudgetMs" || issue.path[0] === "expansionBudget" || issue.path[0] === "resultBudget" || issue.path[0] === "tokenBudget" || issue.path[0] === "contentBudgetChars");
      throw retrievalError(hasBudgetIssue ? "GRAPH_RETRIEVAL_BUDGET_INVALID" : "GRAPH_RETRIEVAL_INPUT_INVALID");
    }
    const value = parsed.data;
    if (value.lens !== "creator") throw retrievalError("GRAPH_RETRIEVAL_CREATOR_LENS_REQUIRED");
    if (value.validTime !== null || value.recordedTime !== null) throw retrievalError("GRAPH_RETRIEVAL_TIME_FILTER_UNSUPPORTED");
    this.#assertCheckpointBranch(value.checkpointId, value.branchId);

    const visibleResources = this.#resources.listAtCheckpoint(value.checkpointId);
    const visibleById = new Map(visibleResources.map((resource) => [resource.id, resource]));
    for (const scopeId of value.authorizedScopeResourceIds) if (!visibleById.has(scopeId)) throw retrievalError("GRAPH_RETRIEVAL_SCOPE_NOT_VISIBLE");
    for (const seedId of value.seedResourceIds) {
      if (!visibleById.has(seedId)) throw retrievalError("GRAPH_RETRIEVAL_SEED_NOT_VISIBLE");
    }
    const effectiveIds = descendantsOf(value.authorizedScopeResourceIds, visibleResources);
    if (value.seedResourceIds.some((seedId) => !effectiveIds.has(seedId))) throw retrievalError("GRAPH_RETRIEVAL_SEED_OUTSIDE_SCOPE");
    if (value.requiredResourceIds.length > value.resultBudget
      || value.requiredTargetVersionIds.length > value.resultBudget
      || value.requiredResourceIds.some((resourceId) => !value.seedResourceIds.includes(resourceId))
      || value.requiredResourceIds.some((resourceId) => !effectiveIds.has(resourceId))) {
      throw retrievalError("GRAPH_RETRIEVAL_REQUIRED_RESOURCE_INVALID");
    }
    this.#assertAssertionSeeds(value.checkpointId, effectiveIds, value.seedAssertionIds);
    const cacheKey = createGraphRetrievalCacheKey(value);
    const cache = retrievalCaches.get(this.workspace) ?? new Map<string, GraphRetrievalResult>();
    retrievalCaches.set(this.workspace, cache);
    const cached = cache.get(cacheKey);
    if (cached) {
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      const result = structuredClone(cached);
      result.receipt.id = value.id;
      result.receipt.cycleId = value.cycleId;
      result.receipt.runId = value.runId;
      result.receipt.toolInvocationId = value.toolInvocationId;
      result.diagnostics.cache = "hit";
      return result;
    }

    const startedAt = this.#now();
    let truncated = false;
    let omittedCount = 0;
    let expandedEdges = 0;
    let consumedContentChars = 0;
    const timeExceeded = (): boolean => this.#now() - startedAt > value.cpuBudgetMs;
    const markTimeLimit = (): boolean => {
      if (!timeExceeded()) return false;
      truncated = true;
      return true;
    };

    const candidates: Candidate[] = [];
    let enumerationStopped = false;
    const appendCandidate = (candidate: Candidate): boolean => {
      if (enumerationStopped) return false;
      if (markTimeLimit()) {
        enumerationStopped = true;
        omittedCount += 1;
        return false;
      }
      candidates.push(candidate);
      return true;
    };

    const resourceVersions = this.#resourceVersions(value.checkpointId, effectiveIds);
    if (markTimeLimit()) {
      enumerationStopped = true;
      omittedCount += resourceVersions.length;
    }
    for (const resource of resourceVersions) {
      if (!appendCandidate({
      key: `resource:${resource.id}:${resource.versionId}`, targetKind: "resource", targetId: resource.id, targetVersionId: resource.versionId,
      resourceIds: [resource.id], text: resource.title, conflict: false, locator: null,
      evidence: { id: resource.id, versionId: resource.versionId, title: resource.title, type: resource.type, objectKind: resource.objectKind },
      })) break;
    }
    const seenDocumentVersions = new Set<string>();
    for (const resourceId of [...effectiveIds].sort()) {
      if (enumerationStopped || markTimeLimit()) { enumerationStopped = true; omittedCount += 1; break; }
      for (const document of this.#creativeDocuments.listAtCheckpoint(value.checkpointId, resourceId)) {
        if (markTimeLimit()) { enumerationStopped = true; omittedCount += 1; break; }
        const version = this.#documents.getStableForCreativeDocumentAtCheckpoint(document.id, value.checkpointId);
        if (!version || seenDocumentVersions.has(version.id)) continue;
        seenDocumentVersions.add(version.id);
        const availableChars = Math.min(value.contentBudgetChars - consumedContentChars, Math.max(0, (value.tokenBudget * 4) - consumedContentChars));
        const content = version.content.slice(0, Math.max(0, availableChars));
        consumedContentChars += content.length;
        if (content.length < version.content.length) { truncated = true; omittedCount += 1; }
        if (!appendCandidate({
          key: `document:${document.id}:${version.id}`, targetKind: "document", targetId: document.id, targetVersionId: version.id,
          resourceIds: [resourceId], text: `${document.title}\n${content}`, conflict: false,
          locator: { locator: `document:${document.id}#version:${version.id}`, versionId: version.id, hash: version.contentHash },
          evidence: { id: document.id, versionId: version.id, title: document.title, excerpt: content },
        })) break;
      }
      if (enumerationStopped) break;
      const legacy = this.#documents.getStableAtCheckpoint(resourceId, value.checkpointId);
      const resource = resourceVersions.find((item) => item.id === resourceId);
      if (legacy && resource && !seenDocumentVersions.has(legacy.id)) {
        seenDocumentVersions.add(legacy.id);
        const availableChars = Math.min(value.contentBudgetChars - consumedContentChars, Math.max(0, (value.tokenBudget * 4) - consumedContentChars));
        const content = legacy.content.slice(0, Math.max(0, availableChars));
        consumedContentChars += content.length;
        if (content.length < legacy.content.length) { truncated = true; omittedCount += 1; }
        if (!appendCandidate({
          key: `legacy-document:${resourceId}:${legacy.id}`, targetKind: "resource", targetId: resourceId, targetVersionId: resource.versionId,
          resourceIds: [resourceId], text: content, conflict: false,
          locator: { locator: `resource:${resourceId}#document-version:${legacy.id}`, versionId: legacy.id, hash: legacy.contentHash },
          evidence: { ...resource, stableDocument: { excerpt: content } },
        })) break;
      }
    }

    const assertions = this.#assertionsAtCheckpoint(value.checkpointId, effectiveIds);
    if (markTimeLimit()) { enumerationStopped = true; omittedCount += assertions.length; }
    for (const assertion of assertions) {
      if (enumerationStopped) break;
      const sources = this.#assertionSources(assertion.id, value.checkpointId, effectiveIds);
      if (!appendCandidate({
        key: `assertion:${assertion.id}`, targetKind: "assertion", targetId: assertion.assertionId, targetVersionId: assertion.id,
        resourceIds: unique([assertion.scopeId, ...readEntityReferences(assertion.object)]),
        graphNodeIds: [assertion.assertionId],
        text: `${assertion.subject}\n${assertion.predicate}\n${assertion.objectJson}`,
        subject: assertion.subject, predicate: assertion.predicate, conflict: assertion.status === "conflict", locator: null,
        evidence: { id: assertion.assertionId, versionId: assertion.id, scopeResourceId: assertion.scopeId, subject: assertion.subject, predicate: assertion.predicate, object: assertion.object, status: assertion.status, sources },
      })) break;
    }
    const relations = this.#relationsAtCheckpoint(value.checkpointId, effectiveIds);
    if (markTimeLimit()) { enumerationStopped = true; omittedCount += relations.length; }
    for (const relation of relations) {
      if (enumerationStopped) break;
      if (!appendCandidate({
        key: `relation:${relation.relationId}:${relation.id}`, targetKind: "relation", targetId: relation.relationId, targetVersionId: relation.id,
        resourceIds: [relation.sourceResourceId, relation.targetResourceId], text: `${relation.kind} ${relation.sourceResourceId} ${relation.targetResourceId}`,
        conflict: false, locator: null, evidence: {
          relationType: "structural", id: relation.relationId, versionId: relation.id,
          kind: relation.kind, sourceResourceId: relation.sourceResourceId, targetResourceId: relation.targetResourceId,
        },
      })) break;
    }
    const causalRelations = this.#causalRelationsAtCheckpoint(value.checkpointId, effectiveIds);
    if (markTimeLimit()) { enumerationStopped = true; omittedCount += causalRelations.length; }
    for (const relation of causalRelations) {
      if (enumerationStopped) break;
      if (!appendCandidate({
        key: `causal:${relation.relationId}:${relation.id}`,
        targetKind: "relation",
        targetId: relation.relationId,
        targetVersionId: relation.id,
        resourceIds: [relation.causeScopeId, relation.effectScopeId],
        graphNodeIds: value.causalDirection === "downstream"
          ? [relation.effectAssertionId]
          : value.causalDirection === "upstream"
            ? [relation.causeAssertionId]
            : [relation.causeAssertionId, relation.effectAssertionId],
        text: `${relation.kind} ${relation.mechanism} ${relation.causeSubject} ${relation.causePredicate} ${relation.effectSubject} ${relation.effectPredicate}`,
        conflict: relation.status === "conflict",
        locator: null,
        evidence: {
          relationType: "causal",
          id: relation.relationId,
          versionId: relation.id,
          kind: relation.kind,
          causeAssertionId: relation.causeAssertionId,
          effectAssertionId: relation.effectAssertionId,
          mechanismSummary: boundedText(relation.mechanism, 1_000),
          status: relation.status,
          epistemicStatus: relation.epistemicStatus,
          sourceReferences: this.#causalSourceReferences(relation.id),
        },
      })) break;
    }

    const edges: Edge[] = [];
    for (const relation of relations) {
      if (markTimeLimit()) { omittedCount += 1; break; }
      edges.push({ from: relation.sourceResourceId, to: relation.targetResourceId }, { from: relation.targetResourceId, to: relation.sourceResourceId });
    }
    for (const assertion of assertions) {
      if (markTimeLimit()) { omittedCount += 1; break; }
      edges.push({ from: assertion.scopeId, to: assertion.assertionId });
      edges.push({ from: assertion.assertionId, to: assertion.scopeId });
      for (const targetId of readEntityReferences(assertion.object)) {
        if (effectiveIds.has(targetId)) edges.push({ from: assertion.scopeId, to: targetId });
      }
    }
    for (const relation of causalRelations) {
      if (markTimeLimit()) { omittedCount += 1; break; }
      if (value.causalDirection === "downstream" || value.causalDirection === "both") {
        edges.push({ from: relation.causeAssertionId, to: relation.effectAssertionId });
      }
      if (value.causalDirection === "upstream" || value.causalDirection === "both") {
        edges.push({ from: relation.effectAssertionId, to: relation.causeAssertionId });
      }
    }
    edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
    const paths = new Map<string, string[]>();
    for (const seedId of [...value.seedResourceIds].sort()) paths.set(seedId, [seedId]);
    for (const seedId of [...value.seedAssertionIds].sort()) paths.set(seedId, [seedId]);
    let frontier = [...paths.keys()].sort();
    for (let hop = 0; hop < value.maxHops && frontier.length > 0 && !truncated; hop += 1) {
      const next: string[] = [];
      for (const from of frontier) {
        for (const edge of edges) {
          if (edge.from !== from) continue;
          if (expandedEdges >= value.expansionBudget || markTimeLimit()) { truncated = true; omittedCount += 1; break; }
          expandedEdges += 1;
          if (!paths.has(edge.to)) {
            paths.set(edge.to, [...(paths.get(from) ?? [from]), edge.to]);
            next.push(edge.to);
          }
        }
        if (truncated) break;
      }
      frontier = unique(next).sort();
    }

    const query = normalize(value.query);
    const aliases = value.aliases.map(normalize).filter(Boolean);
    const ranked: Array<{ candidate: Candidate; score: number; reasons: ReasonCode[]; path: string[] }> = [];
    for (const [index, candidate] of candidates.entries()) {
      if (markTimeLimit()) { omittedCount += candidates.length - index; break; }
      const reasons: ReasonCode[] = ["scope_match"];
      let score = 0.05;
      let matched = value.requiredTargetVersionIds.includes(candidate.targetVersionId);
      const text = normalize(candidate.text);
      if (candidate.subject && contains(normalize(candidate.subject), query)) { reasons.push("exact_subject"); score += 0.7; matched = true; }
      else if (candidate.targetKind === "resource" && contains(text, query)) { reasons.push("exact_subject"); score += 0.65; matched = true; }
      if (candidate.predicate && contains(normalize(candidate.predicate), query)) { reasons.push("exact_predicate"); score += 0.55; matched = true; }
      if (candidate.locator && contains(text, query)) { reasons.push("source_match"); score += 0.45; matched = true; }
      else if (candidate.targetKind === "relation" && contains(text, query)) { reasons.push("source_match"); score += 0.45; matched = true; }
      if (aliases.some((alias) => contains(text, alias))) { reasons.push("alias"); score += 0.35; matched = true; }
      const path = (candidate.graphNodeIds ?? candidate.resourceIds)
        .map((id) => paths.get(id)).find((value): value is string[] => Boolean(value && value.length > 1));
      if (path) { reasons.push("graph_hop"); score += 0.2 / path.length; matched = true; }
      if (!matched) continue;
      if (candidate.conflict) { reasons.push("conflict"); score += 0.1; }
      ranked.push({ candidate, score, reasons: unique(reasons), path: path ?? [] });
    }
    if (markTimeLimit()) { truncated = true; omittedCount += 1; }
    ranked.sort((left, right) => right.score - left.score
      || left.candidate.targetKind.localeCompare(right.candidate.targetKind)
      || left.candidate.targetId.localeCompare(right.candidate.targetId)
      || left.candidate.targetVersionId.localeCompare(right.candidate.targetVersionId));
    if (markTimeLimit()) {
      omittedCount += ranked.length;
      ranked.length = 0;
    }
    const requiredResources = ranked.filter((item) => item.candidate.targetKind === "resource" && value.requiredResourceIds.includes(item.candidate.targetId));
    const requiredVersions = ranked.filter((item) => value.requiredTargetVersionIds.includes(item.candidate.targetVersionId));
    if (requiredResources.length !== value.requiredResourceIds.length
      || requiredVersions.length !== value.requiredTargetVersionIds.length) {
      throw retrievalError("GRAPH_RETRIEVAL_REQUIRED_RESOURCE_INVALID");
    }
    const requiredRanked = [...new Set([...requiredResources, ...requiredVersions])];
    if (requiredRanked.length > value.resultBudget) throw retrievalError("GRAPH_RETRIEVAL_REQUIRED_RESOURCE_INVALID");
    const selectedRequired = new Set(requiredRanked);
    let selected = [...requiredRanked, ...ranked.filter((item) => !selectedRequired.has(item)).slice(0, value.resultBudget - requiredRanked.length)];
    selected.sort((left, right) => right.score - left.score
      || left.candidate.targetKind.localeCompare(right.candidate.targetKind)
      || left.candidate.targetId.localeCompare(right.candidate.targetId)
      || left.candidate.targetVersionId.localeCompare(right.candidate.targetVersionId));
    if (ranked.length > selected.length) { truncated = true; omittedCount += ranked.length - selected.length; }
    const hits: GraphRetrievalEvidenceHit[] = [];
    for (const [index, item] of selected.entries()) {
      if (markTimeLimit()) {
        omittedCount += selected.length - index;
        selected = selected.slice(0, index);
        break;
      }
      hits.push(materializeHit(item.candidate, index + 1, item.score, item.reasons, item.path));
    }
    const coverage: "complete" | "partial" | "unknown" = truncated ? "partial" : selected.length === 0 ? "unknown" : "complete";
    const receipt = {
      id: value.id, cycleId: value.cycleId, runId: value.runId, toolInvocationId: value.toolInvocationId,
      branchId: value.branchId, checkpointId: value.checkpointId, lens: "creator" as const,
      effectiveScopeResourceIds: [...value.authorizedScopeResourceIds], query: value.query, aliases: value.aliases,
      validTime: null, recordedTime: null, maxHops: value.maxHops, cpuBudgetMs: value.cpuBudgetMs,
      expansionBudget: value.expansionBudget, resultBudget: value.resultBudget, tokenBudget: value.tokenBudget,
      policyVersion: value.policyVersion, coverage: { state: coverage, searchedScopeCount: value.authorizedScopeResourceIds.length, omittedCount },
      truncated, links: selected.map((item, index) => ({
        rank: index + 1, targetKind: item.candidate.targetKind, targetId: item.candidate.targetId, targetVersionId: item.candidate.targetVersionId,
        score: Number(item.score.toFixed(6)), reasonCodes: item.reasons, pathTargetIds: item.path,
        stableLocator: item.candidate.locator?.locator ?? null, stableVersionId: item.candidate.locator?.versionId ?? null, stableHash: item.candidate.locator?.hash ?? null,
      })),
    };
    const result: GraphRetrievalResult = {
      receipt,
      hits,
      effectiveScopeResourceIds: [...value.authorizedScopeResourceIds],
      diagnostics: {
        candidateCount: candidates.length,
        expandedEdges,
        consumedContentChars,
        coverage,
        truncated,
        cache: "miss",
      },
    };
    if (!result.diagnostics.truncated) {
      cache.set(cacheKey, structuredClone(result));
      while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    }
    return result;
  }

  #assertCheckpointBranch(checkpointId: string, branchId: string): void {
    if (!this.workspace.db.prepare("SELECT 1 FROM checkpoints WHERE id = ? AND branch_id = ?").get(checkpointId, branchId)) {
      throw retrievalError("GRAPH_RETRIEVAL_CHECKPOINT_BRANCH_MISMATCH");
    }
  }

  #resourceVersions(checkpointId: string, ids: ReadonlySet<string>): Array<{ id: string; versionId: string; title: string; type: string; objectKind: string }> {
    if (ids.size === 0) return [];
    const placeholders = [...ids].map(() => "?").join(", ");
    return this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0 UNION ALL SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT rr.*, ancestry.depth, ROW_NUMBER() OVER (PARTITION BY rr.resource_id ORDER BY ancestry.depth ASC) AS version_rank
        FROM resource_revisions rr JOIN ancestry ON ancestry.checkpoint_id = rr.created_checkpoint_id
      ) SELECT resource_id AS id, id AS version_id, title, type, object_kind FROM ranked WHERE version_rank = 1 AND state = 'active' AND resource_id IN (${placeholders}) ORDER BY resource_id
    `).all(checkpointId, ...ids).map((row) => ({ id: readString(row, "id"), versionId: readString(row, "version_id"), title: readString(row, "title"), type: readString(row, "type"), objectKind: readString(row, "object_kind") }));
  }

  #assertionsAtCheckpoint(checkpointId: string, ids: ReadonlySet<string>): Array<{ id: string; assertionId: string; scopeId: string; subject: string; predicate: string; object: Record<string, unknown>; objectJson: string; status: string }> {
    if (ids.size === 0) return [];
    const placeholders = [...ids].map(() => "?").join(", ");
    return this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0 UNION ALL SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT av.*, ancestry.depth, ROW_NUMBER() OVER (PARTITION BY av.assertion_id ORDER BY ancestry.depth ASC) AS version_rank
        FROM assertion_versions av JOIN ancestry ON ancestry.checkpoint_id = av.created_checkpoint_id
      ) SELECT * FROM ranked WHERE version_rank = 1 AND status IN ('current', 'conflict') AND scope_id IN (${placeholders}) ORDER BY subject, predicate, assertion_id
    `).all(checkpointId, ...ids).map((row) => {
      const objectJson = readString(row, "object_json");
      return { id: readString(row, "id"), assertionId: readString(row, "assertion_id"), scopeId: readString(row, "scope_id"), subject: readString(row, "subject"), predicate: readString(row, "predicate"), object: parseObject(objectJson), objectJson, status: readString(row, "status") };
    });
  }

  #relationsAtCheckpoint(checkpointId: string, ids: ReadonlySet<string>): Array<{ id: string; relationId: string; kind: string; sourceResourceId: string; targetResourceId: string }> {
    if (ids.size === 0) return [];
    const placeholders = [...ids].map(() => "?").join(", ");
    return this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0 UNION ALL SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT crv.*, ancestry.depth, ROW_NUMBER() OVER (PARTITION BY crv.relation_id ORDER BY ancestry.depth ASC) AS version_rank
        FROM creative_relation_versions crv JOIN ancestry ON ancestry.checkpoint_id = crv.created_checkpoint_id
      ) SELECT * FROM ranked WHERE version_rank = 1 AND state = 'active' AND source_resource_id IN (${placeholders}) AND target_resource_id IN (${placeholders}) ORDER BY kind, source_resource_id, target_resource_id, relation_id
    `).all(checkpointId, ...ids, ...ids).map((row) => ({ id: readString(row, "id"), relationId: readString(row, "relation_id"), kind: readString(row, "kind"), sourceResourceId: readString(row, "source_resource_id"), targetResourceId: readString(row, "target_resource_id") }));
  }

  #causalRelationsAtCheckpoint(checkpointId: string, ids: ReadonlySet<string>): Array<{
    id: string;
    relationId: string;
    kind: "causes" | "enables" | "constrains" | "prevents" | "amplifies" | "mitigates" | "depends_on";
    causeAssertionId: string;
    effectAssertionId: string;
    causeScopeId: string;
    effectScopeId: string;
    causeSubject: string;
    causePredicate: string;
    effectSubject: string;
    effectPredicate: string;
    mechanism: string;
    status: "current" | "conflict";
    epistemicStatus: "confirmed" | "inferred" | "disputed";
  }> {
    if (ids.size === 0) return [];
    const placeholders = [...ids].map(() => "?").join(", ");
    return this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0 UNION ALL SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id WHERE c.parent_checkpoint_id IS NOT NULL
      ), causal_ranked AS (
        SELECT versions.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY versions.relation_id ORDER BY ancestry.depth ASC) AS version_rank
        FROM causal_relation_versions versions
        JOIN ancestry ON ancestry.checkpoint_id = versions.created_checkpoint_id
      ), assertion_ranked AS (
        SELECT versions.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY versions.assertion_id ORDER BY ancestry.depth ASC) AS version_rank
        FROM assertion_versions versions
        JOIN ancestry ON ancestry.checkpoint_id = versions.created_checkpoint_id
      )
      SELECT causal_ranked.id, causal_ranked.relation_id, causal_ranked.mechanism,
        causal_ranked.status, causal_ranked.epistemic_status,
        identities.kind, identities.cause_assertion_id, identities.effect_assertion_id,
        cause.scope_id AS cause_scope_id, cause.subject AS cause_subject, cause.predicate AS cause_predicate,
        effect.scope_id AS effect_scope_id, effect.subject AS effect_subject, effect.predicate AS effect_predicate
      FROM causal_ranked
      JOIN causal_relations identities ON identities.id = causal_ranked.relation_id
      JOIN assertion_ranked cause ON cause.assertion_id = identities.cause_assertion_id
        AND cause.version_rank = 1 AND cause.status IN ('current', 'conflict')
      JOIN assertion_ranked effect ON effect.assertion_id = identities.effect_assertion_id
        AND effect.version_rank = 1 AND effect.status IN ('current', 'conflict')
      WHERE causal_ranked.version_rank = 1 AND causal_ranked.status IN ('current', 'conflict')
        AND cause.scope_id IN (${placeholders}) AND effect.scope_id IN (${placeholders})
      ORDER BY identities.kind, identities.cause_assertion_id, identities.effect_assertion_id, identities.id
    `).all(checkpointId, ...ids, ...ids).map((row) => ({
      id: readString(row, "id"),
      relationId: readString(row, "relation_id"),
      kind: readOneOf(row, "kind", ["causes", "enables", "constrains", "prevents", "amplifies", "mitigates", "depends_on"] as const),
      causeAssertionId: readString(row, "cause_assertion_id"),
      effectAssertionId: readString(row, "effect_assertion_id"),
      causeScopeId: readString(row, "cause_scope_id"),
      effectScopeId: readString(row, "effect_scope_id"),
      causeSubject: readString(row, "cause_subject"),
      causePredicate: readString(row, "cause_predicate"),
      effectSubject: readString(row, "effect_subject"),
      effectPredicate: readString(row, "effect_predicate"),
      mechanism: readString(row, "mechanism"),
      status: readOneOf(row, "status", ["current", "conflict"] as const),
      epistemicStatus: readOneOf(row, "epistemic_status", ["confirmed", "inferred", "disputed"] as const),
    }));
  }

  #causalSourceReferences(versionId: string): Array<{
    kind: "document" | "evidence" | "assertion";
    versionId: string;
    locator: string;
  }> {
    return (this.workspace.db.prepare(`
      SELECT source_kind, source_version_id, stable_locator
      FROM causal_relation_sources WHERE relation_version_id = ? ORDER BY ordinal
    `).all(versionId) as Row[]).map((row) => ({
      kind: readOneOf(row, "source_kind", ["document", "evidence", "assertion"] as const),
      versionId: readString(row, "source_version_id"),
      locator: boundedText(readString(row, "stable_locator"), 1_000),
    }));
  }

  #assertAssertionSeeds(checkpointId: string, ids: ReadonlySet<string>, seedAssertionIds: readonly string[]): void {
    if (seedAssertionIds.length === 0) return;
    if (ids.size === 0) throw retrievalError("GRAPH_RETRIEVAL_SEED_NOT_VISIBLE");
    const scopePlaceholders = [...ids].map(() => "?").join(", ");
    const seedPlaceholders = seedAssertionIds.map(() => "?").join(", ");
    const row = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0 UNION ALL SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT versions.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY versions.assertion_id ORDER BY ancestry.depth ASC) AS version_rank
        FROM assertion_versions versions JOIN ancestry ON ancestry.checkpoint_id = versions.created_checkpoint_id
      )
      SELECT COUNT(*) AS count FROM ranked
      WHERE version_rank = 1 AND status IN ('current', 'conflict')
        AND scope_id IN (${scopePlaceholders}) AND assertion_id IN (${seedPlaceholders})
    `).get(checkpointId, ...ids, ...seedAssertionIds) as { count: number };
    if (row.count !== seedAssertionIds.length) throw retrievalError("GRAPH_RETRIEVAL_SEED_NOT_VISIBLE");
  }

  #assertionSources(versionId: string, checkpointId: string, effectiveIds: ReadonlySet<string>): GraphRetrievalAssertionSource[] {
    const sources = this.workspace.db.prepare(`
      SELECT source_records.kind, source_records.ref FROM assertion_sources
      JOIN source_records ON source_records.id = assertion_sources.source_id
      WHERE assertion_sources.assertion_version_id = ? ORDER BY source_records.id
    `).all(versionId) as Row[];
    return sources.map((row) => {
      const kind = readString(row, "kind");
      if (kind !== "document_version") return { type: "unresolved", reason: "unsupported_source" };
      const document = this.#projectDocumentSource(readString(row, "ref"), checkpointId, effectiveIds);
      return document ?? { type: "unresolved", reason: "source_not_active" };
    });
  }

  #projectDocumentSource(versionId: string, checkpointId: string, effectiveIds: ReadonlySet<string>): Extract<GraphRetrievalAssertionSource, { type: "stable_document" }> | null {
    if (effectiveIds.size === 0) return null;
    const placeholders = [...effectiveIds].map(() => "?").join(", ");
    const row = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0 UNION ALL SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id WHERE c.parent_checkpoint_id IS NOT NULL
      ), resource_ranked AS (
        SELECT rr.*, ROW_NUMBER() OVER (PARTITION BY rr.resource_id ORDER BY ancestry.depth ASC) AS version_rank
        FROM resource_revisions rr JOIN ancestry ON ancestry.checkpoint_id = rr.created_checkpoint_id
      )
      SELECT dv.resource_id, resource_ranked.title, dv.id AS version_id
      FROM document_versions dv
      JOIN ancestry ON ancestry.checkpoint_id = dv.created_checkpoint_id
      JOIN resource_ranked ON resource_ranked.resource_id = dv.resource_id
      WHERE dv.id = ? AND resource_ranked.version_rank = 1 AND resource_ranked.state = 'active'
        AND dv.resource_id IN (${placeholders})
    `).get(checkpointId, versionId, ...effectiveIds) as Row | undefined;
    if (!row) return null;
    return {
      type: "stable_document",
      document: { resourceId: readString(row, "resource_id"), title: readString(row, "title"), versionId: readString(row, "version_id") },
    };
  }
}

function descendantsOf(roots: readonly string[], resources: Array<{ id: string; parentId: string | null }>): Set<string> {
  const children = new Map<string, string[]>();
  for (const resource of resources) if (resource.parentId) children.set(resource.parentId, [...(children.get(resource.parentId) ?? []), resource.id]);
  const result = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length) for (const child of children.get(queue.shift()!) ?? []) if (!result.has(child)) { result.add(child); queue.push(child); }
  return result;
}

function readEntityReferences(object: Record<string, unknown>): string[] {
  return [object.entityRef, ...(Array.isArray(object.entityRefs) ? object.entityRefs : [])].flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const id = (value as Record<string, unknown>).resourceId;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}

function materializeHit(candidate: Candidate, rank: number, score: number, reasonCodes: ReasonCode[], pathTargetIds: string[]): GraphRetrievalEvidenceHit {
  const common = { rank, targetKind: candidate.targetKind, targetId: candidate.targetId, targetVersionId: candidate.targetVersionId, score: Number(score.toFixed(6)), reasonCodes, pathTargetIds };
  if (candidate.targetKind === "document") {
    const evidence = candidate.evidence as { id: string; versionId: string; title: string; excerpt: string };
    if (!candidate.locator) throw retrievalError("GRAPH_RETRIEVAL_DATA_INVALID");
    return { ...common, targetKind: "document", document: { ...evidence, locator: candidate.locator.locator, contentHash: candidate.locator.hash } };
  }
  if (candidate.targetKind === "assertion") {
    return { ...common, targetKind: "assertion", assertion: candidate.evidence as Extract<GraphRetrievalEvidenceHit, { targetKind: "assertion" }>["assertion"] };
  }
  if (candidate.targetKind === "relation") {
    return { ...common, targetKind: "relation", relation: candidate.evidence as Extract<GraphRetrievalEvidenceHit, { targetKind: "relation" }>["relation"] };
  }
  const evidence = candidate.evidence as { id: string; versionId: string; title: string; type: string; objectKind: string; stableDocument?: { excerpt: string } };
  return { ...common, targetKind: "resource", resource: { id: evidence.id, versionId: evidence.versionId, title: evidence.title, type: evidence.type, objectKind: evidence.objectKind }, stableDocument: candidate.locator ? { excerpt: evidence.stableDocument?.excerpt ?? "", locator: candidate.locator.locator, versionId: candidate.locator.versionId, contentHash: candidate.locator.hash } : null };
}

function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("zh-Hans").replace(/\s+/gu, " ").trim(); }
function contains(text: string, term: string): boolean { return Boolean(term) && text.includes(term); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function parseObject(value: string): Record<string, unknown> { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function readString(row: Record<string, SQLOutputValue>, key: string): string { const value = row[key]; if (typeof value !== "string") throw retrievalError("GRAPH_RETRIEVAL_DATA_INVALID"); return value; }
function readOneOf<const T extends readonly string[]>(row: Row, key: string, values: T): T[number] {
  const value = readString(row, key);
  if (!values.includes(value)) throw retrievalError("GRAPH_RETRIEVAL_DATA_INVALID");
  return value as T[number];
}
function boundedText(value: string, maxLength: number): string {
  const normalized = value
    .replace(/\b[A-Za-z]:\\[^\s，。；,;）)\]}]+/g, "[本地路径已隐藏]")
    .replace(/\\\\[^\\\s]+\\[^\s，。；,;）)\]}]+/g, "[本地路径已隐藏]")
    .trim()
    .replace(/\s+/g, " ") || "未命名内容";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
export function createGraphRetrievalCacheKey(value: GraphRetrievalRequest): string {
  return JSON.stringify({
    branchId: value.branchId,
    checkpointId: value.checkpointId,
    lens: value.lens,
    authorizedScopeResourceIds: value.authorizedScopeResourceIds,
    seedResourceIds: value.seedResourceIds,
    seedAssertionIds: value.seedAssertionIds,
    requiredResourceIds: value.requiredResourceIds,
    requiredTargetVersionIds: value.requiredTargetVersionIds,
    query: value.query,
    aliases: value.aliases,
    validTime: value.validTime,
    recordedTime: value.recordedTime,
    maxHops: value.maxHops,
    causalDirection: value.causalDirection,
    budgets: {
      cpuBudgetMs: value.cpuBudgetMs,
      expansionBudget: value.expansionBudget,
      resultBudget: value.resultBudget,
      tokenBudget: value.tokenBudget,
      contentBudgetChars: value.contentBudgetChars,
    },
    policyVersion: value.policyVersion,
  });
}
function retrievalError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
