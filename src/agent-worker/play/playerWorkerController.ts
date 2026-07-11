import { canonicalAuditHash } from "../../domain/audit/canonicalAuditHash";
import { createHash } from "node:crypto";
import { getAgentRuntimeProfile } from "../../shared/agentRuntimeProfiles";
import type { AgentWorkerAuditOperation } from "../../shared/agentWorkerProtocol";
import { playerWorkerEventSchema, type PlayerWorkerEvent, type PlayerWorkerTurnStartCommand } from "../../shared/playerWorkerProtocol";
import type { ProviderRuntimeProfile } from "../../shared/providerContract";
import { createOpenAiCompatiblePiAdapter } from "../pi/NovaxPiRuntimeAdapter";
import type { RuntimeAdapter } from "../pi/runtimeAdapterContract";
import { loadActivePromptSet, type PublishedPrompt } from "../promptRegistry";
import { createSpecialistTools } from "../tools/createSpecialistTools";
import { requireActiveGmPrompt, type PlayPrompt } from "./playPromptRegistry";
import { runPlayerTurnPipeline } from "./playerTurnPipeline";

export interface PlayerWorkerDependencies {
  loadGmPrompt(): PlayPrompt;
  loadSpecialistPrompts(): PublishedPrompt[];
  createAdapter(profile: ProviderRuntimeProfile): RuntimeAdapter;
}

const defaults: PlayerWorkerDependencies = {
  loadGmPrompt: requireActiveGmPrompt,
  loadSpecialistPrompts: loadActivePromptSet,
  createAdapter: createOpenAiCompatiblePiAdapter,
};

export async function handlePlayerWorkerCommand(input: {
  command: PlayerWorkerTurnStartCommand;
  signal: AbortSignal;
  audit: { record(runId: string, operation: AgentWorkerAuditOperation, signal?: AbortSignal): Promise<void> };
  emit(event: PlayerWorkerEvent): void;
}, dependencies: PlayerWorkerDependencies = defaults): Promise<void> {
  const { command, signal, audit } = input;
  input.emit(playerWorkerEventSchema.parse({ type: "play.started", runId: command.runId }));
  if (!command.providerProfile) {
    emitFailure(command.runId, "REAL_GM_PROVIDER_REQUIRED", "需要先配置可用的模型服务。", input.emit);
    return;
  }
  try {
    const provider = command.providerProfile;
    if ([...command.evidence, ...command.styleConstraints].some((item) => createHash("sha256").update(item.content, "utf8").digest("hex") !== item.sha256)) {
      throw playerError("PLAYER_EVIDENCE_HASH_MISMATCH");
    }
    const gmPrompt = dependencies.loadGmPrompt();
    const prompts = dependencies.loadSpecialistPrompts();
    const gmInvocationId = `${command.runId}:gm`;
    const specialistTools = createSpecialistTools({
      runId: command.runId,
      parentInvocationId: gmInvocationId,
      providerProfile: provider,
      prompts,
      createAdapter: dependencies.createAdapter,
      audit,
    });
    const evidenceIds = command.evidence.map((item) => item.id);
    const result = await runPlayerTurnPipeline({
      turn: {
        playerAction: command.playerAction,
        canonicalEvidence: command.evidence.map((item) => `[${item.id}]\n${item.content}`).join("\n\n"),
        evidenceIds,
        currentState: command.currentState,
        recentMemory: command.recentMemory,
        luck: command.luck,
      },
      styleConstraints: command.styleConstraints.map((item) => item.content),
      providerProfile: provider,
      gmPrompt,
      createAdapter: dependencies.createAdapter,
      specialistTools,
      signal,
      gmLifecycle: createGmLifecycle({ runId: command.runId, invocationId: gmInvocationId, prompt: gmPrompt, provider, audit, signal }),
    });
    input.emit(playerWorkerEventSchema.parse({ type: "play.completed", runId: command.runId, result }));
  } catch (cause) {
    const code = publicCode(cause);
    emitFailure(command.runId, code, publicMessage(code), input.emit);
  }
}

