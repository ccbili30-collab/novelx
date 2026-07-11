import { ArrowRightLeft, BookOpenText, Brain, CheckCircle2, CircleUserRound, Clock3, Image, LoaderCircle, Map, Network } from "lucide-react";
import type { CollaborationListResult, HandoffSummary, SessionSummary, WorkspaceSnapshot } from "../../../../shared/ipcContract";

const domains = [
  { type: "world", label: "世界", icon: Map },
  { type: "oc", label: "OC", icon: CircleUserRound },
  { type: "story", label: "故事", icon: BookOpenText },
  { type: "graph", label: "图谱", icon: Network },
  { type: "timeline", label: "时间线", icon: Clock3 },
  { type: "asset", label: "资产", icon: Image },
] as const;

interface ProjectActivityPanelProps {
  workspace: WorkspaceSnapshot | null;
  session: SessionSummary | null;
  activity: { label: string; domains: string[] } | null;
  collaboration: CollaborationListResult;
  onOpenResource(resourceId: string): Promise<void>;
  onViewAll(): void;
  onCreateHandoff(): void;
  onUpdateHandoff(handoff: HandoffSummary, status: "accepted" | "completed"): Promise<void>;
}

export function ProjectActivityPanel(props: ProjectActivityPanelProps) {
  return (
    <aside className="project-activity-panel" aria-label="项目活动与产物">
      <div className="panel-heading panel-heading--command">
        <span>活动与产物</span>
        <div className="panel-commands">
          <button type="button" className="text-command" onClick={props.onCreateHandoff} disabled={!props.session}>交接</button>
          <button type="button" className="text-command" onClick={props.onViewAll} disabled={!props.workspace}>查看全部</button>
        </div>
      </div>
      {props.activity ? (
        <div className="activity-now" role="status">
          <LoaderCircle size={14} aria-hidden="true" />
          <span>{props.activity.label}</span>
        </div>
      ) : props.session?.state === "review" ? (
        <div className="activity-now activity-now--review"><CheckCircle2 size={14} aria-hidden="true" /><span>有变更等待确认</span></div>
      ) : null}
      <div className="activity-domains">
        <section className="collaboration-summary" aria-label="Agent 协作">
          <div className="collaboration-heading"><ArrowRightLeft size={15} aria-hidden="true" /><span>任务交接</span><em>{props.collaboration.handoffs.length}</em></div>
          {props.collaboration.handoffs.length === 0 ? <small>暂无交接</small> : props.collaboration.handoffs.slice(0, 5).map((handoff) => (
            <div className="handoff-row" key={handoff.id}>
              <div><strong>{handoff.title}</strong><span>{handoffStatusLabel(handoff.status)}</span></div>
              {handoff.recipientSessionId === props.session?.id && handoff.status === "pending" ? (
                <button type="button" onClick={() => void props.onUpdateHandoff(handoff, "accepted")}>接受</button>
              ) : handoff.recipientSessionId === props.session?.id && handoff.status === "accepted" ? (
                <button type="button" onClick={() => void props.onUpdateHandoff(handoff, "completed")}>完成</button>
              ) : null}
            </div>
          ))}
          <div className="collaboration-heading collaboration-heading--memory"><Brain size={15} aria-hidden="true" /><span>共享记忆</span><em>{props.collaboration.sharedMemories.length}</em></div>
        </section>
        {domains.map((domain) => {
          const resources = props.workspace?.resources.filter((resource) => resource.type === domain.type) ?? [];
          const active = props.activity?.domains.includes(domain.type) ?? false;
          const Icon = domain.icon;
          return (
            <details className="activity-domain" data-active={active} key={domain.type} open={active}>
              <summary>
                <Icon size={16} aria-hidden="true" />
                <span>{domain.label}</span>
                {active ? <small>正在处理</small> : <em>{resources.length}</em>}
              </summary>
              <div className="activity-domain-body">
                {resources.length === 0 ? <span>暂无产物</span> : resources.slice(0, 5).map((resource) => (
                  <button type="button" key={resource.id} onClick={() => void props.onOpenResource(resource.id)}>
                    <span>{resource.title}</span>
                    <small>查看成品</small>
                  </button>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </aside>
  );
}

function handoffStatusLabel(status: HandoffSummary["status"]): string {
  if (status === "pending") return "等待接收";
  if (status === "accepted") return "正在处理";
  if (status === "completed") return "已完成";
  return "已取消";
}
