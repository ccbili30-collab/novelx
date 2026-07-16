import type { GrowthPresentationSnapshot } from "../../../../shared/growthPresentationContract";
import { toGrowthGuidanceStatusView } from "./growthPresentationViews";

export { toGrowthGuidanceStatusView } from "./growthPresentationViews";

export function GrowthGuidanceStatus({ snapshot }: { snapshot: GrowthPresentationSnapshot | null }) {
  const view = toGrowthGuidanceStatusView(snapshot);
  return <section className="growth-guidance-status" data-tone={view.tone} aria-label="Growth 规则状态">
    <strong>{view.title}</strong>
    <span>{view.detail}</span>
  </section>;
}
