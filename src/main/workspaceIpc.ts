import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import {
  desktopIpcChannels,
  changeSetDecisionRequestSchema,
  changeSetDetailResultSchema,
  changeSetFinalizeAssistRequestSchema,
  changeSetGetRequestSchema,
  changeSetListPendingResultSchema,
  documentGetRequestSchema,
  documentOperationResultSchema,
  documentSaveStableRequestSchema,
  documentSaveWorkingRequestSchema,
  editorDocumentSnapshotSchema,
  creativeWorkspaceMutationSchema,
  creativeMutationResultSchema,
  creativeDocumentGetRequestSchema,
  creativeDocumentSaveWorkingRequestSchema,
  creativeDocumentSaveStableRequestSchema,
  creativeDocumentDiscardWorkingRequestSchema,
  creativeEditorDocumentSnapshotSchema,
  creativeDocumentOperationResultSchema,
  constraintEditorGetRequestSchema,
  constraintEditorSaveWorkingRequestSchema,
  constraintEditorRevisionRequestSchema,
  constraintEditorSnapshotSchema,
  constraintEditorOperationResultSchema,
  graphInspectNodeRequestSchema,
  graphInspectorResultSchema,
  graphSnapshotResultSchema,
  semanticGraphInspectorSchema,
  semanticGraphSnapshotSchema,
  workspaceSnapshotSchema,
  workspaceHistoryResultSchema,
  nullableContextBudgetAuditSchema,
  projectDoctorResultSchema,
  storyProfileCreateRequestSchema,
  storyProfileCreateResultSchema,
  storyProfileListResultSchema,
  startProfileCreateRequestSchema,
  startProfileListRequestSchema,
  startProfileResultSchema,
  startProfileListResultSchema,
  playthroughCreateRequestSchema,
  playthroughListRequestSchema,
  playTurnListRequestSchema,
  playthroughInspectRequestSchema,
  playthroughResolveRequestSchema,
  playthroughResultSchema,
  playthroughInspectResultSchema,
  playthroughListResultSchema,
  playTurnListResultSchema,
  workspaceRestoreRequestSchema,
  workspaceRestoreResultSchema,
  safeChangeSetDetailSchema,
  safeChangeSetSummarySchema,
  type ChangeSetDetailResult,
  type ChangeSetErrorCode,
  type ChangeSetListPendingResult,
  type SafeChangeSetDetail,
  type SafeChangeSetSummary,
  type DocumentErrorCode,
  type DocumentOperationResult,
  type EditorDocumentSnapshot,
  type CreativeWorkspaceMutation,
  type CreativeMutationResult,
  type CreativeEditorDocumentSnapshot,
  type ConstraintEditorSnapshot,
  type GraphErrorCode,
  type GraphInspectorResult,
  type GraphSnapshotResult,
  type SemanticGraphInspector,
  type SemanticGraphSnapshot,
  type WorkspaceSnapshot,
  type CheckpointHistoryEntry,
  type WorkspaceHistoryResult,
  type WorkspaceRestoreResult,
  type ProjectDoctorResult,
  type StoryProfileCreateResult,
  type StoryProfileListResult,
  type StartProfileResult,
  type StartProfileListResult,
  type PlaythroughResult,
  type PlaythroughInspectResult,
  type PlaythroughListResult,
  type PlayTurnListResult,
} from "../shared/ipcContract";
import { openWorkspace, type WorkspaceDatabase } from "../domain/workspace/workspaceRepository";
import { ResourceRepository } from "../domain/workspace/resourceRepository";
import { CreativeDocumentRepository } from "../domain/workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../domain/workspace/creativeRelationRepository";
import { ConstraintProfileRepository } from "../domain/workspace/constraintProfileRepository";
import { ConstraintProfileService } from "../domain/workspace/constraintProfileService";
import { CheckpointRepository } from "../domain/version/checkpointRepository";
import { DocumentEditorService } from "../domain/workspace/documentEditorService";
import { CreativeDocumentEditorService } from "../domain/workspace/creativeDocumentEditorService";
import { CreativeWorkspaceService } from "../domain/workspace/creativeWorkspaceService";
import { ChangeSetService, type ChangeSetPolicyEvaluator } from "../domain/changeSet/changeSetService";
import { WorkspaceChangeSetPolicy } from "../domain/changeSet/workspaceChangeSetPolicy";
import { SemanticGraphService } from "../domain/graph/semanticGraphService";
import type { AgentToolGateway } from "./agentProcessSupervisor";
import { createWorkspaceAgentToolGateway } from "./workspaceAgentToolGateway";
import { AgentAuditRepository } from "../domain/audit/agentAuditRepository";
import { ProjectDoctorService } from "../domain/doctor/projectDoctorService";
import { StoryProfileRepository } from "../domain/story/storyProfileRepository";
import { PlaythroughRepository } from "../domain/play/playthroughRepository";
import { StartProfileRepository } from "../domain/play/startProfileRepository";
import { PlaythroughReconciliationService } from "../domain/play/playthroughReconciliationService";
import type { AgentRuntimeLease } from "./agentProcessSupervisor";
import type { PlayerRuntimeLease } from "./playerProcessSupervisor";
import { PlayerAuditRepository } from "../domain/audit/playerAuditRepository";
import { PlayerRunCommitService } from "../domain/play/playerRunCommitService";
import { PlayerTurnContextService } from "../domain/play/playerTurnContextService";

