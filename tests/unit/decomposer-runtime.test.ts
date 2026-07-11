import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDecomposerPrompt } from "../../src/agent-worker/import/decomposerPromptRegistry";
import { runDecomposer } from "../../src/agent-worker/import/decomposerRuntime";
import type { RuntimeAdapter } from "../../src/agent-worker/pi/runtimeAdapterContract";
import { DecompositionService } from "../../src/domain/import/decompositionService";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { TextSourceParserService } from "../../src/domain/import/textSourceParserService";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import type { ProviderRuntimeProfile } from "../../src/shared/providerContract";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });

const provider: ProviderRuntimeProfile = { providerId: "test", displayName: "Test", baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "model", contextWindow: 128_000, maxTokens: null, reasoning: false, input: ["text"] };

describe("Decomposer runtime", () => {
  it("fails closed before Provider access while the Prompt is unpublished", async () => {
    const createAdapter = vi.fn();
    await expect(runDecomposer({ chunks: [chunk()], providerProfile: provider, prompt: loadDecomposerPrompt(), createAdapter, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "DECOMPOSER_PROMPT_NOT_PUBLISHED" });
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it("accepts one structured, source-bound submission", async () => {
    const adapter: RuntimeAdapter = { run: async (input) => {
      await input.tools[0]!.execute("submit", { candidates: [{ kind: "location", sourceChunkIds: ["chunk-1"], confidence: 0.9, payload: { name: "潮汐洞穴", description: "退潮时开放。" } }], unresolvedSourceChunkIds: [] }, input.signal);
      return { text: "", stopReason: "stop" };
    } };
    const result = await runDecomposer({ chunks: [chunk()], providerProfile: provider, prompt: activePrompt(), createAdapter: () => adapter, signal: new AbortController().signal });
    expect(result.candidates[0]).toMatchObject({ kind: "location", sourceChunkIds: ["chunk-1"] });
  });

  it("marks the import job failed and writes no candidate when the Provider violates source binding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-decomposer-")); roots.push(root);
    const filePath = path.join(root, "source.txt"); fs.writeFileSync(filePath, "潮汐洞穴只在退潮时开放。", "utf8");
    const workspace = openWorkspace(root);
    const source = new SourceLibraryRepository(workspace).register({ filePath, rightsAttestation: "user_owned" });
    new TextSourceParserService(workspace).parse(source.id);
    const adapter: RuntimeAdapter = { run: async (input) => {
      await input.tools[0]!.execute("submit", { candidates: [{ kind: "location", sourceChunkIds: ["invented"], confidence: 1, payload: { name: "虚构地点", description: "无来源。" } }], unresolvedSourceChunkIds: [] }, input.signal);
      return { text: "", stopReason: "stop" };
    } };
    await expect(new DecompositionService(workspace).decompose({ sourceId: source.id, providerProfile: provider, prompt: activePrompt(), createAdapter: () => adapter, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "DECOMPOSER_SOURCE_MISMATCH" });
    expect(workspace.db.prepare("SELECT status, error_code FROM import_jobs WHERE kind = 'decompose'").get()).toEqual({ status: "failed", error_code: "DECOMPOSER_SOURCE_MISMATCH" });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM decomposition_candidates").get()).toEqual({ count: 0 });
    workspace.close();
  });
});

function chunk() { return { id: "chunk-1", locator: { kind: "lines", start: 1, end: 1 }, content: "潮汐洞穴只在退潮时开放。", contentSha256: "a".repeat(64) }; }
function activePrompt() { return { ...loadDecomposerPrompt(), status: "active" as const, publicationEvidence: { reportPath: "evidence.json", reportSha256: "b".repeat(64), providerId: "test", modelId: "model", evaluatedAt: new Date().toISOString() } }; }
