import type { AgentArtifact } from "../../../../shared/ipcContract";
import { AgentArtifactList } from "./AgentArtifactList";
import { growthDiagnosticSummary, growthEventSummary, type GrowthPresentation } from "./growthPresentation";
import {
  growthActivityActorLabel,
  growthActivityKindLabel,
  type EditorialActivityEvent,
} from "../growth/growthEditorialPresentation";

export function EditorialActivityTimeline({ events }: { events: EditorialActivityEvent[] }) {
  if (events.length === 0) return null;
  return (
    <section className="growth-editorial-activity" aria-label="世界总编编辑进度">
      <header><strong>世界总编编辑进度</strong><small>{events.length} 条记录</small></header>
      <ol>
        {events.slice(-20).map((event) => (
          <li key={event.id} data-kind={event.kind}>
            <span>{growthActivityActorLabel(event.actor)}</span>
            <strong>{growthActivityKindLabel(event.kind)}</strong>
            {event.safeSummary ? <small>{event.safeSummary}</small> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RunActivityTimeline(props: {
  presentation: GrowthPresentation;
  artifacts: AgentArtifact[];
  onOpenChangeSet(changeSetId: string): Promise<void> | void;
  onOpenDocumentReference?(reference: Extract<AgentArtifact, { kind: "document_reference" }>): Promise<void> | void;
}) {
  return (
    <section className="growth-timeline" aria-label="生长活动时间线" data-status={props.presentation.coordinatorStatus}>
      <header>
        <span>生长进度</span>
        <small>{props.presentation.current ? `第 ${props.presentation.current.sequence} 轮` : "等待开始"}</small>
      </header>
      <div className="growth-timeline__rows">
        {props.presentation.rows.map((row) => (
          <details className="growth-timeline__row" key={row.cycleId} open={row.sequence === props.presentation.current?.sequence}>
            <summary>
              <span className="growth-timeline__marker" data-state={row.durableState} aria-hidden="true" />
              <strong>第 {row.sequence} 轮</strong>
              <span>{row.summary}</span>
            </summary>
            <div className="growth-timeline__details">
              {row.events.map((event) => <p key={`${event.cycleId}-${event.sequence}`}>{growthEventSummary(event)}</p>)}
              {row.activities.map((activity, index) => <p key={`${activity.runId}-${index}`}>{activity.label}</p>)}
              {row.diagnostics.map((diagnostic) => (
                <p className="growth-timeline__diagnostic" data-owner={diagnostic.owner} key={diagnostic.diagnosticId}>
                  {growthDiagnosticSummary(diagnostic)}
                </p>
              ))}
              {row.events.length === 0 && row.activities.length === 0 ? <p>等待 Main 安排此轮。</p> : null}
            </div>
          </details>
        ))}
      </div>
      {props.presentation.guidance?.pending && props.presentation.guidance.nextCycleSequence && props.presentation.guidance.nextCycleKind ? (
        <details className="growth-guidance-card">
          <summary><strong>规则修订 #{props.presentation.guidance.latestSavedRevision}</strong><span>已保存</span></summary>
          <p>已保存，等待安全修订轮；候选边界为第 {props.presentation.guidance.nextCycleSequence} 轮，并不承诺该轮一定执行。预计范围：{growthFocusLabels(props.presentation.guidance.focusKinds)}。</p>
        </details>
      ) : null}
      {props.artifacts.length ? <AgentArtifactList artifacts={props.artifacts} onOpenChangeSet={props.onOpenChangeSet} onOpenDocumentReference={props.onOpenDocumentReference} /> : null}
      {props.presentation.terminalLabel ? <footer role="status">{props.presentation.terminalLabel}</footer> : null}
    </section>
  );
}

function growthFocusLabels(focusKinds: Array<"world" | "story" | "oc">): string {
  if (focusKinds.length === 0) return "从持久状态恢复";
  return focusKinds.map((kind) => ({ world: "世界", story: "故事", oc: "OC" })[kind]).join("、");
}
