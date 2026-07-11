import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { CreativeCommitRepository } from "../../src/domain/commit/creativeCommitRepository";
import { ProjectionCoordinator, projectionInputHash, type CreativeProjector } from "../../src/domain/projection/projectionCoordinator";
import { SemanticGraphProjector } from "../../src/domain/projection/semanticGraphProjector";

let workspace: WorkspaceDatabase | null = null;
let root = "";

afterEach(() => {
  workspace?.close();
  workspace = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("ProjectionCoordinator", () => {
  it("records real projection success and deterministic replay attempts", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-projection-"));
    workspace = openWorkspace(root);
    const changes = new ChangeSetRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const change = changes.propose({ idempotencyKey: "projection-commit", mode: "assist", summary: "创建世界" });
    const checkpointId = changes.commit(change.id, "创建世界", (checkpoint) => {
      resources.putRevision({
        checkpointId: checkpoint,
        type: "world",
        objectKind: "world",
        title: "潮痕世界",
        parentId: resources.listCurrent().find((resource) => resource.type === "world")!.id,
        state: "active",
      });
    });
    const coordinator = new ProjectionCoordinator(workspace, [new SemanticGraphProjector(workspace)]);

    const first = coordinator.listRuns(checkpointId).find((run) => run.projectionKind === "semantic_graph")!;
    const replay = coordinator.replay(checkpointId, "semantic_graph");

    expect(first).toMatchObject({ projectionKind: "semantic_graph", attempt: 1, status: "succeeded", errorCode: null });
    expect(first.outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(replay).toMatchObject({ attempt: 2, status: "succeeded", inputSha256: first.inputSha256, outputSha256: first.outputSha256 });
  });

  it("records a public failure code without rolling back the sealed commit", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-projection-failure-"));
    workspace = openWorkspace(root);
    const commit = new CreativeCommitRepository(workspace).listUnsealed()[0]!;
    workspace.db.prepare("UPDATE creative_commits SET manifest_sha256 = ?, sealed_at = ? WHERE id = ?")
      .run(projectionInputHash([]), new Date().toISOString(), commit.id);
    const failing: CreativeProjector = {
      kind: "failing_projection",
      inputSha256: () => projectionInputHash({ commitId: commit.id }),
      project: () => { throw Object.assign(new Error("private details"), { code: "PROJECTION_TEST_FAILURE" }); },
    };

    const [run] = new ProjectionCoordinator(workspace, [failing]).runAll(commit.id);

    expect(run).toMatchObject({ status: "failed", errorCode: "PROJECTION_TEST_FAILURE", outputSha256: null });
    expect(new CreativeCommitRepository(workspace).getRequired(commit.id).sealedAt).not.toBeNull();
  });
});
