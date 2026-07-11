import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { DecompositionCandidateRepository } from "../../src/domain/import/decompositionCandidateRepository";
import { ImportJobRepository } from "../../src/domain/import/importJobRepository";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { TextSourceParserService } from "../../src/domain/import/textSourceParserService";
import { PlaythroughRepository } from "../../src/domain/play/playthroughRepository";
import { StartProfileRepository } from "../../src/domain/play/startProfileRepository";
import { StoryProfileRepository } from "../../src/domain/story/storyProfileRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let workspace: WorkspaceDatabase | null = null;
let root = "";
afterEach(() => { workspace?.close(); workspace = null; if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("Start Profile to Playthrough binding", () => {
  it("pins reviewed starting facts while keeping original future events outside the initial state", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-start-profile-"));
    workspace = openWorkspace(root);
    const storyProfile = createStoryProfile(workspace);
    const sourcePath = path.join(root, "novel.md");
    fs.writeFileSync(sourcePath, "# 世界\n银湾退潮时洞穴开放。\n# 原著未来\n三年后银湾沉没。", "utf8");
    const source = new SourceLibraryRepository(workspace).register({ filePath: sourcePath, rightsAttestation: "user_owned" });
    const chunks = new TextSourceParserService(workspace).parse(source.id);
    const jobs = new ImportJobRepository(workspace);
    const job = jobs.start(source.id, "decompose");
    const candidates = new DecompositionCandidateRepository(workspace);
    const [rule, future] = candidates.appendOutput({ sourceId: source.id, jobId: job.id, output: {
      candidates: [
        { kind: "world_rule", sourceChunkIds: [chunks[0]!.id], confidence: 0.95, payload: { subject: "银湾洞穴", predicate: "开放条件", value: "退潮" } },
        { kind: "event", sourceChunkIds: [chunks.at(-1)!.id], confidence: 0.9, payload: { subject: "银湾", description: "三年后沉没", temporal: { kind: "instant", value: "三年后" } } },
      ],
      unresolvedSourceChunkIds: [],
    } });
    candidates.decide(rule!.id, "accepted");
    candidates.decide(future!.id, "accepted");
    jobs.succeed(job.id);

    const starts = new StartProfileRepository(workspace);
    const start = starts.create({
      storyProfileId: storyProfile.id,
      sourceId: source.id,
      title: "退潮入口",
      status: "active",
      startState: {
        openingSituation: "玩家抵达退潮后的银湾。",
        initialState: { location: "银湾海岸", tide: "low" },
        sourceCandidateIds: [rule!.id],
        excludedFutureEventCandidateIds: [future!.id],
      },
    });
    const playthrough = new PlaythroughRepository(workspace).create({ storyProfileId: storyProfile.id, startProfileId: start.id });

    expect(playthrough).toMatchObject({
      startProfileId: start.id,
      initialStateSnapshot: { location: "银湾海岸", tide: "low" },
    });
    expect(JSON.stringify(playthrough.initialStateSnapshot)).not.toContain("三年后");
    expect(() => workspace!.db.prepare("UPDATE start_profiles SET start_state_json = '{}' WHERE id = ?").run(start.id)).toThrow(/START_PROFILE_IDENTITY_IMMUTABLE/);
    expect(() => workspace!.db.prepare("UPDATE playthroughs SET start_profile_id = NULL WHERE id = ?").run(playthrough.id)).toThrow(/PLAYTHROUGH_BASELINE_IMMUTABLE/);
  });

  it("rejects unreviewed candidates and draft starts", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-start-profile-invalid-"));
    workspace = openWorkspace(root);
    const storyProfile = createStoryProfile(workspace);
    const sourcePath = path.join(root, "notes.txt"); fs.writeFileSync(sourcePath, "候选设定", "utf8");
    const source = new SourceLibraryRepository(workspace).register({ filePath: sourcePath, rightsAttestation: "user_owned" });
    const chunk = new TextSourceParserService(workspace).parse(source.id)[0]!;
    const job = new ImportJobRepository(workspace).start(source.id, "decompose");
    const candidate = new DecompositionCandidateRepository(workspace).appendOutput({ sourceId: source.id, jobId: job.id, output: {
      candidates: [{ kind: "style", sourceChunkIds: [chunk.id], confidence: 0.5, payload: { description: "冷峻" } }], unresolvedSourceChunkIds: [],
    } })[0]!;
    expect(() => new StartProfileRepository(workspace!).create({ storyProfileId: storyProfile.id, sourceId: source.id, title: "无效", status: "active", startState: {
      openingSituation: "开场", initialState: {}, sourceCandidateIds: [candidate.id], excludedFutureEventCandidateIds: [],
    } })).toThrow();

    const draft = new StartProfileRepository(workspace).create({ storyProfileId: storyProfile.id, title: "草稿", startState: {
      openingSituation: "开场", initialState: {}, sourceCandidateIds: [], excludedFutureEventCandidateIds: [],
    } });
    expect(() => new PlaythroughRepository(workspace!).create({ storyProfileId: storyProfile.id, startProfileId: draft.id })).toThrow();
  });
});

function createStoryProfile(workspace: WorkspaceDatabase) {
  const changes = new ChangeSetRepository(workspace);
  const resources = new ResourceRepository(workspace);
  const change = changes.propose({ idempotencyKey: `start-${Date.now()}-${Math.random()}`, mode: "assist", summary: "建立起始模板基线" });
  let worldId = ""; let storyId = "";
  const commitId = changes.commit(change.id, "建立起始模板基线", (checkpointId) => {
    const roots = resources.listCurrent();
    worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "银湾", parentId: roots.find((item) => item.type === "world")!.id, state: "active" });
    storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "潮痕", parentId: roots.find((item) => item.type === "story")!.id, state: "active" });
  });
  return new StoryProfileRepository(workspace).create({ storyResourceId: storyId, worldResourceId: worldId, canonCommitId: commitId, title: "潮痕开局" });
}
