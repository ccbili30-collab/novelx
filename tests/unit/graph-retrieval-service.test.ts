import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createGraphRetrievalCacheKey, GraphRetrievalService } from "../../src/domain/retrieval/graphRetrievalService";
import { graphRetrievalRequestSchema } from "../../src/domain/retrieval/graphRetrievalTypes";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { CausalRelationRepository } from "../../src/domain/graph/causalRelationRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../../src/domain/workspace/creativeRelationRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("GraphRetrievalService", () => {
  it("retrieves Chinese literal and explicit aliases deterministically with stable document provenance", () => {
    const setup = createSetup();
    const service = new GraphRetrievalService(setup.workspace);
    const first = service.retrieve(request(setup, { query: "潮汐", aliases: ["潮月"] }));
    const second = service.retrieve(request(setup, { query: "潮汐", aliases: ["潮月"] }));
    expect(second.receipt.links).toEqual(first.receipt.links);
    expect(first.hits.map((hit) => [hit.rank, hit.targetKind, hit.targetId, hit.targetVersionId])).toEqual(first.receipt.links.map((link) => [link.rank, link.targetKind, link.targetId, link.targetVersionId]));
    expect(first.receipt.links.some((link) => link.reasonCodes.includes("source_match") && link.stableHash === setup.documentHash)).toBe(true);
    const conflict = first.hits.find((hit) => hit.targetKind === "assertion");
    expect(conflict?.targetKind === "assertion" && conflict.assertion.status).toBe("conflict");
    expect(conflict?.targetKind === "assertion" && conflict.assertion.sources).toEqual(expect.arrayContaining([
      { type: "stable_document", document: expect.objectContaining({ resourceId: setup.worldId, versionId: setup.documentVersionId }) },
    ]));
    expect(first.receipt.links.every((link) => link.targetVersionId)).toBe(true);
  });

  it("enforces pinned scope, checkpoint, Lens and time boundaries", () => {
    const setup = createSetup();
    const service = new GraphRetrievalService(setup.workspace);
    expect(() => service.retrieve(request(setup, { branchId: "other" }))).toThrowError(expect.objectContaining({ code: "GRAPH_RETRIEVAL_CHECKPOINT_BRANCH_MISMATCH" }));
    expect(() => service.retrieve(request(setup, { seedResourceIds: [setup.worldId], authorizedScopeResourceIds: [setup.storyRootId] })))
      .toThrowError(expect.objectContaining({ code: "GRAPH_RETRIEVAL_SEED_OUTSIDE_SCOPE" }));
    expect(() => service.retrieve(request(setup, { validTime: { from: "2026-01-01T00:00:00.000Z", to: null } })))
      .toThrowError(expect.objectContaining({ code: "GRAPH_RETRIEVAL_TIME_FILTER_UNSUPPORTED" }));
    expect(() => service.retrieve({ ...request(setup), lens: "player" })).toThrowError(expect.objectContaining({ code: "GRAPH_RETRIEVAL_CREATOR_LENS_REQUIRED" }));
  });

  it("keeps later-head state out of a pinned query and bounds explicit traversal", () => {
    const setup = createSetup();
    const service = new GraphRetrievalService(setup.workspace);
    const zero = service.retrieve(request(setup, { query: "不存在", maxHops: 0, seedResourceIds: [setup.storyId] }));
    expect(zero.receipt.coverage.state).toBe("unknown");
    const traversed = service.retrieve(request(setup, { query: "不存在", maxHops: 1, seedResourceIds: [setup.storyId] }));
    expect(traversed.receipt.links.some((link) => link.reasonCodes.includes("graph_hop"))).toBe(true);
    const futureCheckpoint = new CheckpointRepository(setup.workspace).appendCheckpoint(setup.branchId, "future");
    new DocumentRepository(setup.workspace).putVersion({ resourceId: setup.worldId, creativeDocumentId: setup.documentId, checkpointId: futureCheckpoint, content: "未来泄漏", authorKind: "user" });
    const pinned = service.retrieve(request(setup, { query: "未来泄漏" }));
    expect(pinned.receipt.links).toHaveLength(0);
    expect(pinned.hits).toHaveLength(0);
  });

  it("retains a Main-required direct seed as an alias hit within the result budget", () => {
    const setup = createSetup();
    const result = new GraphRetrievalService(setup.workspace).retrieve(request(setup, {
      query: "不存在的查询", aliases: ["潮汐世界"], seedResourceIds: [setup.worldId],
      requiredResourceIds: [setup.worldId], maxHops: 0, resultBudget: 1,
    }));
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ targetKind: "resource", targetId: setup.worldId });
    expect(result.hits[0]!.reasonCodes).toContain("alias");
    expect(result.receipt.aliases).toContain("潮汐世界");
    expect(result.receipt.links.map((link) => [link.rank, link.targetKind, link.targetId, link.targetVersionId]))
      .toEqual(result.hits.map((hit) => [hit.rank, hit.targetKind, hit.targetId, hit.targetVersionId]));
  });

  it("retains a Main-pinned target version without relying on model query wording", () => {
    const setup = createSetup();
    const result = new GraphRetrievalService(setup.workspace).retrieve(request(setup, {
      query: "query-that-does-not-describe-the-document", aliases: [], maxHops: 0, resultBudget: 1,
      requiredTargetVersionIds: [setup.documentVersionId],
    }));
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ targetKind: "document", targetVersionId: setup.documentVersionId });
    expect(result.receipt.links[0]).toMatchObject({ targetKind: "document", targetVersionId: setup.documentVersionId });
    expect(() => new GraphRetrievalService(setup.workspace).retrieve(request(setup, {
      requiredTargetVersionIds: ["not-visible-version"],
    }))).toThrowError(expect.objectContaining({ code: "GRAPH_RETRIEVAL_REQUIRED_RESOURCE_INVALID" }));
  });

  it("rejects Main-required resources that are not seed-visible or do not fit the result budget", () => {
    const setup = createSetup();
    const service = new GraphRetrievalService(setup.workspace);
    expect(() => service.retrieve(request(setup, { requiredResourceIds: [setup.worldId] })))
      .toThrowError(expect.objectContaining({ code: "GRAPH_RETRIEVAL_REQUIRED_RESOURCE_INVALID" }));
    expect(() => service.retrieve(request(setup, {
      seedResourceIds: [setup.worldId, setup.storyId], requiredResourceIds: [setup.worldId, setup.storyId], resultBudget: 1,
    }))).toThrowError(expect.objectContaining({ code: "GRAPH_RETRIEVAL_REQUIRED_RESOURCE_INVALID" }));
    expect(() => service.retrieve(request(setup, {
      authorizedScopeResourceIds: [setup.storyRootId], seedResourceIds: [setup.worldId], requiredResourceIds: [setup.worldId],
    }))).toThrowError(expect.objectContaining({ code: "GRAPH_RETRIEVAL_SEED_OUTSIDE_SCOPE" }));
    expect(() => service.retrieve(request(setup, {
      query: "不存在的查询", aliases: [], seedResourceIds: [setup.worldId], requiredResourceIds: [setup.worldId], maxHops: 0, resultBudget: 1,
    }))).toThrowError(expect.objectContaining({ code: "GRAPH_RETRIEVAL_REQUIRED_RESOURCE_INVALID" }));
  });

  it("reports partial truncation for result, content and expansion budgets", () => {
    const setup = createSetup();
    const service = new GraphRetrievalService(setup.workspace);
    expect(service.retrieve(request(setup, { query: "潮", resultBudget: 1 })).receipt.truncated).toBe(true);
    expect(service.retrieve(request(setup, { query: "潮", contentBudgetChars: 1 })).receipt.coverage.state).toBe("partial");
    expect(service.retrieve(request(setup, { query: "不存在", maxHops: 2, expansionBudget: 1, seedResourceIds: [setup.storyId] })).receipt.truncated).toBe(true);
    let tick = 0;
    const cpuBound = new GraphRetrievalService(setup.workspace, { now: () => tick++ });
    const cpuResult = cpuBound.retrieve(request(setup, { query: "潮", cpuBudgetMs: 1 }));
    expect(cpuResult.receipt.coverage.state).toBe("partial");
    expect(cpuResult.receipt.truncated).toBe(true);
  });

  it("creates a Receipt accepted and replayed by GrowthRepository", () => {
    const setup = createSetup();
    const graph = new GraphRetrievalService(setup.workspace);
    const growth = new GrowthRepository(setup.workspace);
    const goal = growth.createGoal({ id: "goal", idempotencyKey: "goal", branchId: setup.branchId, seed: { kind: "text", text: "grow" }, authorizedScopeResourceIds: [setup.storyRootId, setup.worldRootId], initialRuleText: "sources", sourceMessageId: null });
    const cycle = growth.beginCycle({ id: "cycle", goalId: goal.id, idempotencyKey: "cycle", inputCheckpointId: setup.checkpointId, ruleRevision: 1, intent: { kind: "expand", focusKinds: ["world"], resumeFrontier: ["story", "oc"] } });
    const run = seedRun(setup.workspace, setup.branchId, setup.checkpointId);
    growth.attachRun({ cycleId: cycle.id, runId: run.runId });
    const result = graph.retrieve(request(setup, { id: "receipt", cycleId: cycle.id, runId: run.runId, toolInvocationId: run.toolInvocationId, query: "潮汐" }));
    const stored = growth.recordReceipt(result.receipt);
    expect(growth.recordReceipt(result.receipt)).toEqual(stored);
    expect(stored.links.some((link) => link.stableVersionId === result.hits.find((hit) => hit.targetKind === "document")?.targetVersionId && link.stableHash === setup.documentHash)).toBe(true);
  });

  it("excludes cross-scope evidence from hits and Receipt links", () => {
    const setup = createSetup();
    const result = new GraphRetrievalService(setup.workspace).retrieve(request(setup, { authorizedScopeResourceIds: [setup.worldRootId], query: "海岸故事" }));
    expect(result.hits.every((hit) => hit.targetId !== setup.storyId)).toBe(true);
    expect(result.receipt.links.every((link) => link.targetId !== setup.storyId)).toBe(true);
  });

  it("breaks equal-score document ties by stable target identity", () => {
    const setup = createSetup();
    const result = new GraphRetrievalService(setup.workspace).retrieve(request(setup, { query: "十三个" }));
    const documents = result.hits.filter((hit) => hit.targetKind === "document");
    expect(documents.map((hit) => hit.targetId)).toEqual([...documents.map((hit) => hit.targetId)].sort());
  });

  it("projects assertion sources safely without leaking cross-scope, future or opaque refs", () => {
    const setup = createSetup();
    const futureCheckpoint = new CheckpointRepository(setup.workspace).appendCheckpoint(setup.branchId, "future source");
    const futureVersionId = new DocumentRepository(setup.workspace).putVersion({ resourceId: setup.worldId, checkpointId: futureCheckpoint, content: "future-only", authorKind: "user" });
    setup.workspace.db.prepare("UPDATE source_records SET ref = ? WHERE ref = 'future-source-placeholder'").run(futureVersionId);
    const result = new GraphRetrievalService(setup.workspace).retrieve(request(setup, {
      authorizedScopeResourceIds: [setup.worldRootId], query: "source projection",
    }));
    const assertion = result.hits.find((hit) => hit.targetKind === "assertion" && hit.targetId === "source-projection");
    expect(assertion?.targetKind).toBe("assertion");
    if (assertion?.targetKind !== "assertion") return;
    expect(assertion.assertion.sources).toContainEqual({
      type: "stable_document",
      document: expect.objectContaining({ resourceId: setup.worldId, versionId: setup.documentVersionId }),
    });
    expect(assertion.assertion.sources.filter((source) => source.type === "unresolved")).toEqual(expect.arrayContaining([
      { type: "unresolved", reason: "source_not_active" },
      { type: "unresolved", reason: "unsupported_source" },
    ]));
    expect(assertion.assertion.sources.filter((source) => source.type === "unresolved")).toHaveLength(3);
    expect(assertion.assertion.sources.filter((source) => source.type === "unresolved" && source.reason === "source_not_active")).toHaveLength(2);
    const serialized = JSON.stringify(assertion.assertion.sources);
    expect(serialized).not.toContain(setup.crossScopeDocumentVersionId);
    expect(serialized).not.toContain(futureVersionId);
    expect(serialized).not.toContain("C:\\private\\opaque-source");
  });

  it("ranks an exact document match after earlier resources despite a small result budget", () => {
    const setup = createSetup();
    const result = new GraphRetrievalService(setup.workspace).retrieve(request(setup, { query: "retrieval-budget-needle", resultBudget: 1 }));
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ targetKind: "document", targetId: setup.budgetDocumentId });
    expect(result.receipt.links).toHaveLength(1);
  });

  it("retrieves bounded downstream and upstream causal paths with safe edge provenance", () => {
    const setup = createSetup();
    const causal = seedCausalChain(setup);
    const service = new GraphRetrievalService(setup.workspace);
    const downstream = service.retrieve(request(setup, {
      query: "不存在的字面词",
      seedAssertionIds: [causal.causeAssertionId],
      causalDirection: "downstream",
      maxHops: 1,
    }));
    const downstreamCausal = downstream.hits.filter((hit) =>
      hit.targetKind === "relation" && hit.relation.relationType === "causal");
    expect(downstreamCausal).toHaveLength(1);
    expect(downstreamCausal[0]).toMatchObject({
      targetId: causal.firstRelationId,
      reasonCodes: expect.arrayContaining(["graph_hop"]),
      pathTargetIds: [causal.causeAssertionId, causal.middleAssertionId],
      relation: {
        relationType: "causal",
        mechanismSummary: "月潮增强会压缩浅滩可航窗口。",
        epistemicStatus: "inferred",
        status: "current",
        sourceReferences: [expect.objectContaining({ kind: "document", locator: "paragraph:1" })],
      },
    });
    expect(JSON.stringify(downstreamCausal)).not.toMatch(/source\.causal\.chain|sourceSha256|sourceId/);
    const upstream = service.retrieve(request(setup, {
      query: "不存在的字面词",
      seedAssertionIds: [causal.effectAssertionId],
      causalDirection: "upstream",
      maxHops: 1,
    }));
    const upstreamCausal = upstream.hits.filter((hit) =>
      hit.targetKind === "relation" && hit.relation.relationType === "causal");
    expect(upstreamCausal).toHaveLength(1);
    expect(upstreamCausal[0]).toMatchObject({
      targetId: causal.secondRelationId,
      pathTargetIds: [causal.effectAssertionId, causal.middleAssertionId],
      relation: expect.objectContaining({ epistemicStatus: "disputed" }),
    });
    expect(() => service.retrieve(request(setup, { seedAssertionIds: ["assertion.outside"] })))
      .toThrowError(expect.objectContaining({ code: "GRAPH_RETRIEVAL_SEED_NOT_VISIBLE" }));

    const repository = new CausalRelationRepository(setup.workspace);
    const current = repository.getVersion("causal-version.chain.0")!;
    const futureCheckpoint = new CheckpointRepository(setup.workspace).appendCheckpoint(setup.branchId, "future causal revision");
    repository.putVersion({
      versionId: "causal-version.chain.future",
      checkpointId: futureCheckpoint,
      status: "current",
      idempotencyKey: "causal-chain-future",
      relation: {
        id: current.id,
        kind: current.kind,
        causeAssertionId: current.causeAssertionId,
        effectAssertionId: current.effectAssertionId,
        mechanism: "未来因果泄漏",
        conditions: current.conditions,
        temporalScope: current.temporalScope,
        polarityStrengthSummary: current.polarityStrengthSummary,
        epistemicStatus: current.epistemicStatus,
        sourceReferences: current.sourceReferences,
      },
    });
    const pinned = service.retrieve(request(setup, { query: "未来因果泄漏", seedAssertionIds: [], maxHops: 0 }));
    expect(pinned.hits.some((hit) => hit.targetId === causal.firstRelationId)).toBe(false);
  });

  it("uses an identity-free bounded cache keyed by checkpoint, scope, Lens, query and budgets", () => {
    const setup = createSetup();
    const service = new GraphRetrievalService(setup.workspace);
    const first = service.retrieve(request(setup, { id: "receipt-a", runId: "run-a", toolInvocationId: "tool-a" }));
    const second = service.retrieve(request(setup, { id: "receipt-b", runId: "run-b", toolInvocationId: "tool-b" }));
    expect(first.diagnostics.cache).toBe("miss");
    expect(second.diagnostics.cache).toBe("hit");
    expect(second.receipt).toMatchObject({ id: "receipt-b", runId: "run-b", toolInvocationId: "tool-b", lens: "creator" });
    expect(second.receipt.links).toEqual(first.receipt.links);

    const parsed = graphRetrievalRequestSchema.parse(request(setup));
    const key = createGraphRetrievalCacheKey(parsed);
    expect(key).toContain('"lens":"creator"');
    expect(createGraphRetrievalCacheKey({ ...parsed, checkpointId: "checkpoint-other" })).not.toBe(key);
    expect(createGraphRetrievalCacheKey({ ...parsed, authorizedScopeResourceIds: [setup.worldRootId] })).not.toBe(key);
    expect(createGraphRetrievalCacheKey({ ...parsed, query: "另一查询" })).not.toBe(key);
    for (const budget of ["cpuBudgetMs", "expansionBudget", "resultBudget", "tokenBudget", "contentBudgetChars"] as const) {
      expect(createGraphRetrievalCacheKey({ ...parsed, [budget]: parsed[budget] + 1 })).not.toBe(key);
    }
  });
});

