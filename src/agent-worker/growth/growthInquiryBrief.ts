import { Type } from "typebox";
import { z } from "zod";

const localId = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const evidenceId = z.string().trim().min(1).max(240);
const inquiry = z.object({
  localId,
  question: z.string().trim().min(1).max(2_000),
  evidenceIds: z.array(evidenceId).max(100),
  evidenceState: z.enum(["known", "conflicted", "unknown"]),
  safeSummary: z.string().trim().min(1).max(1_000),
  proposedAction: z.string().trim().min(1).max(2_000),
  provisionalAssumption: z.string().trim().min(1).max(2_000).nullable(),
  priority: z.number().finite().min(0).max(1_000_000),
  requiresCreatorChoice: z.boolean(),
}).strict().superRefine((value, context) => {
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    context.addIssue({ code: "custom", path: ["evidenceIds"], message: "Inquiry evidence IDs must be unique." });
  }
  if (value.evidenceState !== "unknown" && value.evidenceIds.length === 0) {
    context.addIssue({ code: "custom", path: ["evidenceIds"], message: "Known or conflicted Inquiry requires evidence." });
  }
  if (value.evidenceState === "unknown" && !value.requiresCreatorChoice && value.provisionalAssumption === null) {
    context.addIssue({ code: "custom", path: ["provisionalAssumption"], message: "A non-blocking unknown Inquiry requires an assumption." });
  }
});

const priorTransition = z.discriminatedUnion("phase", [
  z.object({ priorLocalId: localId, phase: z.literal("promoted"), successorLocalId: localId }).strict(),
  z.object({ priorLocalId: localId, phase: z.literal("answered") }).strict(),
  z.object({
    priorLocalId: localId,
    phase: z.literal("closed"),
    reason: z.enum(["invalidated_by_evidence", "duplicate", "superseded"]),
  }).strict(),
]);

export const growthInquiryBriefSchema = z.object({
  inquiries: z.array(inquiry).min(3).max(7),
  selectedLocalId: localId.nullable(),
  priorTransitions: z.array(priorTransition).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.inquiries.map((item) => item.localId)).size !== value.inquiries.length) {
    context.addIssue({ code: "custom", path: ["inquiries"], message: "Inquiry local IDs must be unique." });
  }
  if (new Set(value.priorTransitions.map((item) => item.priorLocalId)).size !== value.priorTransitions.length) {
    context.addIssue({ code: "custom", path: ["priorTransitions"], message: "A prior Inquiry can transition only once." });
  }
  const choice = value.inquiries.filter((item) => item.requiresCreatorChoice);
  const selected = value.selectedLocalId === null
    ? undefined
    : value.inquiries.find((item) => item.localId === value.selectedLocalId);
  if (value.selectedLocalId === null) {
    if (choice.length !== 1) context.addIssue({ code: "custom", message: "A creator-choice Brief requires one exact choice Inquiry." });
  } else if (!selected || choice.length !== 0) {
    context.addIssue({ code: "custom", message: "A normal Brief requires one selected non-choice Inquiry." });
  }
  const frontier = selected ?? choice[0];
  const highestPriority = Math.max(...value.inquiries.map((item) => item.priority));
  if (value.inquiries.filter((item) => item.priority === highestPriority).length !== 1
    || (frontier && frontier.priority !== highestPriority)) {
    context.addIssue({ code: "custom", message: "The Inquiry frontier must be the unique highest priority." });
  }
  const localIds = new Set(value.inquiries.map((item) => item.localId));
  for (const transition of value.priorTransitions) {
    if (transition.phase === "promoted" && !localIds.has(transition.successorLocalId)) {
      context.addIssue({ code: "custom", path: ["priorTransitions"], message: "Promoted Inquiry successor must be in this Brief." });
    }
  }
});

const localIdParameter = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" });
const inquiryParameter = Type.Object({
  localId: localIdParameter,
  question: Type.String({ minLength: 1, maxLength: 2_000 }),
  evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 100, uniqueItems: true }),
  evidenceState: Type.Union([Type.Literal("known"), Type.Literal("conflicted"), Type.Literal("unknown")]),
  safeSummary: Type.String({ minLength: 1, maxLength: 1_000 }),
  proposedAction: Type.String({ minLength: 1, maxLength: 2_000 }),
  provisionalAssumption: Type.Union([Type.String({ minLength: 1, maxLength: 2_000 }), Type.Null()]),
  priority: Type.Number({ minimum: 0, maximum: 1_000_000 }),
  requiresCreatorChoice: Type.Boolean(),
}, { additionalProperties: false });

export const growthInquiryBriefParameters = Type.Object({
  inquiries: Type.Array(inquiryParameter, { minItems: 3, maxItems: 7 }),
  selectedLocalId: Type.Union([localIdParameter, Type.Null()]),
  priorTransitions: Type.Array(Type.Union([
    Type.Object({ priorLocalId: localIdParameter, phase: Type.Literal("promoted"), successorLocalId: localIdParameter }, { additionalProperties: false }),
    Type.Object({ priorLocalId: localIdParameter, phase: Type.Literal("answered") }, { additionalProperties: false }),
    Type.Object({
      priorLocalId: localIdParameter,
      phase: Type.Literal("closed"),
      reason: Type.Union([Type.Literal("invalidated_by_evidence"), Type.Literal("duplicate"), Type.Literal("superseded")]),
    }, { additionalProperties: false }),
  ]), { maxItems: 100 }),
}, { additionalProperties: false });

export type GrowthInquiryBrief = z.infer<typeof growthInquiryBriefSchema>;