export class WorkspaceSession {
  #workspace: WorkspaceDatabase | null = null;
  #changeSetPolicy: ChangeSetPolicyEvaluator | null = null;
  #activeAgentLeases = 0;
  #writeQueue = new ProjectWriteQueue();

  constructor(readonly createChangeSetPolicy: ((workspace: WorkspaceDatabase) => ChangeSetPolicyEvaluator) | null = null) {}

  openPath(rootPath: string): WorkspaceSnapshot {
    if (this.#activeAgentLeases > 0) {
      throw Object.assign(new Error("An Agent run is using the current workspace."), { code: "WORKSPACE_AGENT_RUN_ACTIVE" });
    }
    this.#workspace?.close();
    this.#workspace = openWorkspace(rootPath);
    this.#writeQueue = new ProjectWriteQueue();
    this.#changeSetPolicy = this.createChangeSetPolicy?.(this.#workspace) ?? null;
    new AgentAuditRepository(this.#workspace).recoverOpenRuns();
    return this.snapshot();
  }

  getCurrent(): WorkspaceSnapshot | null {
    return this.#workspace ? this.snapshot() : null;
  }

  listCheckpointHistory(): CheckpointHistoryEntry[] {
    return new CheckpointRepository(this.requireWorkspace()).listActiveHistory();
  }

  getLatestContextBudget() {
    return new AgentAuditRepository(this.requireWorkspace()).getLatestContextBudget();
  }

  inspectProject() {
    return new ProjectDoctorService(this.requireWorkspace()).inspect();
  }

  createStoryProfile(input: { storyResourceId: string; worldResourceId: string; title: string; ocBindings: Array<{ ocResourceId: string; variantResourceId?: string | null }> }) {
    const workspace = this.requireWorkspace();
    const canonCommitId = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
    return new StoryProfileRepository(workspace).create({ ...input, canonCommitId });
  }

  listStoryProfiles() { return new StoryProfileRepository(this.requireWorkspace()).list(); }

  createStartProfile(input: Parameters<StartProfileRepository["create"]>[0]) {
    return new StartProfileRepository(this.requireWorkspace()).create(input);
  }

  listStartProfiles(storyProfileId: string) {
    return new StartProfileRepository(this.requireWorkspace()).listForStory(storyProfileId);
  }

  createPlaythroughFromStart(storyProfileId: string, startProfileId?: string | null) {
    return new PlaythroughRepository(this.requireWorkspace()).create({ storyProfileId, startProfileId });
  }

  listPlaythroughs(storyProfileId: string) { return new PlaythroughRepository(this.requireWorkspace()).listForStoryProfile(storyProfileId); }
  listPlayTurns(playthroughId: string) { return new PlaythroughRepository(this.requireWorkspace()).listTurns(playthroughId); }

  inspectPlaythrough(playthroughId: string) {
    return new PlaythroughReconciliationService(this.requireWorkspace()).inspect(playthroughId);
  }

  resolvePlaythrough(input: { playthroughId: string; decision: "continue_pinned" | "fork_from_current" }) {
    return new PlaythroughReconciliationService(this.requireWorkspace()).resolve(input);
  }

  getActiveCheckpointId(): string {
    return new CheckpointRepository(this.requireWorkspace()).getActiveBranch().headCheckpointId;
  }

  restoreCheckpoint(checkpointId: string): WorkspaceSnapshot {
    if (this.#activeAgentLeases > 0) {
      throw Object.assign(new Error("An Agent run is using the current workspace."), { code: "WORKSPACE_AGENT_RUN_ACTIVE" });
    }
    const checkpoints = new CheckpointRepository(this.requireWorkspace());
    const target = checkpoints.listActiveHistory().find((checkpoint) => checkpoint.id === checkpointId && !checkpoint.isHead);
    if (!target) throw Object.assign(new Error("Checkpoint is not restorable."), { code: "CHECKPOINT_NOT_FOUND" });
    const label = new Date().toISOString().replace(/[:.]/g, "-");
    checkpoints.restoreFromCheckpoint(checkpointId, `回溯-${label}`);
    return this.snapshot();
  }

  createAgentToolGateway(): AgentToolGateway | null {
    const workspace = this.#workspace;
    const policy = this.#changeSetPolicy;
    if (!workspace || !policy) return null;
    return this.#serializeWrites(createWorkspaceAgentToolGateway(
      workspace,
      policy,
      () => this.#workspace === workspace,
    ));
  }

  acquireAgentRuntimeLease(): AgentRuntimeLease | null {
    const workspace = this.#workspace;
    const policy = this.#changeSetPolicy;
    if (!workspace || !policy) return null;
    this.#activeAgentLeases += 1;
    let released = false;
    return {
      gateway: this.#serializeWrites(createWorkspaceAgentToolGateway(workspace, policy, () => this.#workspace === workspace)),
      audit: new AgentAuditRepository(workspace),
      release: () => {
        if (released) return;
        released = true;
        this.#activeAgentLeases -= 1;
      },
    };
  }

  acquirePlayerRuntimeLease(): PlayerRuntimeLease | null {
    const workspace = this.#workspace;
    if (!workspace) return null;
    this.#activeAgentLeases += 1;
    let released = false;
    return {
      audit: new PlayerAuditRepository(workspace),
      commit: new PlayerRunCommitService(workspace),
      prepare: (input) => {
        if (this.#workspace !== workspace) throw Object.assign(new Error("Workspace changed."), { code: "PLAYER_WORKSPACE_REQUIRED" });
        return new PlayerTurnContextService(workspace).prepare(input);
      },
      release: () => {
        if (released) return;
        released = true;
        this.#activeAgentLeases -= 1;
      },
    };
  }

  getDocument(resourceId: string): EditorDocumentSnapshot {
    return editorDocumentSnapshotSchema.parse(new DocumentEditorService(this.requireWorkspace()).getForEditor(resourceId));
  }

  saveWorkingDocument(input: {
    resourceId: string;
    content: string;
    expectedRevision: number;
    expectedStableVersionId: string | null;
  }): EditorDocumentSnapshot {
    return editorDocumentSnapshotSchema.parse(new DocumentEditorService(this.requireWorkspace()).saveWorkingCopy(input));
  }

  saveStableDocument(input: { resourceId: string; expectedRevision: number }): EditorDocumentSnapshot {
    return editorDocumentSnapshotSchema.parse(new DocumentEditorService(this.requireWorkspace()).saveStable(input));
  }

  mutateCreativeWorkspace(input: CreativeWorkspaceMutation): WorkspaceSnapshot {
    if (this.#activeAgentLeases > 0) {
      throw Object.assign(new Error("An Agent run is using the current workspace."), { code: "WORKSPACE_AGENT_RUN_ACTIVE" });
    }
    new CreativeWorkspaceService(this.requireWorkspace()).mutate(input);
    return this.snapshot();
  }

  getCreativeDocument(documentId: string): CreativeEditorDocumentSnapshot {
    return creativeEditorDocumentSnapshotSchema.parse(
      new CreativeDocumentEditorService(this.requireWorkspace()).getForEditor(documentId),
    );
  }

  saveWorkingCreativeDocument(input: {
    documentId: string;
    content: string;
    expectedRevision: number;
    expectedStableVersionId: string | null;
  }): CreativeEditorDocumentSnapshot {
    return creativeEditorDocumentSnapshotSchema.parse(
      new CreativeDocumentEditorService(this.requireWorkspace()).saveWorkingCopy(input),
    );
  }

  saveStableCreativeDocument(input: { documentId: string; expectedRevision: number }): CreativeEditorDocumentSnapshot {
    return creativeEditorDocumentSnapshotSchema.parse(
      new CreativeDocumentEditorService(this.requireWorkspace()).saveStable(input),
    );
  }

  discardWorkingCreativeDocument(input: { documentId: string; expectedRevision: number }): CreativeEditorDocumentSnapshot {
    return creativeEditorDocumentSnapshotSchema.parse(
      new CreativeDocumentEditorService(this.requireWorkspace()).discardWorkingCopy(input),
    );
  }

  getConstraintEditor(profileId: string): ConstraintEditorSnapshot {
    return constraintEditorSnapshotSchema.parse(new ConstraintProfileService(this.requireWorkspace()).getForEditor(profileId));
  }

  saveWorkingConstraint(input: Parameters<ConstraintProfileService["saveWorkingCopy"]>[0]): ConstraintEditorSnapshot {
    const service = new ConstraintProfileService(this.requireWorkspace());
    service.saveWorkingCopy(input);
    return constraintEditorSnapshotSchema.parse(service.getForEditor(input.profileId));
  }

  saveStableConstraint(input: { profileId: string; expectedRevision: number }): ConstraintEditorSnapshot {
    const service = new ConstraintProfileService(this.requireWorkspace());
    service.saveStable(input);
    return constraintEditorSnapshotSchema.parse(service.getForEditor(input.profileId));
  }

  discardWorkingConstraint(input: { profileId: string; expectedRevision: number }): ConstraintEditorSnapshot {
    return constraintEditorSnapshotSchema.parse(new ConstraintProfileService(this.requireWorkspace()).discardWorkingCopy(input));
  }

  listPendingChangeSets(): SafeChangeSetSummary[] {
    return new ChangeSetService(this.requireWorkspace()).listPendingForReview()
      .map((changeSet) => safeChangeSetSummarySchema.parse(changeSet));
  }

  getChangeSet(changeSetId: string): SafeChangeSetDetail {
    return safeChangeSetDetailSchema.parse(
      new ChangeSetService(this.requireWorkspace()).getReviewDetail(changeSetId),
    );
  }

  decideChangeSetItem(input: {
    changeSetId: string;
    itemId: string;
    decision: "accepted" | "rejected" | "draft";
  }): SafeChangeSetDetail {
    const service = new ChangeSetService(this.requireWorkspace());
    service.decideItem(input.changeSetId, input.itemId, input.decision);
    return safeChangeSetDetailSchema.parse(service.getReviewDetail(input.changeSetId));
  }

  finalizeAssistChangeSet(input: { changeSetId: string; label: string }): SafeChangeSetDetail {
    const service = new ChangeSetService(this.requireWorkspace());
    service.finalizeAssistReview(input.changeSetId, input.label);
    return safeChangeSetDetailSchema.parse(service.getReviewDetail(input.changeSetId));
  }

  getGraphSnapshot(): SemanticGraphSnapshot {
    return semanticGraphSnapshotSchema.parse(new SemanticGraphService(this.requireWorkspace()).getSnapshot());
  }

  inspectGraphNode(nodeId: string): SemanticGraphInspector {
    return semanticGraphInspectorSchema.parse(new SemanticGraphService(this.requireWorkspace()).inspectNode(nodeId));
  }

  close(): void {
    if (this.#activeAgentLeases > 0) {
      throw new Error("Cannot close a workspace while Agent runtime leases are active.");
    }
    this.#workspace?.close();
    this.#workspace = null;
    this.#changeSetPolicy = null;
  }

  private snapshot(): WorkspaceSnapshot {
    if (!this.#workspace) throw new Error("Workspace is not open.");
    const activeBranch = new CheckpointRepository(this.#workspace).getActiveBranch();
    return workspaceSnapshotSchema.parse({
      workspaceId: this.#workspace.workspaceId,
      name: path.basename(this.#workspace.rootPath),
      activeBranchId: activeBranch.id,
      resources: new ResourceRepository(this.#workspace).listVisibleCurrent(),
      documents: new CreativeDocumentRepository(this.#workspace).listCurrent(),
      relations: new CreativeRelationRepository(this.#workspace).listCurrent(),
      constraintProfiles: new ConstraintProfileRepository(this.#workspace).listCurrent().map((profile) => ({
        profileId: profile.profileId,
        versionId: profile.versionId,
        scopeResourceId: profile.scopeResourceId,
        title: profile.title,
        payload: profile.payload,
      })),
    });
  }

  private requireWorkspace(): WorkspaceDatabase {
    if (!this.#workspace) {
      throw Object.assign(new Error("Workspace is not open."), { code: "WORKSPACE_NOT_OPEN" });
    }
    return this.#workspace;
  }

  #serializeWrites(gateway: AgentToolGateway): AgentToolGateway {
    return {
      retrieveGraphEvidence: (args, context) => gateway.retrieveGraphEvidence(args, context),
      proposeChangeSet: (args, context) => this.#writeQueue.run(
        context.signal,
        () => gateway.proposeChangeSet(args, context),
      ),
    };
  }
}

export class ProjectWriteQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      if (signal.aborted) throw Object.assign(new Error("Agent run was cancelled."), { code: "AGENT_RUN_CANCELLED" });
      return operation();
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function registerWorkspaceIpc(options: { changeSetPolicy?: ChangeSetPolicyEvaluator } = {}): WorkspaceSession {
  const createPolicy = options.changeSetPolicy
    ? () => options.changeSetPolicy!
    : (workspace: WorkspaceDatabase) => new WorkspaceChangeSetPolicy(workspace);
  const session = new WorkspaceSession(createPolicy);
  ipcMain.handle(desktopIpcChannels.workspaceCurrent, () => session.getCurrent());
  ipcMain.handle(desktopIpcChannels.workspaceHistory, () => workspaceHistoryResult(() => session.listCheckpointHistory()));
  ipcMain.handle(desktopIpcChannels.workspaceContextBudget, () => (
    nullableContextBudgetAuditSchema.parse(session.getCurrent() ? session.getLatestContextBudget() : null)
  ));
  ipcMain.handle(desktopIpcChannels.workspaceDoctor, () => projectDoctorResult(() => session.inspectProject()));
  ipcMain.handle(desktopIpcChannels.storyProfileCreate, (_event, payload: unknown) => storyProfileResult(() => {
    const request = storyProfileCreateRequestSchema.parse(payload);
    return session.createStoryProfile(request);
  }));
  ipcMain.handle(desktopIpcChannels.storyProfileList, () => storyProfileListResult(() => session.listStoryProfiles()));
  ipcMain.handle(desktopIpcChannels.startProfileCreate, (_event, payload: unknown) => startProfileResult(() => {
    const request = startProfileCreateRequestSchema.parse(payload);
    return session.createStartProfile(request);
  }));
  ipcMain.handle(desktopIpcChannels.startProfileList, (_event, payload: unknown) => startProfileListResult(() => {
    const request = startProfileListRequestSchema.parse(payload);
    return session.listStartProfiles(request.storyProfileId);
  }));
  ipcMain.handle(desktopIpcChannels.playthroughCreate, (_event, payload: unknown) => playthroughResult(() => {
    const request = playthroughCreateRequestSchema.parse(payload);
    return session.createPlaythroughFromStart(request.storyProfileId, request.startProfileId);
  }));
  ipcMain.handle(desktopIpcChannels.playthroughList, (_event, payload: unknown) => playthroughListResult(() => {
    const request = playthroughListRequestSchema.parse(payload);
    return session.listPlaythroughs(request.storyProfileId);
  }));
  ipcMain.handle(desktopIpcChannels.playTurnList, (_event, payload: unknown) => playTurnListResult(() => {
    const request = playTurnListRequestSchema.parse(payload);
    return session.listPlayTurns(request.playthroughId);
  }));
  ipcMain.handle(desktopIpcChannels.playthroughInspect, (_event, payload: unknown) => playthroughInspectResult(() => {
    const request = playthroughInspectRequestSchema.parse(payload);
    return session.inspectPlaythrough(request.playthroughId);
  }));
  ipcMain.handle(desktopIpcChannels.playthroughResolve, (_event, payload: unknown) => playthroughResult(() => {
    const request = playthroughResolveRequestSchema.parse(payload);
    return session.resolvePlaythrough(request);
  }));
  ipcMain.handle(desktopIpcChannels.workspaceRestore, (_event, payload: unknown) => {
    const request = workspaceRestoreRequestSchema.parse(payload);
    return workspaceRestoreResult(() => session.restoreCheckpoint(request.checkpointId));
  });
  ipcMain.handle(desktopIpcChannels.workspaceOpen, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "打开 novelx 工作区",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return session.openPath(result.filePaths[0]);
  });
  ipcMain.handle(desktopIpcChannels.documentGet, (_event, payload: unknown) => documentResult(() => {
    const request = documentGetRequestSchema.parse(payload);
    return session.getDocument(request.resourceId);
  }));
  ipcMain.handle(desktopIpcChannels.documentSaveWorking, async (_event, payload: unknown) => {
    const request = documentSaveWorkingRequestSchema.parse(payload);
    const e2eDelay = readE2eDocumentSaveDelay();
    if (e2eDelay > 0) await new Promise((resolve) => setTimeout(resolve, e2eDelay));
    return documentResult(() => session.saveWorkingDocument(request));
  });
  ipcMain.handle(desktopIpcChannels.documentSaveStable, async (_event, payload: unknown) => {
    const request = documentSaveStableRequestSchema.parse(payload);
    const e2eDelay = readE2eDocumentSaveDelay();
    if (e2eDelay > 0) await new Promise((resolve) => setTimeout(resolve, e2eDelay));
    return documentResult(() => session.saveStableDocument(request));
  });
  ipcMain.handle(desktopIpcChannels.workspaceMutate, (_event, payload: unknown) => creativeMutationResult(() => {
    const request = creativeWorkspaceMutationSchema.parse(payload);
    return session.mutateCreativeWorkspace(request);
  }));
  ipcMain.handle(desktopIpcChannels.creativeDocumentGet, (_event, payload: unknown) => creativeDocumentResult(() => {
    const request = creativeDocumentGetRequestSchema.parse(payload);
    return session.getCreativeDocument(request.documentId);
  }));
  ipcMain.handle(desktopIpcChannels.creativeDocumentSaveWorking, (_event, payload: unknown) => creativeDocumentResult(() => {
    const request = creativeDocumentSaveWorkingRequestSchema.parse(payload);
    return session.saveWorkingCreativeDocument(request);
  }));
  ipcMain.handle(desktopIpcChannels.creativeDocumentSaveStable, (_event, payload: unknown) => creativeDocumentResult(() => {
    const request = creativeDocumentSaveStableRequestSchema.parse(payload);
    return session.saveStableCreativeDocument(request);
  }));
  ipcMain.handle(desktopIpcChannels.creativeDocumentDiscardWorking, (_event, payload: unknown) => creativeDocumentResult(() => {
    const request = creativeDocumentDiscardWorkingRequestSchema.parse(payload);
    return session.discardWorkingCreativeDocument(request);
  }));
  ipcMain.handle(desktopIpcChannels.constraintEditorGet, (_event, payload: unknown) => constraintEditorResult(() => {
    const request = constraintEditorGetRequestSchema.parse(payload);
    return session.getConstraintEditor(request.profileId);
  }));
  ipcMain.handle(desktopIpcChannels.constraintEditorSaveWorking, (_event, payload: unknown) => constraintEditorResult(() => {
    const request = constraintEditorSaveWorkingRequestSchema.parse(payload);
    return session.saveWorkingConstraint(request);
  }));
  ipcMain.handle(desktopIpcChannels.constraintEditorSaveStable, (_event, payload: unknown) => constraintEditorResult(() => {
    const request = constraintEditorRevisionRequestSchema.parse(payload);
    return session.saveStableConstraint(request);
  }));
  ipcMain.handle(desktopIpcChannels.constraintEditorDiscardWorking, (_event, payload: unknown) => constraintEditorResult(() => {
    const request = constraintEditorRevisionRequestSchema.parse(payload);
    return session.discardWorkingConstraint(request);
  }));
  ipcMain.handle(desktopIpcChannels.changeSetListPending, () => changeSetListResult(() => session.listPendingChangeSets()));
  ipcMain.handle(desktopIpcChannels.changeSetGet, (_event, payload: unknown) => changeSetDetailResult(() => {
    const request = changeSetGetRequestSchema.parse(payload);
    return session.getChangeSet(request.changeSetId);
  }));
  ipcMain.handle(desktopIpcChannels.changeSetDecide, (_event, payload: unknown) => changeSetDetailResult(() => {
    const request = changeSetDecisionRequestSchema.parse(payload);
    return session.decideChangeSetItem(request);
  }));
  ipcMain.handle(desktopIpcChannels.changeSetFinalizeAssist, (_event, payload: unknown) => changeSetDetailResult(() => {
    const request = changeSetFinalizeAssistRequestSchema.parse(payload);
    return session.finalizeAssistChangeSet(request);
  }));
  ipcMain.handle(desktopIpcChannels.graphSnapshot, () => graphSnapshotResult(() => session.getGraphSnapshot()));
  ipcMain.handle(desktopIpcChannels.graphInspectNode, (_event, payload: unknown) => graphInspectorResult(() => {
    const request = graphInspectNodeRequestSchema.parse(payload);
    return session.inspectGraphNode(request.nodeId);
  }));

  const e2eWorkspace = !app.isPackaged ? process.env.NOVAX_DESKTOP_E2E_WORKSPACE : undefined;
  if (e2eWorkspace) session.openPath(e2eWorkspace);
  return session;
}

function documentResult(operation: () => EditorDocumentSnapshot): DocumentOperationResult {
  try {
    return documentOperationResultSchema.parse({ ok: true, document: operation() });
  } catch (error) {
    const code = readDocumentErrorCode(error);
    return documentOperationResultSchema.parse({
      ok: false,
      error: {
        code,
        message: DOCUMENT_ERROR_MESSAGES[code],
      },
    });
  }
}

function creativeMutationResult(operation: () => WorkspaceSnapshot): CreativeMutationResult {
  try {
    return creativeMutationResultSchema.parse({ ok: true, workspace: operation() });
  } catch (error) {
    return creativeMutationResultSchema.parse({
      ok: false,
      error: { code: readPublicCode(error, "CREATIVE_MUTATION_FAILED"), message: readCreativeErrorMessage(error) },
    });
  }
}

function creativeDocumentResult(operation: () => CreativeEditorDocumentSnapshot) {
  try {
    return creativeDocumentOperationResultSchema.parse({ ok: true, document: operation() });
  } catch (error) {
    return creativeDocumentOperationResultSchema.parse({
      ok: false,
      error: { code: readPublicCode(error, "CREATIVE_DOCUMENT_OPERATION_FAILED"), message: readCreativeErrorMessage(error) },
    });
  }
}

function constraintEditorResult(operation: () => ConstraintEditorSnapshot) {
  try {
    return constraintEditorOperationResultSchema.parse({ ok: true, profile: operation() });
  } catch (error) {
    return constraintEditorOperationResultSchema.parse({
      ok: false,
      error: { code: readPublicCode(error, "CONSTRAINT_EDITOR_OPERATION_FAILED"), message: readCreativeErrorMessage(error) },
    });
  }
}

function readPublicCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code.slice(0, 120);
  }
  return fallback;
}

