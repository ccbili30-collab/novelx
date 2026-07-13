import { createHash } from "node:crypto";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { ResourceRepository, type ResourceRecord, type ResourceType } from "../workspace/resourceRepository";
import { CheckpointRepository } from "../version/checkpointRepository";
import {
  AssertionRepository,
  type SourcedAssertionRecord,
  type StoredAssertionSource,
} from "./assertionRepository";

export type SemanticGraphNodeKind = "subject" | "fact" | "entity";
export type SemanticGraphStatus = "current" | "conflict";

export interface SemanticGraphScope {
  id: string;
  label: string;
  type: string;
}

export interface SemanticGraphNode {
  id: string;
  kind: SemanticGraphNodeKind;
  label: string;
  description: string;
  semanticType: string;
  scope: SemanticGraphScope;
  status: SemanticGraphStatus;
  conflict: boolean;
  sourceCount: number;
  relationCount: number;
}

export interface SemanticGraphEdge {
  id: string;
  kind: "predicate" | "entity_reference";
  sourceNodeId: string;
  targetNodeId: string;
  label: string;
  status: SemanticGraphStatus;
}

export interface SemanticGraphSnapshot {
  lens: {
    type: "creator";
    label: "创作者视角";
    characterLensAvailable: false;
    limitation: "角色认知视角尚未实现。";
  };
  nodes: SemanticGraphNode[];
  edges: SemanticGraphEdge[];
  filterOptions: {
    nodeKinds: SemanticGraphNodeKind[];
    semanticTypes: string[];
    scopeTypes: string[];
    statuses: SemanticGraphStatus[];
  };
}

export interface SemanticGraphSourceSummary {
  type: "change_set" | "stable_document" | "recorded" | "unavailable";
  label: string;
}

export type SemanticGraphNodeDetail =
  | {
      kind: "fact";
      subject: string;
      predicate: string;
      valueSummary: string;
      status: SemanticGraphStatus;
      scope: SemanticGraphScope;
      sources: SemanticGraphSourceSummary[];
    }
  | {
      kind: "subject" | "entity";
      label: string;
      description: string;
      semanticType: string;
      status: SemanticGraphStatus;
      scope: SemanticGraphScope;
    };

export interface SemanticGraphInspector {
  node: SemanticGraphNode;
  detail: SemanticGraphNodeDetail;
  relations: Array<{
    edgeId: string;
    direction: "incoming" | "outgoing";
    kind: SemanticGraphEdge["kind"];
    label: string;
    neighborId: string;
    neighborLabel: string;
    neighborKind: SemanticGraphNodeKind;
  }>;
}

interface BuiltGraph {
  snapshot: SemanticGraphSnapshot;
  details: Map<string, SemanticGraphNodeDetail>;
}

