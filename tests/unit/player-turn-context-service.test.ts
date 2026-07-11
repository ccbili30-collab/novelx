import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { PlaythroughReconciliationService } from "../../src/domain/play/playthroughReconciliationService";
import { PlaythroughRepository } from "../../src/domain/play/playthroughRepository";
import { PlayerTurnContextService } from "../../src/domain/play/playerTurnContextService";
import { StoryProfileRepository } from "../../src/domain/story/storyProfileRepository";
import { ConstraintProfileRepository } from "../../src/domain/workspace/constraintProfileRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let workspace: WorkspaceDatabase | null = null; let root = "";
afterEach(() => { workspace?.close(); workspace = null; if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("PlayerTurnContextService", () => {
  it("uses the accepted pinned canon, recent immutable turn, and pinned writing constraints", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-player-context-"));
    workspace = openWorkspace(root);
    const resources = new ResourceRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const assertions = new AssertionRepository(workspace);
    const constraints = new ConstraintProfileRepository(workspace);
    const changes = new ChangeSetRepository(workspace);
    const baseChange = changes.propose({ idempotencyKey: "player-context-base", mode: "assist", summary: "旧正史" });
    let worldId = ""; let storyId = ""; let constraintId = "";
    const baseCommitId = changes.commit(baseChange.id, "旧正史", (checkpointId) => {
      const roots = resources.listCurrent();
      worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "银湾", parentId: roots.find((item) => item.type === "world")!.id, state: "active" });
      storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "潮痕", parentId: roots.find((item) => item.type === "story")!.id, state: "active" });
      const versionId = documents.putVersion({ resourceId: worldId, checkpointId, content: "旧正史：洞穴只在退潮时开放。", authorKind: "user" });
      assertions.putVersion({ assertionId: "assertion.cave", checkpointId, scopeType: "world", scopeId: worldId, subject: "洞穴", predicate: "开放条件", object: { tide: "low" }, status: "current", source: { kind: "document_version", ref: versionId } });
      constraintId = constraints.putVersion({ checkpointId, scopeResourceId: storyId, title: "正文风格", payload: payload("轻快"), state: "active", authorKind: "user" }).profileId;
    });
    const profile = new StoryProfileRepository(workspace).create({ storyResourceId: storyId, worldResourceId: worldId, canonCommitId: baseCommitId, title: "旧开局" });
    const plays = new PlaythroughRepository(workspace);
    const play = plays.create({ storyProfileId: profile.id });
    plays.appendTurn({ playthroughId: play.id, playerAction: "抵达海岸", gmResolution: { status: "resolved" }, writerText: "你抵达银湾海岸。", stateSnapshot: { location: "海岸", luck: 0.8 } });

    const nextChange = changes.propose({ idempotencyKey: "player-context-new", mode: "assist", summary: "新正史" });
    changes.commit(nextChange.id, "新正史", (checkpointId) => {
      const newVersionId = documents.putVersion({ resourceId: worldId, checkpointId, content: "新正史：洞穴永久封死。", authorKind: "user" });
      assertions.putVersion({ assertionId: "assertion.cave", checkpointId, scopeType: "world", scopeId: worldId, subject: "洞穴", predicate: "开放条件", object: { state: "sealed" }, status: "current", source: { kind: "document_version", ref: newVersionId } });
      constraints.putVersion({ profileId: constraintId, checkpointId, scopeResourceId: storyId, title: "正文风格", payload: payload("悲伤"), state: "active", authorKind: "user" });
    });

    const service = new PlayerTurnContextService(workspace);
    expect(() => service.prepare({ playthroughId: play.id, playerAction: "进入洞穴" })).toThrow(expect.objectContaining({ code: "PLAYTHROUGH_RECONCILIATION_REQUIRED" }));
    new PlaythroughReconciliationService(workspace).resolve({ playthroughId: play.id, decision: "continue_pinned" });
    const prepared = service.prepare({ playthroughId: play.id, playerAction: "进入洞穴" });

    expect(prepared.currentState).toEqual({ location: "海岸", luck: 0.8 });
    expect(prepared.luck).toBe(0.8);
    expect(prepared.recentMemory).toContain("你抵达银湾海岸");
    expect(prepared.evidence.some((item) => item.content.includes("退潮时开放"))).toBe(true);
    expect(prepared.evidence.filter((item) => item.content.startsWith("{")).every((item) => !item.content.includes("sources"))).toBe(true);
    expect(JSON.stringify(prepared.evidence)).not.toContain("永久封死");
    expect(prepared.styleConstraints.map((item) => item.content)).toContain("正文风格 · 语气：轻快");
    expect(JSON.stringify(prepared.styleConstraints)).not.toContain("悲伤");
  });
});

function payload(tone: string) { return { narrativePerson: "second" as const, tense: "present" as const, tone, pacing: null, humorLevel: null, prohibitedContent: [], requiredContent: [], notes: "" }; }
