import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { PlaythroughRepository } from "../../src/domain/play/playthroughRepository";
import { StoryProfileRepository } from "../../src/domain/story/storyProfileRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { CreativeWorkspaceService } from "../../src/domain/workspace/creativeWorkspaceService";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";

let workspace: WorkspaceDatabase | null = null;
let root = "";

afterEach(() => {
  workspace?.close();
  workspace = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("Story Profile and Playthrough repositories", () => {
  it("pins sealed canon and keeps accepted turns immutable", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-playthrough-"));
    workspace = openWorkspace(root);
    const changes = new ChangeSetRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const change = changes.propose({ idempotencyKey: "playthrough-canon", mode: "assist", summary: "建立故事基线" });
    let worldId = "";
    let storyId = "";
    const commitId = changes.commit(change.id, "建立故事基线", (checkpointId) => {
      worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "银湾", parentId: resources.listCurrent().find((item) => item.type === "world")!.id, state: "active" });
      storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "潮痕", parentId: resources.listCurrent().find((item) => item.type === "story")!.id, state: "active" });
    });
    const profile = new StoryProfileRepository(workspace).create({ storyResourceId: storyId, worldResourceId: worldId, canonCommitId: commitId, title: "潮痕开局" });
    const plays = new PlaythroughRepository(workspace);
    const playthrough = plays.create({ storyProfileId: profile.id });
    const turn = plays.appendTurn({
      playthroughId: playthrough.id,
      playerAction: "进入退潮后的洞穴",
      gmResolution: { outcome: "entered", discovered: ["潮痕石门"] },
      writerText: "你踏过湿冷的礁石，石门在潮声后显露。",
      stateSnapshot: { location: "潮痕洞穴", health: 10 },
    });

    expect(plays.getRequired(playthrough.id)).toMatchObject({ baselineCommitId: commitId, currentTurnId: turn.id });
    expect(turn).toMatchObject({ sequence: 1, parentTurnId: null });
    expect(() => workspace!.db.prepare("UPDATE play_turns SET writer_text = '改写' WHERE id = ?").run(turn.id)).toThrow(/PLAY_TURN_IMMUTABLE/);
    expect(() => workspace!.db.prepare("DELETE FROM play_turns WHERE id = ?").run(turn.id)).toThrow(/PLAY_TURN_IMMUTABLE/);
  });

  it("refuses to pin the unsealed initialization commit", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-unsealed-profile-"));
    workspace = openWorkspace(root);
    const resources = new ResourceRepository(workspace);
    const roots = resources.listCurrent();
    const unsealed = workspace.db.prepare("SELECT id FROM creative_commits WHERE sealed_at IS NULL LIMIT 1").get() as { id: string };
    const worldId = resources.putRevision({ checkpointId: unsealed.id, type: "world", objectKind: "world", title: "未封存世界", parentId: roots.find((item) => item.type === "world")!.id, state: "active" });
    const storyId = resources.putRevision({ checkpointId: unsealed.id, type: "story", objectKind: "story", title: "未封存故事", parentId: roots.find((item) => item.type === "story")!.id, state: "active" });
    expect(() => new StoryProfileRepository(workspace!).create({
      storyResourceId: storyId,
      worldResourceId: worldId,
      canonCommitId: unsealed.id,
      title: "无效基线",
    })).toThrow();
  });

  it("seals manual UI mutations so visible world and story objects can become a canon baseline", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-manual-profile-"));
    workspace = openWorkspace(root);
    const creative = new CreativeWorkspaceService(workspace);
    creative.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "潮汐世界", parentId: null });
    creative.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "潮痕", parentId: null });
    const resources = new ResourceRepository(workspace);
    const world = resources.listVisibleCurrent().find((item) => item.title === "潮汐世界")!;
    const story = resources.listVisibleCurrent().find((item) => item.title === "潮痕")!;
    const head = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;

    expect(new StoryProfileRepository(workspace).create({ storyResourceId: story.id, worldResourceId: world.id, canonCommitId: head, title: "潮痕" }))
      .toMatchObject({ storyResourceId: story.id, worldResourceId: world.id, canonCommitId: head });
  });
});
