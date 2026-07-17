import type { GrowthLongformOutlineErrorCode } from "../../growthLongformOutline";
import type { GrowthLongformSectionErrorCode } from "../../growthLongformSection";
import { GROWTH_LONGFORM_MIN_CODE_POINTS } from "../../../../shared/growthLongformPolicy";

export const growthLongformModelCorrectionCodes = [
  "GROWTH_LONGFORM_OUTLINE_INVALID",
  "GROWTH_LONGFORM_OUTLINE_DUPLICATE_SECTION",
  "GROWTH_LONGFORM_OUTLINE_DUPLICATE_VALUE",
  "GROWTH_LONGFORM_OUTLINE_RANGE_INVALID",
  "GROWTH_LONGFORM_OUTLINE_TARGET_TOO_SHORT",
  "GROWTH_LONGFORM_OUTLINE_EVIDENCE_MISMATCH",
] as const satisfies readonly GrowthLongformOutlineErrorCode[];

export type GrowthLongformModelCorrectionCode = typeof growthLongformModelCorrectionCodes[number];

const correctionCodes = new Set<string>(growthLongformModelCorrectionCodes);

export function isGrowthLongformModelCorrectionCode(
  value: string | null | undefined,
): value is GrowthLongformModelCorrectionCode {
  return typeof value === "string" && correctionCodes.has(value);
}

const correctionInstructions: Record<GrowthLongformModelCorrectionCode, string> = {
  GROWTH_LONGFORM_OUTLINE_INVALID: "Submit a strict Longform outline with 2-100 sections and only the documented fields.",
  GROWTH_LONGFORM_OUTLINE_DUPLICATE_SECTION: "Every Longform outline section must have a unique localId.",
  GROWTH_LONGFORM_OUTLINE_DUPLICATE_VALUE: "Evidence IDs and continuity constraints must not contain duplicates within a section.",
  GROWTH_LONGFORM_OUTLINE_RANGE_INVALID: "Every section estimatedCodePoints range must have min less than or equal to max.",
  GROWTH_LONGFORM_OUTLINE_TARGET_TOO_SHORT: `The sum of all section estimatedCodePoints.min values must be at least ${GROWTH_LONGFORM_MIN_CODE_POINTS}. Increase the section minimums before resubmitting.`,
  GROWTH_LONGFORM_OUTLINE_EVIDENCE_MISMATCH: "Every section evidenceId must come from the pinned Growth Receipt and must not be invented.",
};

export function growthLongformCorrectionError(
  code: GrowthLongformModelCorrectionCode,
): Error & { code: GrowthLongformModelCorrectionCode } {
  return Object.assign(new Error(correctionInstructions[code]), { code });
}

const writerBlockedDiagnosticCodes = {
  missing_source: "STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_SOURCE",
  conflicting_sources: "STEWARD_LONGFORM_WRITER_BLOCKED_CONFLICTING_SOURCES",
  missing_gm_resolution: "STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_GM_RESOLUTION",
  authority_violation: "STEWARD_LONGFORM_WRITER_BLOCKED_AUTHORITY_VIOLATION",
  hidden_fact_risk: "STEWARD_LONGFORM_WRITER_BLOCKED_HIDDEN_FACT_RISK",
  tool_failed: "STEWARD_LONGFORM_WRITER_BLOCKED_TOOL_FAILED",
  major_conflict: "STEWARD_LONGFORM_WRITER_BLOCKED_MAJOR_CONFLICT",
  user_confirmation_required: "STEWARD_LONGFORM_WRITER_BLOCKED_USER_CONFIRMATION_REQUIRED",
  insufficient_input: "STEWARD_LONGFORM_WRITER_BLOCKED_INSUFFICIENT_INPUT",
} as const;

export const growthLongformWriterBlockedDiagnosticCodes = Object.freeze(
  Object.values(writerBlockedDiagnosticCodes),
);

export const growthLongformSectionDiagnosticCodes = Object.freeze([
  "GROWTH_LONGFORM_SECTION_INVALID",
  "GROWTH_LONGFORM_SECTION_AUTHORITY_MISMATCH",
  "GROWTH_LONGFORM_SECTION_OUTLINE_MISMATCH",
  "GROWTH_LONGFORM_SECTION_EVIDENCE_MISMATCH",
  "GROWTH_LONGFORM_SECTION_LENGTH_INVALID",
  "GROWTH_LONGFORM_SECTION_TOO_SHORT",
  "GROWTH_LONGFORM_SECTION_TOO_LONG",
  "GROWTH_LONGFORM_SECTION_PRIOR_PROSE_REQUIRED",
  "GROWTH_LONGFORM_SECTION_PADDING_REJECTED",
  "GROWTH_LONGFORM_SECTION_FILLER_REJECTED",
  "GROWTH_LONGFORM_SECTION_REPLAY",
] as const satisfies readonly GrowthLongformSectionErrorCode[]);

const sectionDiagnosticCodes = new Set<string>(growthLongformSectionDiagnosticCodes);

export function isGrowthLongformSectionDiagnosticCode(
  value: string | null | undefined,
): value is GrowthLongformSectionErrorCode {
  return typeof value === "string" && sectionDiagnosticCodes.has(value);
}

