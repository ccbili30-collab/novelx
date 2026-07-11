import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handlePlayerWorkerCommand, type PlayerWorkerDependencies } from "../../src/agent-worker/play/playerWorkerController";
import { loadGmPrompt } from "../../src/agent-worker/play/playPromptRegistry";
import type { PublishedPrompt } from "../../src/agent-worker/promptRegistry";
import type { PlayerWorkerTurnStartCommand } from "../../src/shared/playerWorkerProtocol";

describe("Player Worker controller", () => {
  it("fails closed on the unpublished GM Prompt before Provider access", async () => {
    const emit = vi.fn(); const providerRun = vi.fn();
    await handlePlayerWorkerCommand({ command: command(), signal: new AbortController().signal, audit: { record: async () => undefined }, emit }, {
      loadGmPrompt,
      loadSpecialistPrompts: () => prompts(),
      createAdapter: () => ({ run: providerRun }),
    });
    expect(providerRun).not.toHaveBeenCalled();
    expect(emit).toHaveBeenLastCalledWith({ type: "play.failed", runId: "player-run-1", error: { code: "PLAY_PROMPT_NOT_PUBLISHED", message: "玩家模式提示词尚未通过真实模型评测。" } });
  });

  it("runs audited GM, Writer, and Checker in order before emitting validated prose", async () => {
    const events: unknown[] = []; const audits: Array<{ type: string; role?: string; eventType?: string }> = [];
    const dependencies: PlayerWorkerDependencies = {
      loadGmPrompt: activeGmPrompt,
      loadSpecialistPrompts: () => prompts(),
      createAdapter: () => ({ run: async (input) => {
        if (input.systemPrompt === "GM") {
          await input.tools[0]!.execute("gm", { status: "resolved", resolutionId: "resolution-1", evidenceIds: ["evidence-1"], outcome: "进入洞穴", consequences: [{ category: "success", description: "进入洞穴", targetId: null, numericDelta: null }], stateDelta: { location: "洞穴" }, narrativeFacts: ["玩家进入洞穴"] }, input.signal);
        } else if (input.systemPrompt === "Writer") {
          await input.tools[0]!.execute("writer", { status: "candidate", candidateText: "你踏过潮湿的礁石，进入洞穴。", evidenceIds: ["evidence-1"], gmResolutionId: "resolution-1", authorityChanges: [] }, input.signal);
        } else if (input.systemPrompt === "Checker") {
          await input.tools[0]!.execute("checker", { status: "passed", findings: [] }, input.signal);
        } else throw new Error("Unexpected Prompt");
        return { text: "raw text must not escape", stopReason: "stop" as const, receipt: receipt() };
      } }),
    };
    await handlePlayerWorkerCommand({
      command: command(), signal: new AbortController().signal,
      audit: { record: async (_runId, operation) => { audits.push(operation); } },
      emit: (event) => events.push(event),
    }, dependencies);

    expect(audits.filter((item) => item.type === "invocation.started").map((item) => item.role)).toEqual(["gm", "writer", "checker"]);
    expect(audits.filter((item) => item.type === "invocation.terminal").map((item) => item.eventType)).toEqual(["completed", "completed", "completed"]);
    expect(events.at(-1)).toMatchObject({ type: "play.completed", result: { writerText: "你踏过潮湿的礁石，进入洞穴。", stateSnapshot: { location: "洞穴" } } });
    expect(JSON.stringify(events)).not.toContain("raw text must not escape");
  });

  it("rejects changed evidence before any audit or Provider call", async () => {
    const emit = vi.fn(); const providerRun = vi.fn(); const record = vi.fn();
    const changed = command(); changed.evidence[0]!.content = "被替换的内容";
    await handlePlayerWorkerCommand({ command: changed, signal: new AbortController().signal, audit: { record }, emit }, {
      loadGmPrompt: activeGmPrompt,
      loadSpecialistPrompts: () => prompts(),
      createAdapter: () => ({ run: providerRun }),
    });
    expect(record).not.toHaveBeenCalled(); expect(providerRun).not.toHaveBeenCalled();
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: "play.failed", error: { code: "PLAYER_EVIDENCE_HASH_MISMATCH", message: "玩家回合证据校验失败，存档未发生变化。" } }));
  });
});

function command(): PlayerWorkerTurnStartCommand {
  const content = "洞穴入口只在退潮时开放。";
  return { type: "play.start", runId: "player-run-1", playthroughId: "playthrough-1", playerAction: "进入洞穴", evidence: [{ id: "evidence-1", content, sha256: createHash("sha256").update(content, "utf8").digest("hex") }], currentState: { location: "海岸" }, recentMemory: "玩家抵达海岸。", luck: 0.5, styleConstraints: ["克制"], providerProfile: { providerId: "test", displayName: "Test", baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "model", contextWindow: 128_000, maxTokens: null, reasoning: false, input: ["text"] } };
}

function activeGmPrompt() { return { ...loadGmPrompt(), content: "GM", status: "active" as const, publicationEvidence: { reportPath: "evidence.json", reportSha256: "b".repeat(64), providerId: "test", modelId: "model", evaluatedAt: new Date().toISOString() } }; }
function prompts(): PublishedPrompt[] { return [
  { id: "novax.steward", role: "steward", version: "1.0.0", status: "active", rollbackTo: null, sha256: "a".repeat(64), content: "Steward" },
  { id: "novax.writer", role: "writer", version: "1.0.0", status: "active", rollbackTo: null, sha256: "b".repeat(64), content: "Writer" },
  { id: "novax.checker", role: "checker", version: "1.0.0", status: "active", rollbackTo: null, sha256: "c".repeat(64), content: "Checker" },
]; }
function receipt() { return { actualProviderId: "test", actualModelId: "model", responseIdSha256: "d".repeat(64), inputTokens: 10, outputTokens: 5, totalTokens: 15, contextPolicyVersion: "v1", maxChargedInputBytes: 100, configuredContextWindow: 128_000, safetyReserve: 2_000, outputReserve: 4_000 }; }