function readCreativeErrorMessage(error: unknown): string {
  const code = readPublicCode(error, "CREATIVE_OPERATION_FAILED");
  const messages: Record<string, string> = {
    WORKSPACE_NOT_OPEN: "尚未打开工作区。",
    WORKSPACE_AGENT_RUN_ACTIVE: "大管家运行期间不能修改创作对象。",
    RESOURCE_PARENT_KIND_INVALID: "这个对象不能放在所选位置。",
    RESOURCE_DOMAIN_KIND_MISMATCH: "对象种类与资源领域不匹配。",
    RESOURCE_OWNERSHIP_CYCLE: "移动会造成资源层级循环。",
    RESOURCE_CHILDREN_ACTIVE: "请先移动或删除下级对象。",
    RESOURCE_RELATIONS_ACTIVE: "请先移除与该对象有关的关联。",
    RESOURCE_DOMAIN_ROOT_PROTECTED: "系统资源根目录不能删除。",
    DOCUMENT_KIND_OWNER_INVALID: "这种文档不能创建在当前对象下。",
    RELATION_SOURCE_KIND_INVALID: "关联的来源对象种类不正确。",
    RELATION_TARGET_KIND_INVALID: "关联的目标对象种类不正确。",
    RELATION_DUPLICATE: "相同的对象关联已经存在。",
    DOCUMENT_EDIT_CONFLICT: "文档已发生变化，请重新载入。",
    DOCUMENT_BASE_CHANGED: "稳定版本已经变化，当前草稿不能覆盖。",
    CONSTRAINT_EDIT_CONFLICT: "写作约束草稿已经变化，请重新载入。",
    CONSTRAINT_BASE_CHANGED: "稳定写作约束已经变化，当前草稿不能覆盖。",
    CONSTRAINT_WORKING_COPY_NOT_FOUND: "当前没有可发布或放弃的写作约束草稿。",
  };
  return messages[code] ?? "创作操作失败，请检查对象关系后重试。";
}

