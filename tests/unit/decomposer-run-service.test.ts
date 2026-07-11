import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadDecomposerPrompt } from "../../src/agent-worker/import/decomposerPromptRegistry";
import { DecomposerRunService } from "../../src/domain/import/decomposerRunService";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { TextSourceParserService } from "../../src/domain/import/textSourceParserService";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";

const roots: string[] = []; afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
const provider = { providerId: "test", displayName: "Test", baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "model", contextWindow: 128_000, maxTokens: null, reasoning: false, input: ["text" as const] };
const prompt = { ...loadDecomposerPrompt(), status: "active" as const, publicationEvidence: { reportPath: "eval.json", reportSha256: "f".repeat(64), providerId: "test", modelId: "model", evaluatedAt: new Date().toISOString() } };

it("atomically commits source-bound candidates with job and audit terminal state", () => {
  const { workspace, sourceId } = fixture();
  try {
    const service = new DecomposerRunService(workspace); const prepared = service.prepare({ sourceId, provider, prompt });
    service.complete({ runId: prepared.runId, output: { candidates: [{ kind: "location", sourceChunkIds: [prepared.chunks[0]!.id], confidence: 0.9, payload: { name: "银湾", description: "退潮开放" } }], unresolvedSourceChunkIds: [] }, receipt: { totalTokens: 42 } });
    expect(workspace.db.prepare("SELECT status FROM import_jobs WHERE id = ?").get(prepared.jobId)).toEqual({ status: "succeeded" });
    expect(workspace.db.prepare("SELECT status, output_sha256 FROM decomposer_run_audits WHERE id = ?").get(prepared.runId)).toMatchObject({ status: "succeeded", output_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM decomposition_candidates WHERE job_id = ?").get(prepared.jobId)).toEqual({ count: 1 });
  } finally { workspace.close(); }
});

it("rejects forged source ids without writing candidates", () => {
  const { workspace, sourceId } = fixture();
  try {
    const service = new DecomposerRunService(workspace); const prepared = service.prepare({ sourceId, provider, prompt });
    expect(() => service.complete({ runId: prepared.runId, output: { candidates: [{ kind: "location", sourceChunkIds: ["invented"], confidence: 1, payload: { name: "伪造", description: "无来源" } }], unresolvedSourceChunkIds: [] }, receipt: {} }))
      .toThrowError(/Decomposer run operation failed/);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM decomposition_candidates").get()).toEqual({ count: 0 });
    service.fail(prepared.runId, "failed", "DECOMPOSER_SOURCE_MISMATCH");
    expect(workspace.db.prepare("SELECT status, error_code FROM decomposer_run_audits WHERE id = ?").get(prepared.runId)).toEqual({ status: "failed", error_code: "DECOMPOSER_SOURCE_MISMATCH" });
  } finally { workspace.close(); }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-decomposer-run-")); roots.push(root);
  const filePath = path.join(root, "source.txt"); fs.writeFileSync(filePath, "银湾只在退潮时开放。", "utf8");
  const workspace = openWorkspace(root); const source = new SourceLibraryRepository(workspace).register({ filePath, rightsAttestation: "user_owned" });
  new TextSourceParserService(workspace).parse(source.id); return { workspace, sourceId: source.id };
}
