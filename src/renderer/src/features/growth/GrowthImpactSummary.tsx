import type { GrowthPresentationSnapshot } from "../../../../shared/growthPresentationContract";
import { toGrowthImpactSummaryView } from "./growthPresentationViews";

export { toGrowthImpactSummaryView } from "./growthPresentationViews";

export function GrowthImpactSummary({ snapshot }: { snapshot: GrowthPresentationSnapshot | null }) {
  const view = toGrowthImpactSummaryView(snapshot);
  if (!view) return null;
  return <details className="growth-impact-summary">
    <summary>
      <span>世界生长摘要</span>
      <small>{view.committedCycleCount} 轮已提交</small>
    </summary>
    <div className="growth-impact-summary__body">
      {view.latestInquiry ? <p><strong>正在推演</strong><span>{view.latestInquiry}<small>{view.inquiryEvidenceLabel}</small></span></p> : null}
      <div className="growth-impact-summary__metrics" aria-label="已提交影响计数">
        <span><b>{view.changedResourceCount}</b>对象</span>
        <span><b>{view.changedDocumentCount}</b>文档</span>
        <span><b>{view.changedAssertionCount}</b>事实</span>
        <span><b>{view.changedRelationCount}</b>关系</span>
      </div>
      <p><strong>角色长篇</strong><span>{view.longformLabel}<small>{view.longformDetail}</small></span></p>
      <p data-tone={view.blockingFindingCount > 0 ? "warning" : undefined}>
        <strong>Checker</strong><span>{view.closureLabel}</span>
      </p>
      {view.closureFindings.length > 0 ? <ul className="growth-impact-summary__findings" aria-label="Checker 返工项">
        {view.closureFindings.map((finding, index) => <li key={`${finding.category}:${index}`} data-severity={finding.severity}>
          <strong>{finding.category}</strong>
          <span>{finding.safeSummary}</span>
          <small>返工目标：{finding.repairObjective}</small>
        </li>)}
      </ul> : null}
    </div>
  </details>;
}
