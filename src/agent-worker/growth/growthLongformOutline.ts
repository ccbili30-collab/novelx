import { Type } from "typebox";
import { z } from "zod";

const identifier = z.string().trim().min(1).max(240);
const localId = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const safeText = (max: number) => z.string().trim().min(1).max(max);

const sectionSchema = z.object({
  localId,
  title: safeText(500),
  objective: safeText(4_000),
  evidenceIds: z.array(identifier).min(1).max(200),
  continuityConstraints: z.array(safeText(2_000)).min(1).max(50),
  estimatedCodePoints: z.object({
    min: z.number().int().min(200).max(8_000),
    max: z.number().int().min(200).max(8_000),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.estimatedCodePoints.min > value.estimatedCodePoints.max) {
    context.addIssue({ code: "custom", message: "GROWTH_LONGFORM_OUTLINE_RANGE_INVALID" });
  }
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length
    || new Set(value.continuityConstraints).size !== value.continuityConstraints.length) {
    context.addIssue({ code: "custom", message: "GROWTH_LONGFORM_OUTLINE_DUPLICATE_VALUE" });
  }
});

export const growthLongformOutlineSchema = z.object({
  summary: safeText(2_000),
  sections: z.array(sectionSchema).min(2).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.sections.map((section) => section.localId)).size !== value.sections.length) {
    context.addIssue({ code: "custom", message: "GROWTH_LONGFORM_OUTLINE_DUPLICATE_SECTION" });
  }
  if (value.sections.reduce((total, section) => total + section.estimatedCodePoints.min, 0) < 10_000) {
    context.addIssue({ code: "custom", message: "GROWTH_LONGFORM_OUTLINE_TARGET_TOO_SHORT" });
  }
});

const identifierParameters = Type.String({ minLength: 1, maxLength: 240 });
export const growthLongformOutlineParameters = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  sections: Type.Array(Type.Object({
    localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    objective: Type.String({ minLength: 1, maxLength: 4_000 }),
    evidenceIds: Type.Array(identifierParameters, { minItems: 1, maxItems: 200 }),
    continuityConstraints: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { minItems: 1, maxItems: 50 }),
    estimatedCodePoints: Type.Object({
      min: Type.Integer({ minimum: 200, maximum: 8_000 }),
      max: Type.Integer({ minimum: 200, maximum: 8_000 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }), { minItems: 2, maxItems: 100 }),
}, { additionalProperties: false });

export interface GrowthLongformOutlineAuthority {
  outlineId: string;
  checkpointId: string;
  receiptId: string;
  availableEvidenceIds: readonly string[];
}

export interface GrowthLongformOutline {
  outlineId: string;
  checkpointId: string;
  receiptId: string;
  summary: string;
  sections: z.infer<typeof sectionSchema>[];
}

export type GrowthLongformOutlineErrorCode =
  | "GROWTH_LONGFORM_OUTLINE_INVALID"
  | "GROWTH_LONGFORM_OUTLINE_AUTHORITY_INVALID"
  | "GROWTH_LONGFORM_OUTLINE_DUPLICATE_SECTION"
  | "GROWTH_LONGFORM_OUTLINE_DUPLICATE_VALUE"
  | "GROWTH_LONGFORM_OUTLINE_RANGE_INVALID"
  | "GROWTH_LONGFORM_OUTLINE_TARGET_TOO_SHORT"
  | "GROWTH_LONGFORM_OUTLINE_EVIDENCE_MISMATCH";

export function compileGrowthLongformOutline(
  input: unknown,
  authority: GrowthLongformOutlineAuthority,
): GrowthLongformOutline {
  const parsed = growthLongformOutlineSchema.safeParse(input);
  if (!parsed.success) throw outlineError(firstOutlineCode(parsed.error.issues.map((issue) => issue.message)));
  const outlineId = identifier.safeParse(authority.outlineId);
  const checkpointId = identifier.safeParse(authority.checkpointId);
  const receiptId = identifier.safeParse(authority.receiptId);
  const available = authority.availableEvidenceIds.map((value) => identifier.safeParse(value));
  if (!outlineId.success || !checkpointId.success || !receiptId.success
    || available.some((result) => !result.success)
    || new Set(authority.availableEvidenceIds).size !== authority.availableEvidenceIds.length) {
    throw outlineError("GROWTH_LONGFORM_OUTLINE_AUTHORITY_INVALID");
  }
  const allowed = new Set(authority.availableEvidenceIds);
  if (parsed.data.sections.some((section) => section.evidenceIds.some((evidenceId) => !allowed.has(evidenceId)))) {
    throw outlineError("GROWTH_LONGFORM_OUTLINE_EVIDENCE_MISMATCH");
  }
  return {
    outlineId: outlineId.data,
    checkpointId: checkpointId.data,
    receiptId: receiptId.data,
    summary: parsed.data.summary,
    sections: parsed.data.sections,
  };
}

function firstOutlineCode(messages: string[]): GrowthLongformOutlineErrorCode {
  const codes: GrowthLongformOutlineErrorCode[] = [
    "GROWTH_LONGFORM_OUTLINE_DUPLICATE_SECTION",
    "GROWTH_LONGFORM_OUTLINE_DUPLICATE_VALUE",
    "GROWTH_LONGFORM_OUTLINE_RANGE_INVALID",
    "GROWTH_LONGFORM_OUTLINE_TARGET_TOO_SHORT",
  ];
  return codes.find((code) => messages.includes(code)) ?? "GROWTH_LONGFORM_OUTLINE_INVALID";
}

function outlineError(code: GrowthLongformOutlineErrorCode): Error & { code: GrowthLongformOutlineErrorCode } {
  return Object.assign(new Error("Growth longform outline is invalid."), { code });
}
