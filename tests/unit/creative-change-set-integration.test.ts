import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { ChangeSetService } from "../../src/domain/changeSet/changeSetService";
import { WorkspaceChangeSetPolicy } from "../../src/domain/changeSet/workspaceChangeSetPolicy";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ConstraintProfileRepository } from "../../src/domain/workspace/constraintProfileRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../../src/domain/workspace/creativeRelationRepository";
import { CreativeWorkspaceService } from "../../src/domain/workspace/creativeWorkspaceService";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("creative Change Set integration", () => {
  it("atomically commits Agent-created objects, relations, documents, content, and constraints", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-creative-change-set-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    opened.push(workspace);
    const resources = new ResourceRepository(workspace);
    const rootsByDomain = new Map(resources.listCurrent().map((resource) => [resource.type, resource]));
    const head = workspace.db.prepare("SELECT head_checkpoint_id FROM branches WHERE status = 'open'").get() as { head_checkpoint_id: string };
    const service = new ChangeSetService(workspace, new WorkspaceChangeSetPolicy(workspace));

    const result = service.propose({
      idempotencyKey: "agent-creative-composition",
      expectedHeadCheckpointId: head.head_checkpoint_id,
      mode: "free",
      summary: "创建世界、角色、故事和写作约束",
      items: [
        { id: "world", kind: "resource.put", dependsOn: [], payload: { resourceId: "world-tide", create: true, type: "world", objectKind: "world", title: "潮汐世界", parentId: rootsByDomain.get("world")!.id, state: "active", sortOrder: 0 } },
        { id: "oc", kind: "resource.put", dependsOn: [], payload: { resourceId: "oc-huai", create: true, type: "oc", objectKind: "oc", title: "槐", parentId: rootsByDomain.get("oc")!.id, state: "active", sortOrder: 0 } },
        { id: "story", kind: "resource.put", dependsOn: [], payload: { resourceId: "story-tide", create: true, type: "story", objectKind: "story", title: "潮痕", parentId: rootsByDomain.get("story")!.id, state: "active", sortOrder: 0 } },
        { id: "variant", kind: "resource.put", dependsOn: ["story"], payload: { resourceId: "variant-huai", create: true, type: "story", objectKind: "oc_variant", title: "槐·潮痕", parentId: "story-tide", state: "active", sortOrder: 0 } },
        { id: "doc", kind: "creative_document.put", dependsOn: ["story"], payload: { documentId: "doc-main", create: true, resourceId: "story-tide", kind: "prose", title: "正文", state: "active", sortOrder: 0 } },
        { id: "content", kind: "document.put", dependsOn: ["doc"], payload: { resourceId: "story-tide", creativeDocumentId: "doc-main", content: "潮声从旧城下醒来。", authorKind: "agent" } },
        { id: "world-ref", kind: "creative_relation.put", dependsOn: ["world", "story"], payload: { relationId: "relation-world", create: true, relationKind: "uses_world", sourceResourceId: "story-tide", targetResourceId: "world-tide", state: "active" } },
        { id: "oc-ref", kind: "creative_relation.put", dependsOn: ["oc", "story"], payload: { relationId: "relation-oc", create: true, relationKind: "uses_oc", sourceResourceId: "story-tide", targetResourceId: "oc-huai", state: "active" } },
        { id: "variant-ref", kind: "creative_relation.put", dependsOn: ["oc", "variant"], payload: { relationId: "relation-variant", create: true, relationKind: "variant_of", sourceResourceId: "variant-huai", targetResourceId: "oc-huai", state: "active" } },
        { id: "style", kind: "constraint_profile.put", dependsOn: ["story"], payload: {
          profileId: "style-story", create: true, scopeResourceId: "story-tide", title: "故事风格",
          profile: { narrativePerson: "third", tense: "past", tone: "轻快诙谐", pacing: "紧凑", humorLevel: 4, prohibitedContent: ["无来源复活"], requiredContent: ["遵守世界规则"], notes: "笑点不能破坏人物一致性。" },
          state: "active", authorKind: "agent",
        } },
      ],
    });

    expect(result.status).toBe("committed");
    expect(new CreativeDocumentRepository(workspace).getCurrent("doc-main")).toMatchObject({ resourceId: "story-tide", kind: "prose" });
    expect(new DocumentRepository(workspace).getCurrentStableForCreativeDocument("doc-main")?.content).toBe("潮声从旧城下醒来。");
    expect(new CreativeRelationRepository(workspace).listCurrent()).toHaveLength(3);
    expect(new ConstraintProfileRepository(workspace).getCurrent("style-story")?.payload.tone).toBe("轻快诙谐");
    expect(new ChangeSetRepository(workspace).listOutputs(result.id).map((output) => output.kind))
      .toEqual(expect.arrayContaining([
        "resource_revision",
        "creative_document_revision",
        "document_version",
        "creative_relation_revision",
        "constraint_profile_version",
      ]));
  });

  it("keeps manual and Agent changes on one checkpoint ancestry and restores the manual state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-shared-version-chain-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    opened.push(workspace);
    const manual = new CreativeWorkspaceService(workspace);
    const resources = new ResourceRepository(workspace);
    const checkpoints = new CheckpointRepository(workspace);

    manual.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "手写故事", parentId: null });
    const story = resources.listVisibleCurrent().find((resource) => resource.title === "手写故事")!;
    const manualHead = checkpoints.getActiveBranch().headCheckpointId;

    const agent = new ChangeSetService(workspace, new WorkspaceChangeSetPolicy(workspace));
    const proposal = agent.propose({
      idempotencyKey: "agent-after-manual-checkpoint",
      expectedHeadCheckpointId: manualHead,
      mode: "assist",
      summary: "Agent 修改手写故事标题",
      items: [{
        id: "rename-story",
        kind: "resource.put",
        dependsOn: [],
        payload: {
          resourceId: story.id,
          create: false,
          type: "story",
          objectKind: "story",
          title: "Agent 修改后的故事",
          parentId: story.parentId,
          state: "active",
          sortOrder: 0,
        },
      }],
    });

    expect(proposal.status).toBe("pending");
    agent.decideItem(proposal.id, "rename-story", "accepted");
    const result = agent.finalizeAssist(proposal.id, {
      expectedHeadCheckpointId: manualHead,
      label: "接受 Agent 标题修改",
    });
    expect(result.status).toBe("committed");
    const agentHead = checkpoints.getActiveBranch().headCheckpointId;
    expect(agentHead).not.toBe(manualHead);
    expect(workspace.db.prepare("SELECT parent_checkpoint_id FROM checkpoints WHERE id = ?").get(agentHead))
      .toEqual({ parent_checkpoint_id: manualHead });
    expect(resources.getCurrent(story.id)?.title).toBe("Agent 修改后的故事");

    checkpoints.restoreFromCheckpoint(manualHead, "回溯手写版本");
    expect(resources.getCurrent(story.id)?.title).toBe("手写故事");
    expect(checkpoints.getActiveBranch().headCheckpointId).toBe(manualHead);
  });
});
