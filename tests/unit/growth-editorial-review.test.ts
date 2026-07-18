import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrowthEditorialRepository } from "../../src/domain/growth/editorial/growthEditorialRepository";
import type {
  EditorialReviewRecord,
  GrowthEditorialRoundSnapshot,
  GrowthWorkOrder,
  GrowthWorkOrderAttempt,
} from "../../src/domain/growth/editorial/growthEditorialTypes";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { GrowthEditorialScheduler } from "../../src/main/growth/editorial/growthEditorialScheduler";
import {
  GrowthEditorialReviewCoordinator,
  prepareSameOwnerRevisionAttempt,
  type EditorialPipelineFinding,
  type GrowthEditorialReviewDependencies,
} from "../../src/main/growth/editorial/growthEditorialReviewCoordinator";
import { GrowthWorkOrderRunner, type GrowthWorkOrderRunnerDependencies } from "../../src/main/growth/editorial/growthWorkOrderRunner";
import type { CheckerReview, DirectorReview } from "../../src/shared/growthEditorialContract";

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("Growth editorial review coordinator", () => {
  it("runs deterministic validation, Graph Curator, Checker and Director in fixed order", async () => {
    const setup = createReviewingSetup();
    const log: string[] = [];
    const coordinator = new GrowthEditorialReviewCoordinator(reviewDependencies({
      log,
      directorReview: reviseReview(),
    }));
    const result = await coordinator.review(reviewInput(setup));

    expect(log).toEqual(["deterministic", "graph", "checker", "director"]);
    expect(result).toMatchObject({ director: { decision: "revise" }, escalation: null });
    expect(result.director.evidenceRefs).toEqual(["@evidence1"]);
    setup.repository.recordReview(result.checker);
    setup.repository.recordReview(result.director);
    expect(setup.repository.getWorkOrder("order-a")?.status).toBe("revision_requested");
  });

  it("overrides Director acceptance when a hard Domain or Checker finding remains", async () => {
    const setup = createReviewingSetup();
    const policies: string[] = [];
    const hard = finding("blocking", "经济机制与来源冲突。");
    const coordinator = new GrowthEditorialReviewCoordinator(reviewDependencies({
      deterministicFindings: [hard],
      checkerReview: blockedChecker(hard),
      directorReview: acceptReview(),
      policies,
    }));
    const result = await coordinator.review(reviewInput(setup));

    expect(result.director).toMatchObject({
      decision: "revise",
      safeSummary: "阻塞发现覆盖了 Director 接受决定，已要求同所有者返工。",
      artifactRef: "artifact://policy/hard_finding",
    });
    expect(policies).toEqual(["hard_finding"]);
    expect(result.director.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("copies the original owner profile, Prompt and model into every revision attempt", () => {
    const setup = createReviewingSetup();
    const first = setup.attempt;
    setup.repository.recordReview(checkerRecord(first, "1".repeat(64)));
    setup.repository.recordReview(directorRecord(first, "revise"));
    const snapshot = setup.repository.getRoundSnapshot("round-1")!;
    const order = snapshot.workOrders[0];
    const prepared = prepareSameOwnerRevisionAttempt({
      order,
      snapshot,
      attemptId: "attempt-2",
      idempotencyKey: "attempt-2-key",
    });

    expect(prepared).toMatchObject({
      workOrderId: first.workOrderId,
      capability: first.capability,
      capabilityProfile: first.capabilityProfile,
      prompt: first.prompt,
      model: first.model,
    });
    expect(setup.repository.startAttempt(prepared)).toMatchObject({ attemptNumber: 2, capability: first.capability });
  });

  it("escalates an unchanged Checker result instead of starting a no-progress revision", async () => {
    const setup = createReviewingSetup();
    persistRevision(setup.repository, setup.attempt, "a".repeat(64));
    const second = startReviewingRevision(setup.repository, "attempt-2");
    const policies: string[] = [];
    const coordinator = new GrowthEditorialReviewCoordinator(reviewDependencies({
      checkerReview: findingsChecker(finding("major", "仍有同一发现。")),
      checkerArtifactSha256: "a".repeat(64),
      directorReview: reviseReview(),
      policies,
    }));
    const result = await coordinator.review(reviewInput({ ...setup, attempt: second }));

    expect(result).toMatchObject({ director: { decision: "ask_user" }, escalation: "ask_user" });
    expect(policies).toEqual(["no_progress"]);
  });

  it("defaults to two revisions, persists ask_user, and prevents automatic redispatch", async () => {
    const setup = createReviewingSetup();
    persistRevision(setup.repository, setup.attempt, "a".repeat(64));
    const second = startReviewingRevision(setup.repository, "attempt-2");
    persistRevision(setup.repository, second, "b".repeat(64));
    const third = startReviewingRevision(setup.repository, "attempt-3");
    const coordinator = new GrowthEditorialReviewCoordinator(reviewDependencies({
      checkerArtifactSha256: "c".repeat(64),
      directorReview: reviseReview(),
    }));
    const result = await coordinator.review(reviewInput({ ...setup, attempt: third }));
    setup.repository.recordReview(result.checker);
    setup.repository.recordReview(result.director);
    expect(result).toMatchObject({ director: { decision: "ask_user" }, escalation: "ask_user" });

    let prepared = 0;
    const runnerDependencies = dormantRunnerDependencies(() => { prepared += 1; });
    const scheduler = new GrowthEditorialScheduler(
      setup.repository,
      new GrowthWorkOrderRunner(setup.repository, runnerDependencies),
    );
    const paused = await scheduler.resumeRound("round-1");
    expect(paused.workOrders[0].status).toBe("revision_requested");
    expect(prepared).toBe(0);
  });

  it("rejects findings and Director reasons outside the original acceptance facets", async () => {
    const setup = createReviewingSetup();
    const forged = { ...finding("major", "越权维度。"), facetId: "geography" };
    const coordinator = new GrowthEditorialReviewCoordinator(reviewDependencies({ deterministicFindings: [forged] }));
    await expect(coordinator.review(reviewInput(setup))).rejects.toMatchObject({
      code: "GROWTH_EDITORIAL_REVIEW_FACET_MISMATCH",
    });
  });

  it("stops the ordered review pipeline at a cancellation boundary", async () => {
    const setup = createReviewingSetup();
    const controller = new AbortController();
    const log: string[] = [];
    const dependencies = reviewDependencies({ log });
    const coordinator = new GrowthEditorialReviewCoordinator({
      ...dependencies,
      deterministicValidate: async () => {
        log.push("deterministic");
        controller.abort();
        return { findings: [] };
      },
    });
    await expect(coordinator.review({ ...reviewInput(setup), signal: controller.signal }))
      .rejects.toMatchObject({ code: "AGENT_RUN_CANCELLED" });
    expect(log).toEqual(["deterministic"]);
  });
});

function createReviewingSetup(): {
  workspace: WorkspaceDatabase;
  repository: GrowthEditorialRepository;
  checkpointId: string;
  goalId: string;
  attempt: GrowthWorkOrderAttempt;
} {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-editorial-review-"));
  workspace = openWorkspace(root);
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
  const goal = new GrowthRepository(workspace).createGoal({
    id: "goal-1", idempotencyKey: "goal-1-key", branchId: branch.id,
    seed: { kind: "text", text: "构建因果世界" }, authorizedScopeResourceIds: [world.id],
    initialRuleText: "所有结论必须有来源。", sourceMessageId: null,
  });
  const repository = new GrowthEditorialRepository(workspace);
  repository.createRound({
    id: "round-1", goalId: goal.id, sourceCheckpointId: branch.headCheckpointId, ruleRevision: 1,
    idempotencyKey: "round-1-key",
    workOrders: [{
      id: "order-a", objective: "补全经济因果。", sourceCheckpointId: branch.headCheckpointId,
      scopeRefs: ["@resource1"], capability: "civilization_author",
      acceptanceFacets: [{ id: "economy", description: "经济机制形成来源闭环。", required: true }], dependencies: [],
    }],
  });
  const attempt = startAttempt(repository, "attempt-1");
  return { workspace, repository, checkpointId: branch.headCheckpointId, goalId: goal.id, attempt };
}

function startAttempt(repository: GrowthEditorialRepository, id: string): GrowthWorkOrderAttempt {
  const snapshot = repository.getRoundSnapshot("round-1")!;
  const order = snapshot.workOrders[0];
  const attempt = repository.startAttempt({
    id, workOrderId: order.id, idempotencyKey: `${id}-key`, sourceCheckpointId: snapshot.round.sourceCheckpointId,
    ruleRevision: snapshot.round.ruleRevision, capability: order.capability,
    capabilityProfile: { id: "civilization-profile", version: "1.0.0", sha256: "3".repeat(64) },
    prompt: { id: "civilization-prompt", version: "1.0.0", sha256: "4".repeat(64) },
    model: { providerId: "provider", modelId: "model", providerConfigSha256: "5".repeat(64) },
  });
  repository.recordCandidate({
    attemptId: attempt.id, outputSha256: "6".repeat(64),
    artifacts: [{ kind: "specialist_candidate", ordinal: 0, storeRef: `artifact://${id}/candidate`, contentSha256: "6".repeat(64) }],
  });
  return repository.beginReview(attempt.id);
}

function startReviewingRevision(repository: GrowthEditorialRepository, id: string): GrowthWorkOrderAttempt {
  const snapshot = repository.getRoundSnapshot("round-1")!;
  const prepared = prepareSameOwnerRevisionAttempt({ order: snapshot.workOrders[0], snapshot, attemptId: id, idempotencyKey: `${id}-key` });
  const attempt = repository.startAttempt(prepared);
  repository.recordCandidate({
    attemptId: attempt.id, outputSha256: "6".repeat(64),
    artifacts: [{ kind: "specialist_candidate", ordinal: 0, storeRef: `artifact://${id}/candidate`, contentSha256: "6".repeat(64) }],
  });
  return repository.beginReview(attempt.id);
}

function persistRevision(repository: GrowthEditorialRepository, attempt: GrowthWorkOrderAttempt, checkerSha: string): void {
  repository.recordReview(checkerRecord(attempt, checkerSha));
  repository.recordReview(directorRecord(attempt, "revise"));
}

function reviewInput(setup: { repository: GrowthEditorialRepository; attempt: GrowthWorkOrderAttempt }) {
  const snapshot = setup.repository.getRoundSnapshot("round-1")!;
  return {
    order: snapshot.workOrders[0],
    attempt: setup.attempt,
    snapshot,
    signal: new AbortController().signal,
  };
}

function reviewDependencies(options: {
  log?: string[];
  deterministicFindings?: EditorialPipelineFinding[];
  checkerReview?: CheckerReview;
  checkerArtifactSha256?: string;
  directorReview?: DirectorReview;
  policies?: string[];
} = {}): GrowthEditorialReviewDependencies {
  const log = options.log ?? [];
  return {
    deterministicValidate: async () => { log.push("deterministic"); return { findings: options.deterministicFindings ?? [] }; },
    curateGraph: async () => { log.push("graph"); return { findings: [], artifact: artifact("graph") }; },
    check: async () => {
      log.push("checker");
      return {
        review: options.checkerReview ?? passedChecker(), safeSummary: "Checker 审查完成。",
        artifact: { ref: "artifact://checker", sha256: options.checkerArtifactSha256 ?? "a".repeat(64) },
      };
    },
    direct: async () => {
      log.push("director");
      return { review: options.directorReview ?? acceptReview(), safeSummary: "Director 审查完成。", artifact: artifact("director") };
    },
    persistPolicyDecision: async ({ review, reason }) => {
      options.policies?.push(reason);
      return { ref: `artifact://policy/${reason}`, sha256: sha256(JSON.stringify({ reason, review })) };
    },
  };
}

function passedChecker(): CheckerReview {
  return { decision: "passed", summary: "检查通过。", findings: [] };
}

function blockedChecker(item: EditorialPipelineFinding): CheckerReview {
  return {
    decision: "blocked", summary: "存在阻塞发现。",
    findings: [{ ...item, category: "causality" }],
  };
}

function findingsChecker(item: EditorialPipelineFinding): CheckerReview {
  return {
    decision: "findings", summary: "仍有检查发现。",
    findings: [{ ...item, category: "coverage" }],
  };
}

function acceptReview(): DirectorReview {
  return { decision: "accept", reasons: [{ facetId: "economy", reason: "编辑方向可接受。", evidenceRefs: ["@evidence1"] }] };
}

function reviseReview(): DirectorReview {
  return {
    decision: "revise", reasons: [{ facetId: "economy", reason: "内容有效但深度不足。", evidenceRefs: ["@evidence1"] }],
    revisionObjective: "补全资源、运输和市场之间的机制。",
  };
}

function finding(severity: "minor" | "major" | "blocking", summary: string): EditorialPipelineFinding {
  return { facetId: "economy", severity, summary, evidenceRefs: ["@evidence1"] };
}

function artifact(kind: string) {
  return { ref: `artifact://${kind}`, sha256: sha256(kind) };
}

function checkerRecord(attempt: GrowthWorkOrderAttempt, artifactSha256: string): EditorialReviewRecord {
  return {
    id: `${attempt.id}-checker`, attemptId: attempt.id, reviewerKind: "checker", decision: "findings",
    safeSummary: "仍有同一发现。", evidenceRefs: ["@evidence1"], artifactRef: `artifact://${attempt.id}/checker`,
    artifactSha256, idempotencyKey: `${attempt.id}-checker-key`,
  };
}

function directorRecord(attempt: GrowthWorkOrderAttempt, decision: "revise"): EditorialReviewRecord {
  return {
    id: `${attempt.id}-director`, attemptId: attempt.id, reviewerKind: "director", decision,
    safeSummary: "要求同所有者返工。", evidenceRefs: ["@evidence1"], artifactRef: `artifact://${attempt.id}/director`,
    artifactSha256: sha256(`${attempt.id}-director`), idempotencyKey: `${attempt.id}-director-key`,
  };
}

function dormantRunnerDependencies(onPrepare: () => void): GrowthWorkOrderRunnerDependencies {
  return {
    prepareAttempt: () => { onPrepare(); throw new Error("must not dispatch"); },
    generateCandidate: async () => { throw new Error("must not generate"); },
    reviewCandidate: async () => { throw new Error("must not review"); },
    rebaseAndRecheck: async () => ({ status: "ready" }),
    commitCandidate: async () => { throw new Error("must not commit"); },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