export class SemanticGraphService {
  readonly #assertions: AssertionRepository;
  readonly #checkpoints: CheckpointRepository;
  readonly #resources: ResourceRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#assertions = new AssertionRepository(workspace);
    this.#checkpoints = new CheckpointRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
  }

  getSnapshot(): SemanticGraphSnapshot {
    return this.#build().snapshot;
  }

  getSnapshotForScopes(scopeResourceIds: readonly string[]): SemanticGraphSnapshot {
    return filterSnapshotByScopes(this.#build().snapshot, normalizeScopeIds(scopeResourceIds));
  }

  inspectNode(nodeId: string, scopeResourceIds?: readonly string[]): SemanticGraphInspector {
    const graph = this.#build();
    const snapshot = scopeResourceIds
      ? filterSnapshotByScopes(graph.snapshot, normalizeScopeIds(scopeResourceIds))
      : graph.snapshot;
    const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
    const detail = graph.details.get(nodeId);
    if (!node || !detail) throw graphError("GRAPH_NODE_NOT_FOUND", "Graph node was not found on the current branch.");
    const nodes = new Map(snapshot.nodes.map((candidate) => [candidate.id, candidate]));
    const relations = snapshot.edges.flatMap((edge) => {
      const direction = edge.sourceNodeId === nodeId
        ? "outgoing" as const
        : edge.targetNodeId === nodeId
          ? "incoming" as const
          : null;
      if (!direction) return [];
      const neighborId = direction === "outgoing" ? edge.targetNodeId : edge.sourceNodeId;
      const neighbor = nodes.get(neighborId);
      if (!neighbor) return [];
      return [{
        edgeId: edge.id,
        direction,
        kind: edge.kind,
        label: edge.label,
        neighborId,
        neighborLabel: neighbor.label,
        neighborKind: neighbor.kind,
      }];
    });
    return { node, detail, relations };
  }

  #build(): BuiltGraph {
    const branch = this.#checkpoints.getActiveBranch();
    const activeResources = new Map(this.#resources.listCurrent(branch.id).map((resource) => [resource.id, resource]));
    const assertions = this.#assertions.listLatestForGraph(branch.id);
    const nodes = new Map<string, SemanticGraphNode>();
    const edges: SemanticGraphEdge[] = [];
    const details = new Map<string, SemanticGraphNodeDetail>();

    for (const assertion of assertions) {
      const status = assertion.status as SemanticGraphStatus;
      const scope = projectScope(assertion, activeResources.get(assertion.scopeId));
      const sources = assertion.sources.map((source) => this.#projectSource(source, branch.id));
      const subjectId = safeId("subject", assertion.scopeId, assertion.subject);
      const factId = safeId("fact", assertion.versionId);
      const subjectNode = upsertSemanticNode(nodes, {
        id: subjectId,
        kind: "subject",
        label: boundedText(assertion.subject, 500),
        description: "断言主题",
        semanticType: "concept",
        scope,
        status,
        conflict: status === "conflict",
        sourceCount: sources.length,
        relationCount: 0,
      });
      details.set(subjectId, {
        kind: "subject",
        label: subjectNode.label,
        description: subjectNode.description,
        semanticType: subjectNode.semanticType,
        status: subjectNode.status,
        scope: subjectNode.scope,
      });

      const valueSummary = summarizeAssertionObject(assertion.object, activeResources);
      const factNode: SemanticGraphNode = {
        id: factId,
        kind: "fact",
        label: boundedText(`${assertion.subject} · ${assertion.predicate}`, 500),
        description: valueSummary,
        semanticType: "assertion",
        scope,
        status,
        conflict: status === "conflict",
        sourceCount: sources.length,
        relationCount: 0,
      };
      nodes.set(factId, factNode);
      details.set(factId, {
        kind: "fact",
        subject: boundedText(assertion.subject, 500),
        predicate: boundedText(assertion.predicate, 240),
        valueSummary,
        status,
        scope,
        sources,
      });
      edges.push({
        id: safeId("edge", "predicate", assertion.versionId),
        kind: "predicate",
        sourceNodeId: subjectId,
        targetNodeId: factId,
        label: boundedText(assertion.predicate, 240),
        status,
      });

      for (const [index, reference] of readEntityReferences(assertion.object).entries()) {
        const resource = activeResources.get(reference.resourceId);
        if (!resource) continue;
        const entityId = safeId("entity", resource.id);
        const entityNode = upsertSemanticNode(nodes, {
          id: entityId,
          kind: "entity",
          label: boundedText(resource.title, 240),
          description: `${resourceTypeLabel(resource.type)}资源`,
          semanticType: resource.type,
          scope,
          status,
          conflict: status === "conflict",
          sourceCount: sources.length,
          relationCount: 0,
        });
        details.set(entityId, {
          kind: "entity",
          label: entityNode.label,
          description: entityNode.description,
          semanticType: entityNode.semanticType,
          status: entityNode.status,
          scope: entityNode.scope,
        });
        edges.push({
          id: safeId("edge", "entity", assertion.versionId, String(index), resource.id),
          kind: "entity_reference",
          sourceNodeId: factId,
          targetNodeId: entityId,
          label: boundedText(reference.relation || "关联实体", 240),
          status,
        });
      }
    }

    const relationCounts = new Map<string, number>();
    for (const edge of edges) {
      relationCounts.set(edge.sourceNodeId, (relationCounts.get(edge.sourceNodeId) || 0) + 1);
      relationCounts.set(edge.targetNodeId, (relationCounts.get(edge.targetNodeId) || 0) + 1);
    }
    const projectedNodes = [...nodes.values()].map((node) => ({
      ...node,
      relationCount: relationCounts.get(node.id) || 0,
    }));

    return {
      snapshot: {
        lens: {
          type: "creator",
          label: "创作者视角",
          characterLensAvailable: false,
          limitation: "角色认知视角尚未实现。",
        },
        nodes: projectedNodes,
        edges,
        filterOptions: {
          nodeKinds: uniqueSorted(projectedNodes.map((node) => node.kind)),
          semanticTypes: uniqueSorted(projectedNodes.map((node) => node.semanticType)),
          scopeTypes: uniqueSorted(projectedNodes.map((node) => node.scope.type)),
          statuses: uniqueSorted(projectedNodes.map((node) => node.status)),
        },
      },
      details,
    };
  }

  #projectSource(source: StoredAssertionSource, branchId: string): SemanticGraphSourceSummary {
    if (source.kind === "confirmed_change_set") {
      const identity = parseChangeSetSource(source.ref);
      if (!identity) return { type: "unavailable", label: "来源不可用" };
      const row = this.workspace.db.prepare(`
        WITH RECURSIVE ancestry(checkpoint_id) AS (
          SELECT head_checkpoint_id FROM branches WHERE id = ?
          UNION ALL
          SELECT checkpoints.parent_checkpoint_id FROM checkpoints
          JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
          WHERE checkpoints.parent_checkpoint_id IS NOT NULL
        )
        SELECT change_sets.summary FROM change_sets
        JOIN ancestry ON ancestry.checkpoint_id = change_sets.committed_checkpoint_id
        LEFT JOIN change_set_items ON change_set_items.change_set_id = change_sets.id
          AND change_set_items.id = ?
        WHERE change_sets.id = ? AND change_sets.status = 'committed'
          AND (? IS NULL OR change_set_items.decision = 'accepted')
      `).get(branchId, identity.itemId, identity.changeSetId, identity.itemId) as { summary: string } | undefined;
      return row
        ? { type: "change_set", label: boundedText(`已确认变更：${row.summary}`, 500) }
        : { type: "unavailable", label: "来源不可用" };
    }
    if (source.kind === "document_version") {
      const row = this.workspace.db.prepare(`
        WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
          SELECT head_checkpoint_id, 0 FROM branches WHERE id = ?
          UNION ALL
          SELECT checkpoints.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints
          JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
          WHERE checkpoints.parent_checkpoint_id IS NOT NULL
        ), resource_ranked AS (
          SELECT rr.resource_id, rr.title, rr.state,
            ROW_NUMBER() OVER (PARTITION BY rr.resource_id ORDER BY ancestry.depth ASC) AS revision_rank
          FROM resource_revisions rr
          JOIN ancestry ON ancestry.checkpoint_id = rr.created_checkpoint_id
        )
        SELECT resource_ranked.title FROM document_versions
        JOIN ancestry ON ancestry.checkpoint_id = document_versions.created_checkpoint_id
        JOIN resource_ranked ON resource_ranked.resource_id = document_versions.resource_id
          AND resource_ranked.revision_rank = 1 AND resource_ranked.state = 'active'
        WHERE document_versions.id = ?
      `).get(branchId, source.ref) as { title: string } | undefined;
      return row
        ? { type: "stable_document", label: boundedText(`稳定文档《${row.title}》`, 500) }
        : { type: "unavailable", label: "来源不可用" };
    }
    return { type: "recorded", label: "已记录来源" };
  }
}

