import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { ProjectDoctorService } from "../../src/domain/doctor/projectDoctorService";

let workspace: WorkspaceDatabase | null = null;
let root = "";

afterEach(() => {
  workspace?.close();
  workspace = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("ProjectDoctorService", () => {
  it("reports migrated unsealed history without inventing projection success", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-doctor-unsealed-"));
    workspace = openWorkspace(root);

    const report = new ProjectDoctorService(workspace).inspect();

    expect(report.status).toBe("warning");
    expect(report.counts).toEqual({ commits: 1, sealedCommits: 0, openBranchHeads: 1, successfulHeadProjections: 0 });
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "COMMIT_UNSEALED", severity: "warning", repairAvailable: true }),
    ]);
    expect(report.deferredCapabilities).toEqual([]);
  });

  it("reports a healthy sealed branch head with a successful graph projection", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-doctor-healthy-"));
    workspace = openWorkspace(root);
    const changes = new ChangeSetRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const change = changes.propose({ idempotencyKey: "doctor-healthy", mode: "assist", summary: "创建世界" });
    changes.commit(change.id, "创建世界", (checkpointId) => {
      resources.putRevision({
        checkpointId,
        type: "world",
        objectKind: "world",
        title: "潮痕世界",
        parentId: resources.listCurrent().find((resource) => resource.type === "world")!.id,
        state: "active",
      });
    });

    const report = new ProjectDoctorService(workspace).inspect();

    expect(report.status).toBe("warning");
    expect(report.counts).toEqual({ commits: 2, sealedCommits: 1, openBranchHeads: 1, successfulHeadProjections: 1 });
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "COMMIT_UNSEALED", severity: "warning" }),
    ]);
  });

  it("reports a failed head projection as repairable without exposing its exception", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-doctor-failed-"));
    workspace = openWorkspace(root);
    const changes = new ChangeSetRepository(workspace);
    const change = changes.propose({ idempotencyKey: "doctor-failed", mode: "assist", summary: "空提交" });
    const checkpointId = changes.commit(change.id, "空提交", () => undefined);
    workspace.db.prepare(`
      UPDATE projection_runs SET status = 'failed', output_sha256 = NULL, error_code = 'GRAPH_TEMPORARY_FAILURE'
      WHERE commit_id = ? AND projection_kind = 'semantic_graph'
    `).run(checkpointId);

    const report = new ProjectDoctorService(workspace).inspect();

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PROJECTION_FAILED", projectionKind: "semantic_graph", repairAvailable: true }),
    ]));
    expect(JSON.stringify(report)).not.toContain("GRAPH_TEMPORARY_FAILURE");
  });
});
