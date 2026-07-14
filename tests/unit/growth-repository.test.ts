import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";

let workspace: WorkspaceDatabase | undefined;
let root: string | undefined;

afterEach(() => {
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  workspace = undefined;
  root = undefined;
});

describe("GrowthRepository", () => {
  it("creates idempotent scoped Goals and only changes rules between Cycles", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const goal = createGoal(repository, setup);
    expect(createGoal(repository, setup).id).toBe(goal.id);
    expect(() => repository.createGoal({
      ...goalInput(setup), idempotencyKey: "goal-idempotency", initialRuleText: "changed",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_IDEMPOTENCY_KEY_REUSED" }));
    expect(() => repository.createGoal({
      ...goalInput(setup), id: "goal-invalid-scope", idempotencyKey: "goal-invalid-scope", authorizedScopeResourceIds: ["missing-scope"],
    })).toThrowError(expect.objectContaining({ code: "GROWTH_SCOPE_NOT_VISIBLE_AT_CHECKPOINT" }));
    repository.appendRule({ goalId: goal.id, expectedRevision: 1, ruleText: "second rule", sourceMessageId: null });
    const cycle = repository.beginCycle({ id: "cycle-1", goalId: goal.id, idempotencyKey: "cycle-idempotency", inputCheckpointId: setup.checkpointId, ruleRevision: 2 });
    expect(cycle.status).toBe("planned");
    expect(() => repository.appendRule({ goalId: goal.id, expectedRevision: 2, ruleText: "third rule", sourceMessageId: null }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RULE_CHANGE_REQUIRES_CYCLE_BOUNDARY" }));
    expect(() => repository.beginCycle({ id: "cycle-2", goalId: goal.id, idempotencyKey: "cycle-2", inputCheckpointId: setup.checkpointId, ruleRevision: 2 }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_OPEN_CYCLE_EXISTS" }));
  });

  it("pins Run, Receipt and committed Change Set to the same branch and checkpoints", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const goal = createGoal(repository, setup);
    const cycle = repository.beginCycle({ id: "cycle-1", goalId: goal.id, idempotencyKey: "cycle-idempotency", inputCheckpointId: setup.checkpointId, ruleRevision: 1 });
    const run = seedRun(setup.workspace, setup.branchId, setup.checkpointId);
    expect(repository.attachRun({ cycleId: cycle.id, runId: run.runId }).status).toBe("running");
    const receipt = receiptInput(setup, cycle.id, run);
    repository.recordReceipt(receipt);
    expect(() => repository.recordReceipt({ ...receipt, id: "receipt-2" })).toThrowError(expect.objectContaining({ code: "GROWTH_RECEIPT_BINDING_INVALID" }));
    const changeSet = new ChangeSetRepository(setup.workspace).propose({ idempotencyKey: "growth-change-set", mode: "free", summary: "growth output" });
    new ChangeSetRepository(setup.workspace).commit(changeSet.id, "growth output", () => undefined);
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id });
    expect(committed).toMatchObject({ status: "committed", changeSetId: changeSet.id, outputCheckpointId: expect.any(String) });
    expect(() => repository.beginCycle({ id: "cycle-2", goalId: goal.id, idempotencyKey: "cycle-2", inputCheckpointId: setup.checkpointId, ruleRevision: 1 }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CYCLE_INPUT_CHECKPOINT_MISMATCH" }));
    const next = repository.beginCycle({ id: "cycle-2", goalId: goal.id, idempotencyKey: "cycle-2", inputCheckpointId: committed.outputCheckpointId!, ruleRevision: 1 });
    expect(next.sequence).toBe(2);
  });

  it("fails closed on mismatches, reconciliation, and cross-Run event references", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const goal = createGoal(repository, setup);
    const cycle = repository.beginCycle({ id: "cycle-1", goalId: goal.id, idempotencyKey: "cycle-idempotency", inputCheckpointId: setup.checkpointId, ruleRevision: 1 });
    expect(() => repository.attachRun({ cycleId: cycle.id, runId: "missing-run" })).toThrowError(expect.objectContaining({ code: "GROWTH_RUN_REFERENCE_MISMATCH" }));
    const run = seedRun(setup.workspace, setup.branchId, setup.checkpointId);
    repository.attachRun({ cycleId: cycle.id, runId: run.runId });
    expect(() => repository.recordReceipt({ ...receiptInput(setup, cycle.id, run), checkpointId: "wrong-checkpoint" }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RECEIPT_REFERENCE_MISMATCH" }));
    const terminal = repository.terminalizeCycle({ cycleId: cycle.id, status: "reconciliation_required", failureCode: "OUTCOME_UNKNOWN" });
    expect(terminal.status).toBe("reconciliation_required");
    expect(() => repository.beginCycle({ id: "cycle-2", goalId: goal.id, idempotencyKey: "cycle-2", inputCheckpointId: setup.checkpointId, ruleRevision: 1 }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_GOAL_NOT_ACTIVE" }));
    expect(() => repository.appendEvent({
      goalId: goal.id, cycleId: cycle.id, runId: "other-run", sequence: 1, safeSummary: "bad event", phase: "cycle_terminal",
      targetKind: "resource", targetId: setup.scopeId, targetVersionId: null, durableState: "reconciliation_required", contentRef: null,
      createdAt: new Date().toISOString(),
    })).toThrowError(expect.objectContaining({ code: "GROWTH_EVENT_REFERENCE_MISMATCH" }));
  });

  it("rejects foreign-branch Runs, stale Change Set bases, and out-of-order events", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const goal = createGoal(repository, setup);
    const cycle = repository.beginCycle({ id: "cycle-1", goalId: goal.id, idempotencyKey: "cycle-idempotency", inputCheckpointId: setup.checkpointId, ruleRevision: 1 });
    const otherBranch = new CheckpointRepository(setup.workspace).createBranchFromCheckpoint(setup.checkpointId, "other");
    const foreignRun = seedRun(setup.workspace, otherBranch.id, setup.checkpointId);
    expect(() => repository.attachRun({ cycleId: cycle.id, runId: foreignRun.runId }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RUN_REFERENCE_MISMATCH" }));
    const run = seedRun(setup.workspace, setup.branchId, setup.checkpointId);
    repository.attachRun({ cycleId: cycle.id, runId: run.runId });
    repository.recordReceipt(receiptInput(setup, cycle.id, run));
    expect(() => repository.appendEvent({
      goalId: goal.id, cycleId: cycle.id, runId: run.runId, sequence: 2, safeSummary: "out of order", phase: "receipt_recorded",
      targetKind: "resource", targetId: setup.scopeId, targetVersionId: null, durableState: "running", contentRef: null, createdAt: new Date().toISOString(),
    })).toThrowError(expect.objectContaining({ code: "GROWTH_EVENT_SEQUENCE_INVALID" }));
    const unrelated = new ChangeSetRepository(setup.workspace).propose({ idempotencyKey: "unrelated", mode: "free", summary: "advance head" });
    new ChangeSetRepository(setup.workspace).commit(unrelated.id, "advance head", () => undefined);
    const staleBase = new ChangeSetRepository(setup.workspace).propose({ idempotencyKey: "stale-growth", mode: "free", summary: "stale growth" });
    new ChangeSetRepository(setup.workspace).commit(staleBase.id, "stale growth", () => undefined);
    expect(() => repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: staleBase.id }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CHANGE_SET_REFERENCE_MISMATCH" }));
  });

  it("rejects a committed Change Set whose output checkpoint is not on the Goal branch", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const goal = createGoal(repository, setup);
    const cycle = repository.beginCycle({ id: "cycle-1", goalId: goal.id, idempotencyKey: "cycle-idempotency", inputCheckpointId: setup.checkpointId, ruleRevision: 1 });
    const run = seedRun(setup.workspace, setup.branchId, setup.checkpointId);
    repository.attachRun({ cycleId: cycle.id, runId: run.runId });
    repository.recordReceipt(receiptInput(setup, cycle.id, run));
    const otherBranch = new CheckpointRepository(setup.workspace).createBranchFromCheckpoint(setup.checkpointId, "other-output");
    const otherCheckpointId = new CheckpointRepository(setup.workspace).appendCheckpoint(otherBranch.id, "other output checkpoint");
    const changeSet = new ChangeSetRepository(setup.workspace).propose({ idempotencyKey: "output-mismatch", mode: "free", summary: "output mismatch" });
    new ChangeSetRepository(setup.workspace).commit(changeSet.id, "output mismatch", () => undefined);
    setup.workspace.db.prepare("UPDATE change_sets SET committed_checkpoint_id = ? WHERE id = ?").run(otherCheckpointId, changeSet.id);
    expect(() => repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CHECKPOINT_BRANCH_MISMATCH" }));
  });
});

function createSetup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-"));
  workspace = openWorkspace(root);
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const scopeId = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!.id;
  return { workspace, branchId: branch.id, checkpointId: branch.headCheckpointId, scopeId };
}

function goalInput(setup: ReturnType<typeof createSetup>) {
  return {
    id: "goal-1", idempotencyKey: "goal-idempotency", branchId: setup.branchId, seed: { kind: "text" as const, text: "grow a coast" },
    authorizedScopeResourceIds: [setup.scopeId], initialRuleText: "keep sources", sourceMessageId: null,
  };
}

function createGoal(repository: GrowthRepository, setup: ReturnType<typeof createSetup>) {
  return repository.createGoal(goalInput(setup));
}

function seedRun(workspace: WorkspaceDatabase, branchId: string, checkpointId: string) {
  const runId = randomUUID();
  const invocationId = randomUUID();
  const toolInvocationId = randomUUID();
  const hash = createHash("sha256").update("growth", "utf8").digest("hex");
  const now = new Date().toISOString();
  workspace.db.prepare(`
    INSERT INTO agent_runs (id, workspace_id, branch_id, base_checkpoint_id, mode, user_input_sha256, provider_id, requested_model_id, provider_config_sha256, runtime_contract_version, created_at)
    VALUES (?, ?, ?, ?, 'free', ?, NULL, NULL, NULL, '1.0.0', ?)
  `).run(runId, workspace.workspaceId, branchId, checkpointId, hash, now);
  workspace.db.prepare(`
    INSERT INTO agent_invocations (
      id, run_id, parent_invocation_id, role, prompt_id, prompt_version, prompt_sha256, agent_profile_id, agent_profile_version,
      agent_profile_sha256, provider_id, requested_model_id, provider_config_sha256, tool_policy_id, tool_policy_version,
      tool_policy_sha256, authorized_tools_json, handoff_contract_id, handoff_version, handoff_payload_sha256, input_sha256, created_at
    ) VALUES (?, ?, NULL, 'steward', 'steward', '1.0.0', ?, 'profile', '1.0.0', ?, 'provider', 'model', ?, 'policy', '1.0.0', ?, '[]', NULL, NULL, NULL, ?, ?)
  `).run(invocationId, runId, hash, hash, hash, hash, hash, now);
  workspace.db.prepare("INSERT INTO agent_tool_invocations (id, run_id, invocation_id, tool_name, arguments_sha256, created_at) VALUES (?, ?, ?, 'retrieve_graph_evidence', ?, ?)")
    .run(toolInvocationId, runId, invocationId, hash, now);
  return { runId, toolInvocationId };
}

function receiptInput(setup: ReturnType<typeof createSetup>, cycleId: string, run: ReturnType<typeof seedRun>) {
  const hash = "a".repeat(64);
  return {
    id: "receipt-1", cycleId, runId: run.runId, toolInvocationId: run.toolInvocationId, branchId: setup.branchId,
    checkpointId: setup.checkpointId, lens: "creator" as const, effectiveScopeResourceIds: [setup.scopeId], query: "coast",
    aliases: [], validTime: null, recordedTime: null, maxHops: 1, cpuBudgetMs: 10, expansionBudget: 10, resultBudget: 10,
    tokenBudget: 10, policyVersion: "growth-retrieval-v1", queryHash: hash, resultHash: hash, hitCount: 0, conflictCount: 0,
    locatorCount: 0, coverage: { state: "complete" as const, searchedScopeCount: 1, omittedCount: 0 }, truncated: false,
    createdAt: new Date().toISOString(), links: [],
  };
}