function normalizeScopeIds(scopeResourceIds: readonly string[]): Set<string> {
  if (scopeResourceIds.length > 100) throw graphError("GRAPH_SCOPE_INVALID", "Graph scope is too large.");
  const normalized = new Set<string>();
  for (const value of scopeResourceIds) {
    const id = value.trim();
    if (!id || id.length > 120) throw graphError("GRAPH_SCOPE_INVALID", "Graph scope contains an invalid resource id.");
    normalized.add(safeId("scope", id));
  }
  return normalized;
}

function filterSnapshotByScopes(snapshot: SemanticGraphSnapshot, scopeIds: ReadonlySet<string>): SemanticGraphSnapshot {
  const nodes = snapshot.nodes.filter((node) => scopeIds.has(node.scope.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = snapshot.edges.filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId));
  return {
    lens: snapshot.lens,
    nodes,
    edges,
    filterOptions: {
      nodeKinds: uniqueSorted(nodes.map((node) => node.kind)),
      semanticTypes: uniqueSorted(nodes.map((node) => node.semanticType)),
      scopeTypes: uniqueSorted(nodes.map((node) => node.scope.type)),
      statuses: uniqueSorted(nodes.map((node) => node.status)),
    },
  };
}

function projectScope(assertion: SourcedAssertionRecord, resource: ResourceRecord | undefined): SemanticGraphScope {
  return {
    id: safeId("scope", assertion.scopeId),
    label: boundedText(resource?.title || scopeTypeLabel(assertion.scopeType), 240),
    type: boundedText(resource?.type || assertion.scopeType || "custom", 80),
  };
}

