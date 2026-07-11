import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlayerAuditRepository, type PlayerAuditRole } from "../../src/domain/audit/playerAuditRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { PlaythroughRepository } from "../../src/domain/play/playthroughRepository";
import { StoryProfileRepository } from "../../src/domain/story/storyProfileRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let workspace: WorkspaceDatabase | null = null;
let root = "";
afterEach(() => { workspace?.close(); workspace = null; if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("PlayerAuditRepository", () => {
  it("requires completed GM, Writer, and Checker invocations before completing a player run", () => {
    const setup = createPlaythrough();
    const audit = new PlayerAuditRepository(setup.workspace);
    audit.beginRun({ runId: "run-1", playthroughId: setup.playthroughId, playerActionSha256: sha("1"), providerId: "provider", requestedModelId: "model", providerConfigSha256: sha("2") });
    beginInvocation(audit, "run-1", "gm-1", "gm", null);
    audit.appendInvocationTerminal({ runId: "run-1", invocationId: "gm-1", eventType: "completed", errorCode: null, receipt: receipt(), structuredSubmissionCount: 1, outputSha256: sha("3") });
    expect(() => audit.appendRunTerminal({ runId: "run-1", eventType: "completed", errorCode: null })).toThrow(/Player audit contract failed/);

    beginInvocation(audit, "run-1", "writer-1", "writer", "gm-1");
    beginInvocation(audit, "run-1", "checker-1", "checker", "gm-1");
    audit.appendInvocationTerminal({ runId: "run-1", invocationId: "writer-1", eventType: "completed", errorCode: null, receipt: receipt(), structuredSubmissionCount: 1, outputSha256: sha("4") });
    audit.appendInvocationTerminal({ runId: "run-1", invocationId: "checker-1", eventType: "completed", errorCode: null, receipt: receipt(), structuredSubmissionCount: 1, outputSha256: sha("5") });
    audit.linkEvidence({ runId: "run-1", invocationId: "gm-1", evidence: [{ id: "assertion-version-1", sha256: sha("6") }] });
    audit.appendRunTerminal({ runId: "run-1", eventType: "completed", errorCode: null });

    expect(setup.workspace.db.prepare("SELECT event_type FROM player_agent_audit_events WHERE entity_type = 'run'").get()).toEqual({ event_type: "completed" });
    expect(setup.workspace.db.prepare("SELECT evidence_id FROM player_agent_evidence_links").get()).toEqual({ evidence_id: "assertion-version-1" });
    expect(() => audit.appendRunTerminal({ runId: "run-1", eventType: "failed", errorCode: "LATE_FAILURE" })).toThrow();
  });

  it("enforces root GM and parented specialist identities in SQLite", () => {
    const setup = createPlaythrough();
    const audit = new PlayerAuditRepository(setup.workspace);
    audit.beginRun({ runId: "run-2", playthroughId: setup.playthroughId, playerActionSha256: sha("1"), providerId: "provider", requestedModelId: "model", providerConfigSha256: sha("2") });
    expect(() => beginInvocation(audit, "run-2", "bad-gm", "gm", "parent")).toThrow();
    expect(() => beginInvocation(audit, "run-2", "bad-writer", "writer", null)).toThrow();
  });
});

function beginInvocation(audit: PlayerAuditRepository, runId: string, invocationId: string, role: PlayerAuditRole, parentInvocationId: string | null) {
  audit.beginInvocation({
    invocationId, runId, parentInvocationId, role,
    prompt: { id: `novax.${role}`, version: "1.0.0", sha256: sha("a") },
    profile: { id: `novax.${role}-runtime`, version: "1.0.0", sha256: sha("b"), toolPolicyId: `novax.${role}-tools`, toolPolicyVersion: "1.0.0", toolPolicySha256: sha("c"), authorizedTools: [`submit_${role}_result`] },
    provider: { providerId: "provider", requestedModelId: "model", providerConfigSha256: sha("2") },
    handoff: role === "gm" ? null : { contractId: `novax.${role}-handoff`, version: "1.0.0", payloadSha256: sha("d") },
    inputSha256: sha("e"),
  });
}

function receipt() { return { actualProviderId: "provider", actualModelId: "model", responseIdSha256: sha("f"), stopReason: "stop", inputTokens: 10, outputTokens: 5, totalTokens: 15, contextPolicyVersion: "v1", maxChargedInputBytes: 100, configuredContextWindow: 128_000, safetyReserve: 2_000, outputReserve: 4_000 }; }
function sha(character: string) { return character.repeat(64).slice(0, 64); }

function createPlaythrough() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-player-audit-"));
  workspace = openWorkspace(root);
  const changes = new ChangeSetRepository(workspace);
  const resources = new ResourceRepository(workspace);
  const change = changes.propose({ idempotencyKey: `audit-${Date.now()}-${Math.random()}`, mode: "assist", summary: "建立玩家审计基线" });
  let worldId = ""; let storyId = "";
  const commitId = changes.commit(change.id, "建立玩家审计基线", (checkpointId) => {
    const roots = resources.listCurrent();
    worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "银湾", parentId: roots.find((item) => item.type === "world")!.id, state: "active" });
    storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "潮痕", parentId: roots.find((item) => item.type === "story")!.id, state: "active" });
  });
  const profile = new StoryProfileRepository(workspace).create({ storyResourceId: storyId, worldResourceId: worldId, canonCommitId: commitId, title: "玩家审计" });
  const playthrough = new PlaythroughRepository(workspace).create({ storyProfileId: profile.id });
  return { workspace, playthroughId: playthrough.id };
}
