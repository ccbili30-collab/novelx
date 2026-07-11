import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetService } from "../../src/domain/changeSet/changeSetService";
import { WorkspaceChangeSetPolicy } from "../../src/domain/changeSet/workspaceChangeSetPolicy";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ConstraintProfileRepository } from "../../src/domain/workspace/constraintProfileRepository";
import { CreativeDocumentEditorService } from "../../src/domain/workspace/creativeDocumentEditorService";
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

describe("creative version chain", () => {
  it("restores object tree, relations, prose, and constraints together without promoting an unpublished draft", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-complete-version-chain-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    opened.push(workspace);
    const manual = new CreativeWorkspaceService(workspace);
    const resources = new ResourceRepository(workspace);
    const relations = new CreativeRelationRepository(workspace);
    const constraints = new ConstraintProfileRepository(workspace);
    const editor = new CreativeDocumentEditorService(workspace);
    const checkpoints = new CheckpointRepository(workspace);

    manual.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "群岛世界", parentId: null });
    manual.mutate({ action: "create_resource", domain: "oc", objectKind: "oc", title: "槐", parentId: null });
    manual.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "潮痕", parentId: null });
    const world = resources.listVisibleCurrent().find((item) => item.title === "群岛世界")!;
    const oc = resources.listVisibleCurrent().find((item) => item.title === "槐")!;
    const story = resources.listVisibleCurrent().find((item) => item.title === "潮痕")!;
    const prose = workspace.db.prepare("SELECT document_id FROM creative_document_revisions WHERE resource_id = ? AND kind = 'prose' ORDER BY rowid DESC LIMIT 1").get(story.id) as { document_id: string };
    manual.mutate({ action: "create_relation", kind: "uses_world", sourceResourceId: story.id, targetResourceId: world.id });
    manual.mutate({
      action: "create_constraint",
      scopeResourceId: story.id,
      title: "故事风格",
      payload: { narrativePerson: "third", tense: "past", tone: "轻快", pacing: "紧凑", humorLevel: 3, prohibitedContent: [], requiredContent: ["遵守世界规则"], notes: "手写稳定约束" },
    });
    const firstDraft = editor.saveWorkingCopy({ documentId: prose.document_id, content: "手写稳定正文", expectedRevision: 0, expectedStableVersionId: null });
    editor.saveStable({ documentId: prose.document_id, expectedRevision: firstDraft.workingRevision });
    const manualHead = checkpoints.getActiveBranch().headCheckpointId;
    const manualBranch = checkpoints.getActiveBranch().id;
    const profile = constraints.listCurrent().find((item) => item.scopeResourceId === story.id)!;

    const unpublished = editor.saveWorkingCopy({
      documentId: prose.document_id,
      content: "尚未发布的手写草稿",
      expectedRevision: editor.getForEditor(prose.document_id).workingRevision,
      expectedStableVersionId: editor.getForEditor(prose.document_id).stableVersionId,
    });
    expect(unpublished.dirty).toBe(true);

    const agent = new ChangeSetService(workspace, new WorkspaceChangeSetPolicy(workspace));
    const proposal = agent.propose({
      idempotencyKey: "complete-agent-version-chain",
      expectedHeadCheckpointId: manualHead,
      mode: "assist",
      summary: "Agent 同时修改对象树、关系、正文和约束",
      items: [
        { id: "rename", kind: "resource.put", dependsOn: [], payload: { resourceId: story.id, create: false, type: "story", objectKind: "story", title: "Agent 潮痕", parentId: story.parentId, state: "active", sortOrder: 0 } },
        { id: "volume", kind: "resource.put", dependsOn: ["rename"], payload: { resourceId: "agent-volume", create: true, type: "story", objectKind: "volume", title: "Agent 第一卷", parentId: story.id, state: "active", sortOrder: 0 } },
        { id: "oc-relation", kind: "creative_relation.put", dependsOn: ["rename"], payload: { relationId: "agent-uses-oc", create: true, relationKind: "uses_oc", sourceResourceId: story.id, targetResourceId: oc.id, state: "active" } },
        { id: "prose", kind: "document.put", dependsOn: ["rename"], payload: { resourceId: story.id, creativeDocumentId: prose.document_id, content: "Agent 稳定正文", authorKind: "agent" } },
        { id: "constraint", kind: "constraint_profile.put", dependsOn: ["rename"], payload: { profileId: profile.profileId, create: false, scopeResourceId: story.id, title: profile.title, profile: { ...profile.payload, tone: "冷峻", notes: "Agent 稳定约束" }, state: "active", authorKind: "agent" } },
      ],
    });
    for (const item of proposal.items) agent.decideItem(proposal.id, item.id, "accepted");
    const result = agent.finalizeAssist(proposal.id, { expectedHeadCheckpointId: manualHead, label: "接受 Agent 完整创作修改" });
    expect(result.status).toBe("committed");
    const agentHead = checkpoints.getActiveBranch().headCheckpointId;
    expect(resources.getCurrent(story.id)?.title).toBe("Agent 潮痕");
    expect(resources.listVisibleCurrent().some((item) => item.id === "agent-volume")).toBe(true);
    expect(relations.listCurrent().map((item) => item.kind)).toEqual(expect.arrayContaining(["uses_world", "uses_oc"]));
    expect(new DocumentRepository(workspace).getCurrentStableForCreativeDocument(prose.document_id)?.content).toBe("Agent 稳定正文");
    expect(constraints.getCurrent(profile.profileId)?.payload.tone).toBe("冷峻");
    expect(workspace.db.prepare("SELECT actor_kind, source_change_set_id FROM checkpoints WHERE id = ?").get(agentHead))
      .toEqual({ actor_kind: "agent", source_change_set_id: result.id });

    checkpoints.restoreFromCheckpoint(manualHead, "恢复完整手写版本");
    expect(resources.getCurrent(story.id)?.title).toBe("潮痕");
    expect(resources.listVisibleCurrent().some((item) => item.id === "agent-volume")).toBe(false);
    expect(relations.listCurrent().map((item) => item.kind)).toEqual(["uses_world"]);
    expect(new DocumentRepository(workspace).getCurrentStableForCreativeDocument(prose.document_id)?.content).toBe("手写稳定正文");
    expect(constraints.getCurrent(profile.profileId)?.payload).toMatchObject({ tone: "轻快", notes: "手写稳定约束" });
    expect(editor.getForEditor(prose.document_id)).toMatchObject({ content: "手写稳定正文", hasWorkingCopy: false, dirty: false });
    expect(workspace.db.prepare("SELECT content, dirty FROM working_creative_documents WHERE branch_id = ? AND document_id = ?").get(manualBranch, prose.document_id))
      .toEqual({ content: "尚未发布的手写草稿", dirty: 1 });
    expect(workspace.db.prepare("SELECT actor_kind, source_change_set_id FROM checkpoints WHERE id = ?").get(manualHead))
      .toEqual({ actor_kind: "user", source_change_set_id: null });
  });
});
