import { z } from "zod";
import {
  agentCapabilityIdSchema,
  editorialRoundPlanSchema,
  growthEditorialContractVersion,
  type AgentCapabilityId,
  type EditorialRoundPlan,
} from "../../../shared/growthEditorialContract";

const idSchema = z.string().trim().min(1).max(240);
const keySchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const versionSchema = z.string().trim().min(1).max(120);
const failureCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,119}$/);

export const editorialRoundCreateSchema = editorialRoundPlanSchema.extend({
  ruleRevision: z.number().int().min(1),
  idempotencyKey: keySchema,
}).strict();

export type EditorialRoundCreate = z.infer<typeof editorialRoundCreateSchema>;

export const workOrderAttemptStartSchema = z.object({
  id: idSchema,
  workOrderId: idSchema,
  idempotencyKey: keySchema,
  sourceCheckpointId: idSchema,
  ruleRevision: z.number().int().min(1),
  capability: agentCapabilityIdSchema,
  capabilityProfile: z.object({ id: idSchema, version: versionSchema, sha256: sha256Schema }).strict(),
  prompt: z.object({ id: idSchema, version: versionSchema, sha256: sha256Schema }).strict(),
  model: z.object({ providerId: idSchema, modelId: idSchema, providerConfigSha256: sha256Schema }).strict(),
}).strict();

export type WorkOrderAttemptStart = z.infer<typeof workOrderAttemptStartSchema>;

export const workOrderArtifactInputSchema = z.object({
  kind: z.enum([
    "content_artifact", "specialist_candidate", "graph_curator_candidate",
    "checker_review", "director_review", "change_set",
  ]),
  ordinal: z.number().int().min(0),
  storeRef: z.string().trim().min(1).max(2_000),
  contentSha256: sha256Schema,
}).strict();

export type WorkOrderArtifactInput = z.infer<typeof workOrderArtifactInputSchema>;

export const candidateRecordSchema = z.object({
  attemptId: idSchema,
  outputSha256: sha256Schema,
  artifacts: z.array(workOrderArtifactInputSchema).min(1).max(100),
}).strict();

export type CandidateRecord = z.infer<typeof candidateRecordSchema>;

export const editorialReviewRecordSchema = z.object({
  id: idSchema,
  attemptId: idSchema,
  reviewerKind: z.enum(["checker", "director"]),
  decision: z.enum(["passed", "findings", "blocked", "accept", "revise", "ask_user"]),
  safeSummary: z.string().trim().min(1).max(2_000),
  evidenceRefs: z.array(z.string().trim().min(1).max(2_000)).max(100),
  artifactRef: z.string().trim().min(1).max(2_000),
  artifactSha256: sha256Schema,
  idempotencyKey: keySchema,
}).strict().superRefine((value, context) => {
  const valid = value.reviewerKind === "checker"
    ? ["passed", "findings", "blocked"].includes(value.decision)
    : ["accept", "revise", "ask_user"].includes(value.decision);
  if (!valid) context.addIssue({ code: "custom", path: ["decision"], message: "Review decision does not match reviewer kind." });
  if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) {
    context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Evidence references must be unique." });
  }
});

export type EditorialReviewRecord = z.infer<typeof editorialReviewRecordSchema>;

export const workOrderTerminalSchema = z.object({
  workOrderId: idSchema,
  status: z.enum(["cancelled", "failed"]),
  failureCode: failureCodeSchema,
}).strict();

export type WorkOrderTerminal = z.infer<typeof workOrderTerminalSchema>;

export const reconciliationRequiredSchema = z.object({
  workOrderId: idSchema,
  attemptId: idSchema,
  failureCode: failureCodeSchema,
}).strict();

export type ReconciliationRequired = z.infer<typeof reconciliationRequiredSchema>;

export const editorialRoundTerminalSchema = z.object({
  roundId: idSchema,
  status: z.enum(["cancelled", "failed"]),
  failureCode: failureCodeSchema,
}).strict();

export type EditorialRoundTerminal = z.infer<typeof editorialRoundTerminalSchema>;

export type EditorialRoundStatus = "planned" | "active" | "completed" | "blocked" | "cancelled" | "failed" | "reconciliation_required";
export type WorkOrderStatus = "planned" | "ready" | "running" | "candidate_ready" | "reviewing" | "revision_requested" | "accepted" | "commit_queued" | "committed" | "cancelled" | "failed" | "reconciliation_required";
export type WorkOrderAttemptStatus = "running" | "candidate_ready" | "reviewing" | "revision_requested" | "accepted" | "cancelled" | "failed" | "reconciliation_required";
export type AttemptSideEffectState = "none" | "commit_requested" | "outcome_unknown" | "committed";

export interface GrowthEditorialRound {
  id: string;
  goalId: string;
  contractVersion: typeof growthEditorialContractVersion;
  sourceCheckpointId: string;
  ruleRevision: number;
  status: EditorialRoundStatus;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface GrowthWorkOrder {
  id: string;
  roundId: string;
  goalId: string;
  ordinal: number;
  objective: string;
  sourceCheckpointId: string;
  scopeRefs: string[];
  capability: AgentCapabilityId;
  acceptanceFacets: EditorialRoundPlan["workOrders"][number]["acceptanceFacets"];
  dependencies: string[];
  status: WorkOrderStatus;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GrowthWorkOrderAttempt {
  id: string;
  roundId: string;
  goalId: string;
  workOrderId: string;
  attemptNumber: number;
  status: WorkOrderAttemptStatus;
  failureCode: string | null;
  sourceCheckpointId: string;
  ruleRevision: number;
  capability: AgentCapabilityId;
  capabilityProfile: { id: string; version: string; sha256: string };
  prompt: { id: string; version: string; sha256: string };
  model: { providerId: string; modelId: string; providerConfigSha256: string };
  sideEffectState: AttemptSideEffectState;
  outputSha256: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface GrowthEditorialReview {
  id: string;
  roundId: string;
  goalId: string;
  workOrderId: string;
  attemptId: string;
  reviewerKind: "checker" | "director";
  decision: EditorialReviewRecord["decision"];
  safeSummary: string;
  evidenceRefs: string[];
  artifactRef: string;
  artifactSha256: string;
  createdAt: string;
}

export interface GrowthWorkOrderArtifact {
  roundId: string;
  goalId: string;
  workOrderId: string;
  attemptId: string;
  kind: WorkOrderArtifactInput["kind"];
  ordinal: number;
  storeRef: string;
  contentSha256: string;
  createdAt: string;
}

export interface GrowthEditorialRoundSnapshot {
  round: GrowthEditorialRound;
  workOrders: GrowthWorkOrder[];
  attempts: GrowthWorkOrderAttempt[];
  reviews: GrowthEditorialReview[];
  artifacts: GrowthWorkOrderArtifact[];
}
