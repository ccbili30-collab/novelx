import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreativeWorkspaceService } from "../../src/domain/workspace/creativeWorkspaceService";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("manual creative workspace service", () => {
  it("puts manual objects, documents, relations, and constraints on one checkpoint chain", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-manual-creative-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    opened.push(workspace);
    const service = new CreativeWorkspaceService(workspace);
    const resources = new ResourceRepository(workspace);

    service.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "潮汐世界", parentId: null });
    service.mutate({ action: "create_resource", domain: "oc", objectKind: "oc", title: "槐", parentId: null });
    service.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "潮痕", parentId: null });
    const world = resources.listVisibleCurrent().find((resource) => resource.title === "潮汐世界")!;
    const oc = resources.listVisibleCurrent().find((resource) => resource.title === "槐")!;
    const story = resources.listVisibleCurrent().find((resource) => resource.title === "潮痕")!;

    service.mutate({ action: "create_document", resourceId: story.id, kind: "prose", title: "正文" });
    service.mutate({ action: "create_relation", kind: "uses_world", sourceResourceId: story.id, targetResourceId: world.id });
    service.mutate({ action: "create_relation", kind: "uses_oc", sourceResourceId: story.id, targetResourceId: oc.id });
    service.mutate({
      action: "create_constraint",
      scopeResourceId: story.id,
      title: "故事风格",
      payload: { narrativePerson: "third", tense: "past", tone: "轻快", pacing: "紧凑", humorLevel: 3, prohibitedContent: [], requiredContent: ["遵守世界规则"], notes: "" },
    });

    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM creative_document_revisions").get()).toEqual({ count: 4 });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM creative_relation_versions").get()).toEqual({ count: 2 });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM constraint_profile_versions").get()).toEqual({ count: 1 });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM checkpoints").get()).toEqual({ count: 8 });
  });
});
