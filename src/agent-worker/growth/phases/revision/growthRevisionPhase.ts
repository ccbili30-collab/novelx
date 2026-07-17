import type { TSchema } from "typebox";
import type {
  GrowthRevisionAuthority,
  GrowthRetrieveGraphEvidenceResult,
  GrowthRunBinding,
  ProposeChangeSetArgs,
} from "../../../../shared/agentWorkerProtocol";
import {
  fixedGrowthPhaseHandler,
  type GrowthPhaseHandler,
} from "../../core/growthPhaseHandler";
import {
  compileGrowthRevisionFragment,
  growthRevisionFragmentParameters,
} from "./growthRevisionFragment";

const revisionCorrectionCodes = new Set([
  "GROWTH_REVISION_FRAGMENT_INVALID",
  "GROWTH_REVISION_FRAGMENT_DUPLICATE_LOCAL_ID",
  "GROWTH_REVISION_FRAGMENT_DUPLICATE_TARGET",
  "GROWTH_REVISION_FRAGMENT_AUTHORITY_INVALID",
  "GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH",
  "GROWTH_REVISION_FRAGMENT_REFERENCE_INVALID",
  "GROWTH_REVISION_FRAGMENT_OWNER_REF_INVALID",
  "GROWTH_REVISION_FRAGMENT_DOCUMENT_OWNER_KIND_INVALID",
  "GROWTH_REVISION_FRAGMENT_SCOPE_REF_INVALID",
  "GROWTH_REVISION_FRAGMENT_DOCUMENT_SOURCE_REF_INVALID",
  "GROWTH_REVISION_FRAGMENT_RELATION_ENDPOINT_REF_INVALID",
  "GROWTH_REVISION_FRAGMENT_PARENT_REF_INVALID",
  "GROWTH_REVISION_FRAGMENT_REFERENCE_CYCLE",
  "GROWTH_REVISION_FRAGMENT_RELATION_INVALID",
  "GROWTH_REVISION_FRAGMENT_CLOSURE_REQUIREMENT_INVALID",
]);

export const growthRevisionMaxCorrectionAttempts = 5;
export const growthRevisionMaxRepeatedCorrectionCode = 3;

export const growthRevisionPhaseHandler: GrowthPhaseHandler<"revision"> = fixedGrowthPhaseHandler(
  "revision",
  (binding) => binding.kind === "revision",
  "change_set",
  ["retrieve_graph_evidence", "submit_growth_inquiry", "propose_change_set"],
);

export function revisionToolPresentation(
  binding: GrowthRunBinding | undefined,
  toolName: string,
): { description: string; parameters: TSchema } | null {
  if (binding?.kind !== "revision" || toolName !== "propose_change_set") return null;
  return {
    description: "Submit one evidence-grounded Revision Fragment after the selected Inquiry. Use only the @resource/@document/@assertion/@relation aliases from revisionReferences for existing targets, plus localIds declared in this Fragment for new targets. Never use evidenceId, resourceId, documentId, relation endpoints, or database identities as Fragment references. Every targetRef marked revise must appear exactly once in the matching update or removal array; preserve and stale_visual targets must not be mutated. Keep every declared mutation array present. Supply only creative edits or additions; never supply checkpoint, branch, scope, versions, ownership, dependencies, state, permissions, or project-file operations.",
    parameters: growthRevisionFragmentParameters,
  };
}

export function compileRevisionProposal(input: {
  binding: GrowthRunBinding;
  authority: GrowthRevisionAuthority | null;
  params: unknown;
}): ProposeChangeSetArgs {
  if (input.binding.kind !== "revision" || !input.authority) throw revisionPhaseError();
  return compileGrowthRevisionFragment(input.params, {
    cycleId: input.binding.cycleId,
    domainRootResourceIds: input.binding.domainRootResourceIds,
    authority: input.authority,
    requiredClosureAssertions: input.binding.closureContinuation?.requiredAssertions ?? [],
  });
}

export interface GrowthRevisionRuntime {
  toolPresentation(toolName: string): { description: string; parameters: TSchema } | null;
  acceptRetrieval(result: GrowthRetrieveGraphEvidenceResult): void;
  compileProposal(toolName: string, params: unknown): ProposeChangeSetArgs | null;
  postInquiryInstruction(nextTool: string | null): string | undefined;
  isCorrectable(toolName: string, error: unknown): boolean;
}

/** Phase-local mutable state. The top-level Steward only invokes this seam. */
export function createGrowthRevisionRuntime(binding: GrowthRunBinding | undefined): GrowthRevisionRuntime | null {
  if (binding?.kind !== "revision") return null;
  let authority: GrowthRevisionAuthority | null = null;
  return {
    toolPresentation: (toolName) => revisionToolPresentation(binding, toolName),
    acceptRetrieval(result) {
      if (!result.revisionAuthority) throw revisionPhaseError();
      authority = result.revisionAuthority;
    },
    compileProposal(toolName, params) {
      return toolName === "propose_change_set"
        ? compileRevisionProposal({ binding, authority, params })
        : null;
    },
    postInquiryInstruction(nextTool) {
      return nextTool === "propose_change_set"
        ? `The selected Inquiry is recorded. Submit one high-level Revision Fragment now: classify affected evidence, preserve unrelated facts, and compile all selected edits into one atomic Change Set.${binding.closureContinuation ? ` This is a Closure continuation. Add one sourced assertionAddition for every exact required predicate: ${binding.closureContinuation.requiredAssertions.map((item) => item.facetId).join(", ")}. Use the matching world, main story, or focus OC @resource alias as scopeRef; do not substitute descriptive predicates.` : ""}`
        : undefined;
    },
    isCorrectable(toolName, error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : null;
      return toolName === "propose_change_set" && code !== null && revisionCorrectionCodes.has(code);
    },
  };
}

function revisionPhaseError(): Error & { code: "STEWARD_GROWTH_REVISION_AUTHORITY_REQUIRED" } {
  return Object.assign(new Error("Growth revision authority is required."), {
    code: "STEWARD_GROWTH_REVISION_AUTHORITY_REQUIRED" as const,
  });
}
