import { z } from "zod";

export const agentCapabilityIds = [
  "world_director",
  "world_system_author",
  "geography_ecology_author",
  "civilization_author",
  "organization_author",
  "species_culture_author",
  "character_author",
  "story_architect",
  "writer",
  "general_setting_author",
  "graph_curator",
  "visual_director",
  "checker",
  "gm",
  "decomposer",
] as const;

export const agentCapabilityIdSchema = z.enum(agentCapabilityIds);
export type AgentCapabilityId = z.infer<typeof agentCapabilityIdSchema>;
