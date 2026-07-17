export interface GrowthClosureSafeEvaluationInput {
  cycleSequence: number;
  decision: string;
  facetResults: Array<{
    facetId: string;
    state: string;
    coverage: string;
    evidence: readonly unknown[];
  }>;
  adverseFindings: Array<{
    severity: string;
    category: string;
    targetEvidence: readonly unknown[];
  }>;
}

export interface GrowthClosureSafeEvaluation {
  cycleSequence: number;
  decision: string;
  facetResults: Array<{
    facetId: string;
    state: string;
    coverage: string;
    evidenceCount: number;
  }>;
  checkerFindings: Array<{
    severity: string;
    category: string;
    targetEvidenceCount: number;
  }>;
}

export function projectGrowthClosureSafeEvaluation(
  input: GrowthClosureSafeEvaluationInput,
): GrowthClosureSafeEvaluation {
  return {
    cycleSequence: input.cycleSequence,
    decision: input.decision,
    facetResults: input.facetResults.map((facet) => ({
      facetId: facet.facetId,
      state: facet.state,
      coverage: facet.coverage,
      evidenceCount: facet.evidence.length,
    })),
    checkerFindings: input.adverseFindings.map((finding) => ({
      severity: finding.severity,
      category: finding.category,
      targetEvidenceCount: finding.targetEvidence.length,
    })),
  };
}
