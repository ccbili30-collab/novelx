import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrowthEditorialRepository } from "../../src/domain/growth/editorial/growthEditorialRepository";
import { SafeDiagnosticRepository } from "../../src/domain/audit/safeDiagnosticRepository";
import type {
  EditorialReviewRecord,
  EditorialRoundCreate,
  GrowthEditorialRoundSnapshot,
  GrowthWorkOrder,
  GrowthWorkOrderAttempt,
} from "../../src/domain/growth/editorial/growthEditorialTypes";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import {
  GrowthEditorialScheduler,
  GrowthEditorialSchedulerApplication,
} from "../../src/main/growth/editorial/growthEditorialScheduler";
import {
  GrowthWorkOrderRunner,
  type GrowthWorkOrderRunnerDependencies,
} from "../../src/main/growth/editorial/growthWorkOrderRunner";

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("Growth editorial scheduler", () => {
  it("persists the Director plan first and dispatches only dependency-ready work", async () => {
    const setup = createSetup();
    const log: string[] = [];
    let latestCheckpoint = setup.checkpointId;
    const dependencies = acceptedDependencies(setup.repository, {
      prepare: (order) => {
        expect(setup.repository.getRound("round-1")).not.toBeNull();
        log.push(`prepare:${order.id}`);
      },
      generate: (order) => { log.push(`generate:${order.id}`); },
      recheck: (order) => log.push(`recheck:${order.id}:${latestCheckpoint}`),
      commit: (order) => {
        log.push(`commit:${order.id}`);
        latestCheckpoint = order.id === "order-a" ? "checkpoint-after-a" : "checkpoint-after-b";
      },
    });
    const scheduler = createScheduler(setup.repository, dependencies);
    const result = await scheduler.startRound(round(setup, [
      order("order-a"),
      order("order-b", ["order-a"]),
    ]));

    expect(result.round.status).toBe("completed");
    expect(result.workOrders.map((item) => item.status)).toEqual(["committed", "committed"]);
    expect(log.indexOf("commit:order-a")).toBeLessThan(log.indexOf("prepare:order-b"));
    expect(log).toContain("recheck:order-b:checkpoint-after-a");
  });

  it("honors provider backpressure, defaults creative concurrency to three, and serializes commits", async () => {
    const setup = createSetup();
    let activeCreative = 0;
    let maxCreative = 0;
    let activeCommits = 0;
    let maxCommits = 0;
    const dependencies = acceptedDependencies(setup.repository, {
      generate: async () => {
        activeCreative += 1;
        maxCreative = Math.max(maxCreative, activeCreative);
        await immediate();
        activeCreative -= 1;
      },
      commit: async () => {
        activeCommits += 1;
        maxCommits = Math.max(maxCommits, activeCommits);
        await immediate();
        activeCommits -= 1;
      },
    });
    const scheduler = createScheduler(setup.repository, dependencies, { availableProviderSlots: () => 2 });
    const result = await scheduler.startRound(round(setup, [
      order("order-a"), order("order-b"), order("order-c"), order("order-d"),
    ]));

    expect(result.round.status).toBe("completed");
    expect(maxCreative).toBe(2);
    expect(maxCommits).toBe(1);
  });

  it("uses three creative slots by default when Provider capacity is higher", async () => {
    const setup = createSetup();
    let active = 0;
    let maximum = 0;
    const dependencies = acceptedDependencies(setup.repository, {
      generate: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await immediate();
        active -= 1;
      },
    });
    const scheduler = createScheduler(setup.repository, dependencies, { availableProviderSlots: () => 10 });
    const result = await scheduler.startRound(round(setup, [
      order("order-a"), order("order-b"), order("order-c"), order("order-d"),
    ]));
    expect(result.round.status).toBe("completed");
    expect(maximum).toBe(3);
  });

  it("returns without dispatch while Provider capacity is zero and resumes exactly once later", async () => {
    const setup = createSetup();
    let slots = 0;
    let generated = 0;
    const dependencies = acceptedDependencies(setup.repository, { generate: () => { generated += 1; } });
    const scheduler = createScheduler(setup.repository, dependencies, { availableProviderSlots: () => slots });
    const paused = await scheduler.startRound(round(setup, [order("order-a")]));
    expect(paused.workOrders[0]).toMatchObject({ status: "ready" });
    expect(generated).toBe(0);

    slots = 1;
    const completed = await scheduler.resumeRound("round-1");
    expect(completed.round.status).toBe("completed");
    expect(generated).toBe(1);
  });

  it("persists a completed candidate before cancellation and never dispatches remaining work", async () => {
    const setup = createSetup();
    const controller = new AbortController();
    const generated: string[] = [];
    const dependencies = acceptedDependencies(setup.repository, {
      generate: (order) => {
        generated.push(order.id);
        controller.abort();
      },
    });
    const scheduler = createScheduler(setup.repository, dependencies, { creativeConcurrency: 1 });
    const result = await scheduler.startRound(round(setup, [order("order-a"), order("order-b")]), controller.signal);

    expect(result.round.status).toBe("cancelled");
    expect(result.workOrders.map((item) => item.status)).toEqual(["cancelled", "cancelled"]);
    expect(generated).toEqual(["order-a"]);
    expect(result.attempts).toHaveLength(1);
    expect(result.artifacts).toEqual([expect.objectContaining({ workOrderId: "order-a", kind: "specialist_candidate" })]);
  });

  it("rechecks before side effects and fails the round without requesting a commit when stale", async () => {
    const setup = createSetup();
    let commits = 0;
    const dependencies = acceptedDependencies(setup.repository, {
      recheckResult: { status: "rejected", failureCode: "GROWTH_EDITORIAL_CHECKPOINT_STALE" },
      commit: () => { commits += 1; },
    });
    const scheduler = createScheduler(setup.repository, dependencies);
    const result = await scheduler.startRound(round(setup, [order("order-a")]));

    expect(result.round).toMatchObject({ status: "failed", failureCode: "GROWTH_EDITORIAL_CHECKPOINT_STALE" });
    expect(result.workOrders[0]).toMatchObject({ status: "failed", failureCode: "GROWTH_EDITORIAL_CHECKPOINT_STALE" });
    expect(result.attempts[0].sideEffectState).toBe("none");
    expect(commits).toBe(0);
    expect(new SafeDiagnosticRepository(setup.workspace).listOperation("tool_call", "order-a"))
      .toEqual([expect.objectContaining({
        code: "WORK_ORDER_STATE_CHECKPOINT_STALE",
        owner: "growth_phase",
        boundary: "phase_compile",
      })]);
  });

  it("classifies a dependency-blocked Work Order at the scheduler boundary", async () => {
    const setup = createSetup();
    const dependencies = acceptedDependencies(setup.repository, {
      generate: (candidateOrder) => {
        if (candidateOrder.id === "order-a") throw Object.assign(new Error("secret provider body"), { code: "PROVIDER_PROTOCOL_FAILED" });
      },
    });
    const scheduler = createScheduler(setup.repository, dependencies, { creativeConcurrency: 1 });
    const result = await scheduler.startRound(round(setup, [order("order-a"), order("order-b", ["order-a"])]));

    expect(result.workOrders.map((item) => item.status)).toEqual(["failed", "failed"]);
    const diagnostics = new SafeDiagnosticRepository(setup.workspace);
    expect(diagnostics.listOperation("tool_call", "order-a"))
      .toEqual([expect.objectContaining({ code: "PROVIDER_PROTOCOL_FAILED", owner: "provider" })]);
    expect(diagnostics.listOperation("tool_call", "order-b"))
      .toEqual([expect.objectContaining({ code: "WORK_ORDER_STATE_DEPENDENCY_FAILED", owner: "growth_phase" })]);
    expect(JSON.stringify([...diagnostics.listOperation("tool_call", "order-a"), ...diagnostics.listOperation("tool_call", "order-b")]))
      .not.toContain("secret provider body");
  });

  it("restarts accepted work without duplicating the candidate or committed Change Set", async () => {
    const setup = createSetup();
    seedAccepted(setup.repository, setup, "order-a");
    let generated = 0;
    let commits = 0;
    const dependencies = acceptedDependencies(setup.repository, {
      generate: () => { generated += 1; },
      commit: () => { commits += 1; },
    });
    const firstScheduler = createScheduler(setup.repository, dependencies);
    const first = await firstScheduler.resumeRound("round-1");
    expect(first.round.status).toBe("completed");
    expect(commits).toBe(1);
    expect(generated).toBe(0);

    const reopenedScheduler = createScheduler(setup.repository, dependencies);
    const replay = await reopenedScheduler.resumeRound("round-1");
    expect(replay.round.status).toBe("completed");
    expect(commits).toBe(1);
    expect(generated).toBe(0);
  });

  it("never reissues a commit whose persisted outcome is unknown", async () => {
    const setup = createSetup();
    seedAccepted(setup.repository, setup, "order-a");
    setup.repository.queueCommit("order-a");
    setup.repository.markCommitRequested("order-a");
    let commits = 0;
    const scheduler = createScheduler(setup.repository, acceptedDependencies(setup.repository, {
      commit: () => { commits += 1; },
    }));
    const result = await scheduler.resumeRound("round-1");

    expect(result.round.status).toBe("reconciliation_required");
    expect(result.workOrders[0].status).toBe("reconciliation_required");
    expect(result.attempts[0].sideEffectState).toBe("outcome_unknown");
    expect(commits).toBe(0);
    expect(new SafeDiagnosticRepository(setup.workspace).listOperation("tool_call", "order-a"))
      .toEqual([expect.objectContaining({
        code: "RECONCILIATION_REQUIRED",
        owner: "reconciliation",
        boundary: "recovery",
      })]);
  });

  it("keeps one scheduler and one commit lane per active workspace", () => {
    const setup = createSetup();
    const application = new GrowthEditorialSchedulerApplication();
    const dependencies = acceptedDependencies(setup.repository);
    const first = application.get(setup.workspace, dependencies);
    expect(application.get(setup.workspace, dependencies)).toBe(first);
    expect(() => application.get(setup.workspace, acceptedDependencies(setup.repository)))
      .toThrowError(expect.objectContaining({ code: "GROWTH_EDITORIAL_SCHEDULER_ALREADY_CONFIGURED" }));
    application.dispose();
  });
});

