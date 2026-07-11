import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadDecomposerPrompt } from "../../src/agent-worker/import/decomposerPromptRegistry";
import { DecomposerRunService } from "../../src/domain/import/decomposerRunService";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { TextSourceParserService } from "../../src/domain/import/textSourceParserService";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import type { AgentWorkerProcess } from "../../src/main/agentProcessSupervisor";
import { DecomposerProcessSupervisor } from "../../src/main/decomposerProcessSupervisor";
import type { DecomposerWorkerEvent } from "../../src/shared/decomposerWorkerProtocol";

const provider = { providerId: "test", displayName: "Test", baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "model", contextWindow: 128_000, maxTokens: null, reasoning: false, input: ["text" as const] };
const prompt = { ...loadDecomposerPrompt(), status: "active" as const, publicationEvidence: { reportPath: "eval.json", reportSha256: "f".repeat(64), providerId: "test", modelId: "model", evaluatedAt: new Date().toISOString() } };

it("persists a matching worker completion through the audited supervisor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-decomposer-supervisor-"));
  const workspace = openWorkspace(root); const filePath = path.join(root, "source.txt"); fs.writeFileSync(filePath, "银湾只在退潮时开放。", "utf8");
  const source = new SourceLibraryRepository(workspace).register({ filePath, rightsAttestation: "user_owned" });
  new TextSourceParserService(workspace).parse(source.id);
  const child = new FakeWorker(); const events: DecomposerWorkerEvent[] = [];
  const supervisor = new DecomposerProcessSupervisor("worker.js", {
    acquireRuntimeLease: () => ({ service: new DecomposerRunService(workspace), release() {} }),
    getProviderProfile: () => structuredClone(provider), loadPrompt: () => prompt, spawnWorker: () => child,
  });
  try {
    const runId = supervisor.start(source.id, (event) => events.push(event)); expect(runId).toBeTruthy(); child.emit("spawn");
    const command = child.sent[0] as { chunks: Array<{ id: string }> }; const chunkId = command.chunks[0]!.id;
    child.emit("message", { type: "decompose.started", runId });
    child.emit("message", { type: "decompose.completed", runId, output: { candidates: [{ kind: "world_rule", sourceChunkIds: [chunkId], confidence: 0.9, payload: { subject: "银湾", predicate: "开放条件", value: "退潮" } }], unresolvedSourceChunkIds: [] }, receipt: {
      actualProviderId: "test", actualModelId: "model", responseIdSha256: null, inputTokens: 10, outputTokens: 5, totalTokens: 15,
      contextPolicyVersion: "policy", maxChargedInputBytes: 100, configuredContextWindow: 128000, safetyReserve: 1000, outputReserve: 1000, correctionAttempts: 0,
    } });
    expect(events.map((event) => event.type)).toEqual(["decompose.started", "decompose.completed"]);
    expect(workspace.db.prepare("SELECT status FROM decomposer_run_audits WHERE id = ?").get(runId)).toEqual({ status: "succeeded" });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM decomposition_candidates").get()).toEqual({ count: 1 });
  } finally { supervisor.dispose(); workspace.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

class FakeWorker extends EventEmitter implements AgentWorkerProcess {
  killed = false; sent: unknown[] = [];
  send(message: unknown) { this.sent.push(message); return true; }
  kill() { this.killed = true; return true; }
  override on(event: "message", listener: (payload: unknown) => void): this { return super.on(event, listener); }
  override once(event: "spawn" | "error" | "exit", listener: (...args: any[]) => void): this { return super.once(event, listener); }
}
