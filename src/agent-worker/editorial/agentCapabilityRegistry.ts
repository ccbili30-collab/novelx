import { createHash } from "node:crypto";
import { z } from "zod";
import {
  agentCapabilityIds,
  type AgentCapabilityId,
} from "../../shared/growthEditorialContract";
import {
  capabilityContractIds,
  createSpecialistContract,
  type CapabilityContractId,
  type SpecialistContractDefinition,
} from "./specialistContracts";

export const agentCapabilityRegistryVersion = "1.0.0" as const;

export const maximumContextClasses = ["compact", "standard", "long"] as const;
export type MaximumContextClass = typeof maximumContextClasses[number];

export const capabilityConcurrencyGroups = [
  "editorial_direction",
  "editorial_authoring",
  "editorial_graph",
  "editorial_review",
  "player_turn",
  "source_import",
] as const;
export type CapabilityConcurrencyGroup = typeof capabilityConcurrencyGroups[number];

export interface PromptAssetBinding {
  id: string;
  version: `${number}.${number}.${number}`;
}

export interface TrustedPromptAssetIdentity extends PromptAssetBinding {
  sha256: string;
}

export interface AgentCapabilityDefinition {
  capabilityId: AgentCapabilityId;
  profile: {
    id: string;
    version: `${number}.${number}.${number}`;
    sha256: string;
  };
  contract: SpecialistContractDefinition;
  promptAsset: PromptAssetBinding;
  maximumContextClass: MaximumContextClass;
  concurrencyGroup: CapabilityConcurrencyGroup;
  terminalSubmissionTool: string;
}

interface CapabilitySeed {
  capabilityId: AgentCapabilityId;
  profileId: string;
  profileVersion: `${number}.${number}.${number}`;
  contractId: CapabilityContractId;
  promptAsset: PromptAssetBinding;
  maximumContextClass: MaximumContextClass;
  concurrencyGroup: CapabilityConcurrencyGroup;
  terminalSubmissionTool: string;
}

const authorCapabilities = new Set<AgentCapabilityId>([
  "world_system_author",
  "geography_ecology_author",
  "civilization_author",
  "organization_author",
  "species_culture_author",
  "character_author",
  "story_architect",
  "general_setting_author",
  "visual_director",
]);

const seeds: CapabilitySeed[] = agentCapabilityIds.map((capabilityId) => {
  if (capabilityId === "world_director") {
    return seed(capabilityId, "world_director_v1", "world-director", "long", "editorial_direction", "submit_world_director_result");
  }
  if (authorCapabilities.has(capabilityId)) {
    const assetName = capabilityId
      .replace(/_author$/, "")
      .replaceAll("_", "-");
    return seed(capabilityId, "specialist_candidate_v1", assetName, capabilityId === "story_architect" ? "long" : "standard", "editorial_authoring", "submit_specialist_candidate");
  }
  if (capabilityId === "graph_curator") {
    return seed(capabilityId, "graph_curator_candidate_v1", "graph-curator", "standard", "editorial_graph", "submit_graph_curator_candidate");
  }
  if (capabilityId === "writer") {
    return seed(capabilityId, "writer_output_v1", "writer", "long", "editorial_authoring", "submit_writer_result", "novax.writer", "1.7.0");
  }
  if (capabilityId === "checker") {
    return seed(capabilityId, "checker_output_v1", "checker", "long", "editorial_review", "submit_checker_result", "novax.checker", "1.8.0");
  }
  if (capabilityId === "gm") {
    return seed(capabilityId, "gm_turn_v1", "gm", "standard", "player_turn", "submit_gm_result", "novax.gm", "1.0.0");
  }
  return seed(capabilityId, "decomposer_output_v1", "decomposer", "long", "source_import", "submit_decomposer_result", "novax.decomposer", "1.1.0");
});

const registry = new Map<AgentCapabilityId, AgentCapabilityDefinition>(seeds.map((entry) => {
  const profileSha256 = hashProfile(entry);
  return [entry.capabilityId, Object.freeze({
    capabilityId: entry.capabilityId,
    profile: Object.freeze({ id: entry.profileId, version: entry.profileVersion, sha256: profileSha256 }),
    contract: createSpecialistContract(entry.capabilityId, entry.contractId),
    promptAsset: Object.freeze({ ...entry.promptAsset }),
    maximumContextClass: entry.maximumContextClass,
    concurrencyGroup: entry.concurrencyGroup,
    terminalSubmissionTool: entry.terminalSubmissionTool,
  })];
}));

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const invocationSchema = z.object({
  capabilityId: z.string().trim().min(1).max(80),
  profile: z.object({ id: z.string().trim().min(1).max(240), version: semverSchema, sha256: sha256Schema }).strict(),
  prompt: z.object({ id: z.string().trim().min(1).max(240), version: semverSchema, sha256: sha256Schema }).strict(),
  inputContractId: z.enum(capabilityContractIds),
  outputContractId: z.enum(capabilityContractIds),
  requestedTools: z.array(z.string().trim().min(1).max(120)).max(20),
  input: z.unknown(),
}).strict();

