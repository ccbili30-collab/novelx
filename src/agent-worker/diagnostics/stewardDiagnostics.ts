import { createSafeDiagnosticCatalog } from "../../shared/diagnostics/safeDiagnosticCatalog";
import { growthInquiryDiagnosticCodes } from "../../shared/diagnostics/growthInquiryDiagnostics";
import {
  isGrowthLongformModelCorrectionCode,
  isGrowthLongformSectionWriterCorrectionCode,
  growthLongformModelCorrectionCodes,
  growthLongformSectionDiagnosticCodes,
  growthLongformWriterBlockedDiagnosticCodes,
} from "../growth/phases/longform/growthLongformDiagnostics";

export const stewardDiagnosticCatalog = createSafeDiagnosticCatalog([
  "STEWARD_CLOSURE_ASSESSMENT_REQUIRED", "STEWARD_CLOSURE_CHECKER_REQUIRED", "STEWARD_CLOSURE_HANDOFF_REQUIRED",
  "STEWARD_CLOSURE_EVIDENCE_MISMATCH", "STEWARD_CLOSURE_NOT_READY",
  "STEWARD_EXECUTION_BLOCKED", "STEWARD_GREENFIELD_WORLD_MAP_SOURCE_MISMATCH",
  ...growthInquiryDiagnosticCodes,
  ...growthLongformModelCorrectionCodes,
  ...growthLongformSectionDiagnosticCodes,
  ...growthLongformWriterBlockedDiagnosticCodes,
  "STEWARD_GROWTH_PLAN_INVALID",
  "STEWARD_GROWTH_RECEIPT_REQUIRED", "STEWARD_GROWTH_RETRIEVAL_REQUIRED",
  "STEWARD_GROWTH_REVISION_AUTHORITY_REQUIRED", "STEWARD_IMAGE_SOURCE_MISMATCH",
  "STEWARD_LONG_READ_RANGE_MISMATCH", "STEWARD_LONGFORM_AUTHORITY_INVALID",
  "STEWARD_LONGFORM_WRITER_EVIDENCE_ECHO_INVALID", "STEWARD_LONGFORM_WRITER_RESULT_INVALID",
  "STEWARD_LONGFORM_WRITER_REQUIRED", "STEWARD_OC_STORY_REQUIRED",
  "STEWARD_PLAN_ALREADY_SUBMITTED", "STEWARD_PLAN_INVALID", "STEWARD_PLAN_REQUIRED",
  "STEWARD_PLAN_SCOPE_MISMATCH", "STEWARD_STEP_OUT_OF_ORDER", "STEWARD_STEP_REQUIRED",
  "STEWARD_STORY_WRITER_REQUIRED", "STEWARD_TASK_NOTE_PAGE_MISMATCH",
  "STEWARD_TASK_NOTE_SOURCE_MISMATCH", "STEWARD_TOOL_RESULT_INVALID", "STEWARD_TOOL_SET_INVALID",
  "STEWARD_UNTRUSTED_ECHO_REJECTED", "STEWARD_WRITER_EVIDENCE_REQUIRED",
  "STEWARD_FINAL_SCHEMA_INVALID", "STEWARD_FINAL_TOOL_OUTCOMES_MISMATCH",
  "STEWARD_FINAL_EVIDENCE_INVALID", "STEWARD_FINAL_BLOCK_STATE_MISMATCH",
  "STEWARD_FINAL_BLOCK_REASON_MISMATCH", "STEWARD_FINAL_CHANGE_SET_MISMATCH",
].map((code) => ({
  code,
  owner: code.includes("CLOSURE") || code.includes("LONGFORM") ? "growth_phase" as const : "worker_schema" as const,
  boundary: code.startsWith("GROWTH_LONGFORM_")
    ? "phase_compile" as const
    : code === "STEWARD_LONGFORM_WRITER_EVIDENCE_ECHO_INVALID" || code === "STEWARD_LONGFORM_WRITER_RESULT_INVALID"
    ? "worker_to_main" as const
    : code.startsWith("STEWARD_LONGFORM_WRITER_BLOCKED_") ? "worker_to_main" as const
    : code === "STEWARD_TOOL_RESULT_INVALID" ? "worker_to_main" as const : "tool_arguments" as const,
  defaultRetryability: code.startsWith("STEWARD_GROWTH_INQUIRY_")
    || code === "STEWARD_CLOSURE_HANDOFF_REQUIRED"
    || isGrowthLongformModelCorrectionCode(code)
    || isGrowthLongformSectionWriterCorrectionCode(code)
    || code === "STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_GM_RESOLUTION"
    || code === "STEWARD_LONGFORM_WRITER_RESULT_INVALID"
    || code === "STEWARD_LONGFORM_WRITER_EVIDENCE_ECHO_INVALID"
    ? "model_correction" as const
    : "do_not_retry" as const,
  userSummaryKey: `steward.${code.toLowerCase()}`,
  modelCorrectionKey: null,
})));
