import { Type } from "typebox";
import { z } from "zod";
import {
  growthInquiryDiagnosticCodes,
  isGrowthInquiryDiagnosticCode,
  type GrowthInquiryDiagnosticCode,
} from "../../shared/diagnostics/growthInquiryDiagnostics";
import {
  selectCausalInquiry,
  type CausalInquirySelection,
} from "../../domain/growth/editorial/causalInquirySelector";

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
    if (choice.length !== 1) context.addIssue({
      code: "custom", path: ["selectedLocalId", "creatorChoiceCount"],
      message: "A creator-choice Brief requires one exact choice Inquiry.",
    });
  } else {
    if (!selected) context.addIssue({
      code: "custom", path: ["selectedLocalId", "selection"],
      message: "The selected Inquiry must exist in this Brief.",
    });
    if (choice.length !== 0) context.addIssue({
      code: "custom", path: ["selectedLocalId", "choiceConflict"],
      message: "A normal Brief cannot contain a creator-choice Inquiry.",
    });
  }
  const frontier = selected ?? choice[0];
  const highestPriority = Math.max(...value.inquiries.map((item) => item.priority));
  if (value.inquiries.filter((item) => item.priority === highestPriority).length !== 1) {
    context.addIssue({
      code: "custom", path: ["inquiries", "priorityTie"],
      message: "The Inquiry Brief requires one unique highest priority.",
    });
  } else if (frontier && frontier.priority !== highestPriority) {
    context.addIssue({
      code: "custom", path: ["selectedLocalId", "priority"],
      message: "The Inquiry frontier must have the highest priority.",
    });
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

export type CompiledCausalGrowthInquiry =
  | { status: "ready"; brief: GrowthInquiryBrief; selection: Extract<CausalInquirySelection, { status: "selected" }> }
  | { status: "no_progress"; selection: Extract<CausalInquirySelection, { status: "no_progress" }> };

/** Binds a model-authored Brief to the Harness-owned causal selection without changing Worker IPC. */
export function compileCausalGrowthInquiryBrief(rawBrief: unknown, rawSelectionInput: unknown): CompiledCausalGrowthInquiry {
  const selection = selectCausalInquiry(rawSelectionInput);
  if (selection.status === "no_progress") return { status: "no_progress", selection };
  const parsed = growthInquiryBriefSchema.safeParse(rawBrief);
  if (!parsed.success) throw causalBriefError("CAUSAL_INQUIRY_BRIEF_INVALID");
  const brief = parsed.data;
  const candidateIds = selection.consideredGapIds;
  const inquiryIds = brief.inquiries.map((item) => item.localId).sort();
  if (candidateIds.length !== inquiryIds.length || candidateIds.some((id, index) => id !== inquiryIds[index])) {
    throw causalBriefError("CAUSAL_INQUIRY_BRIEF_SET_MISMATCH");
  }
  const selected = brief.inquiries.find((item) => item.localId === selection.candidate.gapId);
  if (!selected || selected.question !== selection.candidate.question
    || !sameStringSet(selected.evidenceIds, selection.candidate.evidenceRefs)) {
    throw causalBriefError("CAUSAL_INQUIRY_BRIEF_BINDING_MISMATCH");
  }
  const decisionMatches = selection.action === "autonomous"
    ? brief.selectedLocalId === selected.localId && !selected.requiresCreatorChoice
    : brief.selectedLocalId === null && selected.requiresCreatorChoice;
  if (!decisionMatches) throw causalBriefError("CAUSAL_INQUIRY_BRIEF_DECISION_MISMATCH");
  return { status: "ready", brief, selection };
}

export const growthInquiryBriefDiagnosticCodes = growthInquiryDiagnosticCodes;

export type GrowthInquiryBriefDiagnosticCode = GrowthInquiryDiagnosticCode;

/** Returns one content-free reason for a rejected model-authored Inquiry Brief. */
export function classifyGrowthInquiryBriefFailure(value: unknown): GrowthInquiryBriefDiagnosticCode | null {
  const parsed = growthInquiryBriefSchema.safeParse(value);
  if (parsed.success) return null;
  const issues = parsed.error.issues;
  const paths = issues.map((issue) => issue.path);
  if (issues.some((issue) => (issue.code === "invalid_type" && issue.path.length <= 1)
    || (issue.code === "unrecognized_keys" && issue.path.length === 0))) {
    return "STEWARD_GROWTH_INQUIRY_INPUT_INVALID";
  }
  if (issues.some((issue) => issue.path[0] === "inquiries" && issue.path.length === 1
    && (issue.code === "too_small" || issue.code === "too_big"))) {
    return "STEWARD_GROWTH_INQUIRY_COUNT_INVALID";
  }
  if (paths.some((path) => path[0] === "inquiries" && path[1] === "priorityTie")) {
    return "STEWARD_GROWTH_INQUIRY_PRIORITY_TIE_INVALID";
  }
  if (paths.some((path) => path[0] === "inquiries" && path.length > 1
    && path[1] !== "priorityTie")) {
    return "STEWARD_GROWTH_INQUIRY_ITEM_INVALID";
  }
  if (paths.some((path) => path[0] === "priorTransitions")) {
    return "STEWARD_GROWTH_INQUIRY_TRANSITION_INVALID";
  }
  if (paths.some((path) => path[0] === "selectedLocalId" && path[1] === "creatorChoiceCount")) {
    return "STEWARD_GROWTH_INQUIRY_CHOICE_CARDINALITY_INVALID";
  }
  if (paths.some((path) => path[0] === "selectedLocalId"
    && (path[1] === "selection" || path[1] === "choiceConflict"))) {
    return "STEWARD_GROWTH_INQUIRY_SELECTION_INVALID";
  }
  if (paths.some((path) => path[0] === "selectedLocalId" && path[1] === "priority")) {
    return "STEWARD_GROWTH_INQUIRY_FRONTIER_PRIORITY_INVALID";
  }
  if (paths.some((path) => path[0] === "selectedLocalId")
    || parsed.error.issues.some((issue) => issue.code === "custom" && issue.path.length === 0)) {
    return "STEWARD_GROWTH_INQUIRY_FRONTIER_INVALID";
  }
  return "STEWARD_GROWTH_INQUIRY_INPUT_INVALID";
}

export function isGrowthInquiryBriefDiagnosticCode(value: unknown): value is GrowthInquiryBriefDiagnosticCode {
  return isGrowthInquiryDiagnosticCode(value);
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function causalBriefError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
