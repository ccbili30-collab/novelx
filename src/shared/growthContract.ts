import { z } from "zod";

const idSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });

export const growthContractVersion = "1.1.0" as const;
export const growthCapabilityVersion = "hackathon-growth-closure-v4" as const;

export const growthGoalStatusSchema = z.enum([
  "active", "completed", "blocked", "cancelled", "reconciliation_required",
]);
export const growthCycleStatusSchema = z.enum([
  "planned", "running", "committed", "evaluated", "blocked", "failed", "cancelled", "reconciliation_required",
]);

const uniqueValues = (values: readonly string[], context: z.RefinementCtx, path: string): void => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path: [path], message: "Values must be unique." });
};

export const growthSeedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(12_000) }).strict(),
  z.object({ kind: z.literal("source_document"), sourceDocumentId: idSchema, sourceVersionId: idSchema }).strict(),
  z.object({ kind: z.literal("resource"), resourceId: idSchema, resourceVersionId: idSchema.nullable() }).strict(),
]);

export const growthGoalSchema = z.object({
  id: idSchema,
  branchId: idSchema,
  seed: growthSeedSchema,
  authorizedScopeResourceIds: z.array(idSchema).min(1).max(100),
  status: growthGoalStatusSchema,
  currentRuleRevision: z.number().int().min(1).max(1_000_000),
  currentCycleSequence: z.number().int().min(0).max(1_000_000),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((value, context) => uniqueValues(value.authorizedScopeResourceIds, context, "authorizedScopeResourceIds"));

export const growthGoalCreateSchema = z.object({
  id: idSchema,
  idempotencyKey: idSchema,
  branchId: idSchema,
  seed: growthSeedSchema,
  authorizedScopeResourceIds: z.array(idSchema).min(1).max(100),
  initialRuleText: z.string().trim().min(1).max(12_000),
  sourceMessageId: idSchema.nullable(),
}).strict().superRefine((value, context) => uniqueValues(value.authorizedScopeResourceIds, context, "authorizedScopeResourceIds"));

export const growthRuleRevisionSchema = z.object({
  goalId: idSchema,
  revision: z.number().int().min(1).max(1_000_000),
  ruleText: z.string().trim().min(1).max(12_000),
  sourceMessageId: idSchema.nullable(),
  createdAt: timestampSchema,
}).strict();

export const growthRuleAppendSchema = z.object({
  goalId: idSchema,
  expectedRevision: z.number().int().min(1).max(1_000_000),
  ruleText: z.string().trim().min(1).max(12_000),
  sourceMessageId: idSchema.nullable(),
}).strict();

export const growthCycleSchema = z.object({
  id: idSchema,
  goalId: idSchema,
  sequence: z.number().int().min(1).max(1_000_000),
  idempotencyKey: idSchema,
  inputCheckpointId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  runId: idSchema.nullable(),
  receiptId: idSchema.nullable(),
  changeSetId: idSchema.nullable(),
  outputCheckpointId: idSchema.nullable(),
  status: growthCycleStatusSchema,
  failureCode: z.string().trim().min(1).max(160).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  terminalAt: timestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  const terminal = ["committed", "evaluated", "blocked", "failed", "cancelled", "reconciliation_required"].includes(value.status);
  if (terminal !== (value.terminalAt !== null)) context.addIssue({ code: "custom", message: "Terminal timestamp does not match cycle status." });
  if (value.status === "committed" && (!value.runId || !value.receiptId || !value.changeSetId || !value.outputCheckpointId || value.failureCode)) {
    context.addIssue({ code: "custom", message: "Committed cycle requires run, receipt, Change Set and output checkpoint only." });
  }
  if (value.status !== "committed" && (value.changeSetId !== null || value.outputCheckpointId !== null)) {
    context.addIssue({ code: "custom", message: "Only committed cycles may expose Change Set output state." });
  }
  if (value.status === "evaluated" && (!value.runId || !value.receiptId || value.failureCode)) {
    context.addIssue({ code: "custom", message: "Evaluated cycle requires run, receipt and no failure state." });
  }
  if (value.status === "planned" && (value.runId || value.receiptId || value.failureCode || value.terminalAt)) {
    context.addIssue({ code: "custom", message: "Planned cycle contains execution state." });
  }
  if (value.status === "running" && (!value.runId || value.failureCode || value.terminalAt)) {
    context.addIssue({ code: "custom", message: "Running cycle requires exactly one Run." });
  }
  if (["blocked", "failed", "cancelled", "reconciliation_required"].includes(value.status) && !value.failureCode) {
    context.addIssue({ code: "custom", message: "Terminal non-commit cycle requires failure code." });
  }
});

const growthFocusKindSchema = z.enum(["world", "story", "oc"]);
const growthContentCycleIntentCreateSchema = z.object({
  kind: z.enum(["expand", "revision"]),
  focusKinds: z.array(growthFocusKindSchema).min(1).max(3),
  resumeFrontier: z.array(growthFocusKindSchema).max(3),
}).strict().superRefine((value, context) => {
  uniqueValues(value.focusKinds, context, "focusKinds");
  uniqueValues(value.resumeFrontier, context, "resumeFrontier");
});
const growthClosureEvaluationIntentCreateSchema = z.object({
  kind: z.literal("closure_evaluation"),
  profileId: idSchema,
  revision: z.number().int().min(1).max(1_000_000),
  checkpointId: idSchema,
}).strict();
const growthRepairIntentCreateSchema = z.object({
  kind: z.literal("repair"),
  profileId: idSchema,
  revision: z.number().int().min(1).max(1_000_000),
  originalReviewId: idSchema,
  selectedFindingId: idSchema,
  selectedFindingFingerprint: sha256Schema,
}).strict();
export const growthCycleIntentCreateSchema = z.union([
  growthContentCycleIntentCreateSchema,
  growthClosureEvaluationIntentCreateSchema,
  growthRepairIntentCreateSchema,
]);

export const growthCycleBeginSchema = z.object({
  id: idSchema, goalId: idSchema, idempotencyKey: idSchema, inputCheckpointId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  intent: growthCycleIntentCreateSchema,
}).strict();
export const growthCycleAttachRunSchema = z.object({ cycleId: idSchema, runId: idSchema }).strict();
export const growthCycleAttachChangeSetSchema = z.object({ cycleId: idSchema, changeSetId: idSchema }).strict();
export const growthCycleTerminalizeSchema = z.object({
  cycleId: idSchema,
  status: z.enum(["blocked", "failed", "cancelled", "reconciliation_required"]),
  failureCode: z.string().trim().min(1).max(160),
}).strict();

export const growthReceiptLinkReasonCodeSchema = z.enum([
  "scope_match", "exact_subject", "exact_predicate", "alias", "graph_hop", "time_filter", "source_match", "conflict",
]);
export const growthTargetKindSchema = z.enum(["document", "resource", "assertion", "relation", "change_set"]);
export const growthContentRefKindSchema = z.enum(["document", "resource", "assertion", "relation", "change_set"]);

export const growthRetrievalReceiptLinkSchema = z.object({
  rank: z.number().int().min(1).max(100_000),
  targetKind: growthTargetKindSchema,
  targetId: idSchema,
  targetVersionId: idSchema,
  score: z.number().finite().min(0).max(1),
  reasonCodes: z.array(growthReceiptLinkReasonCodeSchema).min(1).max(12),
  pathTargetIds: z.array(idSchema).max(32),
  stableLocator: z.string().trim().min(1).max(2_000).nullable(),
  stableVersionId: idSchema.nullable(),
  stableHash: sha256Schema.nullable(),
}).strict().superRefine((value, context) => {
  uniqueValues(value.reasonCodes, context, "reasonCodes");
  uniqueValues(value.pathTargetIds, context, "pathTargetIds");
  const completeLocator = value.stableLocator !== null && value.stableVersionId !== null && value.stableHash !== null;
  const emptyLocator = value.stableLocator === null && value.stableVersionId === null && value.stableHash === null;
  if (!completeLocator && !emptyLocator) context.addIssue({ code: "custom", message: "Stable locator, version and hash must be all present or all absent." });
});

const growthTimeFilterSchema = z.object({
  from: timestampSchema.nullable(), to: timestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
    context.addIssue({ code: "custom", message: "Time range is inverted." });
  }
});

export const growthCoverageSchema = z.object({
  state: z.enum(["complete", "partial", "unknown"]),
  searchedScopeCount: z.number().int().min(0).max(100),
  omittedCount: z.number().int().min(0).max(1_000_000),
}).strict();

const receiptInputShape = {
  id: idSchema,
  cycleId: idSchema,
  runId: idSchema,
  toolInvocationId: idSchema,
  branchId: idSchema,
  checkpointId: idSchema,
  lens: z.literal("creator"),
  effectiveScopeResourceIds: z.array(idSchema).min(1).max(100),
  query: z.string().trim().min(1).max(12_000),
  aliases: z.array(z.string().trim().min(1).max(240)).max(100),
  validTime: growthTimeFilterSchema.nullable(),
  recordedTime: growthTimeFilterSchema.nullable(),
  maxHops: z.number().int().min(0).max(8),
  cpuBudgetMs: z.number().int().min(1).max(60_000),
  expansionBudget: z.number().int().min(1).max(100_000),
  resultBudget: z.number().int().min(1).max(100_000),
  tokenBudget: z.number().int().min(1).max(1_000_000),
  policyVersion: z.string().trim().min(1).max(120),
  coverage: growthCoverageSchema,
  truncated: z.boolean(),
  links: z.array(growthRetrievalReceiptLinkSchema).max(100_000),
};

const refineReceiptInput = (value: { effectiveScopeResourceIds: string[]; aliases: string[]; resultBudget: number; coverage: z.infer<typeof growthCoverageSchema>; truncated: boolean; links: z.infer<typeof growthRetrievalReceiptLinkSchema>[] }, context: z.RefinementCtx): void => {
  uniqueValues(value.effectiveScopeResourceIds, context, "effectiveScopeResourceIds");
  if (new Set(value.aliases.map((alias) => alias.toLocaleLowerCase("en-US"))).size !== value.aliases.length) {
    context.addIssue({ code: "custom", path: ["aliases"], message: "Aliases must be unique case-insensitively." });
  }
  value.links.forEach((link, index) => {
    if (link.rank !== index + 1) context.addIssue({ code: "custom", path: ["links", index, "rank"], message: "Receipt link ranks must follow array order from 1." });
  });
  if (value.coverage.searchedScopeCount > value.effectiveScopeResourceIds.length) {
    context.addIssue({ code: "custom", path: ["coverage", "searchedScopeCount"], message: "Searched scope count exceeds effective scope." });
  }
  if (value.coverage.state === "complete" && (value.coverage.omittedCount > 0 || value.truncated)) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "Complete coverage cannot be omitted or truncated." });
  }
  if (value.links.length > value.resultBudget) {
    context.addIssue({ code: "custom", path: ["links"], message: "Links exceed the result budget." });
  }
};

