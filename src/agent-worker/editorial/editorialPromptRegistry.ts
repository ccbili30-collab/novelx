import { createHash } from "node:crypto";
import type { AgentCapabilityId } from "../../shared/growthEditorialContract";
import characterPrompt from "../prompts/editorial/character/v1.md?raw";
import civilizationPrompt from "../prompts/editorial/civilization/v1.md?raw";
import generalSettingPrompt from "../prompts/editorial/general-setting/v1.md?raw";
import geographyEcologyPrompt from "../prompts/editorial/geography-ecology/v1.md?raw";
import graphCuratorPrompt from "../prompts/editorial/graph-curator/v1.md?raw";
import organizationPrompt from "../prompts/editorial/organization/v1.md?raw";
import sharedPrompt from "../prompts/editorial/shared-v1.md?raw";
import speciesCulturePrompt from "../prompts/editorial/species-culture/v1.md?raw";
import storyArchitectPrompt from "../prompts/editorial/story-architect/v1.md?raw";
import visualDirectorPrompt from "../prompts/editorial/visual-director/v1.md?raw";
import worldDirectorPrompt from "../prompts/editorial/world-director/v1.md?raw";
import worldSystemPrompt from "../prompts/editorial/world-system/v1.md?raw";
import { requireAgentCapability } from "./agentCapabilityRegistry";

export const editorialPromptRegistryVersion = "1.0.0" as const;

export const editorialPromptCapabilityIds = [
  "world_director",
  "world_system_author",
  "geography_ecology_author",
  "civilization_author",
  "organization_author",
  "species_culture_author",
  "character_author",
  "story_architect",
  "general_setting_author",
  "graph_curator",
  "visual_director",
] as const satisfies readonly AgentCapabilityId[];

export type EditorialPromptCapabilityId = typeof editorialPromptCapabilityIds[number];

export interface EditorialPromptAsset {
  capabilityId: EditorialPromptCapabilityId;
  id: string;
  version: `${number}.${number}.${number}`;
  status: "candidate" | "active" | "deprecated";
  sha256: string;
  content: string;
  publicationEvidence: {
    reportPath: string;
    reportSha256: string;
    providerId: string;
    modelId: string;
    evaluatedAt: string;
  } | null;
}

interface ManifestEntry {
  capabilityId: EditorialPromptCapabilityId;
  sha256: string;
}

const roleContent: Record<EditorialPromptCapabilityId, string> = {
  world_director: worldDirectorPrompt,
  world_system_author: worldSystemPrompt,
  geography_ecology_author: geographyEcologyPrompt,
  civilization_author: civilizationPrompt,
  organization_author: organizationPrompt,
  species_culture_author: speciesCulturePrompt,
  character_author: characterPrompt,
  story_architect: storyArchitectPrompt,
  general_setting_author: generalSettingPrompt,
  graph_curator: graphCuratorPrompt,
  visual_director: visualDirectorPrompt,
};

const manifest: readonly ManifestEntry[] = [
  { capabilityId: "world_director", sha256: "3d2b257c03b256788565b0dd55c7a081cfa1675472b785f8a31cd3b20f53417d" },
  { capabilityId: "world_system_author", sha256: "8b87837d7d8bfcaa101aa1dfe33c1a9a7f926cb083cef01da15a20ffb8103581" },
  { capabilityId: "geography_ecology_author", sha256: "46874a7dfa7045ea2717566c6784e94771ef811fb037e99f31acf1a7df3fa81a" },
  { capabilityId: "civilization_author", sha256: "94a1d68fdf5999b18a414102ec0c017e0470b83abf5491650dbc1f9f02a993ea" },
  { capabilityId: "organization_author", sha256: "257da934e969f00c33f999d3decdde545ff04c61dcfd2d25e74caea20132cc58" },
  { capabilityId: "species_culture_author", sha256: "465f1df20e702f4f7a5d3f337f146aad7bd6fded546a44521371611807647531" },
  { capabilityId: "character_author", sha256: "06f6086aa54d890066d20de91a10b86cc45fbd0fbc1755b5eeb4a4980c4dd068" },
  { capabilityId: "story_architect", sha256: "401cfdcbd851a739df4f0623f3e3431351f7f32b9b702d22b156f110c4ae9124" },
  { capabilityId: "general_setting_author", sha256: "ce872ef926c411332a9ed2b0a3c1d6f4846585d7617f17bbc03311ba4927ae82" },
  { capabilityId: "graph_curator", sha256: "cd9a1c77f2dd2d53c7888556e67246b23002d2b6a2734aac8a20819d6fb7108d" },
  { capabilityId: "visual_director", sha256: "c2a8513311e0a622c0d4c5ea8ac3dcf826c3c8f7761bfae797fb920f738cac51" },
] as const;

