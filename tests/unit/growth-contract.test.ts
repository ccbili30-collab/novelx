import { describe, expect, it } from "vitest";
import {
  growthContractVersion,
  growthClosureProfileCreateSchema,
  growthCycleBeginSchema,
  growthCycleSchema,
  growthEventAppendSchema,
  growthEventSchema,
  growthInquiryCreatorAnswerCreateSchema,
  growthInquiryLifecycleAppendSchema,
  growthRetrievalReceiptCreateSchema,
  growthRetrievalReceiptSchema,
  growthInquiryBatchSealSchema,
  growthIllustrationAnchorSchema,
  growthIllustrationBatchSealSchema,
} from "../../src/shared/growthContract";

const now = "2026-07-15T00:00:00.000Z";

describe("growth persistence contract", () => {
  it("publishes strict v1 output contracts", () => {
    expect(growthContractVersion).toBe("1.0.0");
    expect(growthCycleSchema.safeParse({
      id: "cycle-1", goalId: "goal-1", sequence: 1, idempotencyKey: "idem-1", inputCheckpointId: "checkpoint-1",
      ruleRevision: 1, runId: null, receiptId: null, changeSetId: null, outputCheckpointId: null, status: "planned",
      failureCode: null, createdAt: now, updatedAt: now, terminalAt: null, unexpected: true,
    }).success).toBe(false);
  });

  it("accepts only repository-owned receipt hashes, counts and time", () => {
    const receipt = baseReceiptCreate();
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, queryHash: "a".repeat(64) }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, hitCount: 0 }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, createdAt: now }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, lens: "player" }).success).toBe(false);
    expect(growthEventAppendSchema.safeParse({ ...baseEventAppend(), createdAt: now }).success).toBe(false);
  });

  it("rejects non-canonical links and contradictory coverage", () => {
    const receipt = baseReceiptCreate();
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, links: [{ ...receipt.links[0], rank: 2 }] }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, links: [{ ...receipt.links[0], targetVersionId: null }] }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, links: [{ ...receipt.links[0], targetKind: "image" }] }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, links: [{ ...receipt.links[0], stableLocator: "line:1" }] }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, links: [{ ...receipt.links[0], pathTargetIds: ["a", "a"] }] }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, coverage: { state: "complete", searchedScopeCount: 2, omittedCount: 1 } }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, truncated: true }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, resultBudget: 0 }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({
      ...receipt, resultBudget: 1, links: [receipt.links[0], { ...receipt.links[0], rank: 2, targetId: "scope-2" }],
    }).success).toBe(false);
  });

  it("compares filter instants rather than ISO string spelling", () => {
    const receipt = baseReceiptCreate();
    expect(growthRetrievalReceiptCreateSchema.safeParse({
      ...receipt, validTime: { from: "2026-07-15T08:00:00+08:00", to: "2026-07-15T00:30:00Z" },
    }).success).toBe(true);
    expect(growthRetrievalReceiptCreateSchema.safeParse({
      ...receipt, validTime: { from: "2026-07-15T00:31:00Z", to: "2026-07-15T08:00:00+08:00" },
    }).success).toBe(false);
  });

  it("keeps Retrieval targets separate from strict Inquiry event targets", () => {
    expect(growthEventAppendSchema.safeParse({ ...baseEventAppend(), phase: "goal_created" }).success).toBe(false);
    expect(growthEventAppendSchema.safeParse({ ...baseEventAppend(), targetKind: "image" }).success).toBe(false);
    expect(growthEventAppendSchema.safeParse({ ...baseEventAppend(), contentRef: { kind: "image", targetId: "image-1", targetVersionId: "job-1" } }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({
      ...baseReceiptCreate(), links: [{ ...baseReceiptCreate().links[0], targetKind: "inquiry" }],
    }).success).toBe(false);
    const selected = {
      ...baseEventAppend(), phase: "inquiry_selected" as const, targetKind: "inquiry" as const,
      targetId: "inquiry-1", targetVersionId: null, contentRef: null,
    };
    expect(growthEventAppendSchema.safeParse(selected).success).toBe(true);
    expect(growthEventAppendSchema.safeParse({ ...selected, durableState: "blocked" }).success).toBe(false);
    expect(growthEventAppendSchema.safeParse({ ...selected, contentRef: { kind: "resource", targetId: "world", targetVersionId: "v1" } }).success).toBe(false);
    expect(growthEventAppendSchema.safeParse({
      ...selected, phase: "creator_choice_required", durableState: "blocked",
    }).success).toBe(true);
    expect(growthEventAppendSchema.safeParse({ ...baseEventAppend(), targetKind: "inquiry" }).success).toBe(false);
    expect(growthEventSchema.safeParse({ ...baseEventAppend(), createdAt: now }).success).toBe(true);
  });

  it("requires ordered unique v24 Cycle intent for every new Cycle", () => {
    const input = {
      id: "cycle-1", goalId: "goal-1", idempotencyKey: "cycle-key", inputCheckpointId: "checkpoint-1", ruleRevision: 2,
      intent: { kind: "revision" as const, focusKinds: ["oc" as const, "world" as const], resumeFrontier: ["story" as const] },
    };
    expect(growthCycleBeginSchema.safeParse(input).success).toBe(true);
    const { intent: _intent, ...legacyInput } = input;
    expect(growthCycleBeginSchema.safeParse(legacyInput).success).toBe(false);
    expect(growthCycleBeginSchema.safeParse({ ...input, intent: { ...input.intent, focusKinds: ["oc", "oc"] } }).success).toBe(false);
    expect(growthCycleBeginSchema.safeParse({ ...input, intent: { ...input.intent, ruleRevision: 2 } }).success).toBe(false);
  });

  it("requires complete v25 Inquiry detail and one exact selected or creator-choice question", () => {
    const questions = Array.from({ length: 3 }, (_, index) => ({
      id: `question-${index}`, question: `Question ${index}?`, evidenceState: "unknown" as const,
      safeSummary: `Summary ${index}`, proposedAction: `Action ${index}`, provisionalAssumption: `Assumption ${index}`,
      requiresCreatorChoice: false, priority: 3 - index, fingerprint: String(index).repeat(64), evidenceRanks: [],
    }));
    const batch = {
      id: "inquiry-1", cycleId: "cycle-1", idempotencyKey: "inquiry-key",
      selectedInquiryId: questions[0].id, creatorChoiceRequiredInquiryId: null, questions,
    };
    expect(growthInquiryBatchSealSchema.safeParse(batch).success).toBe(true);
    expect(growthInquiryBatchSealSchema.safeParse({ ...batch, questions: questions.slice(0, 2) }).success).toBe(false);
    expect(growthInquiryBatchSealSchema.safeParse({ ...batch, selectedInquiryId: null }).success).toBe(false);
    expect(growthInquiryBatchSealSchema.safeParse({
      ...batch,
      selectedInquiryId: null,
      creatorChoiceRequiredInquiryId: questions[0].id,
      questions: questions.map((question, index) => index === 0
        ? { ...question, requiresCreatorChoice: true, provisionalAssumption: null }
        : question),
    }).success).toBe(true);
    expect(growthInquiryBatchSealSchema.safeParse({
      ...batch, questions: questions.map((question, index) => index === 1
        ? { ...question, provisionalAssumption: null }
        : question),
    }).success).toBe(false);
    expect(growthInquiryBatchSealSchema.safeParse({
      ...batch, questions: questions.map((question, index) => index === 0
        ? { ...question, proposedAction: "" }
        : question),
    }).success).toBe(false);
    expect(growthInquiryBatchSealSchema.safeParse({ ...batch, selectedInquiryId: questions[2].id }).success).toBe(false);
  });

  it("keeps creator_answered internal and requires strict evidence-driven lifecycle shapes", () => {
    const common = {
      inquiryId: "inquiry-1", idempotencyKey: "lifecycle-key", expectedSequence: 1, sourceCycleId: "cycle-2",
    };
    expect(growthInquiryLifecycleAppendSchema.safeParse({
      ...common, phase: "promoted", successorInquiryId: "inquiry-2",
    }).success).toBe(true);
    expect(growthInquiryLifecycleAppendSchema.safeParse({ ...common, phase: "answered" }).success).toBe(true);
    expect(growthInquiryLifecycleAppendSchema.safeParse({
      ...common, phase: "closed", reason: "superseded",
    }).success).toBe(true);
    expect(growthInquiryLifecycleAppendSchema.safeParse({
      ...common, phase: "closed", reason: "closure_accepted",
    }).success).toBe(false);
    expect(growthInquiryLifecycleAppendSchema.safeParse({ ...common, phase: "creator_answered" }).success).toBe(false);

    const answer = {
      inquiryId: "inquiry-1", idempotencyKey: "answer-key", expectedRuleRevision: 1,
      expectedLifecycleSequence: 1, answerText: "保留港口自治，但祭司掌握历法。", sourceMessageId: "message-1",
    };
    expect(growthInquiryCreatorAnswerCreateSchema.safeParse(answer).success).toBe(true);
    expect(growthInquiryCreatorAnswerCreateSchema.safeParse({ ...answer, answerText: "" }).success).toBe(false);
    expect(growthInquiryCreatorAnswerCreateSchema.safeParse({ ...answer, options: ["A", "B"] }).success).toBe(false);
  });

  it("requires an OC subject and strict versioned illustration anchor unions", () => {
    expect(growthClosureProfileCreateSchema.safeParse({
      id: "profile-1", idempotencyKey: "profile-key", goalId: "goal-1", profileKind: "oc_saga", subjectResourceId: null,
      checkpointId: "checkpoint-1", ruleRevision: 1, facets: [{ id: "origin", kind: "content", required: true }],
    }).success).toBe(false);
    expect(growthIllustrationAnchorSchema.safeParse({ kind: "resource", resourceId: "oc-1", resourceVersionId: "oc-v1" }).success).toBe(true);
    expect(growthIllustrationAnchorSchema.safeParse({ kind: "resource", resourceId: "oc-1" }).success).toBe(false);
    expect(growthIllustrationAnchorSchema.safeParse({
      kind: "stable_text_span", documentId: "doc-1", documentVersionId: "doc-v1", startCodePoint: 2,
      endCodePoint: 2, textSha256: "a".repeat(64),
    }).success).toBe(false);
  });

  it("keeps illustration quantity unlimited across bounded batches", () => {
    const item = (index: number) => ({
      id: `item-${index}`, purpose: "scene", title: `Scene ${index}`, variantKey: `variant-${index}`,
      compiledPromptSha256: "a".repeat(64), requiredForVisualClosure: true,
      anchor: { kind: "resource" as const, resourceId: `resource-${index}`, resourceVersionId: `version-${index}` },
      sources: [{ kind: "resource" as const, resourceId: `resource-${index}`, resourceVersionId: `version-${index}` }],
    });
    const batch = {
      id: "batch-1", requestId: "request-1", sequence: 1, cursor: null, nextCursor: "20", idempotencyKey: "batch-key",
      snapshots: [], items: Array.from({ length: 20 }, (_, index) => item(index)),
    };
    expect(growthIllustrationBatchSealSchema.safeParse(batch).success).toBe(true);
    expect(growthIllustrationBatchSealSchema.safeParse({ ...batch, items: [...batch.items, item(20)] }).success).toBe(false);
  });
});

