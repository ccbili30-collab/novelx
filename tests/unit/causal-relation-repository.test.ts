import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CausalRelationRepository, type PutCausalRelationVersionInput } from "../../src/domain/graph/causalRelationRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("CausalRelationRepository", () => {
  it("persists an exact replay and rejects a conflicting idempotency replay", () => {
    const setup = createSetup();
    const repository = new CausalRelationRepository(setup.workspace);
    const input = relationInput(setup);
    const first = repository.putVersion(input);

    expect(repository.putVersion(input)).toEqual(first);
    expect(repository.getVersion(input.versionId)).toEqual(first);
    const rootPath = setup.workspace.rootPath;
    setup.workspace.close();
    workspace = openWorkspace(rootPath);
    const reopened = new CausalRelationRepository(workspace);
    expect(reopened.putVersion(input)).toEqual(first);
    expect(() => reopened.putVersion({
      ...input,
      relation: { ...input.relation, mechanism: "冲突重放不得覆盖原机制。" },
    })).toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_IDEMPOTENCY_KEY_REUSED" }));
  });

  it("projects the nearest ancestor version and hides a deleted descendant without rewriting history", () => {
    const setup = createSetup();
    const repository = new CausalRelationRepository(setup.workspace);
    const first = repository.putVersion(relationInput(setup));
    const checkpoint2 = new CheckpointRepository(setup.workspace).appendCheckpoint(setup.branchId, "因果修订");
    const second = repository.putVersion({
      ...relationInput(setup),
      versionId: "causal-version-2",
      checkpointId: checkpoint2,
      idempotencyKey: "causal-version-2-key",
      relation: { ...relationInput(setup).relation, mechanism: "修订后的交通成本机制。", epistemicStatus: "disputed" },
      status: "conflict",
    });
    const checkpoint3 = new CheckpointRepository(setup.workspace).appendCheckpoint(setup.branchId, "删除因果关系");
    repository.putVersion({
      ...relationInput(setup),
      versionId: "causal-version-3",
      checkpointId: checkpoint3,
      idempotencyKey: "causal-version-3-key",
      relation: { ...relationInput(setup).relation, mechanism: "删除墓碑仍保留审计原因与来源。" },
      status: "deleted",
    });

    expect(repository.listAtCheckpoint(setup.checkpointId)).toEqual([first]);
    expect(repository.listAtCheckpoint(checkpoint2)).toEqual([second]);
    expect(repository.listAtCheckpoint(checkpoint3)).toEqual([]);
    expect(repository.getVersion(first.versionId)).toEqual(first);
  });

  it("keeps relation identity immutable across versions", () => {
    const setup = createSetup();
    const repository = new CausalRelationRepository(setup.workspace);
    repository.putVersion(relationInput(setup));
    const checkpoint2 = new CheckpointRepository(setup.workspace).appendCheckpoint(setup.branchId, "身份不可变检查");

    expect(() => repository.putVersion({
      ...relationInput(setup),
      versionId: "identity-conflict-version",
      checkpointId: checkpoint2,
      idempotencyKey: "identity-conflict-key",
      relation: { ...relationInput(setup).relation, effectAssertionId: "assertion.other-effect" },
    })).toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_ENDPOINT_NOT_VISIBLE" }));

    const otherSource = seedDocument(setup.workspace, checkpoint2, setup.worldId, "另一条可见来源。");
    seedAssertion(setup.workspace, checkpoint2, "assertion.other-effect", otherSource.versionId);
    expect(() => repository.putVersion({
      ...relationInput(setup),
      versionId: "identity-conflict-version-2",
      checkpointId: checkpoint2,
      idempotencyKey: "identity-conflict-key-2",
      relation: { ...relationInput(setup).relation, effectAssertionId: "assertion.other-effect" },
    })).toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_IDENTITY_IMMUTABLE" }));
  });

  it("rejects future endpoints and future sources at an older checkpoint", () => {
    const setup = createSetup();
    const repository = new CausalRelationRepository(setup.workspace);
    const futureCheckpoint = new CheckpointRepository(setup.workspace).appendCheckpoint(setup.branchId, "未来断言");
    const futureDocument = seedDocument(setup.workspace, futureCheckpoint, setup.worldId, "只在未来检查点出现的来源。");
    const future = seedAssertion(setup.workspace, futureCheckpoint, "assertion.future", futureDocument.versionId);

    expect(() => repository.putVersion({
      ...relationInput(setup),
      relation: { ...relationInput(setup).relation, effectAssertionId: "assertion.future" },
    })).toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_ENDPOINT_NOT_VISIBLE" }));
    expect(() => repository.putVersion({
      ...relationInput(setup),
      versionId: "future-source-version",
      idempotencyKey: "future-source-key",
      relation: {
        ...relationInput(setup).relation,
        sourceReferences: [{
          sourceId: future.sourceId,
          sourceKind: "document",
          sourceVersionId: futureDocument.versionId,
          stableLocator: "future:1",
          sourceSha256: futureDocument.contentHash,
        }],
      },
    })).toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_SOURCE_NOT_VISIBLE" }));
    expect(() => repository.putVersion({
      ...relationInput(setup),
      versionId: "wrong-source-hash-version",
      idempotencyKey: "wrong-source-hash-key",
      relation: {
        ...relationInput(setup).relation,
        sourceReferences: relationInput(setup).relation.sourceReferences.map((source) => ({
          ...source,
          sourceSha256: "f".repeat(64),
        })),
      },
    })).toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_SOURCE_HASH_MISMATCH" }));
  });

  it("isolates versions created on a sibling branch", () => {
    const setup = createSetup();
    const repository = new CausalRelationRepository(setup.workspace);
    const main = repository.putVersion(relationInput(setup));
    const checkpoints = new CheckpointRepository(setup.workspace);
    const sibling = checkpoints.createBranchFromCheckpoint(setup.checkpointId, "因果实验分支");
    const siblingCheckpoint = checkpoints.appendCheckpoint(sibling.id, "分支因果修订");
    const branchVersion = repository.putVersion({
      ...relationInput(setup),
      versionId: "causal-sibling-version",
      checkpointId: siblingCheckpoint,
      idempotencyKey: "causal-sibling-key",
      relation: { ...relationInput(setup).relation, mechanism: "仅实验分支可见的机制。" },
    });

    expect(repository.listCurrent(setup.branchId)).toEqual([main]);
    expect(repository.listCurrent(sibling.id)).toEqual([branchVersion]);
  });
});

