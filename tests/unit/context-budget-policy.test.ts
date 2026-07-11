import { describe, expect, it, vi } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import { NovaxPiRuntimeAdapter } from "../../src/agent-worker/pi/NovaxPiRuntimeAdapter";
import {
  assertContextAdmission,
  estimateContextBreakdown,
  estimateTextTokens,
  evaluateContextAdmission,
  resolveOutputReserve,
  compactDurablyNotedFileChunks,
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

  it("rejects impossible reserves and requests beyond the long-task ceiling", () => {
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
      requestNumber: 129,
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

  it("compacts only file chunks covered by a later durable task-note receipt", () => {
    const source = { path: "世界.md", sha256: "a".repeat(64), startChar: 0, endChar: 24_000 };
    const uncovered = { path: "人物.md", sha256: "b".repeat(64), startChar: 0, endChar: 24_000 };
    const context = {
      systemPrompt: "",
      tools: [],
      messages: [
        toolResult("read-1", "read_project_file", { result: { ...source, content: "甲".repeat(24_000) } }, 1),
        toolResult("note-1", "save_task_note", { result: { id: "note-1", title: "世界", content: "海岸设定", source } }, 2),
        toolResult("read-2", "read_project_file", { result: { ...uncovered, content: "乙".repeat(24_000) } }, 3),
      ],
    };

    const compacted = compactDurablyNotedFileChunks(context);
    const serialized = JSON.stringify(compacted);

    expect(serialized).not.toContain("甲".repeat(1_000));
    expect(serialized).toContain("乙".repeat(1_000));
    expect(serialized).toContain("durable_file_receipts");
    expect(serialized).toContain("note-1");
  });

  it("removes both sides of completed tool calls and replaces them with a durable receipt", () => {
    const source = { path: "世界.md", sha256: "a".repeat(64), startChar: 0, endChar: 4_000 };
    const context = {
      systemPrompt: "",
      tools: [],
      messages: [
        {
          role: "assistant" as const,
          content: [{
            type: "toolCall" as const,
            id: "note-call-1",
            name: "save_task_note",
            arguments: { title: "世界", content: "海岸设定", source },
          }],
          api: "openai-completions" as const,
          provider: "fixture",
          model: "fixture",
          usage: emptyUsage(),
          stopReason: "toolUse" as const,
          timestamp: 1,
        },
        toolResult("note-call-1", "save_task_note", {
          result: { id: "note-1", title: "世界", content: "海岸设定", source },
        }, 2),
      ],
    };

    const compacted = compactDurablyNotedFileChunks(context);
    expect(compacted.messages).toHaveLength(1);
    expect(compacted.messages[0]?.role).toBe("user");
    expect(JSON.stringify(compacted)).not.toContain("海岸设定");
    expect(JSON.stringify(compacted)).not.toContain("note-call-1");
    expect(JSON.stringify(compacted)).toContain("note-1");
    expect(JSON.stringify(compacted)).toContain("durable_file_receipts");
  });

  it("compacts note arguments by tool-call id when the model supplied stale source coordinates", () => {
    const actualSource = { path: "地理.md", sha256: "b".repeat(64), startChar: 4_000, endChar: 8_000 };
    const context = {
      systemPrompt: "",
      tools: [],
      messages: [
        {
          role: "assistant" as const,
          content: [{
            type: "toolCall" as const,
            id: "note-call-stale",
            name: "save_task_note",
            arguments: {
              title: "错误标题",
              content: "应从活动上下文移除的长笔记正文",
              source: { ...actualSource, path: "错误.md", startChar: 0, endChar: 1 },
            },
          }],
          api: "openai-completions" as const,
          provider: "fixture",
          model: "fixture",
          usage: emptyUsage(),
          stopReason: "toolUse" as const,
          timestamp: 1,
        },
        toolResult("note-call-stale", "save_task_note", {
          result: { id: "note-stale", title: "已校正", content: "正式笔记", source: actualSource },
        }, 2),
      ],
    };

    const compacted = compactDurablyNotedFileChunks(context);
    const serialized = JSON.stringify(compacted);

    expect(serialized).not.toContain("应从活动上下文移除的长笔记正文");
    expect(serialized).not.toContain("错误.md");
    expect(serialized).toContain("地理.md");
    expect(serialized).toContain("note-stale");
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

function toolResult(toolCallId: string, toolName: string, payload: unknown, timestamp: number) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: false,
    timestamp,
  };
}
