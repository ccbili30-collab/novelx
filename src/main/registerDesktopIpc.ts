import { ipcMain } from "electron";
import {
  agentRunCancelRequestSchema,
  agentRunStartRequestSchema,
  playerTurnStartRequestSchema,
  playerTurnStartResponseSchema,
  playerTurnCancelRequestSchema,
  desktopIpcChannels,
  systemStatusSchema,
} from "../shared/ipcContract";
import { AgentProcessSupervisor, type AgentRuntimeLease } from "./agentProcessSupervisor";
import { PlayerProcessSupervisor, type PlayerRuntimeLease } from "./playerProcessSupervisor";
import type { ProviderRuntimeProfile } from "../shared/providerContract";
import { ApplicationRegistryRepository } from "../domain/application/applicationRegistryRepository";

export function registerDesktopIpc(
  workerPath: string,
  applicationRegistry: ApplicationRegistryRepository,
  acquireRuntimeLease: () => AgentRuntimeLease | null = () => null,
  getProviderProfile: () => ProviderRuntimeProfile | null = () => null,
  acquirePlayerRuntimeLease: () => PlayerRuntimeLease | null = () => null,
): { dispose(): void } {
  const supervisor = new AgentProcessSupervisor(workerPath, { acquireRuntimeLease, getProviderProfile });
  const playerSupervisor = new PlayerProcessSupervisor(workerPath, { acquireRuntimeLease: acquirePlayerRuntimeLease, getProviderProfile });

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
  return { dispose: () => { playerSupervisor.dispose(); supervisor.dispose(); } };
}