function baseReceiptCreate() {
  return {
    id: "receipt-1", cycleId: "cycle-1", runId: "run-1", toolInvocationId: "tool-1", branchId: "branch-1",
    checkpointId: "checkpoint-1", lens: "creator" as const, effectiveScopeResourceIds: ["scope-1"], query: "find coast",
    aliases: ["coast"], validTime: null, recordedTime: null, maxHops: 2, cpuBudgetMs: 100, expansionBudget: 10,
    resultBudget: 10, tokenBudget: 100, policyVersion: "growth-retrieval-v1",
    coverage: { state: "complete" as const, searchedScopeCount: 1, omittedCount: 0 }, truncated: false, links: [{
      rank: 1, targetKind: "resource" as const, targetId: "scope-1", targetVersionId: "resource-version-1", score: 1,
      reasonCodes: ["scope_match" as const], pathTargetIds: [], stableLocator: null, stableVersionId: null, stableHash: null,
    }],
  };
}

function baseEventAppend() {
  return {
    goalId: "goal-1", cycleId: "cycle-1", runId: "run-1", sequence: 1, safeSummary: "recorded receipt",
    phase: "receipt_recorded" as const, targetKind: "resource" as const, targetId: "resource-1", targetVersionId: null,
    durableState: "running" as const, contentRef: null,
  };
}
