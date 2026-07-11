import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("creative document repository", () => {
  it("stores multiple versioned documents under one creative object", () => {
    const workspace = createWorkspace();
    const resources = new ResourceRepository(workspace);
    const documents = new CreativeDocumentRepository(workspace);
    const changes = new ChangeSetRepository(workspace);
    const storyRoot = resources.listCurrent().find((resource) => resource.type === "story")!;
    let storyId = "";

    const objectChange = changes.propose({ idempotencyKey: "multi-doc-story", mode: "free", summary: "创建故事" });
    changes.commit(objectChange.id, "创建故事", (checkpointId) => {
      storyId = resources.putRevision({
        checkpointId,
        type: "story",
        objectKind: "story",
        title: "潮痕",
        parentId: storyRoot.id,
        state: "active",
      });
    });

    const documentChange = changes.propose({ idempotencyKey: "multi-doc-create", mode: "free", summary: "创建故事文档" });
    let proseId = "";
    changes.commit(documentChange.id, "创建故事文档", (checkpointId) => {
      proseId = documents.putRevision({
        checkpointId,
        resourceId: storyId,
        kind: "prose",
        title: "正文",
        state: "active",
      });
      documents.putRevision({
        checkpointId,
        resourceId: storyId,
        kind: "knowledge_note",
        title: "潮汐纪年法",
        state: "active",
      });
    });

    expect(documents.listCurrent(storyId)).toMatchObject([
      { id: proseId, resourceId: storyId, kind: "prose", title: "正文" },
      { resourceId: storyId, kind: "knowledge_note", title: "潮汐纪年法" },
    ]);

    const rename = changes.propose({ idempotencyKey: "multi-doc-rename", mode: "free", summary: "重命名知识文档" });
    const note = documents.listCurrent(storyId).find((document) => document.kind === "knowledge_note")!;
    changes.commit(rename.id, "重命名知识文档", (checkpointId) => {
      documents.putRevision({ ...note, documentId: note.id, checkpointId, title: "潮汐历与月相", state: "active" });
    });
    expect(documents.getCurrent(note.id)?.title).toBe("潮汐历与月相");
  });

  it("rejects documents whose kind is incompatible with the owner", () => {
    const workspace = createWorkspace();
    const resources = new ResourceRepository(workspace);
    const documents = new CreativeDocumentRepository(workspace);
    const changes = new ChangeSetRepository(workspace);
    const worldRoot = resources.listCurrent().find((resource) => resource.type === "world")!;
    let worldId = "";
    const objectChange = changes.propose({ idempotencyKey: "world-for-doc", mode: "free", summary: "创建世界" });
    changes.commit(objectChange.id, "创建世界", (checkpointId) => {
      worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "世界", parentId: worldRoot.id, state: "active" });
    });
    const invalid = changes.propose({ idempotencyKey: "invalid-prose-doc", mode: "free", summary: "验证文档种类" });
    changes.commit(invalid.id, "验证文档种类", (checkpointId) => {
      expect(() => documents.putRevision({ checkpointId, resourceId: worldId, kind: "prose", title: "正文", state: "active" }))
        .toThrowError(expect.objectContaining({ code: "DOCUMENT_KIND_OWNER_INVALID" }));
    });
  });
});

function createWorkspace(): WorkspaceDatabase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-creative-documents-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  return workspace;
}
