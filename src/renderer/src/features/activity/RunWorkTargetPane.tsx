import type { AgentArtifact, WorkspaceSnapshot } from "../../../../shared/ipcContract";
import { getGrowthWorldMapDisplay, type GrowthPresentation } from "../agent/growthPresentation";

export function RunWorkTargetPane(props: {
  presentation: GrowthPresentation | null;
  artifacts: AgentArtifact[];
  workspace: WorkspaceSnapshot | null;
  onOpenResource(resourceId: string): Promise<void>;
  onOpenDocument(documentId: string, resourceId: string): Promise<void>;
  onOpenChangeSet(changeSetId: string): Promise<void>;
  onOpenGraph(): Promise<void>;
  onOpenReadyImage(image: Extract<AgentArtifact, { kind: "image" }>): Promise<void> | void;
}) {
  const current = props.presentation?.current ?? null;
  const event = current?.events.at(-1) ?? null;
  const reference = event?.contentRef ?? (event ? {
    kind: event.targetKind,
    targetId: event.targetId,
    targetVersionId: event.targetVersionId,
  } : null);
  const target = resolveTarget(reference, props.workspace);
  const domains = current?.activities.flatMap((activity) => activity.domains) ?? [];
  const uniqueDomains = [...new Set(domains)];
  const worldMap = getGrowthWorldMapDisplay(props.artifacts);
  const worldMapArtifact = worldMap.artifact;

  return (
    <section className="run-work-target-pane" aria-label="当前创作">
      {!props.presentation ? <p>尚未启动生长任务。</p> : (
        <>
          <header>
            <strong>{current ? `第 ${current.sequence}/3 轮` : "等待安排"}</strong>
            <small>{phaseLabel(event?.phase, current?.durableState)}</small>
          </header>
          <p className="run-work-target-pane__summary">{current?.summary ?? props.presentation.terminalLabel ?? "等待 Main 安排"}</p>
          {target ? (
            <div className="run-work-target-pane__target">
              <span>{target.kind}</span>
              <strong>{target.title}</strong>
              {reference?.targetVersionId ? <small>版本引用可用</small> : null}
              <button type="button" onClick={() => void target.open()}>打开</button>
            </div>
          ) : event ? <p className="run-work-target-pane__unresolved">当前目标尚未出现在工作区投影中。</p> : null}
          {uniqueDomains.length ? <div className="run-work-target-pane__domains" aria-label="当前领域">{uniqueDomains.map((domain) => <span key={domain}>{domainLabel(domain)}</span>)}</div> : null}
          {worldMapArtifact ? <section className="run-work-target-pane__world-map" data-status={worldMapArtifact.status} aria-label="世界地图产物">
            {worldMap.canPreview ? <img src={worldMapArtifact.thumbnailUrl ?? undefined} alt={`${worldMapArtifact.title}缩略图`} />
              : <div className="run-work-target-pane__world-map-placeholder">{worldMapStatusLabel(worldMapArtifact.status)}</div>}
            <div>
              <strong>{worldMapArtifact.title}</strong>
              <small>{worldMapArtifact.sourceLabel}</small>
              <span>{worldMapStatusLabel(worldMapArtifact.status)}</span>
            </div>
            {worldMap.canOpenShowcase ? <button type="button" onClick={() => void props.onOpenReadyImage(worldMapArtifact)}>查看完整成果</button> : null}
          </section> : null}
          {props.presentation.terminalLabel ? <footer role="status">{props.presentation.terminalLabel}</footer> : null}
        </>
      )}
    </section>
  );

  function resolveTarget(reference: { kind: "document" | "resource" | "assertion" | "relation" | "change_set"; targetId: string; targetVersionId: string | null } | null, workspace: WorkspaceSnapshot | null) {
    if (!reference) return null;
    if (reference.kind === "document") {
      const document = workspace?.documents.find((item) => item.id === reference.targetId);
      if (!document) return null;
      return { kind: "文档", title: document.title, open: () => props.onOpenDocument(document.id, document.resourceId) };
    }
    if (reference.kind === "resource") {
      const resource = workspace?.resources.find((item) => item.id === reference.targetId);
      if (!resource) return null;
      return { kind: resource.type, title: resource.title, open: () => props.onOpenResource(resource.id) };
    }
    if (reference.kind === "change_set") return { kind: "Change Set", title: "候选变更", open: () => props.onOpenChangeSet(reference.targetId) };
    return { kind: reference.kind === "assertion" ? "断言" : "关系", title: "图谱目标", open: () => props.onOpenGraph() };
  }
}

function phaseLabel(phase: "cycle_planned" | "run_attached" | "receipt_recorded" | "change_set_committed" | "cycle_terminal" | undefined, state: string | undefined): string {
  if (state === "committed") return "已提交";
  if (state === "blocked") return "已阻塞";
  if (state === "failed") return "已失败";
  if (state === "cancelled") return "已取消";
  if (state === "reconciliation_required") return "需要核对";
  return ({ cycle_planned: "推演", run_attached: "生成候选", receipt_recorded: "检索", change_set_committed: "已提交", cycle_terminal: "已结束" })[phase ?? "cycle_planned"];
}

function domainLabel(domain: string): string {
  return ({ world: "世界", oc: "OC", story: "故事", graph: "图谱", timeline: "时间线", asset: "资产" })[domain] ?? domain;
}

function worldMapStatusLabel(status: Extract<AgentArtifact, { kind: "image" }>["status"]): string {
  return ({ queued: "等待生成地图", generating: "正在生成地图", ready: "地图已就绪", failed: "地图生成失败", stale: "地图已过期" })[status];
}