function createSetup(): {
  workspace: WorkspaceDatabase;
  branchId: string;
  checkpointId: string;
  causeSourceId: string;
  causeSourceVersionId: string;
  causeSourceSha256: string;
  worldId: string;
} {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-causal-repository-"));
  workspace = openWorkspace(root);
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const worldId = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!.id;
  const causeDocument = seedDocument(workspace, branch.headCheckpointId, worldId, "地理隔离提高交通成本。");
  const effectDocument = seedDocument(workspace, branch.headCheckpointId, worldId, "交通成本长期维持高位。");
  const cause = seedAssertion(workspace, branch.headCheckpointId, "assertion.isolation", causeDocument.versionId);
  seedAssertion(workspace, branch.headCheckpointId, "assertion.transport-cost", effectDocument.versionId);
  return {
    workspace,
    branchId: branch.id,
    checkpointId: branch.headCheckpointId,
    causeSourceId: cause.sourceId,
    causeSourceVersionId: causeDocument.versionId,
    causeSourceSha256: causeDocument.contentHash,
    worldId,
  };
}

function seedDocument(
  target: WorkspaceDatabase,
  checkpointId: string,
  resourceId: string,
  content: string,
): { versionId: string; contentHash: string } {
  const repository = new DocumentRepository(target);
  const versionId = repository.putVersion({ resourceId, checkpointId, content, authorKind: "user" });
  const version = repository.getVersion(versionId)!;
  return { versionId, contentHash: version.contentHash };
}

function seedAssertion(
  target: WorkspaceDatabase,
  checkpointId: string,
  assertionId: string,
  sourceVersionId: string,
): { versionId: string; sourceId: string } {
  const versionId = new AssertionRepository(target).putVersion({
    assertionId,
    checkpointId,
    scopeType: "world",
    scopeId: "world-root",
    subject: assertionId,
    predicate: "establishes",
    object: { value: assertionId },
    status: "current",
    source: { kind: "document_version", ref: sourceVersionId },
  });
  const source = target.db.prepare(`
    SELECT source_id FROM assertion_sources WHERE assertion_version_id = ?
  `).get(versionId) as { source_id: string };
  return { versionId, sourceId: source.source_id };
}

function relationInput(setup: {
  checkpointId: string;
  causeSourceId: string;
  causeSourceVersionId: string;
  causeSourceSha256: string;
}): PutCausalRelationVersionInput {
  return {
    versionId: "causal-version-1",
    checkpointId: setup.checkpointId,
    status: "current",
    idempotencyKey: "causal-version-1-key",
    relation: {
      id: "relation.isolation.transport",
      kind: "causes",
      causeAssertionId: "assertion.isolation",
      effectAssertionId: "assertion.transport-cost",
      mechanism: "地理隔离迫使交通基础设施跨越高成本屏障。",
      conditions: ["在替代航路尚未成熟时"],
      temporalScope: "沉降纪元后",
      polarityStrengthSummary: "正向、中等强度。",
      epistemicStatus: "confirmed",
      sourceReferences: [{
        sourceId: setup.causeSourceId,
        sourceKind: "document",
        sourceVersionId: setup.causeSourceVersionId,
        stableLocator: "setting:1:1",
        sourceSha256: setup.causeSourceSha256,
      }],
    },
  };
}
