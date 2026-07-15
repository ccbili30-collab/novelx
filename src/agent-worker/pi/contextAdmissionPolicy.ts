import type { Context } from "@earendil-works/pi-ai";
import { canonicalJson } from "../../domain/audit/canonicalAuditHash";
import {
  CONTEXT_ADMISSION_POLICY_VERSION,
  TOKEN_ESTIMATOR_VERSION,
} from "../../shared/contextAdmissionContract";
import { providerProtocolError } from "./providerProtocolStage";

export { CONTEXT_ADMISSION_POLICY_VERSION } from "../../shared/contextAdmissionContract";
export const MAX_PROVIDER_REQUESTS_PER_INVOCATION = 128;

export interface ContextAdmissionDecision {
  policyVersion: typeof CONTEXT_ADMISSION_POLICY_VERSION;
  requestNumber: number;
  chargedInputBytes: number;
  estimatedInputTokens: number;
  tokenEstimatorVersion: typeof TOKEN_ESTIMATOR_VERSION;
  configuredContextWindow: number;
  safetyReserve: number;
  outputReserve: number;
  availableInputBudget: number;
  systemPromptTokens: number;
  toolProtocolTokens: number;
  sessionHistoryTokens: number;
  retrievalTokens: number;
  collaborationTokens: number;
  runtimeConversationTokens: number;
  accepted: boolean;
}

export interface ContextAdmissionClassification {
  collaborationMessageCount: number;
  sessionHistoryMessageCount: number;
}

export function evaluateContextAdmission(input: {
  context: Context;
  contextWindow: number;
  maxTokens: number | null;
  requestNumber: number;
  classification?: ContextAdmissionClassification;
}): ContextAdmissionDecision {
  if (input.requestNumber > MAX_PROVIDER_REQUESTS_PER_INVOCATION) {
    throw providerProtocolError("PROVIDER_PROTOCOL_REQUEST_LIMIT_EXCEEDED");
  }
  const safetyReserve = Math.max(4_096, Math.ceil(input.contextWindow * 0.1));
  const serializedContext = canonicalJson(input.context);
  const chargedInputBytes = Buffer.byteLength(serializedContext, "utf8");
  const estimatedInputTokens = estimateTextTokens(serializedContext);
  const breakdown = estimateContextBreakdown(input.context, input.classification);
  const outputReserve = resolveOutputReserve({
    contextWindow: input.contextWindow,
    estimatedInputTokens,
    configuredMaxTokens: input.maxTokens,
    safetyReserve,
  });
  const availableInputBudget = input.contextWindow - safetyReserve - outputReserve;
  return {
    policyVersion: CONTEXT_ADMISSION_POLICY_VERSION,
    requestNumber: input.requestNumber,
    chargedInputBytes,
    estimatedInputTokens,
    tokenEstimatorVersion: TOKEN_ESTIMATOR_VERSION,
    configuredContextWindow: input.contextWindow,
    safetyReserve,
    outputReserve,
    availableInputBudget,
    ...breakdown,
    accepted: availableInputBudget >= 0 && estimatedInputTokens <= availableInputBudget,
  };
}

export function estimateContextBreakdown(
  context: Context,
  classification: ContextAdmissionClassification = { collaborationMessageCount: 0, sessionHistoryMessageCount: 0 },
): Pick<ContextAdmissionDecision,
  | "systemPromptTokens"
  | "toolProtocolTokens"
  | "sessionHistoryTokens"
  | "retrievalTokens"
  | "collaborationTokens"
  | "runtimeConversationTokens"
> {
  const collaborationEnd = clampMessageIndex(classification.collaborationMessageCount, context.messages.length);
  const historyEnd = clampMessageIndex(
    collaborationEnd + classification.sessionHistoryMessageCount,
    context.messages.length,
  );
  const collaborationMessages = context.messages.slice(0, collaborationEnd);
  const historyMessages = context.messages.slice(collaborationEnd, historyEnd);
  const remainingMessages = context.messages.slice(historyEnd);
  const retrievalMessages = remainingMessages.filter((message) => (
    message.role === "toolResult" && message.toolName === "retrieve_graph_evidence"
  ));
  const runtimeMessages = remainingMessages.filter((message) => !(
    message.role === "toolResult" && message.toolName === "retrieve_graph_evidence"
  ));
  return {
    systemPromptTokens: estimateValueTokens(context.systemPrompt ?? ""),
    toolProtocolTokens: estimateValueTokens(context.tools ?? []),
    sessionHistoryTokens: estimateValueTokens(historyMessages),
    retrievalTokens: estimateValueTokens(retrievalMessages),
    collaborationTokens: estimateValueTokens(collaborationMessages),
    runtimeConversationTokens: estimateValueTokens(runtimeMessages),
  };
}

export function estimateTextTokens(value: string): number {
  let asciiCharacters = 0;
  let nonAsciiCodePoints = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) asciiCharacters += 1;
    else nonAsciiCodePoints += 1;
  }
  // Tokenizer-independent approximation: JSON/English is charged at four ASCII
  // characters per token, CJK/emoji at one token per code point, plus framing.
  return Math.ceil(asciiCharacters / 4) + nonAsciiCodePoints + 8;
}

