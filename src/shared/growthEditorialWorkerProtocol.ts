import { z } from "zod";
import {
  acceptanceFacetSchema,
  agentCapabilityIds,
  agentCapabilityIdSchema,
  directorReviewSchema,
  editorialRoundPlanSchema,
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
const resourceRefSchema = z.string().regex(/^@resource[1-9][0-9]*$/);
const safeSummarySchema = z.string().trim().min(1).max(2_000);

export const worldDirectorPacketSchema = z.object({
  version: z.literal("1.0.0"),
  identity: z.object({
    goalId: identifierSchema,
    branchId: identifierSchema,
    sourceCheckpointId: identifierSchema,
    ruleRevision: z.number().int().positive(),
    lens: z.literal("creator"),
  }).strict(),
  editorialCharter: z.array(z.string().trim().min(1).max(2_000)).min(4).max(20),
  availableCapabilities: z.array(agentCapabilityIdSchema).length(agentCapabilityIds.length),
  userRules: z.array(z.object({
    id: identifierSchema,
    revision: z.number().int().positive(),
    text: z.string().trim().min(1).max(4_000),
    contentSha256: sha256Schema,
  }).strict()).max(100),
  closureMatrix: z.array(z.object({
    sourceCheckpointId: identifierSchema,
    profileId: identifierSchema,
    facetId: identifierSchema,
    state: z.enum(["satisfied", "missing", "conflicted", "blocked", "unknown"]),
    safeSummary: safeSummarySchema,
    evidenceRefs: z.array(evidenceRefSchema).max(100),
  }).strict()).max(500),
  causalFrontier: z.array(z.object({
    sourceCheckpointId: identifierSchema,
    relationVersionId: identifierSchema,
    relationKind: z.enum(["causes", "enables", "constrains", "prevents", "amplifies", "mitigates", "depends_on"]),
    causeAssertionId: identifierSchema,
    effectAssertionId: identifierSchema,
    mechanismSummary: safeSummarySchema,
    epistemicStatus: z.enum(["confirmed", "inferred", "disputed"]),
    sourceReferences: z.array(z.object({
      kind: z.enum(["document", "evidence", "assertion"]),
      versionId: identifierSchema,
      locator: z.string().trim().min(1).max(1_000),
    }).strict()).min(1).max(20),
  }).strict()).max(500),
  recentChangeSets: z.array(z.object({
    sourceCheckpointId: identifierSchema,
    changeSetId: identifierSchema,
    committedCheckpointId: identifierSchema,
    summary: safeSummarySchema,
    outputKinds: z.array(z.enum([
      "resource_revision", "document_version", "assertion_version", "creative_document_revision",
      "creative_relation_revision", "constraint_profile_version", "project_file_version", "causal_relation_version",
    ])).max(100),
    committedAt: z.iso.datetime({ offset: true }),
  }).strict()).max(100),
  unresolvedCheckerFindings: z.array(z.object({
    sourceCheckpointId: identifierSchema,
    findingId: identifierSchema,
    workOrderId: identifierSchema,
    severity: z.enum(["minor", "major", "blocking"]),
    category: z.enum(["fact_conflict", "causality", "source", "coverage", "continuity"]),
    safeSummary: safeSummarySchema,
    evidenceRefs: z.array(evidenceRefSchema).min(1).max(100),
  }).strict()).max(500),
  nodeMaturity: z.array(z.object({
    sourceCheckpointId: identifierSchema,
    scopeRef: resourceRefSchema,
    profileId: identifierSchema,
    state: z.enum(["unknown", "seed", "structured", "developed", "closure_ready", "blocked"]),
    satisfiedFacetIds: z.array(identifierSchema).max(100),
    missingFacetIds: z.array(identifierSchema).max(100),
  }).strict()).max(500),
  graphSummaries: z.array(z.object({
    sourceCheckpointId: identifierSchema,
    scopeRef: resourceRefSchema,
    label: z.string().trim().min(1).max(500),
    safeSummary: safeSummarySchema,
    factCount: z.number().int().nonnegative(),
    causalEdgeCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
    sourceVersionIds: z.array(identifierSchema).min(1).max(100),
    truncated: z.boolean(),
  }).strict()).max(500),
  imageQueueSummary: z.object({
    sourceCheckpointId: identifierSchema,
    requests: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
  }).strict(),
  retrieval: z.object({
    budget: z.object({
      maxClosureFacets: z.number().int().min(1).max(500),
      maxCausalEdges: z.number().int().min(1).max(500),
      maxRecentChangeSets: z.number().int().min(1).max(100),
      maxCheckerFindings: z.number().int().min(1).max(500),
      maxNodeMaturity: z.number().int().min(1).max(500),
      maxGraphSummaries: z.number().int().min(1).max(500),
      maxTotalChars: z.number().int().min(10_000).max(500_000),
    }).strict(),
    omitted: z.object({
      closureFacets: z.number().int().nonnegative(),
      causalEdges: z.number().int().nonnegative(),
      recentChangeSets: z.number().int().nonnegative(),
      checkerFindings: z.number().int().nonnegative(),
      nodeMaturity: z.number().int().nonnegative(),
      graphSummaries: z.number().int().nonnegative(),
    }).strict(),
    incomplete: z.boolean(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (new Set(value.availableCapabilities).size !== agentCapabilityIds.length
    || agentCapabilityIds.some((capabilityId) => !value.availableCapabilities.includes(capabilityId))) {
    context.addIssue({ code: "custom", path: ["availableCapabilities"], message: "Director packet must bind the complete fixed capability registry." });
  }
});

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

export const worldDirectorStartSchema = z.object({
  type: z.literal("growth.editorial.director.start"),
  runId: identifierSchema,
  invocationKind: z.enum(["plan", "review"]),
  profile: z.object({ id: identifierSchema, version: semverSchema, sha256: sha256Schema }).strict(),
  prompt: growthEditorialPromptSchema,
  packet: worldDirectorPacketSchema,
  packetSha256: sha256Schema,
  outputContractId: z.literal("world_director_v1"),
  providerProfile: providerRuntimeProfileSchema.nullable(),
}).strict();

export const worldDirectorEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("growth.editorial.director.started"),
    runId: identifierSchema,
    invocationKind: z.enum(["plan", "review"]),
  }).strict(),
  z.object({
    type: z.literal("growth.editorial.director.planned"),
    runId: identifierSchema,
    plan: editorialRoundPlanSchema,
    receipt: receiptSchema,
  }).strict(),
  z.object({
    type: z.literal("growth.editorial.director.reviewed"),
    runId: identifierSchema,
    review: directorReviewSchema,
    receipt: receiptSchema,
  }).strict(),
  z.object({
    type: z.literal("growth.editorial.director.failed"),
    runId: identifierSchema,
    error: z.object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/),
      message: z.string().trim().min(1).max(240),
    }).strict(),
  }).strict(),
]);

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
export type WorldDirectorPacket = z.infer<typeof worldDirectorPacketSchema>;
export type WorldDirectorStart = z.infer<typeof worldDirectorStartSchema>;
export type WorldDirectorEvent = z.infer<typeof worldDirectorEventSchema>;
