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
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";

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
      ruleRevision: 1, intent: cycleIntent(),
    });
    expect(repository.getCycleIntent(cycle.id)).toEqual({
      cycleId: cycle.id, kind: "expand", focusKinds: ["world"], resumeFrontier: ["story", "oc"], provenance: "persisted_v26",
    });
    setup.workspace.db.prepare("DELETE FROM growth_cycle_intents WHERE cycle_id = ?").run(cycle.id);
    expect(() => repository.getCycleIntent(cycle.id))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CYCLE_INTENT_REQUIRED" }));
    setup.workspace.db.prepare("UPDATE growth_cycles SET payload_hash = ? WHERE id = ?").run(canonicalAuditHash({
      id: cycle.id,
      goalId: goal.id,
      idempotencyKey: "cycle-1",
      inputCheckpointId: setup.checkpointId,
      ruleRevision: 1,
    }), cycle.id);
    expect(repository.getCycleIntent(cycle.id)).toEqual({
      cycleId: cycle.id, kind: "expand", focusKinds: ["world"], resumeFrontier: ["story", "oc"], provenance: "legacy_v23_projection",
    });
    expect(setup.workspace.db.prepare("SELECT 1 FROM growth_cycle_intents WHERE cycle_id = ?").get(cycle.id)).toBeUndefined();
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

  it("seals one complete v25 Inquiry batch atomically with exact replay, lifecycle and safe event provenance", () => {
    const setup = createSetup();
    let repository = new GrowthRepository(setup.workspace);
    const { cycle, run } = runningCycle(repository, setup);
    const receipt = repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [receiptLink(setup)] }));
    const batchInput = inquiryBatchInput(cycle.id);

    expect(() => repository.sealInquiryBatch({
      ...batchInput,
      id: "bad-inquiry-batch",
      idempotencyKey: "bad-inquiry-key",
      questions: batchInput.questions.map((question, index) => index === 0
        ? { ...question, evidenceRanks: [2] } : question),
    })).toThrow();
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_inquiry_batches").get()).toEqual({ count: 0 });

    const sealed = repository.sealInquiryBatch(batchInput);
    expect(sealed).toMatchObject({ contractVersion: "v25", selectedInquiryId: "question-1", creatorChoiceRequiredInquiryId: null });
    if (sealed.contractVersion !== "v25") throw new Error("Expected v25 Inquiry Batch.");
    expect(sealed.questions.map((question) => question.initialState)).toEqual(["selected", "backlog", "backlog"]);
    expect(repository.listInquiryLifecycle("question-1")).toMatchObject([{
      sequence: 1, phase: "selected", sourceCycleId: cycle.id, sourceReceiptId: receipt.id,
      sourceCheckpointId: setup.checkpointId, sourceRuleRevision: 1,
    }]);
    expect(repository.listEvents(cycle.goalId)).toMatchObject([{
      phase: "inquiry_selected", durableState: "running", targetKind: "inquiry", targetId: "question-1",
      targetVersionId: null, contentRef: null, safeSummary: "Known source.",
    }]);
    expect(setup.workspace.db.prepare(`
      SELECT batch_id, inquiry_id, lifecycle_sequence FROM growth_inquiry_event_sources
    `).get()).toEqual({ batch_id: sealed.id, inquiry_id: "question-1", lifecycle_sequence: 1 });
    expect(() => repository.appendEvent({
      goalId: cycle.goalId, cycleId: cycle.id, runId: run.runId, sequence: 2,
      safeSummary: "forged inquiry event", phase: "inquiry_selected", targetKind: "inquiry",
      targetId: "question-1", targetVersionId: null, durableState: "running", contentRef: null,
    })).toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_EVENT_REPOSITORY_OWNED" }));
    expect(repository.sealInquiryBatch(batchInput)).toEqual(sealed);
    expect(() => repository.sealInquiryBatch({
      ...batchInput,
      selectedInquiryId: "question-2",
      questions: batchInput.questions.map((question) => question.id === "question-1"
        ? { ...question, priority: 2 }
        : question.id === "question-2"
          ? { ...question, priority: 3 }
          : question),
    }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_REPLAY_MISMATCH" }));
    expect(repository.getInquiryBatch(sealed.id)).toEqual(sealed);

    workspace?.close();
    workspace = openWorkspace(root!);
    setup.workspace = workspace;
    repository = new GrowthRepository(workspace);
    expect(repository.sealInquiryBatch(batchInput)).toEqual(sealed);

    setup.workspace.db.prepare(`
      UPDATE growth_inquiry_batch_contracts SET contract_version = 'legacy_v24'
      WHERE batch_id = ?
    `).run(sealed.id);
    expect(() => repository.getInquiryBatch(sealed.id))
      .toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_DATA_CORRUPT" }));
    setup.workspace.db.prepare(`
      UPDATE growth_inquiry_batch_contracts SET contract_version = 'v25'
      WHERE batch_id = ?
    `).run(sealed.id);
    setup.workspace.db.prepare("DELETE FROM growth_inquiry_batch_contracts WHERE batch_id = ?").run(sealed.id);
    expect(() => repository.getInquiryBatch(sealed.id))
      .toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_DATA_CORRUPT" }));
    setup.workspace.db.prepare(`
      INSERT INTO growth_inquiry_batch_contracts (
        batch_id, contract_version, creator_choice_required_inquiry_id
      ) VALUES (?, 'v25', NULL)
    `).run(sealed.id);
    setup.workspace.db.prepare("DELETE FROM growth_inquiry_details WHERE inquiry_id = 'question-2'").run();
    expect(() => repository.getInquiryBatch(sealed.id))
      .toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_DATA_CORRUPT" }));
  });

  it("blocks on one concrete creator choice atomically and records creator_answered without claiming evidence resolution", () => {
    const setup = createSetup();
    let repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);
    const receipt = repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [receiptLink(setup)] }));
    const batchInput = creatorChoiceBatchInput(cycle.id);

    setup.workspace.db.exec(`
      CREATE TRIGGER reject_growth_inquiry_event_source
      BEFORE INSERT ON growth_inquiry_event_sources
      BEGIN SELECT RAISE(ABORT, 'forced inquiry source failure'); END;
    `);
    expect(() => repository.sealInquiryBatch(batchInput)).toThrow("forced inquiry source failure");
    expect(repository.getCycle(cycle.id)?.status).toBe("running");
    expect(repository.getGoal(goal.id)?.status).toBe("active");
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_inquiry_batches").get()).toEqual({ count: 0 });
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_events").get()).toEqual({ count: 0 });
    setup.workspace.db.exec("DROP TRIGGER reject_growth_inquiry_event_source");

    const sealed = repository.sealInquiryBatch(batchInput);
    expect(sealed).toMatchObject({
      contractVersion: "v25", selectedInquiryId: null, creatorChoiceRequiredInquiryId: "question-1",
    });
    if (sealed.contractVersion !== "v25") throw new Error("Expected v25 Inquiry Batch.");
    expect(sealed.questions.map((question) => question.initialState)).toEqual(["creator_choice_required", "backlog", "backlog"]);
    expect(repository.getCycle(cycle.id)).toMatchObject({ status: "blocked", failureCode: "GROWTH_CREATOR_CHOICE_REQUIRED" });
    expect(repository.getGoal(goal.id)?.status).toBe("blocked");
    expect(repository.listEvents(goal.id)).toMatchObject([{
      phase: "creator_choice_required", durableState: "blocked", targetKind: "inquiry", targetId: "question-1",
      targetVersionId: null, contentRef: null, safeSummary: "Creator choice required.",
    }]);

    const answerInput = {
      inquiryId: "question-1", idempotencyKey: "creator-answer-key", expectedRuleRevision: 1,
      expectedLifecycleSequence: 1, answerText: "保留港口自治，但祭司掌握历法。", sourceMessageId: "creator-message-1",
    };
    const answer = repository.answerCreatorInquiry(answerInput);
    expect(answer).toMatchObject({
      inquiryId: "question-1", goalId: goal.id, ruleRevision: 2, checkpointId: setup.checkpointId,
      receiptId: receipt.id, answerText: answerInput.answerText,
    });
    expect(repository.answerCreatorInquiry(answerInput)).toEqual(answer);
    expect(repository.getGoal(goal.id)).toMatchObject({ status: "active", currentRuleRevision: 2 });
    expect(repository.getRuleRevision(goal.id, 2)).toMatchObject({ ruleText: answerInput.answerText, sourceMessageId: answerInput.sourceMessageId });
    expect(repository.listInquiryLifecycle("question-1").map((entry) => entry.phase))
      .toEqual(["creator_choice_required", "creator_answered"]);
    expect(() => repository.answerCreatorInquiry({ ...answerInput, answerText: "改为祭司独裁。" }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_ANSWER_REPLAY_MISMATCH" }));
    expect(() => repository.answerCreatorInquiry({ ...answerInput, idempotencyKey: "second-answer-key", expectedRuleRevision: 2, expectedLifecycleSequence: 2 }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_ALREADY_ANSWERED" }));
    expect(() => repository.appendInquiryLifecycle({
      inquiryId: "question-1", idempotencyKey: "premature-answer-key", expectedSequence: 2,
      sourceCycleId: cycle.id, phase: "answered",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_SOURCE_NOT_LATER" }));
    expect(repository.beginCycle({
      id: "creator-answer-resume-cycle", goalId: goal.id, idempotencyKey: "creator-answer-resume-key",
      inputCheckpointId: setup.checkpointId, ruleRevision: 2, intent: cycleIntent(),
    })).toMatchObject({ status: "planned", ruleRevision: 2, inputCheckpointId: setup.checkpointId });

    workspace?.close();
    workspace = openWorkspace(root!);
    setup.workspace = workspace;
    repository = new GrowthRepository(workspace);
    expect(repository.answerCreatorInquiry(answerInput)).toEqual(answer);
  });

  it("appends promoted, answered and closed only from a later pinned Receipt with continuous replay-safe sequence", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);
    repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [receiptLink(setup)] }));
    repository.sealInquiryBatch(inquiryBatchInput(cycle.id));
    const changeSet = committedChangeSet(setup.workspace, "inquiry-output", "inquiry output");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id });

    const nextCycle = repository.beginCycle({
      id: "cycle-2", goalId: goal.id, idempotencyKey: "cycle-2-key", inputCheckpointId: committed.outputCheckpointId,
      ruleRevision: 1, intent: cycleIntent(),
    });
    const nextRun = seedRun(setup.workspace, setup.branchId, committed.outputCheckpointId!);
    repository.attachRun({ cycleId: nextCycle.id, runId: nextRun.runId });
    const nextReceipt = repository.recordReceipt(receiptInput(setup, nextCycle.id, nextRun, {
      id: "receipt-2", checkpointId: committed.outputCheckpointId, links: [receiptLink(setup)],
    }));
    const nextBatch = repository.sealInquiryBatch(inquiryBatchInput(nextCycle.id, "-next"));

    expect(() => repository.appendInquiryLifecycle({
      inquiryId: "question-next-2", idempotencyKey: "predecessor-source-key", expectedSequence: 1,
      sourceCycleId: cycle.id, phase: "answered",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_SOURCE_NOT_LATER" }));

    const promotedInput = {
      inquiryId: "question-2", idempotencyKey: "promote-question-2", expectedSequence: 1,
      sourceCycleId: nextCycle.id, phase: "promoted" as const, successorInquiryId: nextBatch.questions[0].id,
    };
    const promoted = repository.appendInquiryLifecycle(promotedInput);
    expect(promoted).toMatchObject({
      sequence: 2, phase: "promoted", sourceCycleId: nextCycle.id, sourceReceiptId: nextReceipt.id,
      sourceCheckpointId: committed.outputCheckpointId, successorInquiryId: nextBatch.questions[0].id,
    });
    expect(repository.appendInquiryLifecycle(promotedInput)).toEqual(promoted);
    expect(() => repository.appendInquiryLifecycle({ ...promotedInput, successorInquiryId: nextBatch.questions[1].id }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_LIFECYCLE_REPLAY_MISMATCH" }));

    expect(repository.appendInquiryLifecycle({
      inquiryId: "question-1", idempotencyKey: "answer-question-1", expectedSequence: 1,
      sourceCycleId: nextCycle.id, phase: "answered",
    })).toMatchObject({ sequence: 2, phase: "answered", sourceReceiptId: nextReceipt.id });
    expect(repository.appendInquiryLifecycle({
      inquiryId: "question-3", idempotencyKey: "close-question-3", expectedSequence: 1,
      sourceCycleId: nextCycle.id, phase: "closed", reason: "superseded",
    })).toMatchObject({ sequence: 2, phase: "closed", closeReason: "superseded" });
    expect(() => repository.appendInquiryLifecycle({
      inquiryId: "question-3", idempotencyKey: "close-question-3-again", expectedSequence: 2,
      sourceCycleId: nextCycle.id, phase: "closed", reason: "duplicate",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_LIFECYCLE_TERMINAL" }));
  });

  it("seals explicit prior Inquiry transitions in the same transaction as the successor batch", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);
    repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [receiptLink(setup)] }));
    repository.sealInquiryBatch(inquiryBatchInput(cycle.id));
    const changeSet = committedChangeSet(setup.workspace, "atomic-inquiry-output", "atomic inquiry output");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id });
    const nextCycle = repository.beginCycle({
      id: "cycle-atomic", goalId: goal.id, idempotencyKey: "cycle-atomic-key", inputCheckpointId: committed.outputCheckpointId,
      ruleRevision: 1, intent: cycleIntent(),
    });
    const nextRun = seedRun(setup.workspace, setup.branchId, committed.outputCheckpointId!);
    repository.attachRun({ cycleId: nextCycle.id, runId: nextRun.runId });
    repository.recordReceipt(receiptInput(setup, nextCycle.id, nextRun, {
      id: "receipt-atomic", checkpointId: committed.outputCheckpointId, links: [receiptLink(setup)],
    }));
    const nextInput = {
      ...inquiryBatchInput(nextCycle.id, "-atomic"),
      priorTransitions: [
        { inquiryId: "question-1", expectedSequence: 1, phase: "answered" as const },
        { inquiryId: "question-2", expectedSequence: 1, phase: "promoted" as const, successorInquiryId: "question-atomic-1" },
        { inquiryId: "question-3", expectedSequence: 1, phase: "closed" as const, reason: "superseded" as const },
      ],
    };
    setup.workspace.db.exec(`
      CREATE TRIGGER reject_atomic_inquiry_event_source
      BEFORE INSERT ON growth_inquiry_event_sources
      BEGIN SELECT RAISE(ABORT, 'forced atomic Inquiry failure'); END;
    `);

    expect(() => repository.sealInquiryBatch(nextInput)).toThrow("forced atomic Inquiry failure");
    expect(repository.getInquiryBatch(nextInput.id)).toBeNull();
    for (const inquiryId of ["question-1", "question-2", "question-3"]) {
      expect(repository.listInquiryLifecycle(inquiryId)).toHaveLength(1);
    }

    setup.workspace.db.exec("DROP TRIGGER reject_atomic_inquiry_event_source");
    expect(repository.sealInquiryBatch(nextInput)).toMatchObject({ id: nextInput.id, selectedInquiryId: "question-atomic-1" });
    expect(repository.listInquiryLifecycle("question-1").map((entry) => entry.phase)).toEqual(["selected", "answered"]);
    expect(repository.listInquiryLifecycle("question-2")).toMatchObject([
      { phase: "backlog" },
      { phase: "promoted", successorInquiryId: "question-atomic-1", sourceCycleId: nextCycle.id },
    ]);
    expect(repository.listInquiryLifecycle("question-3")).toMatchObject([
      { phase: "backlog" },
      { phase: "closed", closeReason: "superseded", sourceCycleId: nextCycle.id },
    ]);
  });

  it("blocks a consecutive identical Inquiry frontier only when evidence and closure signatures are unchanged", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);
    repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [receiptLink(setup)] }));
    repository.sealInquiryBatch(inquiryBatchInput(cycle.id));
    const changeSet = committedChangeSet(setup.workspace, "stalled-inquiry-output", "stalled inquiry output");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id });
    const nextCycle = repository.beginCycle({
      id: "cycle-stalled", goalId: goal.id, idempotencyKey: "cycle-stalled-key", inputCheckpointId: committed.outputCheckpointId,
      ruleRevision: 1, intent: cycleIntent(),
    });
    const nextRun = seedRun(setup.workspace, setup.branchId, committed.outputCheckpointId!);
    repository.attachRun({ cycleId: nextCycle.id, runId: nextRun.runId });
    repository.recordReceipt(receiptInput(setup, nextCycle.id, nextRun, {
      id: "receipt-stalled", checkpointId: committed.outputCheckpointId, links: [receiptLink(setup)],
    }));
    const candidate = inquiryBatchInput(nextCycle.id, "-stalled");
    const identical = {
      ...candidate,
      questions: candidate.questions.map((question, index) => index === 0
        ? { ...question, fingerprint: "1".repeat(64) }
        : question),
    };

    expect(() => repository.sealInquiryBatch(identical))
      .toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_STALLED" }));
    expect(repository.getInquiryBatch(identical.id)).toBeNull();
    expect(repository.getCycle(nextCycle.id)).toMatchObject({ status: "blocked", failureCode: "GROWTH_INQUIRY_STALLED" });
    expect(repository.getGoal(goal.id)).toMatchObject({ status: "blocked" });
  });

  it("rejects another unresolved or immediately prior fingerprint after the stalled frontier check", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);
    repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [receiptLink(setup)] }));
    repository.sealInquiryBatch(inquiryBatchInput(cycle.id));
    const changeSet = committedChangeSet(setup.workspace, "duplicate-inquiry-output", "duplicate inquiry output");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id });
    const nextCycle = repository.beginCycle({
      id: "cycle-duplicate", goalId: goal.id, idempotencyKey: "cycle-duplicate-key", inputCheckpointId: committed.outputCheckpointId,
      ruleRevision: 1, intent: cycleIntent(),
    });
    const nextRun = seedRun(setup.workspace, setup.branchId, committed.outputCheckpointId!);
    repository.attachRun({ cycleId: nextCycle.id, runId: nextRun.runId });
    repository.recordReceipt(receiptInput(setup, nextCycle.id, nextRun, {
      id: "receipt-duplicate", checkpointId: committed.outputCheckpointId, links: [receiptLink(setup)],
    }));
    const candidate = inquiryBatchInput(nextCycle.id, "-duplicate");
    const duplicatedBacklog = {
      ...candidate,
      questions: candidate.questions.map((question, index) => index === 1
        ? { ...question, fingerprint: "2".repeat(64) }
        : question),
    };

    expect(() => repository.sealInquiryBatch(duplicatedBacklog))
      .toThrowError(expect.objectContaining({ code: "GROWTH_INQUIRY_DUPLICATE" }));
    expect(repository.getInquiryBatch(duplicatedBacklog.id)).toBeNull();
    expect(repository.getCycle(nextCycle.id)).toMatchObject({ status: "running", failureCode: null });
  });

  it("does not treat the same local rank as duplicate or stalled when the new Receipt resolves to another target", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);
    repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [receiptLink(setup)] }));
    repository.sealInquiryBatch(inquiryBatchInput(cycle.id));
    const changeSet = committedChangeSet(setup.workspace, "different-rank-target", "different rank target");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id });
    const other = new ResourceRepository(setup.workspace).putRevisionWithReceipt({
      resourceId: "world.other", create: true, checkpointId: committed.outputCheckpointId!, type: "world", objectKind: "world",
      title: "Other world", parentId: setup.scopeId, state: "active", sortOrder: 1,
    });
    const nextCycle = repository.beginCycle({
      id: "cycle-other-target", goalId: goal.id, idempotencyKey: "cycle-other-target-key", inputCheckpointId: committed.outputCheckpointId,
      ruleRevision: 1, intent: cycleIntent(),
    });
    const nextRun = seedRun(setup.workspace, setup.branchId, committed.outputCheckpointId!);
    repository.attachRun({ cycleId: nextCycle.id, runId: nextRun.runId });
    repository.recordReceipt(receiptInput(setup, nextCycle.id, nextRun, {
      id: "receipt-other-target", checkpointId: committed.outputCheckpointId,
      links: [{
        ...receiptLink(setup), rank: 1, targetId: "world.other", targetVersionId: other.revisionId,
      }],
    }));
    const candidate = inquiryBatchInput(nextCycle.id, "-other-target");
    const sameLocalFingerprint = {
      ...candidate,
      questions: candidate.questions.map((question, index) => index === 0
        ? { ...question, fingerprint: "1".repeat(64) }
        : question),
    };

    expect(repository.sealInquiryBatch(sameLocalFingerprint)).toMatchObject({
      id: sameLocalFingerprint.id, selectedInquiryId: "question-other-target-1",
    });
    expect(repository.getCycle(nextCycle.id)).toMatchObject({ status: "running", failureCode: null });
  });

  it("keeps v4 Steward and Checker submissions invocation-bound and reopens accepted closure through a new revision", () => {
    const setup = createSetup();
    let repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run } = runningCycle(repository, setup);
    const oldReceipt = repository.recordReceipt(receiptInput(setup, cycle.id, run, { links: [receiptLink(setup)] }));
    const changeSet = committedChangeSet(setup.workspace, "closure-output", "closure output");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: changeSet.id });
    const profileInput = {
      id: "profile-world", idempotencyKey: "profile-world-key", goalId: goal.id, profileKind: "world_birth",
      subjectResourceId: null, componentProfiles: [], focusOcResourceId: null, contractGeneration: "v26",
      checkpointId: committed.outputCheckpointId!, ruleRevision: 1,
      facets: [{ id: "history", kind: "content", required: true }, { id: "map", kind: "visual", required: true }],
    } as const;
    const profile = repository.createClosureProfile(profileInput);
    const evaluationCycle = repository.beginCycle({
      id: "cycle-evaluation", goalId: goal.id, idempotencyKey: "cycle-evaluation-key",
      inputCheckpointId: committed.outputCheckpointId, ruleRevision: 1,
      intent: { kind: "closure_evaluation", profileId: profile.id, revision: 1, checkpointId: committed.outputCheckpointId! },
    });
    const evaluationRun = seedRun(setup.workspace, setup.branchId, committed.outputCheckpointId!);
    repository.attachRun({ cycleId: evaluationCycle.id, runId: evaluationRun.runId });
    const receipt = repository.recordReceipt(receiptInput(setup, evaluationCycle.id, evaluationRun, {
      id: "receipt-evaluation", checkpointId: committed.outputCheckpointId, links: [receiptLink(setup)],
    }));
    const stewardHash = "c".repeat(64);
    seedInvocationTerminal(setup.workspace, evaluationRun.runId, evaluationRun.invocationId, stewardHash);
    const checker = seedCheckerInvocation(setup.workspace, evaluationRun.runId, evaluationRun.invocationId, "d".repeat(64));
    const facetResults = [
      { facetId: "history", state: "satisfied" as const, coverage: "complete" as const,
        safeSummary: "History is continuous.", evidence: [{ receiptId: receipt.id, rank: 1 }] },
      { facetId: "map", state: "satisfied" as const, coverage: "complete" as const,
        safeSummary: "Map source is pinned.", evidence: [{ receiptId: receipt.id, rank: 1 }] },
    ];
    const stewardSubmissionInput = {
      id: "assessment-steward", profileId: profile.id, revision: 1, role: "steward", decision: "ready_for_checker",
      cycleId: evaluationCycle.id, checkpointId: committed.outputCheckpointId!, ruleRevision: 1, receiptId: receipt.id,
      agentInvocationId: evaluationRun.invocationId, outputSha256: stewardHash, idempotencyKey: "assessment-steward-key",
      facetResults,
    } as const;
    expect(() => repository.appendClosureStewardSubmission({
      ...stewardSubmissionInput, id: "assessment-old-receipt", receiptId: oldReceipt.id,
      idempotencyKey: "assessment-old-receipt-key",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_ASSESSMENT_REFERENCE_MISMATCH" }));
    const stewardAssessment = repository.appendClosureStewardSubmission(stewardSubmissionInput);
    expect(repository.appendClosureStewardSubmission(stewardSubmissionInput)).toEqual(stewardAssessment);
    expect(() => repository.appendClosureCheckerSubmission({
      id: "assessment-wrong-role", profileId: profile.id, revision: 1, role: "checker", decision: "accepted",
      cycleId: evaluationCycle.id, checkpointId: committed.outputCheckpointId, ruleRevision: 1, receiptId: receipt.id,
      agentInvocationId: evaluationRun.invocationId, outputSha256: stewardHash, idempotencyKey: "assessment-wrong-role-key",
      adverseFindings: [],
    })).toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_INVOCATION_MISMATCH" }));
    const checkerSubmissionInput = {
      id: "assessment-checker", profileId: profile.id, revision: 1, role: "checker", decision: "accepted",
      cycleId: evaluationCycle.id, checkpointId: committed.outputCheckpointId!, ruleRevision: 1, receiptId: receipt.id,
      agentInvocationId: checker.invocationId, outputSha256: checker.outputSha256, idempotencyKey: "assessment-checker-key",
      adverseFindings: [],
    } as const;
    const checkerAssessment = repository.appendClosureCheckerSubmission(checkerSubmissionInput);
    const reviewInput = {
      id: "review-accepted", profileId: profile.id, revision: 1, stewardAssessmentId: stewardAssessment.id,
      checkerAssessmentId: checkerAssessment.id, idempotencyKey: "review-accepted-key",
      facetResults, adverseFindings: [],
    };
    setup.workspace.db.exec(`
      CREATE TEMP TRIGGER reject_growth_closure_review BEFORE INSERT ON growth_closure_reviews
      BEGIN SELECT RAISE(ABORT, 'closure interrupted'); END;
    `);
    expect(() => repository.sealClosureReviewV4({
      ...reviewInput, id: "review-rollback", idempotencyKey: "review-rollback-key",
    })).toThrow();
    expect(setup.workspace.db.prepare("SELECT COUNT(*) AS count FROM growth_closure_reviews").get()).toEqual({ count: 0 });
    expect(repository.getClosureState(profile.id)).toMatchObject({ contentState: "growing", missingFacetIds: ["history"] });
    setup.workspace.db.exec("DROP TRIGGER reject_growth_closure_review");
    const review = repository.sealClosureReviewV4(reviewInput);
    expect(repository.sealClosureReviewV4(reviewInput)).toEqual(review);
    expect(repository.getClosureState(profile.id)).toMatchObject({
      contentState: "growing",
      satisfiedFacetIds: [],
      missingFacetIds: ["history"],
    });
    const outcomeInput = {
      id: "outcome-accepted", cycleId: evaluationCycle.id, profileId: profile.id, revision: 1, receiptId: receipt.id,
      stewardAssessmentId: stewardAssessment.id, checkerAssessmentId: checkerAssessment.id, reviewId: review.id,
      decision: "accepted", idempotencyKey: "outcome-accepted-key",
    } as const;
    const outcome = repository.sealClosureEvaluationOutcome(outcomeInput);
    const { facetResults: _facetResults, ...legacyAssessmentInput } = stewardSubmissionInput;
    expect(() => repository.appendClosureAssessment(legacyAssessmentInput))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_LEGACY_WRITE_FORBIDDEN" }));
    expect(() => repository.sealClosureReview({
      id: "legacy-review", profileId: profile.id, revision: 1, stewardAssessmentId: stewardAssessment.id,
      checkerAssessmentId: checkerAssessment.id, idempotencyKey: "legacy-review-key",
      findings: [{ facetId: "history", state: "satisfied", safeSummary: "Legacy result.", evidence: { receiptId: receipt.id, rank: 1 } }],
    })).toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_LEGACY_WRITE_FORBIDDEN" }));

    workspace?.close();
    workspace = openWorkspace(root!);
    setup.workspace = workspace;
    repository = new GrowthRepository(workspace);
    expect(repository.createClosureProfile(profileInput)).toEqual(profile);
    expect(repository.appendClosureStewardSubmission(stewardSubmissionInput)).toEqual(stewardAssessment);
    expect(repository.appendClosureCheckerSubmission(checkerSubmissionInput)).toEqual(checkerAssessment);
    expect(repository.sealClosureReviewV4(reviewInput)).toEqual(review);
    expect(repository.sealClosureEvaluationOutcome(outcomeInput)).toEqual(outcome);
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
    expect(() => repository.appendClosureRevision({
      profileId: profile.id, expectedRevision: 1, idempotencyKey: "profile-world-invalid-revision-2",
      checkpointId: committed.outputCheckpointId, ruleRevision: 2,
      componentProfiles: ["world_birth"], focusOcResourceId: null, contractGeneration: "v26",
      facets: [{ id: "history", kind: "content", required: true }],
    })).toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_REVISION_SHAPE_INVALID" }));
    expect(repository.getClosureProfile(profile.id)).toMatchObject({ currentRevision: 1, currentEpoch: 1 });
    expect(repository.getClosureRevision(profile.id, 2)).toBeNull();
    const revision = repository.appendClosureRevision({
      profileId: profile.id, expectedRevision: 1, idempotencyKey: "profile-world-revision-2",
      checkpointId: committed.outputCheckpointId, ruleRevision: 2,
      componentProfiles: [], focusOcResourceId: null, contractGeneration: "v26",
      facets: [{ id: "history", kind: "content", required: true }, { id: "map", kind: "visual", required: true }],
    });
    expect(revision).toMatchObject({ revision: 2, epoch: 2 });
    expect(repository.getClosureState(profile.id)).toMatchObject({ contentState: "growing", revision: 2, missingFacetIds: ["history"] });
    expect(repository.getClosureReview(review.id)).toBeNull();
    expect(repository.getClosureReviewV4(review.id)).toEqual(review);
  });

  it("persists typed v4 Closure evaluation and terminalizes the evaluation Cycle atomically without content output", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run: contentRun } = runningCycle(repository, setup);
    repository.recordReceipt(receiptInput(setup, cycle.id, contentRun, { id: "receipt-v4-content", links: [receiptLink(setup)] }));
    const contentChangeSet = committedChangeSet(setup.workspace, "v4-closure-base", "v4 closure base");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: contentChangeSet.id });
    const profile = repository.createClosureProfile({
      id: "profile-v4", idempotencyKey: "profile-v4-key", goalId: goal.id, profileKind: "world_birth",
      subjectResourceId: null, componentProfiles: [], focusOcResourceId: null, contractGeneration: "v26",
      checkpointId: committed.outputCheckpointId!, ruleRevision: 1,
      facets: [{ id: "history", kind: "content", required: true }],
    });
    const evaluationCycle = repository.beginCycle({
      id: "cycle-v4-evaluation", goalId: goal.id, idempotencyKey: "cycle-v4-evaluation-key",
      inputCheckpointId: committed.outputCheckpointId!, ruleRevision: 1,
      intent: { kind: "closure_evaluation", profileId: profile.id, revision: 1, checkpointId: committed.outputCheckpointId! },
    });
    const run = seedRun(setup.workspace, setup.branchId, committed.outputCheckpointId!);
    repository.attachRun({ cycleId: evaluationCycle.id, runId: run.runId });
    const receipt = repository.recordReceipt(receiptInput(setup, evaluationCycle.id, run, {
      id: "receipt-v4-evaluation", checkpointId: committed.outputCheckpointId!, links: [receiptLink(setup)],
    }));
    const stewardHash = "a".repeat(64);
    seedInvocationTerminal(setup.workspace, run.runId, run.invocationId, stewardHash);
    const checker = seedCheckerInvocation(setup.workspace, run.runId, run.invocationId, "b".repeat(64));
    const steward = repository.appendClosureStewardSubmission({
      id: "submission-v4-steward", profileId: profile.id, revision: 1, role: "steward", decision: "ready_for_checker",
      cycleId: evaluationCycle.id, checkpointId: committed.outputCheckpointId!, ruleRevision: 1, receiptId: receipt.id,
      agentInvocationId: run.invocationId, outputSha256: stewardHash, idempotencyKey: "submission-v4-steward-key",
      facetResults: [{ facetId: "history", state: "satisfied", coverage: "complete", safeSummary: "History is evidenced.", evidence: [{ receiptId: receipt.id, rank: 1 }] }],
    });
    const checkerSubmission = repository.appendClosureCheckerSubmission({
      id: "submission-v4-checker", profileId: profile.id, revision: 1, role: "checker", decision: "accepted",
      cycleId: evaluationCycle.id, checkpointId: committed.outputCheckpointId!, ruleRevision: 1, receiptId: receipt.id,
      agentInvocationId: checker.invocationId, outputSha256: checker.outputSha256, idempotencyKey: "submission-v4-checker-key",
      adverseFindings: [],
    });
    const review = repository.sealClosureReviewV4({
      id: "review-v4", profileId: profile.id, revision: 1, stewardAssessmentId: steward.id,
      checkerAssessmentId: checkerSubmission.id, idempotencyKey: "review-v4-key",
      facetResults: [{ facetId: "history", state: "satisfied", coverage: "complete", safeSummary: "History is evidenced.", evidence: [{ receiptId: receipt.id, rank: 1 }] }],
      adverseFindings: [],
    });
    const outcomeInput = {
      id: "outcome-v4", cycleId: evaluationCycle.id, profileId: profile.id, revision: 1, receiptId: receipt.id,
      stewardAssessmentId: steward.id, checkerAssessmentId: checkerSubmission.id, reviewId: review.id,
      decision: "accepted", idempotencyKey: "outcome-v4-key",
    } as const;
    const outcome = repository.sealClosureEvaluationOutcome(outcomeInput);

    expect(repository.sealClosureEvaluationOutcome(outcomeInput)).toEqual(outcome);
    expect(repository.getCycle(evaluationCycle.id)).toMatchObject({
      status: "evaluated", receiptId: receipt.id, changeSetId: null, outputCheckpointId: null, failureCode: null,
    });
    expect(repository.listEvents(goal.id).slice(-1)).toMatchObject([{
      cycleId: evaluationCycle.id, phase: "cycle_evaluated", targetKind: "closure_evaluation",
      targetId: outcome.id, durableState: "evaluated", contentRef: null,
    }]);

    setup.workspace.db.prepare("DELETE FROM growth_events WHERE goal_id = ? AND phase = 'cycle_evaluated'").run(goal.id);
    expect(repository.repairClosureEvaluationEvent(evaluationCycle.id)).toMatchObject({
      phase: "cycle_evaluated", targetId: outcome.id,
    });
    expect(repository.repairClosureEvaluationEvent(evaluationCycle.id)).toEqual(repository.listEvents(goal.id).at(-1));
  });

  it("persists one selected repair finding, leaves the rest in backlog, rejects blocked reviews and stalls a repeated fingerprint", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run: contentRun } = runningCycle(repository, setup);
    repository.recordReceipt(receiptInput(setup, cycle.id, contentRun, { id: "receipt-repair-content", links: [receiptLink(setup)] }));
    const contentChangeSet = committedChangeSet(setup.workspace, "repair-base", "repair base");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: contentChangeSet.id });
    const repairProfile = repository.createClosureProfile({
      id: "profile-repair", idempotencyKey: "profile-repair-key", goalId: goal.id, profileKind: "world_birth",
      subjectResourceId: null, componentProfiles: [], focusOcResourceId: null, contractGeneration: "v26",
      checkpointId: committed.outputCheckpointId!, ruleRevision: 1,
      facets: [{ id: "history", kind: "content", required: true }],
    });
    const blockedProfile = repository.createClosureProfile({
      id: "profile-blocked", idempotencyKey: "profile-blocked-key", goalId: goal.id, profileKind: "world_birth",
      subjectResourceId: null, componentProfiles: [], focusOcResourceId: null, contractGeneration: "v26",
      checkpointId: committed.outputCheckpointId!, ruleRevision: 1,
      facets: [{ id: "history", kind: "content", required: true }],
    });
    const selectedFinding = {
      id: "finding-selected", fingerprint: "1".repeat(64), severity: "major" as const, category: "causality" as const,
      targetEvidence: [{ receiptId: "placeholder", rank: 1 }], safeSummary: "History contradicts its cause.",
      repairObjective: "Repair the causal transition without changing the creator rule.",
    };
    const backlogFinding = {
      id: "finding-backlog", fingerprint: "2".repeat(64), severity: "minor" as const, category: "continuity" as const,
      targetEvidence: [{ receiptId: "placeholder", rank: 1 }], safeSummary: "A minor date remains unclear.",
      repairObjective: "Clarify the date after the blocking repair.",
    };
    const repairEvaluation = completeClosureEvaluation(repository, setup, {
      goalId: goal.id, profileId: repairProfile.id, checkpointId: committed.outputCheckpointId!, suffix: "repair",
      checkerDecision: "repairs_required", adverseFindings: [selectedFinding, backlogFinding],
    });
    const blockingFinding = {
      id: "finding-blocking", fingerprint: "3".repeat(64), severity: "blocking" as const,
      category: "creator_choice_required" as const, targetEvidence: [{ receiptId: "placeholder", rank: 1 }],
      safeSummary: "Creator intent is required.", repairObjective: "Ask the creator before changing canon.",
    };
    const blockedEvaluation = completeClosureEvaluation(repository, setup, {
      goalId: goal.id, profileId: blockedProfile.id, checkpointId: committed.outputCheckpointId!, suffix: "blocked",
      checkerDecision: "blocked", adverseFindings: [blockingFinding],
    });
    expect(() => repository.beginCycle({
      id: "cycle-blocked-repair", goalId: goal.id, idempotencyKey: "cycle-blocked-repair-key",
      inputCheckpointId: committed.outputCheckpointId!, ruleRevision: 1,
      intent: {
        kind: "repair", profileId: blockedProfile.id, revision: 1, originalReviewId: blockedEvaluation.review.id,
        selectedFindingId: blockingFinding.id, selectedFindingFingerprint: blockingFinding.fingerprint,
      },
    })).toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_REPAIR_INTENT_INVALID" }));

    const firstRepairCycle = repository.beginCycle({
      id: "cycle-repair-first", goalId: goal.id, idempotencyKey: "cycle-repair-first-key",
      inputCheckpointId: committed.outputCheckpointId!, ruleRevision: 1,
      intent: {
        kind: "repair", profileId: repairProfile.id, revision: 1, originalReviewId: repairEvaluation.review.id,
        selectedFindingId: selectedFinding.id, selectedFindingFingerprint: selectedFinding.fingerprint,
      },
    });
    const firstLineageInput = {
      id: "lineage-first", profileId: repairProfile.id, revision: 1, originalReviewId: repairEvaluation.review.id,
      selectedFindingId: selectedFinding.id, selectedFindingFingerprint: selectedFinding.fingerprint,
      repairCycleId: firstRepairCycle.id, backlogFindingIds: [backlogFinding.id], idempotencyKey: "lineage-first-key",
    } as const;
    const firstLineage = repository.createClosureRepairLineage(firstLineageInput);
    expect(firstLineage).toMatchObject({ resolutionState: "planned", backlogFindingIds: [backlogFinding.id] });
    expect(repository.createClosureRepairLineage(firstLineageInput)).toEqual(firstLineage);
    expect(() => repository.markClosureRepairResolution(firstLineage.id, "committed"))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_REPAIR_CYCLE_NOT_COMMITTED" }));
    const firstRepairRun = seedRun(setup.workspace, setup.branchId, committed.outputCheckpointId!);
    repository.attachRun({ cycleId: firstRepairCycle.id, runId: firstRepairRun.runId });
    repository.recordReceipt(receiptInput(setup, firstRepairCycle.id, firstRepairRun, {
      id: "receipt-repair-first", checkpointId: committed.outputCheckpointId!, links: [receiptLink(setup)],
    }));
    const repairChangeSet = committedChangeSet(setup.workspace, "repair-first", "repair first");
    const firstRepairCommitted = repository.attachCommittedChangeSet({ cycleId: firstRepairCycle.id, changeSetId: repairChangeSet.id });
    const committedLineage = repository.markClosureRepairResolution(firstLineage.id, "committed");
    expect(committedLineage).toMatchObject({ resolutionState: "committed" });
    expect(repository.markClosureRepairResolution(firstLineage.id, "committed")).toEqual(committedLineage);
    expect(() => repository.markClosureRepairResolution(firstLineage.id, "no_progress"))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_REPAIR_TRANSITION_INVALID" }));

    const secondRepairCycle = repository.beginCycle({
      id: "cycle-repair-second", goalId: goal.id, idempotencyKey: "cycle-repair-second-key",
      inputCheckpointId: firstRepairCommitted.outputCheckpointId!, ruleRevision: 1,
      intent: {
        kind: "repair", profileId: repairProfile.id, revision: 1, originalReviewId: repairEvaluation.review.id,
        selectedFindingId: selectedFinding.id, selectedFindingFingerprint: selectedFinding.fingerprint,
      },
    });
    const secondLineage = repository.createClosureRepairLineage({
      id: "lineage-second", profileId: repairProfile.id, revision: 1, originalReviewId: repairEvaluation.review.id,
      selectedFindingId: selectedFinding.id, selectedFindingFingerprint: selectedFinding.fingerprint,
      repairCycleId: secondRepairCycle.id, backlogFindingIds: [backlogFinding.id], idempotencyKey: "lineage-second-key",
    });
    expect(secondLineage).toMatchObject({ resolutionState: "stalled", backlogFindingIds: [backlogFinding.id] });
    expect(repository.getClosureRepairStallState(repairProfile.id, 1, selectedFinding.fingerprint)).toEqual({
      stalled: true, sameFingerprintAttempts: 2, noProgressAttempts: 1,
    });
    expect(() => repository.markClosureRepairResolution(secondLineage.id, "committed"))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_REPAIR_TRANSITION_INVALID" }));
  });

  it("stalls after two committed repair Cycles make no progress on different findings", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run: contentRun } = runningCycle(repository, setup);
    repository.recordReceipt(receiptInput(setup, cycle.id, contentRun, { id: "receipt-no-progress-content", links: [receiptLink(setup)] }));
    const contentChangeSet = committedChangeSet(setup.workspace, "no-progress-base", "no progress base");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: contentChangeSet.id });
    const profile = repository.createClosureProfile({
      id: "profile-no-progress", idempotencyKey: "profile-no-progress-key", goalId: goal.id, profileKind: "world_birth",
      subjectResourceId: null, componentProfiles: [], focusOcResourceId: null, contractGeneration: "v26",
      checkpointId: committed.outputCheckpointId!, ruleRevision: 1,
      facets: [{ id: "history", kind: "content", required: true }],
    });
    const firstFinding = {
      id: "finding-no-progress-first", fingerprint: "4".repeat(64), severity: "major" as const, category: "causality" as const,
      targetEvidence: [{ receiptId: "placeholder", rank: 1 }], safeSummary: "The first cause is unresolved.",
      repairObjective: "Repair the first causal gap.",
    };
    const secondFinding = {
      id: "finding-no-progress-second", fingerprint: "5".repeat(64), severity: "major" as const, category: "continuity" as const,
      targetEvidence: [{ receiptId: "placeholder", rank: 1 }], safeSummary: "The second transition is unresolved.",
      repairObjective: "Repair the second continuity gap.",
    };
    const evaluation = completeClosureEvaluation(repository, setup, {
      goalId: goal.id, profileId: profile.id, checkpointId: committed.outputCheckpointId!, suffix: "no-progress",
      checkerDecision: "repairs_required", adverseFindings: [firstFinding, secondFinding],
    });

    const firstCycle = repository.beginCycle({
      id: "cycle-no-progress-first", goalId: goal.id, idempotencyKey: "cycle-no-progress-first-key",
      inputCheckpointId: committed.outputCheckpointId!, ruleRevision: 1,
      intent: {
        kind: "repair", profileId: profile.id, revision: 1, originalReviewId: evaluation.review.id,
        selectedFindingId: firstFinding.id, selectedFindingFingerprint: firstFinding.fingerprint,
      },
    });
    const firstLineage = repository.createClosureRepairLineage({
      id: "lineage-no-progress-first", profileId: profile.id, revision: 1, originalReviewId: evaluation.review.id,
      selectedFindingId: firstFinding.id, selectedFindingFingerprint: firstFinding.fingerprint,
      repairCycleId: firstCycle.id, backlogFindingIds: [secondFinding.id], idempotencyKey: "lineage-no-progress-first-key",
    });
    const firstRun = seedRun(setup.workspace, setup.branchId, committed.outputCheckpointId!);
    repository.attachRun({ cycleId: firstCycle.id, runId: firstRun.runId });
    repository.recordReceipt(receiptInput(setup, firstCycle.id, firstRun, {
      id: "receipt-no-progress-first", checkpointId: committed.outputCheckpointId!, links: [receiptLink(setup)],
    }));
    const firstChangeSet = committedChangeSet(setup.workspace, "no-progress-first", "no progress first");
    const firstCommitted = repository.attachCommittedChangeSet({ cycleId: firstCycle.id, changeSetId: firstChangeSet.id });
    const firstNoProgress = repository.markClosureRepairResolution(firstLineage.id, "no_progress");
    expect(firstNoProgress).toMatchObject({ resolutionState: "no_progress" });
    expect(repository.markClosureRepairResolution(firstLineage.id, "no_progress")).toEqual(firstNoProgress);
    expect(() => repository.markClosureRepairResolution(firstLineage.id, "committed"))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_REPAIR_TRANSITION_INVALID" }));

    const secondCycle = repository.beginCycle({
      id: "cycle-no-progress-second", goalId: goal.id, idempotencyKey: "cycle-no-progress-second-key",
      inputCheckpointId: firstCommitted.outputCheckpointId!, ruleRevision: 1,
      intent: {
        kind: "repair", profileId: profile.id, revision: 1, originalReviewId: evaluation.review.id,
        selectedFindingId: secondFinding.id, selectedFindingFingerprint: secondFinding.fingerprint,
      },
    });
    const secondLineage = repository.createClosureRepairLineage({
      id: "lineage-no-progress-second", profileId: profile.id, revision: 1, originalReviewId: evaluation.review.id,
      selectedFindingId: secondFinding.id, selectedFindingFingerprint: secondFinding.fingerprint,
      repairCycleId: secondCycle.id, backlogFindingIds: [firstFinding.id], idempotencyKey: "lineage-no-progress-second-key",
    });
    expect(secondLineage.resolutionState).toBe("planned");
    const secondRun = seedRun(setup.workspace, setup.branchId, firstCommitted.outputCheckpointId!);
    repository.attachRun({ cycleId: secondCycle.id, runId: secondRun.runId });
    repository.recordReceipt(receiptInput(setup, secondCycle.id, secondRun, {
      id: "receipt-no-progress-second", checkpointId: firstCommitted.outputCheckpointId!, links: [receiptLink(setup)],
    }));
    const secondChangeSet = committedChangeSet(setup.workspace, "no-progress-second", "no progress second");
    repository.attachCommittedChangeSet({ cycleId: secondCycle.id, changeSetId: secondChangeSet.id });
    const secondNoProgress = repository.markClosureRepairResolution(secondLineage.id, "no_progress");
    expect(secondNoProgress).toMatchObject({ resolutionState: "stalled" });
    expect(repository.markClosureRepairResolution(secondLineage.id, "no_progress")).toEqual(secondNoProgress);
    expect(repository.getClosureRepairStallState(profile.id, 1, secondFinding.fingerprint)).toEqual({
      stalled: true, sameFingerprintAttempts: 1, noProgressAttempts: 2,
    });
  });

  it("resolves a committed repair only after a later accepted Closure revision evaluates its output checkpoint", () => {
    const setup = createSetup();
    const repository = new GrowthRepository(setup.workspace);
    const { goal, cycle, run: contentRun } = runningCycle(repository, setup);
    repository.recordReceipt(receiptInput(setup, cycle.id, contentRun, {
      id: "receipt-repair-resolution-content", links: [receiptLink(setup)],
    }));
    const contentChangeSet = committedChangeSet(setup.workspace, "repair-resolution-base", "repair resolution base");
    const committed = repository.attachCommittedChangeSet({ cycleId: cycle.id, changeSetId: contentChangeSet.id });
    const profile = repository.createClosureProfile({
      id: "profile-repair-resolution", idempotencyKey: "profile-repair-resolution-key", goalId: goal.id,
      profileKind: "world_birth", subjectResourceId: null, componentProfiles: [], focusOcResourceId: null,
      contractGeneration: "v26", checkpointId: committed.outputCheckpointId!, ruleRevision: 1,
      facets: [{ id: "history", kind: "content", required: true }],
    });
    const finding = {
      id: "finding-repair-resolution", fingerprint: "6".repeat(64), severity: "major" as const,
      category: "causality" as const, targetEvidence: [{ receiptId: "placeholder", rank: 1 }],
      safeSummary: "One consequence is unsupported.", repairObjective: "Add the missing causal bridge.",
    };
    const evaluation = completeClosureEvaluation(repository, setup, {
      goalId: goal.id, profileId: profile.id, checkpointId: committed.outputCheckpointId!, suffix: "repair-resolution-before",
      checkerDecision: "repairs_required", adverseFindings: [finding],
    });
    const repairCycle = repository.beginCycle({
      id: "cycle-repair-resolution", goalId: goal.id, idempotencyKey: "cycle-repair-resolution-key",
      inputCheckpointId: committed.outputCheckpointId!, ruleRevision: 1,
      intent: {
        kind: "repair", profileId: profile.id, revision: 1, originalReviewId: evaluation.review.id,
        selectedFindingId: finding.id, selectedFindingFingerprint: finding.fingerprint,
      },
    });
    const lineage = repository.createClosureRepairLineage({
      id: "lineage-repair-resolution", profileId: profile.id, revision: 1, originalReviewId: evaluation.review.id,
      selectedFindingId: finding.id, selectedFindingFingerprint: finding.fingerprint,
      repairCycleId: repairCycle.id, backlogFindingIds: [], idempotencyKey: "lineage-repair-resolution-key",
    });
    const repairRun = seedRun(setup.workspace, setup.branchId, committed.outputCheckpointId!);
    repository.attachRun({ cycleId: repairCycle.id, runId: repairRun.runId });
    repository.recordReceipt(receiptInput(setup, repairCycle.id, repairRun, {
      id: "receipt-repair-resolution", checkpointId: committed.outputCheckpointId!, links: [receiptLink(setup)],
    }));
    const repairChangeSet = committedChangeSet(setup.workspace, "repair-resolution", "repair resolution");
    const repairCommitted = repository.attachCommittedChangeSet({ cycleId: repairCycle.id, changeSetId: repairChangeSet.id });
    const committedLineage = repository.markClosureRepairResolution(lineage.id, "committed");
    expect(() => repository.markClosureRepairResolution(lineage.id, "resolved"))
      .toThrowError(expect.objectContaining({ code: "GROWTH_CLOSURE_REPAIR_RESOLUTION_UNPROVEN" }));

    const revision = repository.appendClosureRevision({
      profileId: profile.id, expectedRevision: 1, idempotencyKey: "profile-repair-resolution-revision-2",
      checkpointId: repairCommitted.outputCheckpointId!, ruleRevision: 1,
      componentProfiles: [], focusOcResourceId: null, contractGeneration: "v26",
      facets: [{ id: "history", kind: "content", required: true }],
    });
    completeClosureEvaluation(repository, setup, {
      goalId: goal.id, profileId: profile.id, revision: revision.revision,
      checkpointId: repairCommitted.outputCheckpointId!, suffix: "repair-resolution-after",
      checkerDecision: "accepted", adverseFindings: [],
    });
    const resolved = repository.markClosureRepairResolution(lineage.id, "resolved");
    expect(resolved).toMatchObject({ resolutionState: "resolved" });
    expect(repository.markClosureRepairResolution(lineage.id, "resolved")).toEqual(resolved);
    expect(committedLineage.resolutionState).toBe("committed");
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

function completeClosureEvaluation(
  repository: GrowthRepository,
  setup: ReturnType<typeof createSetup>,
  input: {
    goalId: string;
    profileId: string;
    revision?: number;
    checkpointId: string;
    suffix: string;
    checkerDecision: "accepted" | "repairs_required" | "blocked";
    adverseFindings: Array<{
      id: string;
      fingerprint: string;
      severity: "minor" | "major" | "blocking";
      category: "world_consistency" | "story_consistency" | "character_consistency" | "causality" | "continuity"
        | "evidence_gap" | "scope_violation" | "creator_choice_required";
      targetEvidence: Array<{ receiptId: string; rank: number }>;
      safeSummary: string;
      repairObjective: string;
    }>;
  },
) {
  const revision = input.revision ?? 1;
  const cycle = repository.beginCycle({
    id: `cycle-evaluation-${input.suffix}`, goalId: input.goalId,
    idempotencyKey: `cycle-evaluation-${input.suffix}-key`, inputCheckpointId: input.checkpointId, ruleRevision: 1,
    intent: { kind: "closure_evaluation", profileId: input.profileId, revision, checkpointId: input.checkpointId },
  });
  const run = seedRun(setup.workspace, setup.branchId, input.checkpointId);
  repository.attachRun({ cycleId: cycle.id, runId: run.runId });
  const receipt = repository.recordReceipt(receiptInput(setup, cycle.id, run, {
    id: `receipt-evaluation-${input.suffix}`, checkpointId: input.checkpointId, links: [receiptLink(setup)],
  }));
  const stewardHash = hashText(`steward-${input.suffix}`);
  seedInvocationTerminal(setup.workspace, run.runId, run.invocationId, stewardHash);
  const checker = seedCheckerInvocation(setup.workspace, run.runId, run.invocationId, hashText(`checker-${input.suffix}`));
  const facetResults = [{
    facetId: "history",
    state: input.checkerDecision === "accepted" ? "satisfied" as const
      : input.checkerDecision === "blocked" ? "blocked" as const : "missing" as const,
    coverage: input.checkerDecision === "accepted" ? "complete" as const : "partial" as const,
    safeSummary: input.checkerDecision === "accepted" ? "History is now coherent." : "History still requires resolution.",
    evidence: [{ receiptId: receipt.id, rank: 1 }],
  }];
  const adverseFindings = input.adverseFindings.map((finding) => ({
    ...finding, targetEvidence: finding.targetEvidence.map((link) => ({ ...link, receiptId: receipt.id })),
  }));
  const steward = repository.appendClosureStewardSubmission({
    id: `submission-steward-${input.suffix}`, profileId: input.profileId, revision, role: "steward",
    decision: "ready_for_checker", cycleId: cycle.id, checkpointId: input.checkpointId, ruleRevision: 1,
    receiptId: receipt.id, agentInvocationId: run.invocationId, outputSha256: stewardHash,
    idempotencyKey: `submission-steward-${input.suffix}-key`, facetResults,
  });
  const checkerSubmission = repository.appendClosureCheckerSubmission({
    id: `submission-checker-${input.suffix}`, profileId: input.profileId, revision, role: "checker",
    decision: input.checkerDecision, cycleId: cycle.id, checkpointId: input.checkpointId, ruleRevision: 1,
    receiptId: receipt.id, agentInvocationId: checker.invocationId, outputSha256: checker.outputSha256,
    idempotencyKey: `submission-checker-${input.suffix}-key`, adverseFindings,
  });
  const review = repository.sealClosureReviewV4({
    id: `review-${input.suffix}`, profileId: input.profileId, revision, stewardAssessmentId: steward.id,
    checkerAssessmentId: checkerSubmission.id, idempotencyKey: `review-${input.suffix}-key`, facetResults, adverseFindings,
  });
  const outcome = repository.sealClosureEvaluationOutcome({
    id: `outcome-${input.suffix}`, cycleId: cycle.id, profileId: input.profileId, revision, receiptId: receipt.id,
    stewardAssessmentId: steward.id, checkerAssessmentId: checkerSubmission.id, reviewId: review.id,
    decision: input.checkerDecision, idempotencyKey: `outcome-${input.suffix}-key`,
  });
  return { cycle, receipt, steward, checkerSubmission, review, outcome };
}

function inquiryBatchInput(cycleId: string, suffix = "") {
  const questionId = (sequence: number) => `question${suffix}-${sequence}`;
  return {
    id: `inquiry-batch${suffix}`, cycleId, idempotencyKey: `inquiry-batch-key${suffix}`,
    selectedInquiryId: questionId(1), creatorChoiceRequiredInquiryId: null,
    questions: [
      { id: questionId(1), question: "What is known?", evidenceState: "known" as const, safeSummary: "Known source.",
        proposedAction: "Use the pinned fact.", provisionalAssumption: null, requiresCreatorChoice: false, priority: 3,
        fingerprint: suffix ? "4".repeat(64) : "1".repeat(64), evidenceRanks: [1] },
      { id: questionId(2), question: "What conflicts?", evidenceState: "unknown" as const, safeSummary: "No conflict evidence.",
        proposedAction: "Test one provisional consequence.", provisionalAssumption: "No conflict is present yet.",
        requiresCreatorChoice: false, priority: 2, fingerprint: suffix ? "5".repeat(64) : "2".repeat(64), evidenceRanks: [] },
      { id: questionId(3), question: "What remains?", evidenceState: "unknown" as const, safeSummary: "An open frontier.",
        proposedAction: "Trace the next consequence.", provisionalAssumption: "The frontier remains unresolved.",
        requiresCreatorChoice: false, priority: 1, fingerprint: suffix ? "6".repeat(64) : "3".repeat(64), evidenceRanks: [] },
    ],
  };
}

function creatorChoiceBatchInput(cycleId: string) {
  const input = inquiryBatchInput(cycleId);
  return {
    ...input,
    selectedInquiryId: null,
    creatorChoiceRequiredInquiryId: "question-1",
    questions: input.questions.map((question, index) => index === 0
      ? {
        ...question,
        question: "Should the port remain autonomous?",
        safeSummary: "Creator choice required.",
        proposedAction: "Wait for the creator's free-text guidance.",
        requiresCreatorChoice: true,
      }
      : question),
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