function createSetup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-graph-retrieval-"));
  workspace = openWorkspace(root);
  const resources = new ResourceRepository(workspace);
  const changes = new ChangeSetRepository(workspace);
  const roots = new Map(resources.listCurrent().map((resource) => [resource.type, resource.id]));
  let storyId = "";
  let worldId = "";
  const objects = changes.propose({ idempotencyKey: "objects", mode: "free", summary: "objects" });
  changes.commit(objects.id, "objects", (checkpointId) => {
    for (let index = 0; index < 5; index += 1) {
      resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: `noise-${index}`, parentId: roots.get("world")!, state: "active" });
    }
    worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "潮汐世界", parentId: roots.get("world")!, state: "active" });
    storyId = resources.putRevision({ checkpointId, type: "story", objectKind: "story", title: "海岸故事", parentId: roots.get("story")!, state: "active" });
  });
  let documentId = "";
  let documentIdTwo = "";
  let documentHash = "";
  let documentVersionId = "";
  let crossScopeDocumentVersionId = "";
  let budgetDocumentId = "";
  const evidence = changes.propose({ idempotencyKey: "evidence", mode: "free", summary: "evidence" });
  changes.commit(evidence.id, "evidence", (checkpointId) => {
    const creative = new CreativeDocumentRepository(workspace!).putRevisionWithReceipt({ create: true, checkpointId, resourceId: worldId, kind: "setting", title: "潮月设定", state: "active" });
    documentId = creative.documentId;
    const versionId = new DocumentRepository(workspace!).putVersion({ resourceId: worldId, creativeDocumentId: documentId, checkpointId, content: "潮汐决定十三个潮月。", authorKind: "user" });
    documentVersionId = versionId;
    documentHash = (workspace!.db.prepare("SELECT content_hash FROM document_versions WHERE id = ?").get(versionId) as { content_hash: string }).content_hash;
    const creativeTwo = new CreativeDocumentRepository(workspace!).putRevisionWithReceipt({ create: true, checkpointId, resourceId: worldId, kind: "setting", title: "潮月副本", state: "active" });
    documentIdTwo = creativeTwo.documentId;
    crossScopeDocumentVersionId = new DocumentRepository(workspace!).putVersion({ resourceId: storyId, checkpointId, content: "cross scope source", authorKind: "user" });
    const budgetDocument = new CreativeDocumentRepository(workspace!).putRevisionWithReceipt({ create: true, checkpointId, resourceId: worldId, kind: "setting", title: "retrieval-budget-needle", state: "active" });
    budgetDocumentId = budgetDocument.documentId;
    new DocumentRepository(workspace!).putVersion({ resourceId: worldId, creativeDocumentId: budgetDocumentId, checkpointId, content: "retrieval-budget-needle", authorKind: "user" });
    new DocumentRepository(workspace!).putVersion({ resourceId: worldId, creativeDocumentId: documentIdTwo, checkpointId, content: "潮汐决定十三个潮月。", authorKind: "user" });
    new AssertionRepository(workspace!).putVersion({ assertionId: "tide-rule", checkpointId, scopeType: "story", scopeId: storyId, subject: "潮汐法则", predicate: "影响", object: { entityRef: { resourceId: worldId } }, status: "conflict", source: { kind: "document_version", ref: versionId } });
    new AssertionRepository(workspace!).putVersion({ assertionId: "source-projection", checkpointId, scopeType: "world", scopeId: worldId, subject: "source projection", predicate: "proves", object: {}, status: "current", sources: [
      { kind: "document_version", ref: versionId },
      { kind: "document_version", ref: crossScopeDocumentVersionId },
      { kind: "document_version", ref: "future-source-placeholder" },
      { kind: "opaque_kind", ref: "C:\\private\\opaque-source" },
    ] });
    new CreativeRelationRepository(workspace!).putRevision({ checkpointId, kind: "uses_world", sourceResourceId: storyId, targetResourceId: worldId, state: "active" });
  });
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  return { workspace, branchId: branch.id, checkpointId: branch.headCheckpointId, storyId, worldId, storyRootId: roots.get("story")!, worldRootId: roots.get("world")!, documentId, documentIdTwo, documentHash, documentVersionId, crossScopeDocumentVersionId, budgetDocumentId };
}

