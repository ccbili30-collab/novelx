import { Type } from "typebox";
import { z } from "zod";

import {
  growthRevisionExistingRefParameter,
  growthRevisionExistingRefSchema,
} from "./growthRevisionReferences";
const safeSummarySchema = z.string().trim().min(1).max(2_000);

export const growthImpactBriefSchema = z.object({
  summary: safeSummarySchema,
  targets: z.array(z.object({
    targetRef: growthRevisionExistingRefSchema,
    decision: z.enum(["revise", "preserve", "stale_visual"]),
    reasonSummary: safeSummarySchema,
  }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.targets.map((target) => target.targetRef)).size !== value.targets.length) {
    context.addIssue({ code: "custom", path: ["targets"], message: "GROWTH_REVISION_IMPACT_TARGET_DUPLICATE" });
  }
});

export type GrowthImpactBrief = z.infer<typeof growthImpactBriefSchema>;

export const growthImpactBriefParameters = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  targets: Type.Array(Type.Object({
    targetRef: growthRevisionExistingRefParameter,
    decision: Type.Union([Type.Literal("revise"), Type.Literal("preserve"), Type.Literal("stale_visual")]),
    reasonSummary: Type.String({ minLength: 1, maxLength: 2_000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });
