import { describe, expect, it } from "vitest";
import {
  classifyGrowthInquiryBriefFailure,
  compileCausalGrowthInquiryBrief,
  growthInquiryBriefParameters,
  growthInquiryBriefSchema,
} from "../../src/agent-worker/growth/growthInquiryBrief";
import { causalInquiryFingerprint } from "../../src/domain/growth/editorial/causalInquirySelector";

const inquiry = (localId: string, priority: number, overrides: Record<string, unknown> = {}) => ({
  localId,
  question: `What consequence follows from ${localId}?`,
  evidenceIds: ["evidence-1"],
  evidenceState: "known",
  safeSummary: `Tracing the consequence of ${localId}.`,
  proposedAction: `Apply the consequence of ${localId}.`,
  provisionalAssumption: null,
  priority,
  requiresCreatorChoice: false,
  ...overrides,
});

describe("Growth Inquiry Brief", () => {
  it("accepts only three to seven authority-free questions", () => {
    const valid = {
      inquiries: [inquiry("one", 3), inquiry("two", 2), inquiry("three", 1)],
      selectedLocalId: "one",
      priorTransitions: [],
    };
    expect(growthInquiryBriefSchema.parse(valid)).toEqual(valid);
    expect(growthInquiryBriefSchema.safeParse({ ...valid, inquiries: valid.inquiries.slice(0, 2) }).success).toBe(false);
    expect(growthInquiryBriefSchema.safeParse({
      ...valid,
      inquiries: Array.from({ length: 8 }, (_, index) => inquiry(`item_${index}`, 8 - index)),
    }).success).toBe(false);

    for (const forbidden of [
      "batchId", "inquiryId", "fingerprint", "rank", "goalId", "cycleId", "checkpointId",
      "scopeResourceIds", "ruleRevision", "receiptId",
    ]) {
      expect(growthInquiryBriefSchema.safeParse({
        ...valid,
        inquiries: [{ ...valid.inquiries[0], [forbidden]: "forged" }, ...valid.inquiries.slice(1)],
      }).success).toBe(false);
      expect(JSON.stringify(growthInquiryBriefParameters)).not.toContain(forbidden);
    }
  });

  it("enforces the normal and creator-choice frontier decisions", () => {
    const base = [inquiry("one", 3), inquiry("two", 2), inquiry("three", 1)];
    expect(growthInquiryBriefSchema.safeParse({ inquiries: base, selectedLocalId: "two", priorTransitions: [] }).success).toBe(false);
    expect(growthInquiryBriefSchema.safeParse({
      inquiries: [inquiry("one", 3), inquiry("two", 3), inquiry("three", 1)],
      selectedLocalId: "one",
      priorTransitions: [],
    }).success).toBe(false);
    expect(growthInquiryBriefSchema.safeParse({
      inquiries: [inquiry("one", 3, { requiresCreatorChoice: true }), ...base.slice(1)],
      selectedLocalId: "one",
      priorTransitions: [],
    }).success).toBe(false);
    expect(growthInquiryBriefSchema.safeParse({
      inquiries: [inquiry("one", 3, { requiresCreatorChoice: true }), ...base.slice(1)],
      selectedLocalId: null,
      priorTransitions: [],
    }).success).toBe(true);
    expect(growthInquiryBriefSchema.safeParse({ inquiries: base, selectedLocalId: null, priorTransitions: [] }).success).toBe(false);
  });

  it("requires provisional assumptions for non-blocking unknowns and keeps prior transitions allowlisted", () => {
    const base = [
      inquiry("one", 3, { evidenceIds: [], evidenceState: "unknown", provisionalAssumption: "Treat the tide as seasonal." }),
      inquiry("two", 2),
      inquiry("three", 1),
    ];
    expect(growthInquiryBriefSchema.safeParse({ inquiries: base, selectedLocalId: "one", priorTransitions: [] }).success).toBe(true);
    expect(growthInquiryBriefSchema.safeParse({
      inquiries: [{ ...base[0], provisionalAssumption: null }, ...base.slice(1)],
      selectedLocalId: "one",
      priorTransitions: [],
    }).success).toBe(false);
    expect(growthInquiryBriefSchema.safeParse({
      inquiries: base,
      selectedLocalId: "one",
      priorTransitions: [{ priorLocalId: "prior_1", phase: "promoted", successorLocalId: "one" }],
    }).success).toBe(true);
    expect(growthInquiryBriefSchema.safeParse({
      inquiries: base,
      selectedLocalId: "one",
      priorTransitions: [{ priorLocalId: "prior_1", phase: "closed", reason: "missing_fingerprint" }],
    }).success).toBe(false);
  });

  it("classifies rejected Briefs without retaining model-authored content", () => {
    const base = [inquiry("one", 3), inquiry("two", 2), inquiry("three", 1)];
    expect(classifyGrowthInquiryBriefFailure({})).toBe("STEWARD_GROWTH_INQUIRY_INPUT_INVALID");
    expect(classifyGrowthInquiryBriefFailure({ inquiries: base.slice(0, 2), selectedLocalId: "one", priorTransitions: [] }))
      .toBe("STEWARD_GROWTH_INQUIRY_COUNT_INVALID");
    expect(classifyGrowthInquiryBriefFailure({
      inquiries: [{ ...base[0], localId: "INVALID ID" }, ...base.slice(1)], selectedLocalId: "one", priorTransitions: [],
    })).toBe("STEWARD_GROWTH_INQUIRY_ITEM_INVALID");
    expect(classifyGrowthInquiryBriefFailure({ inquiries: base, selectedLocalId: "missing", priorTransitions: [] }))
      .toBe("STEWARD_GROWTH_INQUIRY_SELECTION_INVALID");
    expect(classifyGrowthInquiryBriefFailure({ inquiries: base, selectedLocalId: "two", priorTransitions: [] }))
      .toBe("STEWARD_GROWTH_INQUIRY_FRONTIER_PRIORITY_INVALID");
    expect(classifyGrowthInquiryBriefFailure({
      inquiries: [inquiry("one", 3), inquiry("two", 3), inquiry("three", 1)],
      selectedLocalId: "one", priorTransitions: [],
    })).toBe("STEWARD_GROWTH_INQUIRY_PRIORITY_TIE_INVALID");
    expect(classifyGrowthInquiryBriefFailure({ inquiries: base, selectedLocalId: null, priorTransitions: [] }))
      .toBe("STEWARD_GROWTH_INQUIRY_CHOICE_CARDINALITY_INVALID");
    expect(classifyGrowthInquiryBriefFailure({
      inquiries: [inquiry("one", 3, { requiresCreatorChoice: true }), ...base.slice(1)],
      selectedLocalId: "one", priorTransitions: [],
    })).toBe("STEWARD_GROWTH_INQUIRY_SELECTION_INVALID");
    expect(classifyGrowthInquiryBriefFailure({
      inquiries: base, selectedLocalId: "one",
      priorTransitions: [{ priorLocalId: "prior", phase: "closed", reason: "not_allowlisted" }],
    })).toBe("STEWARD_GROWTH_INQUIRY_TRANSITION_INVALID");
    expect(classifyGrowthInquiryBriefFailure({ inquiries: base, selectedLocalId: "one", priorTransitions: [] })).toBeNull();
  });

  it("binds the model Brief to one Harness-selected causal frontier and preserves no-progress", () => {
    const brief = {
      inquiries: [inquiry("one", 3), inquiry("two", 2), inquiry("three", 1)],
      selectedLocalId: "one", priorTransitions: [],
    };
    const selectionInput = causalSelectionInput(brief.inquiries);
    expect(compileCausalGrowthInquiryBrief(brief, selectionInput)).toMatchObject({
      status: "ready", brief: { selectedLocalId: "one" },
      selection: { status: "selected", action: "autonomous", candidate: { gapId: "one", affectedNodeRefs: ["node-one"] } },
    });
    expectCode(() => compileCausalGrowthInquiryBrief({ ...brief, inquiries: [
      { ...brief.inquiries[0], question: "Unbound replacement?" }, ...brief.inquiries.slice(1),
    ] }, selectionInput), "CAUSAL_INQUIRY_BRIEF_BINDING_MISMATCH");

    const first = compileCausalGrowthInquiryBrief(brief, selectionInput);
    if (first.status !== "ready") throw new Error("Fixture mismatch.");
    expect(compileCausalGrowthInquiryBrief(brief, {
      ...selectionInput,
      priorAttempts: selectionInput.candidates.map((candidate) => ({
        fingerprint: causalInquiryFingerprint(candidate),
        outcome: "no_progress" as const,
      })),
    })).toMatchObject({ status: "no_progress", selection: { status: "no_progress" } });
  });
});

function causalSelectionInput(inquiries: ReturnType<typeof inquiry>[]) {
  return {
    authority: "harness_projection" as const,
    candidates: inquiries.map((item, index) => ({
      gapId: item.localId, gapKind: "missing_mechanism" as const, facetId: `causal.${item.localId}`,
      question: item.question, affectedNodeRefs: [`node-${item.localId}`], evidenceRefs: item.evidenceIds,
      missingCausalLinkCount: 1, downstreamBlockedCount: 3 - index,
      importanceTier: index === 0 ? "core" as const : "major" as const,
      decision: { kind: "autonomous" as const },
    })),
    priorAttempts: [],
  };
}

function expectCode(action: () => unknown, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ${code}.`);
}
