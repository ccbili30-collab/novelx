import { Type } from "typebox";
import { z } from "zod";

const evidenceIdSchema = z.string().trim().min(1).max(240);
const safeSummarySchema = z.string().trim().min(1).max(2_000);

export const growthImpactBriefSchema = z.object({
  summary: safeSummarySchema,
  targets: z.array(z.object({
    evidenceId: evidenceIdSchema,
    decision: z.enum(["revise", "preserve", "stale_visual"]),
    reasonSummary: safeSummarySchema,
  }).strict()).min(1).max(100),
  additions: z.array(z.object({
    kind: z.enum(["world", "location", "faction", "story", "oc", "document", "assertion", "relation"]),
    reasonSummary: safeSummarySchema,
  }).strict()).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.targets.map((target) => target.evidenceId)).size !== value.targets.length) {
    context.addIssue({ code: "custom", path: ["targets"], message: "GROWTH_REVISION_IMPACT_TARGET_DUPLICATE" });
  }
});

export type GrowthImpactBrief = z.infer<typeof growthImpactBriefSchema>;

export const growthImpactBriefParameters = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  targets: Type.Array(Type.Object({
    evidenceId: Type.String({ minLength: 1, maxLength: 240 }),
    decision: Type.Union([Type.Literal("revise"), Type.Literal("preserve"), Type.Literal("stale_visual")]),
    reasonSummary: Type.String({ minLength: 1, maxLength: 2_000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
  additions: Type.Array(Type.Object({
    kind: Type.Union([
      Type.Literal("world"), Type.Literal("location"), Type.Literal("faction"), Type.Literal("story"),
      Type.Literal("oc"), Type.Literal("document"), Type.Literal("assertion"), Type.Literal("relation"),
    ]),
    reasonSummary: Type.String({ minLength: 1, maxLength: 2_000 }),
  }, { additionalProperties: false }), { maxItems: 100 }),
}, { additionalProperties: false });
