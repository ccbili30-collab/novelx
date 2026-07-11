import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import fs from "node:fs";
import {
  desktopIpcChannels,
  projectAddResultSchema,
  projectInitializeRequestSchema,
  projectListResultSchema,
  projectRemoveRequestSchema,
  projectRestoreRequestSchema,
  projectRescanRequestSchema,
  projectSelectRequestSchema,
  projectSelectResultSchema,
  sessionArchiveRequestSchema,
  sessionClearRequestSchema,
  sessionDeleteRequestSchema,
  sessionExportRequestSchema,
  sessionExportResultSchema,
  sessionCreateRequestSchema,
  sessionListRequestSchema,
  sessionListResultSchema,
  sessionMessageListRequestSchema,
  sessionMessageListResultSchema,
  sessionRenameRequestSchema,
  sessionSummarySchema,
  type ProjectAddResult,
  type ProjectSelectResult,
  collaborationListRequestSchema,
  collaborationListResultSchema,
  handoffCreateRequestSchema,
  handoffSummarySchema,
  handoffUpdateRequestSchema,
  sharedMemoryPublishRequestSchema,
  sharedMemorySummarySchema,
  type SessionMessage,
} from "../shared/ipcContract";
import { ApplicationRegistryRepository } from "../domain/application/applicationRegistryRepository";
import { detectProjectDirectory, type ProjectDirectoryDetection } from "../domain/application/projectDirectoryService";
import type { WorkspaceSession } from "./workspaceIpc";

