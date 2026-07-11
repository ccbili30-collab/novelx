import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SafePiEvent } from "./eventProjection";
import type { AgentCollaborationContext, AgentSessionHistory } from "../../shared/agentWorkerProtocol";

export interface RuntimeAdapter {
  run(input: {
    systemPrompt: string;
    userInput: string;
    sessionHistory?: AgentSessionHistory;
    collaborationContext?: AgentCollaborationContext;
    tools: AgentTool[];
    signal?: AbortSignal;
    onEvent?(event: SafePiEvent): void;
    completionGuard?: {
      toolName: string;
      isSatisfied(): boolean;
      createCorrection?(): string;
      forceTool?: boolean;
      requiredToolName?(): string;
    };
  }): Promise<{
    text: string;
    stopReason: "stop";
    receipt?: {
      actualProviderId: string | null;
      actualModelId: string | null;
      responseIdSha256: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      contextPolicyVersion: string;
      maxChargedInputBytes: number;
      configuredContextWindow: number;
      safetyReserve: number;
      outputReserve: number;
      estimatedInputTokens?: number;
      availableInputBudget?: number;
      systemPromptTokens?: number;
      toolProtocolTokens?: number;
      sessionHistoryTokens?: number;
      retrievalTokens?: number;
      collaborationTokens?: number;
      runtimeConversationTokens?: number;
      correctionAttempts?: number;
    };
  }>;
}