function workspaceHistoryResult(operation: () => CheckpointHistoryEntry[]): WorkspaceHistoryResult {
  try {
    return workspaceHistoryResultSchema.parse({ ok: true, checkpoints: operation() });
  } catch (error) {
    return workspaceHistoryResultSchema.parse({ ok: false, error: publicWorkspaceHistoryError(error) });
  }
}

function workspaceRestoreResult(operation: () => WorkspaceSnapshot): WorkspaceRestoreResult {
  try {
    return workspaceRestoreResultSchema.parse({ ok: true, workspace: operation() });
  } catch (error) {
    return workspaceRestoreResultSchema.parse({ ok: false, error: publicWorkspaceHistoryError(error) });
  }
}

function projectDoctorResult(operation: () => unknown): ProjectDoctorResult {
  try {
    return projectDoctorResultSchema.parse({ ok: true, report: operation() });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      && String((error as { code: unknown }).code) === "WORKSPACE_NOT_OPEN"
      ? "WORKSPACE_NOT_OPEN"
      : "PROJECT_DOCTOR_FAILED";
    const message = code === "WORKSPACE_NOT_OPEN"
      ? "尚未打开工作区。"
      : "项目体检失败，请重试。";
    return projectDoctorResultSchema.parse({ ok: false, error: { code, message } });
  }
}