function request(setup: ReturnType<typeof createSetup>, overrides: Record<string, unknown> = {}) {
  return {
    id: "receipt", cycleId: "cycle", runId: "run", toolInvocationId: "tool", branchId: setup.branchId, checkpointId: setup.checkpointId,
    lens: "creator" as const, authorizedScopeResourceIds: [setup.storyRootId, setup.worldRootId], seedResourceIds: [], query: "潮汐", aliases: [],
    validTime: null, recordedTime: null, maxHops: 1, cpuBudgetMs: 1000, expansionBudget: 100, resultBudget: 20, tokenBudget: 1000, contentBudgetChars: 1000,
    policyVersion: "graph-retrieval-v1", ...overrides,
  };
}

function seedCausalChain(setup: ReturnType<typeof createSetup>) {
  const changes = new ChangeSetRepository(setup.workspace);
  const causal = new CausalRelationRepository(setup.workspace);
  const assertions = new AssertionRepository(setup.workspace);
  const sourceHash = setup.documentHash;
  const causeAssertionId = "assertion.causal.tide";
  const middleAssertionId = "assertion.causal.shoal";
  const effectAssertionId = "assertion.causal.route";
  const firstRelationId = "relation.causal.tide-shoal";
  const secondRelationId = "relation.causal.shoal-route";
  const changeSet = changes.propose({ idempotencyKey: "causal-chain", mode: "free", summary: "causal chain" });
  const checkpointId = changes.commit(changeSet.id, "causal chain", (checkpointId) => {
    for (const [assertionId, subject, predicate] of [
      [causeAssertionId, "月潮", "增强"],
      [middleAssertionId, "浅滩窗口", "缩短"],
      [effectAssertionId, "商路", "北移"],
    ] as const) {
      assertions.putVersion({
        assertionId,
        checkpointId,
        scopeType: "world",
        scopeId: setup.worldId,
        subject,
        predicate,
        object: { text: `${subject}${predicate}` },
        status: "current",
        source: { kind: "document_version", ref: setup.documentVersionId },
      });
    }
    for (const [index, input] of [
      {
        relationId: firstRelationId,
        causeAssertionId,
        effectAssertionId: middleAssertionId,
        mechanism: "月潮增强会压缩浅滩可航窗口。",
        epistemicStatus: "inferred" as const,
      },
      {
        relationId: secondRelationId,
        causeAssertionId: middleAssertionId,
        effectAssertionId,
        mechanism: "浅滩窗口缩短可能迫使商路北移。",
        epistemicStatus: "disputed" as const,
      },
    ].entries()) {
      const sourceId = `source.causal.chain.${index}`;
      setup.workspace.db.prepare("INSERT INTO source_records (id, kind, ref, created_at) VALUES (?, 'document_version', ?, ?)")
        .run(sourceId, setup.documentVersionId, "2026-07-18T00:00:00.000Z");
      causal.putVersion({
        versionId: `causal-version.chain.${index}`,
        checkpointId,
        status: "current",
        idempotencyKey: `causal-chain-${index}`,
        relation: {
          id: input.relationId,
          kind: "causes",
          causeAssertionId: input.causeAssertionId,
          effectAssertionId: input.effectAssertionId,
          mechanism: input.mechanism,
          conditions: ["强月潮"],
          temporalScope: "涨潮后三小时",
          polarityStrengthSummary: "强正向",
          epistemicStatus: input.epistemicStatus,
          sourceReferences: [{
            sourceId,
            sourceKind: "document",
            sourceVersionId: setup.documentVersionId,
            stableLocator: `paragraph:${index + 1}`,
            sourceSha256: sourceHash,
          }],
        },
      });
    }
  });
  setup.checkpointId = checkpointId;
  return { causeAssertionId, middleAssertionId, effectAssertionId, firstRelationId, secondRelationId };
}