export function registerProjectSessionIpc(
  registry: ApplicationRegistryRepository,
  workspaceSession: WorkspaceSession,
): void {
  ipcMain.handle(desktopIpcChannels.projectList, () => projectListResultSchema.parse({
    projects: registry.listProjects(),
  }));
  ipcMain.handle(desktopIpcChannels.projectAdd, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "添加 novelx 项目目录",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return registerPath(registry, workspaceSession, result.filePaths[0]);
  });
  ipcMain.handle(desktopIpcChannels.projectSelect, (_event, payload: unknown) => {
    const request = projectSelectRequestSchema.parse(payload);
    return selectProject(registry, workspaceSession, request.projectId);
  });
  ipcMain.handle(desktopIpcChannels.projectRemove, (_event, payload: unknown) => {
    const request = projectRemoveRequestSchema.parse(payload);
    if (registry.getActiveProjectId() === request.projectId) workspaceSession.close();
    registry.removeProject(request.projectId);
    return projectListResultSchema.parse({ projects: registry.listProjects() });
  });
  ipcMain.handle(desktopIpcChannels.projectListRemoved, () => projectListResultSchema.parse({
    projects: registry.listRemovedProjects(),
  }));
  ipcMain.handle(desktopIpcChannels.projectRestore, (_event, payload: unknown) => {
    const request = projectRestoreRequestSchema.parse(payload);
    registry.restoreProject(request.projectId);
    return projectListResultSchema.parse({ projects: registry.listProjects() });
  });
  ipcMain.handle(desktopIpcChannels.projectRescan, (_event, payload: unknown) => {
    const request = projectRescanRequestSchema.parse(payload);
    const project = registry.getProject(request.projectId);
    if (!fs.existsSync(project.rootPath)) {
      registry.setProjectState(project.id, "missing");
      if (registry.getActiveProjectId() === project.id) workspaceSession.close();
      return selectProject(registry, workspaceSession, project.id);
    }
    const detection = detectProjectDirectory(project.rootPath);
    registry.replaceSourceInventory(project.id, detection.sources);
    registry.setProjectState(project.id, detection.kind === "initialized"
      ? "ready"
      : detection.kind === "existing_materials" ? "materials_detected" : "uninitialized");
    return selectProject(registry, workspaceSession, project.id);
  });
  ipcMain.handle(desktopIpcChannels.projectInitialize, (_event, payload: unknown) => {
    const request = projectInitializeRequestSchema.parse(payload);
    const project = registry.getProject(request.projectId);
    const detection = detectProjectDirectory(project.rootPath);
    if (detection.kind === "initialized") {
      registry.setProjectState(project.id, "ready");
    } else if (request.strategy === "new") {
      if (detection.kind !== "empty") throw projectError("PROJECT_NEW_REQUIRES_EMPTY_DIRECTORY");
      workspaceSession.openPath(project.rootPath);
      registry.setProjectState(project.id, "ready");
    } else {
      registry.replaceSourceInventory(project.id, detection.sources);
      workspaceSession.openPath(project.rootPath);
      registry.setProjectState(project.id, "ready");
    }
    registry.ensureDefaultSession(project.id);
    return selectProject(registry, workspaceSession, project.id);
  });

  ipcMain.handle(desktopIpcChannels.sessionList, (_event, payload: unknown) => {
    const request = sessionListRequestSchema.parse(payload);
    return sessionListResultSchema.parse({
      sessions: registry.listSessions(request.projectId, request.includeArchived),
    });
  });
  ipcMain.handle(desktopIpcChannels.sessionCreate, (_event, payload: unknown) => {
    const request = sessionCreateRequestSchema.parse(payload);
    return sessionSummarySchema.parse(registry.createSession(request.projectId, request.title));
  });
  ipcMain.handle(desktopIpcChannels.sessionRename, (_event, payload: unknown) => {
    const request = sessionRenameRequestSchema.parse(payload);
    return sessionSummarySchema.parse(registry.renameSession(request.sessionId, request.title));
  });
  ipcMain.handle(desktopIpcChannels.sessionArchive, (_event, payload: unknown) => {
    const request = sessionArchiveRequestSchema.parse(payload);
    return sessionSummarySchema.parse(registry.archiveSession(request.sessionId, request.archived));
  });
  ipcMain.handle(desktopIpcChannels.sessionClear, (_event, payload: unknown) => {
    const request = sessionClearRequestSchema.parse(payload);
    return sessionSummarySchema.parse(registry.clearSessionMessages(request.sessionId));
  });
  ipcMain.handle(desktopIpcChannels.sessionDelete, (_event, payload: unknown) => {
    const request = sessionDeleteRequestSchema.parse(payload);
    const session = registry.getSession(request.sessionId);
    registry.deleteSession(request.sessionId);
    return sessionListResultSchema.parse({
      sessions: registry.listSessions(session.projectId, true),
    });
  });
  ipcMain.handle(desktopIpcChannels.sessionExport, async (event, payload: unknown) => {
    const request = sessionExportRequestSchema.parse(payload);
    const session = registry.getSession(request.sessionId);
    const messages = registry.listMessages(request.sessionId);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = owner
      ? await dialog.showSaveDialog(owner, sessionExportDialogOptions(session.title))
      : await dialog.showSaveDialog(sessionExportDialogOptions(session.title));
    if (result.canceled || !result.filePath) {
      return sessionExportResultSchema.parse({ canceled: true, filePath: null, messageCount: messages.length });
    }
    fs.writeFileSync(result.filePath, renderSessionExport(session.title, messages), "utf8");
    return sessionExportResultSchema.parse({
      canceled: false,
      filePath: result.filePath,
      messageCount: messages.length,
    });
  });
  ipcMain.handle(desktopIpcChannels.sessionMessages, (_event, payload: unknown) => {
    const request = sessionMessageListRequestSchema.parse(payload);
    return sessionMessageListResultSchema.parse({ messages: registry.listMessages(request.sessionId) });
  });
  ipcMain.handle(desktopIpcChannels.collaborationList, (_event, payload: unknown) => {
    const request = collaborationListRequestSchema.parse(payload);
    return collaborationListResultSchema.parse({
      sharedMemories: registry.listSharedMemories(request.projectId).map(toSharedMemorySummary),
      handoffs: registry.listSessionHandoffs(request.sessionId).map(toHandoffSummary),
    });
  });
  ipcMain.handle(desktopIpcChannels.sharedMemoryPublish, (_event, payload: unknown) => {
    const request = sharedMemoryPublishRequestSchema.parse(payload);
    requireActiveReadyProject(registry, request.projectId);
    return sharedMemorySummarySchema.parse(toSharedMemorySummary(registry.publishSharedMemory({
      ...request,
      checkpointId: workspaceSession.getActiveCheckpointId(),
    })));
  });
  ipcMain.handle(desktopIpcChannels.handoffCreate, (_event, payload: unknown) => {
    const request = handoffCreateRequestSchema.parse(payload);
    requireActiveReadyProject(registry, request.projectId);
    return handoffSummarySchema.parse(toHandoffSummary(registry.createHandoff({
      ...request,
      checkpointId: workspaceSession.getActiveCheckpointId(),
    })));
  });
  ipcMain.handle(desktopIpcChannels.handoffUpdate, (_event, payload: unknown) => {
    const request = handoffUpdateRequestSchema.parse(payload);
    return handoffSummarySchema.parse(toHandoffSummary(
      registry.updateHandoffStatus(request.handoffId, request.actorSessionId, request.status),
    ));
  });
}

