import { Type } from "typebox";
import { z } from "zod";
import {
  graphCuratorCandidateParameters,
  graphCuratorCandidateSchema,
} from "../../shared/growthEditorialContract";
import {
  growthEditorialPromptSchema,
  growthEditorialReceiptSchema,
} from "../../shared/growthEditorialWorkerProtocol";
import { providerRuntimeProfileSchema } from "../../shared/providerContract";

const identifierSchema = z.string().trim().min(1).max(240);
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceRefSchema = z.string().regex(/^@evidence[1-9][0-9]*$/);
const resourceRefSchema = z.string().regex(/^@resource[1-9][0-9]*$/);
const assertionRefSchema = z.string().regex(/^@assertion[1-9][0-9]*$/);

export const graphCuratorPacketSchema = z.object({
  capabilityId: z.literal("graph_curator"),
  sourceCheckpointId: identifierSchema,
  workOrderId: identifierSchema,
  objective: z.string().trim().min(1).max(4_000),
  scopeRefs: z.array(resourceRefSchema).min(1).max(100),
  existingAssertionRefs: z.array(assertionRefSchema).max(200),
  evidence: z.array(z.object({
    ref: evidenceRefSchema,
    kind: z.enum(["document", "specialist_candidate"]),
    stableLocator: z.string().trim().min(1).max(1_000),
    content: z.string().min(1).max(100_000),
    contentSha256: sha256Schema,
  }).strict()).min(1).max(200),
}).strict().superRefine((value, context) => {
  if (new Set(value.evidence.map((item) => item.ref)).size !== value.evidence.length) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Evidence refs must be unique." });
  }
  if (new Set(value.scopeRefs).size !== value.scopeRefs.length
    || new Set(value.existingAssertionRefs).size !== value.existingAssertionRefs.length) {
    context.addIssue({ code: "custom", message: "Graph scope and assertion refs must be unique." });
  }
  if (value.evidence.reduce((total, item) => total + item.content.length, 0) > 500_000) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Graph Curator packet exceeds its content budget." });
  }
});

const graphCuratorReadySchema = z.object({
  status: z.literal("ready"),
  candidate: graphCuratorCandidateSchema,
}).strict();

const graphCuratorNeedsEvidenceSchema = z.object({
  status: z.literal("needs_more_evidence"),
  summary: z.string().trim().min(1).max(2_000),
  evidenceRefs: z.array(evidenceRefSchema).max(100),
  missingEvidenceQueries: z.array(z.string().trim().min(1).max(1_000)).min(1).max(10),
}).strict().superRefine((value, context) => {
  if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) {
    context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Evidence refs must be unique." });
  }
  if (new Set(value.missingEvidenceQueries).size !== value.missingEvidenceQueries.length) {
    context.addIssue({ code: "custom", path: ["missingEvidenceQueries"], message: "Queries must be unique." });
  }
});

export const graphCuratorSubmissionSchema = z.discriminatedUnion("status", [
  graphCuratorReadySchema,
  graphCuratorNeedsEvidenceSchema,
]);

const evidenceRefParameter = Type.String({ pattern: "^@evidence[1-9][0-9]*$" });
export const graphCuratorSubmissionParameters = Type.Union([
  Type.Object({
    status: Type.Literal("ready"),
    candidate: graphCuratorCandidateParameters,
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("needs_more_evidence"),
    summary: Type.String({ minLength: 1, maxLength: 2_000 }),
    evidenceRefs: Type.Array(evidenceRefParameter, { maxItems: 100, uniqueItems: true }),
    missingEvidenceQueries: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 10, uniqueItems: true }),
  }, { additionalProperties: false }),
]);

export const graphCuratorStartSchema = z.object({
  type: z.literal("growth.editorial.graph_curator.start"),
  runId: identifierSchema,
  attemptId: identifierSchema,
  profile: z.object({ id: identifierSchema, version: semverSchema, sha256: sha256Schema }).strict(),
  prompt: growthEditorialPromptSchema,
  packet: graphCuratorPacketSchema,
  packetSha256: sha256Schema,
  outputContractId: z.literal("graph_curator_candidate_v1"),
  providerProfile: providerRuntimeProfileSchema.nullable(),
}).strict();

export const graphCuratorEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("growth.editorial.graph_curator.started"),
    runId: identifierSchema,
    attemptId: identifierSchema,
  }).strict(),
  z.object({
    type: z.literal("growth.editorial.graph_curator.completed"),
    runId: identifierSchema,
    attemptId: identifierSchema,
    candidate: graphCuratorCandidateSchema,
    receipt: growthEditorialReceiptSchema,
  }).strict(),
  z.object({
    type: z.literal("growth.editorial.graph_curator.evidence_requested"),
    runId: identifierSchema,
    attemptId: identifierSchema,
    request: graphCuratorNeedsEvidenceSchema,
    receipt: growthEditorialReceiptSchema,
  }).strict(),
  z.object({
    type: z.literal("growth.editorial.graph_curator.failed"),
    runId: identifierSchema,
    attemptId: identifierSchema,
    error: z.object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/),
      message: z.string().trim().min(1).max(240),
    }).strict(),
  }).strict(),
]);

export type GraphCuratorPacket = z.infer<typeof graphCuratorPacketSchema>;
export type GraphCuratorSubmission = z.infer<typeof graphCuratorSubmissionSchema>;
export type GraphCuratorStart = z.infer<typeof graphCuratorStartSchema>;
export type GraphCuratorEvent = z.infer<typeof graphCuratorEventSchema>;
