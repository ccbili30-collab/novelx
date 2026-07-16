import { AssertionRepository, type SourcedAssertionRecord } from "../graph/assertionRepository";
import { CreativeDocumentRepository, type CreativeDocumentRecord } from "../workspace/creativeDocumentRepository";
import { CreativeRelationRepository, type CreativeRelationRecord } from "../workspace/creativeRelationRepository";
import { DocumentRepository, type DocumentVersionRecord } from "../workspace/documentRepository";
import { ResourceRepository, type ResourceRecord } from "../workspace/resourceRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export const GROWTH_CLOSURE_FACETS = {
  world: {
    resource: "closure.world.structure.resource",
    setting: "closure.world.structure.setting",
    location: "closure.world.structure.location",
    faction: "closure.world.structure.faction",
    cosmologyTime: "closure.world.fact.cosmology_time",
    geographyEnvironment: "closure.world.fact.geography_environment",
    historyTimeline: "closure.world.fact.history_timeline",
    politiesInstitutions: "closure.world.fact.polities_institutions",
    cultureBeliefEconomy: "closure.world.fact.culture_belief_economy",
    powerTechnologyRules: "closure.world.fact.power_technology_rules",
    currentConflicts: "closure.world.fact.current_conflicts",
  },
  story: {
    resource: "closure.story.structure.resource",
    prose: "closure.story.structure.prose",
    usesWorld: "closure.story.structure.uses_world",
    usesOc: "closure.story.structure.uses_oc",
    historicalBackground: "closure.story.fact.historical_background",
    characterOrigins: "closure.story.fact.character_origins",
    incitingConflict: "closure.story.fact.inciting_conflict",
    development: "closure.story.fact.development",
    turningPoints: "closure.story.fact.turning_points",
    stageResolution: "closure.story.fact.stage_resolution",
  },
  oc: {
    resource: "closure.oc.structure.resource",
    profile: "closure.oc.structure.profile",
    relationship: "closure.oc.structure.relationship",
    worldStoryBindings: "closure.oc.structure.world_story_bindings",
    backstory: "closure.oc.fact.backstory",
    personalityMotivation: "closure.oc.fact.personality_motivation",
    abilitiesLimits: "closure.oc.fact.abilities_limits",
    worldInfluence: "closure.oc.fact.world_influence",
    personalStoryBinding: "closure.oc.binding.personal_story",
    personalStory: "closure.oc.structure.personal_story_10000",
  },
} as const;

export type GrowthClosureComponentProfile = "world_birth" | "story_universe" | "oc_saga";
export type GrowthClosureProfileKind = GrowthClosureComponentProfile | "mixed_birth";

export interface GrowthClosureEvaluationInput {
  checkpointId: string;
  profileKind: GrowthClosureProfileKind;
  subjectResourceId?: string | null;
  componentProfiles?: GrowthClosureComponentProfile[];
  focusOcResourceId?: string | null;
}

export interface GrowthClosureFacetEvidence {
  targetKind: "resource" | "document" | "assertion" | "relation";
  targetId: string;
  targetVersionId: string;
}

export interface GrowthClosureFacetEvaluation {
  facetId: string;
  state: "satisfied" | "missing";
  evidence: GrowthClosureFacetEvidence[];
}

export interface GrowthClosureDeterministicEvaluation {
  checkpointId: string;
  components: GrowthClosureComponentProfile[];
  facetResults: GrowthClosureFacetEvaluation[];
  ocPersonalStoryCodePoints: number | null;
  deterministicContentReady: boolean;
}

type Snapshot = {
  resources: ResourceRecord[];
  documents: Array<{ record: CreativeDocumentRecord; version: DocumentVersionRecord }>;
  relations: CreativeRelationRecord[];
  assertions: SourcedAssertionRecord[];
};

/**
 * Evaluates only deterministic, checkpoint-pinned Closure structure.
 * Semantic quality remains the independent Checker's responsibility.
 */
export class GrowthClosureEvaluator {
  constructor(readonly workspace: WorkspaceDatabase) {}

