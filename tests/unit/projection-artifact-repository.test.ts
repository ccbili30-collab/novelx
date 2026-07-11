import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { CreativeCommitRepository } from "../../src/domain/commit/creativeCommitRepository";
import { projectionInputHash, ProjectionCoordinator, type CreativeProjector } from "../../src/domain/projection/projectionCoordinator";
import { ProjectionArtifactRepository } from "../../src/domain/projection/projectionArtifactRepository";

let workspace: WorkspaceDatabase | null = null;
let root = "";

afterEach(() => {
  workspace?.close();
  workspace = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("ProjectionArtifactRepository", () => {
  it("allows append only while a run is active and keeps artifacts immutable", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-projection-artifact-"));
    workspace = openWorkspace(root);
    const commit = new CreativeCommitRepository(workspace).listUnsealed()[0]!;
    workspace.db.prepare("UPDATE creative_commits SET manifest_sha256 = ?, sealed_at = ? WHERE id = ?")
      .run(projectionInputHash([]), new Date().toISOString(), commit.id);
    const artifacts = new ProjectionArtifactRepository(workspace);
    const projector: CreativeProjector = {
      kind: "artifact_test",
      inputSha256: () => projectionInputHash({ commitId: commit.id }),
      project: (_commit, runId) => {
        artifacts.append({ runId, artifactKey: "timeline:1", payload: { event: "潮汐升起" }, sourceRefs: ["source-2", "source-1", "source-1"] });
        return { outputSha256: projectionInputHash(artifacts.listForRun(runId)) };
      },
    };

    const [run] = new ProjectionCoordinator(workspace, [projector]).runAll(commit.id);
    const [artifact] = artifacts.listForRun(run.id);

    expect(run.status).toBe("succeeded");
    expect(artifact).toMatchObject({ artifactKey: "timeline:1", payload: { event: "潮汐升起" }, sourceRefs: ["source-1", "source-2"] });
    expect(() => workspace!.db.prepare("UPDATE projection_artifacts SET artifact_key = 'changed' WHERE run_id = ?").run(run.id))
      .toThrow(/PROJECTION_ARTIFACT_IMMUTABLE/);
    expect(() => artifacts.append({ runId: run.id, artifactKey: "late", payload: {}, sourceRefs: [] }))
      .toThrow(/PROJECTION_RUN_NOT_WRITABLE/);
  });
});