export const growthRetrievalReceiptCreateSchema = z.object(receiptInputShape).strict().superRefine(refineReceiptInput);
export const growthRetrievalReceiptSchema = z.object({
  ...receiptInputShape,
  queryHash: sha256Schema,
  resultHash: sha256Schema,
  hitCount: z.number().int().min(0).max(100_000),
  conflictCount: z.number().int().min(0).max(100_000),
  locatorCount: z.number().int().min(0).max(100_000),
  createdAt: timestampSchema,
}).strict().superRefine((value, context) => {
  refineReceiptInput(value, context);
  if (value.hitCount !== value.links.length) context.addIssue({ code: "custom", path: ["hitCount"], message: "Hit count is inconsistent." });
  if (value.conflictCount !== value.links.filter((link) => link.reasonCodes.includes("conflict")).length) {
    context.addIssue({ code: "custom", path: ["conflictCount"], message: "Conflict count is inconsistent." });
  }
  if (value.locatorCount !== value.links.filter((link) => link.stableLocator !== null).length) {
    context.addIssue({ code: "custom", path: ["locatorCount"], message: "Locator count is inconsistent." });
  }
});

export const growthEventPhaseSchema = z.enum([
  "cycle_planned", "run_attached", "receipt_recorded", "inquiry_selected", "creator_choice_required",
  "change_set_committed", "cycle_evaluated", "cycle_terminal",
]);
export const growthEventTargetKindSchema = z.enum([
  "document", "resource", "assertion", "relation", "change_set", "inquiry", "closure_evaluation",
]);
export const growthDurableStateSchema = z.enum([
  "planned", "running", "committed", "evaluated", "blocked", "failed", "cancelled", "reconciliation_required",
]);
export const growthContentRefSchema = z.object({
  kind: growthContentRefKindSchema,
  targetId: idSchema,
  targetVersionId: idSchema,
}).strict();

