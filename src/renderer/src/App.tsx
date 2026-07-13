import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Boxes, Download, FileInput, Image, LoaderCircle, MessageSquareText, PanelLeft, Settings, Sparkles } from "lucide-react";
import type { AgentArtifact, CollaborationListResult, CreativeWorkspaceMutation, HandoffSummary, ProjectAddResult, ProjectSummary, SessionSummary, WorkspaceSnapshot } from "../../shared/ipcContract";
import type { DesktopUpdateState } from "../../shared/desktopUpdateContract";
import { StewardRuntimePanel } from "./features/agent/StewardRuntimePanel";
import { resolveAgentScopeResourceIds } from "../../shared/agentScope";
import { ProjectActivityPanel } from "./features/activity/ProjectActivityPanel";
import { ChangeSetWorkbench } from "./features/change-set/ChangeSetWorkbench";
import { EditorHost, type EditorHostHandle } from "./features/editor/EditorHost";
import { CreativeDocumentEditorHost } from "./features/editor/CreativeDocumentEditorHost";
import { DocumentTabs } from "./features/editor/DocumentTabs";
import { CreateDocumentDialog } from "./features/editor/CreateDocumentDialog";
import { CheckpointHistoryDialog } from "./features/history/CheckpointHistoryDialog";
import { ProjectDoctorDialog } from "./features/doctor/ProjectDoctorDialog";
import { ProjectOnboardingDialog } from "./features/projects/ProjectOnboardingDialog";
import { ProjectSessionRail } from "./features/projects/ProjectSessionRail";
import { HandoffDialog } from "./features/projects/HandoffDialog";
import { DomainResourceTree } from "./features/resources/DomainResourceTree";
import { CreateCreativeObjectDialog } from "./features/resources/CreateCreativeObjectDialog";
import { ObjectMetadataPanel } from "./features/resources/ObjectMetadataPanel";
import { MoveCreativeObjectDialog } from "./features/resources/MoveCreativeObjectDialog";
import { DeleteCreativeObjectDialog, RenameCreativeObjectDialog } from "./features/resources/CreativeObjectCommandDialogs";
import { applyThemePreference, readThemePreference, type NovaxTheme } from "../../shared/themePreference";
import {
  applyBackgroundPreference,
  readBackgroundPreference,
  type NovaxBackgroundPreference,
} from "../../shared/backgroundPreference";
import { PlayerWorkbench } from "./features/player/PlayerWorkbench";
import { ImportWorkbench } from "./features/import/ImportWorkbench";
import { CreativeShowcase } from "./features/showcase/CreativeShowcase";
import snowBackgroundUrl from "./assets/snow.svg?url";

const SemanticGraphView = lazy(async () => {
  const module = await import("./features/graph/SemanticGraphView");
  return { default: module.SemanticGraphView };
});

const ProviderSettingsDialog = lazy(async () => {
  const module = await import("./features/provider/ProviderSettingsDialog");
  return { default: module.ProviderSettingsDialog };
});

type WorkbenchMode = "player" | "agent" | "ide" | "showcase" | "import";
type OnboardingState = Pick<ProjectAddResult, "project" | "detection">;

