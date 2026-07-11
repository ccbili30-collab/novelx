import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetService, type ChangeSetCandidate } from "../../src/domain/changeSet/changeSetService";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ContextPacketService } from "../../src/domain/retrieval/contextPacketService";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { CreativeDocumentEditorService } from "../../src/domain/workspace/creativeDocumentEditorService";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { CreativeWorkspaceService } from "../../src/domain/workspace/creativeWorkspaceService";
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

describe("ContextPacketService", () => {
  it("retrieves every stable Creative Document with a versioned, clickable identity", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-context-creative-documents-"));
    workspace = openWorkspace(root);
    const creative = new CreativeWorkspaceService(workspace);
    creative.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "潮痕", parentId: null });
    const story = new ResourceRepository(workspace).listVisibleCurrent().find((resource) => resource.title === "潮痕")!;
    creative.mutate({ action: "create_document", resourceId: story.id, kind: "knowledge_note", title: "潮汐纪年法" });
    const documents = new CreativeDocumentRepository(workspace).listCurrent(story.id);
    const prose = documents.find((document) => document.kind === "prose")!;
    const knowledge = documents.find((document) => document.title === "潮汐纪年法")!;
    const editor = new CreativeDocumentEditorService(workspace);
    const proseDraft = editor.saveWorkingCopy({ documentId: prose.id, content: "潮声从旧城下醒来。", expectedRevision: 0, expectedStableVersionId: null });
    editor.saveStable({ documentId: prose.id, expectedRevision: proseDraft.workingRevision });
    const knowledgeDraft = editor.saveWorkingCopy({ documentId: knowledge.id, content: "一年分为十三个潮月。", expectedRevision: 0, expectedStableVersionId: null });
    editor.saveStable({ documentId: knowledge.id, expectedRevision: knowledgeDraft.workingRevision });

    const packet = new ContextPacketService(workspace).build({ scopeResourceIds: [story.id] });
    expect(packet.documents.map((document) => ({
      title: document.source.document?.title,
      documentId: document.source.document?.id,
      content: document.content,
      versionId: document.source.version.id,
    }))).toEqual([
      { title: "正文", documentId: prose.id, content: "潮声从旧城下醒来。", versionId: expect.any(String) },
      { title: "潮汐纪年法", documentId: knowledge.id, content: "一年分为十三个潮月。", versionId: expect.any(String) },
    ]);
  });

  it("builds evidence only from explicitly requested active scopes", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-context-packet-"));
    workspace = openWorkspace(root);
    const assertions = new AssertionRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const roots = resources.listCurrent();
    const worldRootId = roots.find((resource) => resource.type === "world")!.id;
    const storyRootId = roots.find((resource) => resource.type === "story")!.id;
    let worldResourceId = "";
    let requestedStoryId = "";
    let otherStoryId = "";
    const source = commitFixtureCheckpoint(workspace, {
      idempotencyKey: "context-scopes",
      summary: "记录世界与两条故事线",
      label: "建立检索范围",
    }, (checkpointId, changeSetId) => {
      worldResourceId = resources.putRevision({
        checkpointId,
        type: "world",
        title: "银湾世界",
        parentId: worldRootId,
        state: "active",
      });
      requestedStoryId = resources.putRevision({
        checkpointId,
        type: "story",
        title: "潮汐故事",
        parentId: storyRootId,
        state: "active",
      });
      otherStoryId = resources.putRevision({
        checkpointId,
        type: "story",
        title: "群星故事",
        parentId: storyRootId,
        state: "active",
      });

      for (const [resourceId, content] of [
        [worldResourceId, "银湾海岸由沉降纪元与海水倒灌塑造。"],
        [requestedStoryId, "潮汐故事发生在沉降纪元之后。"],
        [otherStoryId, "群星故事拥有另一条互不相干的历史。"],
      ] as const) {
        documents.putVersion({ resourceId, checkpointId, content, authorKind: "user" });
      }

      for (const [assertionId, scopeId, subject, text] of [
        ["assertion.world.coast", worldResourceId, "银湾海岸", "沉降纪元造成海水倒灌。"],
        ["assertion.story.tide", requestedStoryId, "潮汐故事", "故事发生在沉降纪元之后。"],
        ["assertion.story.stars", otherStoryId, "群星故事", "故事遵循另一条历史。"],
      ] as const) {
        assertions.putVersion({
          assertionId,
          checkpointId,
          scopeType: scopeId === worldResourceId ? "world" : "story",
          scopeId,
          subject,
          predicate: "设定",
          object: { text },
          status: "current",
          source: { kind: "confirmed_change_set", ref: changeSetId },
        });
      }
    });

    const packet = new ContextPacketService(workspace).build({
      scopeResourceIds: [worldResourceId, requestedStoryId],
    });

    expect(packet.scopes.map(({ resourceId, title }) => ({ resourceId, title }))).toEqual([
      { resourceId: worldResourceId, title: "银湾世界" },
      { resourceId: requestedStoryId, title: "潮汐故事" },
    ]);
    expect(packet.assertions.map((assertion) => assertion.assertionId)).toEqual([
      "assertion.story.tide",
      "assertion.world.coast",
    ]);
    expect(packet.documents.map((document) => document.source.resource.resourceId)).toEqual([
      worldResourceId,
      requestedStoryId,
    ]);
    expect(JSON.stringify(packet)).not.toContain(otherStoryId);
    expect(packet.assertions[0]?.sources).toEqual([
      {
        type: "change_set",
        changeSet: { id: source.changeSetId, summary: "记录世界与两条故事线" },
      },
    ]);
    expect(JSON.stringify(packet)).not.toContain('"ref"');
    expect(JSON.stringify(packet)).not.toContain('"path"');
  });

  it("uses stable document versions and never reads a dirty working copy", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-stable-context-"));
    workspace = openWorkspace(root);
    const assertions = new AssertionRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const worldRootId = resources.listCurrent().find((resource) => resource.type === "world")!.id;
    let resourceId = "";
    let stableVersionId = "";
    commitFixtureCheckpoint(workspace, {
      idempotencyKey: "stable-document-source",
      summary: "确认海岸文档",
      label: "确认稳定文档",
    }, (checkpointId) => {
      resourceId = resources.putRevision({
        checkpointId,
        type: "world",
        title: "银湾海岸",
        parentId: worldRootId,
        state: "active",
      });
      stableVersionId = documents.putVersion({
        resourceId,
        checkpointId,
        content: "稳定版本：海岸形成于沉降纪元。",
        authorKind: "user",
      });
      assertions.putVersion({
        assertionId: "assertion.coast.document",
        checkpointId,
        scopeType: "world",
        scopeId: resourceId,
        subject: "银湾海岸",
        predicate: "形成时期",
        object: { text: "沉降纪元" },
        status: "current",
        source: { kind: "document_version", ref: stableVersionId },
      });
    });
    documents.saveWorkingCopy({
      resourceId,
      content: "未稳定草稿：海岸由外星舰队轰击形成。",
    });

    const packet = new ContextPacketService(workspace).build({ scopeResourceIds: [resourceId] });

    expect(packet.documents).toHaveLength(1);
    expect(packet.documents[0]?.content).toBe("稳定版本：海岸形成于沉降纪元。");
    expect(packet.assertions[0]?.sources).toEqual([
      {
        type: "stable_document",
        document: {
          resourceId,
          title: "银湾海岸",
          versionId: stableVersionId,
        },
      },
    ]);
    expect(JSON.stringify(packet)).not.toContain("外星舰队");
  });

  it("excludes archived future evidence after restoring an older checkpoint", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-context-rollback-"));
    workspace = openWorkspace(root);
    const assertions = new AssertionRepository(workspace);
    const checkpoints = new CheckpointRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const worldRootId = resources.listCurrent().find((resource) => resource.type === "world")!.id;
    let resourceId = "";
    const first = commitFixtureCheckpoint(workspace, {
      idempotencyKey: "context-before-future",
      summary: "海岸初版",
      label: "海岸初版",
    }, (checkpointId) => {
      resourceId = resources.putRevision({
        checkpointId,
        type: "world",
        title: "银湾海岸",
        parentId: worldRootId,
        state: "active",
      });
      const documentVersionId = documents.putVersion({
        resourceId,
        checkpointId,
        content: "初版：古冰川切割海岸。",
        authorKind: "user",
      });
      assertions.putVersion({
        assertionId: "assertion.coast.rollback",
        checkpointId,
        scopeType: "world",
        scopeId: resourceId,
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { text: "古冰川切割" },
        status: "current",
        source: { kind: "document_version", ref: documentVersionId },
      });
    });

    let futureOnlyResourceId = "";
    const future = commitFixtureCheckpoint(workspace, {
      idempotencyKey: "context-future",
      summary: "海岸未来修订",
      label: "海岸未来修订",
    }, (checkpointId) => {
      const documentVersionId = documents.putVersion({
        resourceId,
        checkpointId,
        content: "未来修订：沉降纪元造成海水倒灌。",
        authorKind: "user",
      });
      assertions.putVersion({
        assertionId: "assertion.coast.rollback",
        checkpointId,
        scopeType: "world",
        scopeId: resourceId,
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { text: "沉降纪元与海水倒灌" },
        status: "current",
        source: { kind: "document_version", ref: documentVersionId },
      });
      futureOnlyResourceId = resources.putRevision({
        checkpointId,
        type: "world",
        title: "未来群岛",
        parentId: worldRootId,
        state: "active",
      });
    });

    checkpoints.restoreFromCheckpoint(first.checkpointId, "回到海岸初版");
    commitFixtureCheckpoint(workspace, {
      idempotencyKey: "context-current-branch",
      summary: "验证归档来源隔离",
      label: "验证归档来源隔离",
    }, (checkpointId) => {
      assertions.putVersion({
        assertionId: "assertion.archived-source",
        checkpointId,
        scopeType: "world",
        scopeId: resourceId,
        subject: "归档来源",
        predicate: "引用",
        object: { text: "当前分支上的断言" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: future.changeSetId },
      });
    });
    const packet = new ContextPacketService(workspace).build({ scopeResourceIds: [resourceId] });

    expect(packet.documents[0]?.content).toBe("初版：古冰川切割海岸。");
    expect(packet.assertions.find((assertion) => assertion.assertionId === "assertion.coast.rollback")?.object)
      .toEqual({ text: "古冰川切割" });
    expect(packet.assertions.find((assertion) => assertion.assertionId === "assertion.archived-source")?.sources)
      .toEqual([{ type: "unresolved", reason: "source_not_active" }]);
    expect(JSON.stringify(packet)).not.toContain("沉降纪元");
    expect(JSON.stringify(packet)).not.toContain("海岸未来修订");
    expect(() => new ContextPacketService(workspace!).build({ scopeResourceIds: [futureOnlyResourceId] }))
      .toThrow(expect.objectContaining({ code: "CONTEXT_SCOPE_NOT_ACTIVE" }));
  });

  it("retrieves the sealed Playthrough baseline instead of the newer branch head", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-context-pinned-playthrough-"));
    workspace = openWorkspace(root);
    const assertions = new AssertionRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const worldRootId = resources.listCurrent().find((resource) => resource.type === "world")!.id;
    let resourceId = "";
    const baseline = commitFixtureCheckpoint(workspace, {
      idempotencyKey: "pinned-baseline", summary: "旧存档正史", label: "旧存档正史",
    }, (checkpointId, changeSetId) => {
      resourceId = resources.putRevision({ checkpointId, type: "world", title: "潮汐洞穴", parentId: worldRootId, state: "active" });
      const versionId = documents.putVersion({ resourceId, checkpointId, content: "旧正史：洞穴只在退潮时开放。", authorKind: "user" });
      assertions.putVersion({ assertionId: "assertion.cave.rule", checkpointId, scopeType: "world", scopeId: resourceId, subject: "潮汐洞穴", predicate: "开放条件", object: { tide: "low" }, status: "current", sources: [{ kind: "document_version", ref: versionId }, { kind: "confirmed_change_set", ref: changeSetId }] });
    });
    commitFixtureCheckpoint(workspace, {
      idempotencyKey: "new-canon", summary: "新正史改写", label: "新正史改写",
    }, (checkpointId, changeSetId) => {
      const versionId = documents.putVersion({ resourceId, checkpointId, content: "新正史：洞穴已被永久封死。", authorKind: "user" });
      assertions.putVersion({ assertionId: "assertion.cave.rule", checkpointId, scopeType: "world", scopeId: resourceId, subject: "潮汐洞穴", predicate: "开放条件", object: { state: "sealed" }, status: "current", sources: [{ kind: "document_version", ref: versionId }, { kind: "confirmed_change_set", ref: changeSetId }] });
    });

    const current = new ContextPacketService(workspace).build({ scopeResourceIds: [resourceId] });
    const pinned = new ContextPacketService(workspace).build({ scopeResourceIds: [resourceId], checkpointId: baseline.checkpointId });

    expect(current.documents[0]?.content).toContain("永久封死");
    expect(pinned.branch.headCheckpointId).toBe(baseline.checkpointId);
    expect(pinned.documents[0]?.content).toBe("旧正史：洞穴只在退潮时开放。");
    expect(pinned.assertions[0]?.object).toEqual({ tide: "low" });
    expect(JSON.stringify(pinned)).not.toContain("永久封死");
  });

  it("projects the committed Change Set item used by the production write path", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-context-change-set-source-"));
    workspace = openWorkspace(root);
    const checkpoints = new CheckpointRepository(workspace);
    const worldRootId = new ResourceRepository(workspace).listCurrent()
      .find((resource) => resource.type === "world")!.id;
    const service = new ChangeSetService(workspace, {
      assess: (candidate: ChangeSetCandidate) => candidate.items.map((item) => ({
        itemId: item.id,
        risk: "low" as const,
        conflicts: [],
      })),
    });

    const committed = service.propose({
      idempotencyKey: "context-production-source",
      expectedHeadCheckpointId: checkpoints.getActiveBranch().headCheckpointId,
      mode: "free",
      summary: "确认银湾世界气候",
      items: [{
        id: "climate",
        kind: "assertion.put",
        dependsOn: [],
        payload: {
          assertionId: "assertion.world.climate",
          scopeType: "world",
          scopeId: worldRootId,
          subject: "银湾世界",
          predicate: "气候",
          object: { text: "海洋性气候" },
          status: "current",
          source: { kind: "agent_proposal", ref: "must-be-overridden" },
        },
      }],
    });
    const packet = new ContextPacketService(workspace).build({ scopeResourceIds: [worldRootId] });

    expect(packet.assertions[0]?.sources).toEqual([{
      type: "change_set",
      changeSet: {
        id: committed.id,
        summary: "确认银湾世界气候",
        itemId: "climate",
      },
    }]);
    expect(JSON.stringify(packet)).not.toContain("must-be-overridden");
  });

  it("applies deterministic count and document character budgets with explicit incompleteness", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-context-budget-"));
    workspace = openWorkspace(root);
    const assertions = new AssertionRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const worldRootId = resources.listCurrent().find((resource) => resource.type === "world")!.id;
    const scopeIds: string[] = [];
    commitFixtureCheckpoint(workspace, {
      idempotencyKey: "context-budget-fixture",
      summary: "建立预算测试资料",
      label: "建立预算测试资料",
    }, (checkpointId) => {
      for (let index = 0; index < 3; index += 1) {
        const resourceId = resources.putRevision({
          checkpointId,
          type: "world",
          title: `预算范围 ${index + 1}`,
          parentId: worldRootId,
          state: "active",
        });
        scopeIds.push(resourceId);
        const versionId = documents.putVersion({
          resourceId,
          checkpointId,
          content: `document-${index + 1}`,
          authorKind: "user",
        });
        assertions.putVersion({
          assertionId: `assertion.budget.${index + 1}`,
          checkpointId,
          scopeType: "world",
          scopeId: resourceId,
          subject: `预算事实 ${index + 1}`,
          predicate: "顺序",
          object: { index },
          status: "current",
          source: { kind: "document_version", ref: versionId },
        });
      }
    });

    const service = new ContextPacketService(workspace);
    const input = {
      scopeResourceIds: scopeIds,
      budget: {
        maxAssertions: 1,
        maxDocuments: 2,
        maxDocumentChars: 4,
        totalChars: 10_000,
      },
    };
    const first = service.build(input);
    const second = service.build(input);

    expect(second).toEqual(first);
    expect(first.assertions).toHaveLength(1);
    expect(first.documents.map((document) => document.content)).toEqual(["docu", "docu"]);
    expect(first.documents.map((document) => document.contentState)).toEqual([
      { complete: false, originalChars: 10, returnedChars: 4 },
      { complete: false, originalChars: 10, returnedChars: 4 },
    ]);
    expect(first.retrieval.completeness).toEqual({
      incomplete: true,
      omittedAssertions: 2,
      omittedDocuments: 1,
      truncatedDocuments: 2,
      limitsHit: ["max_assertions", "max_documents", "max_document_chars"],
    });
    expect(first.retrieval.ordering).toEqual({
      assertions: "repository_subject_predicate_assertion_id",
      documents: "requested_scope_order",
      relevanceRanking: "not_applied",
    });
    expect(first.retrieval.usage.totalChars).toBeLessThanOrEqual(first.retrieval.budget.totalChars);
  });

  it("never exceeds the total character budget and reports omitted evidence", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-context-total-budget-"));
    workspace = openWorkspace(root);
    const documents = new DocumentRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const worldRootId = resources.listCurrent().find((resource) => resource.type === "world")!.id;
    let resourceId = "";
    commitFixtureCheckpoint(workspace, {
      idempotencyKey: "context-total-budget-fixture",
      summary: "建立总预算资料",
      label: "建立总预算资料",
    }, (checkpointId) => {
      resourceId = resources.putRevision({
        checkpointId,
        type: "world",
        title: "总预算范围",
        parentId: worldRootId,
        state: "active",
      });
      documents.putVersion({
        resourceId,
        checkpointId,
        content: "0123456789ABCDEFGHIJ",
        authorKind: "user",
      });
    });

    const packet = new ContextPacketService(workspace).build({
      scopeResourceIds: [resourceId],
      budget: {
        maxAssertions: 10,
        maxDocuments: 10,
        maxDocumentChars: 20,
        totalChars: 7,
      },
    });

    expect(packet.documents[0]).toMatchObject({
      content: "0123456",
      contentState: { complete: false, originalChars: 20, returnedChars: 7 },
    });
    expect(packet.retrieval.usage).toMatchObject({ documentChars: 7, totalChars: 7 });
    expect(packet.retrieval.completeness).toEqual({
      incomplete: true,
      omittedAssertions: 0,
      omittedDocuments: 0,
      truncatedDocuments: 1,
      limitsHit: ["total_chars"],
    });
  });

  it("rejects retrieval budgets outside enforced bounds", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-context-invalid-budget-"));
    workspace = openWorkspace(root);
    const worldRootId = new ResourceRepository(workspace).listCurrent()
      .find((resource) => resource.type === "world")!.id;

    expect(() => new ContextPacketService(workspace!).build({
      scopeResourceIds: [worldRootId],
      budget: { totalChars: 500_001 },
    })).toThrow(expect.objectContaining({ code: "CONTEXT_BUDGET_INVALID" }));
  });
});
