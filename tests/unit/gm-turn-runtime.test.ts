import { describe, expect, it, vi } from "vitest";
import { runGmTurn } from "../../src/agent-worker/play/gmTurnRuntime";
import { loadGmPrompt } from "../../src/agent-worker/play/playPromptRegistry";
import type { RuntimeAdapter } from "../../src/agent-worker/pi/runtimeAdapterContract";
import type { ProviderRuntimeProfile } from "../../src/shared/providerContract";

const provider: ProviderRuntimeProfile = {
  providerId: "test", displayName: "Test", baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "model",
  contextWindow: 128_000, maxTokens: null, reasoning: false, input: ["text"],
};

describe("runGmTurn", () => {
  it("blocks an unpublished GM prompt before calling the Provider", async () => {
    const createAdapter = vi.fn();
    await expect(runGmTurn({
      turn: turn(), providerProfile: provider, prompt: { ...loadGmPrompt(), status: "candidate", publicationEvidence: null }, createAdapter, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "PLAY_PROMPT_NOT_PUBLISHED" });
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it("accepts exactly one source-bound structured resolution from a real adapter boundary", async () => {
    const prompt = { ...loadGmPrompt(), status: "active" as const, sha256: "a".repeat(64), publicationEvidence: {
      reportPath: "evidence.json", reportSha256: "b".repeat(64), providerId: "test", modelId: "model", evaluatedAt: new Date().toISOString(),
    } };
    const adapter: RuntimeAdapter = {
      run: async (input) => {
        await input.tools[0]!.execute("gm-submit", {
          status: "resolved", resolutionId: "resolution-1", evidenceIds: ["evidence-1"], outcome: "玩家成功进入洞穴。",
          consequences: [{ category: "success", description: "进入洞穴", targetId: null, numericDelta: null }],
          stateDelta: { location: "洞穴" }, narrativeFacts: ["玩家进入洞穴"],
        }, input.signal);
        return { text: "", stopReason: "stop" };
      },
    };
    const result = await runGmTurn({ turn: turn(), providerProfile: provider, prompt, createAdapter: () => adapter, signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "resolved", resolutionId: "resolution-1", stateDelta: { location: "洞穴" } });
  });
});

function turn() {
  return { playerAction: "进入洞穴", canonicalEvidence: "洞穴入口在退潮时开放。", evidenceIds: ["evidence-1"], currentState: { location: "海岸" }, recentMemory: "玩家抵达海岸。", luck: 0.5 };
}
