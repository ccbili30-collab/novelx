import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceChangeSetPolicy } from "../../src/domain/changeSet/workspaceChangeSetPolicy";
import type { ChangeSetCandidate } from "../../src/domain/changeSet/changeSetService";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let root: string | null = null;
let workspace: WorkspaceDatabase | null = null;

afterEach(() => {
  workspace?.close();
  workspace = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("WorkspaceChangeSetPolicy", () => {
  it("allows a sourced new assertion but blocks missing evidence and contradictory values", () => {
    const setup = createWorkspaceEvidence();
    const policy = new WorkspaceChangeSetPolicy(setup.workspace);
    const sourced = policy.assess(candidate(assertionItem("new-coast", setup.worldId, setup.documentVersionId, {
      cause: "差异侵蚀与海水倒灌",
    })));
    expect(sourced).toEqual([{ itemId: "new-coast", risk: "low", conflicts: [] }]);

    const missing = policy.assess(candidate(assertionItem("missing-source", setup.worldId, "not-active", {
      cause: "无来源",
    })));
    expect(missing[0]).toMatchObject({
      risk: "elevated",
      conflicts: [{ severity: "major", code: "ASSERTION_EVIDENCE_NOT_ACTIVE" }],
    });
    const orphaned = policy.assess(candidate(assertionItem("orphaned", "world.not-active", setup.documentVersionId, {
      cause: "孤立范围",
    })));
    expect(orphaned[0].conflicts).toContainEqual({ severity: "major", code: "ASSERTION_SCOPE_NOT_ACTIVE" });

    new AssertionRepository(setup.workspace).putVersion({
      assertionId: "assertion.current-coast",
      checkpointId: setup.headCheckpointId,
      scopeType: "world",
      scopeId: setup.worldId,
      subject: "银湾海岸",
      predicate: "形成原因",
      object: { cause: "古海侵" },
      status: "current",
      source: { kind: "document_version", ref: setup.documentVersionId },
    });
    const conflicting = policy.assess(candidate(assertionItem("conflict-coast", setup.worldId, setup.documentVersionId, {
      cause: "帝国开凿",
    })));
    expect(conflicting[0].conflicts).toContainEqual({ severity: "major", code: "ASSERTION_VALUE_CONFLICT" });
  });

  it("allows valid Free content writes while keeping destructive resource changes elevated", () => {
    const setup = createWorkspaceEvidence();
    const policy = new WorkspaceChangeSetPolicy(setup.workspace);
    const assessments = policy.assess(candidate([
      {
        id: "new-resource",
        dependsOn: [],
        kind: "resource.put",
        payload: {
          resourceId: "location.silver-bay",
          create: true,
          type: "world",
          title: "银湾海岸",
          parentId: setup.worldId,
          state: "active",
          sortOrder: 10,
        },
      },
      {
        id: "rewrite-document",
        dependsOn: [],
        kind: "document.put",
        payload: { resourceId: setup.worldId, content: "改写正文", authorKind: "agent" },
      },
      {
        id: "delete-world",
        dependsOn: [],
        kind: "resource.put",
        payload: {
          resourceId: setup.worldId,
          create: false,
          type: "world",
          title: "世界",
          parentId: null,
          state: "deleted",
          sortOrder: 0,
        },
      },
    ]));

    expect(assessments).toEqual([
      { itemId: "new-resource", risk: "low", conflicts: [] },
      { itemId: "rewrite-document", risk: "low", conflicts: [] },
      { itemId: "delete-world", risk: "elevated", conflicts: [] },
    ]);
  });

  it("allows same-Change-Set resource hierarchy only through explicit dependencies", () => {
    const setup = createWorkspaceEvidence();
    const policy = new WorkspaceChangeSetPolicy(setup.workspace);
    const baseItems: ChangeSetCandidate["items"] = [
      {
        id: "create-region",
        dependsOn: [],
        kind: "resource.put",
        payload: {
          resourceId: "region.silver-bay",
          create: true,
          type: "world",
          title: "银湾地区",
          parentId: setup.worldId,
          state: "active",
          sortOrder: 1,
        },
      },
      {
        id: "create-coast",
        dependsOn: ["create-region"],
        kind: "resource.put",
        payload: {
          resourceId: "location.silver-bay-coast",
          create: true,
          type: "world",
          title: "银湾海岸",
          parentId: "region.silver-bay",
          state: "active",
          sortOrder: 2,
        },
      },
      {
        ...assertionItem("coast-fact", "location.silver-bay-coast", setup.documentVersionId, { cause: "差异侵蚀" }),
        dependsOn: ["create-coast"],
      },
    ];

    expect(policy.assess(candidate(baseItems))).toEqual([
      { itemId: "create-region", risk: "low", conflicts: [] },
      { itemId: "create-coast", risk: "low", conflicts: [] },
      { itemId: "coast-fact", risk: "low", conflicts: [] },
    ]);
    const missingDependency = baseItems.map((item) => item.id === "create-coast" ? { ...item, dependsOn: [] } : item);
    expect(policy.assess(candidate(missingDependency))[1].conflicts)
      .toContainEqual({ severity: "major", code: "RESOURCE_PARENT_NOT_ACTIVE" });
  });
});

function createWorkspaceEvidence() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-change-policy-"));
  workspace = openWorkspace(root);
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
  const documentVersionId = new DocumentRepository(workspace).putVersion({
    resourceId: world.id,
    checkpointId: branch.headCheckpointId,
    content: "银湾海岸由沉降、侵蚀与海水倒灌共同形成。",
    authorKind: "user",
  });
  return {
    workspace,
    worldId: world.id,
    documentVersionId,
    headCheckpointId: branch.headCheckpointId,
  };
}

function candidate(items: ChangeSetCandidate["items"][number] | ChangeSetCandidate["items"]): ChangeSetCandidate {
  return { mode: "free", summary: "测试策略", items: Array.isArray(items) ? items : [items] };
}

function assertionItem(
  id: string,
  scopeId: string,
  evidenceId: string,
  object: Record<string, string>,
): ChangeSetCandidate["items"][number] {
  return {
    id,
    dependsOn: [],
    kind: "assertion.put",
    payload: {
      assertionId: `assertion.${id}`,
      scopeType: "world",
      scopeId,
      subject: "银湾海岸",
      predicate: "形成原因",
      object,
      evidenceIds: [evidenceId],
      status: "current",
      source: { kind: "agent_candidate", ref: `test:${id}` },
    },
  };
}