function createGmLifecycle(input: {
  runId: string;
  invocationId: string;
  prompt: PlayPrompt;
  provider: ProviderRuntimeProfile;
  audit: { record(runId: string, operation: AgentWorkerAuditOperation, signal?: AbortSignal): Promise<void> };
  signal: AbortSignal;
}) {
  return {
    started: async ({ handoff }: { handoff: string }) => {
      await input.audit.record(input.runId, {
        type: "invocation.started",
        invocationId: input.invocationId,
        parentInvocationId: null,
        role: "gm",
        prompt: { id: input.prompt.id, version: input.prompt.version, sha256: input.prompt.sha256 },
        profile: getAgentRuntimeProfile("gm"),
        provider: {
          providerId: input.provider.providerId,
          requestedModelId: input.provider.modelId,
          providerConfigSha256: providerConfigSha256(input.provider),
        },
        handoff: null,
        inputSha256: canonicalAuditHash(handoff),
      }, input.signal);
    },
    completed: async (event: { output: unknown; adapterResult: Awaited<ReturnType<RuntimeAdapter["run"]>>; submissionCount: number }) => {
      await input.audit.record(input.runId, {
        type: "invocation.terminal",
        invocationId: input.invocationId,
        eventType: "completed",
        errorCode: null,
        receipt: projectReceipt(event.adapterResult),
        structuredSubmissionCount: event.submissionCount,
        outputSha256: canonicalAuditHash(event.output),
      });
    },
    failed: async (event: { cause: unknown; submissionCount: number }) => {
      const code = publicCode(event.cause);
      await input.audit.record(input.runId, {
        type: "invocation.terminal",
        invocationId: input.invocationId,
        eventType: code === "AGENT_RUN_CANCELLED" ? "cancelled" : "failed",
        errorCode: code,
        receipt: emptyReceipt(),
        structuredSubmissionCount: event.submissionCount,
        outputSha256: null,
      });
    },
  };
}

function projectReceipt(result: Awaited<ReturnType<RuntimeAdapter["run"]>>) {
  const receipt = result.receipt;
  return receipt ? {
    ...receipt,
    stopReason: result.stopReason,
    estimatedInputTokens: receipt.estimatedInputTokens ?? null,
    availableInputBudget: receipt.availableInputBudget ?? null,
    systemPromptTokens: receipt.systemPromptTokens ?? null,
    toolProtocolTokens: receipt.toolProtocolTokens ?? null,
    sessionHistoryTokens: receipt.sessionHistoryTokens ?? null,
    retrievalTokens: receipt.retrievalTokens ?? null,
    collaborationTokens: receipt.collaborationTokens ?? null,
    runtimeConversationTokens: receipt.runtimeConversationTokens ?? null,
    correctionAttempts: receipt.correctionAttempts ?? 0,
  } : emptyReceipt(result.stopReason);
}

function emptyReceipt(stopReason: string | null = null) {
  return {
    actualProviderId: null, actualModelId: null, responseIdSha256: null, stopReason,
    inputTokens: null, outputTokens: null, totalTokens: null, contextPolicyVersion: null,
    maxChargedInputBytes: null, configuredContextWindow: null, safetyReserve: null, outputReserve: null,
    estimatedInputTokens: null, availableInputBudget: null, systemPromptTokens: null,
    toolProtocolTokens: null, sessionHistoryTokens: null, retrievalTokens: null,
    collaborationTokens: null, runtimeConversationTokens: null, correctionAttempts: 0,
  };
}

function providerConfigSha256(profile: ProviderRuntimeProfile): string {
  const { apiKey: _apiKey, ...safe } = profile;
  return canonicalAuditHash(safe);
}

function publicCode(cause: unknown): string {
  return cause && typeof cause === "object" && "code" in cause ? String(cause.code).slice(0, 120) : "PLAYER_RUN_FAILED";
}

function publicMessage(code: string): string {
  const messages: Record<string, string> = {
    PLAY_PROMPT_NOT_PUBLISHED: "玩家模式提示词尚未通过真实模型评测。",
    PROMPT_SET_NOT_PUBLISHED: "写手或校验器提示词尚未通过发布验证。",
    GM_RESOLUTION_BLOCKED: "现有资料不足或互相冲突，本回合没有写入存档。",
    TURN_VALIDATION_REJECTED: "正文与 GM 裁决冲突，本回合没有写入存档。",
    TURN_VALIDATION_REVIEW_REQUIRED: "本回合需要人工检查，尚未写入存档。",
    AGENT_AUDIT_REQUIRED: "玩家运行审计不可用，本回合已阻止。",
    AGENT_RUN_CANCELLED: "玩家回合已取消。",
    PLAYER_EVIDENCE_HASH_MISMATCH: "玩家回合证据校验失败，存档未发生变化。",
  };
  return messages[code] ?? "玩家回合运行失败，存档未发生变化。";
}

function emitFailure(runId: string, code: string, message: string, emit: (event: PlayerWorkerEvent) => void): void {
  emit(playerWorkerEventSchema.parse({ type: "play.failed", runId, error: { code, message } }));
}

function playerError(code: string): Error & { code: string } {
  return Object.assign(new Error("Player Worker contract failed."), { code });
}