export function loadCandidateEditorialPrompts(): EditorialPromptAsset[] {
  const prompts = materialize();
  verifyEditorialPromptCandidates(prompts);
  return prompts.map(clonePrompt);
}

export function requireActiveEditorialPrompt(capabilityId: unknown): EditorialPromptAsset {
  const prompts = loadCandidateEditorialPrompts().filter((prompt) => prompt.capabilityId === capabilityId && prompt.status === "active");
  if (prompts.length !== 1) throw promptError("EDITORIAL_PROMPT_NOT_PUBLISHED");
  return clonePrompt(prompts[0]);
}

export function verifyEditorialPromptCandidates(prompts: readonly EditorialPromptAsset[]): { ok: true; verified: number } {
  if (prompts.length !== editorialPromptCapabilityIds.length) throw promptError("EDITORIAL_PROMPT_SET_INCOMPLETE");
  const seen = new Set<EditorialPromptCapabilityId>();
  for (const prompt of prompts) {
    if (seen.has(prompt.capabilityId)) throw promptError("EDITORIAL_PROMPT_IDENTITY_DUPLICATE");
    seen.add(prompt.capabilityId);
    const capability = requireAgentCapability(prompt.capabilityId);
    if (prompt.id !== capability.promptAsset.id || prompt.version !== capability.promptAsset.version) {
      throw promptError("EDITORIAL_PROMPT_CAPABILITY_MISMATCH");
    }
    if (prompt.status !== "candidate" || prompt.publicationEvidence !== null) {
      throw promptError("EDITORIAL_PROMPT_CANDIDATE_SET_REQUIRED");
    }
    if (sha256(prompt.content) !== prompt.sha256) throw promptError("EDITORIAL_PROMPT_INTEGRITY_FAILED");
    if (lintEditorialPrompt(prompt).length > 0) throw promptError("EDITORIAL_PROMPT_STATIC_CONTRACT_FAILED");
  }
  if (editorialPromptCapabilityIds.some((capabilityId) => !seen.has(capabilityId))) {
    throw promptError("EDITORIAL_PROMPT_SET_INCOMPLETE");
  }
  return { ok: true, verified: prompts.length };
}

export function evaluateEditorialPromptCandidates(): {
  classification: "static-contract-lint-not-publication-evidence";
  registryVersion: typeof editorialPromptRegistryVersion;
  cases: Array<{ capabilityId: EditorialPromptCapabilityId; passed: boolean; issues: string[] }>;
} {
  const prompts = materialize();
  return {
    classification: "static-contract-lint-not-publication-evidence",
    registryVersion: editorialPromptRegistryVersion,
    cases: prompts.map((prompt) => {
      const issues = lintEditorialPrompt(prompt);
      return { capabilityId: prompt.capabilityId, passed: issues.length === 0, issues };
    }),
  };
}

export function lintEditorialPrompt(prompt: EditorialPromptAsset): string[] {
  const issues: string[] = [];
  const capability = requireAgentCapability(prompt.capabilityId);
  const required = [
    `# Capability: ${prompt.capabilityId}`,
    capability.terminalSubmissionTool,
    "evidence",
    "只调用一次",
    "思维链",
    "Canon",
  ];
  for (const marker of required) if (!prompt.content.includes(marker)) issues.push(`missing:${marker}`);
  const prohibited = ["API_KEY=", "sk-", "write_database", "propose_change_set"];
  for (const marker of prohibited) if (prompt.content.includes(marker)) issues.push(`prohibited:${marker}`);
  return issues;
}

function materialize(): EditorialPromptAsset[] {
  return manifest.map((entry) => {
    const capability = requireAgentCapability(entry.capabilityId);
    return {
      capabilityId: entry.capabilityId,
      id: capability.promptAsset.id,
      version: capability.promptAsset.version,
      status: "candidate",
      sha256: entry.sha256,
      content: composePrompt(roleContent[entry.capabilityId]),
      publicationEvidence: null,
    };
  });
}

function composePrompt(rolePrompt: string): string {
  return `${sharedPrompt.trim()}\n\n${rolePrompt.trim()}\n`;
}

function clonePrompt(prompt: EditorialPromptAsset): EditorialPromptAsset {
  return { ...prompt, publicationEvidence: prompt.publicationEvidence ? { ...prompt.publicationEvidence } : null };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function promptError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