function requireActiveReadyProject(registry: ApplicationRegistryRepository, projectId: string): void {
  if (registry.getActiveProjectId() !== projectId || registry.getProject(projectId).state !== "ready") {
    throw projectError("PROJECT_NOT_ACTIVE");
  }
}

function toSharedMemorySummary(memory: ReturnType<ApplicationRegistryRepository["getSharedMemory"]>) {
  const { checkpointId: _checkpointId, status: _status, ...summary } = memory;
  return summary;
}

function toHandoffSummary(handoff: ReturnType<ApplicationRegistryRepository["getHandoff"]>) {
  const { checkpointId: _checkpointId, ...summary } = handoff;
  return summary;
}

export function registerPath(
  registry: ApplicationRegistryRepository,
  workspaceSession: WorkspaceSession,
  rootPath: string,
): ProjectAddResult {
  const detection = detectProjectDirectory(rootPath);
  const state = detection.kind === "initialized"
    ? "ready"
    : detection.kind === "existing_materials" ? "materials_detected" : "uninitialized";
  const project = registry.registerProject(rootPath, state);
  registry.ensureDefaultSession(project.id);
  registry.selectProject(project.id);
  if (detection.kind === "initialized") workspaceSession.openPath(project.rootPath);
  else workspaceSession.close();
  return projectAddResultSchema.parse({
    project: requireProjectSummary(registry, project.id),
    detection: publicDetection(detection),
  });
}

function selectProject(
  registry: ApplicationRegistryRepository,
  workspaceSession: WorkspaceSession,
  projectId: string,
): ProjectSelectResult {
  let project = registry.getProject(projectId);
  let detection: ReturnType<typeof publicDetection> | null = null;
  if (!fs.existsSync(project.rootPath)) {
    project = registry.setProjectState(projectId, "missing");
    workspaceSession.close();
  } else if (project.state === "ready") {
    workspaceSession.openPath(project.rootPath);
  } else {
    const scanned = detectProjectDirectory(project.rootPath);
    if (scanned.kind === "initialized") {
      project = registry.setProjectState(projectId, "ready");
      workspaceSession.openPath(project.rootPath);
    } else {
      const state = scanned.kind === "existing_materials" ? "materials_detected" : "uninitialized";
      project = registry.setProjectState(projectId, state);
      detection = publicDetection(scanned);
      workspaceSession.close();
    }
  }
  registry.selectProject(projectId);
  return projectSelectResultSchema.parse({
    project: requireProjectSummary(registry, projectId),
    workspace: workspaceSession.getCurrent(),
    detection,
  });
}

function requireProjectSummary(registry: ApplicationRegistryRepository, projectId: string) {
  const project = registry.listProjects().find((candidate) => candidate.id === projectId);
  if (!project) throw projectError("PROJECT_NOT_FOUND");
  return project;
}

function publicDetection(detection: ProjectDirectoryDetection) {
  return {
    kind: detection.kind,
    fileCount: detection.fileCount,
    supportedFileCount: detection.supportedFileCount,
  };
}

function projectError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function sessionExportDialogOptions(title: string) {
  const safeName = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120) || "novelx-session";
  return {
    title: "导出 Agent 会话",
    defaultPath: `${safeName}.md`,
    filters: [{ name: "Markdown（标记文本）", extensions: ["md"] }],
  };
}

function renderSessionExport(title: string, messages: SessionMessage[]): string {
  const lines = [`# ${title}`, "", `导出时间：${new Date().toISOString()}`, ""];
  for (const message of messages) {
    const role = message.role === "user" ? "用户" : message.role === "assistant" ? "Agent" : "错误";
    lines.push(`## ${role} · ${message.createdAt}`, "", message.text, "");
  }
  return `${lines.join("\n")}\n`;
}
