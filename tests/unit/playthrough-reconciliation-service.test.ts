import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { PlaythroughReconciliationService } from "../../src/domain/play/playthroughReconciliationService";
import { PlaythroughRepository } from "../../src/domain/play/playthroughRepository";
import { StoryProfileRepository } from "../../src/domain/story/storyProfileRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let workspace: WorkspaceDatabase | null = null;
let root = "";

afterEach(() => {
  workspace?.close();
  workspace = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("PlaythroughReconciliationService", () => {
  it("keeps the old save pinned or forks a new empty save from current canon", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-reconcile-"));
    workspace = openWorkspace(root);
    const changes = new ChangeSetRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const baseChange = changes.propose({ idempotencyKey: "reconcile-base", mode: "assist", summary: "创建旧正史" });
    let worldId = "";
    let storyId = "";
    const baseCommitId = changes.commit(baseChange.id, "旧正史", (checkpointId) => {
      worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "旧银湾", parentId: resources.listCurrent().find((item) => item.type === "world")!.id, state: "active" });
      storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "潮痕", parentId: resources.listCurrent().find((item) => item.type === "story")!.id, state: "active" });
    });
    const profile = new StoryProfileRepository(workspace).create({ storyResourceId: storyId, worldResourceId: worldId, canonCommitId: baseCommitId, title: "旧开局" });
    const plays = new PlaythroughRepository(workspace);
    const oldPlay = plays.create({ storyProfileId: profile.id });
    plays.appendTurn({ playthroughId: oldPlay.id, playerAction: "调查海岸", gmResolution: { result: "found" }, writerText: "旧海岸仍在。", stateSnapshot: { scene: 1 } });
    const newChange = changes.propose({ idempotencyKey: "reconcile-new", mode: "assist", summary: "修改当前正史" });
    const currentCommitId = changes.commit(newChange.id, "新正史", () => undefined);
    const service = new PlaythroughReconciliationService(workspace);

    expect(service.inspect(oldPlay.id)).toMatchObject({ state: "canon_diverged", pinnedCommitId: baseCommitId, currentCommitId });
    expect(service.resolve({ playthroughId: oldPlay.id, decision: "continue_pinned" }).id).toBe(oldPlay.id);
    const fork = service.resolve({ playthroughId: oldPlay.id, decision: "fork_from_current" });

    expect(fork).toMatchObject({ parentPlaythroughId: oldPlay.id, baselineCommitId: currentCommitId, currentTurnId: null });
    expect(plays.getRequired(oldPlay.id)).toMatchObject({ baselineCommitId: baseCommitId });
    expect(workspace.db.prepare("SELECT decision, forked_playthrough_id FROM canon_reconciliation_decisions ORDER BY created_at, rowid").all()).toEqual([
      { decision: "continue_pinned", forked_playthrough_id: null },
      { decision: "fork_from_current", forked_playthrough_id: fork.id },
    ]);
  });
});