const eventInputShape = {
  goalId: idSchema,
  cycleId: idSchema,
  runId: idSchema.nullable(),
  sequence: z.number().int().min(1).max(1_000_000),
  safeSummary: z.string().trim().min(1).max(1_000),
  phase: growthEventPhaseSchema,
  targetKind: growthEventTargetKindSchema,
  targetId: idSchema,
  targetVersionId: idSchema.nullable(),
  durableState: growthDurableStateSchema,
  contentRef: growthContentRefSchema.nullable(),
};

const refineEvent = (value: {
  durableState: string;
  phase: string;
  targetKind: string;
  targetVersionId: string | null;
  contentRef: z.infer<typeof growthContentRefSchema> | null;
}, context: z.RefinementCtx): void => {
  if (value.durableState === "committed" && value.phase !== "change_set_committed") {
    context.addIssue({ code: "custom", message: "Committed state requires Change Set commit phase." });
  }
  if (value.phase === "change_set_committed" && value.targetKind !== "change_set") {
    context.addIssue({ code: "custom", message: "Change Set commit phase requires Change Set target." });
  }
  const evaluationPhase = value.phase === "cycle_evaluated";
  if (evaluationPhase !== (value.targetKind === "closure_evaluation")) {
    context.addIssue({ code: "custom", message: "Closure evaluation target is event-only and requires its evaluation phase." });
  }
  if (evaluationPhase && (value.durableState !== "evaluated" || value.targetVersionId !== null || value.contentRef !== null)) {
    context.addIssue({ code: "custom", message: "Evaluated Closure event cannot expose a version or content reference." });
  }
  if (!evaluationPhase && value.durableState === "evaluated") {
    context.addIssue({ code: "custom", message: "Evaluated durable state requires the Closure evaluation phase." });
  }
  const inquiryPhase = value.phase === "inquiry_selected" || value.phase === "creator_choice_required";
  if (inquiryPhase !== (value.targetKind === "inquiry")) {
    context.addIssue({ code: "custom", message: "Inquiry event phases require the event-only Inquiry target." });
  }
  if (value.phase === "inquiry_selected" && value.durableState !== "running") {
    context.addIssue({ code: "custom", message: "Selected Inquiry events require a running Cycle." });
  }
  if (value.phase === "creator_choice_required" && value.durableState !== "blocked") {
    context.addIssue({ code: "custom", message: "Creator-choice Inquiry events require a blocked Cycle." });
  }
  if (inquiryPhase && (value.targetVersionId !== null || value.contentRef !== null)) {
    context.addIssue({ code: "custom", message: "Inquiry events cannot expose a target version or content reference." });
  }
};

export const growthEventAppendSchema = z.object(eventInputShape).strict().superRefine(refineEvent);
export const growthEventSchema = z.object({ ...eventInputShape, createdAt: timestampSchema }).strict().superRefine(refineEvent);

const intentProjectionShape = {
  cycleId: idSchema,
  provenance: z.enum(["persisted_v26", "persisted_v24", "legacy_v23_projection"]),
};
export const growthCycleIntentSchema = z.union([
  z.object({
    ...intentProjectionShape,
    kind: z.enum(["expand", "revision"]),
    focusKinds: z.array(growthFocusKindSchema).min(1).max(3),
    resumeFrontier: z.array(growthFocusKindSchema).max(3),
  }).strict().superRefine((value, context) => {
    uniqueValues(value.focusKinds, context, "focusKinds");
    uniqueValues(value.resumeFrontier, context, "resumeFrontier");
  }),
  z.object({
    ...intentProjectionShape,
    provenance: z.literal("persisted_v26"),
    kind: z.literal("closure_evaluation"),
    profileId: idSchema,
    revision: z.number().int().min(1).max(1_000_000),
    checkpointId: idSchema,
  }).strict(),
  z.object({
    ...intentProjectionShape,
    provenance: z.literal("persisted_v26"),
    kind: z.literal("repair"),
    profileId: idSchema,
    revision: z.number().int().min(1).max(1_000_000),
    originalReviewId: idSchema,
    selectedFindingId: idSchema,
    selectedFindingFingerprint: sha256Schema,
  }).strict(),
]);

export const growthInquiryEvidenceLinkSchema = z.object({
  receiptId: idSchema,
  rank: z.number().int().min(1).max(100_000),
}).strict();

const growthInquiryQuestionDetailShape = {
  id: idSchema,
  question: z.string().trim().min(1).max(2_000),
  evidenceState: z.enum(["known", "conflicted", "unknown"]),
  safeSummary: z.string().trim().min(1).max(1_000),
  proposedAction: z.string().trim().min(1).max(2_000),
  provisionalAssumption: z.string().trim().min(1).max(2_000).nullable(),
  requiresCreatorChoice: z.boolean(),
  priority: z.number().finite().min(0).max(1_000_000),
  fingerprint: sha256Schema,
};

const refineInquiryQuestion = (value: {
  evidenceState: string;
  provisionalAssumption: string | null;
  requiresCreatorChoice: boolean;
  evidenceRanks: number[];
}, context: z.RefinementCtx): void => {
  uniqueValues(value.evidenceRanks.map(String), context, "evidenceRanks");
  if (value.evidenceState !== "unknown" && value.evidenceRanks.length === 0) {
    context.addIssue({ code: "custom", path: ["evidenceRanks"], message: "Known or conflicted Inquiry requires pinned evidence." });
  }
  if (value.evidenceState === "unknown" && !value.requiresCreatorChoice && value.provisionalAssumption === null) {
    context.addIssue({ code: "custom", path: ["provisionalAssumption"], message: "A non-blocking unknown Inquiry requires a provisional assumption." });
  }
};

export const growthInquiryQuestionCreateSchema = z.object({
  ...growthInquiryQuestionDetailShape,
  evidenceRanks: z.array(z.number().int().min(1).max(100_000)).max(100),
}).strict().superRefine(refineInquiryQuestion);

export const growthInquiryCloseReasonSchema = z.enum(["invalidated_by_evidence", "duplicate", "superseded"]);

export const growthInquiryPriorTransitionSealSchema = z.discriminatedUnion("phase", [
  z.object({
    inquiryId: idSchema,
    expectedSequence: z.number().int().min(1).max(1_000_000),
    phase: z.literal("promoted"),
    successorInquiryId: idSchema,
  }).strict(),
  z.object({
    inquiryId: idSchema,
    expectedSequence: z.number().int().min(1).max(1_000_000),
    phase: z.literal("answered"),
  }).strict(),
  z.object({
    inquiryId: idSchema,
    expectedSequence: z.number().int().min(1).max(1_000_000),
    phase: z.literal("closed"),
    reason: growthInquiryCloseReasonSchema,
  }).strict(),
]);