function upsertSemanticNode(nodes: Map<string, SemanticGraphNode>, candidate: SemanticGraphNode): SemanticGraphNode {
  const existing = nodes.get(candidate.id);
  if (!existing) {
    nodes.set(candidate.id, candidate);
    return candidate;
  }
  if (candidate.conflict && !existing.conflict) {
    const updated = { ...existing, status: "conflict" as const, conflict: true };
    nodes.set(candidate.id, updated);
    return updated;
  }
  return existing;
}

function readEntityReferences(object: Record<string, unknown>): Array<{ resourceId: string; relation: string | null }> {
  const values = [object.entityRef, ...(Array.isArray(object.entityRefs) ? object.entityRefs : [])];
  return values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const resourceId = typeof record.resourceId === "string" ? record.resourceId.trim() : "";
    if (!resourceId) return [];
    const relation = typeof record.relation === "string" && record.relation.trim()
      ? record.relation.trim()
      : null;
    return [{ resourceId, relation }];
  });
}

function summarizeAssertionObject(
  object: Record<string, unknown>,
  resources: ReadonlyMap<string, ResourceRecord>,
): string {
  if (typeof object.text === "string" && object.text.trim()) return boundedText(object.text, 1000);
  const entityLabels = readEntityReferences(object)
    .map((reference) => resources.get(reference.resourceId)?.title)
    .filter((label): label is string => Boolean(label));
  const scalarValues = Object.entries(object)
    .filter(([key]) => key !== "entityRef" && key !== "entityRefs")
    .flatMap(([, value]) => {
      if (typeof value === "string" && value.trim()) return [value.trim()];
      if (typeof value === "number" || typeof value === "boolean") return [String(value)];
      return [];
    });
  const summary = [...scalarValues, ...entityLabels].join("；");
  return boundedText(summary || "结构化事实", 1000);
}

function parseChangeSetSource(ref: string): { changeSetId: string; itemId: string | null } | null {
  const separator = ref.indexOf(":");
  if (separator < 0) return ref ? { changeSetId: ref, itemId: null } : null;
  const changeSetId = ref.slice(0, separator);
  const itemId = ref.slice(separator + 1);
  return changeSetId && itemId ? { changeSetId, itemId } : null;
}

function safeId(...parts: string[]): string {
  return `graph-${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 24)}`;
}

function boundedText(value: string, maxLength: number): string {
  const normalized = value
    .replace(/\b[A-Za-z]:\\[^\s，。；,;）)\]}]+/g, "[本地路径已隐藏]")
    .replace(/\\\\[^\\\s]+\\[^\s，。；,;）)\]}]+/g, "[本地路径已隐藏]")
    .trim()
    .replace(/\s+/g, " ") || "未命名内容";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function resourceTypeLabel(type: ResourceType): string {
  return ({ world: "世界", oc: "OC", story: "故事", graph: "图谱", timeline: "时间线", asset: "资产" })[type];
}

function scopeTypeLabel(type: string): string {
  return ({ world: "世界范围", oc: "OC 范围", story: "故事范围", graph: "图谱范围", timeline: "时间线范围", asset: "资产范围" } as Record<string, string>)[type]
    || "自定义范围";
}

function graphError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
