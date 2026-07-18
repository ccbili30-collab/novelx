import type { ZodType } from "zod";
import { z } from "zod";
import { decomposerOutputSchema } from "../../shared/decomposerContracts";
import {
  agentCapabilityIdSchema,
  directorReviewSchema,
  editorialRoundPlanSchema,
  graphCuratorCandidateSchema,
  growthEditorialContractVersion,
  specialistCandidateSchema,
  type AgentCapabilityId,
} from "../../shared/growthEditorialContract";
import { gmTurnOutputSchema } from "../../shared/playerWorkerProtocol";
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

export interface SpecialistContractDefinition {
  id: CapabilityContractId;
  inputSchema: ZodType<CapabilityInvocationBinding>;
  outputSchema: ZodType;
}

const worldDirectorOutputSchema = z.union([editorialRoundPlanSchema, directorReviewSchema]);

const contractOutputSchemas: Record<CapabilityContractId, ZodType> = {
  world_director_v1: worldDirectorOutputSchema,
  specialist_candidate_v1: specialistCandidateSchema,
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