const refineInquiryBatchDecision = (value: {
  selectedInquiryId: string | null;
  creatorChoiceRequiredInquiryId: string | null;
  questions: Array<{ id: string; priority: number; requiresCreatorChoice: boolean }>;
}, context: z.RefinementCtx): void => {
  const selected = value.selectedInquiryId === null
    ? undefined
    : value.questions.find((question) => question.id === value.selectedInquiryId);
  const creatorChoice = value.creatorChoiceRequiredInquiryId === null
    ? undefined
    : value.questions.find((question) => question.id === value.creatorChoiceRequiredInquiryId);
  if ((value.selectedInquiryId === null) === (value.creatorChoiceRequiredInquiryId === null)) {
    context.addIssue({ code: "custom", message: "Exactly one selected or creator-choice Inquiry is required." });
  }
  if (value.selectedInquiryId !== null && !selected) {
    context.addIssue({ code: "custom", path: ["selectedInquiryId"], message: "Selected Inquiry does not exist." });
  }
  if (value.creatorChoiceRequiredInquiryId !== null && !creatorChoice) {
    context.addIssue({ code: "custom", path: ["creatorChoiceRequiredInquiryId"], message: "Creator-choice Inquiry does not exist." });
  }
  const creatorChoiceQuestions = value.questions.filter((question) => question.requiresCreatorChoice);
  if (value.creatorChoiceRequiredInquiryId === null && creatorChoiceQuestions.length !== 0) {
    context.addIssue({ code: "custom", path: ["questions"], message: "A normal Batch cannot contain creator-choice questions." });
  }
  if (value.creatorChoiceRequiredInquiryId !== null
    && (creatorChoiceQuestions.length !== 1 || creatorChoiceQuestions[0]?.id !== value.creatorChoiceRequiredInquiryId)) {
    context.addIssue({ code: "custom", path: ["questions"], message: "A blocked Batch requires one exact creator-choice question." });
  }
  const frontier = selected ?? creatorChoice;
  const highestPriority = Math.max(...value.questions.map((question) => question.priority));
  if (value.questions.filter((question) => question.priority === highestPriority).length !== 1
    || (frontier && frontier.priority !== highestPriority)) {
    context.addIssue({ code: "custom", message: "The chosen Inquiry must have the unique highest priority." });
  }
};

export const growthInquiryBatchSealSchema = z.object({
  id: idSchema,
  cycleId: idSchema,
  idempotencyKey: idSchema,
  selectedInquiryId: idSchema.nullable(),
  creatorChoiceRequiredInquiryId: idSchema.nullable(),
  questions: z.array(growthInquiryQuestionCreateSchema).min(3).max(7),
  priorTransitions: z.array(growthInquiryPriorTransitionSealSchema).max(100).optional(),
}).strict().superRefine((value, context) => {
  uniqueValues(value.questions.map((question) => question.id), context, "questions");
  uniqueValues(value.questions.map((question) => question.fingerprint), context, "questions");
  uniqueValues((value.priorTransitions ?? []).map((transition) => transition.inquiryId), context, "priorTransitions");
  const inquiryIds = new Set(value.questions.map((question) => question.id));
  for (const transition of value.priorTransitions ?? []) {
    if (transition.phase === "promoted" && !inquiryIds.has(transition.successorInquiryId)) {
      context.addIssue({ code: "custom", path: ["priorTransitions"], message: "Promoted Inquiry successor must belong to the sealed Batch." });
    }
  }
  refineInquiryBatchDecision(value, context);
});

export const growthLegacyInquirySchema = z.object({
  id: idSchema,
  question: z.string().trim().min(1).max(2_000),
  evidenceState: z.enum(["known", "conflicted", "unknown"]),
  safeSummary: z.string().trim().min(1).max(1_000),
  priority: z.number().finite().min(0).max(1_000_000),
  fingerprint: sha256Schema,
  evidenceLinks: z.array(growthInquiryEvidenceLinkSchema).max(100),
  selected: z.boolean(),
}).strict();

export const growthInquirySchema = z.object({
  ...growthInquiryQuestionDetailShape,
  evidenceLinks: z.array(growthInquiryEvidenceLinkSchema).max(100),
  initialState: z.enum(["backlog", "selected", "creator_choice_required"]),
}).strict().superRefine((value, context) => {
  refineInquiryQuestion({ ...value, evidenceRanks: value.evidenceLinks.map((link) => link.rank) }, context);
});

const growthInquiryBatchCommonShape = {
  id: idSchema,
  cycleId: idSchema,
  receiptId: idSchema,
  checkpointId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  idempotencyKey: idSchema,
  payloadHash: sha256Schema,
  status: z.literal("sealed"),
  sealedAt: timestampSchema,
};

const growthLegacyInquiryBatchSchema = z.object({
  ...growthInquiryBatchCommonShape,
  contractVersion: z.literal("legacy_v24"),
  creatorChoiceBlocked: z.boolean(),
  selectedInquiryId: idSchema.nullable(),
  questions: z.array(growthLegacyInquirySchema).min(3).max(7),
}).strict().superRefine((value, context) => {
  const selected = value.questions.filter((question) => question.selected);
  if (value.creatorChoiceBlocked ? selected.length !== 0 : selected.length !== 1) {
    context.addIssue({ code: "custom", message: "Legacy Inquiry selection is inconsistent." });
  }
  if (value.creatorChoiceBlocked ? value.selectedInquiryId !== null : selected[0]?.id !== value.selectedInquiryId) {
    context.addIssue({ code: "custom", message: "Legacy Inquiry selected identity is inconsistent." });
  }
});

const growthV25InquiryBatchSchema = z.object({
  ...growthInquiryBatchCommonShape,
  contractVersion: z.literal("v25"),
  selectedInquiryId: idSchema.nullable(),
  creatorChoiceRequiredInquiryId: idSchema.nullable(),
  questions: z.array(growthInquirySchema).min(3).max(7),
}).strict().superRefine((value, context) => {
  refineInquiryBatchDecision(value, context);
  value.questions.forEach((question) => {
    const expected = question.id === value.selectedInquiryId
      ? "selected"
      : question.id === value.creatorChoiceRequiredInquiryId
        ? "creator_choice_required"
        : "backlog";
    if (question.initialState !== expected) {
      context.addIssue({ code: "custom", message: "Persisted Inquiry initial lifecycle is inconsistent." });
    }
  });
});

export const growthInquiryBatchSchema = z.discriminatedUnion("contractVersion", [
  growthLegacyInquiryBatchSchema,
  growthV25InquiryBatchSchema,
]);

