import { z } from "zod";
import { canonicalAuditHash } from "../../audit/canonicalAuditHash";

const id = z.string().trim().min(1).max(240);
const candidateSchema = z.object({
  gapId: id,
  gapKind: z.enum(["missing_cause", "missing_effect", "missing_mechanism", "missing_condition", "cross_system_dependency"]),
  facetId: id,
  question: z.string().trim().min(1).max(2_000),
  affectedNodeRefs: z.array(id).min(1).max(100),
  evidenceRefs: z.array(id).min(1).max(100),
  missingCausalLinkCount: z.number().int().min(1).max(1_000),
  downstreamBlockedCount: z.number().int().min(0).max(1_000),
  importanceTier: z.enum(["core", "major", "supporting", "background"]),
  decision: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("autonomous") }).strict(),
    z.object({
      kind: z.literal("creator_choice"),
      reason: z.enum(["mutually_exclusive_canon", "conflicting_user_rules", "irreversible_world_premise"]),
    }).strict(),
  ]),
}).strict();

const selectorInputSchema = z.object({
  authority: z.literal("harness_projection"),
  candidates: z.array(candidateSchema).min(3).max(7),
  priorAttempts: z.array(z.object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["progressed", "no_progress", "answered"]),
  }).strict()).max(100),
}).strict();

export type CausalInquiryCandidate = z.infer<typeof candidateSchema>;
export type CausalInquirySelection =
  | {
    status: "selected";
    action: "autonomous" | "ask_user";
    candidate: CausalInquiryCandidate;
    fingerprint: string;
    valueScore: number;
    consideredGapIds: string[];
    deduplicatedGapIds: string[];
  }
  | {
    status: "no_progress";
    exhaustedFingerprints: string[];
    consideredGapIds: string[];
    deduplicatedGapIds: string[];
  };

export function selectCausalInquiry(rawInput: unknown): CausalInquirySelection {
  const parsed = selectorInputSchema.safeParse(rawInput);
  if (!parsed.success) throw selectorError("CAUSAL_INQUIRY_INPUT_INVALID");
  const input = parsed.data;
  for (const candidate of input.candidates) {
    assertUnique(candidate.affectedNodeRefs, "CAUSAL_INQUIRY_AFFECTED_NODE_DUPLICATED");
    assertUnique(candidate.evidenceRefs, "CAUSAL_INQUIRY_EVIDENCE_DUPLICATED");
  }
  assertUnique(input.candidates.map((item) => item.gapId), "CAUSAL_INQUIRY_GAP_ID_DUPLICATED");
  const priorFingerprints = new Set(input.priorAttempts.map((item) => item.fingerprint));
  const uniqueCandidates = new Map<string, { candidate: CausalInquiryCandidate; score: number }>();
  const deduplicatedGapIds: string[] = [];
  for (const candidate of input.candidates) {
    const fingerprint = causalInquiryFingerprint(candidate);
    const existing = uniqueCandidates.get(fingerprint);
    const score = valueScore(candidate);
    if (!existing) uniqueCandidates.set(fingerprint, { candidate, score });
    else {
      const winner = compareCandidate({ candidate, score }, existing) < 0 ? { candidate, score } : existing;
      const loser = winner === existing ? candidate : existing.candidate;
      uniqueCandidates.set(fingerprint, winner);
      deduplicatedGapIds.push(loser.gapId);
    }
  }
  const eligible = [...uniqueCandidates.entries()]
    .filter(([fingerprint]) => !priorFingerprints.has(fingerprint))
    .map(([fingerprint, entry]) => ({ fingerprint, ...entry }))
    .sort(compareCandidate);
  if (eligible.length === 0) {
    return {
      status: "no_progress",
      exhaustedFingerprints: [...uniqueCandidates.keys()].sort(),
      consideredGapIds: input.candidates.map((item) => item.gapId).sort(),
      deduplicatedGapIds: deduplicatedGapIds.sort(),
    };
  }
  const selected = eligible[0]!;
  return {
    status: "selected",
    action: selected.candidate.decision.kind === "creator_choice" ? "ask_user" : "autonomous",
    candidate: selected.candidate,
    fingerprint: selected.fingerprint,
    valueScore: selected.score,
    consideredGapIds: input.candidates.map((item) => item.gapId).sort(),
    deduplicatedGapIds: deduplicatedGapIds.sort(),
  };
}

export function causalInquiryFingerprint(candidate: Pick<CausalInquiryCandidate, "gapKind" | "facetId" | "affectedNodeRefs" | "evidenceRefs">): string {
  return canonicalAuditHash({
    gapKind: candidate.gapKind,
    facetId: candidate.facetId,
    affectedNodeRefs: [...candidate.affectedNodeRefs].sort(),
    evidenceRefs: [...candidate.evidenceRefs].sort(),
  });
}

function valueScore(candidate: CausalInquiryCandidate): number {
  const importance = { core: 4, major: 3, supporting: 2, background: 1 }[candidate.importanceTier];
  return importance * 1_000_000 + candidate.downstreamBlockedCount * 1_000 + candidate.missingCausalLinkCount * 10
    + Math.min(candidate.evidenceRefs.length, 9);
}

function compareCandidate(
  left: { candidate: CausalInquiryCandidate; score: number },
  right: { candidate: CausalInquiryCandidate; score: number },
): number {
  return right.score - left.score || left.candidate.gapId.localeCompare(right.candidate.gapId);
}

function assertUnique(values: string[], code: string): void {
  if (new Set(values).size !== values.length) throw selectorError(code);
}

function selectorError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
