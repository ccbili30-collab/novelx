import type { GrowthPresentationSnapshot } from "../../../../shared/growthPresentationContract";

export interface GrowthGuidanceStatusView {
  tone: "idle" | "pending" | "applied";
  title: string;
  detail: string;
}

export interface GrowthImpactSummaryView {
  committedCycleCount: number;
  changedResourceCount: number;
  changedDocumentCount: number;
  changedAssertionCount: number;
  changedRelationCount: number;
  latestInquiry: string | null;
  inquiryEvidenceLabel: string;
  blockingFindingCount: number;
  closureLabel: string;
  closureFindings: Array<{
    severity: "minor" | "major" | "blocking";
    category: string;
    safeSummary: string;
    repairObjective: string;
  }>;
  longformLabel: string;
  longformDetail: string;
}

export type GrowthIllustrationPresentationItem = GrowthPresentationSnapshot["illustrationRequests"][number]["items"][number];
export const growthIllustrationPageSize = 100;

export function toGrowthGuidanceStatusView(snapshot: GrowthPresentationSnapshot | null): GrowthGuidanceStatusView {
  if (!snapshot) return { tone: "idle", title: "尚未载入规则修订", detail: "启动生长后，这里会显示当前轮采用的规则版本。" };
  if (snapshot.guidanceStatus === "persisted_pending_boundary") {
    return {
      tone: "pending",
      title: `规则修订 #${snapshot.currentRuleRevision} 已收到`,
      detail: snapshot.activeCycleRuleRevision === null
        ? "将在下一条安全生长边界固定并重新检索。"
        : `当前原子轮仍使用 #${snapshot.activeCycleRuleRevision}，新规则不会污染正在执行的提交。`,
    };
  }
  if (snapshot.guidanceStatus === "applied") {
    return {
      tone: "applied",
      title: `正在使用规则修订 #${snapshot.currentRuleRevision}`,
      detail: "本轮检索、推演与变更均固定在这个版本。",
    };
  }
  return { tone: "idle", title: "初始规则", detail: "当前没有等待应用的新指导。" };
}

export function toGrowthImpactSummaryView(snapshot: GrowthPresentationSnapshot | null): GrowthImpactSummaryView | null {
  if (!snapshot) return null;
  const committed = snapshot.impacts.filter((impact) => impact.durableState === "committed" || impact.durableState === "evaluated");
  const totals = committed.reduce((current, impact) => ({
    resources: current.resources + impact.resourceCount,
    documents: current.documents + impact.documentCount,
    assertions: current.assertions + impact.assertionCount,
    relations: current.relations + impact.relationCount,
  }), { resources: 0, documents: 0, assertions: 0, relations: 0 });
  const blockingFindingCount = snapshot.closures.flatMap((closure) => closure.findings)
    .filter((finding) => finding.severity === "blocking").length;
  const latestClosure = snapshot.closures.at(-1) ?? null;
  const closureLabel = !latestClosure ? "尚未进入独立检查"
    : latestClosure.checkerDecision === "accepted" ? "Checker 已接受，复检通过"
      : latestClosure.checkerDecision === "repairs_required" ? "Checker 要求返工"
        : latestClosure.checkerDecision === "blocked" ? "Checker 已阻塞"
          : `${latestClosure.satisfiedCount} 项满足，${latestClosure.missingCount} 项待补`;
  const closureFindings = (latestClosure?.findings ?? []).slice(0, 20);
  const longformLabel = snapshot.longform.status === "ready"
    ? `${snapshot.longform.storyTitle} · ${snapshot.longform.completedSectionCount}/${snapshot.longform.totalSectionCount} 节 · ${snapshot.longform.totalCodePoints} 字符`
    : snapshot.longform.status === "blocked" ? "个人长篇暂时阻塞" : "尚未生成个人长篇";
  const longformDetail = snapshot.longform.status === "ready"
    ? snapshot.longform.complete ? "全部章节已提交，等待或已经进入闭环复检。"
      : snapshot.longform.currentSectionTitle ? `下一节：${snapshot.longform.currentSectionTitle}` : "等待下一节。"
    : snapshot.longform.status === "blocked" ? `安全失败码：${snapshot.longform.reasonCode}` : "生成后会显示大纲章节、累计字符和当前进度。";
  return {
    committedCycleCount: committed.length,
    changedResourceCount: totals.resources,
    changedDocumentCount: totals.documents,
    changedAssertionCount: totals.assertions,
    changedRelationCount: totals.relations,
    latestInquiry: snapshot.inquirySummaries.at(-1) ?? null,
    inquiryEvidenceLabel: snapshot.inquirySummaries.length > 0 ? "来自持久化自询事件" : "尚无已选择的自询问题",
    blockingFindingCount,
    closureLabel,
    closureFindings,
    longformLabel,
    longformDetail,
  };
}

export function flattenGrowthIllustrationItems(snapshot: GrowthPresentationSnapshot | null): GrowthIllustrationPresentationItem[] {
  return (snapshot?.illustrationRequests ?? []).flatMap((request) => request.items)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

export function canOpenGrowthIllustration(item: GrowthIllustrationPresentationItem): boolean {
  return item.status === "ready" && item.assetId !== null && item.thumbnailUrl !== null;
}

export function visibleGrowthIllustrationItems(
  items: readonly GrowthIllustrationPresentationItem[],
  visibleCount: number,
): GrowthIllustrationPresentationItem[] {
  return items.slice(0, Math.max(growthIllustrationPageSize, visibleCount));
}

export function illustrationStatusLabel(status: GrowthIllustrationPresentationItem["status"]): string {
  return ({
    planned: "已计划", queued: "排队中", running: "正在绘制", ready: "已就绪", failed: "生成失败",
    cancelled: "已取消", stale: "来源已变化", reconciliation_required: "需要核对",
  })[status];
}
