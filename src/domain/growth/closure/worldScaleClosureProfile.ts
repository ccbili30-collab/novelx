export const WORLD_SCALE_DEFAULT_REQUIREMENTS = Object.freeze({
  worlds: 1,
  macroRegions: 3,
  polityOrCivilizationGroups: 4,
  representedMacroRegions: 2,
  eras: 4,
  historicalTurningPoints: 3,
  crossSystemCausalMechanisms: 4,
});

export const WORLD_SCALE_GEOGRAPHY_ROLES = [
  "mountain_system", "sea", "river", "transport_network", "resource_distribution",
] as const;

export const WORLD_SCALE_SYSTEMS = [
  "geography", "ecology", "economy", "polity", "culture", "history", "technology", "magic", "character", "story",
] as const;

export type WorldScaleEntityRole =
  | "macro_region"
  | (typeof WORLD_SCALE_GEOGRAPHY_ROLES)[number]
  | "polity"
  | "civilization_group";

export interface WorldScaleClosureProjection {
  worldRefs: string[];
  entityRoles: Array<{
    entityRef: string;
    role: WorldScaleEntityRole;
    macroRegionRef: string | null;
    evidenceRefs: string[];
  }>;
  eras: Array<{ ref: string; evidenceRefs: string[] }>;
  historicalTurningPoints: Array<{ ref: string; evidenceRefs: string[] }>;
  causalMechanisms: Array<{ ref: string; systemRefs: string[]; evidenceRefs: string[] }>;
}

export type WorldScaleClosureFacetId =
  | "world_count"
  | "macro_regions"
  | "polity_civilization_groups"
  | "geography_mountains"
  | "geography_seas"
  | "geography_rivers"
  | "transport"
  | "resource_distribution"
  | "historical_eras"
  | "historical_turning_points"
  | "cross_system_causal_mechanisms";

export interface WorldScaleClosureFacetResult {
  facetId: WorldScaleClosureFacetId;
  state: "satisfied" | "missing";
  required: number;
  actual: number;
  evidenceRefs: string[];
}

export interface WorldScaleClosureEvaluation {
  ready: boolean;
  facets: WorldScaleClosureFacetResult[];
}

export function evaluateWorldScaleClosure(input: WorldScaleClosureProjection): WorldScaleClosureEvaluation {
  validateProjection(input);
  const macroRegions = input.entityRoles.filter((item) => item.role === "macro_region");
  const macroRegionRefs = new Set(macroRegions.map((item) => item.entityRef));
  const groups = input.entityRoles.filter((item) => item.role === "polity" || item.role === "civilization_group");
  const representedRegions = new Set(groups.map((item) => item.macroRegionRef).filter((value): value is string => value !== null));
  const facets: WorldScaleClosureFacetResult[] = [
    exactFacet("world_count", WORLD_SCALE_DEFAULT_REQUIREMENTS.worlds, input.worldRefs),
    minimumFacet("macro_regions", WORLD_SCALE_DEFAULT_REQUIREMENTS.macroRegions, macroRegions.length, macroRegions.flatMap(evidenceForRole)),
    combinedGroupFacet(groups, representedRegions.size),
    roleFacet("geography_mountains", "mountain_system", input.entityRoles),
    roleFacet("geography_seas", "sea", input.entityRoles),
    roleFacet("geography_rivers", "river", input.entityRoles),
    roleFacet("transport", "transport_network", input.entityRoles),
    roleFacet("resource_distribution", "resource_distribution", input.entityRoles),
    minimumFacet("historical_eras", WORLD_SCALE_DEFAULT_REQUIREMENTS.eras, input.eras.length, input.eras.flatMap((item) => item.evidenceRefs)),
    minimumFacet("historical_turning_points", WORLD_SCALE_DEFAULT_REQUIREMENTS.historicalTurningPoints, input.historicalTurningPoints.length, input.historicalTurningPoints.flatMap((item) => item.evidenceRefs)),
    minimumFacet("cross_system_causal_mechanisms", WORLD_SCALE_DEFAULT_REQUIREMENTS.crossSystemCausalMechanisms, input.causalMechanisms.length, input.causalMechanisms.flatMap((item) => item.evidenceRefs)),
  ];
  if (groups.some((item) => item.macroRegionRef === null || !macroRegionRefs.has(item.macroRegionRef))) {
    throw profileError("WORLD_SCALE_GROUP_REGION_INVALID");
  }
  return { ready: facets.every((facet) => facet.state === "satisfied"), facets };
}