  evaluate(input: GrowthClosureEvaluationInput): GrowthClosureDeterministicEvaluation {
    const normalized = normalizeInput(input);
    const snapshot = this.#snapshot(normalized.checkpointId);
    const results: GrowthClosureFacetEvaluation[] = [];
    let personalStoryCodePoints: number | null = null;

    for (const component of normalized.components) {
      if (component === "world_birth") results.push(...this.#evaluateWorld(snapshot, normalized.checkpointId));
      if (component === "story_universe") results.push(...this.#evaluateStory(snapshot, normalized.checkpointId));
      if (component === "oc_saga") {
        const evaluated = this.#evaluateOc(snapshot, normalized.checkpointId, normalized.focusOcResourceId!);
        results.push(...evaluated.results);
        personalStoryCodePoints = evaluated.codePoints;
      }
    }

    return {
      checkpointId: normalized.checkpointId,
      components: normalized.components,
      facetResults: results,
      ocPersonalStoryCodePoints: personalStoryCodePoints,
      deterministicContentReady: results.length > 0 && results.every((result) => result.state === "satisfied"),
    };
  }

  #snapshot(checkpointId: string): Snapshot {
    const resources = new ResourceRepository(this.workspace).listAtCheckpoint(checkpointId);
    const creativeDocuments = new CreativeDocumentRepository(this.workspace).listAtCheckpoint(checkpointId);
    const documentsRepository = new DocumentRepository(this.workspace);
    const documents = creativeDocuments.flatMap((record) => {
      const version = documentsRepository.getStableForCreativeDocumentAtCheckpoint(record.id, checkpointId);
      return version ? [{ record, version }] : [];
    });
    const relations = new CreativeRelationRepository(this.workspace).listAtCheckpoint(checkpointId);
    const assertions = new AssertionRepository(this.workspace)
      .listCurrentInScopesAtCheckpoint(resources.map((resource) => resource.id), checkpointId)
      .filter((assertion) => assertion.sources.some((source) => (
        source.kind === "document_version"
        && documents.some((document) => document.version.id === source.ref)
      )));
    return { resources, documents, relations, assertions };
  }

  #evaluateWorld(snapshot: Snapshot, checkpointId: string): GrowthClosureFacetEvaluation[] {
    const worlds = snapshot.resources.filter((resource) => resource.objectKind === "world");
    const world = worlds.length === 1 ? worlds[0]! : null;
    const owned = world ? descendantIds(snapshot.resources, world.id) : new Set<string>();
    const settings = snapshot.documents.filter((document) => document.record.kind === "setting" && owned.has(document.record.resourceId));
    const locations = snapshot.resources.filter((resource) => resource.objectKind === "location" && owned.has(resource.id));
    const factions = snapshot.resources.filter((resource) => resource.objectKind === "faction" && owned.has(resource.id));
    const results = [
      structureFacet(GROWTH_CLOSURE_FACETS.world.resource, world ? [resourceEvidence(this.workspace, checkpointId, world.id)] : []),
      structureFacet(GROWTH_CLOSURE_FACETS.world.setting, settings.map(documentEvidence)),
      structureFacet(GROWTH_CLOSURE_FACETS.world.location, locations.map((resource) => resourceEvidence(this.workspace, checkpointId, resource.id))),
      structureFacet(GROWTH_CLOSURE_FACETS.world.faction, factions.map((resource) => resourceEvidence(this.workspace, checkpointId, resource.id))),
    ];
    for (const facetId of worldFactFacetIds) results.push(assertionFacet(facetId, snapshot.assertions, world?.id ?? null));
    return results;
  }

