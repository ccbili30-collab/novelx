import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetService } from "../../src/domain/changeSet/changeSetService";
import { WorkspaceChangeSetPolicy } from "../../src/domain/changeSet/workspaceChangeSetPolicy";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ProjectFileVersionService } from "../../src/domain/workspace/projectFileVersionService";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let root: string | null = null;
let workspace: WorkspaceDatabase | null = null;

afterEach(() => {
  workspace?.close();
  workspace = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("project file Change Set version chain", () => {
  it("creates a text file in Free mode and restores its prior absence", () => {
    const setup = createWorkspace();
    const checkpoints = new CheckpointRepository(setup);
    const initial = checkpoints.getActiveBranch().headCheckpointId;
    const result = new ChangeSetService(setup, new WorkspaceChangeSetPolicy(setup)).propose({
      idempotencyKey: "create-readme",
      expectedHeadCheckpointId: initial,
      mode: "free",
      summary: "创建说明",
      items: [{
        id: "readme",
        dependsOn: [],
        kind: "project_file.put",
        payload: { path: "README.md", content: "# NovelX\n", expectedSha256: null },
      }],
    });
    expect(result.status).toBe("committed");
    expect(fs.readFileSync(path.join(root!, "README.md"), "utf8")).toBe("# NovelX\n");

    const rollback = new ProjectFileVersionService(setup).restoreToCheckpoint(initial);
    expect(fs.existsSync(path.join(root!, "README.md"))).toBe(false);
    rollback();
    expect(fs.readFileSync(path.join(root!, "README.md"), "utf8")).toBe("# NovelX\n");
  });

  it("requires Assist review for overwrites and rejects stale file hashes", () => {
    const setup = createWorkspace();
    const filePath = path.join(root!, "world.md");
    fs.writeFileSync(filePath, "旧设定", "utf8");
    const oldHash = hash("旧设定");
    const head = new CheckpointRepository(setup).getActiveBranch().headCheckpointId;
    const service = new ChangeSetService(setup, new WorkspaceChangeSetPolicy(setup));
    const pending = service.propose({
      idempotencyKey: "update-world",
      expectedHeadCheckpointId: head,
      mode: "assist",
      summary: "更新世界设定",
      items: [{
        id: "world",
        dependsOn: [],
        kind: "project_file.put",
        payload: { path: "world.md", content: "新设定", expectedSha256: oldHash },
      }],
    });
    expect(pending.gateStatus).toBe("review_pending");
    service.decideItem(pending.id, "world", "accepted");
    const committed = service.finalizeAssist(pending.id, { expectedHeadCheckpointId: head, label: "更新世界设定" });
    expect(committed.status).toBe("committed");
    expect(fs.readFileSync(filePath, "utf8")).toBe("新设定");

    const latest = new CheckpointRepository(setup).getActiveBranch().headCheckpointId;
    const stale = service.propose({
      idempotencyKey: "stale-update",
      expectedHeadCheckpointId: latest,
      mode: "assist",
      summary: "错误覆盖",
      items: [{
        id: "stale",
        dependsOn: [],
        kind: "project_file.put",
        payload: { path: "world.md", content: "错误内容", expectedSha256: oldHash },
      }],
    });
    service.decideItem(stale.id, "stale", "accepted");
    expect(() => service.finalizeAssist(stale.id, {
      expectedHeadCheckpointId: latest,
      label: "错误覆盖",
    })).toThrow();
    expect(fs.readFileSync(filePath, "utf8")).toBe("新设定");
  });
});

function createWorkspace(): WorkspaceDatabase {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-file-version-"));
  workspace = openWorkspace(root);
  return workspace;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
