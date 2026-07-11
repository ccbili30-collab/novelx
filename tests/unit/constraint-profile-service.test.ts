import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { ConstraintProfileService } from "../../src/domain/workspace/constraintProfileService";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("constraint profile service", () => {
  it("inherits stable constraints from project to story hierarchy with source tracking", () => {
    const workspace = createWorkspace();
    const resources = new ResourceRepository(workspace);
    const changes = new ChangeSetRepository(workspace);
    const constraints = new ConstraintProfileService(workspace);
    const storyRoot = resources.listCurrent().find((resource) => resource.type === "story")!;
    let storyId = "";
    let volumeId = "";
    let chapterId = "";
    const setup = changes.propose({ idempotencyKey: "constraint-hierarchy", mode: "free", summary: "创建故事层级" });
    changes.commit(setup.id, "创建故事层级", (checkpointId) => {
      storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "潮痕", parentId: storyRoot.id, state: "active" });
      volumeId = resources.putRevision({ checkpointId, type: "story", objectKind: "volume", title: "第一卷", parentId: storyId, state: "active" });
      chapterId = resources.putRevision({ checkpointId, type: "story", objectKind: "chapter", title: "归潮", parentId: volumeId, state: "active" });
    });

    constraints.createStable({
      scopeResourceId: null,
      title: "项目基准",
      payload: {
        narrativePerson: "third",
        tense: null,
        tone: "克制",
        pacing: null,
        humorLevel: 0,
        prohibitedContent: ["现代网络用语"],
        requiredContent: ["遵守既定世界规则"],
        notes: "",
      },
    });
    const storyProfile = constraints.createStable({
      scopeResourceId: storyId,
      title: "故事风格",
      payload: {
        narrativePerson: null,
        tense: "past",
        tone: "轻快诙谐",
        pacing: "紧凑",
        humorLevel: 4,
        prohibitedContent: ["无来源复活"],
        requiredContent: [],
        notes: "笑点不能破坏人物一致性。",
      },
    });
    constraints.createStable({
      scopeResourceId: chapterId,
      title: "本章约束",
      payload: {
        narrativePerson: null,
        tense: "present",
        tone: null,
        pacing: null,
        humorLevel: null,
        prohibitedContent: [],
        requiredContent: ["本章必须出现潮钟"],
        notes: "",
      },
    });

    expect(constraints.resolveForResource(chapterId)).toMatchObject({
      narrativePerson: { value: "third", sourceTitle: "项目基准" },
      tense: { value: "present", sourceTitle: "本章约束" },
      tone: { value: "轻快诙谐", sourceTitle: "故事风格" },
      humorLevel: { value: 4, sourceTitle: "故事风格" },
      prohibitedContent: [
        { value: "现代网络用语", sourceTitle: "项目基准" },
        { value: "无来源复活", sourceTitle: "故事风格" },
      ],
      requiredContent: [
        { value: "遵守既定世界规则", sourceTitle: "项目基准" },
        { value: "本章必须出现潮钟", sourceTitle: "本章约束" },
      ],
    });

    const draft = constraints.saveWorkingCopy({
      profileId: storyProfile.profileId,
      payload: { ...storyProfile.payload, tone: "阴郁悲怆" },
      expectedRevision: 0,
      expectedStableVersionId: storyProfile.versionId,
    });
    expect(draft.dirty).toBe(true);
    expect(constraints.resolveForResource(chapterId).tone.value).toBe("轻快诙谐");

    constraints.saveStable({ profileId: storyProfile.profileId, expectedRevision: draft.workingRevision });
    expect(constraints.resolveForResource(chapterId).tone.value).toBe("阴郁悲怆");

    const stableEditor = constraints.getForEditor(storyProfile.profileId);
    const discardedDraft = constraints.saveWorkingCopy({
      profileId: storyProfile.profileId,
      payload: { ...stableEditor.payload, tone: "不应发布的草稿" },
      expectedRevision: stableEditor.workingRevision,
      expectedStableVersionId: stableEditor.stableVersionId,
    });
    expect(constraints.getForEditor(storyProfile.profileId)).toMatchObject({ dirty: true, payload: { tone: "不应发布的草稿" } });
    expect(constraints.discardWorkingCopy({ profileId: storyProfile.profileId, expectedRevision: discardedDraft.workingRevision }))
      .toMatchObject({ dirty: false, hasWorkingCopy: false, payload: { tone: "阴郁悲怆" } });
  });
});

function createWorkspace(): WorkspaceDatabase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-constraints-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  return workspace;
}
