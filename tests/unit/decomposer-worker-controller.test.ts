import { expect, it, vi } from "vitest";
import { handleDecomposerWorkerCommand } from "../../src/agent-worker/import/decomposerWorkerController";
import { loadDecomposerPrompt } from "../../src/agent-worker/import/decomposerPromptRegistry";
import type { DecomposerWorkerEvent, DecomposerWorkerStart } from "../../src/shared/decomposerWorkerProtocol";

const command: DecomposerWorkerStart = {
  type: "decompose.start", runId: "run-1", sourceId: "source-1",
  chunks: [{ id: "chunk-1", locator: { kind: "lines", start: 1, end: 1 }, content: "source", contentSha256: "a".repeat(64) }],
  providerProfile: { providerId: "test", displayName: "Test", baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "model", contextWindow: 128_000, maxTokens: null, reasoning: false, input: ["text"] },
};

it("fails closed before Provider access when the Decomposer Prompt is unpublished", async () => {
  const events: DecomposerWorkerEvent[] = []; const createAdapter = vi.fn();
  await handleDecomposerWorkerCommand({ command: structuredClone(command), signal: new AbortController().signal, emit: (event) => events.push(event) },
    { loadPrompt: () => ({ ...loadDecomposerPrompt(), status: "candidate", publicationEvidence: null }), createAdapter });
  expect(createAdapter).not.toHaveBeenCalled();
  expect(events).toEqual([
    { type: "decompose.started", runId: "run-1" },
    { type: "decompose.failed", runId: "run-1", error: { code: "DECOMPOSER_PROMPT_NOT_PUBLISHED", message: "拆解运行失败，未写入候选。" } },
  ]);
});
