import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  agentRunCancelRequestSchema,
  agentRunEventSchema,
  agentRunStartRequestSchema,
  agentRunStartResponseSchema,
  changeSetDecisionRequestSchema,
  changeSetDetailResultSchema,
  changeSetFinalizeAssistRequestSchema,
  changeSetGetRequestSchema,
  changeSetListPendingResultSchema,
  desktopIpcChannels,
  collaborationListRequestSchema,
  collaborationListResultSchema,
  handoffCreateRequestSchema,
  handoffSummarySchema,
  handoffUpdateRequestSchema,
  documentGetRequestSchema,
  documentOperationResultSchema,
  documentSaveStableRequestSchema,
  documentSaveWorkingRequestSchema,
  creativeWorkspaceMutationSchema,
  creativeMutationResultSchema,
  creativeDocumentGetRequestSchema,
  creativeDocumentSaveWorkingRequestSchema,
  creativeDocumentSaveStableRequestSchema,
  creativeDocumentDiscardWorkingRequestSchema,
  creativeDocumentOperationResultSchema,
  constraintEditorGetRequestSchema,
  constraintEditorSaveWorkingRequestSchema,
  constraintEditorRevisionRequestSchema,
  constraintEditorOperationResultSchema,
  graphInspectNodeRequestSchema,
  graphInspectorResultSchema,
  graphSnapshotResultSchema,
  nullableWorkspaceSnapshotSchema,
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
  playerTurnStartRequestSchema,
  playerTurnStartResponseSchema,
  playerTurnCancelRequestSchema,
  playerTurnEventSchema,
  sourceListResultSchema,
  sourceAddRequestSchema,
  sourceAddResultSchema,
  sourceParseRequestSchema,
  sourceParseResultSchema,
  decompositionCandidateListRequestSchema,
  decompositionCandidateListResultSchema,
  decompositionCandidateReviseRequestSchema,
  decompositionCandidateDecideRequestSchema,
  decomposerStartRequestSchema,
  decomposerStartResultSchema,
  decomposerCancelRequestSchema,
  publicDecomposerEventSchema,
  importCandidateProposeRequestSchema,
  importCandidateProposeResultSchema,
  nullableProjectAddResultSchema,
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
  sessionRetractLastRequestSchema,
  sessionRetractLastResultSchema,
  sessionRenameRequestSchema,
  sessionSummarySchema,
  sharedMemoryPublishRequestSchema,
  sharedMemorySummarySchema,
  systemStatusSchema,
  workspaceFlushCompleteSchema,
  workspaceFlushRequestSchema,
  workspaceHistoryResultSchema,
  workspaceRestoreRequestSchema,
  workspaceRestoreResultSchema,
  type DesktopApi,
} from "../shared/ipcContract";
import { desktopUpdateStateSchema } from "../shared/desktopUpdateContract";
import {
  providerSaveRequestSchema,
  providerStatusResultSchema,
  providerTestRequestSchema,
  providerTestResultSchema,
} from "../shared/providerContract";

const flushSubscribers = new Set<(request: import("../shared/ipcContract").WorkspaceFlushRequest) => void>();
const pendingFlushRequests: import("../shared/ipcContract").WorkspaceFlushRequest[] = [];

ipcRenderer.on(desktopIpcChannels.workspaceFlushRequest, (_event, payload: unknown) => {
  const parsed = workspaceFlushRequestSchema.safeParse(payload);
  if (!parsed.success) return;
  if (flushSubscribers.size === 0) {
    pendingFlushRequests.push(parsed.data);
    return;
  }
  for (const subscriber of flushSubscribers) subscriber(parsed.data);
});

