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
        intent: cycleIntent(),
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
        intent: cycleIntent(),
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
    const cycle = repository.beginCycle({ id: "cycle-1", goalId: goal.id, idempotencyKey: "cycle-idempotency", inputCheckpointId: setup.checkpointId, ruleRevision: 2, intent: cycleIntent() });
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
    expect(() => repository.beginCycle({ id: "cycle-2", goalId: goal.id, idempotencyKey: "cycle-2", inputCheckpointId: setup.checkpointId, ruleRevision: 1, intent: cycleIntent() }))
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
    const cycle = repository.beginCycle({ id: "cycle-1", goalId: goal.id, idempotencyKey: "cycle-idempotency", inputCheckpointId: setup.checkpointId, ruleRevision: 1, intent: cycleIntent() });
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

  it("creates Cycle and ordered intent atomically and enforces one open Cycle in SQLite", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const goal = createGoal(repository, setup);
    setup.workspace.db.exec(`
      CREATE TEMP TRIGGER reject_growth_intent BEFORE INSERT ON growth_cycle_intents
      BEGIN SELECT RAISE(ABORT, 'intent interrupted'); END;
    `);
    expect(() => repository.beginCycle({
      id: "cycle-rollback", goalId: goal.id, idempotencyKey: "cycle-rollback", inputCheckpointId: setup.checkpointId,
      ruleRevision: 1, intent: cycleIntent(),
    })).toThrow();
    expect(repository.listCycles(goal.id)).toEqual([]);
    expect(repository.getGoal(goal.id)?.currentCycleSequence).toBe(0);
    setup.workspace.db.exec("DROP TRIGGER reject_growth_intent");

    const cycle = repository.beginCycle({
      id: "cycle-1", goalId: goal.id, idempotencyKey: "cycle-1", inputCheckpointId: setup.checkpointId,
      ruleRevision: 1,
    });
    expect(repository.getCycleIntent(cycle.id)).toEqual({
      cycleId: cycle.id, kind: "expand", focusKinds: ["world"], resumeFrontier: ["story", "oc"], provenance: "persisted_v24",
    });
    expect(() => setup.workspace.db.prepare(`
      INSERT INTO growth_cycles (
        id, goal_id, sequence, idempotency_key, payload_hash, input_checkpoint_id, rule_revision,
        run_id, receipt_id, change_set_id, output_checkpoint_id, status, failure_code, created_at, updated_at, terminal_at
      ) VALUES ('cycle-sql-bypass', ?, 2, 'cycle-sql-bypass-key', ?, ?, 1,
        NULL, NULL, NULL, NULL, 'planned', NULL, ?, ?, NULL)
    `).run(goal.id, "a".repeat(64), setup.checkpointId, new Date().toISOString(), new Date().toISOString())).toThrow();
    expect(repository.listCycles(goal.id).map((entry) => entry.id)).toEqual([cycle.id]);
    expect(() => repository.beginCycle({
      id: "cycle-2", goalId: goal.id, idempotencyKey: "cycle-2", inputCheckpointId: setup.checkpointId,
      ruleRevision: 1, intent: cycleIntent(),
    })).toThrowError(expect.objectContaining({ code: "GROWTH_OPEN_CYCLE_EXISTS" }));
  });

  it("seals one evidence-grounded inquiry batch atomically with exact replay and rank foreign keys", () => {
    const setup = createSetup();
    let repository = new GrowthRepository(setup.workspace);
    const { cycle, run } = runningCycle(repository, setup);
    const receipt = repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [receiptLink(setup)] }));
    const batchInput = inquiryBatchInput(cycle.id, receipt.id);

    expect(() => repository.sealInquiryBatch({
      ...batchInput,
      id: "bad-inquiry-batch",
      idempotencyKey: "bad-inquiry-key",
      questions: batchInput.questions.map((question, index) => index === 0
        ? { ...question, evidenceLinks: [{ receiptId: receipt.id, rank: 2 }] } : question),
    })).toThrow();
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_inquiry_batches").get()).toEqual({ count: 0 });

    const sealed = repository.sealInquiryBatch(batchInput);
    expect(sealed.questions.filter((question) => question.selected).map((question) => question.id)).toEqual(["question-1"]);
    expect(repository.sealInquiryBatch(batchInput)).toEqual(sealed);
    expect(() => repository.sealInquiryBatch({ ...batchInput, selectedInquiryId: "question-2" }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_REPLAY_MISMATCH" }));
    expect(repository.getInquiryBatch(sealed.id)).toEqual(sealed);

    workspace?.close();
    workspace = openWorkspace(root!);
    setup.workspace = workspace;
    repository = new GrowthRepository(workspace);
    expect(repository.sealInquiryBatch(batchInput)).toEqual(sealed);
  });

  it("keeps Steward and Checker assessments invocation-bound and reopens accepted closure through a new revision", () => {
    const setup = createSetup();
    let repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);
    const oldReceipt = repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [receiptLink(setup)] }));
    const changeSet = committedChangeSet(setup.workspace, "closure-output", "closure output");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id });
    const evaluationCycle = repository.beginCycle({
      id: "cycle-evaluation", goalId: goal.id, idempotencyKey: "cycle-evaluation-key",
      inputCheckpointId: committed.outputCheckpointId, ruleRevision: 1, intent: cycleIntent(),
    });
    const evaluationRun = seedRun(setup.workspace, setup.branchId, committed.outputCheckpointId!);
    repository.attachRun({ cycleId: evaluationCycle.id, runId: evaluationRun.runId });
    const receipt = repository.recordReceipt(receiptInput(setup, evaluationCycle.id, evaluationRun, {
      id: "receipt-evaluation", checkpointId: committed.outputCheckpointId, links: [receiptLink(setup)],
    }));
    const profileInput = {
      id: "profile-world", idempotencyKey: "profile-world-key", goalId: goal.id, profileKind: "world_birth",
      subjectResourceId: null, checkpointId: committed.outputCheckpointId!, ruleRevision: 1,
      facets: [{ id: "history", kind: "content", required: true }, { id: "map", kind: "visual", required: true }],
    } as const;
    const profile = repository.createClosureProfile(profileInput);
    const stewardHash = "c".repeat(64);
    seedInvocationTerminal(setup.workspace, evaluationRun.runId, evaluationRun.invocationId, stewardHash);
    const checker = seedCheckerInvocation(setup.workspace, evaluationRun.runId, evaluationRun.invocationId, "d".repeat(64));
    const stewardAssessmentInput = {
      id: "assessment-steward", profileId: profile.id, revision: 1, role: "steward", decision: "ready_for_checker",
      cycleId: evaluationCycle.id, checkpointId: committed.outputCheckpointId!, ruleRevision: 1, receiptId: receipt.id,
      agentInvocationId: evaluationRun.invocationId, outputSha256: stewardHash, idempotencyKey: "assessment-steward-key",
    } as const;
    expect(() => repository.appendClosureAssessment({
      ...stewardAssessmentInput, id: "assessment-old-receipt", receiptId: oldReceipt.id,
      idempotencyKey: "assessment-old-receipt-key",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_ASSESSMENT_REFERENCE_MISMATCH" }));
    const stewardAssessment = repository.appendClosureAssessment(stewardAssessmentInput);
    expect(repository.appendClosureAssessment(stewardAssessmentInput)).toEqual(stewardAssessment);
    expect(() => repository.appendClosureAssessment({
      id: "assessment-wrong-role", profileId: profile.id, revision: 1, role: "checker", decision: "accepted",
      cycleId: evaluationCycle.id, checkpointId: committed.outputCheckpointId, ruleRevision: 1, receiptId: receipt.id,
      agentInvocationId: evaluationRun.invocationId, outputSha256: stewardHash, idempotencyKey: "assessment-wrong-role-key",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_INVOCATION_MISMATCH" }));
    const checkerAssessmentInput = {
      id: "assessment-checker", profileId: profile.id, revision: 1, role: "checker", decision: "accepted",
      cycleId: evaluationCycle.id, checkpointId: committed.outputCheckpointId!, ruleRevision: 1, receiptId: receipt.id,
      agentInvocationId: checker.invocationId, outputSha256: checker.outputSha256, idempotencyKey: "assessment-checker-key",
    } as const;
    const checkerAssessment = repository.appendClosureAssessment(checkerAssessmentInput);
    const reviewInput = {
      id: "review-accepted", profileId: profile.id, revision: 1, stewardAssessmentId: stewardAssessment.id,
      checkerAssessmentId: checkerAssessment.id, idempotencyKey: "review-accepted-key",
      findings: [{ facetId: "history", state: "satisfied" as const, safeSummary: "History is continuous.", evidence: { receiptId: receipt.id, rank: 1 } }],
    };
    setup.workspace.db.exec(`
      CREATE TEMP TRIGGER reject_growth_closure_finding BEFORE INSERT ON growth_closure_review_findings
      BEGIN SELECT RAISE(ABORT, 'closure interrupted'); END;
    `);
    expect(() => repository.sealClosureReview({
      ...reviewInput, id: "review-rollback", idempotencyKey: "review-rollback-key",
    })).toThrow();
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_closure_reviews").get()).toEqual({ count: 0 });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_closure_review_findings").get()).toEqual({ count: 0 });
    expect(repository.getClosureState(profile.id)).toMatchObject({ contentState: "growing", missingFacetIds: ["history"] });
    setup.workspace.db.exec("DROP TRIGGER reject_growth_closure_finding");
    const review = repository.sealClosureReview(reviewInput);
    expect(repository.sealClosureReview(reviewInput)).toEqual(review);

    workspace?.close();
    workspace = openWorkspace(root!);
    setup.workspace = workspace;
    repository = new GrowthRepository(workspace);
    expect(repository.createClosureProfile(profileInput)).toEqual(profile);
    expect(repository.appendClosureAssessment(stewardAssessmentInput)).toEqual(stewardAssessment);
    expect(repository.appendClosureAssessment(checkerAssessmentInput)).toEqual(checkerAssessment);
    expect(repository.sealClosureReview(reviewInput)).toEqual(review);
    expect(repository.getClosureState(profile.id)).toMatchObject({ contentState: "closed", visualState: "planning", revision: 1 });

    const visualRequest = repository.createIllustrationRequest({
      id: "closure-visual-request", goalId: goal.id, cycleId: cycle.id, ruleRevision: 1, coverageMode: "default",
      closureProfileId: profile.id, closureRevision: 1, idempotencyKey: "closure-visual-request-key",
    });
    repository.sealIllustrationBatch({
      id: "closure-visual-batch", requestId: visualRequest.id, sequence: 1, cursor: null, nextCursor: null,
      idempotencyKey: "closure-visual-batch-key", snapshots: [],
      items: [{ ...illustrationResourceItem(setup, "closure-map", "closure-map-v1"), requiredForVisualClosure: true }],
    });
    const visualJob = seedImageJob(setup.workspace, "succeeded", resourceImageJobBinding(setup), true);
    const visualItem = repository.bindIllustrationImageJob({ itemId: "closure-map", imageJobId: visualJob });
    expect(repository.getClosureState(profile.id)).toMatchObject({ contentState: "closed", visualState: "ready" });
    repository.markIllustrationItemStale({ itemId: visualItem.id, expectedAnchorHash: visualItem.anchorHash });
    expect(repository.getClosureState(profile.id)).toMatchObject({ contentState: "closed", visualState: "planning" });

    repository.appendRule({ goalId: goal.id, expectedRevision: 1, ruleText: "reopen history", sourceMessageId: "closure-rule-2" });
    const revision = repository.appendClosureRevision({
      profileId: profile.id, expectedRevision: 1, idempotencyKey: "profile-world-revision-2",
      checkpointId: committed.outputCheckpointId, ruleRevision: 2,
      facets: [{ id: "history", kind: "content", required: true }, { id: "map", kind: "visual", required: true }],
    });
    expect(revision).toMatchObject({ revision: 2, epoch: 2 });
    expect(repository.getClosureState(profile.id)).toMatchObject({ contentState: "growing", revision: 2, missingFacetIds: ["history"] });
    expect(repository.getClosureReview(review.id)).toEqual(review);
  });

  it("persists unlimited batched illustration items, immutable snapshots, stale reopening and outcome unknown", () => {
    const setup = createSetup();
    let repository = new GrowthRepository(setup.workspace);
    const { goal, cycle } = runningCycle(repository, setup);
    const request = repository.createIllustrationRequest({
      id: "illustration-request", goalId: goal.id, cycleId: cycle.id, ruleRevision: 1, coverageMode: "custom",
      closureProfileId: null, closureRevision: null, idempotencyKey: "illustration-request-key",
    });
    expect(repository.createIllustrationRequest({
      id: "illustration-request", goalId: goal.id, cycleId: cycle.id, ruleRevision: 1, coverageMode: "custom",
      closureProfileId: null, closureRevision: null, idempotencyKey: "illustration-request-key",
    })).toEqual(request);
    expect(() => repository.createIllustrationRequest({
      id: "illustration-request", goalId: goal.id, cycleId: cycle.id, ruleRevision: 1, coverageMode: "default",
      closureProfileId: null, closureRevision: null, idempotencyKey: "illustration-request-key",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_REQUEST_REPLAY_MISMATCH" }));
    const snapshotText = "working 🌊 snapshot";
    const snapshotHash = hashText(snapshotText);
    const firstItems = Array.from({ length: 20 }, (_, index) => index === 0
      ? {
          ...illustrationResourceItem(setup, `item-${index}`, `variant-${index}`),
          anchor: { kind: "working_text_snapshot" as const, sourceSnapshotId: "snapshot-1", textSha256: snapshotHash },
        }
      : illustrationResourceItem(setup, `item-${index}`, `variant-${index}`));
    const batchOne = {
      id: "illustration-batch-1", requestId: request.id, sequence: 1, cursor: null, nextCursor: "20",
      idempotencyKey: "illustration-batch-1-key",
      snapshots: [{ id: "snapshot-1", kind: "working_text_snapshot" as const, text: snapshotText, textSha256: snapshotHash }],
      items: firstItems,
    };
    expect(() => repository.sealIllustrationBatch({
      ...batchOne, id: "bad-snapshot-batch", idempotencyKey: "bad-snapshot-key",
      snapshots: [{ ...batchOne.snapshots[0], textSha256: "f".repeat(64) }],
      items: [{ ...firstItems[0], anchor: { kind: "working_text_snapshot", sourceSnapshotId: "snapshot-1", textSha256: "f".repeat(64) } }],
    })).toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_SNAPSHOT_HASH_MISMATCH" }));
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_illustration_text_snapshots").get()).toEqual({ count: 0 });
    const sealedOne = repository.sealIllustrationBatch(batchOne);
    expect(repository.sealIllustrationBatch(batchOne)).toEqual(sealedOne);
    expect(() => repository.sealIllustrationBatch({ ...batchOne, nextCursor: "changed" }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_BATCH_REPLAY_MISMATCH" }));

    workspace?.close();
    workspace = openWorkspace(root!);
    setup.workspace = workspace;
    repository = new GrowthRepository(workspace);
    expect(repository.sealIllustrationBatch(batchOne)).toEqual(sealedOne);

    const document = pinnedDocumentVersionWithContent(setup, "A🌊B");
    repository.sealIllustrationBatch({
      id: "illustration-batch-2", requestId: request.id, sequence: 2, cursor: "20", nextCursor: null,
      idempotencyKey: "illustration-batch-2-key", snapshots: [], items: [{
        id: "item-20", purpose: "scene", title: "Unicode span", variantKey: "variant-20",
        compiledPromptSha256: "e".repeat(64), requiredForVisualClosure: false,
        anchor: { kind: "stable_text_span", documentId: document.documentId, documentVersionId: document.versionId,
          startCodePoint: 1, endCodePoint: 2, textSha256: hashText("🌊") },
        sources: [{ kind: "document", documentId: document.documentId, documentVersionId: document.versionId, contentSha256: document.contentHash }],
      }],
    });
    expect(repository.getIllustrationRequest(request.id)).toMatchObject({ itemCount: 21, status: "planned" });
    const reconciliationJob = seedImageJob(setup.workspace, "reconciliation_required", {
      ...resourceImageJobBinding(setup), sourceVersionIds: [document.versionId],
    });
    expect(repository.bindIllustrationImageJob({ itemId: "item-20", imageJobId: reconciliationJob }).status).toBe("reconciliation_required");
    expect(repository.getIllustrationRequest(request.id)?.status).toBe("reconciliation_required");

    const readyRequest = repository.createIllustrationRequest({
      id: "ready-request", goalId: goal.id, cycleId: cycle.id, ruleRevision: 1, coverageMode: "default",
      closureProfileId: null, closureRevision: null, idempotencyKey: "ready-request-key",
    });
    const readyBatch = repository.sealIllustrationBatch({
      id: "ready-batch", requestId: readyRequest.id, sequence: 1, cursor: null, nextCursor: null,
      idempotencyKey: "ready-batch-key", snapshots: [], items: [illustrationResourceItem(setup, "ready-item", "ready-variant")],
    });
    const promptMismatchJob = seedImageJob(setup.workspace, "succeeded", {
      ...resourceImageJobBinding(setup), promptSha256: "f".repeat(64),
    }, true);
    expect(() => repository.bindIllustrationImageJob({ itemId: "ready-item", imageJobId: promptMismatchJob }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_JOB_PROMPT_MISMATCH" }));
    const purposeMismatchJob = seedImageJob(setup.workspace, "succeeded", {
      ...resourceImageJobBinding(setup), purpose: "world_map",
    }, true);
    expect(() => repository.bindIllustrationImageJob({ itemId: "ready-item", imageJobId: purposeMismatchJob }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_JOB_PURPOSE_MISMATCH" }));
    const sourceMismatchJob = seedImageJob(setup.workspace, "succeeded", {
      ...resourceImageJobBinding(setup), sourceVersionIds: [setup.scopeVersionId, document.versionId],
    }, true);
    expect(() => repository.bindIllustrationImageJob({ itemId: "ready-item", imageJobId: sourceMismatchJob }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_JOB_SOURCE_MISMATCH" }));
    const missingSourceJob = seedImageJob(setup.workspace, "succeeded", {
      ...resourceImageJobBinding(setup), sourceVersionIds: [document.versionId],
    }, true);
    expect(() => repository.bindIllustrationImageJob({ itemId: "ready-item", imageJobId: missingSourceJob }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_JOB_SOURCE_MISMATCH" }));
    const malformedSourceJob = seedImageJob(setup.workspace, "succeeded", {
      ...resourceImageJobBinding(setup), sourceVersionIds: [""],
    }, true);
    expect(() => repository.bindIllustrationImageJob({ itemId: "ready-item", imageJobId: malformedSourceJob }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_JOB_SOURCE_MALFORMED" }));
    const readyJob = seedImageJob(setup.workspace, "succeeded", resourceImageJobBinding(setup), true);
    const readyItem = repository.bindIllustrationImageJob({ itemId: "ready-item", imageJobId: readyJob });
    expect(readyItem.status).toBe("ready");
    expect(repository.getIllustrationRequest(readyRequest.id)?.status).toBe("completed");
    expect(repository.markIllustrationItemStale({ itemId: readyItem.id, expectedAnchorHash: readyItem.anchorHash }).status).toBe("stale");
    expect(repository.getIllustrationRequest(readyRequest.id)?.status).toBe("stale");
    expect(repository.getIllustrationBatch(readyBatch.id)?.status).toBe("stale");
  });

  it("rolls back interrupted Illustration batches and canonicalizes source-set uniqueness without changing display order", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle } = runningCycle(repository, setup);
    const request = repository.createIllustrationRequest({
      id: "source-set-request", goalId: goal.id, cycleId: cycle.id, ruleRevision: 1, coverageMode: "custom",
      closureProfileId: null, closureRevision: null, idempotencyKey: "source-set-request-key",
    });
    const document = pinnedDocumentVersion(setup);
    const sources = [
      { kind: "resource" as const, resourceId: setup.scopeId, resourceVersionId: setup.scopeVersionId },
      { kind: "document" as const, documentId: document.documentId, documentVersionId: document.versionId, contentSha256: document.contentHash },
    ];
    const firstItem = { ...illustrationResourceItem(setup, "source-set-item-1", "same-variant"), sources };
    const firstBatch = {
      id: "source-set-batch-1", requestId: request.id, sequence: 1, cursor: null, nextCursor: "next",
      idempotencyKey: "source-set-batch-1-key", snapshots: [], items: [firstItem],
    };
    setup.workspace.db.exec(`
      CREATE TEMP TRIGGER reject_growth_illustration_source BEFORE INSERT ON growth_illustration_item_sources
      BEGIN SELECT RAISE(ABORT, 'illustration interrupted'); END;
    `);
    expect(() => repository.sealIllustrationBatch({
      ...firstBatch, id: "source-set-rollback", idempotencyKey: "source-set-rollback-key",
    })).toThrow();
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_illustration_request_batches").get()).toEqual({ count: 0 });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_illustration_items").get()).toEqual({ count: 0 });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_illustration_item_sources").get()).toEqual({ count: 0 });
    expect(repository.getIllustrationRequest(request.id)).toMatchObject({ status: "planned", itemCount: 0 });
    setup.workspace.db.exec("DROP TRIGGER reject_growth_illustration_source");

    repository.sealIllustrationBatch(firstBatch);
    expect(repository.getIllustrationItem(firstItem.id)?.sources).toEqual(sources);
    expect(() => repository.sealIllustrationBatch({
      id: "source-set-batch-2", requestId: request.id, sequence: 2, cursor: "next", nextCursor: null,
      idempotencyKey: "source-set-batch-2-key", snapshots: [],
      items: [{ ...firstItem, id: "source-set-item-2", sources: [...sources].reverse() }],
    })).toThrow();
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_illustration_request_batches").get()).toEqual({ count: 1 });
    expect(repository.getIllustrationRequest(request.id)).toMatchObject({ itemCount: 1 });
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
  const cycle = repository.beginCycle({ id: "cycle-1", goalId: goal.id, idempotencyKey: "cycle-idempotency", inputCheckpointId: setup.checkpointId, ruleRevision: 1, intent: cycleIntent() });
  const run = seedRun(setup.workspace, setup.branchId, setup.checkpointId);
  repository.attachRun({ cycleId: cycle.id, runId: run.runId });
  return { goal, cycle, run };
}

function cycleIntent() {
  return { kind: "expand" as const, focusKinds: ["world" as const], resumeFrontier: ["story" as const, "oc" as const] };
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
  return { runId, invocationId, toolInvocationId };
}

function inquiryBatchInput(cycleId: string, receiptId: string) {
  return {
    id: "inquiry-batch", cycleId, idempotencyKey: "inquiry-batch-key", creatorChoiceBlocked: false,
    selectedInquiryId: "question-1",
    questions: [
      { id: "question-1", question: "What is known?", evidenceState: "known" as const, safeSummary: "Known source.", priority: 3,
        fingerprint: "1".repeat(64), evidenceLinks: [{ receiptId, rank: 1 }] },
      { id: "question-2", question: "What conflicts?", evidenceState: "unknown" as const, safeSummary: "No conflict evidence.", priority: 2,
        fingerprint: "2".repeat(64), evidenceLinks: [] },
      { id: "question-3", question: "What remains?", evidenceState: "unknown" as const, safeSummary: "An open frontier.", priority: 1,
        fingerprint: "3".repeat(64), evidenceLinks: [] },
    ],
  };
}

function seedInvocationTerminal(workspace: WorkspaceDatabase, runId: string, invocationId: string, outputSha256: string): void {
  workspace.db.prepare(`
    INSERT INTO agent_audit_events (
      id, run_id, entity_type, invocation_id, tool_invocation_id, event_type, terminal, output_sha256, created_at
    ) VALUES (?, ?, 'invocation', ?, NULL, 'completed', 1, ?, ?)
  `).run(randomUUID(), runId, invocationId, outputSha256, new Date().toISOString());
}

function seedCheckerInvocation(workspace: WorkspaceDatabase, runId: string, parentInvocationId: string, outputSha256: string) {
  const invocationId = randomUUID();
  const hash = "b".repeat(64);
  const now = new Date().toISOString();
  workspace.db.prepare(`
    INSERT INTO agent_invocations (
      id, run_id, parent_invocation_id, role, prompt_id, prompt_version, prompt_sha256, agent_profile_id, agent_profile_version,
      agent_profile_sha256, provider_id, requested_model_id, provider_config_sha256, tool_policy_id, tool_policy_version,
      tool_policy_sha256, authorized_tools_json, handoff_contract_id, handoff_version, handoff_payload_sha256, input_sha256, created_at
    ) VALUES (?, ?, ?, 'checker', 'checker', '1.0.0', ?, 'checker-profile', '1.0.0', ?, 'provider', 'model', ?,
      'policy', '1.0.0', ?, '[]', 'closure-review', '1.0.0', ?, ?, ?)
  `).run(invocationId, runId, parentInvocationId, hash, hash, hash, hash, hash, hash, now);
  seedInvocationTerminal(workspace, runId, invocationId, outputSha256);
  return { invocationId, outputSha256 };
}

function illustrationResourceItem(setup: ReturnType<typeof createSetup>, id: string, variantKey: string) {
  return {
    id, purpose: "scene", title: id, variantKey, compiledPromptSha256: "e".repeat(64), requiredForVisualClosure: false,
    anchor: { kind: "resource" as const, resourceId: setup.scopeId, resourceVersionId: setup.scopeVersionId },
    sources: [{ kind: "resource" as const, resourceId: setup.scopeId, resourceVersionId: setup.scopeVersionId }],
  };
}

function seedImageJob(
  workspace: WorkspaceDatabase,
  status: "queued" | "running" | "succeeded" | "failed" | "reconciliation_required",
  binding: { purpose: string; promptSha256: string; sourceResourceIds: string[]; sourceVersionIds: string[] },
  withAsset = false,
): string {
  const id = randomUUID();
  const hash = "9".repeat(64);
  const now = new Date().toISOString();
  workspace.db.prepare(`
    INSERT INTO image_generation_jobs (
      id, idempotency_key, request_sha256, provider_id, model_id, title, purpose, prompt, prompt_sha256, size, quality,
      background, source_resource_ids_json, source_version_ids_json, status, request_sent_at, provider_response_id_sha256,
      error_code, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, 'provider', 'model', 'image', ?, 'managed prompt', ?, '1024x1024', 'auto', 'auto', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `).run(id, `image-job-${id}`, hash, binding.purpose, binding.promptSha256,
    JSON.stringify(binding.sourceResourceIds), JSON.stringify(binding.sourceVersionIds), status, now, now);
  if (withAsset) {
    workspace.db.prepare(`
      INSERT INTO image_assets (
        id, job_id, mime_type, width, height, byte_length, sha256, relative_path, status, created_at, updated_at
      ) VALUES (?, ?, 'image/png', 1, 1, 4, ?, ?, 'ready', ?, ?)
    `).run(randomUUID(), id, hash, `images/${id}.png`, now, now);
  }
  return id;
}

function resourceImageJobBinding(setup: ReturnType<typeof createSetup>) {
  return {
    purpose: "scene", promptSha256: "e".repeat(64),
    sourceResourceIds: [setup.scopeId], sourceVersionIds: [setup.scopeVersionId],
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

function pinnedDocumentVersionWithContent(setup: ReturnType<typeof createSetup>, content: string) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const contentHash = hashText(content);
  const now = new Date().toISOString();
  setup.workspace.db.prepare("INSERT INTO creative_documents (id) VALUES (?)").run(documentId);
  setup.workspace.db.prepare(`
    INSERT INTO document_versions (id, resource_id, created_checkpoint_id, content, content_hash, author_kind, created_at, creative_document_id)
    VALUES (?, ?, ?, ?, ?, 'user', ?, ?)
  `).run(versionId, setup.scopeId, setup.checkpointId, content, contentHash, now, documentId);
  return { documentId, versionId, contentHash };
}
