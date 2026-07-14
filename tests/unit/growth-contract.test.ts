import { describe, expect, it } from "vitest";
import {
  growthContractVersion,
  growthCycleSchema,
  growthEventSchema,
  growthRetrievalReceiptSchema,
} from "../../src/shared/growthContract";

const now = "2026-07-15T00:00:00.000Z";
const hash = "a".repeat(64);

describe("growth persistence contract", () => {
  it("publishes a strict v1 contract and rejects unknown fields", () => {
    expect(growthContractVersion).toBe("1.0.0");
    expect(growthCycleSchema.safeParse({
      id: "cycle-1", goalId: "goal-1", sequence: 1, idempotencyKey: "idem-1", inputCheckpointId: "checkpoint-1",
      ruleRevision: 1, runId: null, receiptId: null, changeSetId: null, outputCheckpointId: null, status: "planned",
      failureCode: null, createdAt: now, updatedAt: now, terminalAt: null, unexpected: true,
    }).success).toBe(false);
  });

  it("fails closed for player Lens and inconsistent receipt metadata", () => {
    const receipt = baseReceipt();
    expect(growthRetrievalReceiptSchema.safeParse({ ...receipt, lens: "player" }).success).toBe(false);
    expect(growthRetrievalReceiptSchema.safeParse({ ...receipt, locatorCount: 1 }).success).toBe(false);
  });

  it("does not permit transient state to masquerade as committed output", () => {
    const cycle = {
      id: "cycle-1", goalId: "goal-1", sequence: 1, idempotencyKey: "idem-1", inputCheckpointId: "checkpoint-1",
      ruleRevision: 1, runId: "run-1", receiptId: "receipt-1", changeSetId: null, outputCheckpointId: null,
      status: "committed", failureCode: null, createdAt: now, updatedAt: now, terminalAt: now,
    };
    expect(growthCycleSchema.safeParse(cycle).success).toBe(false);
    expect(growthEventSchema.safeParse({
      goalId: "goal-1", cycleId: "cycle-1", runId: "run-1", sequence: 1, safeSummary: "unsafe",
      phase: "cycle_terminal", targetKind: "resource", targetId: "resource-1", targetVersionId: null,
      durableState: "committed", contentRef: null, createdAt: now,
    }).success).toBe(false);
  });
});

function baseReceipt() {
  return {
    id: "receipt-1", cycleId: "cycle-1", runId: "run-1", toolInvocationId: "tool-1", branchId: "branch-1",
    checkpointId: "checkpoint-1", lens: "creator" as const, effectiveScopeResourceIds: ["scope-1"], query: "find coast",
    aliases: ["coast"], validTime: null, recordedTime: null, maxHops: 2, cpuBudgetMs: 100, expansionBudget: 10,
    resultBudget: 10, tokenBudget: 100, policyVersion: "growth-retrieval-v1", queryHash: hash, resultHash: hash,
    hitCount: 1, conflictCount: 0, locatorCount: 0, coverage: { state: "complete" as const, searchedScopeCount: 1, omittedCount: 0 },
    truncated: false, createdAt: now, links: [{
      rank: 1, targetKind: "resource" as const, targetId: "scope-1", targetVersionId: null, score: 1,
      reasonCodes: ["scope_match" as const], pathTargetIds: [], stableLocator: null, stableVersionId: null, stableHash: null,
    }],
  };
}
