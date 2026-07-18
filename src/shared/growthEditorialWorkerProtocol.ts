import { z } from "zod";
import {
  acceptanceFacetSchema,
  agentCapabilityIdSchema,
  growthEditorialContractVersion,
  specialistCandidateSchema,
} from "./growthEditorialContract";
import { providerRuntimeProfileSchema } from "./providerContract";

const identifierSchema = z.string().trim().min(1).max(240);
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceRefSchema = z.string().regex(/^@evidence[1-9][0-9]*$/);
const artifactRefSchema = z.string().regex(/^@artifact[1-9][0-9]*$/);
const scopeRefSchema = z.string().regex(/^@(resource|document|assertion|relation)[1-9][0-9]*$/);

export const specialistArtifactSchema = z.object({
  ref: artifactRefSchema,
  title: z.string().trim().min(1).max(500),
  mediaType: z.literal("text/markdown"),
  content: z.string().trim().min(1).max(100_000),
}).strict();

export const growthEditorialSpecialistPacketSchema = z.object({
  capabilityId: agentCapabilityIdSchema,
  sourceCheckpointId: identifierSchema,
  workOrderId: identifierSchema,
  objective: z.string().trim().min(1).max(4_000),
  scopeRefs: z.array(scopeRefSchema).min(1).max(100),
  acceptanceFacets: z.array(acceptanceFacetSchema).min(1).max(50),
  evidence: z.array(z.object({
    ref: evidenceRefSchema,
    kind: z.enum(["document", "assertion", "causal_relation", "review"]),
    stableLocator: z.string().trim().min(1).max(1_000),
    content: z.string().trim().min(1).max(100_000),
    contentSha256: sha256Schema,
  }).strict()).min(1).max(200),
  artifactSlots: z.array(artifactRefSchema).min(1).max(20),
  revisionFeedback: z.array(z.string().trim().min(1).max(2_000)).max(20),
}).strict().superRefine((value, context) => {
  const unique = (items: readonly string[], path: string): void => {
    if (new Set(items).size !== items.length) context.addIssue({ code: "custom", path: [path], message: `${path} must be unique.` });
  };
  unique(value.scopeRefs, "scopeRefs");
  unique(value.acceptanceFacets.map((facet) => facet.id), "acceptanceFacets");
  unique(value.evidence.map((item) => item.ref), "evidence");
  unique(value.artifactSlots, "artifactSlots");
  unique(value.revisionFeedback, "revisionFeedback");
  if (value.evidence.reduce((total, item) => total + item.content.length, 0) > 500_000) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Prepared evidence packet exceeds its bounded content budget." });
  }
});

export const growthEditorialPromptSchema = z.object({
  id: z.string().trim().min(1).max(240),
  version: semverSchema,
  sha256: sha256Schema,
  status: z.enum(["candidate", "active", "deprecated"]),
  content: z.string().min(1).max(200_000),
  publicationEvidence: z.object({
    reportPath: z.string().trim().min(1).max(1_000),
    reportSha256: sha256Schema,
  }).strict().nullable(),
}).strict();

export const growthEditorialSpecialistStartSchema = z.object({
  type: z.literal("growth.editorial.specialist.start"),
  runId: identifierSchema,
  attemptId: identifierSchema,
  profile: z.object({ id: identifierSchema, version: semverSchema, sha256: sha256Schema }).strict(),
  prompt: growthEditorialPromptSchema,
  binding: z.object({
    capabilityId: agentCapabilityIdSchema,
    contractVersion: z.literal(growthEditorialContractVersion),
    inputContractId: z.literal("specialist_candidate_v1"),
    sourceCheckpointId: identifierSchema,
    workOrderId: identifierSchema,
    packetSha256: sha256Schema,
  }).strict(),
  outputContractId: z.literal("specialist_candidate_v1"),
  packet: growthEditorialSpecialistPacketSchema,
  providerProfile: providerRuntimeProfileSchema.nullable(),
}).strict();

const receiptSchema = z.object({
  actualProviderId: z.string().trim().min(1).max(240).nullable(),
  actualModelId: z.string().trim().min(1).max(240).nullable(),
  responseIdSha256: sha256Schema.nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  correctionAttempts: z.number().int().nonnegative(),
}).strict();

export const growthEditorialSpecialistEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("growth.editorial.specialist.started"),
    runId: identifierSchema,
    attemptId: identifierSchema,
    capabilityId: agentCapabilityIdSchema,
  }).strict(),
  z.object({
    type: z.literal("growth.editorial.specialist.completed"),
    runId: identifierSchema,
    attemptId: identifierSchema,
    candidate: specialistCandidateSchema.refine((value) => value.status === "ready"),
    artifacts: z.array(specialistArtifactSchema).min(1).max(20),
    receipt: receiptSchema,
  }).strict(),
  z.object({
    type: z.literal("growth.editorial.specialist.evidence_requested"),
    runId: identifierSchema,
    attemptId: identifierSchema,
    request: specialistCandidateSchema.refine((value) => value.status === "needs_more_evidence"),
    receipt: receiptSchema,
  }).strict(),
  z.object({
    type: z.literal("growth.editorial.specialist.failed"),
    runId: identifierSchema,
    attemptId: identifierSchema,
    error: z.object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/),
      message: z.string().trim().min(1).max(240),
    }).strict(),
  }).strict(),
]);

export type GrowthEditorialSpecialistPacket = z.infer<typeof growthEditorialSpecialistPacketSchema>;
export type GrowthEditorialPrompt = z.infer<typeof growthEditorialPromptSchema>;
export type GrowthEditorialSpecialistStart = z.infer<typeof growthEditorialSpecialistStartSchema>;
export type GrowthEditorialSpecialistEvent = z.infer<typeof growthEditorialSpecialistEventSchema>;
