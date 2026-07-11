import { ipcMain } from "electron";
import {
  agentRunCancelRequestSchema,
  agentRunStartRequestSchema,
  playerTurnStartRequestSchema,
  playerTurnStartResponseSchema,
  playerTurnCancelRequestSchema,
  decomposerStartRequestSchema,
  decomposerStartResultSchema,
  decomposerCancelRequestSchema,
  publicDecomposerEventSchema,
  desktopIpcChannels,
  systemStatusSchema,
} from "../shared/ipcContract";
import { AgentProcessSupervisor, type AgentRuntimeLease } from "./agentProcessSupervisor";
import { PlayerProcessSupervisor, type PlayerRuntimeLease } from "./playerProcessSupervisor";
import { DecomposerProcessSupervisor, type DecomposerRuntimeLease } from "./decomposerProcessSupervisor";
import type { ProviderRuntimeProfile } from "../shared/providerContract";
import { ApplicationRegistryRepository } from "../domain/application/applicationRegistryRepository";

export function registerDesktopIpc(
  workerPath: string,
  applicationRegistry: ApplicationRegistryRepository,
  acquireRuntimeLease: () => AgentRuntimeLease | null = () => null,
  getProviderProfile: () => ProviderRuntimeProfile | null = () => null,
  acquirePlayerRuntimeLease: () => PlayerRuntimeLease | null = () => null,
  acquireDecomposerRuntimeLease: () => DecomposerRuntimeLease | null = () => null,
): { dispose(): void } {
  const supervisor = new AgentProcessSupervisor(workerPath, { acquireRuntimeLease, getProviderProfile });
  const playerSupervisor = new PlayerProcessSupervisor(workerPath, { acquireRuntimeLease: acquirePlayerRuntimeLease, getProviderProfile });
  const decomposerSupervisor = new DecomposerProcessSupervisor(workerPath, { acquireRuntimeLease: acquireDecomposerRuntimeLease, getProviderProfile });

  ipcMain.handle(desktopIpcChannels.systemStatus, () => systemStatusSchema.parse({
    platform: process.platform,
    agent: "not_started",
  }));
  ipcMain.handle(desktopIpcChannels.agentStart, (event, payload: unknown) => {
    const request = agentRunStartRequestSchema.parse(payload);
    const session = applicationRegistry.getSession(request.sessionId);
    if (session.projectId !== request.projectId) throw new Error("AGENT_SESSION_PROJECT_MISMATCH");
    applicationRegistry.getProject(request.projectId);
    const sessionHistory = applicationRegistry.listRecentConversation(request.sessionId);
    const collaborationContext = applicationRegistry.getCollaborationContext(request.projectId, request.sessionId);
    applicationRegistry.appendMessage({
      sessionId: request.sessionId,
      role: "user",
      text: request.userInput,
      outcome: null,
    });
    applicationRegistry.setSessionState(request.sessionId, "working");
    const runId = supervisor.start(request, (agentEvent) => {
      const projected = { ...agentEvent, sessionId: request.sessionId };
      if (agentEvent.type === "run.completed") {
        applicationRegistry.appendMessage({
          sessionId: request.sessionId,
          role: "assistant",
          text: agentEvent.message,
          artifacts: agentEvent.artifacts,
          outcome: agentEvent.outcome === "awaiting_confirmation"
            ? "review"
            : agentEvent.outcome === "blocked" ? "blocked" : "completed",
        });
        applicationRegistry.setSessionState(
          request.sessionId,
          agentEvent.outcome === "awaiting_confirmation"
            ? "review"
            : agentEvent.outcome === "blocked" ? "blocked" : "idle",
        );
      } else if (agentEvent.type === "run.failed") {
        applicationRegistry.appendMessage({
          sessionId: request.sessionId,
          role: "error",
          text: agentEvent.message,
          outcome: "blocked",
        });
        applicationRegistry.setSessionState(request.sessionId, "blocked");
      }
      if (!event.sender.isDestroyed()) event.sender.send(desktopIpcChannels.agentEvent, projected);
    }, sessionHistory, collaborationContext);
    return { runId };
  });
  ipcMain.handle(desktopIpcChannels.agentCancel, (_event, payload: unknown) => {
    const request = agentRunCancelRequestSchema.parse(payload);
    supervisor.cancel(request.runId);
  });
  ipcMain.handle(desktopIpcChannels.playerTurnStart, (event, payload: unknown) => {
    const request = playerTurnStartRequestSchema.parse(payload);
    const runId = playerSupervisor.start(request, (playerEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send(desktopIpcChannels.playerTurnEvent, playerEvent);
    });
    return playerTurnStartResponseSchema.parse({ runId });
  });
  ipcMain.handle(desktopIpcChannels.playerTurnCancel, (_event, payload: unknown) => {
    playerSupervisor.cancel(playerTurnCancelRequestSchema.parse(payload).runId);
  });
  ipcMain.handle(desktopIpcChannels.decomposerStart, (event, payload: unknown) => {
    const request = decomposerStartRequestSchema.parse(payload);
    try {
      const runId = decomposerSupervisor.start(request.sourceId, (workerEvent) => {
        const projected = workerEvent.type === "decompose.started"
          ? { type: "started" as const, runId: workerEvent.runId, sourceId: request.sourceId }
          : workerEvent.type === "decompose.completed"
            ? { type: "completed" as const, runId: workerEvent.runId, sourceId: request.sourceId, candidateCount: workerEvent.output.candidates.length }
            : { type: "failed" as const, runId: workerEvent.runId, sourceId: request.sourceId, error: publicDecomposerError(workerEvent.error.code) };
        if (!event.sender.isDestroyed()) event.sender.send(desktopIpcChannels.decomposerEvent, publicDecomposerEventSchema.parse(projected));
      });
      return decomposerStartResultSchema.parse({ ok: true, runId });
    } catch (error) { return decomposerStartResultSchema.parse({ ok: false, error: publicDecomposerError(readCode(error)) }); }
  });
  ipcMain.handle(desktopIpcChannels.decomposerCancel, (_event, payload: unknown) => {
    decomposerSupervisor.cancel(decomposerCancelRequestSchema.parse(payload).runId);
  });
  return { dispose: () => { decomposerSupervisor.dispose(); playerSupervisor.dispose(); supervisor.dispose(); } };
}

function readCode(error: unknown): string { return error && typeof error === "object" && "code" in error ? String(error.code).slice(0, 120) : "DECOMPOSITION_FAILED"; }
function publicDecomposerError(code: string) {
  const messages: Record<string, string> = {
    REAL_DECOMPOSER_PROVIDER_REQUIRED: "需要先配置可用的模型服务。", WORKSPACE_NOT_OPEN: "需要先打开小说工作区。",
    DECOMPOSER_PROMPT_NOT_PUBLISHED: "拆解器提示词尚未通过发布验证。", DECOMPOSER_SOURCE_NOT_PARSED: "需要先解析来源资料。",
    SOURCE_RIGHTS_ATTESTATION_REQUIRED: "需要先确认资料的使用权。", SOURCE_FILE_CHANGED: "来源文件已经变化，请重新添加。",
    AGENT_RUN_CANCELLED: "拆解任务已取消。", AGENT_WORKER_INTERRUPTED: "拆解工作进程中断，未写入候选。",
  };
  return { code, message: messages[code] ?? "拆解任务失败，未写入候选。" };
}