function estimateValueTokens(value: unknown): number {
  return estimateTextTokens(canonicalJson(value));
}

function clampMessageIndex(value: number, messageCount: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) return 0;
  return Math.min(value, messageCount);
}

export function resolveOutputReserve(input: {
  contextWindow: number;
  estimatedInputTokens: number;
  configuredMaxTokens: number | null;
  safetyReserve: number;
}): number {
  if (input.configuredMaxTokens !== null) return input.configuredMaxTokens;
  const remaining = input.contextWindow - input.safetyReserve - input.estimatedInputTokens;
  if (remaining <= 0) return 0;
  return Math.min(32_768, Math.max(1_024, Math.floor(remaining * 0.25)), remaining);
}

export function assertContextAdmission(input: Parameters<typeof evaluateContextAdmission>[0]): ContextAdmissionDecision {
  const decision = evaluateContextAdmission(input);
  if (!decision.accepted) throw contextAdmissionError("AGENT_CONTEXT_BUDGET_EXCEEDED");
  return decision;
}

export function compactDurablyNotedFileChunks(context: Context): Context {
  const durableNotes = new Map<string, { noteId: string; source: Record<string, unknown> }>();
  const noteReceiptsByToolCallId = new Map<string, { noteId: string; source: Record<string, unknown> }>();
  const readReceiptsByToolCallId = new Map<string, { noteId: string; source: Record<string, unknown> }>();
  for (const message of context.messages) {
    if (message.role !== "toolResult" || message.toolName !== "save_task_note" || message.isError) continue;
    const payload = readToolPayload(message.content);
    const note = readResultObject(payload);
    const source = note && readObject(note.source);
    if (!note || !source || typeof note.id !== "string") continue;
    const key = sourceRangeKey(source);
    if (key) {
      const receipt = { noteId: note.id, source };
      durableNotes.set(key, receipt);
      noteReceiptsByToolCallId.set(message.toolCallId, receipt);
    }
  }
  if (durableNotes.size === 0) return context;
  for (const message of context.messages) {
    if (message.role !== "toolResult" || message.toolName !== "read_project_file" || message.isError) continue;
    const result = readResultObject(readToolPayload(message.content));
    const key = result && sourceRangeKey(result);
    const receipt = key ? durableNotes.get(key) : undefined;
    if (receipt) readReceiptsByToolCallId.set(message.toolCallId, receipt);
  }

  const messages: Context["messages"] = context.messages.map((message) => {
    if (message.role === "toolResult") {
      const receipt = message.toolName === "read_project_file"
        ? readReceiptsByToolCallId.get(message.toolCallId)
        : message.toolName === "save_task_note"
          ? noteReceiptsByToolCallId.get(message.toolCallId)
          : undefined;
      return receipt ? compactToolResult(message, receipt) : message;
    }
    if (message.role === "assistant") {
      let changed = false;
      const content = message.content.map((item) => {
        if (item.type !== "toolCall") return item;
        const receipt = noteReceiptsByToolCallId.get(item.id);
        if (!receipt) return item;
        changed = true;
        return {
          ...item,
          arguments: {
            title: "[stored task note]",
            content: "[content stored durably in workspace task note]",
            source: receipt.source,
          },
        };
      });
      return changed ? { ...message, content } : message;
    }
    return message;
  });
  return { ...context, messages };
}

function compactToolResult(
  message: Extract<Context["messages"][number], { role: "toolResult" }>,
  receipt: { noteId: string; source: Record<string, unknown> },
): Extract<Context["messages"][number], { role: "toolResult" }> {
  return {
    ...message,
    content: [{
      type: "text",
      text: JSON.stringify({
        result: {
          novaxState: "durable_file_receipt",
          noteId: receipt.noteId,
          source: receipt.source,
          contentStored: true,
        },
      }),
    }],
    details: {
      novaxState: "durable_file_receipt",
      noteId: receipt.noteId,
      source: receipt.source,
      contentStored: true,
    },
  };
}

function readToolPayload(content: unknown): unknown {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!item || typeof item !== "object" || !("type" in item) || item.type !== "text" || !("text" in item)) continue;
    try {
      return JSON.parse(String(item.text));
    } catch {
      continue;
    }
  }
  return null;
}

function readResultObject(payload: unknown): Record<string, unknown> | null {
  const object = readObject(payload);
  return object ? readObject(object.result) : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sourceRangeKey(value: Record<string, unknown>): string | null {
  const { path, sha256, startChar, endChar } = value;
  if (typeof path !== "string" || typeof sha256 !== "string"
    || !Number.isSafeInteger(startChar) || !Number.isSafeInteger(endChar)) return null;
  return `${path}\u0000${sha256}\u0000${startChar}\u0000${endChar}`;
}

function contextAdmissionError(code: "AGENT_CONTEXT_BUDGET_EXCEEDED" | "PROVIDER_PROTOCOL_FAILED"): Error & { code: string } {
  return Object.assign(new Error("Agent context admission failed."), { code });
}
