export const growthInquiryDiagnosticCodes = [
  "STEWARD_GROWTH_INQUIRY_REQUIRED",
  "STEWARD_GROWTH_INQUIRY_INPUT_INVALID",
  "STEWARD_GROWTH_INQUIRY_COUNT_INVALID",
  "STEWARD_GROWTH_INQUIRY_ITEM_INVALID",
  "STEWARD_GROWTH_INQUIRY_FRONTIER_INVALID",
  "STEWARD_GROWTH_INQUIRY_TRANSITION_INVALID",
  "STEWARD_GROWTH_INQUIRY_CHOICE_CARDINALITY_INVALID",
  "STEWARD_GROWTH_INQUIRY_SELECTION_INVALID",
  "STEWARD_GROWTH_INQUIRY_PRIORITY_TIE_INVALID",
  "STEWARD_GROWTH_INQUIRY_FRONTIER_PRIORITY_INVALID",
  "STEWARD_GROWTH_INQUIRY_EVIDENCE_INVALID",
  "STEWARD_GROWTH_INQUIRY_DUPLICATE_INVALID",
] as const;

export type GrowthInquiryDiagnosticCode = (typeof growthInquiryDiagnosticCodes)[number];

export function isGrowthInquiryDiagnosticCode(value: unknown): value is GrowthInquiryDiagnosticCode {
  return typeof value === "string"
    && growthInquiryDiagnosticCodes.includes(value as GrowthInquiryDiagnosticCode);
}
