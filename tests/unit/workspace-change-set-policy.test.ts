import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceChangeSetPolicy } from "../../src/domain/changeSet/workspaceChangeSetPolicy";
import {
  classifyGreenfieldCreateOnlyCandidate,
  greenfieldDocumentOutputEvidence,
  isGreenfieldCreateOnlyCandidate,
  type ChangeSetCandidate,
} from "../../src/domain/changeSet/changeSetService";
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

  it("allows a blank Free create-only Change Set to source assertions from its dependent document output", () => {
    const setup = createBlankWorkspace();
    const worldRoot = new ResourceRepository(setup.workspace).listCurrent().find((resource) => resource.type === "world")!;
    const items = greenfieldCandidateItems(worldRoot.id);

    expect(new WorkspaceChangeSetPolicy(setup.workspace).assess(candidate(items, true))).toEqual([
      { itemId: "create-world", risk: "low", conflicts: [] },
      { itemId: "world-document", risk: "low", conflicts: [] },
      { itemId: "world-assertion", risk: "low", conflicts: [] },
    ]);
  });

  it("classifies every Greenfield structural violation without changing the create-only truth value", () => {
    const item = (kind: string, payload: Record<string, unknown>, dependsOn: string[] = []) => ({ id: `${kind}-${dependsOn.length}`, kind, payload, dependsOn });
    const resource = (id = "resource", create = true, state = "active", objectKind = "world") =>
      item("resource.put", { resourceId: id, create, state, objectKind });
    const document = (dependsOn: string[], resourceId = "resource") => item("document.put", { resourceId }, dependsOn);
    const assertion = (dependsOn: string[], evidenceIds: string[] = []) => item("assertion.put", { scopeId: "resource", evidenceIds }, dependsOn);
    const creativeDocument = (dependsOn: string[], resourceId = "resource", create = true, state = "active") =>
      item("creative_document.put", { documentId: "creative", resourceId, create, state }, dependsOn);
    const relation = (dependsOn: string[], sourceResourceId = "source", targetResourceId = "target") =>
      item("creative_relation.put", { sourceResourceId, targetResourceId, create: true, state: "active" }, dependsOn);
    const constraint = (dependsOn: string[], scopeResourceId = "resource") =>
      item("constraint_profile.put", { scopeResourceId, create: true, state: "active" }, dependsOn);
    const cases: Array<[string, unknown[]]> = [
      ["GREENFIELD_RESOURCE_CREATE_REQUIRED", [resource("resource", false)]],
      ["GREENFIELD_DOMAIN_ROOT_FORBIDDEN", [resource("resource", true, "active", "domain_root")]],
      ["GREENFIELD_CREATIVE_CREATE_REQUIRED", [creativeDocument([], "resource", false)]],
      ["GREENFIELD_PROJECT_FILE_MUTATION_FORBIDDEN", [item("project_file.put", {})]],
      ["GREENFIELD_DOCUMENT_TARGET_REQUIRED", [document([])]],
      ["GREENFIELD_DOCUMENT_DEPENDENCY_REQUIRED", [resource(), document([])]],
      ["GREENFIELD_ASSERTION_SCOPE_REQUIRED", [assertion([])]],
      ["GREENFIELD_ASSERTION_EVIDENCE_REQUIRED", [resource(), document(["resource.put-0"]), assertion(["resource.put-0", "document.put-1"], ["bad-evidence"])]],
      ["GREENFIELD_CREATIVE_DOCUMENT_OWNER_REQUIRED", [creativeDocument([])]],
      ["GREENFIELD_CREATIVE_DOCUMENT_DEPENDENCY_REQUIRED", [resource(), creativeDocument([])]],
      ["GREENFIELD_RELATION_ENDPOINT_REQUIRED", [relation([])]],
      ["GREENFIELD_RELATION_DEPENDENCY_REQUIRED", [resource("source"), resource("target"), relation([])]],
      ["GREENFIELD_CONSTRAINT_SCOPE_REQUIRED", [resource(), constraint([])]],
    ];
    for (const [expected, items] of cases) {
      const candidate = items as unknown as ChangeSetCandidate["items"];
      expect(classifyGreenfieldCreateOnlyCandidate(candidate)).toBe(expected);
      expect(isGreenfieldCreateOnlyCandidate(candidate)).toBe(false);
    }
    const valid = greenfieldCandidateItems("world-root");
    expect(classifyGreenfieldCreateOnlyCandidate(valid)).toBeNull();
    expect(isGreenfieldCreateOnlyCandidate(valid)).toBe(true);
  });

  it("does not accept the Greenfield document-output exception without Main authorization", () => {
    const setup = createBlankWorkspace();
    const worldRoot = new ResourceRepository(setup.workspace).listCurrent().find((resource) => resource.type === "world")!;

    expect(new WorkspaceChangeSetPolicy(setup.workspace).assess(candidate(greenfieldCandidateItems(worldRoot.id)))[2].conflicts)
      .toContainEqual({ severity: "major", code: "ASSERTION_EVIDENCE_NOT_ACTIVE" });
  });

  it("does not accept the Greenfield document-output exception when a stable root document exists", () => {
    const setup = createBlankWorkspace();
    const worldRoot = new ResourceRepository(setup.workspace).listCurrent().find((resource) => resource.type === "world")!;
    new DocumentRepository(setup.workspace).putVersion({
      resourceId: worldRoot.id,
      checkpointId: new CheckpointRepository(setup.workspace).getActiveBranch().headCheckpointId,
      content: "已有稳定根文档。",
      authorKind: "user",
    });
    expect(new WorkspaceChangeSetPolicy(setup.workspace).assess(candidate(greenfieldCandidateItems(worldRoot.id), true))[2].conflicts)
      .toContainEqual({ severity: "major", code: "ASSERTION_EVIDENCE_NOT_ACTIVE" });
  });

  it("does not accept the Greenfield document-output exception when a root working document exists", () => {
    const setup = createBlankWorkspace();
    const worldRoot = new ResourceRepository(setup.workspace).listCurrent().find((resource) => resource.type === "world")!;
    new DocumentRepository(setup.workspace).saveWorkingCopy({ resourceId: worldRoot.id, content: "已有根工作副本。" });
    expect(new WorkspaceChangeSetPolicy(setup.workspace).assess(candidate(greenfieldCandidateItems(worldRoot.id), true))[2].conflicts)
      .toContainEqual({ severity: "major", code: "ASSERTION_EVIDENCE_NOT_ACTIVE" });
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

function createBlankWorkspace() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-change-policy-greenfield-"));
  const created = openWorkspace(root);
  workspace = created;
  return { workspace: created };
}

function candidate(
  items: ChangeSetCandidate["items"][number] | ChangeSetCandidate["items"],
  greenfieldCreateAuthorized = false,
): ChangeSetCandidate {
  return {
    mode: "free",
    summary: "测试策略",
    items: Array.isArray(items) ? items : [items],
    greenfieldCreateAuthorized,
  };
}

function greenfieldCandidateItems(worldRootId: string): ChangeSetCandidate["items"] {
  return [
    {
      id: "create-world",
      dependsOn: [],
      kind: "resource.put",
      payload: {
        resourceId: "world.greenfield",
        create: true,
        type: "world",
        objectKind: "world",
        title: "雾港群岛",
        parentId: worldRootId,
        state: "active",
        sortOrder: 1,
      },
    },
    {
      id: "world-document",
      dependsOn: ["create-world"],
      kind: "document.put",
      payload: { resourceId: "world.greenfield", content: "群岛受月潮影响。", authorKind: "agent" },
    },
    {
      id: "world-assertion",
      dependsOn: ["create-world", "world-document"],
      kind: "assertion.put",
      payload: {
        assertionId: "assertion.greenfield.moon-tide",
        scopeType: "world",
        scopeId: "world.greenfield",
        subject: "月潮",
        predicate: "影响",
        object: { target: "群岛航线" },
        evidenceIds: [greenfieldDocumentOutputEvidence("world-document")],
        status: "current",
      },
    },
  ];
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
