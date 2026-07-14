import { describe, expect, it } from "vitest";
import {
  growthContractVersion,
  growthCycleSchema,
  growthEventAppendSchema,
  growthEventSchema,
  growthRetrievalReceiptCreateSchema,
  growthRetrievalReceiptSchema,
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
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, links: [{ ...receipt.links[0], stableLocator: "line:1" }] }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, links: [{ ...receipt.links[0], pathTargetIds: ["a", "a"] }] }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, coverage: { state: "complete", searchedScopeCount: 2, omittedCount: 1 } }).success).toBe(false);
    expect(growthRetrievalReceiptCreateSchema.safeParse({ ...receipt, truncated: true }).success).toBe(false);
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

  it("keeps cycle-only event phases and rejects image content references", () => {
    expect(growthEventAppendSchema.safeParse({ ...baseEventAppend(), phase: "goal_created" }).success).toBe(false);
    expect(growthEventAppendSchema.safeParse({ ...baseEventAppend(), contentRef: { kind: "image", targetId: "image-1", targetVersionId: "job-1" } }).success).toBe(false);
    expect(growthEventSchema.safeParse({ ...baseEventAppend(), createdAt: now }).success).toBe(true);
  });
});

function baseReceiptCreate() {
  return {
    id: "receipt-1", cycleId: "cycle-1", runId: "run-1", toolInvocationId: "tool-1", branchId: "branch-1",
    checkpointId: "checkpoint-1", lens: "creator" as const, effectiveScopeResourceIds: ["scope-1"], query: "find coast",
    aliases: ["coast"], validTime: null, recordedTime: null, maxHops: 2, cpuBudgetMs: 100, expansionBudget: 10,
    resultBudget: 10, tokenBudget: 100, policyVersion: "growth-retrieval-v1",
    coverage: { state: "complete" as const, searchedScopeCount: 1, omittedCount: 0 }, truncated: false, links: [{
      rank: 1, targetKind: "resource" as const, targetId: "scope-1", targetVersionId: null, score: 1,
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