function storyProfileResult(operation: () => unknown): StoryProfileCreateResult {
  try {
    return storyProfileCreateResultSchema.parse({ ok: true, profile: operation() });
  } catch (error) {
    return storyProfileCreateResultSchema.parse({ ok: false, error: publicPlayError(error) });
  }
}

function storyProfileListResult(operation: () => unknown): StoryProfileListResult {
  try { return storyProfileListResultSchema.parse({ ok: true, profiles: operation() }); }
  catch (error) { return storyProfileListResultSchema.parse({ ok: false, error: publicPlayError(error) }); }
}

function startProfileResult(operation: () => unknown): StartProfileResult {
  try {
    return startProfileResultSchema.parse({ ok: true, startProfile: operation() });
  } catch (error) {
    return startProfileResultSchema.parse({ ok: false, error: publicPlayError(error) });
  }
}

function startProfileListResult(operation: () => unknown): StartProfileListResult {
  try {
    return startProfileListResultSchema.parse({ ok: true, startProfiles: operation() });
  } catch (error) {
    return startProfileListResultSchema.parse({ ok: false, error: publicPlayError(error) });
  }
}

function playthroughResult(operation: () => unknown): PlaythroughResult {
  try {
    return playthroughResultSchema.parse({ ok: true, playthrough: operation() });
  } catch (error) {
    return playthroughResultSchema.parse({ ok: false, error: publicPlayError(error) });
  }
}

