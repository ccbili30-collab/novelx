import {
  createModels,
  createProvider,
  type AssistantMessage,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  Agent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import { projectPiEvent, type SafePiEvent } from "./eventProjection";
import { modelProfileSchema, type ModelProfile } from "./modelProfile";
import {
  assertContextAdmission,
  CONTEXT_ADMISSION_POLICY_VERSION,
  type ContextAdmissionDecision,
} from "./contextAdmissionPolicy";
import {
  createStructuredSubmissionCorrection,
  STRUCTURED_SUBMISSION_CORRECTION,
} from "../../shared/agentRuntimeProfiles";
import type { AgentCollaborationContext, AgentSessionHistory } from "../../shared/agentWorkerProtocol";

interface AdapterDependencies {
  model: Model<string>;
  streamFn: StreamFn;
  configuredMaxTokens?: number | null;
}

interface PiRunInput {
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
  };
}

export interface PiRunResult {
  text: string;
  stopReason: "stop";
  receipt: {
    actualProviderId: string | null;
    actualModelId: string | null;
    responseIdSha256: string | null;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextPolicyVersion: string;
    maxChargedInputBytes: number;
    configuredContextWindow: number;
    safetyReserve: number;
      outputReserve: number;
      estimatedInputTokens: number;
      availableInputBudget: number;
      systemPromptTokens: number;
      toolProtocolTokens: number;
      sessionHistoryTokens: number;
      retrievalTokens: number;
      collaborationTokens: number;
      runtimeConversationTokens: number;
      correctionAttempts: number;
  };
}

export class NovaxPiRuntimeAdapter {
  readonly #model: Model<string>;
  readonly #streamFn: StreamFn;
  readonly #configuredMaxTokens: number | null;

  constructor(dependencies: AdapterDependencies) {
    this.#model = dependencies.model;
    this.#streamFn = dependencies.streamFn;
    this.#configuredMaxTokens = dependencies.configuredMaxTokens ?? dependencies.model.maxTokens;
  }

  async run(input: PiRunInput): Promise<PiRunResult> {
    if (input.signal?.aborted) throw piRuntimeError("AGENT_RUN_CANCELLED", "任务已取消。");
    let finalMessage: AssistantMessage | undefined;
    let admissionFailure: unknown;
    const admissionDecisions: ContextAdmissionDecision[] = [];
    let requestNumber = 0;
    let correctionAttempts = 0;
    const collaborationMessages = createCollaborationMessages(input.collaborationContext);
    const historyMessages = createHistoryMessages(input.sessionHistory, this.#model);
    const guardedStreamFn: StreamFn = (model, context, options) => {
      requestNumber += 1;
      try {
        admissionDecisions.push(assertContextAdmission({
          context,
          contextWindow: model.contextWindow,
          maxTokens: this.#configuredMaxTokens,
          requestNumber,
          classification: {
            collaborationMessageCount: collaborationMessages.length,
            sessionHistoryMessageCount: historyMessages.length,
          },
        }));
      } catch (error) {
        admissionFailure = error;
        throw error;
      }
      const decision = admissionDecisions.at(-1)!;
      return this.#streamFn({ ...model, maxTokens: decision.outputReserve }, context, {
        ...options,
        maxTokens: decision.outputReserve,
        onPayload: input.completionGuard?.forceTool && !input.completionGuard.isSatisfied()
          ? (payload) => forceOpenAiToolChoice(payload, input.completionGuard!.toolName)
          : options?.onPayload,
      });
    };
    const agent = new Agent({
      initialState: {
        systemPrompt: input.systemPrompt,
        model: this.#model,
        tools: input.tools,
        thinkingLevel: "off",
        messages: [
          ...collaborationMessages,
          ...historyMessages,
        ],
      },
      streamFn: guardedStreamFn,
      toolExecution: "sequential",
    });

    agent.subscribe((event) => {
      const projected = projectPiEvent(event);
      if (projected) input.onEvent?.(projected);
      if (event.type === "agent_end") {
        finalMessage = [...event.messages]
          .reverse()
          .find((message): message is AssistantMessage => message.role === "assistant");
      }
    });

