import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrowthEditorialRepository } from "../../src/domain/growth/editorial/growthEditorialRepository";
import type { EditorialRoundCreate, WorkOrderAttemptStart } from "../../src/domain/growth/editorial/growthEditorialTypes";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
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

describe("GrowthEditorialRepository", () => {
  it("replays an exact Round request and rejects a conflicting idempotency replay", () => {
    const setup = createSetup();
    const repository = new GrowthEditorialRepository(setup.workspace);
    const input = roundInput(setup);
    const first = repository.createRound(input);

    expect(repository.createRound(input)).toEqual(first);
    expect(first.workOrders.map((order) => [order.id, order.status])).toEqual([
      ["world-foundation", "ready"],
      ["civilization-layer", "planned"],
    ]);
    expect(() => repository.createRound({
      ...input,
      workOrders: input.workOrders.map((order, index) => index === 0 ? { ...order, objective: "冲突目标" } : order),
    })).toThrowError(expect.objectContaining({ code: "GROWTH_EDITORIAL_IDEMPOTENCY_KEY_REUSED" }));
  });

  it("unlocks dependencies only after accepted work is serially committed", () => {
    const setup = createSetup();
    const repository = new GrowthEditorialRepository(setup.workspace);
    repository.createRound(roundInput(setup));
    const attempt = repository.startAttempt(attemptInput(setup, "attempt-world-1", "world-foundation", "world_system_author"));
    repository.recordCandidate({
      attemptId: attempt.id,
      outputSha256: "2".repeat(64),
      artifacts: [{
        kind: "specialist_candidate",
        ordinal: 0,
        storeRef: "artifact://world-foundation/2",
        contentSha256: "2".repeat(64),
      }],
    });
    repository.beginReview(attempt.id);
    repository.recordReview(checkerReview(attempt.id));
    repository.recordReview(directorReview(attempt.id, "accept"));

    expect(repository.getWorkOrder("civilization-layer")?.status).toBe("planned");
    expect(repository.queueCommit("world-foundation").status).toBe("commit_queued");
    expect(repository.getAttempt(attempt.id)?.sideEffectState).toBe("none");
    expect(repository.markCommitRequested("world-foundation").sideEffectState).toBe("commit_requested");
    expect(repository.markCommitted("world-foundation").status).toBe("committed");
    expect(repository.getWorkOrder("civilization-layer")?.status).toBe("ready");
  });

  it("creates revisions as a new attempt owned by the same capability", () => {
    const setup = createSetup();
    const repository = new GrowthEditorialRepository(setup.workspace);
    repository.createRound(singleOrderRound(setup));
    const first = repository.startAttempt(attemptInput(setup, "attempt-revision-1", "world-foundation", "world_system_author"));
    makeReviewable(repository, first.id);
    repository.recordReview(checkerReview(first.id));
    repository.recordReview(directorReview(first.id, "revise"));

    expect(repository.getWorkOrder("world-foundation")?.status).toBe("revision_requested");
    expect(() => repository.startAttempt(attemptInput(
      setup, "attempt-wrong-owner", "world-foundation", "civilization_author",
    ))).toThrowError(expect.objectContaining({ code: "GROWTH_EDITORIAL_CAPABILITY_OWNER_MISMATCH" }));
    const second = repository.startAttempt(attemptInput(
      setup, "attempt-revision-2", "world-foundation", "world_system_author",
    ));
    expect(second).toMatchObject({ attemptNumber: 2, capability: "world_system_author", status: "running" });
  });

  it("recovers the full persisted Round snapshot after reopening SQLite", () => {
    const setup = createSetup();
    const repository = new GrowthEditorialRepository(setup.workspace);
    repository.createRound(singleOrderRound(setup));
    const attemptInputValue = attemptInput(setup, "attempt-recover", "world-foundation", "world_system_author");
    const attempt = repository.startAttempt(attemptInputValue);
    makeReviewable(repository, attempt.id);
    repository.recordReview(checkerReview(attempt.id));
    const before = repository.getRoundSnapshot("editorial-round");
    const rootPath = setup.workspace.rootPath;
    setup.workspace.close();
    workspace = undefined;

    workspace = openWorkspace(rootPath);
    const recovered = new GrowthEditorialRepository(workspace);
    expect(recovered.getRoundSnapshot("editorial-round")).toEqual(before);
    expect(recovered.startAttempt(attemptInputValue)).toMatchObject({ id: attempt.id, status: "reviewing" });
  });

  it.each(["cancelled", "failed"] as const)("terminalizes pre-side-effect work as %s without a second attempt", (status) => {
    const setup = createSetup();
    const repository = new GrowthEditorialRepository(setup.workspace);
    repository.createRound(singleOrderRound(setup));
    const attempt = repository.startAttempt(attemptInput(setup, `attempt-${status}`, "world-foundation", "world_system_author"));
    const terminal = repository.terminalizeWorkOrder({
      workOrderId: "world-foundation",
      status,
      failureCode: status === "cancelled" ? "GROWTH_EDITORIAL_CANCELLED" : "GROWTH_EDITORIAL_PROVIDER_FAILED",
    });

    expect(terminal.status).toBe(status);
    expect(repository.getAttempt(attempt.id)).toMatchObject({ status, terminalAt: expect.any(String) });
    expect(repository.terminalizeWorkOrder({
      workOrderId: "world-foundation",
      status,
      failureCode: terminal.failureCode!,
    })).toEqual(terminal);
    expect(() => repository.startAttempt(attemptInput(
      setup, `attempt-${status}-2`, "world-foundation", "world_system_author",
    ))).toThrowError(expect.objectContaining({ code: "GROWTH_EDITORIAL_WORK_ORDER_NOT_STARTABLE" }));
  });

  it("persists an unknown commit outcome and keeps every successor blocked", () => {
    const setup = createSetup();
    const repository = new GrowthEditorialRepository(setup.workspace);
    repository.createRound(roundInput(setup));
    const attempt = repository.startAttempt(attemptInput(setup, "attempt-unknown", "world-foundation", "world_system_author"));
    makeReviewable(repository, attempt.id);
    repository.recordReview(checkerReview(attempt.id));
    repository.recordReview(directorReview(attempt.id, "accept"));
    repository.queueCommit("world-foundation");
    repository.markCommitRequested("world-foundation");
    const input = {
      workOrderId: "world-foundation",
      attemptId: attempt.id,
      failureCode: "GROWTH_EDITORIAL_COMMIT_OUTCOME_UNKNOWN",
    } as const;
    const blocked = repository.markReconciliationRequired(input);

    expect(blocked.status).toBe("reconciliation_required");
    expect(repository.getAttempt(attempt.id)).toMatchObject({
      status: "reconciliation_required",
      sideEffectState: "outcome_unknown",
    });
    expect(repository.getRound("editorial-round")?.status).toBe("reconciliation_required");
    expect(repository.unlockReadyWorkOrders("editorial-round")).toEqual([]);
    expect(repository.getWorkOrder("civilization-layer")?.status).toBe("planned");
    expect(repository.markReconciliationRequired(input)).toEqual(blocked);
  });
});