export const growthInquiryLifecyclePhaseSchema = z.enum([
  "backlog", "selected", "creator_choice_required", "creator_answered", "promoted", "answered", "closed",
]);

const inquiryLifecycleAppendShape = {
  inquiryId: idSchema,
  idempotencyKey: idSchema,
  expectedSequence: z.number().int().min(1).max(1_000_000),
  sourceCycleId: idSchema,
};
export const growthInquiryLifecycleAppendSchema = z.discriminatedUnion("phase", [
  z.object({ ...inquiryLifecycleAppendShape, phase: z.literal("promoted"), successorInquiryId: idSchema }).strict(),
  z.object({ ...inquiryLifecycleAppendShape, phase: z.literal("answered") }).strict(),
  z.object({ ...inquiryLifecycleAppendShape, phase: z.literal("closed"), reason: growthInquiryCloseReasonSchema }).strict(),
]);

export const growthInquiryLifecycleSchema = z.object({
  inquiryId: idSchema,
  sequence: z.number().int().min(1).max(1_000_000),
  phase: growthInquiryLifecyclePhaseSchema,
  idempotencyKey: idSchema,
  payloadHash: sha256Schema,
  sourceCycleId: idSchema,
  sourceReceiptId: idSchema,
  sourceCheckpointId: idSchema,
  sourceRuleRevision: z.number().int().min(1).max(1_000_000),
  successorInquiryId: idSchema.nullable(),
  answerRuleRevision: z.number().int().min(1).max(1_000_000).nullable(),
  closeReason: growthInquiryCloseReasonSchema.nullable(),
  createdAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.phase === "promoted") !== (value.successorInquiryId !== null)) {
    context.addIssue({ code: "custom", message: "Only promoted Inquiry lifecycle may link a successor." });
  }
  if ((value.phase === "creator_answered") !== (value.answerRuleRevision !== null)) {
    context.addIssue({ code: "custom", message: "Only creator_answered lifecycle may link the answer Rule Revision." });
  }
  if ((value.phase === "closed") !== (value.closeReason !== null)) {
    context.addIssue({ code: "custom", message: "Only closed Inquiry lifecycle may contain a close reason." });
  }
});

export const growthInquiryCreatorAnswerCreateSchema = z.object({
  inquiryId: idSchema,
  idempotencyKey: idSchema,
  expectedRuleRevision: z.number().int().min(1).max(1_000_000),
  expectedLifecycleSequence: z.number().int().min(1).max(1_000_000),
  answerText: z.string().trim().min(1).max(12_000),
  sourceMessageId: idSchema.nullable(),
}).strict();

export const growthInquiryCreatorAnswerSchema = z.object({
  inquiryId: idSchema,
  goalId: idSchema,
  ruleRevision: z.number().int().min(2).max(1_000_000),
  idempotencyKey: idSchema,
  payloadHash: sha256Schema,
  answerText: z.string().trim().min(1).max(12_000),
  sourceMessageId: idSchema.nullable(),
  checkpointId: idSchema,
  receiptId: idSchema,
  createdAt: timestampSchema,
}).strict();

export const growthClosureProfileKindSchema = z.enum(["world_birth", "oc_saga", "story_universe", "mixed_birth"]);
export const growthClosureComponentProfileSchema = z.enum(["world_birth", "oc_saga", "story_universe"]);
export const growthClosureFacetCreateSchema = z.object({
  id: idSchema,
  kind: z.enum(["content", "visual"]),
  required: z.boolean(),
}).strict();