function seedRun(workspace: WorkspaceDatabase, branchId: string, checkpointId: string) {
  const runId = randomUUID();
  const invocationId = randomUUID();
  const toolInvocationId = randomUUID();
  const hash = createHash("sha256").update("growth", "utf8").digest("hex");
  const now = new Date().toISOString();
  workspace.db.prepare("INSERT INTO agent_runs (id, workspace_id, branch_id, base_checkpoint_id, mode, user_input_sha256, provider_id, requested_model_id, provider_config_sha256, runtime_contract_version, created_at) VALUES (?, ?, ?, ?, 'free', ?, NULL, NULL, NULL, '1.0.0', ?)").run(runId, workspace.workspaceId, branchId, checkpointId, hash, now);
  workspace.db.prepare("INSERT INTO agent_invocations (id, run_id, parent_invocation_id, role, prompt_id, prompt_version, prompt_sha256, agent_profile_id, agent_profile_version, agent_profile_sha256, provider_id, requested_model_id, provider_config_sha256, tool_policy_id, tool_policy_version, tool_policy_sha256, authorized_tools_json, handoff_contract_id, handoff_version, handoff_payload_sha256, input_sha256, created_at) VALUES (?, ?, NULL, 'steward', 'steward', '1.0.0', ?, 'profile', '1.0.0', ?, 'provider', 'model', ?, 'policy', '1.0.0', ?, '[]', NULL, NULL, NULL, ?, ?)").run(invocationId, runId, hash, hash, hash, hash, hash, now);
  workspace.db.prepare("INSERT INTO agent_tool_invocations (id, run_id, invocation_id, tool_name, arguments_sha256, created_at) VALUES (?, ?, ?, 'retrieve_graph_evidence', ?, ?)").run(toolInvocationId, runId, invocationId, hash, now);
  return { runId, toolInvocationId };
}
