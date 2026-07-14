import { z } from "zod";

const idSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });

export const growthContractVersion = "1.0.0" as const;
export const growthCapabilityVersion = "hackathon-growth-persistence-v1" as const;

export const growthGoalStatusSchema = z.enum([
  "active", "completed", "blocked", "cancelled", "reconciliation_required",
]);
export const growthCycleStatusSchema = z.enum([
  "planned", "running", "committed", "blocked", "failed", "cancelled", "reconciliation_required",
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
  const terminal = ["committed", "blocked", "failed", "cancelled", "reconciliation_required"].includes(value.status);
  if (terminal !== (value.terminalAt !== null)) context.addIssue({ code: "custom", message: "Terminal timestamp does not match cycle status." });
  if (value.status === "committed" && (!value.runId || !value.receiptId || !value.changeSetId || !value.outputCheckpointId || value.failureCode)) {
    context.addIssue({ code: "custom", message: "Committed cycle requires run, receipt, Change Set and output checkpoint only." });
  }
  if (value.status !== "committed" && (value.changeSetId !== null || value.outputCheckpointId !== null)) {
    context.addIssue({ code: "custom", message: "Only committed cycles may expose Change Set output state." });
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

export const growthCycleBeginSchema = z.object({
  id: idSchema, goalId: idSchema, idempotencyKey: idSchema, inputCheckpointId: idSchema,
  ruleRevision: z.number().int().min(1).max(1_000_000),
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
export const growthTargetKindSchema = z.enum(["document", "resource", "assertion", "relation", "image", "change_set"]);
export const growthContentRefKindSchema = z.enum(["document", "resource", "assertion", "relation", "change_set"]);

export const growthRetrievalReceiptLinkSchema = z.object({
  rank: z.number().int().min(1).max(100_000),
  targetKind: growthTargetKindSchema,
  targetId: idSchema,
  targetVersionId: idSchema.nullable(),
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

const refineReceiptInput = (value: { effectiveScopeResourceIds: string[]; aliases: string[]; coverage: z.infer<typeof growthCoverageSchema>; truncated: boolean; links: z.infer<typeof growthRetrievalReceiptLinkSchema>[] }, context: z.RefinementCtx): void => {
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
  "cycle_planned", "run_attached", "receipt_recorded", "change_set_committed", "cycle_terminal",
]);
export const growthDurableStateSchema = z.enum([
  "planned", "running", "committed", "blocked", "failed", "cancelled", "reconciliation_required",
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
  targetKind: growthTargetKindSchema,
  targetId: idSchema,
  targetVersionId: idSchema.nullable(),
  durableState: growthDurableStateSchema,
  contentRef: growthContentRefSchema.nullable(),
};

const refineEvent = (value: { durableState: string; phase: string; targetKind: string }, context: z.RefinementCtx): void => {
  if (value.durableState === "committed" && value.phase !== "change_set_committed") {
    context.addIssue({ code: "custom", message: "Committed state requires Change Set commit phase." });
  }
  if (value.phase === "change_set_committed" && value.targetKind !== "change_set") {
    context.addIssue({ code: "custom", message: "Change Set commit phase requires Change Set target." });
  }
};

export const growthEventAppendSchema = z.object(eventInputShape).strict().superRefine(refineEvent);
export const growthEventSchema = z.object({ ...eventInputShape, createdAt: timestampSchema }).strict().superRefine(refineEvent);

export type GrowthGoal = z.infer<typeof growthGoalSchema>;
export type GrowthGoalCreate = z.infer<typeof growthGoalCreateSchema>;
export type GrowthRuleRevision = z.infer<typeof growthRuleRevisionSchema>;
export type GrowthCycle = z.infer<typeof growthCycleSchema>;
export type GrowthRetrievalReceiptCreate = z.infer<typeof growthRetrievalReceiptCreateSchema>;
export type GrowthRetrievalReceipt = z.infer<typeof growthRetrievalReceiptSchema>;
export type GrowthRetrievalReceiptLink = z.infer<typeof growthRetrievalReceiptLinkSchema>;
export type GrowthEventAppend = z.infer<typeof growthEventAppendSchema>;
export type GrowthEvent = z.infer<typeof growthEventSchema>;