export function exposeDesktopApi(): void {
  const api: DesktopApi = {
    system: {
      async getStatus() {
        return systemStatusSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.systemStatus));
      },
    },
    update: {
      async getStatus() {
        return desktopUpdateStateSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.updateStatus));
      },
      async check() {
        return desktopUpdateStateSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.updateCheck));
      },
      async download() {
        return desktopUpdateStateSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.updateDownload));
      },
      async install() {
        await ipcRenderer.invoke(desktopIpcChannels.updateInstall);
      },
      subscribe(listener) {
        const handler = (_event: IpcRendererEvent, payload: unknown) => {
          const parsed = desktopUpdateStateSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data);
        };
        ipcRenderer.on(desktopIpcChannels.updateEvent, handler);
        return () => ipcRenderer.removeListener(desktopIpcChannels.updateEvent, handler);
      },
    },
    project: {
      async list() {
        return projectListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.projectList));
      },
      async add() {
        return nullableProjectAddResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.projectAdd));
      },
      async select(request) {
        const safeRequest = projectSelectRequestSchema.parse(request);
        return projectSelectResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.projectSelect, safeRequest));
      },
      async remove(request) {
        const safeRequest = projectRemoveRequestSchema.parse(request);
        return projectListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.projectRemove, safeRequest));
      },
      async listRemoved() {
        return projectListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.projectListRemoved));
      },
      async restore(request) {
        const safeRequest = projectRestoreRequestSchema.parse(request);
        return projectListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.projectRestore, safeRequest));
      },
      async rescan(request) {
        const safeRequest = projectRescanRequestSchema.parse(request);
        return projectSelectResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.projectRescan, safeRequest));
      },
      async initialize(request) {
        const safeRequest = projectInitializeRequestSchema.parse(request);
        return projectSelectResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.projectInitialize, safeRequest));
      },
    },
    session: {
      async list(request) {
        const safeRequest = sessionListRequestSchema.parse(request);
        return sessionListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sessionList, safeRequest));
      },
      async create(request) {
        const safeRequest = sessionCreateRequestSchema.parse(request);
        return sessionSummarySchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sessionCreate, safeRequest));
      },
      async rename(request) {
        const safeRequest = sessionRenameRequestSchema.parse(request);
        return sessionSummarySchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sessionRename, safeRequest));
      },
      async archive(request) {
        const safeRequest = sessionArchiveRequestSchema.parse(request);
        return sessionSummarySchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sessionArchive, safeRequest));
      },
      async clear(request) {
        const safeRequest = sessionClearRequestSchema.parse(request);
        return sessionSummarySchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sessionClear, safeRequest));
      },
      async delete(request) {
        const safeRequest = sessionDeleteRequestSchema.parse(request);
        return sessionListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sessionDelete, safeRequest));
      },
      async export(request) {
        const safeRequest = sessionExportRequestSchema.parse(request);
        return sessionExportResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sessionExport, safeRequest));
      },
      async messages(request) {
        const safeRequest = sessionMessageListRequestSchema.parse(request);
        return sessionMessageListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sessionMessages, safeRequest));
      },
      async retractLast(request) {
        const safeRequest = sessionRetractLastRequestSchema.parse(request);
        return sessionRetractLastResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sessionRetractLast, safeRequest));
      },
    },
    collaboration: {
      async list(request) {
        const safeRequest = collaborationListRequestSchema.parse(request);
        return collaborationListResultSchema.parse(
          await ipcRenderer.invoke(desktopIpcChannels.collaborationList, safeRequest),
        );
      },
      async publishMemory(request) {
        const safeRequest = sharedMemoryPublishRequestSchema.parse(request);
        return sharedMemorySummarySchema.parse(
          await ipcRenderer.invoke(desktopIpcChannels.sharedMemoryPublish, safeRequest),
        );
      },
      async createHandoff(request) {
        const safeRequest = handoffCreateRequestSchema.parse(request);
        return handoffSummarySchema.parse(await ipcRenderer.invoke(desktopIpcChannels.handoffCreate, safeRequest));
      },
      async updateHandoff(request) {
        const safeRequest = handoffUpdateRequestSchema.parse(request);
        return handoffSummarySchema.parse(await ipcRenderer.invoke(desktopIpcChannels.handoffUpdate, safeRequest));
      },
    },
    workspace: {
      async open() {
        return nullableWorkspaceSnapshotSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.workspaceOpen));
      },
      async getCurrent() {
        return nullableWorkspaceSnapshotSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.workspaceCurrent));
      },
      async listHistory() {
        return workspaceHistoryResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.workspaceHistory));
      },
      async getLatestContextBudget() {
        return nullableContextBudgetAuditSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.workspaceContextBudget));
      },
      async inspectProject() {
        return projectDoctorResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.workspaceDoctor));
      },
      async restore(request) {
        const safeRequest = workspaceRestoreRequestSchema.parse(request);
        return workspaceRestoreResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.workspaceRestore, safeRequest));
      },
      subscribeFlushRequest(listener) {
        flushSubscribers.add(listener);
        for (const request of pendingFlushRequests.splice(0)) listener(request);
        return () => flushSubscribers.delete(listener);
      },
      completeFlush(request) {
        ipcRenderer.send(desktopIpcChannels.workspaceFlushComplete, workspaceFlushCompleteSchema.parse(request));
      },
      async mutate(request) {
        const safeRequest = creativeWorkspaceMutationSchema.parse(request);
        const result = creativeMutationResultSchema.parse(
          await ipcRenderer.invoke(desktopIpcChannels.workspaceMutate, safeRequest),
        );
        if (result.ok) return result.workspace;
        throw new Error(result.error.message);
      },
    },
    play: {
      async createStoryProfile(request) {
        const safeRequest = storyProfileCreateRequestSchema.parse(request);
        return storyProfileCreateResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.storyProfileCreate, safeRequest));
      },
      async listStoryProfiles() {
        return storyProfileListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.storyProfileList));
      },
      async createStartProfile(request) {
        const safeRequest = startProfileCreateRequestSchema.parse(request);
        return startProfileResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.startProfileCreate, safeRequest));
      },
      async listStartProfiles(request) {
        const safeRequest = startProfileListRequestSchema.parse(request);
        return startProfileListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.startProfileList, safeRequest));
      },
      async createPlaythrough(request) {
        const safeRequest = playthroughCreateRequestSchema.parse(request);
        return playthroughResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.playthroughCreate, safeRequest));
      },
      async listPlaythroughs(request) {
        const safeRequest = playthroughListRequestSchema.parse(request);
        return playthroughListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.playthroughList, safeRequest));
      },
      async listTurns(request) {
        const safeRequest = playTurnListRequestSchema.parse(request);
        return playTurnListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.playTurnList, safeRequest));
      },
      async inspect(request) {
        const safeRequest = playthroughInspectRequestSchema.parse(request);
        return playthroughInspectResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.playthroughInspect, safeRequest));
      },
      async resolve(request) {
        const safeRequest = playthroughResolveRequestSchema.parse(request);
        return playthroughResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.playthroughResolve, safeRequest));
      },
      async runTurn(request) {
        const safeRequest = playerTurnStartRequestSchema.parse(request);
        return playerTurnStartResponseSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.playerTurnStart, safeRequest));
      },
      async cancelTurn(request) {
        await ipcRenderer.invoke(desktopIpcChannels.playerTurnCancel, playerTurnCancelRequestSchema.parse(request));
      },
      subscribeTurns(listener) {
        const handler = (_event: IpcRendererEvent, payload: unknown) => {
          const parsed = playerTurnEventSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data);
        };
        ipcRenderer.on(desktopIpcChannels.playerTurnEvent, handler);
        return () => ipcRenderer.removeListener(desktopIpcChannels.playerTurnEvent, handler);
      },
    },
    sourceLibrary: {
      async list() {
        return sourceListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sourceList));
      },
      async add(request) {
        return sourceAddResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sourceAdd, sourceAddRequestSchema.parse(request)));
      },
      async parse(request) {
        return sourceParseResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.sourceParse, sourceParseRequestSchema.parse(request)));
      },
      async listCandidates(request) {
        return decompositionCandidateListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.decompositionCandidateList, decompositionCandidateListRequestSchema.parse(request)));
      },
      async reviseCandidate(request) {
        return decompositionCandidateListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.decompositionCandidateRevise, decompositionCandidateReviseRequestSchema.parse(request)));
      },
      async decideCandidate(request) {
        return decompositionCandidateListResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.decompositionCandidateDecide, decompositionCandidateDecideRequestSchema.parse(request)));
      },
      async startDecomposer(request) {
        return decomposerStartResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.decomposerStart, decomposerStartRequestSchema.parse(request)));
      },
      async cancelDecomposer(request) {
        await ipcRenderer.invoke(desktopIpcChannels.decomposerCancel, decomposerCancelRequestSchema.parse(request));
      },
      subscribeDecomposer(listener) {
        const handler = (_event: IpcRendererEvent, payload: unknown) => { const parsed = publicDecomposerEventSchema.safeParse(payload); if (parsed.success) listener(parsed.data); };
        ipcRenderer.on(desktopIpcChannels.decomposerEvent, handler);
        return () => ipcRenderer.removeListener(desktopIpcChannels.decomposerEvent, handler);
      },
      async proposeCandidates(request) {
        return importCandidateProposeResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.importCandidatePropose, importCandidateProposeRequestSchema.parse(request)));
      },
    },
    document: {
      async get(request) {
        const safeRequest = documentGetRequestSchema.parse(request);
        return unwrapDocumentResult(await ipcRenderer.invoke(desktopIpcChannels.documentGet, safeRequest));
      },
      async saveWorking(request) {
        const safeRequest = documentSaveWorkingRequestSchema.parse(request);
        return unwrapDocumentResult(await ipcRenderer.invoke(desktopIpcChannels.documentSaveWorking, safeRequest));
      },
      async saveStable(request) {
        const safeRequest = documentSaveStableRequestSchema.parse(request);
        return unwrapDocumentResult(await ipcRenderer.invoke(desktopIpcChannels.documentSaveStable, safeRequest));
      },
    },
    creativeDocument: {
      async get(request) {
        const safeRequest = creativeDocumentGetRequestSchema.parse(request);
        return unwrapCreativeDocumentResult(
          await ipcRenderer.invoke(desktopIpcChannels.creativeDocumentGet, safeRequest),
        );
      },
      async saveWorking(request) {
        const safeRequest = creativeDocumentSaveWorkingRequestSchema.parse(request);
        return unwrapCreativeDocumentResult(
          await ipcRenderer.invoke(desktopIpcChannels.creativeDocumentSaveWorking, safeRequest),
        );
      },
      async saveStable(request) {
        const safeRequest = creativeDocumentSaveStableRequestSchema.parse(request);
        return unwrapCreativeDocumentResult(
          await ipcRenderer.invoke(desktopIpcChannels.creativeDocumentSaveStable, safeRequest),
        );
      },
      async discardWorking(request) {
        const safeRequest = creativeDocumentDiscardWorkingRequestSchema.parse(request);
        return unwrapCreativeDocumentResult(
          await ipcRenderer.invoke(desktopIpcChannels.creativeDocumentDiscardWorking, safeRequest),
        );
      },
    },
    constraintEditor: {
      async get(request) {
        const safeRequest = constraintEditorGetRequestSchema.parse(request);
        return unwrapConstraintEditorResult(await ipcRenderer.invoke(desktopIpcChannels.constraintEditorGet, safeRequest));
      },
      async saveWorking(request) {
        const safeRequest = constraintEditorSaveWorkingRequestSchema.parse(request);
        return unwrapConstraintEditorResult(await ipcRenderer.invoke(desktopIpcChannels.constraintEditorSaveWorking, safeRequest));
      },
      async saveStable(request) {
        const safeRequest = constraintEditorRevisionRequestSchema.parse(request);
        return unwrapConstraintEditorResult(await ipcRenderer.invoke(desktopIpcChannels.constraintEditorSaveStable, safeRequest));
      },
      async discardWorking(request) {
        const safeRequest = constraintEditorRevisionRequestSchema.parse(request);
        return unwrapConstraintEditorResult(await ipcRenderer.invoke(desktopIpcChannels.constraintEditorDiscardWorking, safeRequest));
      },
    },
    provider: {
      async getStatus() {
        return providerStatusResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.providerStatus));
      },
      async save(request) {
        const safeRequest = providerSaveRequestSchema.parse(request);
        return providerStatusResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.providerSave, safeRequest));
      },
      async clearCredential() {
        return providerStatusResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.providerClearCredential));
      },
      async test(request) {
        const safeRequest = providerTestRequestSchema.parse(request);
        return providerTestResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.providerTest, safeRequest));
      },
    },
    changeSet: {
      async listPending() {
        return changeSetListPendingResultSchema.parse(
          await ipcRenderer.invoke(desktopIpcChannels.changeSetListPending),
        );
      },
      async get(request) {
        const safeRequest = changeSetGetRequestSchema.parse(request);
        return changeSetDetailResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.changeSetGet, safeRequest));
      },
      async decide(request) {
        const safeRequest = changeSetDecisionRequestSchema.parse(request);
        return changeSetDetailResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.changeSetDecide, safeRequest));
      },
      async finalizeAssist(request) {
        const safeRequest = changeSetFinalizeAssistRequestSchema.parse(request);
        return changeSetDetailResultSchema.parse(
          await ipcRenderer.invoke(desktopIpcChannels.changeSetFinalizeAssist, safeRequest),
        );
      },
    },
    graph: {
      async getSnapshot() {
        return graphSnapshotResultSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.graphSnapshot));
      },
      async inspectNode(request) {
        const safeRequest = graphInspectNodeRequestSchema.parse(request);
        return graphInspectorResultSchema.parse(
          await ipcRenderer.invoke(desktopIpcChannels.graphInspectNode, safeRequest),
        );
      },
    },
    agent: {
      async start(request) {
        const safeRequest = agentRunStartRequestSchema.parse(request);
        return agentRunStartResponseSchema.parse(await ipcRenderer.invoke(desktopIpcChannels.agentStart, safeRequest));
      },
      async cancel(request) {
        const safeRequest = agentRunCancelRequestSchema.parse(request);
        await ipcRenderer.invoke(desktopIpcChannels.agentCancel, safeRequest);
      },
      subscribe(listener) {
        const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
          const parsed = agentRunEventSchema.safeParse(payload);
          if (parsed.success) listener(parsed.data);
        };
        ipcRenderer.on(desktopIpcChannels.agentEvent, handler);
        return () => ipcRenderer.removeListener(desktopIpcChannels.agentEvent, handler);
      },
    },
  };

  contextBridge.exposeInMainWorld("novaxDesktop", api);
}

function unwrapDocumentResult(payload: unknown) {
  const result = documentOperationResultSchema.parse(payload);
  if (result.ok) return result.document;
  throw new Error(result.error.message);
}

function unwrapCreativeDocumentResult(payload: unknown) {
  const result = creativeDocumentOperationResultSchema.parse(payload);
  if (result.ok) return result.document;
  throw new Error(result.error.message);
}

function unwrapConstraintEditorResult(payload: unknown) {
  const result = constraintEditorOperationResultSchema.parse(payload);
  if (result.ok) return result.profile;
  throw new Error(result.error.message);
}