function playthroughListResult(operation: () => unknown): PlaythroughListResult {
  try { return playthroughListResultSchema.parse({ ok: true, playthroughs: operation() }); }
  catch (error) { return playthroughListResultSchema.parse({ ok: false, error: publicPlayError(error) }); }
}

function playTurnListResult(operation: () => unknown): PlayTurnListResult {
  try {
    const turns = operation() as Array<{ id: string; playthroughId: string; sequence: number; playerAction: string; writerText: string; stateSnapshot: unknown; createdAt: string }>;
    return playTurnListResultSchema.parse({ ok: true, turns: turns.map((turn) => ({ id: turn.id, playthroughId: turn.playthroughId,
      sequence: turn.sequence, playerAction: turn.playerAction, writerText: turn.writerText, stateSnapshot: turn.stateSnapshot, createdAt: turn.createdAt })) });
  } catch (error) { return playTurnListResultSchema.parse({ ok: false, error: publicPlayError(error) }); }
}

function playthroughInspectResult(operation: () => unknown): PlaythroughInspectResult {
  try {
    return playthroughInspectResultSchema.parse({ ok: true, reconciliation: operation() });
  } catch (error) {
    return playthroughInspectResultSchema.parse({ ok: false, error: publicPlayError(error) });
  }
}

function publicPlayError(error: unknown) {
  const internal = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (internal === "WORKSPACE_NOT_OPEN") return { code: "WORKSPACE_NOT_OPEN" as const, message: "尚未打开工作区。" };
  if (internal === "PLAYTHROUGH_NOT_FOUND") return { code: "PLAYTHROUGH_NOT_FOUND" as const, message: "找不到这个游玩存档。" };
  if (internal.startsWith("STORY_PROFILE_")) return { code: "STORY_PROFILE_INVALID" as const, message: "故事配置不完整或正史版本尚未就绪。" };
  if (internal.startsWith("START_PROFILE_")) return { code: "START_PROFILE_INVALID" as const, message: "起始模板无效、未启用或来源审核尚未完成。" };
  if (internal.startsWith("PLAYTHROUGH_RECONCILIATION_")) return { code: "PLAYTHROUGH_RECONCILIATION_REQUIRED" as const, message: "需要先选择继续旧存档或创建新分支。" };
  if (internal.startsWith("PLAYTHROUGH_") || internal.startsWith("PLAY_")) return { code: "PLAY_OPERATION_INVALID" as const, message: "当前游玩操作不符合存档状态。" };
  return { code: "PLAY_OPERATION_FAILED" as const, message: "游玩存档操作失败，请重试。" };
}

