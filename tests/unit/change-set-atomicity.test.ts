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
});

describe("Change Set transaction and idempotency", () => {
  it("rejects reuse of an idempotency key with different content", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-idempotency-"));
    workspace = openWorkspace(root);
    const changes = new ChangeSetRepository(workspace);
    changes.propose({ idempotencyKey: "same-key", mode: "assist", summary: "版本一" });
    expect(() => changes.propose({ idempotencyKey: "same-key", mode: "assist", summary: "版本二" }))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }));
  });

  it("rolls back assertion writes and branch head when apply fails", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-atomicity-"));
    workspace = openWorkspace(root);
    const changes = new ChangeSetRepository(workspace);
    const assertions = new AssertionRepository(workspace);
    const checkpoints = new CheckpointRepository(workspace);
    const beforeHead = checkpoints.getActiveBranch().headCheckpointId;
    const proposed = changes.propose({ idempotencyKey: "atomic-1", mode: "assist", summary: "原子写入" });

    expect(() => changes.commit(proposed.id, "应当回滚", (checkpointId) => {
      assertions.putVersion({
        assertionId: "assertion.atomic",
        checkpointId,
        scopeType: "world",
        scopeId: "world.atomic",
        subject: "测试",
        predicate: "状态",
        object: { text: "不应保留" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: proposed.id },
      });
      throw new Error("injected failure");
    })).toThrow("injected failure");

    expect(checkpoints.getActiveBranch().headCheckpointId).toBe(beforeHead);
    expect(changes.get(proposed.id)?.status).toBe("pending");
    expect(assertions.listHistory("assertion.atomic")).toEqual([]);
  });
});

