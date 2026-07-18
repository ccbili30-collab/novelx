import { describe, expect, it } from "vitest";
import {
  causalInquiryFingerprint,
  selectCausalInquiry,
  type CausalInquiryCandidate,
} from "../../src/domain/growth/editorial/causalInquirySelector";

describe("causal Inquiry selector", () => {
  it("selects one highest-value sourced causal gap with deterministic tie-breaking", () => {
    const candidates = [
      candidate("minor", { importanceTier: "supporting", downstreamBlockedCount: 20 }),
      candidate("core_b", { importanceTier: "core", downstreamBlockedCount: 2 }),
      candidate("core_a", { importanceTier: "core", downstreamBlockedCount: 2 }),
    ];
    const first = selectCausalInquiry({ authority: "harness_projection", candidates, priorAttempts: [] });
    expect(first).toMatchObject({
      status: "selected", action: "autonomous", candidate: { gapId: "core_a" }, deduplicatedGapIds: [],
    });
    expect(selectCausalInquiry({ authority: "harness_projection", candidates: structuredClone(candidates), priorAttempts: [] })).toEqual(first);
  });

  it("deduplicates equivalent gaps independently of question wording and selects the stronger projection", () => {
    const duplicate = candidate("duplicate", {
      question: "Different prose for the same evidence-bound gap?", downstreamBlockedCount: 9,
      affectedNodeRefs: ["node_original"], evidenceRefs: ["evidence_original"],
    });
    const original = candidate("original", { downstreamBlockedCount: 1 });
    const result = selectCausalInquiry({ authority: "harness_projection",
      candidates: [original, duplicate, candidate("other", { affectedNodeRefs: ["node_other"] })],
      priorAttempts: [],
    });
    expect(causalInquiryFingerprint(original)).toBe(causalInquiryFingerprint(duplicate));
    expect(result).toMatchObject({
      status: "selected", candidate: { gapId: "duplicate" }, deduplicatedGapIds: ["original"],
    });
  });

  it("skips previously attempted fingerprints and terminates when no evidence identity changed", () => {
    const candidates = [candidate("one"), candidate("two"), candidate("three")];
    const priorAttempts = candidates.map((item) => ({ fingerprint: causalInquiryFingerprint(item), outcome: "no_progress" as const }));
    expect(selectCausalInquiry({ authority: "harness_projection", candidates, priorAttempts })).toEqual({
      status: "no_progress",
      exhaustedFingerprints: candidates.map(causalInquiryFingerprint).sort(),
      consideredGapIds: ["one", "three", "two"],
      deduplicatedGapIds: [],
    });
    expect(selectCausalInquiry({ authority: "harness_projection", candidates, priorAttempts: priorAttempts.slice(0, 1) })).toMatchObject({
      status: "selected", candidate: { gapId: "three" },
    });
  });

  it("asks the user only for an allowlisted genuine creator decision", () => {
    const result = selectCausalInquiry({ authority: "harness_projection",
      candidates: [
        candidate("choice", { importanceTier: "core", decision: { kind: "creator_choice", reason: "mutually_exclusive_canon" } }),
        candidate("auto", { importanceTier: "major" }),
        candidate("background", { importanceTier: "background" }),
      ],
      priorAttempts: [],
    });
    expect(result).toMatchObject({ status: "selected", action: "ask_user", candidate: { gapId: "choice" } });
    expectCode(() => selectCausalInquiry({ authority: "harness_projection",
      candidates: [
        candidate("fake", { decision: { kind: "creator_choice", reason: "model_is_uncertain" } as never }),
        candidate("two"), candidate("three"),
      ], priorAttempts: [],
    }), "CAUSAL_INQUIRY_INPUT_INVALID");
  });

  it("fails closed without affected nodes, evidence, distinct systems of identity or bounded cardinality", () => {
    expectCode(() => selectCausalInquiry({ authority: "harness_projection", candidates: [
      candidate("one", { affectedNodeRefs: [] }), candidate("two"), candidate("three"),
    ], priorAttempts: [] }), "CAUSAL_INQUIRY_INPUT_INVALID");
    expectCode(() => selectCausalInquiry({ authority: "harness_projection", candidates: [
      candidate("one", { evidenceRefs: [] }), candidate("two"), candidate("three"),
    ], priorAttempts: [] }), "CAUSAL_INQUIRY_INPUT_INVALID");
    expectCode(() => selectCausalInquiry({ authority: "harness_projection", candidates: [candidate("one"), candidate("two")], priorAttempts: [] }), "CAUSAL_INQUIRY_INPUT_INVALID");
    expectCode(() => selectCausalInquiry({ authority: "harness_projection", candidates: [
      candidate("same"), candidate("same"), candidate("three"),
    ], priorAttempts: [] }), "CAUSAL_INQUIRY_GAP_ID_DUPLICATED");
  });
});

function candidate(gapId: string, overrides: Partial<CausalInquiryCandidate> = {}): CausalInquiryCandidate {
  return {
    gapId,
    gapKind: "missing_mechanism",
    facetId: "causal_gap",
    question: `What causes ${gapId}?`,
    affectedNodeRefs: [`node_${gapId}`],
    evidenceRefs: [`evidence_${gapId}`],
    missingCausalLinkCount: 1,
    downstreamBlockedCount: 0,
    importanceTier: "major",
    decision: { kind: "autonomous" },
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ${code}.`);
}