function publicWorkspaceHistoryError(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "CHECKPOINT_RESTORE_FAILED";
  const safeCode = code === "WORKSPACE_NOT_OPEN"
    || code === "WORKSPACE_AGENT_RUN_ACTIVE"
    || code === "CHECKPOINT_NOT_FOUND"
    ? code
    : "CHECKPOINT_RESTORE_FAILED";
  const messages = {
    WORKSPACE_NOT_OPEN: "尚未打开工作区。",
    WORKSPACE_AGENT_RUN_ACTIVE: "大管家运行期间不能回溯。",
    CHECKPOINT_NOT_FOUND: "找不到这个历史版本。",
    CHECKPOINT_RESTORE_FAILED: "回溯失败，请重试。",
  } as const;
  return { code: safeCode, message: messages[safeCode] };
}

function readDocumentErrorCode(error: unknown): DocumentErrorCode {
  if (typeof error !== "object" || error === null || !("code" in error)) return "DOCUMENT_OPERATION_FAILED";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code in DOCUMENT_ERROR_MESSAGES
    ? code as DocumentErrorCode
    : "DOCUMENT_OPERATION_FAILED";
}

const DOCUMENT_ERROR_MESSAGES: Record<DocumentErrorCode, string> = {
  WORKSPACE_NOT_OPEN: "尚未打开工作区。",
  RESOURCE_NOT_FOUND: "当前分支中找不到这个创作资源。",
  DOCUMENT_WORKING_COPY_NOT_FOUND: "请先保存草稿，再创建稳定版本。",
  DOCUMENT_EDIT_CONFLICT: "文档已在其他操作中发生变化，请重新载入后再保存。",
  DOCUMENT_BASE_CHANGED: "稳定版本已发生变化，当前草稿不能直接覆盖它。",
  DOCUMENT_NOT_DIRTY: "文档没有尚未发布的修改。",
  DOCUMENT_OPERATION_FAILED: "文档操作失败，请重试。",
};

