import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DocumentEditorService } from "../../src/domain/workspace/documentEditorService";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("DocumentEditorService", () => {
  it("recovers a working copy after restart while Agent reads only the stable version", () => {
    const root = createRoot();
    let workspace = openTracked(root);
    const resourceId = getWorldResourceId(workspace);
    const checkpoints = new CheckpointRepository(workspace);
    const documents = new DocumentRepository(workspace);
    documents.putVersion({
      resourceId,
      checkpointId: checkpoints.getActiveBranch().headCheckpointId,
      content: "稳定世界设定",
      authorKind: "user",
    });

    const editor = new DocumentEditorService(workspace);
    const draft = editor.saveWorkingCopy({
      resourceId,
      content: "尚未发布的世界设定草稿",
      expectedRevision: 0,
      expectedStableVersionId: editor.getForEditor(resourceId).stableVersionId,
    });
    expect(draft).toMatchObject({ workingRevision: 1, dirty: true, hasWorkingCopy: true });
    expect(editor.getStableForAgent(resourceId)?.content).toBe("稳定世界设定");

    closeTracked(workspace);
    workspace = openTracked(root);
    const reopened = new DocumentEditorService(workspace);
    expect(reopened.getForEditor(resourceId)).toMatchObject({
      content: "尚未发布的世界设定草稿",
      workingRevision: 1,
      dirty: true,
    });
    expect(reopened.getStableForAgent(resourceId)?.content).toBe("稳定世界设定");

    const beforeHead = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
    const stable = reopened.saveStable({ resourceId, expectedRevision: 1 });
    const afterHead = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
    expect(afterHead).not.toBe(beforeHead);
    expect(stable).toMatchObject({
      content: "尚未发布的世界设定草稿",
      workingRevision: 1,
      dirty: false,
    });
    expect(stable.stableVersionId).not.toBeNull();
    expect(reopened.getStableForAgent(resourceId)?.content).toBe("尚未发布的世界设定草稿");
  });

  it("rejects a stale working-copy revision without overwriting the newer draft", () => {
    const workspace = openTracked(createRoot());
    const resourceId = getWorldResourceId(workspace);
    const editor = new DocumentEditorService(workspace);

    editor.saveWorkingCopy({ resourceId, content: "第一份草稿", expectedRevision: 0, expectedStableVersionId: null });
    expect(() => editor.saveWorkingCopy({
      resourceId,
      content: "来自过期编辑器的覆盖",
      expectedRevision: 0,
      expectedStableVersionId: null,
    })).toThrowError(expect.objectContaining({ code: "DOCUMENT_EDIT_CONFLICT" }));
    expect(editor.getForEditor(resourceId)).toMatchObject({
      content: "第一份草稿",
      workingRevision: 1,
      dirty: true,
    });
  });

  it("does not create a first working copy on top of a stable version the editor never loaded", () => {
    const workspace = openTracked(createRoot());
    const resourceId = getWorldResourceId(workspace);
    const checkpoints = new CheckpointRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const firstVersionId = documents.putVersion({
      resourceId,
      checkpointId: checkpoints.getActiveBranch().headCheckpointId,
      content: "版本一",
      authorKind: "user",
    });
    const editor = new DocumentEditorService(workspace);
    const staleSnapshot = editor.getForEditor(resourceId);
    expect(staleSnapshot.stableVersionId).toBe(firstVersionId);

    const nextCheckpointId = checkpoints.appendCheckpoint(checkpoints.getActiveBranch().id, "并发稳定更新");
    documents.putVersion({
      resourceId,
      checkpointId: nextCheckpointId,
      content: "版本二",
      authorKind: "agent",
    });

    expect(() => editor.saveWorkingCopy({
      resourceId,
      content: "旧编辑器基于版本一的修改",
      expectedRevision: staleSnapshot.workingRevision,
      expectedStableVersionId: staleSnapshot.stableVersionId,
    })).toThrowError(expect.objectContaining({ code: "DOCUMENT_BASE_CHANGED" }));
    expect(editor.getForEditor(resourceId)).toMatchObject({
      content: "版本二",
      workingRevision: 0,
      dirty: false,
    });
  });

  it("blocks stable publication when the draft base version is no longer current", () => {
    const workspace = openTracked(createRoot());
    const resourceId = getWorldResourceId(workspace);
    const checkpoints = new CheckpointRepository(workspace);
    const documents = new DocumentRepository(workspace);
    documents.putVersion({
      resourceId,
      checkpointId: checkpoints.getActiveBranch().headCheckpointId,
      content: "版本一",
      authorKind: "user",
    });
    const editor = new DocumentEditorService(workspace);
    editor.saveWorkingCopy({
      resourceId,
      content: "基于版本一的草稿",
      expectedRevision: 0,
      expectedStableVersionId: editor.getForEditor(resourceId).stableVersionId,
    });

    const branch = checkpoints.getActiveBranch();
    const externalCheckpoint = checkpoints.appendCheckpoint(branch.id, "External stable update");
    documents.putVersion({
      resourceId,
      checkpointId: externalCheckpoint,
      content: "版本二",
      authorKind: "agent",
    });

    expect(() => editor.saveStable({ resourceId, expectedRevision: 1 }))
      .toThrowError(expect.objectContaining({ code: "DOCUMENT_BASE_CHANGED" }));
    expect(editor.getStableForAgent(resourceId)?.content).toBe("版本二");
    expect(editor.getForEditor(resourceId)).toMatchObject({ content: "基于版本一的草稿", dirty: true });
  });

  it("rolls back the checkpoint when stable version insertion fails", () => {
    const workspace = openTracked(createRoot());
    const resourceId = getWorldResourceId(workspace);
    const editor = new DocumentEditorService(workspace);
    editor.saveWorkingCopy({ resourceId, content: "等待稳定保存", expectedRevision: 0, expectedStableVersionId: null });
    const checkpoints = new CheckpointRepository(workspace);
    const beforeHead = checkpoints.getActiveBranch().headCheckpointId;
    workspace.db.exec(`
      CREATE TRIGGER fail_document_version_insert
      BEFORE INSERT ON document_versions
      BEGIN
        SELECT RAISE(ABORT, 'injected document version failure');
      END;
    `);

    expect(() => editor.saveStable({ resourceId, expectedRevision: 1 }))
      .toThrow("injected document version failure");
    expect(checkpoints.getActiveBranch().headCheckpointId).toBe(beforeHead);
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM document_versions").get()).toMatchObject({ count: 0 });
    expect(editor.getForEditor(resourceId)).toMatchObject({ content: "等待稳定保存", dirty: true });
  });
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-document-editor-"));
  roots.push(root);
  return root;
}

function openTracked(root: string): WorkspaceDatabase {
  const workspace = openWorkspace(root);
  opened.push(workspace);
  return workspace;
}

function closeTracked(workspace: WorkspaceDatabase): void {
  workspace.close();
  opened.splice(opened.indexOf(workspace), 1);
}

function getWorldResourceId(workspace: WorkspaceDatabase): string {
  return new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!.id;
}