export const growthClosureProfileCreateSchema = z.object({
  id: idSchema,
  idempotencyKey: idSchema,
  goalId: idSchema,
  profileKind: growthClosureProfileKindSchema,
  subjectResourceId: idSchema.nullable(),
  componentProfiles: z.array(growthClosureComponentProfileSchema).max(3),
  focusOcResourceId: idSchema.nullable(),
  contractGeneration: z.literal("v26"),
  checkpointId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  facets: z.array(growthClosureFacetCreateSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  uniqueValues(value.facets.map((facet) => facet.id), context, "facets");
  uniqueValues(value.componentProfiles, context, "componentProfiles");
  if (value.profileKind === "oc_saga" && value.subjectResourceId === null) {
    context.addIssue({ code: "custom", path: ["subjectResourceId"], message: "OC saga closure requires an OC subject." });
  }
  if (value.profileKind !== "oc_saga" && value.subjectResourceId !== null) {
    context.addIssue({ code: "custom", path: ["subjectResourceId"], message: "Only OC saga closure may bind a subject resource." });
  }
  if (value.profileKind === "mixed_birth") {
    if (value.componentProfiles.length === 0) context.addIssue({ code: "custom", path: ["componentProfiles"], message: "Mixed closure requires explicit component profiles." });
    const needsFocusOc = value.componentProfiles.includes("oc_saga");
    if (needsFocusOc !== (value.focusOcResourceId !== null)) {
      context.addIssue({ code: "custom", path: ["focusOcResourceId"], message: "Mixed OC saga component requires exactly one focus OC." });
    }
  } else if (value.componentProfiles.length > 0 || value.focusOcResourceId !== null) {
    context.addIssue({ code: "custom", path: ["componentProfiles"], message: "Only mixed closure may declare component profiles or a focus OC." });
  }
});

export const growthClosureRevisionAppendSchema = z.object({
  profileId: idSchema,
  expectedRevision: z.number().int().min(1).max(1_000_000),
  idempotencyKey: idSchema,
  checkpointId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  componentProfiles: z.array(growthClosureComponentProfileSchema).max(3),
  focusOcResourceId: idSchema.nullable(),
  contractGeneration: z.literal("v26"),
  facets: z.array(growthClosureFacetCreateSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  uniqueValues(value.facets.map((facet) => facet.id), context, "facets");
  uniqueValues(value.componentProfiles, context, "componentProfiles");
});

const growthClosureProfileCommonShape = {
  id: idSchema,
  goalId: idSchema,
  profileKind: growthClosureProfileKindSchema,
  subjectResourceId: idSchema.nullable(),
  currentRevision: z.number().int().min(1).max(1_000_000),
  currentEpoch: z.number().int().min(1).max(1_000_000),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};
const growthClosureLegacyProfileSchema = z.object({
    ...growthClosureProfileCommonShape,
    contractGeneration: z.literal("legacy_pre_v26"),
    componentProfiles: z.null(),
    focusOcResourceId: z.null(),
  }).strict();
const growthClosureV26ProfileSchema = z.object({
    ...growthClosureProfileCommonShape,
    contractGeneration: z.literal("v26"),
    componentProfiles: z.array(growthClosureComponentProfileSchema).max(3),
    focusOcResourceId: idSchema.nullable(),
  }).strict().superRefine((value, context) => {
    uniqueValues(value.componentProfiles, context, "componentProfiles");
    if (value.profileKind === "oc_saga") {
      if (value.subjectResourceId === null) context.addIssue({ code: "custom", path: ["subjectResourceId"], message: "OC saga closure requires a subject." });
      if (value.componentProfiles.length > 0 || value.focusOcResourceId !== null) context.addIssue({ code: "custom", path: ["componentProfiles"], message: "Non-mixed closure cannot declare components." });
      return;
    }
    if (value.subjectResourceId !== null) context.addIssue({ code: "custom", path: ["subjectResourceId"], message: "Only OC saga closure may bind a subject." });
    if (value.profileKind === "mixed_birth") {
      if (value.componentProfiles.length === 0) context.addIssue({ code: "custom", path: ["componentProfiles"], message: "Mixed closure requires explicit components." });
      if (value.componentProfiles.includes("oc_saga") !== (value.focusOcResourceId !== null)) {
        context.addIssue({ code: "custom", path: ["focusOcResourceId"], message: "Mixed OC saga component requires a focus OC." });
      }
    } else if (value.componentProfiles.length > 0 || value.focusOcResourceId !== null) {
      context.addIssue({ code: "custom", path: ["componentProfiles"], message: "Non-mixed closure cannot declare components." });
    }
  });
export const growthClosureProfileSchema = z.union([
  growthClosureLegacyProfileSchema,
  growthClosureV26ProfileSchema,
]);

const growthClosureRevisionCommonShape = {
  profileId: idSchema,
  revision: z.number().int().min(1).max(1_000_000),
  epoch: z.number().int().min(1).max(1_000_000),
  checkpointId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  facets: z.array(growthClosureFacetCreateSchema).min(1).max(100),
  createdAt: timestampSchema,
};
export const growthClosureRevisionSchema = z.union([
  z.object({
    ...growthClosureRevisionCommonShape,
    contractGeneration: z.literal("legacy_pre_v26"),
    componentProfiles: z.null(),
    focusOcResourceId: z.null(),
  }).strict(),
  z.object({
    ...growthClosureRevisionCommonShape,
    contractGeneration: z.literal("v26"),
    componentProfiles: z.array(growthClosureComponentProfileSchema).max(3),
    focusOcResourceId: idSchema.nullable(),
  }).strict(),
]);

const closureAssessmentCommonShape = {
  id: idSchema,
  profileId: idSchema,
  revision: z.number().int().min(1).max(1_000_000),
  cycleId: idSchema,
  checkpointId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  receiptId: idSchema,
  agentInvocationId: idSchema,
  outputSha256: sha256Schema,
  idempotencyKey: idSchema,
};
export const growthClosureAssessmentAppendSchema = z.discriminatedUnion("role", [
  z.object({ ...closureAssessmentCommonShape, role: z.literal("steward"), decision: z.enum(["continue_growing", "ready_for_checker"]) }).strict(),
  z.object({ ...closureAssessmentCommonShape, role: z.literal("checker"), decision: z.enum(["accepted", "repairs_required", "blocked"]) }).strict(),
]);
export const growthClosureAssessmentSchema = z.discriminatedUnion("role", [
  z.object({ ...closureAssessmentCommonShape, role: z.literal("steward"), decision: z.enum(["continue_growing", "ready_for_checker"]), payloadHash: sha256Schema, createdAt: timestampSchema }).strict(),
  z.object({ ...closureAssessmentCommonShape, role: z.literal("checker"), decision: z.enum(["accepted", "repairs_required", "blocked"]), payloadHash: sha256Schema, createdAt: timestampSchema }).strict(),
]);

export const growthClosureFacetResultSchema = z.object({
  facetId: idSchema,
  state: z.enum(["satisfied", "missing", "conflicted", "blocked"]),
  coverage: z.enum(["complete", "partial", "unknown"]),
  safeSummary: z.string().trim().min(1).max(1_000),
  evidence: z.array(growthInquiryEvidenceLinkSchema).max(100),
}).strict().superRefine((value, context) => {
  uniqueValues(value.evidence.map((link) => `${link.receiptId}:${link.rank}`), context, "evidence");
  if (value.state === "satisfied" && value.evidence.length === 0) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Satisfied Closure facet requires pinned evidence." });
  }
});

export const growthClosureFindingSeveritySchema = z.enum(["minor", "major", "blocking"]);
export const growthClosureFindingCategorySchema = z.enum([
  "world_consistency", "story_consistency", "character_consistency", "causality", "continuity",
  "evidence_gap", "scope_violation", "creator_choice_required",
]);
export const growthClosureAdverseFindingSchema = z.object({
  id: idSchema,
  fingerprint: sha256Schema,
  severity: growthClosureFindingSeveritySchema,
  category: growthClosureFindingCategorySchema,
  targetEvidence: z.array(growthInquiryEvidenceLinkSchema).min(1).max(100),
  safeSummary: z.string().trim().min(1).max(1_000),
  repairObjective: z.string().trim().min(1).max(2_000),
}).strict().superRefine((value, context) => {
  uniqueValues(value.targetEvidence.map((link) => `${link.receiptId}:${link.rank}`), context, "targetEvidence");
});

export const growthClosureStewardSubmissionSchema = z.object({
  ...closureAssessmentCommonShape,
  role: z.literal("steward"),
  decision: z.enum(["continue_growing", "ready_for_checker"]),
  facetResults: z.array(growthClosureFacetResultSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  uniqueValues(value.facetResults.map((result) => result.facetId), context, "facetResults");
});

export const growthClosureCheckerSubmissionSchema = z.object({
  ...closureAssessmentCommonShape,
  role: z.literal("checker"),
  decision: z.enum(["accepted", "repairs_required", "blocked"]),
  adverseFindings: z.array(growthClosureAdverseFindingSchema).max(100),
}).strict().superRefine((value, context) => {
  uniqueValues(value.adverseFindings.map((finding) => finding.id), context, "adverseFindings");
  uniqueValues(value.adverseFindings.map((finding) => finding.fingerprint), context, "adverseFindings");
  if (value.decision === "accepted" && value.adverseFindings.length > 0) {
    context.addIssue({ code: "custom", path: ["adverseFindings"], message: "Accepted Checker submission cannot contain adverse findings." });
  }
  if (value.decision === "repairs_required" && !value.adverseFindings.some((finding) => ["major", "blocking"].includes(finding.severity))) {
    context.addIssue({ code: "custom", path: ["adverseFindings"], message: "Repairs require a major or blocking finding." });
  }
  if (value.decision === "blocked" && !value.adverseFindings.some((finding) => finding.severity === "blocking")) {
    context.addIssue({ code: "custom", path: ["adverseFindings"], message: "Blocked Checker submission requires a blocking finding." });
  }
});

export const growthClosureReviewV4SealSchema = z.object({
  id: idSchema,
  profileId: idSchema,
  revision: z.number().int().min(1).max(1_000_000),
  stewardAssessmentId: idSchema,
  checkerAssessmentId: idSchema,
  idempotencyKey: idSchema,
  facetResults: z.array(growthClosureFacetResultSchema).min(1).max(100),
  adverseFindings: z.array(growthClosureAdverseFindingSchema).max(100),
}).strict().superRefine((value, context) => {
  uniqueValues(value.facetResults.map((result) => result.facetId), context, "facetResults");
  uniqueValues(value.adverseFindings.map((finding) => finding.id), context, "adverseFindings");
});

const growthClosureEvaluationOutcomeCommonShape = {
  id: idSchema,
  cycleId: idSchema,
  profileId: idSchema,
  revision: z.number().int().min(1).max(1_000_000),
  receiptId: idSchema,
  stewardAssessmentId: idSchema,
  idempotencyKey: idSchema,
};
export const growthClosureEvaluationOutcomeSealSchema = z.discriminatedUnion("decision", [
  z.object({
    ...growthClosureEvaluationOutcomeCommonShape,
    decision: z.literal("continue_growing"),
    checkerAssessmentId: z.null(),
    reviewId: z.null(),
  }).strict(),
  z.object({
    ...growthClosureEvaluationOutcomeCommonShape,
    decision: z.enum(["accepted", "repairs_required", "blocked"]),
    checkerAssessmentId: idSchema,
    reviewId: idSchema,
  }).strict(),
]);
export const growthClosureEvaluationOutcomeSchema = z.union([
  growthClosureEvaluationOutcomeSealSchema.options[0].extend({ payloadHash: sha256Schema, createdAt: timestampSchema }).strict(),
  growthClosureEvaluationOutcomeSealSchema.options[1].extend({ payloadHash: sha256Schema, createdAt: timestampSchema }).strict(),
]);

export const growthClosureRepairLineageCreateSchema = z.object({
  id: idSchema,
  profileId: idSchema,
  revision: z.number().int().min(1).max(1_000_000),
  originalReviewId: idSchema,
  selectedFindingId: idSchema,
  selectedFindingFingerprint: sha256Schema,
  repairCycleId: idSchema,
  backlogFindingIds: z.array(idSchema).max(99),
  idempotencyKey: idSchema,
}).strict().superRefine((value, context) => {
  uniqueValues(value.backlogFindingIds, context, "backlogFindingIds");
  if (value.backlogFindingIds.includes(value.selectedFindingId)) {
    context.addIssue({ code: "custom", path: ["backlogFindingIds"], message: "Selected repair finding cannot remain in backlog." });
  }
});
export const growthClosureRepairLineageSchema = growthClosureRepairLineageCreateSchema.extend({
  resolutionState: z.enum(["planned", "committed", "resolved", "no_progress", "stalled"]),
  payloadHash: sha256Schema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const growthClosureReviewFindingSchema = z.object({
  facetId: idSchema,
  state: z.enum(["satisfied", "missing", "conflicted", "blocked"]),
  safeSummary: z.string().trim().min(1).max(1_000),
  evidence: growthInquiryEvidenceLinkSchema,
}).strict();
export const growthClosureReviewSealSchema = z.object({
  id: idSchema,
  profileId: idSchema,
  revision: z.number().int().min(1).max(1_000_000),
  stewardAssessmentId: idSchema,
  checkerAssessmentId: idSchema,
  idempotencyKey: idSchema,
  findings: z.array(growthClosureReviewFindingSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  uniqueValues(value.findings.map((finding) => `${finding.facetId}:${finding.evidence.receiptId}:${finding.evidence.rank}`), context, "findings");
});
export const growthClosureReviewSchema = growthClosureReviewSealSchema.extend({
  checkerDecision: z.enum(["accepted", "repairs_required", "blocked"]),
  payloadHash: sha256Schema,
  createdAt: timestampSchema,
}).strict();

export const growthClosureStateSchema = z.object({
  profileId: idSchema,
  goalId: idSchema,
  profileKind: growthClosureProfileKindSchema,
  subjectResourceId: idSchema.nullable(),
  revision: z.number().int().min(1).max(1_000_000),
  epoch: z.number().int().min(1).max(1_000_000),
  contentState: z.enum(["growing", "closed", "blocked"]),
  visualState: z.enum(["planning", "generating", "ready", "blocked"]),
  satisfiedFacetIds: z.array(idSchema).max(100),
  missingFacetIds: z.array(idSchema).max(100),
  lastProgressCycleSequence: z.number().int().min(0).max(1_000_000),
}).strict();

export const growthIllustrationAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resource"), resourceId: idSchema, resourceVersionId: idSchema }).strict(),
  z.object({
    kind: z.literal("stable_text_span"), documentId: idSchema, documentVersionId: idSchema,
    startCodePoint: z.number().int().min(0).max(100_000_000), endCodePoint: z.number().int().min(1).max(100_000_000),
    textSha256: sha256Schema,
  }).strict().superRefine((value, context) => {
    if (value.endCodePoint <= value.startCodePoint) context.addIssue({ code: "custom", path: ["endCodePoint"], message: "Text span must be non-empty." });
  }),
  z.object({ kind: z.literal("working_text_snapshot"), sourceSnapshotId: idSchema, textSha256: sha256Schema }).strict(),
  z.object({ kind: z.literal("conversation_text_snapshot"), sourceSnapshotId: idSchema, textSha256: sha256Schema }).strict(),
]);

export const growthIllustrationTextSnapshotCreateSchema = z.object({
  id: idSchema,
  kind: z.enum(["working_text_snapshot", "conversation_text_snapshot"]),
  text: z.string().min(1).max(1_000_000),
  textSha256: sha256Schema,
}).strict();

export const growthIllustrationSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resource"), resourceId: idSchema, resourceVersionId: idSchema }).strict(),
  z.object({ kind: z.literal("document"), documentId: idSchema, documentVersionId: idSchema, contentSha256: sha256Schema }).strict(),
]);

export const growthIllustrationItemCreateSchema = z.object({
  id: idSchema,
  purpose: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(240),
  variantKey: idSchema,
  compiledPromptSha256: sha256Schema,
  requiredForVisualClosure: z.boolean(),
  anchor: growthIllustrationAnchorSchema,
  sources: z.array(growthIllustrationSourceSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const identities = value.sources.map((source) => source.kind === "resource"
    ? `resource:${source.resourceId}:${source.resourceVersionId}`
    : `document:${source.documentId}:${source.documentVersionId}`);
  uniqueValues(identities, context, "sources");
});

export const growthIllustrationRequestCreateSchema = z.object({
  id: idSchema,
  goalId: idSchema,
  cycleId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  coverageMode: z.enum(["default", "all_visible_nodes", "custom"]),
  closureProfileId: idSchema.nullable(),
  closureRevision: z.number().int().min(1).max(1_000_000).nullable(),
  idempotencyKey: idSchema,
}).strict().superRefine((value, context) => {
  if ((value.closureProfileId === null) !== (value.closureRevision === null)) {
    context.addIssue({ code: "custom", message: "Closure profile and revision must be both present or both absent." });
  }
});

export const growthIllustrationBatchSealSchema = z.object({
  id: idSchema,
  requestId: idSchema,
  sequence: z.number().int().min(1).max(1_000_000),
  cursor: z.string().trim().min(1).max(2_000).nullable(),
  nextCursor: z.string().trim().min(1).max(2_000).nullable(),
  idempotencyKey: idSchema,
  snapshots: z.array(growthIllustrationTextSnapshotCreateSchema).max(20),
  items: z.array(growthIllustrationItemCreateSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  uniqueValues(value.snapshots.map((snapshot) => snapshot.id), context, "snapshots");
  uniqueValues(value.items.map((item) => item.id), context, "items");
});

export const growthIllustrationStatusSchema = z.enum([
  "planned", "queued", "running", "ready", "failed", "cancelled", "stale", "reconciliation_required",
]);
export const growthIllustrationItemSchema = growthIllustrationItemCreateSchema.extend({
  requestId: idSchema,
  batchId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  anchorHash: sha256Schema,
  sourceVersionSetHash: sha256Schema,
  status: growthIllustrationStatusSchema,
  imageJobId: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export const growthIllustrationRequestSchema = z.object({
  id: idSchema,
  goalId: idSchema,
  cycleId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
  coverageMode: z.enum(["default", "all_visible_nodes", "custom"]),
  closureProfileId: idSchema.nullable(),
  closureRevision: z.number().int().min(1).max(1_000_000).nullable(),
  status: z.enum(["planned", "running", "completed", "failed", "cancelled", "stale", "reconciliation_required"]),
  itemCount: z.number().int().min(0),
  readyCount: z.number().int().min(0),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.closureProfileId === null) !== (value.closureRevision === null)) {
    context.addIssue({ code: "custom", message: "Closure profile and revision must be both present or both absent." });
  }
});
export const growthIllustrationBatchSchema = z.object({
  id: idSchema,
  requestId: idSchema,
  sequence: z.number().int().min(1).max(1_000_000),
  cursor: z.string().nullable(),
  nextCursor: z.string().nullable(),
  idempotencyKey: idSchema,
  payloadHash: sha256Schema,
  itemCount: z.number().int().min(1).max(20),
  status: z.enum(["planned", "running", "completed", "failed", "cancelled", "stale", "reconciliation_required"]),
  items: z.array(growthIllustrationItemSchema).min(1).max(20),
  sealedAt: timestampSchema,
}).strict();
export const growthIllustrationImageJobBindSchema = z.object({ itemId: idSchema, imageJobId: idSchema }).strict();
export const growthIllustrationMarkStaleSchema = z.object({ itemId: idSchema, expectedAnchorHash: sha256Schema }).strict();

export type GrowthGoal = z.infer<typeof growthGoalSchema>;
export type GrowthGoalCreate = z.infer<typeof growthGoalCreateSchema>;
export type GrowthRuleRevision = z.infer<typeof growthRuleRevisionSchema>;
export type GrowthCycle = z.infer<typeof growthCycleSchema>;
export type GrowthCycleIntent = z.infer<typeof growthCycleIntentSchema>;
export type GrowthContentCycleIntent = Extract<GrowthCycleIntent, { kind: "expand" | "revision" }>;
export type GrowthRetrievalReceiptCreate = z.infer<typeof growthRetrievalReceiptCreateSchema>;
export type GrowthRetrievalReceipt = z.infer<typeof growthRetrievalReceiptSchema>;
export type GrowthRetrievalReceiptLink = z.infer<typeof growthRetrievalReceiptLinkSchema>;
export type GrowthEventAppend = z.infer<typeof growthEventAppendSchema>;
export type GrowthEvent = z.infer<typeof growthEventSchema>;
export type GrowthInquiryBatch = z.infer<typeof growthInquiryBatchSchema>;
export type GrowthInquiryLifecycle = z.infer<typeof growthInquiryLifecycleSchema>;
export type GrowthInquiryCreatorAnswer = z.infer<typeof growthInquiryCreatorAnswerSchema>;
export type GrowthClosureProfile = z.infer<typeof growthClosureProfileSchema>;
export type GrowthClosureRevision = z.infer<typeof growthClosureRevisionSchema>;
export type GrowthClosureAssessment = z.infer<typeof growthClosureAssessmentSchema>;
export type GrowthClosureStewardSubmission = z.infer<typeof growthClosureStewardSubmissionSchema>;
export type GrowthClosureCheckerSubmission = z.infer<typeof growthClosureCheckerSubmissionSchema>;
export type GrowthClosureFacetResult = z.infer<typeof growthClosureFacetResultSchema>;
export type GrowthClosureAdverseFinding = z.infer<typeof growthClosureAdverseFindingSchema>;
export type GrowthClosureEvaluationOutcome = z.infer<typeof growthClosureEvaluationOutcomeSchema>;
export type GrowthClosureRepairLineage = z.infer<typeof growthClosureRepairLineageSchema>;
export type GrowthClosureReview = z.infer<typeof growthClosureReviewSchema>;
export type GrowthClosureState = z.infer<typeof growthClosureStateSchema>;
export type GrowthIllustrationRequest = z.infer<typeof growthIllustrationRequestSchema>;
export type GrowthIllustrationBatch = z.infer<typeof growthIllustrationBatchSchema>;
export type GrowthIllustrationItem = z.infer<typeof growthIllustrationItemSchema>;
