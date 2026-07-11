import {
  Archive,
  ArchiveRestore,
  Download,
  Folder,
  FolderOpen,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  RefreshCw,
  GitBranch,
  Trash2,
} from "lucide-react";
import type { MouseEvent } from "react";
import type { ProjectSummary, SessionSummary } from "../../../../shared/ipcContract";

interface ProjectSessionRailProps {
  projects: ProjectSummary[];
  sessionsByProject: Record<string, SessionSummary[]>;
  activeProjectId: string | null;
  activeSessionId: string | null;
  addingProject: boolean;
  onAddProject(): Promise<void>;
  onSelectProject(projectId: string): Promise<void>;
  onCreateSession(projectId: string): Promise<void>;
  onSelectSession(projectId: string, sessionId: string): Promise<void>;
  removedProjects?: ProjectSummary[];
  onRemoveProject?(projectId: string): Promise<void>;
  onRestoreProject?(projectId: string): Promise<void>;
  onRescanProject?(projectId: string): Promise<void>;
  onRenameSession?(sessionId: string, title: string): Promise<void>;
  onArchiveSession?(sessionId: string, archived: boolean): Promise<void>;
  onClearSession?(sessionId: string): Promise<void>;
  onDeleteSession?(sessionId: string): Promise<void>;
  onExportSession?(sessionId: string): Promise<void>;
  onOpenProjectHistory?(projectId: string): Promise<void>;
}