export const growthLongformSectionWriterCorrectionCodes = Object.freeze([
  "GROWTH_LONGFORM_SECTION_INVALID",
  "GROWTH_LONGFORM_SECTION_LENGTH_INVALID",
  "GROWTH_LONGFORM_SECTION_TOO_SHORT",
  "GROWTH_LONGFORM_SECTION_TOO_LONG",
  "GROWTH_LONGFORM_SECTION_PADDING_REJECTED",
  "GROWTH_LONGFORM_SECTION_FILLER_REJECTED",
] as const satisfies readonly GrowthLongformSectionErrorCode[]);

export type GrowthLongformSectionWriterCorrectionCode =
  typeof growthLongformSectionWriterCorrectionCodes[number];

export type GrowthLongformWriterCorrectionCode = GrowthLongformSectionWriterCorrectionCode
  | "STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_SOURCE"
  | "STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_GM_RESOLUTION"
  | "STEWARD_LONGFORM_WRITER_RESULT_INVALID"
  | "STEWARD_LONGFORM_WRITER_EVIDENCE_ECHO_INVALID";

const sectionWriterCorrectionCodes = new Set<string>(growthLongformSectionWriterCorrectionCodes);

export function isGrowthLongformSectionWriterCorrectionCode(
  value: string | null | undefined,
): value is GrowthLongformSectionWriterCorrectionCode {
  return typeof value === "string" && sectionWriterCorrectionCodes.has(value);
}

const sectionWriterCorrectionInstructions: Record<GrowthLongformSectionWriterCorrectionCode, string> = {
  GROWTH_LONGFORM_SECTION_INVALID:
    "The previous Writer candidate was not a valid non-empty section within the 20000-code-point hard limit. Rewrite the complete section.",
  GROWTH_LONGFORM_SECTION_LENGTH_INVALID:
    "The previous Writer candidate was outside the selected section's exact Unicode code-point range. Rewrite it within the stated minimum and maximum.",
  GROWTH_LONGFORM_SECTION_TOO_SHORT:
    "The combined Writer candidate is shorter than the selected section minimum. Continue the supplied draft with consequential new prose until the stated minimum is reached.",
  GROWTH_LONGFORM_SECTION_TOO_LONG:
    "The previous Writer candidate exceeded the section hard safety limit. Rewrite the complete section within the tool hard limit; the outline maximum itself is only a preferred estimate.",
  GROWTH_LONGFORM_SECTION_PADDING_REJECTED:
    "The previous Writer candidate contained leading or trailing padding. Rewrite it without leading or trailing whitespace.",
  GROWTH_LONGFORM_SECTION_FILLER_REJECTED:
    "The previous Writer candidate contained repeated filler. Rewrite it with distinct, consequential prose and no repeated paragraphs or sentence loops.",
};

export function growthLongformSectionWriterCorrectionInstruction(
  code: GrowthLongformSectionWriterCorrectionCode,
): string {
  return sectionWriterCorrectionInstructions[code];
}

export function growthLongformWriterCorrectionInstruction(
  code: GrowthLongformWriterCorrectionCode,
): string {
  if (code === "STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_SOURCE") {
    return "The pinned evidence values and the approved outline section are present in sourceMaterial and evidenceIds. Re-read only those supplied authorities and retry the same section. Missing pre-existing scene prose, dialogue, connective action, sensory detail, pacing, or minor non-Canon incidents is not missing_source: create those details as needed without presenting them as prior Canon. Return blocked with missing_source only if a required pinned fact is absent or completing the approved section would require a new consequential Canon fact, identity, rule, outcome, or authority decision. Never invent or substitute evidence.";
  }
  if (code === "STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_GM_RESOLUTION") {
    return "The previous Writer response incorrectly treated Creator Lens section authoring as a live player turn. No GM resolution exists or is required here: the selected outline section already supplies the confirmed creative events, choices, consequences, and ending state. Realize only those decided facts and the pinned evidence; do not invent an additional outcome.";
  }
  if (code === "STEWARD_LONGFORM_WRITER_RESULT_INVALID") {
    return "The previous Writer response did not match the strict candidate result schema. Return exactly one candidate with non-empty candidateText, only allowed evidenceIds, gmResolutionId null, and an empty authorityChanges array.";
  }
  if (code === "STEWARD_LONGFORM_WRITER_EVIDENCE_ECHO_INVALID") {
    return "The previous Writer response echoed an evidenceId that was not supplied in this request. Return the candidate using only the supplied evidenceIds; never invent or copy another identifier.";
  }
  return growthLongformSectionWriterCorrectionInstruction(code);
}

export function growthLongformWriterBlockedDiagnosticCode(
  reasonCode: string,
): typeof growthLongformWriterBlockedDiagnosticCodes[number] | null {
  return writerBlockedDiagnosticCodes[reasonCode as keyof typeof writerBlockedDiagnosticCodes] ?? null;
}

export function classifyGrowthLongformWriterBlockedDiagnostics(
  reasonCodes: readonly string[],
): Array<typeof growthLongformWriterBlockedDiagnosticCodes[number]> {
  return [...new Set(reasonCodes
    .map((reasonCode) => growthLongformWriterBlockedDiagnosticCode(reasonCode))
    .filter((code): code is typeof growthLongformWriterBlockedDiagnosticCodes[number] => code !== null))];
}
