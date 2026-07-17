export const growthRevisionProposalPolicyCodes = [
  "GROWTH_REVISION_POLICY_ASSERTION_SOURCE_INVALID",
  "GROWTH_REVISION_POLICY_CREATED_ID_INVALID",
  "GROWTH_REVISION_POLICY_EXISTING_TARGET_INVALID",
  "GROWTH_REVISION_POLICY_FORBIDDEN_MUTATION",
  "GROWTH_REVISION_POLICY_IMPACT_AUTHORITY_INVALID",
  "GROWTH_REVISION_POLICY_IMPACT_SET_CONFLICT",
  "GROWTH_REVISION_POLICY_ITEM_GRAPH_INVALID",
  "GROWTH_REVISION_POLICY_LONGFORM_DOCUMENT_FORBIDDEN",
  "GROWTH_REVISION_POLICY_MUTATION_SET_MISMATCH",
  "GROWTH_REVISION_POLICY_OWNER_INVALID",
  "GROWTH_REVISION_POLICY_RELATION_ENDPOINT_INVALID",
  "GROWTH_REVISION_POLICY_CLOSURE_REQUIREMENT_INVALID",
] as const;

export type GrowthRevisionProposalPolicyCode = (typeof growthRevisionProposalPolicyCodes)[number];

export const growthRevisionProposalDiagnosticCatalog = createSafeDiagnosticCatalog(
  growthRevisionProposalPolicyCodes.map((code) => ({
    code,
    owner: "main_gateway" as const,
    boundary: "tool_authorization" as const,
    defaultRetryability: "do_not_retry" as const,
    userSummaryKey: `growth.revision.policy.${code.toLowerCase()}`,
    modelCorrectionKey: null,
  })),
);

export function growthRevisionProposalPolicyError(
  code: GrowthRevisionProposalPolicyCode,
): Error & { code: GrowthRevisionProposalPolicyCode } {
  return Object.assign(new Error("Growth revision proposal exceeds pinned authority."), { code });
}

export function readGrowthRevisionProposalPolicyCode(
  error: unknown,
): GrowthRevisionProposalPolicyCode | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const value = error.code;
  return typeof value === "string" && growthRevisionProposalDiagnosticCatalog.has(value)
    ? value as GrowthRevisionProposalPolicyCode
    : null;
}
import { createSafeDiagnosticCatalog } from "../../../../shared/diagnostics/safeDiagnosticCatalog";