function createSetup(): { workspace: WorkspaceDatabase; repository: GrowthEditorialRepository; checkpointId: string; goalId: string } {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-editorial-scheduler-"));
  workspace = openWorkspace(root);
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
  const goal = new GrowthRepository(workspace).createGoal({
    id: "goal-1",
    idempotencyKey: "goal-1-key",
    branchId: branch.id,
    seed: { kind: "text", text: "构建因果世界" },
    authorizedScopeResourceIds: [world.id],
    initialRuleText: "所有结论必须有来源。",
    sourceMessageId: null,
  });
  const repository = new GrowthEditorialRepository(workspace);
  return { workspace, repository, checkpointId: branch.headCheckpointId, goalId: goal.id };
}

function round(
  setup: { checkpointId: string; goalId: string },
  workOrders: EditorialRoundCreate["workOrders"],
): EditorialRoundCreate {
  return {
    id: "round-1",
    goalId: setup.goalId,
    sourceCheckpointId: setup.checkpointId,
    ruleRevision: 1,
    idempotencyKey: "round-1-key",
    workOrders: workOrders.map((item) => ({ ...item, sourceCheckpointId: setup.checkpointId })),
  };
}

function order(id: string, dependencies: string[] = []): EditorialRoundCreate["workOrders"][number] {
  return {
    id,
    objective: `完成 ${id} 的来源绑定创作。`,
    sourceCheckpointId: "replaced-by-round",
    scopeRefs: ["@resource1"],
    capability: "world_system_author",
    acceptanceFacets: [{ id: "causality", description: "形成来源绑定的因果机制。", required: true }],
    dependencies,
  };
}

