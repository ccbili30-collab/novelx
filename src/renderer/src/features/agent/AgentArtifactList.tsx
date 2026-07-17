import { AlertTriangle, CheckCircle2, FileText, Image, LoaderCircle, Wrench } from "lucide-react";
import type { AgentArtifact } from "../../../../shared/ipcContract";
import { FailedImagePlaceholder } from "../assets/FailedImagePlaceholder";

interface AgentArtifactListProps {
  artifacts: AgentArtifact[];
  onOpenChangeSet?(changeSetId: string): Promise<void> | void;
  onOpenDocumentReference?(reference: Extract<AgentArtifact, { kind: "document_reference" }>): Promise<void> | void;
}

export function AgentArtifactList({ artifacts, onOpenChangeSet, onOpenDocumentReference }: AgentArtifactListProps) {
  if (artifacts.length === 0) return null;
  return (
    <details className="agent-artifacts" aria-label="Agent 已处理内容">
      <summary>已处理 {artifacts.length} 项</summary>
      <div className="agent-artifacts__body">
      {artifacts.map((artifact, index) => {
        const key = `${artifact.kind}-${index}`;
        if (artifact.kind === "tool_call") {
          return (
            <section className="agent-artifact agent-artifact--tool" key={key}>
              <Wrench size={15} aria-hidden="true" />
              <div><strong>{artifact.label}</strong><small>{toolStatusLabel(artifact.status)}</small></div>
            </section>
          );
        }
        if (artifact.kind === "activity") {
          return (
            <section className={`agent-artifact agent-artifact--activity agent-artifact--${artifact.status}`} key={key}>
              {artifact.status === "succeeded" ? <CheckCircle2 size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
              <div><strong>{artifact.label}</strong><small>{artifact.status === "succeeded" ? "已完成" : "未完成"}</small>{artifact.detail ? <p>{artifact.detail}</p> : null}</div>
            </section>
          );
        }
        if (artifact.kind === "change_set") {
          return (
            <button className="agent-artifact agent-artifact--action" type="button" key={key} onClick={() => void onOpenChangeSet?.(artifact.changeSetId)}>
              <CheckCircle2 size={15} aria-hidden="true" />
              <span><strong>Change Set（变更集）</strong><small>{artifact.state === "pending_review" ? "等待审查" : "已提交"}</small></span>
            </button>
          );
        }
        if (artifact.kind === "conflict") {
          return (
            <section className="agent-artifact agent-artifact--conflict" key={key}>
              <AlertTriangle size={15} aria-hidden="true" />
              <div><strong>需要处理的冲突</strong><p>{artifact.message}</p>{artifact.evidenceIds.length ? <small>{artifact.evidenceIds.length} 条结构化证据</small> : null}</div>
            </section>
          );
        }
        if (artifact.kind === "document_reference") {
          const locator = artifact.locator.kind === "line"
            ? `第 ${artifact.locator.start}${artifact.locator.end === artifact.locator.start ? "" : `-${artifact.locator.end}`} 行`
            : artifact.locator.label;
          return (
            <button
              className="agent-artifact agent-artifact--action"
              type="button"
              key={key}
              disabled={!onOpenDocumentReference}
              onClick={() => void onOpenDocumentReference?.(artifact)}
            >
              <FileText size={15} aria-hidden="true" />
              <span><strong>{artifact.title}</strong><small>{locator} · 稳定版本 {artifact.versionId}</small>{artifact.excerpt ? <q>{artifact.excerpt}</q> : null}</span>
            </button>
          );
        }
        return (
          <section className={`agent-artifact agent-artifact--image agent-artifact--${artifact.status}`} key={key}>
            {artifact.status === "failed" ? <FailedImagePlaceholder compact label={`${artifact.title}生成失败`} />
              : artifact.status === "generating" ? <LoaderCircle size={15} aria-hidden="true" /> : <Image size={15} aria-hidden="true" />}
            {artifact.thumbnailUrl && artifact.status === "ready"
              ? <img src={artifact.thumbnailUrl} alt="" loading="lazy" />
              : null}
            <div><strong>{artifact.title}</strong><small>{imageStatusLabel(artifact.status)} · {imagePurposeLabel(artifact.purpose)}</small><small>来源：{artifact.sourceLabel}</small></div>
          </section>
        );
      })}
      </div>
    </details>
  );
}

function toolStatusLabel(status: Extract<AgentArtifact, { kind: "tool_call" }>["status"]): string {
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  return "未运行";
}

function imageStatusLabel(status: Extract<AgentArtifact, { kind: "image" }>["status"]): string {
  return { queued: "已排队", generating: "生成中", ready: "已完成", failed: "生成失败", stale: "已过期" }[status];
}

export function imagePurposeLabel(purpose: string): string {
  return purpose === "world_map" ? "世界地图" : purpose;
}
