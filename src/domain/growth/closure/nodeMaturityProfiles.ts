import { z } from "zod";

export const NODE_IMPORTANCE_TIERS = ["core", "major", "supporting", "background"] as const;
export type NodeImportanceTier = (typeof NODE_IMPORTANCE_TIERS)[number];

export const NODE_MATURITY_KINDS = [
  "oc", "nation", "organization", "geography", "species", "civilization", "story", "world",
] as const;
export type NodeMaturityKind = (typeof NODE_MATURITY_KINDS)[number];

const nationCivilizationDimensions = [
  "territory", "population", "institutions", "economy", "class_structure", "culture", "faith",
  "technology_or_magic", "military", "diplomacy", "history", "internal_conflicts", "resources",
  "daily_life", "symbols", "causal_dependencies",
] as const;

export const NODE_MATURITY_PROFILES: Readonly<Record<NodeMaturityKind, readonly string[]>> = Object.freeze({
  oc: Object.freeze([
    "identity", "origin", "family_or_class", "formative_events", "abilities_and_limits", "desires_and_fears",
    "contradiction", "worldview", "habits", "relationships", "secrets", "arc", "world_impact", "personal_causal_history",
  ]),
  nation: Object.freeze([...nationCivilizationDimensions]),
  organization: Object.freeze([
    "purpose", "legitimacy", "hierarchy", "recruitment", "resources", "operations", "internal_factions",
    "allies_and_enemies", "public_image", "secrets", "history", "failure_pressure",
  ]),
  geography: Object.freeze([
    "formation", "terrain", "climate", "hydrology", "ecology", "resources", "hazards", "settlement",
    "transport", "strategic_meaning", "cultural_meaning", "historical_effects",
  ]),
  species: Object.freeze([
    "origin", "biology", "lifecycle", "diversity", "environment", "subsistence", "family", "law", "faith",
    "language", "aesthetics", "conflict", "history", "relations",
  ]),
  civilization: Object.freeze([...nationCivilizationDimensions]),
  story: Object.freeze([
    "historical_preconditions", "inciting_cause", "actors_prior_histories", "regional_movement",
    "escalating_consequences", "reversals", "resolution_pressure", "world_feedback",
  ]),
  world: Object.freeze([
    "origin", "astronomy", "geography", "eras", "global_systems", "civilizations", "unresolved_tensions", "cross_system_causes",
  ]),
});

const maturityEvaluationInputSchema = z.object({
  nodeId: z.string().trim().min(1).max(240),
  nodeKind: z.enum(NODE_MATURITY_KINDS),
  importanceTier: z.enum(NODE_IMPORTANCE_TIERS),
  coverage: z.array(z.object({
    dimensionId: z.string().trim().min(1).max(120),
    evidenceRefs: z.array(z.string().trim().min(1).max(240)).min(1).max(100),
  }).strict()).max(100),
}).strict();

export interface NodeMaturityDimensionResult {
  dimensionId: string;
  state: "covered" | "missing";
  evidenceRefs: string[];
}

export interface NodeMaturityEvaluation {
  nodeId: string;
  nodeKind: NodeMaturityKind;
  importanceTier: NodeImportanceTier;
  policy: "coverage_criteria";
  fullDepthRequired: boolean;
  fullDepthReady: boolean;
  blocksConvergence: boolean;
  dimensions: NodeMaturityDimensionResult[];
  blockingMissingDimensionIds: string[];
}

export function evaluateNodeMaturity(rawInput: unknown): NodeMaturityEvaluation {
  const parsed = maturityEvaluationInputSchema.safeParse(rawInput);
  if (!parsed.success) throw maturityError("NODE_MATURITY_INPUT_INVALID");
  const input = parsed.data;
  const profile = NODE_MATURITY_PROFILES[input.nodeKind];
  const coverageIds = input.coverage.map((item) => item.dimensionId);
  if (new Set(coverageIds).size !== coverageIds.length) throw maturityError("NODE_MATURITY_COVERAGE_DUPLICATED");
  if (coverageIds.some((id) => !profile.includes(id))) throw maturityError("NODE_MATURITY_DIMENSION_UNAUTHORIZED");
  if (input.coverage.some((item) => new Set(item.evidenceRefs).size !== item.evidenceRefs.length)) {
    throw maturityError("NODE_MATURITY_EVIDENCE_DUPLICATED");
  }
  const coverage = new Map(input.coverage.map((item) => [item.dimensionId, item.evidenceRefs]));
  const dimensions = profile.map((dimensionId): NodeMaturityDimensionResult => {
    const evidenceRefs = coverage.get(dimensionId) ?? [];
    return { dimensionId, state: evidenceRefs.length > 0 ? "covered" : "missing", evidenceRefs: [...evidenceRefs] };
  });
  const missing = dimensions.filter((item) => item.state === "missing").map((item) => item.dimensionId);
  const fullDepthRequired = input.importanceTier === "core" || input.importanceTier === "major";
  return {
    nodeId: input.nodeId,
    nodeKind: input.nodeKind,
    importanceTier: input.importanceTier,
    policy: "coverage_criteria",
    fullDepthRequired,
    fullDepthReady: missing.length === 0,
    blocksConvergence: fullDepthRequired && missing.length > 0,
    dimensions,
    blockingMissingDimensionIds: fullDepthRequired ? missing : [],
  };
}

export function promoteNodeImportance(current: NodeImportanceTier, target: NodeImportanceTier): NodeImportanceTier {
  const rank: Record<NodeImportanceTier, number> = { background: 0, supporting: 1, major: 2, core: 3 };
  if (!(current in rank) || !(target in rank) || rank[target] <= rank[current]) {
    throw maturityError("NODE_MATURITY_PROMOTION_INVALID");
  }
  return target;
}

function maturityError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
