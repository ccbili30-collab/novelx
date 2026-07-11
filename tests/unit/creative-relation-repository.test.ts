import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { CreativeRelationRepository } from "../../src/domain/workspace/creativeRelationRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("creative relation repository", () => {
  it("versions story references and OC variant origins on the checkpoint chain", () => {
    const workspace = createWorkspace();
    const resources = new ResourceRepository(workspace);
    const relations = new CreativeRelationRepository(workspace);
    const changes = new ChangeSetRepository(workspace);
    const rootsByDomain = new Map(resources.listCurrent().map((resource) => [resource.type, resource]));
    let worldId = "";
    let ocId = "";
    let storyId = "";
    let variantId = "";

    const objects = changes.propose({ idempotencyKey: "relation-objects", mode: "free", summary: "创建关系对象" });
    changes.commit(objects.id, "创建关系对象", (checkpointId) => {
      worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "潮汐世界", parentId: rootsByDomain.get("world")!.id, state: "active" });
      ocId = resources.putRevision({ checkpointId, type: "oc", objectKind: "oc", title: "槐", parentId: rootsByDomain.get("oc")!.id, state: "active" });
      storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "潮痕", parentId: rootsByDomain.get("story")!.id, state: "active" });
      variantId = resources.putRevision({ checkpointId, type: "story", objectKind: "oc_variant", title: "槐·潮痕", parentId: storyId, state: "active" });
    });

    const references = changes.propose({ idempotencyKey: "story-references", mode: "free", summary: "组合世界与角色" });
    let worldRelationId = "";
    changes.commit(references.id, "组合故事素材", (checkpointId) => {
      worldRelationId = relations.putRevision({ checkpointId, kind: "uses_world", sourceResourceId: storyId, targetResourceId: worldId, state: "active" });
      relations.putRevision({ checkpointId, kind: "uses_oc", sourceResourceId: storyId, targetResourceId: ocId, state: "active" });
      relations.putRevision({ checkpointId, kind: "variant_of", sourceResourceId: variantId, targetResourceId: ocId, state: "active" });
    });

    expect(relations.listCurrent()).toMatchObject([
      { kind: "uses_world", sourceResourceId: storyId, targetResourceId: worldId },
      { kind: "uses_oc", sourceResourceId: storyId, targetResourceId: ocId },
      { kind: "variant_of", sourceResourceId: variantId, targetResourceId: ocId },
    ]);
    expect(relations.listIncoming(ocId)).toHaveLength(2);

    const blockedDelete = changes.propose({ idempotencyKey: "blocked-oc-delete", mode: "free", summary: "验证引用删除阻塞" });
    changes.commit(blockedDelete.id, "验证引用删除阻塞", (checkpointId) => {
      expect(() => resources.putRevision({
        resourceId: ocId,
        checkpointId,
        type: "oc",
        objectKind: "oc",
        title: "槐",
        parentId: rootsByDomain.get("oc")!.id,
        state: "deleted",
      })).toThrowError(expect.objectContaining({ code: "RESOURCE_RELATIONS_ACTIVE" }));
    });

    const remove = changes.propose({ idempotencyKey: "remove-world-reference", mode: "free", summary: "移除世界引用" });
    changes.commit(remove.id, "移除世界引用", (checkpointId) => {
      relations.putRevision({
        relationId: worldRelationId,
        checkpointId,
        kind: "uses_world",
        sourceResourceId: storyId,
        targetResourceId: worldId,
        state: "deleted",
      });
    });
    expect(relations.listCurrent().map((relation) => relation.kind)).toEqual(["uses_oc", "variant_of"]);
  });

  it("rejects invalid endpoints and duplicate active relations", () => {
    const workspace = createWorkspace();
    const resources = new ResourceRepository(workspace);
    const relations = new CreativeRelationRepository(workspace);
    const changes = new ChangeSetRepository(workspace);
    const rootsByDomain = new Map(resources.listCurrent().map((resource) => [resource.type, resource]));
    let worldId = "";
    let ocId = "";
    let storyId = "";

    const objects = changes.propose({ idempotencyKey: "invalid-relation-objects", mode: "free", summary: "创建校验对象" });
    changes.commit(objects.id, "创建校验对象", (checkpointId) => {
      worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "世界", parentId: rootsByDomain.get("world")!.id, state: "active" });
      ocId = resources.putRevision({ checkpointId, type: "oc", objectKind: "oc", title: "角色", parentId: rootsByDomain.get("oc")!.id, state: "active" });
      storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "故事", parentId: rootsByDomain.get("story")!.id, state: "active" });
    });

    const invalid = changes.propose({ idempotencyKey: "invalid-relations", mode: "free", summary: "验证关系约束" });
    changes.commit(invalid.id, "验证关系约束", (checkpointId) => {
      expect(() => relations.putRevision({ checkpointId, kind: "uses_world", sourceResourceId: ocId, targetResourceId: worldId, state: "active" }))
        .toThrowError(expect.objectContaining({ code: "RELATION_SOURCE_KIND_INVALID" }));
      relations.putRevision({ checkpointId, kind: "uses_oc", sourceResourceId: storyId, targetResourceId: ocId, state: "active" });
      expect(() => relations.putRevision({ checkpointId, kind: "uses_oc", sourceResourceId: storyId, targetResourceId: ocId, state: "active" }))
        .toThrowError(expect.objectContaining({ code: "RELATION_DUPLICATE" }));
    });
  });
});

function createWorkspace(): WorkspaceDatabase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-relations-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  return workspace;
}