    const abort = (): void => agent.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      let promptError: unknown = null;
      try {
        await agent.prompt(input.userInput);
      } catch (error) {
        if (admissionFailure) throw admissionFailure;
        if (input.signal?.aborted) throw piRuntimeError("AGENT_RUN_CANCELLED", "任务已取消。");
        if (!input.completionGuard) throw error;
        promptError = error;
      }
      while (
        input.completionGuard
        && !input.completionGuard.isSatisfied()
        && correctionAttempts < STRUCTURED_SUBMISSION_CORRECTION.maxAttempts
      ) {
        correctionAttempts += 1;
        try {
          await agent.prompt(
            input.completionGuard.createCorrection?.()
              ?? createStructuredSubmissionCorrection(input.completionGuard.toolName),
          );
          promptError = null;
        } catch (error) {
          if (admissionFailure) throw admissionFailure;
          if (input.signal?.aborted) throw piRuntimeError("AGENT_RUN_CANCELLED", "任务已取消。");
          promptError = error;
        }
      }
      if (input.completionGuard && !input.completionGuard.isSatisfied() && promptError) throw promptError;
    } catch (error) {
      if (admissionFailure) throw admissionFailure;
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }

    if (admissionFailure) throw admissionFailure;
    if (!finalMessage) throw piRuntimeError("PROVIDER_PROTOCOL_FAILED", "模型服务没有返回最终消息。");
    if (finalMessage.stopReason === "error") throw piRuntimeError("PROVIDER_RUNTIME_FAILED", "模型服务运行失败。");
    if (finalMessage.stopReason === "aborted") throw piRuntimeError("AGENT_RUN_CANCELLED", "任务已取消。");
    if (finalMessage.stopReason === "length") throw piRuntimeError("PROVIDER_OUTPUT_INCOMPLETE", "模型输出被截断。");
    if (finalMessage.stopReason === "toolUse" && !input.completionGuard?.isSatisfied()) {
      throw piRuntimeError("PROVIDER_PROTOCOL_FAILED", "模型工具流程没有正常结束。");
    }

    const maximumAdmission = admissionDecisions.reduce((maximum, decision) =>
      decision.estimatedInputTokens > maximum.estimatedInputTokens ? decision : maximum);
    return {
      text: finalMessage.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(""),
      stopReason: "stop",
      receipt: {
        actualProviderId: finalMessage.provider,
        actualModelId: finalMessage.responseModel ?? null,
        responseIdSha256: finalMessage.responseId ? sha256(finalMessage.responseId) : null,
        inputTokens: finalMessage.usage.input,
        outputTokens: finalMessage.usage.output,
        totalTokens: finalMessage.usage.totalTokens,
        contextPolicyVersion: CONTEXT_ADMISSION_POLICY_VERSION,
        maxChargedInputBytes: maximumAdmission.chargedInputBytes,
        configuredContextWindow: maximumAdmission.configuredContextWindow,
        safetyReserve: maximumAdmission.safetyReserve,
        outputReserve: maximumAdmission.outputReserve,
        estimatedInputTokens: maximumAdmission.estimatedInputTokens,
        availableInputBudget: maximumAdmission.availableInputBudget,
        systemPromptTokens: maximumAdmission.systemPromptTokens,
        toolProtocolTokens: maximumAdmission.toolProtocolTokens,
        sessionHistoryTokens: maximumAdmission.sessionHistoryTokens,
        retrievalTokens: maximumAdmission.retrievalTokens,
        collaborationTokens: maximumAdmission.collaborationTokens,
        runtimeConversationTokens: maximumAdmission.runtimeConversationTokens,
        correctionAttempts,
      },
    };
  }
}

function createCollaborationMessages(context: AgentCollaborationContext | undefined): Message[] {
  if (!context) return [];
  const messages: Message[] = [];
  for (const memory of context.sharedMemories) {
    messages.push({
      role: "user",
      content: `【共享记忆摘要】${memory.title}\n${memory.content}\n适用资源：${memory.scopeResourceIds.join("、") || "项目级"}\n基准检查点：${memory.checkpointId}\n此摘要用于定位资料，不替代正式检索。`,
      timestamp: Date.parse(memory.createdAt),
    });
  }
  for (const handoff of context.handoffs) {
    messages.push({
      role: "user",
      content: `【结构化任务交接｜${handoff.status === "pending" ? "待接受" : "已接受"}】来自 ${handoff.senderSessionTitle}：${handoff.title}\n${handoff.instructions}\n授权范围：${handoff.scopeResourceIds.join("、")}\n基准检查点：${handoff.checkpointId}\n执行前必须检索当前分支正式资料；若检查点已过期，按最新事实重新核验。`,
      timestamp: Date.parse(handoff.createdAt),
    });
  }
  return messages;
}

function createHistoryMessages(history: AgentSessionHistory | undefined, model: Model<string>): Message[] {
  if (!history || history.entries.length === 0) return [];
  const messages: Message[] = history.entries.map((entry) => {
    const timestamp = Date.parse(entry.createdAt);
    if (entry.role === "user") return { role: "user", content: entry.text, timestamp };
    return {
      role: "assistant",
      content: [{ type: "text", text: entry.text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    };
  });
  if (history.completeness.incomplete) {
    messages.unshift({
      role: "user",
      content: `【会话记录不完整】更早的 ${history.completeness.omittedMessages} 条消息未载入。以下记录只用于理解当前对话，不是项目正式事实；涉及设定、状态或正文时必须检索正式资料。`,
      timestamp: messages[0]?.timestamp ?? Date.now(),
    });
  }
  return messages;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function forceOpenAiToolChoice(payload: unknown, toolName: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return {
    ...(payload as Record<string, unknown>),
    tool_choice: { type: "function", function: { name: toolName } },
  };
}

export function createOpenAiCompatiblePiAdapter(profileInput: unknown): NovaxPiRuntimeAdapter {
  const profile = modelProfileSchema.parse(profileInput);
  const model = createModel(profile);
  const provider = createProvider({
    id: profile.providerId,
    name: profile.displayName,
    baseUrl: profile.baseUrl,
    auth: {
      apiKey: {
        name: `${profile.displayName} API key`,
        resolve: async () => ({
          auth: { apiKey: profile.apiKey, baseUrl: profile.baseUrl },
          source: "Novax provider profile",
        }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const streamFn: StreamFn = (selectedModel, context, options) => models.streamSimple(selectedModel, context, {
    ...options,
    apiKey: profile.apiKey,
  });
  return new NovaxPiRuntimeAdapter({ model, streamFn, configuredMaxTokens: profile.maxTokens });
}

function createModel(profile: ModelProfile): Model<"openai-completions"> {
  return {
    id: profile.modelId,
    name: profile.modelId,
    api: "openai-completions",
    provider: profile.providerId,
    baseUrl: profile.baseUrl,
    reasoning: profile.reasoning,
    input: profile.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: profile.contextWindow,
    // Pi requires a numeric model capability. Auto mode replaces this ceiling per request.
    maxTokens: profile.maxTokens ?? Math.min(32_768, profile.contextWindow),
  };
}

function piRuntimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
