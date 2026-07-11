import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { promptManifest } from "../../src/agent-worker/prompts/manifest";
import { loadGmPrompt } from "../../src/agent-worker/play/playPromptRegistry";
import { PlayerAuditRepository } from "../../src/domain/audit/playerAuditRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { PlayerRunCommitService } from "../../src/domain/play/playerRunCommitService";
import { PlaythroughRepository } from "../../src/domain/play/playthroughRepository";
import { StoryProfileRepository } from "../../src/domain/story/storyProfileRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { PlayerProcessSupervisor, type PlayerRuntimeLease } from "../../src/main/playerProcessSupervisor";
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";
import { getAgentRuntimeProfile } from "../../src/shared/agentRuntimeProfiles";
import type { AgentWorkerProcess } from "../../src/main/agentProcessSupervisor";
import type { ProviderRuntimeProfile } from "../../src/shared/providerContract";

let workspace: WorkspaceDatabase | null = null; let root = "";
afterEach(() => { workspace?.close(); workspace = null; if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("PlayerProcessSupervisor", () => {
  it("persists one immutable turn only after all three audited invocations complete", async () => {
    const setup = createSetup(); const child = new FakePlayerWorker(true, setup.provider, activeGm());
    const events: unknown[] = []; const supervisor = createSupervisor(setup, child);
    supervisor.start({ playthroughId: setup.playthroughId, playerAction: "进入洞穴" }, (event) => events.push(event));
    await child.finished;

    expect(events.at(-1)).toMatchObject({ type: "completed", turn: { writerText: "你进入退潮后的洞穴。", sequence: 1 } });
    expect(JSON.stringify(events)).not.toContain("gmResolution");
    expect(workspace!.db.prepare("SELECT COUNT(*) AS count FROM play_turns").get()).toEqual({ count: 1 });
    expect(workspace!.db.prepare("SELECT event_type FROM player_agent_audit_events WHERE entity_type = 'run'").get()).toEqual({ event_type: "completed" });
  });

  it("rejects a forged completion without role audits and writes no turn", async () => {
    const setup = createSetup(); const child = new FakePlayerWorker(false, setup.provider, activeGm());
    const events: unknown[] = []; const supervisor = createSupervisor(setup, child);
    supervisor.start({ playthroughId: setup.playthroughId, playerAction: "进入洞穴" }, (event) => events.push(event));
    await child.finished;

    expect(events.at(-1)).toMatchObject({ type: "failed" });
    expect(workspace!.db.prepare("SELECT COUNT(*) AS count FROM play_turns").get()).toEqual({ count: 0 });
    expect(workspace!.db.prepare("SELECT event_type FROM player_agent_audit_events WHERE entity_type = 'run'").get()).toEqual({ event_type: "failed" });
  });
});

function createSupervisor(setup: ReturnType<typeof createSetup>, child: FakePlayerWorker) {
  return new PlayerProcessSupervisor("worker.js", {
    acquireRuntimeLease: () => lease(setup.playthroughId), getProviderProfile: () => ({ ...setup.provider }),
    loadGmPrompt: activeGm, spawnWorker: () => child,
  });
}

function lease(playthroughId: string): PlayerRuntimeLease {
  return {
    audit: new PlayerAuditRepository(workspace!), commit: new PlayerRunCommitService(workspace!), release: () => undefined,
    prepare: ({ playerAction }) => ({ playthroughId, playerAction, evidence: [{ id: "evidence-1", content: "洞穴只在退潮时开放。", sha256: hash("洞穴只在退潮时开放。") }], currentState: { location: "海岸" }, recentMemory: "", luck: 0.5, styleConstraints: [] }),
  };
}

class FakePlayerWorker extends EventEmitter implements AgentWorkerProcess {
  killed = false; readonly finished: Promise<void>; private resolveFinished!: () => void; private command: any; private step = 0;
  constructor(readonly audited: boolean, readonly provider: ProviderRuntimeProfile, readonly gmPrompt: ReturnType<typeof activeGm>) {
    super(); this.finished = new Promise((resolve) => { this.resolveFinished = resolve; });
    queueMicrotask(() => this.emit("spawn"));
  }
  send(message: any): boolean {
    if (message.type === "play.start") {
      this.command = message; queueMicrotask(() => {
        this.emit("message", { type: "play.started", runId: message.runId });
        if (this.audited) this.emitNextAudit(); else this.emitCompletion();
      }); return true;
    }
    if (message.type === "audit.response") {
      if (!message.ok) { this.emit("message", { type: "play.failed", runId: this.command.runId, error: { code: "AGENT_AUDIT_REQUIRED", message: "审计失败。" } }); this.resolveFinished(); return true; }
      this.step += 1; queueMicrotask(() => this.step < 6 ? this.emitNextAudit() : this.emitCompletion()); return true;
    }
    return true;
  }
  kill(): boolean { this.killed = true; return true; }
  private emitNextAudit() {
    const roles = ["gm", "gm", "writer", "writer", "checker", "checker"] as const;
    const role = roles[this.step]!; const started = this.step % 2 === 0; const invocationId = `${this.command.runId}:${role}`;
    const prompt = role === "gm"
      ? { id: this.gmPrompt.id, version: this.gmPrompt.version, sha256: this.gmPrompt.sha256 }
      : (() => { const value = activeManifestPrompt(role); return { id: value.id, version: value.version, sha256: value.publishedSha256 }; })();
    const operation = started ? {
      type: "invocation.started", invocationId, parentInvocationId: role === "gm" ? null : `${this.command.runId}:gm`, role,
      prompt, profile: getAgentRuntimeProfile(role),
      provider: { providerId: this.provider.providerId, requestedModelId: this.provider.modelId, providerConfigSha256: providerHash(this.provider) },
      handoff: role === "gm" ? null : { contractId: `novax.${role}-handoff`, version: "2.0.0", payloadSha256: "d".repeat(64) }, inputSha256: "e".repeat(64),
    } : { type: "invocation.terminal", invocationId, eventType: "completed", errorCode: null, receipt: receipt(), structuredSubmissionCount: 1, outputSha256: "f".repeat(64) };
    this.emit("message", { type: "audit.request", runId: this.command.runId, auditRequestId: randomUUID(), operation });
  }
  private emitCompletion() {
    this.emit("message", { type: "play.completed", runId: this.command.runId, result: { gmResolution: { status: "resolved", resolutionId: "resolution-1", evidenceIds: ["evidence-1"], outcome: "进入洞穴", consequences: [{ category: "success", description: "进入洞穴", targetId: null, numericDelta: null }], stateDelta: { location: "洞穴" }, narrativeFacts: ["玩家进入洞穴"] }, writerText: "你进入退潮后的洞穴。", evidenceIds: ["evidence-1"], stateSnapshot: { location: "洞穴" } } });
    queueMicrotask(() => this.resolveFinished());
  }
}

function createSetup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-player-supervisor-")); workspace = openWorkspace(root);
  const changes = new ChangeSetRepository(workspace); const resources = new ResourceRepository(workspace);
  const change = changes.propose({ idempotencyKey: `supervisor-${Date.now()}-${Math.random()}`, mode: "assist", summary: "玩家基线" }); let worldId = ""; let storyId = "";
  const commitId = changes.commit(change.id, "玩家基线", (checkpointId) => { const roots = resources.listCurrent(); worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "银湾", parentId: roots.find((item) => item.type === "world")!.id, state: "active" }); storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "潮痕", parentId: roots.find((item) => item.type === "story")!.id, state: "active" }); });
  const profile = new StoryProfileRepository(workspace).create({ storyResourceId: storyId, worldResourceId: worldId, canonCommitId: commitId, title: "玩家" });
  const playthroughId = new PlaythroughRepository(workspace).create({ storyProfileId: profile.id }).id;
  const provider: ProviderRuntimeProfile = { providerId: "test", displayName: "Test", baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "model", contextWindow: 128_000, maxTokens: null, reasoning: false, input: ["text"] };
  return { playthroughId, provider };
}
function activeGm() { return { ...loadGmPrompt(), status: "active" as const, publicationEvidence: { reportPath: "evidence.json", reportSha256: "a".repeat(64), providerId: "test", modelId: "model", evaluatedAt: new Date().toISOString() } }; }
function activeManifestPrompt(role: "writer" | "checker") { return promptManifest.find((item) => item.role === role && item.status === "active")!; }
function providerHash(profile: ProviderRuntimeProfile) { const { apiKey: _key, ...safe } = profile; return canonicalAuditHash(safe); }
function hash(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function receipt() { return { actualProviderId: "test", actualModelId: "model", responseIdSha256: "a".repeat(64), stopReason: "stop", inputTokens: 10, outputTokens: 5, totalTokens: 15, contextPolicyVersion: "v1", maxChargedInputBytes: 100, configuredContextWindow: 128_000, safetyReserve: 2_000, outputReserve: 4_000, estimatedInputTokens: 10, availableInputBudget: 100_000, systemPromptTokens: 1, toolProtocolTokens: 1, sessionHistoryTokens: 0, retrievalTokens: 5, collaborationTokens: 0, runtimeConversationTokens: 0, correctionAttempts: 0 }; }
