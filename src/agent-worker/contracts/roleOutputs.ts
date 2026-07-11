import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(240);
const messageSchema = z.string().trim().min(1).max(8_000);

const blockedReasonSchema = z.object({
  code: z.enum([
    "missing_source",
    "conflicting_sources",
    "missing_gm_resolution",
    "authority_violation",
    "hidden_fact_risk",
    "tool_failed",
    "major_conflict",
    "user_confirmation_required",
    "insufficient_input",
  ]),
  message: z.string().trim().min(1).max(1_000),
  evidenceIds: z.array(identifierSchema).max(100),
}).strict();

export const stewardOutputSchema = z.object({
  status: z.enum(["completed", "blocked", "awaiting_confirmation"]),
  message: messageSchema,
  evidenceIds: z.array(identifierSchema).max(200),
  toolOutcomes: z.array(z.object({
    tool: z.enum(["retrieve_graph_evidence", "propose_change_set", "writer", "checker"]),
    status: z.enum(["succeeded", "failed", "not_run"]),
  }).strict()).max(20),
  changeSet: z.object({
    state: z.enum(["none", "pending_review", "committed"]),
    changeSetId: identifierSchema.nullable(),
  }).strict(),
  escalations: z.array(blockedReasonSchema).max(20),
}).strict().superRefine((value, context) => {
  if (value.changeSet.state === "none" && value.changeSet.changeSetId !== null) {
    context.addIssue({ code: "custom", message: "A missing Change Set cannot have an id." });
  }
  if (value.changeSet.state !== "none" && value.changeSet.changeSetId === null) {
    context.addIssue({ code: "custom", message: "A proposed or committed Change Set requires an id." });
  }
  if (value.status === "blocked" && value.escalations.length === 0) {
    context.addIssue({ code: "custom", message: "Blocked Steward output requires an escalation." });
  }
});

const writerCandidateSchema = z.object({
  status: z.literal("candidate"),
  candidateText: messageSchema,
  evidenceIds: z.array(identifierSchema).min(1).max(200),
  gmResolutionId: identifierSchema.nullable(),
  authorityChanges: z.array(z.never()).max(0),
}).strict();

const writerBlockedSchema = z.object({
  status: z.literal("blocked"),
  reasons: z.array(blockedReasonSchema).min(1).max(20),
}).strict();

export const writerOutputSchema = z.discriminatedUnion("status", [
  writerCandidateSchema,
  writerBlockedSchema,
]);

const checkerFindingSchema = z.object({
  severity: z.enum(["info", "warning", "major"]),
  category: z.enum([
    "source_missing",
    "fact_conflict",
    "writer_authority",
    "hidden_fact_leak",
    "timeline",
    "character_continuity",
    "style",
    "permission",
    "dependency",
    "tool_claim",
  ]),
  evidence: z.array(z.object({
    sourceId: identifierSchema,
    claim: z.string().trim().min(1).max(1_000),
  }).strict()).min(1).max(100),
  location: z.string().trim().min(1).max(1_000),
  scope: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(2_000),
}).strict();

const checkerPassedSchema = z.object({
  status: z.literal("passed"),
  findings: z.array(z.never()).max(0),
}).strict();

const checkerFindingsSchema = z.object({
  status: z.literal("findings"),
  findings: z.array(checkerFindingSchema).min(1).max(200),
}).strict();

const checkerBlockedSchema = z.object({
  status: z.literal("blocked"),
  reasons: z.array(blockedReasonSchema).min(1).max(20),
}).strict();

export const checkerOutputSchema = z.discriminatedUnion("status", [
  checkerPassedSchema,
  checkerFindingsSchema,
  checkerBlockedSchema,
]);

export const roleOutputSchemas = {
  steward: stewardOutputSchema,
  writer: writerOutputSchema,
  checker: checkerOutputSchema,
} as const;

export type StewardOutput = z.infer<typeof stewardOutputSchema>;
export type WriterOutput = z.infer<typeof writerOutputSchema>;
export type CheckerOutput = z.infer<typeof checkerOutputSchema>;
export type RoleOutput = StewardOutput | WriterOutput | CheckerOutput;
