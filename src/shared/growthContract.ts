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

export const growthSeedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(12_000) }).strict(),
  z.object({ kind: z.literal("source_document"), sourceDocumentId: idSchema, sourceVersionId: idSchema }).strict(),
  z.object({ kind: z.literal("resource"), resourceId: idSchema, resourceVersionId: idSchema.nullable() }).strict(),
]);

const uniqueIds = (values: string[], context: z.RefinementCtx, path: string): void => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path: [path], message: "IDs must be unique." });
};

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
}).strict().superRefine((value, context) => uniqueIds(value.authorizedScopeResourceIds, context, "authorizedScopeResourceIds"));

export const growthGoalCreateSchema = z.object({
  id: idSchema,
  idempotencyKey: idSchema,
  branchId: idSchema,
  seed: growthSeedSchema,
  authorizedScopeResourceIds: z.array(idSchema).min(1).max(100),
  initialRuleText: z.string().trim().min(1).max(12_000),
  sourceMessageId: idSchema.nullable(),
}).strict().superRefine((value, context) => uniqueIds(value.authorizedScopeResourceIds, context, "authorizedScopeResourceIds"));

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
  const terminal = value.status === "committed" || value.status === "blocked" || value.status === "failed"
    || value.status === "cancelled" || value.status === "reconciliation_required";
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
  id: idSchema,
  goalId: idSchema,
  idempotencyKey: idSchema,
  inputCheckpointId: idSchema,
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
  uniqueIds(value.reasonCodes, context, "reasonCodes");
  if ((value.stableLocator === null) !== (value.stableVersionId === null)) {
    context.addIssue({ code: "custom", message: "Stable locator and version must be present together." });
  }
});

const growthTimeFilterSchema = z.object({
  from: timestampSchema.nullable(),
  to: timestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.from && value.to && value.from > value.to) context.addIssue({ code: "custom", message: "Time range is inverted." });
});

export const growthCoverageSchema = z.object({
  state: z.enum(["complete", "partial", "unknown"]),
  searchedScopeCount: z.number().int().min(0).max(100),
  omittedCount: z.number().int().min(0).max(1_000_000),
}).strict();

export const growthRetrievalReceiptSchema = z.object({
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
  queryHash: sha256Schema,
  resultHash: sha256Schema,
  hitCount: z.number().int().min(0).max(100_000),
  conflictCount: z.number().int().min(0).max(100_000),
  locatorCount: z.number().int().min(0).max(100_000),
  coverage: growthCoverageSchema,
  truncated: z.boolean(),
  createdAt: timestampSchema,
  links: z.array(growthRetrievalReceiptLinkSchema).max(100_000),
}).strict().superRefine((value, context) => {
  uniqueIds(value.effectiveScopeResourceIds, context, "effectiveScopeResourceIds");
  if (new Set(value.aliases.map((alias) => alias.toLocaleLowerCase("en-US"))).size !== value.aliases.length) {
    context.addIssue({ code: "custom", path: ["aliases"], message: "Aliases must be unique case-insensitively." });
  }
  const ranks = value.links.map((link) => link.rank);
  if (new Set(ranks).size !== ranks.length) context.addIssue({ code: "custom", path: ["links"], message: "Receipt link ranks must be unique." });
  if (value.locatorCount !== value.links.filter((link) => link.stableLocator !== null).length) {
    context.addIssue({ code: "custom", path: ["locatorCount"], message: "Locator count is inconsistent." });
  }
});

export const growthEventPhaseSchema = z.enum([
  "goal_created", "rule_appended", "cycle_planned", "run_attached", "receipt_recorded", "change_set_committed", "cycle_terminal",
]);
export const growthDurableStateSchema = z.enum([
  "planned", "running", "committed", "blocked", "failed", "cancelled", "reconciliation_required",
]);
export const growthContentRefSchema = z.object({
  kind: growthTargetKindSchema,
  targetId: idSchema,
  targetVersionId: idSchema,
}).strict();

export const growthEventSchema = z.object({
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
  createdAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if (value.durableState === "committed" && value.phase !== "change_set_committed") {
    context.addIssue({ code: "custom", message: "Committed state requires Change Set commit phase." });
  }
  if (value.phase === "change_set_committed" && value.targetKind !== "change_set") {
    context.addIssue({ code: "custom", message: "Change Set commit phase requires Change Set target." });
  }
});

export type GrowthGoal = z.infer<typeof growthGoalSchema>;
export type GrowthGoalCreate = z.infer<typeof growthGoalCreateSchema>;
export type GrowthRuleRevision = z.infer<typeof growthRuleRevisionSchema>;
export type GrowthCycle = z.infer<typeof growthCycleSchema>;
export type GrowthRetrievalReceipt = z.infer<typeof growthRetrievalReceiptSchema>;
export type GrowthRetrievalReceiptLink = z.infer<typeof growthRetrievalReceiptLinkSchema>;
export type GrowthEvent = z.infer<typeof growthEventSchema>;
