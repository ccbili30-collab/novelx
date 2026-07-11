import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RuntimeAdapter } from "../../src/agent-worker/pi/runtimeAdapterContract";
import { loadGmPrompt } from "../../src/agent-worker/play/playPromptRegistry";
import { runPlayerTurnPipeline } from "../../src/agent-worker/play/playerTurnPipeline";
import type { ProviderRuntimeProfile } from "../../src/shared/providerContract";

const provider: ProviderRuntimeProfile = {
  providerId: "test", displayName: "Test", baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "model",
  contextWindow: 128_000, maxTokens: null, reasoning: false, input: ["text"],
};

describe("runPlayerTurnPipeline", () => {
  it("runs GM then Writer then Checker and returns only a validated immutable turn", async () => {
    const calls: string[] = [];
    const adapter: RuntimeAdapter = { run: async (input) => {
      calls.push("gm");
      await input.tools[0]!.execute("gm", {
        status: "resolved", resolutionId: "resolution-1", evidenceIds: ["evidence-1"], outcome: "进入洞穴",
        consequences: [{ category: "state_change", description: "位置变为洞穴", targetId: null, numericDelta: null }],
        stateDelta: { location: "洞穴" }, narrativeFacts: ["玩家进入洞穴"],
      }, input.signal);
      return { text: "", stopReason: "stop" };
    } };
    const tools: AgentTool[] = [
      tool("writer", async (params) => {
        calls.push("writer");
        const value = params as { gmResolutionId: string; evidenceIds: string[] };
        return { status: "candidate", candidateText: "你踏入洞穴。", evidenceIds: value.evidenceIds, gmResolutionId: value.gmResolutionId, authorityChanges: [] };
      }),
      tool("checker", async () => { calls.push("checker"); return { status: "passed", findings: [] }; }),
    ];
    const prompt = { ...loadGmPrompt(), status: "active" as const, publicationEvidence: {
      reportPath: "evidence.json", reportSha256: "b".repeat(64), providerId: "test", modelId: "model", evaluatedAt: new Date().toISOString(),
    } };

    const result = await runPlayerTurnPipeline({
      turn: { playerAction: "进入洞穴", canonicalEvidence: "洞穴在退潮时开放。", evidenceIds: ["evidence-1"], currentState: { location: "海岸" }, recentMemory: "抵达海岸", luck: 0.5 },
      styleConstraints: ["第二人称"], providerProfile: provider, gmPrompt: prompt, createAdapter: () => adapter, specialistTools: tools, signal: new AbortController().signal,
    });

    expect(calls).toEqual(["gm", "writer", "checker"]);
    expect(result).toMatchObject({ writerText: "你踏入洞穴。", stateSnapshot: { location: "洞穴" }, gmResolution: { resolutionId: "resolution-1" } });
  });

  it("does not persist or accept a turn when Checker reports Writer authority expansion", async () => {
    const adapter: RuntimeAdapter = { run: async (input) => {
      await input.tools[0]!.execute("gm", { status: "resolved", resolutionId: "resolution-1", evidenceIds: ["evidence-1"], outcome: "进入洞穴", consequences: [], stateDelta: {}, narrativeFacts: ["进入洞穴"] }, input.signal);
      return { text: "", stopReason: "stop" };
    } };
    const tools = [
      tool("writer", async () => ({ status: "candidate", candidateText: "你进入洞穴并获得王冠。", evidenceIds: ["evidence-1"], gmResolutionId: "resolution-1", authorityChanges: [] })),
      tool("checker", async () => ({ status: "findings", findings: [{ severity: "major", category: "writer_authority", evidence: [{ sourceId: "evidence-1", claim: "GM 未裁决王冠" }], location: "正文", scope: "本回合", reason: "新增奖励" }] })),
    ];
    const prompt = { ...loadGmPrompt(), status: "active" as const, publicationEvidence: { reportPath: "evidence.json", reportSha256: "b".repeat(64), providerId: "test", modelId: "model", evaluatedAt: new Date().toISOString() } };
    await expect(runPlayerTurnPipeline({
      turn: { playerAction: "进入洞穴", canonicalEvidence: "洞穴开放。", evidenceIds: ["evidence-1"], currentState: {}, recentMemory: "", luck: 0 },
      styleConstraints: [], providerProfile: provider, gmPrompt: prompt, createAdapter: () => adapter, specialistTools: tools, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "TURN_VALIDATION_REJECTED" });
  });
});

function tool(name: string, executeResult: (params: unknown) => Promise<unknown>): AgentTool {
  return {
    name, label: name, description: name, parameters: { type: "object" },
    execute: async (_id, params) => {
      const details = await executeResult(params);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };
}
