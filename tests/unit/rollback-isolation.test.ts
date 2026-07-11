import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("checkpoint branch isolation", () => {
  it("keeps archived future facts auditable but excludes them from a branch created at an older checkpoint", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-rollback-"));
    workspace = openWorkspace(root);
    const changes = new ChangeSetRepository(workspace);
    const assertions = new AssertionRepository(workspace);
    const checkpoints = new CheckpointRepository(workspace);
    const mainBranch = checkpoints.getActiveBranch();

    const first = changes.propose({ idempotencyKey: "coast-v1", mode: "assist", summary: "海岸初稿" });
    const firstCheckpoint = changes.commit(first.id, "海岸初稿", (checkpointId) => {
      assertions.putVersion({
        assertionId: "assertion.coastline",
        checkpointId,
        scopeType: "world",
        scopeId: "world.silver-bay",
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { text: "古冰川切割。" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: first.id },
      });
    });
    expect(checkpoints.listActiveHistory().map((checkpoint) => checkpoint.label)).toEqual([
      "海岸初稿",
      "工作区初始化",
    ]);

    const second = changes.propose({ idempotencyKey: "coast-v2", mode: "assist", summary: "海岸修订" });
    changes.commit(second.id, "海岸修订", (checkpointId) => {
      assertions.putVersion({
        assertionId: "assertion.coastline",
        checkpointId,
        scopeType: "world",
        scopeId: "world.silver-bay",
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { text: "沉降纪元与海水倒灌。" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: second.id },
      });
    });

    expect(assertions.listCurrent(mainBranch.id)[0]?.object).toEqual({ text: "沉降纪元与海水倒灌。" });

    const rollbackBranch = checkpoints.restoreFromCheckpoint(firstCheckpoint, "从海岸初稿重写");

    expect(assertions.listCurrent()[0]?.object).toEqual({ text: "古冰川切割。" });
    expect(assertions.listHistory("assertion.coastline")).toHaveLength(2);
    expect(assertions.listCurrent(mainBranch.id)[0]?.object).toEqual({ text: "沉降纪元与海水倒灌。" });
    expect(checkpoints.getBranch(mainBranch.id).status).toBe("archived");
    expect(checkpoints.getActiveBranch().id).toBe(rollbackBranch.id);
    expect(checkpoints.listActiveHistory()).toEqual([
      expect.objectContaining({ id: firstCheckpoint, label: "海岸初稿", isHead: true }),
      expect.objectContaining({ label: "工作区初始化", isHead: false }),
    ]);
  });
});
