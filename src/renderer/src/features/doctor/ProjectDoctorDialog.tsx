import { AlertTriangle, CheckCircle2, CircleX, LoaderCircle, Stethoscope, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectDoctorReport } from "../../../../shared/ipcContract";

interface ProjectDoctorDialogProps {
  workspaceId: string;
  onClose(): void;
}

export function ProjectDoctorDialog({ workspaceId, onClose }: ProjectDoctorDialogProps) {
  const [report, setReport] = useState<ProjectDoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void window.novaxDesktop.workspace.inspectProject().then((result) => {
      if (!current) return;
      if (result.ok) setReport(result.report);
      else setError(result.error.message);
      setLoading(false);
    });
    return () => { current = false; };
  }, [workspaceId]);

  return <div className="settings-backdrop" data-testid="project-doctor-backdrop">
    <section className="settings-dialog project-doctor-dialog" role="dialog" aria-modal="true" aria-labelledby="project-doctor-title">
      <header className="settings-header">
        <div><span className="settings-kicker">PROJECT DOCTOR（项目体检）</span><h1 id="project-doctor-title">项目体检</h1></div>
        <button className="icon-command" type="button" onClick={onClose} title="关闭项目体检"><X size={17} aria-hidden="true" /><span className="sr-only">关闭项目体检</span></button>
      </header>
      <div className="project-doctor-body">
        {loading ? <div className="project-doctor-state" role="status"><LoaderCircle size={18} aria-hidden="true" />正在检查创作版本和图谱投影</div> : null}
        {error ? <div className="project-doctor-state project-doctor-state--blocked" role="alert"><CircleX size={18} aria-hidden="true" />{error}</div> : null}
        {report ? <DoctorReport report={report} /> : null}
      </div>
      <footer className="project-doctor-footer"><span>当前仅检查创作提交与语义图谱投影。自动修复尚未开放。</span><button type="button" onClick={onClose}>完成</button></footer>
    </section>
  </div>;
}

function DoctorReport({ report }: { report: ProjectDoctorReport }) {
  const Icon = report.status === "healthy" ? CheckCircle2 : report.status === "blocked" ? CircleX : AlertTriangle;
  const statusLabel = report.status === "healthy" ? "基础链路正常" : report.status === "blocked" ? "发现阻塞问题" : "发现需要处理的问题";
  return <>
    <div className="project-doctor-summary" data-status={report.status}><Icon size={22} aria-hidden="true" /><div><strong>{statusLabel}</strong><span>{new Date(report.checkedAt).toLocaleString("zh-CN")} 完成检查</span></div></div>
    <div className="project-doctor-metrics" aria-label="检查摘要">
      <div><strong>{report.counts.commits}</strong><span>创作版本</span></div><div><strong>{report.counts.sealedCommits}</strong><span>已封存清单</span></div>
      <div><strong>{report.counts.openBranchHeads}</strong><span>当前分支</span></div><div><strong>{report.counts.successfulHeadProjections}</strong><span>有效图谱投影</span></div>
    </div>
    {report.issues.length === 0 ? <div className="project-doctor-empty"><Stethoscope size={18} aria-hidden="true" />本批检查范围内没有发现问题。</div> : <div className="project-doctor-issues">
      {summarizeIssues(report).map((item) => <div className="project-doctor-issue" data-severity={item.severity} key={item.code}>
        {item.severity === "blocked" ? <CircleX size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}
        <div><strong>{item.title}</strong><p>{item.description}</p><small>{item.count} 项 · {item.repairAvailable ? "后续可提供修复" : "需要人工核查"}</small></div>
      </div>)}
    </div>}
    <div className="project-doctor-deferred">尚未纳入本批检查：时间线、检索索引、摘要、角色认知。</div>
  </>;
}

function summarizeIssues(report: ProjectDoctorReport) {
  const labels: Record<ProjectDoctorReport["issues"][number]["code"], { title: string; description: string }> = {
    COMMIT_UNSEALED: { title: "历史版本缺少第四阶段清单", description: "这是升级前创建的版本，系统没有伪造其封存状态。" },
    COMMIT_MANIFEST_MISMATCH: { title: "创作版本清单不一致", description: "版本内容与不可变清单不一致，必须先核查数据完整性。" },
    PROJECTION_MISSING: { title: "当前版本尚未建立图谱投影", description: "正式创作内容仍在，但图谱派生结果尚未生成。" },
    PROJECTION_FAILED: { title: "图谱投影生成失败", description: "正式创作内容没有回滚，图谱需要重新构建。" },
    PROJECTION_STALE: { title: "图谱投影已经过期", description: "当前图谱不是由最新的创作版本生成。" },
  };
  return Object.entries(labels).flatMap(([code, label]) => {
    const issues = report.issues.filter((issue) => issue.code === code);
    return issues.length ? [{ code, ...label, count: issues.length, severity: issues.some((issue) => issue.severity === "blocked") ? "blocked" : "warning", repairAvailable: issues.every((issue) => issue.repairAvailable) }] : [];
  });
}