export interface AuthorizedCapabilityInvocation {
  definition: AgentCapabilityDefinition;
  input: unknown;
  prompt: TrustedPromptAssetIdentity;
}

export function listAgentCapabilities(): AgentCapabilityDefinition[] {
  return agentCapabilityIds.map((capabilityId) => requireAgentCapability(capabilityId));
}

export function requireAgentCapability(capabilityId: unknown): AgentCapabilityDefinition {
  if (typeof capabilityId !== "string" || !registry.has(capabilityId as AgentCapabilityId)) {
    throw capabilityError("AGENT_CAPABILITY_UNKNOWN");
  }
  return registry.get(capabilityId as AgentCapabilityId)!;
}

export function authorizeCapabilityInvocation(
  input: unknown,
  trustedPromptAssets: readonly TrustedPromptAssetIdentity[],
): AuthorizedCapabilityInvocation {
  const parsed = invocationSchema.safeParse(input);
  if (!parsed.success) {
    const capabilityId = readCapabilityId(input);
    if (!registry.has(capabilityId as AgentCapabilityId)) throw capabilityError("AGENT_CAPABILITY_UNKNOWN");
    throw capabilityError("AGENT_CAPABILITY_INVOCATION_INVALID");
  }
  const value = parsed.data;
  const definition = requireAgentCapability(value.capabilityId);
  if (value.profile.id !== definition.profile.id
    || value.profile.version !== definition.profile.version
    || value.profile.sha256 !== definition.profile.sha256) {
    throw capabilityError("AGENT_CAPABILITY_PROFILE_MISMATCH");
  }
  if (value.inputContractId !== definition.contract.id || value.outputContractId !== definition.contract.id) {
    throw capabilityError("AGENT_CAPABILITY_CONTRACT_MISMATCH");
  }
  if (value.requestedTools.length !== 1 || value.requestedTools[0] !== definition.terminalSubmissionTool) {
    throw capabilityError("AGENT_CAPABILITY_TOOL_POLICY_MISMATCH");
  }
  if (value.prompt.id !== definition.promptAsset.id || value.prompt.version !== definition.promptAsset.version) {
    throw capabilityError("AGENT_CAPABILITY_PROMPT_MISMATCH");
  }
  const promptMatches = trustedPromptAssets.filter((candidate) =>
    candidate.id === definition.promptAsset.id && candidate.version === definition.promptAsset.version);
  if (promptMatches.length !== 1) throw capabilityError("AGENT_CAPABILITY_PROMPT_NOT_REGISTERED");
  const trustedPrompt = promptMatches[0];
  if (!sha256Schema.safeParse(trustedPrompt.sha256).success || value.prompt.sha256 !== trustedPrompt.sha256) {
    throw capabilityError("AGENT_CAPABILITY_PROMPT_HASH_MISMATCH");
  }
  if (!definition.contract.inputSchema.safeParse(value.input).success) {
    throw capabilityError("AGENT_CAPABILITY_INPUT_CONTRACT_MISMATCH");
  }
  return { definition, input: value.input, prompt: { ...trustedPrompt } };
}

export function parseCapabilitySubmission(
  capabilityId: unknown,
  outputContractId: unknown,
  output: unknown,
): unknown {
  const definition = requireAgentCapability(capabilityId);
  if (outputContractId !== definition.contract.id) throw capabilityError("AGENT_CAPABILITY_CONTRACT_MISMATCH");
  const parsed = definition.contract.outputSchema.safeParse(output);
  if (!parsed.success) throw capabilityError("AGENT_CAPABILITY_OUTPUT_CONTRACT_MISMATCH");
  return parsed.data;
}

function seed(
  capabilityId: AgentCapabilityId,
  contractId: CapabilityContractId,
  assetName: string,
  maximumContextClass: MaximumContextClass,
  concurrencyGroup: CapabilityConcurrencyGroup,
  terminalSubmissionTool: string,
  promptId = `novax.editorial.${assetName}`,
  promptVersion: `${number}.${number}.${number}` = "1.0.0",
): CapabilitySeed {
  return {
    capabilityId,
    profileId: `novax.capability.${capabilityId}`,
    profileVersion: agentCapabilityRegistryVersion,
    contractId,
    promptAsset: { id: promptId, version: promptVersion },
    maximumContextClass,
    concurrencyGroup,
    terminalSubmissionTool,
  };
}

function hashProfile(entry: CapabilitySeed): string {
  return createHash("sha256").update(JSON.stringify({
    registryVersion: agentCapabilityRegistryVersion,
    capabilityId: entry.capabilityId,
    profileId: entry.profileId,
    profileVersion: entry.profileVersion,
    contractId: entry.contractId,
    promptAsset: entry.promptAsset,
    maximumContextClass: entry.maximumContextClass,
    concurrencyGroup: entry.concurrencyGroup,
    terminalSubmissionTool: entry.terminalSubmissionTool,
  }), "utf8").digest("hex");
}

function readCapabilityId(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const value = (input as Record<string, unknown>).capabilityId;
  return typeof value === "string" ? value : "";
}

function capabilityError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
