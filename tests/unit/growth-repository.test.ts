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
  it("reads one exact historical rule revision and rejects a missing revision", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const goal = createGoal(repository, setup);
    repository.appendRule({ goalId: goal.id, expectedRevision: 1, ruleText: "second rule", sourceMessageId: "message-rule-2" });

    expect(repository.getRuleRevision(goal.id, 1)).toMatchObject({
      goalId: goal.id,
      revision: 1,
      ruleText: "keep sources",
    });
    expect(() => repository.getRuleRevision(goal.id, 3))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RULE_REVISION_NOT_FOUND" }));
  });

  it("lists rule revisions in bounded revision order", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const goal = createGoal(repository, setup);
    repository.appendRule({ goalId: goal.id, expectedRevision: 1, ruleText: "second rule", sourceMessageId: "message-rule-2" });
    repository.appendRule({ goalId: goal.id, expectedRevision: 2, ruleText: "third rule", sourceMessageId: "message-rule-3" });

    expect(repository.listRuleRevisions(goal.id, { fromRevision: 2, limit: 1 }))
      .toEqual([repository.getRuleRevision(goal.id, 2)]);
    expect(repository.listRuleRevisions(goal.id, { limit: 100 }).map((rule) => rule.revision)).toEqual([1, 2, 3]);
    expect(() => repository.listRuleRevisions(goal.id, { limit: 101 }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RULE_LIST_BOUNDS_INVALID" }));
  });

  it("replays an exact old append request after later revisions exist", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const goal = createGoal(repository, setup);
    const oldRequest = { goalId: goal.id, expectedRevision: 1, ruleText: "second rule", sourceMessageId: "message-rule-2" };
    const second = repository.appendRule(oldRequest);
    repository.appendRule({ goalId: goal.id, expectedRevision: 2, ruleText: "third rule", sourceMessageId: "message-rule-3" });

    expect(repository.appendRule(oldRequest)).toEqual(second);
    expect(repository.getGoal(goal.id)?.currentRuleRevision).toBe(3);
  });

  it("rejects reusing one source message for different rule content", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const goal = createGoal(repository, setup);
    repository.appendRule({ goalId: goal.id, expectedRevision: 1, ruleText: "second rule", sourceMessageId: "message-rule-2" });

    expect(() => repository.appendRule({
      goalId: goal.id,
      expectedRevision: 2,
      ruleText: "conflicting content",
      sourceMessageId: "message-rule-2",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_RULE_REVISION_MISMATCH" }));
    expect(repository.getGoal(goal.id)?.currentRuleRevision).toBe(2);
  });

  it.each(["failed", "blocked", "reconciliation_required"] as const)(
    "allows rule metadata append after a %s Cycle without changing the terminal Cycle",
    (status) => {
      const setup = createSetup();
      const repository = new GrowthRepository(setup.workspace);
      const goal = createGoal(repository, setup);
      const cycle = repository.beginCycle({
        id: "cycle-1",
        goalId: goal.id,
        idempotencyKey: "cycle-idempotency",
        inputCheckpointId: setup.checkpointId,
        ruleRevision: 1,
      });
      repository.terminalizeCycle({ cycleId: cycle.id, status, failureCode: "STOPPED" });

      expect(repository.appendRule({
        goalId: goal.id,
        expectedRevision: 1,
        ruleText: `rule after ${status}`,
        sourceMessageId: `message-after-${status}`,
      }).revision).toBe(2);
      expect(repository.getCycle(cycle.id)).toMatchObject({ status, ruleRevision: 1, failureCode: "STOPPED" });
      expect(() => repository.beginCycle({
        id: "cycle-2",
        goalId: goal.id,
        idempotencyKey: "cycle-2-idempotency",
        inputCheckpointId: setup.checkpointId,
        ruleRevision: 2,
      })).toThrowError(expect.objectContaining({ code: "GROWTH_GOAL_NOT_ACTIVE" }));
    },
  );

  it("allows only one competing repository connection to win the same CAS revision", () => {
    const setup = createSetup();
    const competitorWorkspace = openWorkspace(setup.workspace.rootPath);
    try {
      const first = new GrowthRepository(setup.workspace);
      const competitor = new GrowthRepository(competitorWorkspace);
      const goal = createGoal(first, setup);

      expect(first.appendRule({
        goalId: goal.id,
        expectedRevision: 1,
        ruleText: "winner",
        sourceMessageId: "message-winner",
      }).revision).toBe(2);
      expect(() => competitor.appendRule({
        goalId: goal.id,
        expectedRevision: 1,
        ruleText: "loser",
        sourceMessageId: "message-loser",
      })).toThrowError(expect.objectContaining({ code: "GROWTH_RULE_REVISION_MISMATCH" }));
      expect(competitor.listRuleRevisions(goal.id, { limit: 100 }).map((rule) => rule.ruleText))
        .toEqual(["keep sources", "winner"]);
    } finally {
      competitorWorkspace.close();
    }
  });

  it("replays persisted rule history after reopening SQLite", () => {
    const setup = createSetup();
    const goal = createGoal(new GrowthRepository(setup.workspace), setup);
    new GrowthRepository(setup.workspace).appendRule({
      goalId: goal.id,
      expectedRevision: 1,
      ruleText: "persist across reopen",
      sourceMessageId: "message-persisted",
    });
    const rootPath = setup.workspace.rootPath;
    setup.workspace.close();
    workspace = undefined;

    const reopened = openWorkspace(rootPath);
    workspace = reopened;
    const repository = new GrowthRepository(reopened);
    expect(repository.getRuleRevision(goal.id, 2)).toMatchObject({
      revision: 2,
      ruleText: "persist across reopen",
      sourceMessageId: "message-persisted",
    });
    expect(repository.listRuleRevisions(goal.id, { limit: 100 }).map((rule) => rule.revision)).toEqual([1, 2]);
  });

  it("persists a new rule revision while a running Cycle remains pinned to its original revision", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);

    const revision = repository.appendRule({
      goalId: goal.id,
      expectedRevision: 1,
      ruleText: "apply only to the next Cycle",
      sourceMessageId: "message-rule-2",
    });

    expect(revision).toMatchObject({ goalId: goal.id, revision: 2, ruleText: "apply only to the next Cycle" });
    expect(repository.getGoal(goal.id)?.currentRuleRevision).toBe(2);
    expect(repository.getCycle(cycle.id)).toMatchObject({
      status: "running",
      ruleRevision: 1,
      inputCheckpointId: setup.checkpointId,
      runId: run.runId,
    });
  });

  it("creates idempotent scoped Goals and replays rule, Run, Receipt and Change Set bindings", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const goal = createGoal(repository, setup);
    expect(createGoal(repository, setup).id).toBe(goal.id);
    expect(() => repository.createGoal({ ...goalInput(setup), initialRuleText: "changed" }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_IDEMPOTENCY_KEY_REUSED" }));
    const rule = repository.appendRule({ goalId: goal.id, expectedRevision: 1, ruleText: "second rule", sourceMessageId: null });
    expect(repository.appendRule({ goalId: goal.id, expectedRevision: 1, ruleText: "second rule", sourceMessageId: null })).toEqual(rule);
    expect(() => repository.appendRule({ goalId: goal.id, expectedRevision: 1, ruleText: "different", sourceMessageId: null }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RULE_REVISION_MISMATCH" }));
    const cycle = repository.beginCycle({ id: "cycle-1", goalId: goal.id, idempotencyKey: "cycle-idempotency", inputCheckpointId: setup.checkpointId, ruleRevision: 2 });
    expect(repository.listCycles(goal.id)).toEqual([cycle]);
    expect(repository.appendRule({ goalId: goal.id, expectedRevision: 2, ruleText: "third rule", sourceMessageId: null }).revision).toBe(3);
    expect(repository.getCycle(cycle.id)?.ruleRevision).toBe(2);
    const run = seedRun(setup.workspace, setup.branchId, setup.checkpointId);
    expect(repository.attachRun({ cycleId: cycle.id, runId: run.runId }).status).toBe("running");
    expect(repository.attachRun({ cycleId: cycle.id, runId: run.runId }).status).toBe("running");
    const receipt = repository.recordReceipt(receiptInput(setup, cycle.id, run));
    expect(repository.recordReceipt(receiptInput(setup, cycle.id, run))).toEqual(receipt);
    const changeSet = committedChangeSet(setup.workspace, "growth-change-set", "growth output");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id });
    expect(repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id })).toEqual(committed);
    expect(committed).toMatchObject({ status: "committed", changeSetId: changeSet.id, outputCheckpointId: expect.any(String) });
  });

  it("derives receipt audit values, supports immutable replay, and rebuilds the persisted output", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { cycle, run } = runningCycle(repository, setup);
    const input = receiptInput(setup, cycle.id, run, { links: [receiptLink(setup)] });
    const first = repository.recordReceipt(input);
    expect(first).toMatchObject({ hitCount: 1, conflictCount: 0, locatorCount: 0, queryHash: expect.stringMatching(/^[a-f0-9]{64}$/), resultHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(first.createdAt).not.toBeUndefined();
    expect(repository.recordReceipt(input)).toEqual(first);
    expect(repository.getReceipt(first.id)).toEqual(first);
    expect(() => repository.recordReceipt({ ...input, query: "different query" }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RECEIPT_REPLAY_MISMATCH" }));
  });

  it("verifies Receipt targets, budgets and stable locators at the pinned checkpoint", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { cycle, run } = runningCycle(repository, setup);
    expect(() => repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [{ ...receiptLink(setup), targetId: "missing", targetVersionId: "missing-version" }] })))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RECEIPT_LINK_NOT_VISIBLE" }));
    const foreignResourceVersion = foreignResourceRevision(setup);
    expect(() => repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [{ ...receiptLink(setup), targetVersionId: foreignResourceVersion }] })))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RECEIPT_LINK_NOT_VISIBLE" }));
    const foreignDocument = foreignDocumentVersion(setup);
    expect(() => repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [{ ...receiptLink(setup), stableLocator: "foreign:1", stableVersionId: foreignDocument.versionId, stableHash: foreignDocument.contentHash }] })))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RECEIPT_LOCATOR_INVALID" }));
    const pinnedDocument = pinnedDocumentVersion(setup);
    expect(() => repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [{ ...receiptLink(setup), targetKind: "document", targetId: "wrong-document", targetVersionId: pinnedDocument.versionId }] })))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RECEIPT_LINK_NOT_VISIBLE" }));
    expect(() => repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [{ ...receiptLink(setup), stableLocator: "line:1", stableVersionId: pinnedDocument.versionId, stableHash: "a".repeat(64) }] })))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RECEIPT_LOCATOR_INVALID" }));
    const valid = repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [{ ...receiptLink(setup), stableLocator: "line:1", stableVersionId: pinnedDocument.versionId, stableHash: pinnedDocument.contentHash }] }));
    expect(valid.locatorCount).toBe(1);
  });

  it("uses repository event time, replays exact events and lists monotonic history", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);
    const input = eventInput(goal.id, cycle.id, run.runId, 1, setup.scopeId);
    const first = repository.appendEvent(input);
    expect(first.createdAt).not.toBeUndefined();
    expect(repository.appendEvent(input)).toEqual(first);
    expect(repository.listEvents(goal.id)).toEqual([first]);
    expect(() => repository.appendEvent({ ...input, safeSummary: "different" }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_EVENT_REPLAY_MISMATCH" }));
    expect(() => repository.appendEvent({ ...eventInput(goal.id, cycle.id, run.runId, 3, setup.scopeId), safeSummary: "out of order" }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_EVENT_SEQUENCE_INVALID" }));
  });

  it("verifies Event targets at the Cycle checkpoint and terminalizes idempotently", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);
    expect(() => repository.appendEvent(eventInput(goal.id, cycle.id, run.runId, 1, "missing-resource")))
      .toThrowError(expect.objectContaining({ code: "GROWTH_EVENT_TARGET_NOT_VISIBLE" }));
    expect(() => repository.appendEvent({ ...eventInput(goal.id, cycle.id, run.runId, 1, setup.scopeId), targetKind: "document", targetVersionId: null }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_EVENT_TARGET_NOT_VISIBLE" }));
    const foreignDocument = foreignDocumentVersion(setup);
    expect(() => repository.appendEvent({ ...eventInput(goal.id, cycle.id, run.runId, 1, foreignDocument.documentId), targetKind: "document", targetVersionId: foreignDocument.versionId }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_EVENT_TARGET_NOT_VISIBLE" }));
    expect(repository.appendEvent(eventInput(goal.id, cycle.id, run.runId, 1, setup.scopeId)).targetId).toBe(setup.scopeId);
    const terminal = repository.terminalizeCycle({ cycleId: cycle.id, status: "failed", failureCode: "RETRY_LATER" });
    expect(repository.terminalizeCycle({ cycleId: cycle.id, status: "failed", failureCode: "RETRY_LATER" })).toEqual(terminal);
    expect(() => repository.terminalizeCycle({ cycleId: cycle.id, status: "failed", failureCode: "DIFFERENT" }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CYCLE_ALREADY_TERMINAL" }));
  });

  it("fails closed for mismatched receipt and Run references, reconciliation, and future ContentRefs", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);
    expect(() => repository.recordReceipt({ ...receiptInput(setup, cycle.id, run), checkpointId: "wrong-checkpoint" }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_RECEIPT_REFERENCE_MISMATCH" }));
    const foreign = foreignDocumentVersion(setup);
    expect(() => repository.appendEvent({
      ...eventInput(goal.id, cycle.id, run.runId, 1, setup.scopeId),
      contentRef: { kind: "document", targetId: foreign.documentId, targetVersionId: foreign.versionId },
    })).toThrowError(expect.objectContaining({ code: "GROWTH_CONTENT_REFERENCE_NOT_VISIBLE" }));
    const terminal = repository.terminalizeCycle({ cycleId: cycle.id, status: "reconciliation_required", failureCode: "OUTCOME_UNKNOWN" });
    expect(terminal.status).toBe("reconciliation_required");
    expect(() => repository.beginCycle({ id: "cycle-2", goalId: goal.id, idempotencyKey: "cycle-2", inputCheckpointId: setup.checkpointId, ruleRevision: 1 }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_GOAL_NOT_ACTIVE" }));
    expect(() => repository.appendEvent({ ...eventInput(goal.id, cycle.id, "other-run", 1, setup.scopeId), durableState: "reconciliation_required", phase: "cycle_terminal" }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_EVENT_REFERENCE_MISMATCH" }));
  });

  it("rejects resource and source-document seed revisions that are only on a future or foreign branch", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const foreignResource = foreignResourceRevision(setup);
    expect(() => repository.createGoal({
      ...goalInput(setup), id: "resource-seed", idempotencyKey: "resource-seed",
      seed: { kind: "resource", resourceId: setup.scopeId, resourceVersionId: foreignResource },
    })).toThrowError(expect.objectContaining({ code: "GROWTH_SEED_REFERENCE_INVALID" }));
    const foreignDocument = foreignDocumentVersion(setup);
    expect(() => repository.createGoal({
      ...goalInput(setup), id: "document-seed", idempotencyKey: "document-seed",
      seed: { kind: "source_document", sourceDocumentId: foreignDocument.documentId, sourceVersionId: foreignDocument.versionId },
    })).toThrowError(expect.objectContaining({ code: "GROWTH_SEED_REFERENCE_INVALID" }));
  });

  it("rejects foreign-branch Runs, stale Change Set bases and nonmatching committed event targets", () => {
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
    const unrelated = committedChangeSet(setup.workspace, "unrelated", "advance head");
    const stale = committedChangeSet(setup.workspace, "stale-growth", "stale growth");
    expect(() => repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: stale.id }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CHANGE_SET_REFERENCE_MISMATCH" }));
    expect(unrelated.id).not.toBe(stale.id);
  });
});

function createSetup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-"));
  workspace = openWorkspace(root);
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const scopeId = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!.id;
  const scopeVersionId = (workspace.db.prepare("SELECT id FROM resource_revisions WHERE resource_id = ? AND created_checkpoint_id = ?").get(scopeId, branch.headCheckpointId) as { id: string }).id;
  return { workspace, branchId: branch.id, checkpointId: branch.headCheckpointId, scopeId, scopeVersionId };
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

function runningCycle(repository: GrowthRepository, setup: ReturnType<typeof createSetup>) {
  const goal = createGoal(repository, setup);
  const cycle = repository.beginCycle({ id: "cycle-1", goalId: goal.id, idempotencyKey: "cycle-idempotency", inputCheckpointId: setup.checkpointId, ruleRevision: 1 });
  const run = seedRun(setup.workspace, setup.branchId, setup.checkpointId);
  repository.attachRun({ cycleId: cycle.id, runId: run.runId });
  return { goal, cycle, run };
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

function receiptInput(setup: ReturnType<typeof createSetup>, cycleId: string, run: ReturnType<typeof seedRun>, overrides: Record<string, unknown> = {}) {
  return {
    id: "receipt-1", cycleId, runId: run.runId, toolInvocationId: run.toolInvocationId, branchId: setup.branchId,
    checkpointId: setup.checkpointId, lens: "creator" as const, effectiveScopeResourceIds: [setup.scopeId], query: "coast",
    aliases: [], validTime: null, recordedTime: null, maxHops: 1, cpuBudgetMs: 10, expansionBudget: 10, resultBudget: 10,
    tokenBudget: 10, policyVersion: "growth-retrieval-v1", coverage: { state: "complete" as const, searchedScopeCount: 1, omittedCount: 0 },
    truncated: false, links: [], ...overrides,
  };
}

function receiptLink(setup: ReturnType<typeof createSetup>) {
  return {
    rank: 1, targetKind: "resource" as const, targetId: setup.scopeId, targetVersionId: setup.scopeVersionId, score: 1,
    reasonCodes: ["scope_match" as const], pathTargetIds: [], stableLocator: null, stableVersionId: null, stableHash: null,
  };
}

function eventInput(goalId: string, cycleId: string, runId: string, sequence: number, targetId: string) {
  return {
    goalId, cycleId, runId, sequence, safeSummary: "receipt recorded", phase: "receipt_recorded" as const,
    targetKind: "resource" as const, targetId, targetVersionId: null, durableState: "running" as const, contentRef: null,
  };
}

function committedChangeSet(workspace: WorkspaceDatabase, idempotencyKey: string, summary: string) {
  const repository = new ChangeSetRepository(workspace);
  const changeSet = repository.propose({ idempotencyKey, mode: "free", summary });
  repository.commit(changeSet.id, summary, () => undefined);
  return changeSet;
}

function foreignResourceRevision(setup: ReturnType<typeof createSetup>): string {
  const branch = new CheckpointRepository(setup.workspace).createBranchFromCheckpoint(setup.checkpointId, `foreign-resource-${randomUUID()}`);
  const checkpointId = new CheckpointRepository(setup.workspace).appendCheckpoint(branch.id, "foreign resource");
  const revisionId = randomUUID();
  setup.workspace.db.prepare(`
    INSERT INTO resource_revisions (id, resource_id, type, object_kind, title, parent_resource_id, created_checkpoint_id, state, sort_order, created_at)
    VALUES (?, ?, 'world', 'domain_root', 'Foreign', NULL, ?, 'active', 0, ?)
  `).run(revisionId, setup.scopeId, checkpointId, new Date().toISOString());
  return revisionId;
}

function foreignDocumentVersion(setup: ReturnType<typeof createSetup>) {
  const branch = new CheckpointRepository(setup.workspace).createBranchFromCheckpoint(setup.checkpointId, `foreign-document-${randomUUID()}`);
  const checkpointId = new CheckpointRepository(setup.workspace).appendCheckpoint(branch.id, "foreign document");
  const documentId = randomUUID();
  const versionId = randomUUID();
  const now = new Date().toISOString();
  setup.workspace.db.prepare("INSERT INTO creative_documents (id) VALUES (?)").run(documentId);
  setup.workspace.db.prepare(`
    INSERT INTO document_versions (id, resource_id, created_checkpoint_id, content, content_hash, author_kind, created_at, creative_document_id)
    VALUES (?, ?, ?, 'foreign source', ?, 'user', ?, ?)
  `).run(versionId, setup.scopeId, checkpointId, createHash("sha256").update("foreign source", "utf8").digest("hex"), now, documentId);
  return { documentId, versionId, contentHash: createHash("sha256").update("foreign source", "utf8").digest("hex") };
}

function pinnedDocumentVersion(setup: ReturnType<typeof createSetup>) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const content = "pinned source";
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  const now = new Date().toISOString();
  setup.workspace.db.prepare("INSERT INTO creative_documents (id) VALUES (?)").run(documentId);
  setup.workspace.db.prepare(`
    INSERT INTO document_versions (id, resource_id, created_checkpoint_id, content, content_hash, author_kind, created_at, creative_document_id)
    VALUES (?, ?, ?, ?, ?, 'user', ?, ?)
  `).run(versionId, setup.scopeId, setup.checkpointId, content, contentHash, now, documentId);
  return { documentId, versionId, contentHash };
}
