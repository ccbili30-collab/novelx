import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { SemanticGraphService } from "../../src/domain/graph/semanticGraphService";
import { CausalRelationRepository } from "../../src/domain/graph/causalRelationRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
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

  it("projects source-bound causal edges with safe mechanism and epistemic metadata", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-semantic-causal-"));
    workspace = openWorkspace(root);
    const assertions = new AssertionRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const causal = new CausalRelationRepository(workspace);
    const worldRootId = new ResourceRepository(workspace).listCurrent()
      .find((resource) => resource.type === "world")!.id;
    commitFixtureCheckpoint(workspace, {
      idempotencyKey: "semantic-causal-projection",
      summary: "确认月潮因果边",
      label: "建立因果图谱",
    }, (checkpointId) => {
      const documentVersionId = documents.putVersion({
        resourceId: worldRootId,
        checkpointId,
        content: "月潮增强会改变浅滩可航窗口，迫使商路北移。",
        authorKind: "user",
      });
      for (const [assertionId, subject, predicate] of [
        ["assertion.semantic.tide", "月潮", "增强"],
        ["assertion.semantic.route", "商路", "北移"],
      ] as const) {
        assertions.putVersion({
          assertionId,
          checkpointId,
          scopeType: "world",
          scopeId: worldRootId,
          subject,
          predicate,
          object: { text: `${subject}${predicate}` },
          status: "current",
          source: { kind: "document_version", ref: documentVersionId },
        });
      }
      workspace!.db.prepare("INSERT INTO source_records (id, kind, ref, created_at) VALUES (?, 'document_version', ?, ?)")
        .run("source.semantic.causal", documentVersionId, "2026-07-18T00:00:00.000Z");
      causal.putVersion({
        versionId: "causal-version.semantic.route",
        checkpointId,
        status: "current",
        idempotencyKey: "semantic-causal-projection",
        relation: {
          id: "relation.semantic.tide-route",
          kind: "causes",
          causeAssertionId: "assertion.semantic.tide",
          effectAssertionId: "assertion.semantic.route",
          mechanism: "潮差改变浅滩可航窗口。",
          conditions: ["强月潮"],
          temporalScope: "涨潮后三小时",
          polarityStrengthSummary: "强正向",
          epistemicStatus: "inferred",
          sourceReferences: [{
            sourceId: "source.semantic.causal",
            sourceKind: "document",
            sourceVersionId: documentVersionId,
            stableLocator: "paragraph:1",
            sourceSha256: documents.getVersion(documentVersionId)!.contentHash,
          }],
        },
      });
    });

    const service = new SemanticGraphService(workspace);
    const edge = service.getSnapshot().edges.find((candidate) => candidate.kind === "causal");
    expect(edge).toMatchObject({
      kind: "causal",
      relationKind: "causes",
      label: "导致",
      mechanismSummary: "潮差改变浅滩可航窗口。",
      epistemicStatus: "inferred",
      status: "current",
      sourceReferences: [{ kind: "document", locator: "paragraph:1" }],
    });
    if (!edge) throw new Error("Expected causal edge.");
    const inspector = service.inspectNode(edge.sourceNodeId);
    expect(inspector.relations).toContainEqual(expect.objectContaining({
      edgeId: edge.id,
      direction: "outgoing",
      causal: expect.objectContaining({
        mechanismSummary: "潮差改变浅滩可航窗口。",
        epistemicStatus: "inferred",
        sourceReferences: [expect.objectContaining({ locator: "paragraph:1" })],
      }),
    }));
    expect(JSON.stringify({ edge, inspector })).not.toMatch(/source\.semantic\.causal|sourceSha256|workspace\.db/);
  });
});
