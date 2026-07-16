import { Type, type TSchema } from "typebox";
import { checkerOutputSchema, type CheckerOutput } from "../../../contracts/roleOutputs";
import {
  submitClosureCheckerReviewArgsSchema,
  submitClosureCheckerReviewResultSchema,
  type GrowthRetrieveGraphEvidenceResult,
  type GrowthRunBinding,
  type SubmitClosureCheckerReviewArgs,
} from "../../../../shared/agentWorkerProtocol";

export type ClosureEvaluation = NonNullable<GrowthRetrieveGraphEvidenceResult["closureEvaluation"]>;
export type ClosureCheckerOutput = Extract<CheckerOutput, { status: "closure_review" }>;

export interface GrowthClosureToolPresentation {
  description: string;
  parameters?: TSchema;
}

export function closureToolPresentation(
  binding: GrowthRunBinding | undefined,
  toolName: string,
): GrowthClosureToolPresentation | null {
  if (binding?.kind === "closure_evaluation" && toolName === "checker") {
    return {
      description: "Independently review the trusted pinned Closure facet assessment. Parameters are compiled by the Harness from the recorded Receipt; do not supply content, evidence, scope, checkpoint, profile, or authority fields.",
      parameters: Type.Object({}, { additionalProperties: false }),
    };
  }
  if (binding?.kind === "closure_evaluation" && toolName === "submit_closure_checker_review") {
    return {
      description: "Record the immediately preceding independent Checker result. Parameters are compiled by the Harness; do not supply findings, evidence, scope, checkpoint, profile, hashes, or authority fields.",
      parameters: Type.Object({}, { additionalProperties: false }),
    };
  }
  if (binding?.kind === "repair" && toolName === "propose_change_set") {
    return {
      description: `Submit exactly one source-bound Change Set for the selected Closure repair. Repair only this objective: ${binding.closureRepair?.repairObjective ?? "the selected finding"}. Do not rewrite unrelated resources, add images, or broaden the task.`,
    };
  }
  return null;
}

export function compileClosureCheckerInput(input: {
  binding: GrowthRunBinding;
  evaluation: ClosureEvaluation | null;
  evidenceById: ReadonlyMap<string, unknown>;
}): Record<string, unknown> {
  if (input.binding.kind !== "closure_evaluation" || !input.binding.closureProfile || !input.evaluation) {
    throw closureError("STEWARD_CLOSURE_CHECKER_REQUIRED");
  }
  const evidenceIds = [...new Set(input.evaluation.facetResults.flatMap((facet) => facet.evidenceIds))];
  const sourceMaterial = JSON.stringify({
    evidence: evidenceIds.map((evidenceId) => input.evidenceById.get(evidenceId)),
    facetResults: input.evaluation.facetResults,
  });
  if (evidenceIds.length === 0 || evidenceIds.some((id) => !input.evidenceById.has(id)) || sourceMaterial.length > 160_000) {
    throw closureError("STEWARD_CLOSURE_EVIDENCE_MISMATCH");
  }
  return {
    evaluationKind: "closure_v4",
    profileKind: input.binding.closureProfile.profileKind,
    sourceMaterial,
    evidenceIds,
    facetResults: input.evaluation.facetResults,
    constraints: [
      "Review only the pinned facet results and cited evidence IDs.",
      "Do not invent missing facts, rewrite creative content, or grant Canon authority.",
      "Return accepted only when no adverse finding remains.",
    ],
  };
}

export function captureClosureCheckerOutput(input: {
  details: unknown;
  evaluation: ClosureEvaluation | null;
}): ClosureCheckerOutput {
  const checker = checkerOutputSchema.safeParse(input.details);
  if (!checker.success || checker.data.status !== "closure_review" || !input.evaluation) {
    throw closureError("STEWARD_TOOL_RESULT_INVALID");
  }
  const allowed = new Set(input.evaluation.facetResults.flatMap((facet) => facet.evidenceIds));
  if (checker.data.adverseFindings.flatMap((finding) => finding.evidenceIds).some((id) => !allowed.has(id))) {
    throw closureError("STEWARD_CLOSURE_EVIDENCE_MISMATCH");
  }
  return checker.data;
}

export function compileClosureCheckerSubmission(output: ClosureCheckerOutput | null): SubmitClosureCheckerReviewArgs {
  if (!output) throw closureError("STEWARD_CLOSURE_CHECKER_REQUIRED");
  return submitClosureCheckerReviewArgsSchema.parse({
    decision: output.decision,
    adverseFindings: output.adverseFindings,
  });
}

export function validateClosureCheckerReviewResult(
  details: unknown,
  output: ClosureCheckerOutput | null,
): void {
  const result = submitClosureCheckerReviewResultSchema.safeParse(details);
  if (!result.success || !output || result.data.decision !== output.decision) {
    throw closureError("STEWARD_TOOL_RESULT_INVALID");
  }
}

function closureError(code: string): Error & { code: string } {
  return Object.assign(new Error("Steward Closure phase contract failed."), { code });
}
