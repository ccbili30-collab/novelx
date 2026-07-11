import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { CreativeDocumentEditorService } from "../../src/domain/workspace/creativeDocumentEditorService";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("creative document editor service", () => {
  it("keeps separate drafts and publishes each document on the shared checkpoint chain", () => {
    const workspace = createWorkspace();
    const resources = new ResourceRepository(workspace);
    const documents = new CreativeDocumentRepository(workspace);
    const changes = new ChangeSetRepository(workspace);
    const editor = new CreativeDocumentEditorService(workspace);
    const storyRoot = resources.listCurrent().find((resource) => resource.type === "story")!;
    let storyId = "";
    let proseId = "";
    let noteId = "";

    const setup = changes.propose({ idempotencyKey: "creative-editor-setup", mode: "free", summary: "创建编辑对象" });
    changes.commit(setup.id, "创建编辑对象", (checkpointId) => {
      storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "潮痕", parentId: storyRoot.id, state: "active" });
      proseId = documents.putRevision({ checkpointId, resourceId: storyId, kind: "prose", title: "正文", state: "active" });
      noteId = documents.putRevision({ checkpointId, resourceId: storyId, kind: "knowledge_note", title: "潮汐历", state: "active" });
    });

    const proseDraft = editor.saveWorkingCopy({ documentId: proseId, content: "潮声从城墙下醒来。", expectedRevision: 0, expectedStableVersionId: null });
    const noteDraft = editor.saveWorkingCopy({ documentId: noteId, content: "一年分为十三个潮月。", expectedRevision: 0, expectedStableVersionId: null });
    expect(proseDraft.dirty).toBe(true);
    expect(noteDraft.dirty).toBe(true);
    expect(editor.getStableForAgent(proseId)).toBeNull();

    const stableProse = editor.saveStable({ documentId: proseId, expectedRevision: proseDraft.workingRevision });
    const stableNote = editor.saveStable({ documentId: noteId, expectedRevision: noteDraft.workingRevision });
    expect(stableProse.dirty).toBe(false);
    expect(stableNote.dirty).toBe(false);
    expect(editor.getStableForAgent(proseId)?.content).toBe("潮声从城墙下醒来。");
    expect(editor.getStableForAgent(noteId)?.content).toBe("一年分为十三个潮月。");

    const checkpoints = workspace.db.prepare("SELECT label FROM checkpoints ORDER BY sequence").all() as Array<{ label: string }>;
    expect(checkpoints.map((row) => row.label)).toEqual([
      "工作区初始化",
      "创建编辑对象",
      "保存《正文》",
      "保存《潮汐历》",
    ]);
  });

  it("discards an unpublished draft and restores the latest stable content", () => {
    const workspace = createWorkspace();
    const resources = new ResourceRepository(workspace);
    const documents = new CreativeDocumentRepository(workspace);
    const changes = new ChangeSetRepository(workspace);
    const editor = new CreativeDocumentEditorService(workspace);
    const storyRoot = resources.listCurrent().find((resource) => resource.type === "story")!;
    let storyId = "";
    let proseId = "";

    const setup = changes.propose({ idempotencyKey: "discard-draft-setup", mode: "free", summary: "创建正文" });
    changes.commit(setup.id, "创建正文", (checkpointId) => {
      storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "潮痕", parentId: storyRoot.id, state: "active" });
      proseId = documents.putRevision({ checkpointId, resourceId: storyId, kind: "prose", title: "正文", state: "active" });
    });
    const firstDraft = editor.saveWorkingCopy({ documentId: proseId, content: "稳定正文", expectedRevision: 0, expectedStableVersionId: null });
    const stable = editor.saveStable({ documentId: proseId, expectedRevision: firstDraft.workingRevision });
    const laterDraft = editor.saveWorkingCopy({ documentId: proseId, content: "尚未发布的改写", expectedRevision: stable.workingRevision, expectedStableVersionId: stable.stableVersionId });

    const restored = editor.discardWorkingCopy({ documentId: proseId, expectedRevision: laterDraft.workingRevision });
    expect(restored).toMatchObject({ content: "稳定正文", dirty: false, hasWorkingCopy: false, workingRevision: 0 });
    expect(() => editor.discardWorkingCopy({ documentId: proseId, expectedRevision: laterDraft.workingRevision }))
      .toThrowError(/working copy/i);
  });
});

function createWorkspace(): WorkspaceDatabase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-creative-editor-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  return workspace;
}