function createScheduler(
  repository: GrowthEditorialRepository,
  dependencies: GrowthWorkOrderRunnerDependencies,
  options: ConstructorParameters<typeof GrowthEditorialScheduler>[2] = {},
): GrowthEditorialScheduler {
  const runner = new GrowthWorkOrderRunner(repository, dependencies);
  return new GrowthEditorialScheduler(repository, runner, options);
}

function acceptedDependencies(
  repository: GrowthEditorialRepository,
  hooks: {
    prepare?: (order: GrowthWorkOrder) => void;
    generate?: (order: GrowthWorkOrder) => void | Promise<void>;
    recheck?: (order: GrowthWorkOrder) => void;
    recheckResult?: { status: "ready" } | { status: "rejected"; failureCode: string };
    commit?: (order: GrowthWorkOrder) => void | Promise<void>;
  } = {},
): GrowthWorkOrderRunnerDependencies {
  return {
    prepareAttempt: ({ order, snapshot }) => {
      hooks.prepare?.(order);
      const number = snapshot.attempts.filter((attempt) => attempt.workOrderId === order.id).length + 1;
      return {
        id: `${order.id}-attempt-${number}`,
        workOrderId: order.id,
        idempotencyKey: `${order.id}-attempt-${number}-key`,
        sourceCheckpointId: snapshot.round.sourceCheckpointId,
        ruleRevision: snapshot.round.ruleRevision,
        capability: order.capability,
        capabilityProfile: { id: "profile", version: "1.0.0", sha256: "3".repeat(64) },
        prompt: { id: "prompt", version: "1.0.0", sha256: "4".repeat(64) },
        model: { providerId: "provider", modelId: "model", providerConfigSha256: "5".repeat(64) },
      };
    },
    generateCandidate: async ({ order, attempt }) => {
      await hooks.generate?.(order);
      return candidate(attempt);
    },
    reviewCandidate: async ({ attempt }) => reviews(attempt),
    rebaseAndRecheck: async ({ order }) => {
      hooks.recheck?.(order);
      return hooks.recheckResult ?? { status: "ready" };
    },
    commitCandidate: async ({ order }) => { await hooks.commit?.(order); },
  };
}

