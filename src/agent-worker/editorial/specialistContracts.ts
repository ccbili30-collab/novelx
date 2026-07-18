import { Type } from "typebox";
import type { ZodType } from "zod";
import { z } from "zod";
import { decomposerOutputSchema } from "../../shared/decomposerContracts";
import {
  agentCapabilityIdSchema,
  directorReviewSchema,
  editorialRoundPlanSchema,
  graphCuratorCandidateSchema,
  growthEditorialContractVersion,
  specialistCandidateParameters,
  specialistCandidateSchema,
  type AgentCapabilityId,
} from "../../shared/growthEditorialContract";
import { gmTurnOutputSchema } from "../../shared/playerWorkerProtocol";
import { specialistArtifactSchema } from "../../shared/growthEditorialWorkerProtocol";
import { checkerOutputSchema, writerOutputSchema } from "../contracts/roleOutputs";

const identifierSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const capabilityContractIds = [
  "world_director_v1",
  "specialist_candidate_v1",
  "graph_curator_candidate_v1",
  "writer_output_v1",
  "checker_output_v1",
  "gm_turn_v1",
  "decomposer_output_v1",
] as const;

export type CapabilityContractId = typeof capabilityContractIds[number];

export const capabilityInvocationBindingSchema = z.object({
  capabilityId: agentCapabilityIdSchema,
  contractVersion: z.literal(growthEditorialContractVersion),
  inputContractId: z.enum(capabilityContractIds),
  sourceCheckpointId: identifierSchema,
  workOrderId: identifierSchema,
  packetSha256: sha256Schema,
}).strict();

export type CapabilityInvocationBinding = z.infer<typeof capabilityInvocationBindingSchema>;

export const specialistSubmissionSchema = z.object({
  candidate: specialistCandidateSchema,
  artifacts: z.array(specialistArtifactSchema).max(20),
}).strict().superRefine((value, context) => {
  const artifactRefs = value.artifacts.map((artifact) => artifact.ref);
  if (new Set(artifactRefs).size !== artifactRefs.length) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "Artifact refs must be unique." });
  }
  const readyCandidate = value.candidate.status === "ready" ? value.candidate : null;
  if (!readyCandidate) {
    if (value.artifacts.length > 0) context.addIssue({ code: "custom", path: ["artifacts"], message: "Evidence requests cannot contain artifacts." });
    return;
  }
  if (artifactRefs.length !== readyCandidate.contentArtifactRefs.length
    || artifactRefs.some((ref) => !readyCandidate.contentArtifactRefs.includes(ref))) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "Ready candidate artifact refs must match submitted artifacts exactly." });
  }
});

const artifactRefParameter = Type.String({ pattern: "^@artifact[1-9][0-9]*$" });
export const specialistSubmissionParameters = Type.Object({
  candidate: specialistCandidateParameters,
  artifacts: Type.Array(Type.Object({
    ref: artifactRefParameter,
    title: Type.String({ minLength: 1, maxLength: 500 }),
    mediaType: Type.Literal("text/markdown"),
    content: Type.String({ minLength: 1, maxLength: 100_000 }),
  }, { additionalProperties: false }), { maxItems: 20 }),
}, { additionalProperties: false });

export type SpecialistSubmission = z.infer<typeof specialistSubmissionSchema>;

export interface SpecialistContractDefinition {
  id: CapabilityContractId;
  inputSchema: ZodType<CapabilityInvocationBinding>;
  outputSchema: ZodType;
}

const worldDirectorOutputSchema = z.union([editorialRoundPlanSchema, directorReviewSchema]);

const contractOutputSchemas: Record<CapabilityContractId, ZodType> = {
  world_director_v1: worldDirectorOutputSchema,
  specialist_candidate_v1: specialistSubmissionSchema,
  graph_curator_candidate_v1: graphCuratorCandidateSchema,
  writer_output_v1: writerOutputSchema,
  checker_output_v1: checkerOutputSchema,
  gm_turn_v1: gmTurnOutputSchema,
  decomposer_output_v1: decomposerOutputSchema,
};

export function createSpecialistContract(
  capabilityId: AgentCapabilityId,
  contractId: CapabilityContractId,
): SpecialistContractDefinition {
  return Object.freeze({
    id: contractId,
    inputSchema: capabilityInvocationBindingSchema.refine(
      (value) => value.capabilityId === capabilityId && value.inputContractId === contractId,
      { message: "Capability invocation binding does not match its registered contract." },
    ),
    outputSchema: contractOutputSchemas[contractId],
  });
}
