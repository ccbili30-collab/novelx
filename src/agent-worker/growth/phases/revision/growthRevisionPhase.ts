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
  "GROWTH_REVISION_FRAGMENT_REFERENCE_CYCLE",
  "GROWTH_REVISION_FRAGMENT_RELATION_INVALID",
]);

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
    description: "Submit one evidence-grounded Revision Fragment after the selected Inquiry. First summarize affected evidence and preserve/stale decisions, then supply only creative edits or additions. Cite returned evidence IDs or Fragment local IDs; never supply checkpoint, branch, scope, resource/database IDs, versions, ownership, dependencies, state, permissions, or project-file operations.",
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
        ? "The selected Inquiry is recorded. Submit one high-level Revision Fragment now: classify affected evidence, preserve unrelated facts, and compile all selected edits into one atomic Change Set."
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