function createSetup(): { workspace: WorkspaceDatabase; checkpointId: string; goalId: string } {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-editorial-repository-"));
  workspace = openWorkspace(root);
  const checkpoint = new CheckpointRepository(workspace).getActiveBranch();
  const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
  const goal = new GrowthRepository(workspace).createGoal({
    id: "editorial-goal",
    idempotencyKey: "editorial-goal-key",
    branchId: checkpoint.id,
    seed: { kind: "text", text: "构建可追溯因果世界" },
    authorizedScopeResourceIds: [world.id],
    initialRuleText: "所有正式结论必须有来源。",
    sourceMessageId: null,
  });
  return { workspace, checkpointId: checkpoint.headCheckpointId, goalId: goal.id };
}

function roundInput(setup: { checkpointId: string; goalId: string }): EditorialRoundCreate {
  return {
    id: "editorial-round",
    goalId: setup.goalId,
    sourceCheckpointId: setup.checkpointId,
    ruleRevision: 1,
    idempotencyKey: "editorial-round-key",
    workOrders: [
      {
        id: "world-foundation",
        objective: "建立世界系统和因果基础",
        sourceCheckpointId: setup.checkpointId,
        scopeRefs: ["@resource1"],
        capability: "world_system_author",
        acceptanceFacets: [{ id: "causal-foundation", description: "形成可验证的世界因果基础", required: true }],
        dependencies: [],
      },
      {
        id: "civilization-layer",
        objective: "基于世界基础形成文明发展链",
        sourceCheckpointId: setup.checkpointId,
        scopeRefs: ["@resource1"],
        capability: "civilization_author",
        acceptanceFacets: [{ id: "civilization-causality", description: "文明差异由明确机制驱动", required: true }],
        dependencies: ["world-foundation"],
      },
    ],
  };
}

function singleOrderRound(setup: { checkpointId: string; goalId: string }): EditorialRoundCreate {
  return { ...roundInput(setup), workOrders: [roundInput(setup).workOrders[0]!] };
}

function attemptInput(
  setup: { checkpointId: string },
  id: string,
  workOrderId: string,
  capability: WorkOrderAttemptStart["capability"],
): WorkOrderAttemptStart {
  return {
    id,
    workOrderId,
    idempotencyKey: `${id}-key`,
    sourceCheckpointId: setup.checkpointId,
    ruleRevision: 1,
    capability,
    capabilityProfile: { id: `${capability}-profile`, version: "1.0.0", sha256: "3".repeat(64) },
    prompt: { id: `${capability}-prompt`, version: "1.0.0", sha256: "4".repeat(64) },
    model: { providerId: "configured-provider", modelId: "configured-model", providerConfigSha256: "5".repeat(64) },
  };
}

function makeReviewable(repository: GrowthEditorialRepository, attemptId: string): void {
  repository.recordCandidate({
    attemptId,
    outputSha256: "6".repeat(64),
    artifacts: [{
      kind: "specialist_candidate",
      ordinal: 0,
      storeRef: `artifact://${attemptId}/candidate`,
      contentSha256: "6".repeat(64),
    }],
  });
  repository.beginReview(attemptId);
}

function checkerReview(attemptId: string) {
  return {
    id: `${attemptId}-checker-review`,
    attemptId,
    reviewerKind: "checker" as const,
    decision: "passed" as const,
    safeSummary: "来源与连续性检查通过。",
    evidenceRefs: ["evidence://world-foundation"],
    artifactRef: `artifact://${attemptId}/checker-review`,
    artifactSha256: "7".repeat(64),
    idempotencyKey: `${attemptId}-checker-review-key`,
  };
}

function directorReview(attemptId: string, decision: "accept" | "revise") {
  return {
    id: `${attemptId}-director-review`,
    attemptId,
    reviewerKind: "director" as const,
    decision,
    safeSummary: decision === "accept" ? "编辑验收通过。" : "保持原作者并要求定向返工。",
    evidenceRefs: ["evidence://world-foundation"],
    artifactRef: `artifact://${attemptId}/director-review`,
    artifactSha256: "8".repeat(64),
    idempotencyKey: `${attemptId}-director-review-key`,
  };
}