  #evaluateStory(snapshot: Snapshot, checkpointId: string): GrowthClosureFacetEvaluation[] {
    const stories = snapshot.resources.filter((resource) => resource.objectKind === "story");
    const story = stories.length === 1 ? stories[0]! : null;
    const prose = story ? snapshot.documents.filter((document) => document.record.kind === "prose" && document.record.resourceId === story.id) : [];
    const usesWorld = story ? snapshot.relations.filter((relation) => relation.kind === "uses_world" && relation.sourceResourceId === story.id) : [];
    const usesOc = story ? snapshot.relations.filter((relation) => relation.kind === "uses_oc" && relation.sourceResourceId === story.id) : [];
    const results = [
      structureFacet(GROWTH_CLOSURE_FACETS.story.resource, story ? [resourceEvidence(this.workspace, checkpointId, story.id)] : []),
      structureFacet(GROWTH_CLOSURE_FACETS.story.prose, prose.map(documentEvidence)),
      structureFacet(GROWTH_CLOSURE_FACETS.story.usesWorld, usesWorld.map((relation) => relationEvidence(this.workspace, checkpointId, relation.id))),
      structureFacet(GROWTH_CLOSURE_FACETS.story.usesOc, usesOc.map((relation) => relationEvidence(this.workspace, checkpointId, relation.id))),
    ];
    for (const facetId of storyFactFacetIds) results.push(assertionFacet(facetId, snapshot.assertions, story?.id ?? null));
    return results;
  }

  #evaluateOc(snapshot: Snapshot, checkpointId: string, focusOcResourceId: string): {
    results: GrowthClosureFacetEvaluation[];
    codePoints: number;
  } {
    const oc = snapshot.resources.find((resource) => resource.id === focusOcResourceId && resource.objectKind === "oc") ?? null;
    const profiles = oc ? snapshot.documents.filter((document) => document.record.kind === "character_profile" && document.record.resourceId === oc.id) : [];
    const relationships = oc ? snapshot.relations.filter((relation) => relation.kind === "related_to" && (relation.sourceResourceId === oc.id || relation.targetResourceId === oc.id)) : [];
    const storyBindings = oc ? snapshot.relations.filter((relation) => relation.kind === "uses_oc" && relation.targetResourceId === oc.id) : [];
    const boundStoryIds = new Set(storyBindings.map((relation) => relation.sourceResourceId));
    const worldBindings = snapshot.relations.filter((relation) => relation.kind === "uses_world" && boundStoryIds.has(relation.sourceResourceId));
    const personalStoryIds = new Set(snapshot.assertions
      .filter((assertion) => assertion.scopeId === focusOcResourceId && assertion.predicate === GROWTH_CLOSURE_FACETS.oc.personalStoryBinding)
      .map((assertion) => assertion.object.storyResourceId)
      .filter((value): value is string => typeof value === "string" && boundStoryIds.has(value)));
    const personalStoryDocuments = snapshot.documents.filter((document) => (
      document.record.kind === "prose" && personalStoryIds.has(document.record.resourceId)
    ));
    const codePoints = personalStoryDocuments.reduce((sum, document) => sum + Array.from(document.version.content).length, 0);
    const results = [
      structureFacet(GROWTH_CLOSURE_FACETS.oc.resource, oc ? [resourceEvidence(this.workspace, checkpointId, oc.id)] : []),
      structureFacet(GROWTH_CLOSURE_FACETS.oc.profile, profiles.map(documentEvidence)),
      structureFacet(GROWTH_CLOSURE_FACETS.oc.relationship, relationships.map((relation) => relationEvidence(this.workspace, checkpointId, relation.id))),
      structureFacet(GROWTH_CLOSURE_FACETS.oc.worldStoryBindings, [
        ...storyBindings.map((relation) => relationEvidence(this.workspace, checkpointId, relation.id)),
        ...worldBindings.map((relation) => relationEvidence(this.workspace, checkpointId, relation.id)),
      ], storyBindings.length > 0 && worldBindings.length > 0),
    ];
    for (const facetId of ocFactFacetIds) results.push(assertionFacet(facetId, snapshot.assertions, oc?.id ?? null));
    results.push(structureFacet(GROWTH_CLOSURE_FACETS.oc.personalStory, personalStoryDocuments.map(documentEvidence), codePoints >= 10_000));
    return { results, codePoints };
  }
}

const worldFactFacetIds = [
  GROWTH_CLOSURE_FACETS.world.cosmologyTime,
  GROWTH_CLOSURE_FACETS.world.geographyEnvironment,
  GROWTH_CLOSURE_FACETS.world.historyTimeline,
  GROWTH_CLOSURE_FACETS.world.politiesInstitutions,
  GROWTH_CLOSURE_FACETS.world.cultureBeliefEconomy,
  GROWTH_CLOSURE_FACETS.world.powerTechnologyRules,
  GROWTH_CLOSURE_FACETS.world.currentConflicts,
] as const;

const storyFactFacetIds = [
  GROWTH_CLOSURE_FACETS.story.historicalBackground,
  GROWTH_CLOSURE_FACETS.story.characterOrigins,
  GROWTH_CLOSURE_FACETS.story.incitingConflict,
  GROWTH_CLOSURE_FACETS.story.development,
  GROWTH_CLOSURE_FACETS.story.turningPoints,
  GROWTH_CLOSURE_FACETS.story.stageResolution,
] as const;

const ocFactFacetIds = [
  GROWTH_CLOSURE_FACETS.oc.backstory,
  GROWTH_CLOSURE_FACETS.oc.personalityMotivation,
  GROWTH_CLOSURE_FACETS.oc.abilitiesLimits,
  GROWTH_CLOSURE_FACETS.oc.worldInfluence,
] as const;