function candidate(attempt: GrowthWorkOrderAttempt) {
  return {
    attemptId: attempt.id,
    outputSha256: "6".repeat(64),
    artifacts: [{
      kind: "specialist_candidate" as const,
      ordinal: 0,
      storeRef: `artifact://${attempt.id}/candidate`,
      contentSha256: "6".repeat(64),
    }],
  };
}

function reviews(attempt: GrowthWorkOrderAttempt): { checker: EditorialReviewRecord; director: EditorialReviewRecord } {
  return {
    checker: {
      id: `${attempt.id}-checker`, attemptId: attempt.id, reviewerKind: "checker", decision: "passed",
      safeSummary: "检查通过。", evidenceRefs: ["@evidence1"], artifactRef: `artifact://${attempt.id}/checker`,
      artifactSha256: "7".repeat(64), idempotencyKey: `${attempt.id}-checker-key`,
    },
    director: {
      id: `${attempt.id}-director`, attemptId: attempt.id, reviewerKind: "director", decision: "accept",
      safeSummary: "编辑验收通过。", evidenceRefs: ["@evidence1"], artifactRef: `artifact://${attempt.id}/director`,
      artifactSha256: "8".repeat(64), idempotencyKey: `${attempt.id}-director-key`,
    },
  };
}

function seedAccepted(
  repository: GrowthEditorialRepository,
  setup: { checkpointId: string; goalId: string },
  workOrderId: string,
): void {
  const created = repository.createRound(round(setup, [order(workOrderId)]));
  const dependencies = acceptedDependencies(repository);
  const prepared = dependencies.prepareAttempt({ order: created.workOrders[0], snapshot: created }) as ReturnType<GrowthWorkOrderRunnerDependencies["prepareAttempt"]>;
  if (prepared instanceof Promise) throw new Error("Unexpected async fixture preparation.");
  const attempt = repository.startAttempt(prepared);
  repository.recordCandidate(candidate(attempt));
  repository.beginReview(attempt.id);
  const review = reviews(attempt);
  repository.recordReview(review.checker);
  repository.recordReview(review.director);
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