function readE2eDocumentSaveDelay(): number {
  if (app.isPackaged) return 0;
  const value = Number(process.env.NOVAX_DESKTOP_E2E_DOCUMENT_SAVE_DELAY_MS || 0);
  return Number.isInteger(value) && value >= 0 && value <= 5_000 ? value : 0;
}

function changeSetListResult(operation: () => SafeChangeSetSummary[]): ChangeSetListPendingResult {
  try {
    return changeSetListPendingResultSchema.parse({ ok: true, changeSets: operation() });
  } catch (error) {
    return changeSetListPendingResultSchema.parse({ ok: false, error: publicChangeSetError(error) });
  }
}

function changeSetDetailResult(operation: () => SafeChangeSetDetail): ChangeSetDetailResult {
  try {
    return changeSetDetailResultSchema.parse({ ok: true, changeSet: operation() });
  } catch (error) {
    return changeSetDetailResultSchema.parse({ ok: false, error: publicChangeSetError(error) });
  }
}

function publicChangeSetError(error: unknown): { code: ChangeSetErrorCode; message: string } {
  const code = readChangeSetErrorCode(error);
  return { code, message: CHANGE_SET_ERROR_MESSAGES[code] };
}

function readChangeSetErrorCode(error: unknown): ChangeSetErrorCode {
  if (typeof error !== "object" || error === null || !("code" in error)) return "CHANGE_SET_OPERATION_FAILED";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code in CHANGE_SET_ERROR_MESSAGES
    ? code as ChangeSetErrorCode
    : "CHANGE_SET_OPERATION_FAILED";
}

const CHANGE_SET_ERROR_MESSAGES: Record<ChangeSetErrorCode, string> = {
  WORKSPACE_NOT_OPEN: "尚未打开工作区。",
  CHANGE_SET_NOT_FOUND: "找不到这个变更集。",
  CHANGE_SET_NOT_PENDING: "这个变更集已经结束，不能继续审查。",
  CHANGE_SET_REVIEW_NOT_ALLOWED: "这个变更集不支持协助审查。",
  CHANGE_SET_ITEM_NOT_FOUND: "找不到要审查的变更项。",
  CHANGE_SET_MAJOR_CONFLICT: "存在重大冲突，必须先修改方案，不能直接提交。",
  CHANGE_SET_REVIEW_INCOMPLETE: "仍有变更项尚未决定。",
  CHANGE_SET_DEPENDENCY_UNRESOLVED: "已接受内容依赖未接受的变更，请先处理依赖。",
  CHANGE_SET_EXPECTED_HEAD_MISMATCH: "变更基线与当前版本不一致，请重新载入。",
  CHANGE_SET_BASE_STALE: "工作区已产生新版本，请重新检查这组变更。",
  CHANGE_SET_BRANCH_MISMATCH: "这组变更不属于当前时间分支。",
  CHANGE_SET_BLOCKED: "这组变更当前被安全策略阻塞。",
  CHANGE_SET_DATA_INVALID: "变更集数据无法安全读取。",
  CHANGE_SET_OPERATION_FAILED: "变更集操作失败，请重试。",
};

function graphSnapshotResult(operation: () => SemanticGraphSnapshot): GraphSnapshotResult {
  try {
    return graphSnapshotResultSchema.parse({ ok: true, graph: operation() });
  } catch (error) {
    return graphSnapshotResultSchema.parse({ ok: false, error: publicGraphError(error) });
  }
}

function graphInspectorResult(operation: () => SemanticGraphInspector): GraphInspectorResult {
  try {
    return graphInspectorResultSchema.parse({ ok: true, inspector: operation() });
  } catch (error) {
    return graphInspectorResultSchema.parse({ ok: false, error: publicGraphError(error) });
  }
}

function publicGraphError(error: unknown): { code: GraphErrorCode; message: string } {
  const code = readGraphErrorCode(error);
  return { code, message: GRAPH_ERROR_MESSAGES[code] };
}

function readGraphErrorCode(error: unknown): GraphErrorCode {
  if (typeof error === "object" && error !== null) {
    if ("code" in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code in GRAPH_ERROR_MESSAGES) return code as GraphErrorCode;
    }
    if ("name" in error && (error as { name?: unknown }).name === "ZodError") return "GRAPH_DATA_INVALID";
  }
  return "GRAPH_OPERATION_FAILED";
}

const GRAPH_ERROR_MESSAGES: Record<GraphErrorCode, string> = {
  WORKSPACE_NOT_OPEN: "尚未打开工作区。",
  GRAPH_NODE_NOT_FOUND: "当前版本中找不到这个图谱节点。",
  GRAPH_DATA_INVALID: "图谱数据无法安全读取。",
  GRAPH_OPERATION_FAILED: "图谱读取失败，请重试。",
};
