import { describe, expect, it, vi } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import { NovaxPiRuntimeAdapter } from "../../src/agent-worker/pi/NovaxPiRuntimeAdapter";
import {
  assertContextAdmission,
  estimateContextBreakdown,
  estimateTextTokens,
  evaluateContextAdmission,
  resolveOutputReserve,
} from "../../src/agent-worker/pi/contextAdmissionPolicy";

describe("token-estimated context admission policy", () => {
  it("keeps UTF-8 bytes as audit evidence but admits against estimated tokens", () => {
    const ascii = decisionFor("a".repeat(400));
    const chinese = decisionFor("银湾海岸".repeat(100));

    expect(ascii.chargedInputBytes).toBeGreaterThan(ascii.estimatedInputTokens);
    expect(chinese.estimatedInputTokens).toBeGreaterThan(ascii.estimatedInputTokens);
    expect(ascii.tokenEstimatorVersion).toBe("novax.unicode-mixed-v1@1.0.0");
    expect(estimateTextTokens("a".repeat(400))).toBe(108);
  });

  it("accepts a normal 12,800-token ping context that the byte policy overstated", () => {
    const decision = evaluateContextAdmission({
      context: contextWithText("ping"),
      contextWindow: 12_800,
      maxTokens: null,
      requestNumber: 1,
    });
    expect(decision.accepted).toBe(true);
    expect(decision.outputReserve).toBeGreaterThanOrEqual(1_024);
    expect(decision.availableInputBudget).toBeGreaterThan(decision.estimatedInputTokens);
  });

  it("computes Auto output reserve from remaining context and honors explicit limits", () => {
    expect(resolveOutputReserve({ contextWindow: 64_000, estimatedInputTokens: 8_000, configuredMaxTokens: null, safetyReserve: 6_400 })).toBe(12_400);
    expect(resolveOutputReserve({ contextWindow: 64_000, estimatedInputTokens: 8_000, configuredMaxTokens: 4_096, safetyReserve: 6_400 })).toBe(4_096);
  });

  it("audits system, tools, private history, retrieval, collaboration, and runtime messages separately", () => {
    const breakdown = estimateContextBreakdown({
      systemPrompt: "系统约束",
      tools: [{ name: "retrieve_graph_evidence", description: "检索", parameters: { type: "object" } as never }],
      messages: [
        { role: "user", content: "共享记忆", timestamp: 1 },
        { role: "user", content: "历史问题", timestamp: 2 },
        { role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: emptyUsage(), stopReason: "stop", timestamp: 3 },
        { role: "user", content: "当前问题", timestamp: 4 },
        { role: "toolResult", toolCallId: "tool-1", toolName: "retrieve_graph_evidence", content: [{ type: "text", text: "正式资料" }], isError: false, timestamp: 5 },
      ],
    }, { collaborationMessageCount: 1, sessionHistoryMessageCount: 2 });

    expect(breakdown.systemPromptTokens).toBeGreaterThan(0);
    expect(breakdown.toolProtocolTokens).toBeGreaterThan(0);
    expect(breakdown.collaborationTokens).toBeGreaterThan(0);
    expect(breakdown.sessionHistoryTokens).toBeGreaterThan(breakdown.collaborationTokens);
    expect(breakdown.retrievalTokens).toBeGreaterThan(0);
    expect(breakdown.runtimeConversationTokens).toBeGreaterThan(0);
  });

  it("rejects impossible reserves and a ninth Provider request", () => {
    expect(() => assertContextAdmission({
      context: contextWithText("x"),
      contextWindow: 4_096,
      maxTokens: 1_000,
      requestNumber: 1,
    })).toThrow(expect.objectContaining({ code: "AGENT_CONTEXT_BUDGET_EXCEEDED" }));
    expect(() => evaluateContextAdmission({
      context: contextWithText("x"),
      contextWindow: 64_000,
      maxTokens: 8_000,
      requestNumber: 9,
    })).toThrow(expect.objectContaining({ code: "PROVIDER_PROTOCOL_FAILED" }));
  });

  it("blocks before the stream function can make a network request", async () => {
    const faux = fauxProvider({ provider: "context-budget-fixture" });
    const streamFn = vi.fn();
    const adapter = new NovaxPiRuntimeAdapter({
      model: { ...faux.getModel(), contextWindow: 100, maxTokens: 50 },
      streamFn,
    });

    await expect(adapter.run({
      systemPrompt: "系统约束",
      userInput: "银湾海岸".repeat(100),
      tools: [],
    })).rejects.toMatchObject({ code: "AGENT_CONTEXT_BUDGET_EXCEEDED" });
    expect(streamFn).not.toHaveBeenCalled();
  });
});

function decisionFor(text: string) {
  return evaluateContextAdmission({
    context: contextWithText(text),
    contextWindow: 64_000,
    maxTokens: 8_000,
    requestNumber: 1,
  });
}

function contextWithText(text: string) {
  return {
    systemPrompt: "",
    messages: [{ role: "user" as const, content: text, timestamp: 0 }],
    tools: [],
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
