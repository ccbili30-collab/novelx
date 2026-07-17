import { useEffect, useMemo, useState } from "react";
import { Image, LoaderCircle, Plus, RotateCcw, X } from "lucide-react";
import type { WorkspaceSnapshot } from "../../../../shared/ipcContract";
import type {
  GrowthIllustrationCreateRequest,
  GrowthPresentationSnapshot,
} from "../../../../shared/growthPresentationContract";
import {
  canOpenGrowthIllustration,
  flattenGrowthIllustrationItems,
  growthIllustrationPageSize,
  illustrationStatusLabel,
  visibleGrowthIllustrationItems,
  type GrowthIllustrationPresentationItem,
} from "./growthPresentationViews";
import { FailedImagePlaceholder } from "../assets/FailedImagePlaceholder";

export { canOpenGrowthIllustration, flattenGrowthIllustrationItems, growthIllustrationPageSize } from "./growthPresentationViews";

export function GrowthIllustrationGallery(props: {
  snapshot: GrowthPresentationSnapshot | null;
  workspace: WorkspaceSnapshot | null;
  busy: boolean;
  error: string | null;
  onCreate(input: Omit<GrowthIllustrationCreateRequest, "projectId" | "sessionId" | "goalId" | "requestId">): Promise<void>;
  onCancel(requestId: string): Promise<void>;
  onOpen(item: GrowthIllustrationPresentationItem): Promise<void> | void;
}) {
  const resources = props.workspace?.resources.filter((resource) => resource.type !== "graph" && resource.type !== "asset") ?? [];
  const [targetKey, setTargetKey] = useState("");
  const [graphNodes, setGraphNodes] = useState<Array<{ id: string; label: string; kind: "subject" | "fact" | "entity"; scopeResourceId: string }>>([]);
  const [sourceText, setSourceText] = useState("");
  const [title, setTitle] = useState("");
  const [composition, setComposition] = useState("");
  const [visualStyle, setVisualStyle] = useState("");
  const [purpose, setPurpose] = useState<GrowthIllustrationCreateRequest["purpose"]>("scene");
  const [variantCount, setVariantCount] = useState(1);
  const [visibleCount, setVisibleCount] = useState(growthIllustrationPageSize);
  const items = useMemo(() => flattenGrowthIllustrationItems(props.snapshot), [props.snapshot]);

  useEffect(() => {
    let cancelled = false;
    setGraphNodes([]);
    if (!props.workspace) return () => { cancelled = true; };
    void window.novaxDesktop.graph.getSnapshot().then((result) => {
      if (cancelled || !result.ok) return;
      setGraphNodes(result.graph.nodes.map((node) => ({ id: node.id, label: node.label, kind: node.kind, scopeResourceId: node.scope.id })));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [props.workspace?.workspaceId]);

  async function create() {
    const selectedKey = targetKey || (resources[0] ? `resource:${resources[0].id}` : "");
    const separator = selectedKey.indexOf(":");
    const selectedKind = separator === -1 ? "" : selectedKey.slice(0, separator);
    const selectedId = separator === -1 ? "" : selectedKey.slice(separator + 1);
    const graphNode = selectedKind === "graph" ? graphNodes.find((node) => node.id === selectedId) : null;
    const selectedResourceId = selectedKind === "resource" ? selectedId : graphNode?.scopeResourceId;
    if (!selectedResourceId || !title.trim() || !composition.trim()) return;
    await props.onCreate({
      target: sourceText.trim()
        ? { kind: "working_text_snapshot", sourceResourceId: selectedResourceId, text: sourceText }
        : graphNode ? { kind: "graph_node", nodeId: graphNode.id }
          : { kind: "resource", resourceId: selectedResourceId },
      purpose,
      title: title.trim(),
      compositionDescription: composition.trim(),
      variantCount,
      ...(visualStyle.trim() ? { visualStyle: visualStyle.trim() } : {}),
    });
  }

  async function regenerate(item: GrowthIllustrationPresentationItem) {
    await props.onCreate({
      target: { kind: "resource", resourceId: item.source.sourceResourceId },
      purpose: item.purpose,
      title: `${item.title} · 新变体`,
      compositionDescription: `以“${item.source.label}”为可信来源，保持主题一致并生成一张新的构图变体。`,
      variantCount: 1,
    });
  }

  return <section className="growth-illustration-gallery" aria-label="图文图鉴">
    <div className="growth-illustration-gallery__composer">
      <label>配图节点<select aria-label="配图节点" value={targetKey} onChange={(event) => setTargetKey(event.target.value)}>
        <option value="">选择当前世界节点</option>
        <optgroup label="正式对象">{resources.map((resource) => <option value={`resource:${resource.id}`} key={resource.id}>{resource.title}</option>)}</optgroup>
        {graphNodes.length ? <optgroup label="语义图谱节点">{graphNodes.map((node) => <option value={`graph:${node.id}`} key={node.id}>[{node.kind}] {node.label}</option>)}</optgroup> : null}
      </select></label>
      <label>类型<select aria-label="配图类型" value={purpose} onChange={(event) => setPurpose(event.target.value as typeof purpose)}>
        <option value="scene">场景 / 背景</option><option value="character_portrait">角色图</option><option value="world_map">地图</option>
      </select></label>
      <label>标题<input aria-label="配图标题" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="如：月潮港夜景" /></label>
      <label>数量<input aria-label="配图数量" type="number" min={1} max={100} value={variantCount} onChange={(event) => setVariantCount(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} /></label>
      <label className="growth-illustration-gallery__wide">画面说明<textarea aria-label="画面说明" rows={3} value={composition} onChange={(event) => setComposition(event.target.value)} placeholder="描述镜头、人物、氛围和希望强调的世界细节。" /></label>
      <label className="growth-illustration-gallery__wide">任意文本片段（可选）<textarea aria-label="配图文本片段" rows={3} maxLength={8_000} value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="粘贴或输入要配图的一段文字；留空则为整个节点配图。" /></label>
      <label className="growth-illustration-gallery__wide">画风覆盖（可选）<input aria-label="配图画风" value={visualStyle} onChange={(event) => setVisualStyle(event.target.value)} placeholder="默认使用漫画感手绘风；需要时可在这里覆盖。" /></label>
      <button type="button" className="growth-illustration-gallery__create" disabled={props.busy || resources.length === 0 || !title.trim() || !composition.trim()} onClick={() => void create()}>
        {props.busy ? <LoaderCircle size={14} /> : <Plus size={14} />}生成配图
      </button>
      {props.error ? <p role="alert">{props.error}</p> : null}
    </div>
    <div className="growth-illustration-gallery__items">
      {items.length === 0 ? <div className="growth-illustration-gallery__empty"><Image size={20} /><span>还没有图鉴配图。任意节点或文本片段都可以成为画面来源。</span></div> : visibleGrowthIllustrationItems(items, visibleCount).map((item) => (
        <article key={item.id} data-status={item.status}>
          {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt={`${item.title}缩略图`} />
            : item.status === "failed"
              ? <FailedImagePlaceholder label={`${item.title}生成失败`} />
              : <div className="growth-illustration-gallery__placeholder"><Image size={20} /><span>{illustrationStatusLabel(item.status)}</span></div>}
          <div className="growth-illustration-gallery__caption">
            <strong>{item.title}</strong><small>{item.source.label}</small><span>{illustrationStatusLabel(item.status)}</span>
          </div>
          <div className="growth-illustration-gallery__actions">
            {canOpenGrowthIllustration(item) ? <button type="button" onClick={() => void props.onOpen(item)}>查看</button> : null}
            <button type="button" disabled={props.busy} onClick={() => void regenerate(item)}><RotateCcw size={12} />基于当前节点再生成</button>
            {item.status === "planned" || item.status === "queued" || item.status === "running"
              ? <button type="button" onClick={() => void props.onCancel(item.requestId)}><X size={12} />取消</button> : null}
          </div>
        </article>
      ))}
    </div>
    {items.length > visibleCount ? <button type="button" className="growth-illustration-gallery__more" onClick={() => setVisibleCount((count) => count + growthIllustrationPageSize)}>再显示 {Math.min(growthIllustrationPageSize, items.length - visibleCount)} 张</button> : null}
  </section>;
}