function normalizeInput(input: GrowthClosureEvaluationInput): {
  checkpointId: string;
  components: GrowthClosureComponentProfile[];
  focusOcResourceId: string | null;
} {
  const checkpointId = normalizeId(input.checkpointId);
  if (!checkpointId || !closureProfileKinds.includes(input.profileKind)) {
    throw evaluatorError("GROWTH_CLOSURE_EVALUATION_INPUT_INVALID");
  }
  if (input.profileKind === "mixed_birth") {
    const components = [...(input.componentProfiles ?? [])];
    if (
      components.length === 0
      || components.length > closureComponentProfiles.length
      || components.some((component) => !closureComponentProfiles.includes(component))
      || new Set(components).size !== components.length
      || normalizeId(input.subjectResourceId) !== null
    ) {
      throw evaluatorError("GROWTH_CLOSURE_EVALUATION_INPUT_INVALID");
    }
    const needsOc = components.includes("oc_saga");
    const focus = normalizeId(input.focusOcResourceId);
    if (needsOc !== (focus !== null)) throw evaluatorError("GROWTH_CLOSURE_EVALUATION_INPUT_INVALID");
    return { checkpointId, components, focusOcResourceId: focus };
  }
  if ((input.componentProfiles?.length ?? 0) > 0 || normalizeId(input.focusOcResourceId) !== null) {
    throw evaluatorError("GROWTH_CLOSURE_EVALUATION_INPUT_INVALID");
  }
  const subject = normalizeId(input.subjectResourceId);
  if (input.profileKind === "oc_saga" && !subject) throw evaluatorError("GROWTH_CLOSURE_EVALUATION_INPUT_INVALID");
  if (input.profileKind !== "oc_saga" && subject) throw evaluatorError("GROWTH_CLOSURE_EVALUATION_INPUT_INVALID");
  return { checkpointId, components: [input.profileKind], focusOcResourceId: subject };
}

const closureComponentProfiles: readonly GrowthClosureComponentProfile[] = ["world_birth", "story_universe", "oc_saga"];
const closureProfileKinds: readonly GrowthClosureProfileKind[] = [...closureComponentProfiles, "mixed_birth"];

function normalizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 240 ? normalized : null;
}

function structureFacet(
  facetId: string,
  evidence: GrowthClosureFacetEvidence[],
  satisfied = evidence.length > 0,
): GrowthClosureFacetEvaluation {
  return { facetId, state: satisfied ? "satisfied" : "missing", evidence: satisfied ? evidence : [] };
}

function assertionFacet(facetId: string, assertions: SourcedAssertionRecord[], scopeId: string | null): GrowthClosureFacetEvaluation {
  const matches = scopeId ? assertions.filter((assertion) => (
    assertion.scopeId === scopeId && assertion.subject === scopeId && assertion.predicate === facetId
  )) : [];
  return structureFacet(facetId, matches.map((assertion) => ({
    targetKind: "assertion",
    targetId: assertion.assertionId,
    targetVersionId: assertion.versionId,
  })));
}

function documentEvidence(document: { record: CreativeDocumentRecord; version: DocumentVersionRecord }): GrowthClosureFacetEvidence {
  return { targetKind: "document", targetId: document.record.id, targetVersionId: document.version.id };
}

function resourceEvidence(workspace: WorkspaceDatabase, checkpointId: string, resourceId: string): GrowthClosureFacetEvidence {
  return { targetKind: "resource", targetId: resourceId, targetVersionId: currentVersionId(workspace, "resource", resourceId, checkpointId) };
}

function relationEvidence(workspace: WorkspaceDatabase, checkpointId: string, relationId: string): GrowthClosureFacetEvidence {
  return { targetKind: "relation", targetId: relationId, targetVersionId: currentVersionId(workspace, "relation", relationId, checkpointId) };
}

function currentVersionId(workspace: WorkspaceDatabase, kind: "resource" | "relation", id: string, checkpointId: string): string {
  const table = kind === "resource" ? "resource_revisions" : "creative_relation_versions";
  const identity = kind === "resource" ? "resource_id" : "relation_id";
  const row = workspace.db.prepare(`
    WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
      SELECT ?, 0 UNION ALL
      SELECT checkpoints.parent_checkpoint_id, ancestry.depth + 1
      FROM checkpoints JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
      WHERE checkpoints.parent_checkpoint_id IS NOT NULL
    )
    SELECT versions.id FROM ${table} versions
    JOIN ancestry ON ancestry.checkpoint_id = versions.created_checkpoint_id
    WHERE versions.${identity} = ?
    ORDER BY ancestry.depth ASC, versions.created_at DESC, versions.rowid DESC LIMIT 1
  `).get(checkpointId, id) as { id?: unknown } | undefined;
  if (typeof row?.id !== "string") throw evaluatorError("GROWTH_CLOSURE_EVIDENCE_NOT_PINNED");
  return row.id;
}

function descendantIds(resources: ResourceRecord[], rootId: string): Set<string> {
  const result = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const resource of resources) {
      if (resource.parentId && result.has(resource.parentId) && !result.has(resource.id)) {
        result.add(resource.id);
        changed = true;
      }
    }
  }
  return result;
}

function evaluatorError(code: "GROWTH_CLOSURE_EVALUATION_INPUT_INVALID" | "GROWTH_CLOSURE_EVIDENCE_NOT_PINNED"): Error & { code: string } {
  return Object.assign(new Error("Growth Closure evaluation is invalid."), { code });
}
