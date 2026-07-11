import { FileSearch, FolderPlus, X } from "lucide-react";
import type { ProjectDetection, ProjectSummary } from "../../../../shared/ipcContract";

interface ProjectOnboardingDialogProps {
  project: ProjectSummary;
  detection: ProjectDetection;
  busy: boolean;
  onInitialize(strategy: "new" | "adopt"): Promise<void>;
  onClose(): void;
}

export function ProjectOnboardingDialog(props: ProjectOnboardingDialogProps) {
  const existing = props.detection.kind === "existing_materials";
  return (
    <div className="settings-backdrop" role="presentation">
      <section className="project-onboarding" role="dialog" aria-modal="true" aria-label="初始化 novelx 项目">
        <header>
          <div>
            <small>{existing ? "接管现有资料" : "新建项目"}</small>
            <h1>{props.project.name}</h1>
          </div>
          <button type="button" onClick={props.onClose} title="关闭">
            <X size={17} aria-hidden="true" />
            <span className="sr-only">关闭</span>
          </button>
        </header>
        <div className="project-onboarding-body">
          {existing ? <FileSearch size={28} aria-hidden="true" /> : <FolderPlus size={28} aria-hidden="true" />}
          <div>
            <strong>{existing ? "发现现有创作素材" : "这个目录目前为空"}</strong>
            <p>{existing
              ? `检测到 ${props.detection.fileCount} 个文件，其中 ${props.detection.supportedFileCount} 个可以建立来源索引。原文件不会被移动或改写。`
              : "novelx 将建立隐藏工作区和六个空的创作领域，不会生成六份假内容或 Windows 文件夹。"}</p>
          </div>
        </div>
        <footer>
          <button type="button" className="secondary-command" onClick={props.onClose} disabled={props.busy}>稍后处理</button>
          <button type="button" className="primary-command" onClick={() => void props.onInitialize(existing ? "adopt" : "new")} disabled={props.busy}>
            {props.busy ? "正在初始化" : existing ? "建立来源索引并继续" : "创建 novelx 项目"}
          </button>
        </footer>
      </section>
    </div>
  );
}
