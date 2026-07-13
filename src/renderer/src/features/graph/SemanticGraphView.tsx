import { useEffect, useMemo, useRef, useState } from "react";
import dagre from "@dagrejs/dagre";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AlertTriangle, Focus, LoaderCircle, Search, Share2 } from "lucide-react";
import type { SemanticGraphInspector, SemanticGraphSnapshot } from "../../../../shared/ipcContract";

type GraphNodeRecord = SemanticGraphSnapshot["nodes"][number];
type GraphNodeData = { record: GraphNodeRecord };
type FlowNode = Node<GraphNodeData, "semantic">;
type KindFilter = "all" | GraphNodeRecord["kind"];

const NODE_WIDTH = 184;
const NODE_HEIGHT = 68;
const nodeTypes = { semantic: SemanticNodeCard };

export function SemanticGraphView({
  refreshKey,
  snapshot: suppliedSnapshot,
  scopeResourceIds,
  embedded = false,
}: {
  refreshKey: number;
  snapshot?: SemanticGraphSnapshot;
  scopeResourceIds?: string[];
  embedded?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<SemanticGraphSnapshot | null>(null);
  const [inspector, setInspector] = useState<SemanticGraphInspector | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [semanticType, setSemanticType] = useState("all");
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [focusNeighborhood, setFocusNeighborhood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectorLoading, setInspectorLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setError(null);
    setInspector(null);
    setSelectedId(null);
    if (suppliedSnapshot) {
      setSnapshot(suppliedSnapshot);
      return () => { active = false; };
    }
    setSnapshot(null);
    void window.novaxDesktop.graph.getSnapshot().then((result) => {
      if (!active) return;
      if (result.ok) setSnapshot(result.graph);
      else setError(result.error.message);
    }).catch((cause: unknown) => {
      if (active) setError(readErrorMessage(cause));
    });
    return () => { active = false; };
  }, [refreshKey, suppliedSnapshot]);

  const visibleGraph = useMemo(() => {
    if (!snapshot) return { nodes: [] as FlowNode[], edges: [] as Edge[] };
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    let records = snapshot.nodes.filter((node) => {
      if (kind !== "all" && node.kind !== kind) return false;
      if (semanticType !== "all" && node.semanticType !== semanticType) return false;
      if (conflictsOnly && !node.conflict) return false;
      return !normalizedQuery || `${node.label}\n${node.description}\n${node.scope.label}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery);
    });

    if (focusNeighborhood && selectedId) {
      const neighborhood = new Set([selectedId]);
      for (const edge of snapshot.edges) {
        if (edge.sourceNodeId === selectedId) neighborhood.add(edge.targetNodeId);
        if (edge.targetNodeId === selectedId) neighborhood.add(edge.sourceNodeId);
      }
      records = records.filter((node) => neighborhood.has(node.id));
    }

    const visibleIds = new Set(records.map((node) => node.id));
    const edges = snapshot.edges.filter((edge) => visibleIds.has(edge.sourceNodeId) && visibleIds.has(edge.targetNodeId));
    return layoutGraph(records, edges);
  }, [conflictsOnly, focusNeighborhood, kind, query, selectedId, semanticType, snapshot]);

  async function inspect(nodeId: string) {
    setSelectedId(nodeId);
    setInspectorLoading(true);
    setError(null);
    try {
      const result = await window.novaxDesktop.graph.inspectNode({ nodeId, scopeResourceIds });
      if (result.ok) setInspector(result.inspector);
      else setError(result.error.message);
    } catch (cause) {
      setError(readErrorMessage(cause));
    } finally {
      setInspectorLoading(false);
    }
  }

  if (error && !snapshot) {
    return <div className="graph-fatal" role="alert"><AlertTriangle size={18} aria-hidden="true" />{error}</div>;
  }
  if (!snapshot) {
    return <div className="graph-loading"><LoaderCircle size={18} aria-hidden="true" />正在载入图谱</div>;
  }

  return (
    <article className="semantic-graph" data-embedded={embedded} aria-label="语义图谱">
      <header className="graph-toolbar">
        <label className="graph-search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索节点" aria-label="搜索图谱" />
        </label>
        <div className="graph-kind-filter" role="group" aria-label="节点类型">
          {(["all", "subject", "fact", "entity"] as const).map((value) => (
            <button type="button" key={value} data-selected={kind === value} onClick={() => setKind(value)}>
              {kindLabel(value)}
            </button>
          ))}
        </div>
        <select value={semanticType} onChange={(event) => setSemanticType(event.target.value)} aria-label="语义类型">
          <option value="all">全部语义</option>
          {snapshot.filterOptions.semanticTypes.map((value) => <option value={value} key={value}>{value}</option>)}
        </select>
        <label className="graph-toggle"><input type="checkbox" checked={conflictsOnly} onChange={(event) => setConflictsOnly(event.target.checked)} />仅冲突</label>
        <label className="graph-toggle"><input type="checkbox" checked={focusNeighborhood} onChange={(event) => setFocusNeighborhood(event.target.checked)} /><Focus size={13} aria-hidden="true" />邻域</label>
        <span className="graph-lens">{snapshot.lens.label}</span>
      </header>

      <div className="semantic-graph-layout">
        <div className="graph-canvas">
          {visibleGraph.nodes.length === 0 ? (
            <div className="graph-empty"><Share2 size={23} aria-hidden="true" /><span>当前筛选下没有图事件</span></div>
          ) : (
            <ReactFlowProvider>
              <FlowCanvas
                nodes={visibleGraph.nodes}
                edges={visibleGraph.edges}
                selectedId={selectedId}
                onSelect={inspect}
              />
            </ReactFlowProvider>
          )}
        </div>
        <GraphInspector
          inspector={inspector}
          loading={inspectorLoading}
          error={error}
          onSelectNeighbor={inspect}
        />
      </div>
    </article>
  );
}

function FlowCanvas(props: {
  nodes: FlowNode[];
  edges: Edge[];
  selectedId: string | null;
  onSelect(nodeId: string): void;
}) {
  const { fitView } = useReactFlow();
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    void fitView({ padding: 0.18, duration: 220 });
  }, [fitView, props.nodes, props.edges]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => void fitView({ padding: 0.18, duration: 0 }));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [fitView]);

  const nodes = props.nodes.map((node) => ({ ...node, selected: node.id === props.selectedId }));
  return (
    <div className="graph-flow" ref={containerRef}>
      <ReactFlow
        nodes={nodes}
        edges={props.edges}
        nodeTypes={nodeTypes}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.2}
        maxZoom={1.8}
        fitView
        onNodeClick={(_event, node) => props.onSelect(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--line)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(node) => {
          const record = (node.data as GraphNodeData).record;
          return record.conflict ? "var(--novax-color-danger)" : nodeColor(record.kind);
        }} />
      </ReactFlow>
    </div>
  );
}

function SemanticNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const node = data.record;
  return (
    <div className="graph-node" data-kind={node.kind} data-conflict={node.conflict} data-selected={selected}>
      <Handle type="target" position={Position.Left} />
      <span className="graph-node-kind">{kindLabel(node.kind)}</span>
      <strong>{node.label}</strong>
      <small>{node.scope.label}</small>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function GraphInspector(props: {
  inspector: SemanticGraphInspector | null;
  loading: boolean;
  error: string | null;
  onSelectNeighbor(nodeId: string): void;
}) {
  return (
    <aside className="graph-inspector" aria-label="图谱检查器">
      <div className="graph-inspector-heading">节点详情</div>
      {props.loading ? (
        <div className="graph-inspector-empty"><LoaderCircle size={16} aria-hidden="true" />正在载入</div>
      ) : !props.inspector ? (
        <div className="graph-inspector-empty">选择一个节点</div>
      ) : (
        <div className="graph-inspector-content">
          <span className="graph-inspector-type">{kindLabel(props.inspector.node.kind)} · {props.inspector.node.scope.label}</span>
          <h2>{props.inspector.node.label}</h2>
          <p>{props.inspector.node.description}</p>
          {props.inspector.detail.kind === "fact" ? (
            <>
              <dl>
                <dt>状态</dt><dd>{props.inspector.detail.status === "conflict" ? "存在冲突" : "当前有效"}</dd>
                <dt>来源</dt><dd>{props.inspector.detail.sources.length}</dd>
              </dl>
              <div className="graph-sources">
                {props.inspector.detail.sources.map((source, index) => <span key={`${source.type}-${index}`}>{source.label}</span>)}
              </div>
            </>
          ) : null}
          <div className="graph-relations">
            <strong>关系</strong>
            {props.inspector.relations.length === 0 ? <span>暂无显式关系</span> : props.inspector.relations.map((relation) => (
              <button type="button" key={relation.edgeId} onClick={() => props.onSelectNeighbor(relation.neighborId)}>
                <small>{relation.label}</small>
                <span>{relation.neighborLabel}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {props.error ? <div className="graph-inspector-error" role="alert">{props.error}</div> : null}
    </aside>
  );
}

function layoutGraph(records: GraphNodeRecord[], sourceEdges: SemanticGraphSnapshot["edges"]): { nodes: FlowNode[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", nodesep: 34, ranksep: 82, marginx: 28, marginy: 28 });
  for (const node of records) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of sourceEdges) graph.setEdge(edge.sourceNodeId, edge.targetNodeId);
  dagre.layout(graph);

  const byId = new Map(records.map((node) => [node.id, node]));
  return {
    nodes: records.map((record) => {
      const position = graph.node(record.id) as { x: number; y: number };
      return {
        id: record.id,
        type: "semantic",
        position: { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 },
        data: { record },
      };
    }),
    edges: sourceEdges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      label: edge.label,
      type: "smoothstep",
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: { stroke: edge.status === "conflict" ? "var(--novax-color-danger)" : "var(--novax-color-graph-edge)", strokeWidth: 1.3 },
      labelStyle: { fill: "var(--novax-color-text-subtle)", fontSize: 10 },
      labelBgStyle: { fill: "var(--novax-color-surface-control)", fillOpacity: 0.88 },
    })).filter((edge) => byId.has(edge.source) && byId.has(edge.target)),
  };
}

function kindLabel(kind: KindFilter): string {
  if (kind === "all") return "全部";
  if (kind === "subject") return "主题";
  if (kind === "fact") return "事实";
  return "实体";
}

function nodeColor(kind: GraphNodeRecord["kind"]): string {
  if (kind === "fact") return "var(--novax-color-accent)";
  if (kind === "entity") return "var(--novax-color-entity)";
  return "var(--novax-color-text-faint)";
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "图谱暂时无法载入，请重试。";
}
