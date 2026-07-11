import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { SemanticGraphService } from "../../src/domain/graph/semanticGraphService";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { commitFixtureCheckpoint } from "../helpers/workspaceFixtures";

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("SemanticGraphService", () => {
  it("projects real current/conflict assertions without inferring relations from prose", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-semantic-graph-"));
    workspace = openWorkspace(root);
    const assertions = new AssertionRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const worldRootId = resources.listCurrent().find((resource) => resource.type === "world")!.id;
    let coastResourceId = "";
    commitFixtureCheckpoint(workspace, {
      idempotencyKey: "semantic-graph-projection",
      summary: "确认银湾海岸图谱事实（C:\\private\\graph.json）",
      label: "建立语义图谱证据",
    }, (checkpointId, changeSetId) => {
      coastResourceId = resources.putRevision({
        checkpointId,
        type: "world",
        title: "银湾海岸",
        parentId: worldRootId,
        state: "active",
      });
      assertions.putVersion({
        assertionId: "assertion.coast.cause",
        checkpointId,
        scopeType: "world",
        scopeId: worldRootId,
        subject: "沉降纪元",
        predicate: "塑造",
        object: {
          text: "沉降与海水倒灌共同塑造银湾海岸。",
          entityRef: { resourceId: coastResourceId, relation: "影响地点" },
        },
        status: "current",
        source: { kind: "confirmed_change_set", ref: changeSetId },
      });
      assertions.putVersion({
        assertionId: "assertion.coast.conflict",
        checkpointId,
        scopeType: "world",
        scopeId: worldRootId,
        subject: "银湾海岸",
        predicate: "古代成因",
        object: { text: "现有资料对古代成因存在冲突。" },
        status: "conflict",
        source: { kind: "confirmed_change_set", ref: changeSetId },
      });
      assertions.putVersion({
        assertionId: "assertion.no-inference",
        checkpointId,
        scopeType: "world",
        scopeId: worldRootId,
        subject: "航海传闻",
        predicate: "描述",
        object: { text: "水手提到幽灵岛，但没有登记任何实体引用。" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: changeSetId },
      });
    });

    const service = new SemanticGraphService(workspace);
    const snapshot = service.getSnapshot();

    expect(snapshot.lens).toEqual({
      type: "creator",
      label: "创作者视角",
      characterLensAvailable: false,
      limitation: "角色认知视角尚未实现。",
    });
    expect(snapshot.nodes.filter((node) => node.kind === "fact")).toHaveLength(3);
    expect(snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "subject", label: "沉降纪元", semanticType: "concept" }),
      expect.objectContaining({ kind: "entity", label: "银湾海岸", semanticType: "world" }),
      expect.objectContaining({ kind: "fact", label: "银湾海岸 · 古代成因", status: "conflict", conflict: true }),
    ]));
    expect(snapshot.edges.filter((edge) => edge.kind === "predicate")).toHaveLength(3);
    expect(snapshot.edges.filter((edge) => edge.kind === "entity_reference")).toEqual([
      expect.objectContaining({ label: "影响地点" }),
    ]);
    expect(snapshot.nodes.some((node) => node.label === "幽灵岛")).toBe(false);

    const fact = snapshot.nodes.find((node) => node.kind === "fact" && node.label === "沉降纪元 · 塑造")!;
    const inspector = service.inspectNode(fact.id);
    expect(inspector.detail).toMatchObject({
      kind: "fact",
      subject: "沉降纪元",
      predicate: "塑造",
      valueSummary: "沉降与海水倒灌共同塑造银湾海岸。",
      status: "current",
      sources: [{ type: "change_set", label: "已确认变更：确认银湾海岸图谱事实（[本地路径已隐藏]）" }],
    });
    expect(inspector.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "outgoing", label: "影响地点", neighborLabel: "银湾海岸" }),
    ]));
    expect(JSON.stringify({ snapshot, inspector }))
      .not.toMatch(/"(?:rawRef|ref|path|locator|checkpointId|payload|databasePath)"|workspace\.db/i);
    expect(JSON.stringify({ snapshot, inspector })).not.toContain("C:\\private");
    expect(() => service.inspectNode("unknown-node")).toThrow(expect.objectContaining({ code: "GRAPH_NODE_NOT_FOUND" }));
  });

  it("drops assertion versions that only exist in an archived future", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-semantic-graph-rollback-"));
    workspace = openWorkspace(root);
    const assertions = new AssertionRepository(workspace);
    const checkpoints = new CheckpointRepository(workspace);
    const worldRootId = new ResourceRepository(workspace).listCurrent()
      .find((resource) => resource.type === "world")!.id;
    const beforeFuture = commitFixtureCheckpoint(workspace, {
      idempotencyKey: "semantic-before-future",
      summary: "确认旧海岸事实",
      label: "旧海岸事实",
    }, (checkpointId, changeSetId) => {
      assertions.putVersion({
        assertionId: "assertion.rollback.graph",
        checkpointId,
        scopeType: "world",
        scopeId: worldRootId,
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { text: "古冰川切割" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: changeSetId },
      });
    });
    commitFixtureCheckpoint(workspace, {
      idempotencyKey: "semantic-future",
      summary: "未来海岸修订",
      label: "未来海岸修订",
    }, (checkpointId, changeSetId) => {
      assertions.putVersion({
        assertionId: "assertion.rollback.graph",
        checkpointId,
        scopeType: "world",
        scopeId: worldRootId,
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { text: "沉降纪元与海水倒灌" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: changeSetId },
      });
    });

    checkpoints.restoreFromCheckpoint(beforeFuture.checkpointId, "回到旧海岸事实");
    const snapshot = new SemanticGraphService(workspace).getSnapshot();

    expect(snapshot.nodes.find((node) => node.kind === "fact")?.description).toBe("古冰川切割");
    expect(JSON.stringify(snapshot)).not.toContain("沉降纪元与海水倒灌");
    expect(JSON.stringify(snapshot)).not.toContain("未来海岸修订");
  });
});