function combinedGroupFacet(
  groups: WorldScaleClosureProjection["entityRoles"],
  representedRegionCount: number,
): WorldScaleClosureFacetResult {
  const actual = Math.min(
    groups.length / WORLD_SCALE_DEFAULT_REQUIREMENTS.polityOrCivilizationGroups,
    representedRegionCount / WORLD_SCALE_DEFAULT_REQUIREMENTS.representedMacroRegions,
  );
  const satisfied = actual >= 1;
  return {
    facetId: "polity_civilization_groups",
    state: satisfied ? "satisfied" : "missing",
    required: WORLD_SCALE_DEFAULT_REQUIREMENTS.polityOrCivilizationGroups,
    actual: groups.length,
    evidenceRefs: satisfied ? unique(groups.flatMap(evidenceForRole)) : [],
  };
}

function roleFacet(
  facetId: WorldScaleClosureFacetId,
  role: WorldScaleEntityRole,
  roles: WorldScaleClosureProjection["entityRoles"],
): WorldScaleClosureFacetResult {
  const matches = roles.filter((item) => item.role === role);
  return minimumFacet(facetId, 1, matches.length, matches.flatMap(evidenceForRole));
}

function exactFacet(facetId: WorldScaleClosureFacetId, required: number, refs: string[]): WorldScaleClosureFacetResult {
  const satisfied = refs.length === required;
  return { facetId, state: satisfied ? "satisfied" : "missing", required, actual: refs.length, evidenceRefs: satisfied ? unique(refs) : [] };
}

function minimumFacet(facetId: WorldScaleClosureFacetId, required: number, actual: number, refs: string[]): WorldScaleClosureFacetResult {
  const evidenceRefs = unique(refs);
  const satisfied = actual >= required;
  return { facetId, state: satisfied ? "satisfied" : "missing", required, actual, evidenceRefs: satisfied ? evidenceRefs : [] };
}

function evidenceForRole(item: WorldScaleClosureProjection["entityRoles"][number]): string[] {
  return item.evidenceRefs;
}

function validateProjection(input: WorldScaleClosureProjection): void {
  const allRefs = [
    ...input.worldRefs,
    ...input.entityRoles.map((item) => item.entityRef),
    ...input.eras.map((item) => item.ref),
    ...input.historicalTurningPoints.map((item) => item.ref),
    ...input.causalMechanisms.map((item) => item.ref),
  ];
  if (allRefs.some((value) => !validRef(value)) || new Set(allRefs).size !== allRefs.length) {
    throw profileError("WORLD_SCALE_PROJECTION_IDENTITY_INVALID");
  }
  for (const collection of [input.entityRoles, input.eras, input.historicalTurningPoints, input.causalMechanisms]) {
    if (collection.some((item) => item.evidenceRefs.length === 0 || item.evidenceRefs.some((ref) => !validRef(ref)))) {
      throw profileError("WORLD_SCALE_EVIDENCE_REQUIRED");
    }
  }
  if (input.causalMechanisms.some((item) => unique(item.systemRefs).length < 2
    || item.systemRefs.some((system) => !(WORLD_SCALE_SYSTEMS as readonly string[]).includes(system)))) {
    throw profileError("WORLD_SCALE_CAUSAL_MECHANISM_NOT_CROSS_SYSTEM");
  }
}

function validRef(value: string): boolean { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 240; }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function profileError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
