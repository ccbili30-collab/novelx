import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopApi } from "../../src/shared/ipcContract";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import {
  ChangeSetService,
  type ChangeSetCandidate,
  type ChangeSetPolicyEvaluator,
} from "../../src/domain/changeSet/changeSetService";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("reviews and finalizes an Assist Change Set through the real preload API", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-change-set-e2e-"));
  let app: ElectronApplication | null = null;
  const workspace = openWorkspace(workspaceRoot);
  const head = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
  const pending = new ChangeSetService(workspace, new ContractLowRiskPolicy()).propose({
    idempotencyKey: "e2e-assist-review",
    expectedHeadCheckpointId: head,
    mode: "assist",
    summary: "记录银湾海岸成因",
    items: [{
      id: "coast-cause",
      kind: "assertion.put",
      dependsOn: [],
      payload: {
        assertionId: "assertion.e2e-coast",
        scopeType: "world",
        scopeId: "world.silver-bay",
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { text: "沉降纪元造成差异侵蚀与海水倒灌。" },
        status: "current",
        source: { kind: "agent_candidate", ref: "e2e-private-source" },
      },
    }],
  });
  const major = new ChangeSetService(workspace, new ContractMajorConflictPolicy()).propose({
    idempotencyKey: "e2e-major-review",
    expectedHeadCheckpointId: head,
    mode: "assist",
    summary: "冲突的世界规则",
    items: [{
      id: "world-rule",
      kind: "assertion.put",
      dependsOn: [],
      payload: {
        assertionId: "assertion.e2e-rule",
        scopeType: "world",
        scopeId: "world.silver-bay",
        subject: "银湾海域",
        predicate: "物理规则",
        object: { text: "海水向高处流动。" },
        status: "current",
        source: { kind: "agent_candidate", ref: "e2e-major-private-source" },
      },
    }],
  });
  workspace.close();

  try {
    app = await launch(workspaceRoot);
    const page = await app.firstWindow();
    const result = await page.evaluate(async ({ changeSetId, majorChangeSetId }) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const apiKeys = Object.keys(desktop.changeSet).sort();
      const listResult = await desktop.changeSet.listPending();
      if (!listResult.ok) throw new Error(listResult.error.message);
      const majorDecision = await desktop.changeSet.decide({
        changeSetId: majorChangeSetId,
        itemId: "world-rule",
        decision: "accepted",
      });
      if (!majorDecision.ok) throw new Error(majorDecision.error.message);
      const majorFinalize = await desktop.changeSet.finalizeAssist({
        changeSetId: majorChangeSetId,
        label: "不能接受重大冲突",
      });
      const majorAfterResult = await desktop.changeSet.get({ changeSetId: majorChangeSetId });
      if (!majorAfterResult.ok) throw new Error(majorAfterResult.error.message);
      const beforeResult = await desktop.changeSet.get({ changeSetId });
      if (!beforeResult.ok) throw new Error(beforeResult.error.message);
      const reviewedResult = await desktop.changeSet.decide({
        changeSetId,
        itemId: "coast-cause",
        decision: "accepted",
      });
      if (!reviewedResult.ok) throw new Error(reviewedResult.error.message);
      const finalizedResult = await desktop.changeSet.finalizeAssist({
        changeSetId,
        label: "接受银湾海岸设定",
      });
      if (!finalizedResult.ok) throw new Error(finalizedResult.error.message);
      return {
        apiKeys,
        list: listResult.changeSets,
        majorError: majorFinalize.ok ? null : majorFinalize.error,
        majorAfter: majorAfterResult.changeSet,
        before: beforeResult.changeSet,
        reviewed: reviewedResult.changeSet,
        finalized: finalizedResult.changeSet,
      };
    }, { changeSetId: pending.id, majorChangeSetId: major.id });

    expect(result.list).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pending.id, pendingCount: 1 }),
      expect.objectContaining({ id: major.id, blockedReason: "MAJOR_CONFLICT" }),
    ]));
    expect(result.apiKeys).toEqual(["decide", "finalizeAssist", "get", "listPending"]);
    expect(result.majorError).toEqual({
      code: "CHANGE_SET_MAJOR_CONFLICT",
      message: "存在重大冲突，必须先修改方案，不能直接提交。",
    });
    expect(result.majorAfter).toMatchObject({ status: "pending", gateStatus: "blocked", blockedReason: "MAJOR_CONFLICT" });
    expect(result.before.items[0]).toMatchObject({
      kind: "fact",
      kindLabel: "世界事实",
      semanticSummary: "银湾海岸 · 形成原因",
      contentPreview: "沉降纪元造成差异侵蚀与海水倒灌。",
      decision: "pending",
    });
    expect(result.reviewed).toMatchObject({ gateStatus: "ready" });
    expect(result.finalized).toMatchObject({ status: "committed" });
    expect(JSON.stringify(result)).not.toMatch(/payload|rawJson|sourceRef|e2e-(?:major-)?private-source|machinePath|debugMessage/i);

    await app.close();
    app = null;
    const reopened = openWorkspace(workspaceRoot);
    expect(new AssertionRepository(reopened).listCurrent()).toMatchObject([
      { assertionId: "assertion.e2e-coast", object: { text: "沉降纪元造成差异侵蚀与海水倒灌。" } },
    ]);
    reopened.close();
  } finally {
    if (app) await app.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("fails safely when Change Set review is requested without an open workspace", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  delete env.NOVAX_DESKTOP_E2E_WORKSPACE;
  const app = await electron.launch({ executablePath: electronPath, args: ["."], env });
  try {
    const page = await app.firstWindow();
    const result = await page.evaluate(async () => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.changeSet.listPending();
    });
    expect(result).toEqual({ ok: false, error: { code: "WORKSPACE_NOT_OPEN", message: "尚未打开工作区。" } });
    expect(JSON.stringify(result)).not.toMatch(/[A-Z]:\\|workspace\.db|debug/i);
  } finally {
    await app.close();
  }
});

class ContractLowRiskPolicy implements ChangeSetPolicyEvaluator {
  assess(candidate: ChangeSetCandidate) {
    return candidate.items.map((item) => ({ itemId: item.id, risk: "low" as const, conflicts: [] }));
  }
}

class ContractMajorConflictPolicy implements ChangeSetPolicyEvaluator {
  assess(candidate: ChangeSetCandidate) {
    return candidate.items.map((item) => ({
      itemId: item.id,
      risk: "elevated" as const,
      conflicts: [{ severity: "major" as const, code: "E2E_INTERNAL_CONFLICT" }],
    }));
  }
}

function launch(workspaceRoot: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: { ...process.env, NOVAX_DESKTOP_E2E_WORKSPACE: workspaceRoot },
  });
}