export function App() {
  const [theme, setTheme] = useState<NovaxTheme>(() => readThemePreference(window.localStorage));
  const [background, setBackground] = useState<NovaxBackgroundPreference>(() => readBackgroundPreference(window.localStorage));
  const [mode, setMode] = useState<WorkbenchMode>("agent");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [removedProjects, setRemovedProjects] = useState<ProjectSummary[]>([]);
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, SessionSummary[]>>({});
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [documentLocator, setDocumentLocator] = useState<Extract<AgentArtifact, { kind: "document_reference" }>["locator"] | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<WorkspaceSnapshot["resources"][number]["type"] | null>(null);
  const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | null>(null);
  const [showcaseStoryId, setShowcaseStoryId] = useState<string | null>(null);
  const [changeSetRefreshKey, setChangeSetRefreshKey] = useState(0);
  const [committedWorkspaceRefreshKey, setCommittedWorkspaceRefreshKey] = useState(0);
  const [sessionMessageRefreshKey, setSessionMessageRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [activity, setActivity] = useState<{ label: string; domains: string[] } | null>(null);
  const [collaboration, setCollaboration] = useState<CollaborationListResult>({ sharedMemories: [], handoffs: [] });
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [creativeBusy, setCreativeBusy] = useState(false);
  const [creativeError, setCreativeError] = useState<string | null>(null);
  const [createObjectTarget, setCreateObjectTarget] = useState<{
    domain: WorkspaceSnapshot["resources"][number]["type"];
    parent: WorkspaceSnapshot["resources"][number] | null;
  } | null>(null);
  const [createDocumentResource, setCreateDocumentResource] = useState<WorkspaceSnapshot["resources"][number] | null>(null);
  const [moveResource, setMoveResource] = useState<WorkspaceSnapshot["resources"][number] | null>(null);
  const [renameResourceTarget, setRenameResourceTarget] = useState<WorkspaceSnapshot["resources"][number] | null>(null);
  const [deleteResourceTarget, setDeleteResourceTarget] = useState<WorkspaceSnapshot["resources"][number] | null>(null);
  const editorRef = useRef<EditorHostHandle | null>(null);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeSession = sessionsByProject[activeProjectId ?? ""]?.find((session) => session.id === activeSessionId) ?? null;
  const selectedResource = useMemo(
    () => workspace?.resources.find((resource) => resource.id === selectedResourceId) ?? null,
    [selectedResourceId, workspace],
  );
  const selectedDocument = useMemo(
    () => workspace?.documents.find((document) => document.id === selectedDocumentId) ?? null,
    [selectedDocumentId, workspace],
  );

  useEffect(() => {
    let active = true;
    void window.novaxDesktop.update.getStatus().then((state) => {
      if (active) setUpdateState(state);
    });
    const unsubscribe = window.novaxDesktop.update.subscribe((state) => setUpdateState(state));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    applyThemePreference(theme, document.documentElement, window.localStorage);
  }, [theme]);

  useEffect(() => {
    applyBackgroundPreference(background, snowBackgroundUrl, document.documentElement, window.localStorage);
  }, [background]);

  function changeBackground(next: NovaxBackgroundPreference): boolean {
    const saved = applyBackgroundPreference(next, snowBackgroundUrl, document.documentElement, window.localStorage);
    if (saved) setBackground(next);
    return saved;
  }

  useEffect(() => window.novaxDesktop.workspace.subscribeFlushRequest((request) => {
    void flushEditor().then(
      () => window.novaxDesktop.workspace.completeFlush({ requestId: request.requestId, success: true }),
      () => window.novaxDesktop.workspace.completeFlush({ requestId: request.requestId, success: false }),
    );
  }), []);

  async function bootstrap() {
    const [result, removed] = await Promise.all([
      window.novaxDesktop.project.list(),
      window.novaxDesktop.project.listRemoved(),
    ]);
    setProjects(result.projects);
    setRemovedProjects(removed.projects);
    await loadAllSessions(result.projects);
    const active = result.projects.find((project) => project.active) ?? result.projects[0] ?? null;
    if (active) await selectProject(active.id);
  }

  async function loadAllSessions(nextProjects: ProjectSummary[]) {
    const pairs = await Promise.all(nextProjects.map(async (project) => [
      project.id,
      (await window.novaxDesktop.session.list({ projectId: project.id, includeArchived: true })).sessions,
    ] as const));
    setSessionsByProject(Object.fromEntries(pairs));
  }

  async function refreshProjects() {
    const [result, removed] = await Promise.all([
      window.novaxDesktop.project.list(),
      window.novaxDesktop.project.listRemoved(),
    ]);
    setProjects(result.projects);
    setRemovedProjects(removed.projects);
    return result.projects;
  }

  async function addProject() {
    setAddingProject(true);
    try {
      await flushEditor();
      const result = await window.novaxDesktop.project.add();
      if (!result) return;
      const nextProjects = await refreshProjects();
      await loadAllSessions(nextProjects);
      setActiveProjectId(result.project.id);
      setActiveSessionId(null);
      setSelectedResourceId(null);
      setSelectedDocumentId(null);
      setSelectedDomain(null);
      setSelectedChangeSetId(null);
      if (result.detection.kind === "initialized") {
        const selected = await window.novaxDesktop.project.select({ projectId: result.project.id });
        setWorkspace(selected.workspace);
      } else {
        setWorkspace(null);
        setOnboarding(result);
      }
    } finally {
      setAddingProject(false);
    }
  }

  async function selectProject(projectId: string) {
    await flushEditor();
    const selected = await window.novaxDesktop.project.select({ projectId });
    const sessions = (await window.novaxDesktop.session.list({ projectId, includeArchived: true })).sessions;
    setProjects(await refreshProjects());
    setSessionsByProject((current) => ({ ...current, [projectId]: sessions }));
    setActiveProjectId(projectId);
    const nextSessionId = sessions.some((session) => session.id === activeSessionId && !session.archived)
      ? activeSessionId
      : sessions.find((session) => !session.archived)?.id ?? null;
    setActiveSessionId(nextSessionId);
    setWorkspace(selected.workspace);
    setSelectedResourceId(null);
    setSelectedDocumentId(null);
    setSelectedDomain(null);
    setSelectedChangeSetId(null);
    setActivity(null);
    await loadCollaboration(projectId, nextSessionId);
    if (!selected.workspace && selected.detection) {
      setOnboarding({
        project: selected.project,
        detection: selected.detection,
      });
    }
  }

  async function createSession(projectId: string) {
    if (projectId !== activeProjectId) await selectProject(projectId);
    const session = await window.novaxDesktop.session.create({ projectId });
    const sessions = (await window.novaxDesktop.session.list({ projectId, includeArchived: true })).sessions;
    setSessionsByProject((current) => ({ ...current, [projectId]: sessions }));
    setActiveProjectId(projectId);
    setActiveSessionId(session.id);
    await loadCollaboration(projectId, session.id);
    await refreshProjects();
  }

  async function selectSession(projectId: string, sessionId: string) {
    if (projectId !== activeProjectId) await selectProject(projectId);
    setActiveSessionId(sessionId);
    setSelectedChangeSetId(null);
    setActivity(null);
    await loadCollaboration(projectId, sessionId);
  }

  async function loadCollaboration(projectId: string, sessionId: string | null) {
    setCollaboration(sessionId
      ? await window.novaxDesktop.collaboration.list({ projectId, sessionId })
      : { sharedMemories: [], handoffs: [] });
  }

  async function createHandoff(input: { recipientSessionId: string; title: string; instructions: string }) {
    if (!activeProjectId || !activeSessionId) return;
    setHandoffBusy(true);
    try {
      await window.novaxDesktop.collaboration.createHandoff({
        projectId: activeProjectId,
        senderSessionId: activeSessionId,
        recipientSessionId: input.recipientSessionId,
        title: input.title,
        instructions: input.instructions,
        scopeResourceIds: selectedResourceId ? [selectedResourceId] : [],
      });
      await loadCollaboration(activeProjectId, activeSessionId);
      setHandoffOpen(false);
    } finally {
      setHandoffBusy(false);
    }
  }

  async function updateHandoff(handoff: HandoffSummary, status: "accepted" | "completed") {
    if (!activeProjectId || !activeSessionId) return;
    await window.novaxDesktop.collaboration.updateHandoff({ handoffId: handoff.id, actorSessionId: activeSessionId, status });
    await loadCollaboration(activeProjectId, activeSessionId);
  }

  async function initializeProject(strategy: "new" | "adopt") {
    if (!onboarding) return;
    setInitializing(true);
    try {
      const selected = await window.novaxDesktop.project.initialize({ projectId: onboarding.project.id, strategy });
      setWorkspace(selected.workspace);
      setActiveProjectId(selected.project.id);
      let sessions = (await window.novaxDesktop.session.list({ projectId: selected.project.id, includeArchived: true })).sessions;
      if (sessions.length === 0) {
        const created = await window.novaxDesktop.session.create({ projectId: selected.project.id });
        sessions = [created];
      }
      setSessionsByProject((current) => ({ ...current, [selected.project.id]: sessions }));
      setActiveSessionId(sessions.find((session) => !session.archived)?.id ?? null);
      await refreshProjects();
      setOnboarding(null);
    } finally {
      setInitializing(false);
    }
  }

  async function selectResource(resourceId: string) {
    if (resourceId === selectedResourceId && !selectedDocumentId) return;
    await flushEditor();
    setSelectedResourceId(resourceId);
    setSelectedDocumentId(workspace?.documents.find((document) => document.resourceId === resourceId)?.id ?? null);
    setDocumentLocator(null);
    setSelectedDomain(null);
    setSelectedChangeSetId(null);
  }

  async function selectDocument(documentId: string, resourceId: string) {
    if (documentId === selectedDocumentId) return;
    await flushEditor();
    setSelectedResourceId(resourceId);
    setSelectedDocumentId(documentId);
    setDocumentLocator(null);
    setSelectedDomain(null);
    setSelectedChangeSetId(null);
  }

  async function selectDomain(domain: WorkspaceSnapshot["resources"][number]["type"]) {
    await flushEditor();
    setSelectedResourceId(null);
    setSelectedDocumentId(null);
    setSelectedDomain(domain);
    setSelectedChangeSetId(null);
  }

  async function openActivityResource(resourceId: string) {
    await selectResource(resourceId);
    setMode("ide");
  }

  async function openShowcaseDocument(documentId: string, resourceId: string) {
    await selectDocument(documentId, resourceId);
    setMode("ide");
  }

  const openReadyImageShowcase = useCallback(async (artifact: Extract<AgentArtifact, { kind: "image" }>) => {
    const currentWorkspace = await window.novaxDesktop.workspace.getCurrent() ?? workspace;
    if (!currentWorkspace) return;
    const result = await window.novaxDesktop.workspace.listImageAssets();
    if (!result.ok) return;
    const asset = result.assets.find((candidate) => candidate.assetId === artifact.assetId);
    if (!asset) return;
    const stories = currentWorkspace.resources.filter((resource) => resource.type === "story" && resource.objectKind === "story");
    const candidates = stories.filter((story) => {
      const relevantIds = collectShowcaseNavigationIds(story.id, currentWorkspace);
      return asset.sourceResourceIds.some((resourceId) => relevantIds.has(resourceId));
    });
    const target = candidates.length === 1
      ? candidates[0]
      : candidates.length === 0 && stories.length === 1 ? stories[0] : null;
    if (!target) return;
    setWorkspace(currentWorkspace);
    setShowcaseStoryId(target.id);
    setCommittedWorkspaceRefreshKey((value) => value + 1);
    setMode("showcase");
  }, [workspace]);

  async function openChangeSet(changeSetId: string) {
    await flushEditor();
    setSelectedChangeSetId(changeSetId);
  }

  async function openDocumentReference(reference: Extract<AgentArtifact, { kind: "document_reference" }>) {
    const document = workspace?.documents.find((item) => item.id === reference.documentId);
    if (!document) return;
    await flushEditor();
    setSelectedResourceId(document.resourceId);
    setSelectedDocumentId(document.id);
    setDocumentLocator(reference.locator);
    setSelectedDomain(null);
    setSelectedChangeSetId(null);
    setMode("ide");
  }

  async function flushEditor(): Promise<void> {
    await editorRef.current?.flush();
  }

  async function mutateCreativeWorkspace(input: CreativeWorkspaceMutation): Promise<WorkspaceSnapshot | null> {
    await flushEditor();
    setCreativeBusy(true);
    setCreativeError(null);
    try {
      const next = await window.novaxDesktop.workspace.mutate(input);
      setWorkspace(next);
      setChangeSetRefreshKey((value) => value + 1);
      return next;
    } catch (error) {
      setCreativeError(error instanceof Error && error.message.trim() ? error.message : "创作对象操作失败，请重试。");
      return null;
    } finally {
      setCreativeBusy(false);
    }
  }

  const refreshCreativeWorkspace = useCallback(async () => {
    const next = await window.novaxDesktop.workspace.getCurrent();
    if (next) setWorkspace(next);
  }, []);

  const handleCommittedChangeSet = useCallback(async () => {
    setChangeSetRefreshKey((value) => value + 1);
    setCommittedWorkspaceRefreshKey((value) => value + 1);
    try {
      await refreshCreativeWorkspace();
      setCreativeError(null);
    } catch (error) {
      setCreativeError(error instanceof Error && error.message.trim()
        ? error.message
        : "正式内容已提交，但工作台刷新失败，请重新打开项目。");
    }
  }, [refreshCreativeWorkspace]);

  async function createCreativeObject(input: Extract<CreativeWorkspaceMutation, { action: "create_resource" }>) {
    const existing = new Set(workspace?.resources.map((resource) => resource.id) ?? []);
    const next = await mutateCreativeWorkspace(input);
    if (!next) return;
    const created = next.resources.find((resource) => !existing.has(resource.id)) ?? null;
    setCreateObjectTarget(null);
    if (created) await selectResourceFromSnapshot(created.id, next);
  }

  async function selectResourceFromSnapshot(resourceId: string, snapshot: WorkspaceSnapshot) {
    setSelectedResourceId(resourceId);
    setSelectedDocumentId(snapshot.documents.find((document) => document.resourceId === resourceId)?.id ?? null);
    setDocumentLocator(null);
    setSelectedDomain(null);
    setSelectedChangeSetId(null);
  }

  async function renameResource(title: string) {
    if (!renameResourceTarget) return;
    const next = await mutateCreativeWorkspace({ action: "rename_resource", resourceId: renameResourceTarget.id, title });
    if (next) setRenameResourceTarget(null);
  }

  async function deleteResource() {
    if (!deleteResourceTarget) return;
    const next = await mutateCreativeWorkspace({ action: "delete_resource", resourceId: deleteResourceTarget.id });
    if (!next) return;
    setDeleteResourceTarget(null);
    setSelectedResourceId(null);
    setSelectedDocumentId(null);
  }

  async function moveCreativeResource(parentId: string) {
    if (!moveResource) return;
    const next = await mutateCreativeWorkspace({ action: "move_resource", resourceId: moveResource.id, parentId });
    if (next) setMoveResource(null);
  }

  async function createDocument(input: Extract<CreativeWorkspaceMutation, { action: "create_document" }>) {
    const existing = new Set(workspace?.documents.map((document) => document.id) ?? []);
    const next = await mutateCreativeWorkspace(input);
    if (!next) return;
    const created = next.documents.find((document) => !existing.has(document.id)) ?? null;
    setCreateDocumentResource(null);
    if (created) {
      setSelectedResourceId(created.resourceId);
      setSelectedDocumentId(created.id);
      setDocumentLocator(null);
    }
  }

  async function deleteDocument(document: WorkspaceSnapshot["documents"][number]) {
    if (!window.confirm(`删除文档《${document.title}》？稳定版本仍保留在项目“版本与分支”中。`)) return;
    const next = await mutateCreativeWorkspace({ action: "delete_document", documentId: document.id });
    if (!next) return;
    const replacement = next.documents.find((candidate) => candidate.resourceId === document.resourceId) ?? null;
    setSelectedDocumentId(replacement?.id ?? null);
  }

  async function reloadProjectSessions(projectId: string): Promise<SessionSummary[]> {
    const sessions = (await window.novaxDesktop.session.list({ projectId, includeArchived: true })).sessions;
    setSessionsByProject((current) => ({ ...current, [projectId]: sessions }));
    return sessions;
  }

  async function removeProject(projectId: string) {
    await flushEditor();
    await window.novaxDesktop.project.remove({ projectId });
    const nextProjects = await refreshProjects();
    if (projectId === activeProjectId) {
      const next = nextProjects[0] ?? null;
      if (next) await selectProject(next.id);
      else {
        setActiveProjectId(null);
        setActiveSessionId(null);
        setWorkspace(null);
      }
    }
  }

  async function restoreProject(projectId: string) {
    await window.novaxDesktop.project.restore({ projectId });
    const nextProjects = await refreshProjects();
    await loadAllSessions(nextProjects);
  }

  async function rescanProject(projectId: string) {
    const result = await window.novaxDesktop.project.rescan({ projectId });
    await refreshProjects();
    if (projectId === activeProjectId) setWorkspace(result.workspace);
  }

  async function renameSession(sessionId: string, title: string) {
    const session = await window.novaxDesktop.session.rename({ sessionId, title });
    await reloadProjectSessions(session.projectId);
  }

  async function archiveSession(sessionId: string, archived: boolean) {
    const session = await window.novaxDesktop.session.archive({ sessionId, archived });
    const sessions = await reloadProjectSessions(session.projectId);
    if (archived && sessionId === activeSessionId) {
      setActiveSessionId(sessions.find((candidate) => !candidate.archived)?.id ?? null);
    }
  }

  async function clearSession(sessionId: string) {
    const session = await window.novaxDesktop.session.clear({ sessionId });
    await reloadProjectSessions(session.projectId);
    setSessionMessageRefreshKey((value) => value + 1);
  }

  async function deleteSession(sessionId: string) {
    const session = Object.values(sessionsByProject).flat().find((candidate) => candidate.id === sessionId);
    if (!session) return;
    const result = await window.novaxDesktop.session.delete({ sessionId });
    setSessionsByProject((current) => ({ ...current, [session.projectId]: result.sessions }));
    if (sessionId === activeSessionId) setActiveSessionId(result.sessions.find((candidate) => !candidate.archived)?.id ?? null);
    await refreshProjects();
  }

  async function exportSession(sessionId: string) {
    await window.novaxDesktop.session.export({ sessionId });
  }

  const agentScopeResourceIds = resolveAgentScopeResourceIds(workspace, selectedResourceId);
  const agentPanel = (
    <section className="agent-conversation-panel" aria-label="大管家">
      <div className="panel-heading">
        <MessageSquareText size={16} aria-hidden="true" />
        <span>{activeSession?.title ?? "大管家"}</span>
      </div>
      <StewardRuntimePanel
        workspace={workspace}
        projectId={activeProjectId}
        session={activeSession}
        scopeResourceIds={agentScopeResourceIds}
        changeSetRefreshKey={changeSetRefreshKey}
        messageRefreshKey={sessionMessageRefreshKey}
        selectedChangeSetId={selectedChangeSetId}
        onOpenChangeSet={openChangeSet}
        onCommittedChangeSet={handleCommittedChangeSet}
        onOpenDocumentReference={openDocumentReference}
        onReadyImage={openReadyImageShowcase}
        onActivityChange={setActivity}
      />
    </section>
  );

  async function openProjectVersions(projectId = activeProjectId) {
    if (!projectId) return;
    if (projectId !== activeProjectId) await selectProject(projectId);
    setHistoryOpen(true);
  }

  async function openProjectDoctor(projectId = activeProjectId) {
    if (!projectId) return;
    if (projectId !== activeProjectId) await selectProject(projectId);
    setDoctorOpen(true);
  }

  const showUpdateCommand = updateState
    ? ["available", "downloading", "downloaded", "error"].includes(updateState.kind)
    : false;

  return (
    <main className={`workbench workbench--${mode}`} data-mode={mode} aria-label="novelx 桌面工作台">
      <header className="titlebar">
        <strong className="brand">novelx</strong>
        <span className="workspace-state">{activeProject?.name ?? "未选择项目"}</span>
        <div className="mode-switch" role="radiogroup" aria-label="工作台模式">
          <button type="button" role="radio" aria-checked={mode === "player"} onClick={() => setMode("player")}>
            <BookOpen size={14} aria-hidden="true" />玩家模式
          </button>
          <button type="button" role="radio" aria-checked={mode === "agent"} onClick={() => setMode("agent")}>
            <MessageSquareText size={14} aria-hidden="true" />Agent 模式
          </button>
          <button type="button" role="radio" aria-checked={mode === "ide"} onClick={() => setMode("ide")}>
            <PanelLeft size={14} aria-hidden="true" />IDE 模式
          </button>
          <button type="button" role="radio" aria-checked={mode === "showcase"} onClick={() => setMode("showcase")}>
            <Sparkles size={14} aria-hidden="true" />作品预览
          </button>
          <button type="button" role="radio" aria-checked={mode === "import"} onClick={() => setMode("import")}>
            <FileInput size={14} aria-hidden="true" />导入
          </button>
        </div>
        <button className="titlebar-command" data-testid="open-settings" type="button" onClick={() => setSettingsOpen(true)} title="设置">
          <Settings size={16} aria-hidden="true" /><span className="sr-only">设置</span>
        </button>
        {showUpdateCommand ? <button className="titlebar-command titlebar-update-command" data-state={updateState?.kind} type="button" onClick={() => setSettingsOpen(true)} title={updateState?.message ?? "软件更新"}>
          {updateState?.kind === "downloading" ? <LoaderCircle size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
          <span className="sr-only">软件更新</span>
        </button> : null}
      </header>

      {mode === "player" ? <PlayerWorkbench workspace={workspace} /> : mode === "import" ? <ImportWorkbench workspace={workspace} /> : mode === "showcase" ? (
        workspace ? <CreativeShowcase
          workspace={workspace}
          refreshKey={committedWorkspaceRefreshKey}
          storyResourceId={showcaseStoryId}
          onStoryChange={setShowcaseStoryId}
          onOpenResource={openActivityResource}
          onOpenDocument={openShowcaseDocument}
        /> : <div className="empty-state"><Sparkles size={28} strokeWidth={1.4} aria-hidden="true" /><h1>项目尚未初始化</h1></div>
      ) : mode === "agent" ? (
        <div className="workbench-grid workbench-grid--agent">
          <ProjectSessionRail
            projects={projects}
            sessionsByProject={sessionsByProject}
            activeProjectId={activeProjectId}
            activeSessionId={activeSessionId}
            addingProject={addingProject}
            removedProjects={removedProjects}
            onAddProject={addProject}
            onSelectProject={selectProject}
            onCreateSession={createSession}
            onSelectSession={selectSession}
            onRemoveProject={removeProject}
            onRestoreProject={restoreProject}
            onRescanProject={rescanProject}
            onRenameSession={renameSession}
            onArchiveSession={archiveSession}
            onClearSession={clearSession}
            onDeleteSession={deleteSession}
            onExportSession={exportSession}
            onOpenProjectHistory={openProjectVersions}
            onOpenProjectDoctor={openProjectDoctor}
          />
          {agentPanel}
          {selectedChangeSetId ? (
            <section className="agent-artifact-panel"><ChangeSetWorkbench changeSetId={selectedChangeSetId} onChanged={() => setChangeSetRefreshKey((value) => value + 1)} onCommitted={handleCommittedChangeSet} /></section>
          ) : (
            <ProjectActivityPanel
              projectId={activeProjectId}
              workspace={workspace}
              session={activeSession}
              activity={activity}
              collaboration={collaboration}
              refreshKey={changeSetRefreshKey}
              onOpenResource={openActivityResource}
              onViewAll={() => setMode("ide")}
              onCreateHandoff={() => setHandoffOpen(true)}
              onUpdateHandoff={updateHandoff}
            />
          )}
        </div>
      ) : (
        <div className="workbench-grid workbench-grid--ide">
          <DomainResourceTree
            workspace={workspace}
            selectedResourceId={selectedResourceId}
            selectedDocumentId={selectedDocumentId}
            selectedDomain={selectedDomain}
            onSelect={selectResource}
            onSelectDocument={selectDocument}
            onSelectDomain={selectDomain}
            onCreate={(domain, parent) => setCreateObjectTarget({ domain, parent })}
            onRename={setRenameResourceTarget}
            onMove={setMoveResource}
            onDelete={setDeleteResourceTarget}
            onOpenHistory={() => void openProjectVersions()}
            onOpenDoctor={() => void openProjectDoctor()}
          />
          <section className="canvas" aria-label="创作内容">
            {selectedChangeSetId ? (
              <ChangeSetWorkbench changeSetId={selectedChangeSetId} onChanged={() => setChangeSetRefreshKey((value) => value + 1)} onCommitted={handleCommittedChangeSet} />
            ) : selectedDomain === "graph" || selectedResource?.type === "graph" ? (
              <Suspense fallback={<div className="graph-loading"><LoaderCircle size={18} aria-hidden="true" />正在载入图谱</div>}><SemanticGraphView refreshKey={committedWorkspaceRefreshKey} /></Suspense>
            ) : selectedDomain === "asset" || selectedResource?.type === "asset" ? (
              <div className="empty-state"><Image size={28} strokeWidth={1.4} aria-hidden="true" /><h1>视觉资产</h1><button type="button" onClick={() => setMode("showcase")}>打开作品预览</button></div>
            ) : selectedResource ? (
              <div className="creative-canvas-stack">
                {workspace ? <ObjectMetadataPanel workspace={workspace} resource={selectedResource} busy={creativeBusy} onMutate={mutateCreativeWorkspace} onWorkspaceRefresh={refreshCreativeWorkspace} /> : null}
                <div className="creative-editor-stack">
                  <DocumentTabs
                    documents={workspace?.documents.filter((document) => document.resourceId === selectedResource.id) ?? []}
                    selectedDocumentId={selectedDocumentId}
                    onSelect={(document) => selectDocument(document.id, document.resourceId)}
                    onCreate={() => setCreateDocumentResource(selectedResource)}
                    onDelete={deleteDocument}
                  />
                  {selectedDocument
                    ? <CreativeDocumentEditorHost ref={editorRef} document={selectedDocument} refreshKey={committedWorkspaceRefreshKey} locator={documentLocator} onCreateDocument={() => setCreateDocumentResource(selectedResource)} />
                    : <EditorHost ref={editorRef} resource={selectedResource} />}
                </div>
              </div>
            ) : (
              <div className="empty-state"><Boxes size={28} strokeWidth={1.4} aria-hidden="true" /><h1>{workspace ? selectedDomain ? "这个领域暂无创作对象" : "选择一个创作对象" : "项目尚未初始化"}</h1></div>
            )}
          </section>
          {agentPanel}
        </div>
      )}

      <footer className="statusbar">
        <span>{activeProject ? projectStateLabel(activeProject.state) : "本地"}</span>
        <span>{mode === "player" ? "玩家模式" : mode === "showcase" ? "作品预览" : mode === "import" ? "来源导入" : activeSession ? `Agent：${activeSession.title}` : "尚未选择 Agent 会话"}</span>
      </footer>

      {creativeError ? <div className="creative-operation-error" role="alert"><span>{creativeError}</span><button type="button" onClick={() => setCreativeError(null)}>关闭</button></div> : null}

      {settingsOpen ? <Suspense fallback={null}><ProviderSettingsDialog
        theme={theme}
        background={background}
        onThemeChange={setTheme}
        onBackgroundChange={changeBackground}
        onClose={() => setSettingsOpen(false)}
      /></Suspense> : null}
      {historyOpen && workspace ? <CheckpointHistoryDialog workspaceId={workspace.workspaceId} onClose={() => setHistoryOpen(false)} onRestored={(restored) => {
        setWorkspace(restored);
        setSelectedResourceId(null);
        setSelectedDocumentId(null);
        setSelectedDomain(null);
        setSelectedChangeSetId(null);
        setChangeSetRefreshKey((value) => value + 1);
      }} /> : null}
      {doctorOpen && workspace ? <ProjectDoctorDialog workspaceId={workspace.workspaceId} onClose={() => setDoctorOpen(false)} /> : null}
      {createObjectTarget ? <CreateCreativeObjectDialog
        domain={createObjectTarget.domain}
        parent={createObjectTarget.parent}
        busy={creativeBusy}
        onSubmit={createCreativeObject}
        onClose={() => setCreateObjectTarget(null)}
      /> : null}
      {createDocumentResource ? <CreateDocumentDialog
        resource={createDocumentResource}
        busy={creativeBusy}
        onSubmit={createDocument}
        onClose={() => setCreateDocumentResource(null)}
      /> : null}
      {moveResource && workspace ? <MoveCreativeObjectDialog resource={moveResource} resources={workspace.resources} busy={creativeBusy} onSubmit={moveCreativeResource} onClose={() => setMoveResource(null)} /> : null}
      {renameResourceTarget ? <RenameCreativeObjectDialog resource={renameResourceTarget} busy={creativeBusy} onSubmit={renameResource} onClose={() => setRenameResourceTarget(null)} /> : null}
      {deleteResourceTarget ? <DeleteCreativeObjectDialog resource={deleteResourceTarget} busy={creativeBusy} onConfirm={deleteResource} onClose={() => setDeleteResourceTarget(null)} /> : null}
      {onboarding ? <ProjectOnboardingDialog project={onboarding.project} detection={onboarding.detection} busy={initializing} onInitialize={initializeProject} onClose={() => setOnboarding(null)} /> : null}
      {handoffOpen && activeProjectId && activeSessionId ? <HandoffDialog
        recipients={(sessionsByProject[activeProjectId] ?? []).filter((session) => session.id !== activeSessionId)}
        scopeLabel={selectedResource?.title ?? null}
        busy={handoffBusy}
        onSubmit={createHandoff}
        onClose={() => setHandoffOpen(false)}
      /> : null}
    </main>
  );
}

function projectStateLabel(state: ProjectSummary["state"]): string {
  if (state === "ready") return "novelx 项目已就绪";
  if (state === "materials_detected") return "现有素材等待接管";
  if (state === "missing") return "项目目录失联";
  return "项目等待初始化";
}

function collectShowcaseNavigationIds(storyId: string, workspace: WorkspaceSnapshot): Set<string> {
  const ids = new Set([storyId]);
  for (const relation of workspace.relations) {
    if (relation.sourceResourceId === storyId && (relation.kind === "uses_world" || relation.kind === "uses_oc")) {
      ids.add(relation.targetResourceId);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const resource of workspace.resources) {
      if (resource.parentId && ids.has(resource.parentId) && !ids.has(resource.id)) {
        ids.add(resource.id);
        changed = true;
      }
    }
  }
  return ids;
}
