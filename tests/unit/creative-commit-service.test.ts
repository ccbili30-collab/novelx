import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { CreativeCommitRepository } from "../../src/domain/commit/creativeCommitRepository";
import { CreativeCommitService } from "../../src/domain/commit/creativeCommitService";

let workspace: WorkspaceDatabase | null = null;
let root = "";

afterEach(() => {
  workspace?.close();
  workspace = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("Creative Commit sealing", () => {
  it("seals a deterministic manifest for canonical artifacts and rejects later mutation", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-creative-commit-"));
    workspace = openWorkspace(root);
    const changes = new ChangeSetRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const assertions = new AssertionRepository(workspace);
    const worldRoot = resources.listCurrent().find((resource) => resource.type === "world")!;
    const proposed = changes.propose({ idempotencyKey: "creative-commit-1", mode: "assist", summary: "记录海岸事实" });

    const checkpointId = changes.commit(proposed.id, "接受海岸事实", (checkpoint) => {
      const resourceId = resources.putRevision({
        checkpointId: checkpoint,
        type: "world",
        objectKind: "world",
        title: "银湾海岸",
        parentId: worldRoot.id,
        state: "active",
      });
      documents.putVersion({ resourceId, checkpointId: checkpoint, content: "海岸由沉降形成。", authorKind: "user" });
      assertions.putVersion({
        assertionId: "assertion.coast",
        checkpointId: checkpoint,
        scopeType: "world",
        scopeId: worldRoot.id,
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { text: "沉降纪元" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: proposed.id },
      });
    });

    const commit = new CreativeCommitRepository(workspace).getRequired(checkpointId);
    expect(commit).toMatchObject({
      id: checkpointId,
      parentCommitId: proposed.baseCheckpointId,
      kind: "manual",
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sealedAt: expect.any(String),
    });
    expect(commit.entries.map((entry) => entry.artifactKind)).toEqual([
      "assertion_version",
      "document_version",
      "resource_revision",
    ]);
    expect(new CreativeCommitService(workspace).verify(checkpointId).matches).toBe(true);
    expect(() => workspace!.db.prepare("DELETE FROM creative_commit_entries WHERE commit_id = ?").run(checkpointId))
      .toThrow(/CREATIVE_COMMIT_ALREADY_SEALED/);
  });

  it("keeps migrated historical commits unsealed instead of inventing successful manifests", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-creative-legacy-"));
    workspace = openWorkspace(root);
    const initial = new CreativeCommitRepository(workspace).listUnsealed();
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ kind: "initialization", sealedAt: null });
  });
});