export function ProjectSessionRail(props: ProjectSessionRailProps) {
  return (
    <aside className="project-session-rail" aria-label="项目与 Agent 会话">
      <div className="panel-heading panel-heading--command">
        <span>项目</span>
        <button className="icon-command" type="button" onClick={() => void props.onAddProject()} disabled={props.addingProject} title="添加项目目录">
          <FolderOpen size={16} aria-hidden="true" />
          <span className="sr-only">添加项目目录</span>
        </button>
      </div>
      <div className="project-session-list">
        {props.projects.length === 0 ? (
          <div className="project-list-empty">
            <Folder size={18} aria-hidden="true" />
            <span>添加一个目录开始创作</span>
          </div>
        ) : props.projects.map((project) => {
          const sessions = props.sessionsByProject[project.id] ?? [];
          const activeSessions = sessions.filter((session) => !session.archived);
          const archivedSessions = sessions.filter((session) => session.archived);
          const active = project.id === props.activeProjectId;
          return (
            <section className="project-group" data-active={active} key={project.id}>
              <div className="project-row">
                <button type="button" className="project-select" onClick={() => void props.onSelectProject(project.id)}>
                  {active ? <FolderOpen size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
                  <span>{project.name}</span>
                  {project.state !== "ready" ? <small>{projectStateLabel(project.state)}</small> : null}
                </button>
                <button type="button" className="project-add-session" onClick={() => void props.onCreateSession(project.id)} title="新建 Agent 会话">
                  <Plus size={14} aria-hidden="true" />
                  <span className="sr-only">新建 Agent 会话</span>
                </button>
                <ProjectActions project={project} props={props} />
              </div>
              <div className="project-sessions">
                {activeSessions.length === 0 ? <span className="session-empty">无会话</span> : activeSessions.map((session) => (
                  <SessionRow key={session.id} projectId={project.id} session={session} props={props} />
                ))}
                {archivedSessions.length > 0 ? (
                  <details className="archived-sessions">
                    <summary>已归档（{archivedSessions.length}）</summary>
                    {archivedSessions.map((session) => (
                      <SessionRow key={session.id} projectId={project.id} session={session} props={props} />
                    ))}
                  </details>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
      {(props.removedProjects?.length ?? 0) > 0 ? (
        <details className="removed-projects">
          <summary>已移除项目（{props.removedProjects!.length}）</summary>
          {props.removedProjects!.map((project) => (
            <button key={project.id} type="button" className="session-row" onClick={() => void props.onRestoreProject?.(project.id)}>
              <ArchiveRestore size={13} aria-hidden="true" />
              <span>{project.name}</span>
            </button>
          ))}
        </details>
      ) : null}
    </aside>
  );
}

function ProjectActions({ project, props }: { project: ProjectSummary; props: ProjectSessionRailProps }) {
  if (!props.onRemoveProject && !props.onRescanProject && !props.onOpenProjectHistory) return null;
  return (
    <details className="rail-actions">
      <summary title="项目操作"><MoreHorizontal size={14} aria-hidden="true" /></summary>
      <div className="rail-actions__menu">
        {props.onOpenProjectHistory ? <button type="button" onClick={(event) => { closeActionMenu(event); void props.onOpenProjectHistory?.(project.id); }}><GitBranch size={13} />版本与分支</button> : null}
        {props.onRescanProject ? <button type="button" onClick={(event) => { closeActionMenu(event); void props.onRescanProject?.(project.id); }}><RefreshCw size={13} />重新扫描</button> : null}
        {props.onRemoveProject ? <button type="button" onClick={(event) => {
          closeActionMenu(event);
          if (window.confirm(`只把“${project.name}”移出 novelx 列表？磁盘文件不会删除。`)) void props.onRemoveProject?.(project.id);
        }}><Archive size={13} />移出列表</button> : null}
      </div>
    </details>
  );
}

function SessionRow({ projectId, session, props }: { projectId: string; session: SessionSummary; props: ProjectSessionRailProps }) {
  return (
    <div className="session-row-wrap">
      <button type="button" className="session-row" data-selected={session.id === props.activeSessionId} onClick={() => void props.onSelectSession(projectId, session.id)}>
        <MessageSquareText size={13} aria-hidden="true" />
        <span>{session.title}</span>
        {session.state !== "idle" ? <i data-state={session.state} title={sessionStateLabel(session.state)} /> : null}
      </button>
      <SessionActions session={session} props={props} />
    </div>
  );
}

function SessionActions({ session, props }: { session: SessionSummary; props: ProjectSessionRailProps }) {
  const hasActions = props.onRenameSession || props.onArchiveSession || props.onClearSession || props.onDeleteSession || props.onExportSession;
  if (!hasActions) return null;
  return (
    <details className="rail-actions">
      <summary title="会话操作"><MoreHorizontal size={13} aria-hidden="true" /></summary>
      <div className="rail-actions__menu">
        {props.onRenameSession ? <button type="button" onClick={(event) => {
          closeActionMenu(event);
          const title = window.prompt("会话名称", session.title)?.trim();
          if (title && title !== session.title) void props.onRenameSession?.(session.id, title);
        }}>重命名</button> : null}
        {props.onArchiveSession ? <button type="button" onClick={(event) => { closeActionMenu(event); void props.onArchiveSession?.(session.id, !session.archived); }}>
          {session.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}{session.archived ? "恢复会话" : "归档会话"}
        </button> : null}
        {props.onExportSession ? <button type="button" onClick={(event) => { closeActionMenu(event); void props.onExportSession?.(session.id); }}><Download size={13} />导出会话</button> : null}
        {props.onClearSession ? <button type="button" onClick={(event) => {
          closeActionMenu(event);
          if (window.confirm(`清空“${session.title}”的全部对话？此操作不可撤销。`)) void props.onClearSession?.(session.id);
        }}><Trash2 size={13} />清空对话</button> : null}
        {props.onDeleteSession ? <button type="button" onClick={(event) => {
          closeActionMenu(event);
          if (window.confirm(`永久删除会话“${session.title}”？已发布的共享记忆会保留。`)) void props.onDeleteSession?.(session.id);
        }}><Trash2 size={13} />删除会话</button> : null}
      </div>
    </details>
  );
}

function closeActionMenu(event: MouseEvent<HTMLElement>): void {
  event.currentTarget.closest("details")?.removeAttribute("open");
}

function projectStateLabel(state: ProjectSummary["state"]): string {
  if (state === "materials_detected") return "待整理";
  if (state === "missing") return "目录失联";
  return "待初始化";
}

function sessionStateLabel(state: SessionSummary["state"]): string {
  if (state === "working") return "正在工作";
  if (state === "review") return "等待确认";
  if (state === "blocked") return "运行受阻";
  return "空闲";
}
