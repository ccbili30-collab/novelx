import { Type } from "typebox";
import { z } from "zod";

export const growthEditorialContractVersion = "1.0.0" as const;

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

const boundedIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const persistedIdSchema = z.string().trim().min(1).max(240);
const boundedTextSchema = z.string().trim().min(1).max(4_000);
const summarySchema = z.string().trim().min(1).max(2_000);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const artifactRefSchema = z.string().regex(/^@artifact[1-9][0-9]*$/);
const evidenceRefSchema = z.string().regex(/^@evidence[1-9][0-9]*$/);
const scopeRefSchema = z.string().regex(/^@(resource|document|assertion|relation)[1-9][0-9]*$/);
const sourceRefSchema = z.string().regex(/^@(document|evidence)[1-9][0-9]*$/);
const graphEntityRefSchema = z.string().regex(/^(?:@(resource|assertion|evidence)[1-9][0-9]*|local:[a-z][a-z0-9_-]{0,79})$/);

const uniqueStrings = (values: readonly string[], context: z.RefinementCtx, path: PropertyKey): void => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path: [path], message: "Values must be unique." });
  }
};

export const acceptanceFacetSchema = z.object({
  id: boundedIdSchema,
  description: boundedTextSchema,
  required: z.boolean(),
}).strict();

export const workOrderDefinitionSchema = z.object({
  id: boundedIdSchema,
  objective: boundedTextSchema,
  sourceCheckpointId: persistedIdSchema,
  scopeRefs: z.array(scopeRefSchema).min(1).max(100),
  capability: agentCapabilityIdSchema,
  acceptanceFacets: z.array(acceptanceFacetSchema).min(1).max(50),
  dependencies: z.array(boundedIdSchema).max(19),
}).strict().superRefine((value, context) => {
  uniqueStrings(value.scopeRefs, context, "scopeRefs");
  uniqueStrings(value.dependencies, context, "dependencies");
  uniqueStrings(value.acceptanceFacets.map((facet) => facet.id), context, "acceptanceFacets");
  if (value.dependencies.includes(value.id)) {
    context.addIssue({ code: "custom", path: ["dependencies"], message: "A Work Order cannot depend on itself." });
  }
});

export type WorkOrderDefinition = z.infer<typeof workOrderDefinitionSchema>;

export const editorialRoundPlanSchema = z.object({
  id: boundedIdSchema,
  goalId: persistedIdSchema,
  sourceCheckpointId: persistedIdSchema,
  workOrders: z.array(workOrderDefinitionSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  const orderIndex = new Map<string, number>();
  for (let index = 0; index < value.workOrders.length; index += 1) {
    const order = value.workOrders[index];
    if (orderIndex.has(order.id)) {
      context.addIssue({ code: "custom", path: ["workOrders", index, "id"], message: "Work Order IDs must be unique." });
      continue;
    }
    if (order.sourceCheckpointId !== value.sourceCheckpointId) {
      context.addIssue({ code: "custom", path: ["workOrders", index, "sourceCheckpointId"], message: "Every Work Order must pin the round checkpoint." });
    }
    const dependencyPositions = order.dependencies.map((dependency, dependencyIndex) => {
      const position = orderIndex.get(dependency);
      if (position === undefined) {
        context.addIssue({
          code: "custom",
          path: ["workOrders", index, "dependencies", dependencyIndex],
          message: "Dependencies must reference an earlier Work Order in the same round.",
        });
        return Number.MAX_SAFE_INTEGER;
      }
      return position;
    });
    const canonicalPositions = [...dependencyPositions].sort((left, right) => left - right);
    if (dependencyPositions.some((position, dependencyIndex) => position !== canonicalPositions[dependencyIndex])) {
      context.addIssue({
        code: "custom",
        path: ["workOrders", index, "dependencies"],
        message: "Dependencies must follow canonical round order.",
      });
    }
    orderIndex.set(order.id, index);
  }
});

export type EditorialRoundPlan = z.infer<typeof editorialRoundPlanSchema>;

export const declaredCoverageSchema = z.object({
  facetId: boundedIdSchema,
  state: z.enum(["covered", "partial", "missing"]),
  evidenceRefs: z.array(evidenceRefSchema).max(20),
}).strict().superRefine((value, context) => uniqueStrings(value.evidenceRefs, context, "evidenceRefs"));

const specialistCandidateReadySchema = z.object({
  status: z.literal("ready"),
  summary: summarySchema,
  contentArtifactRefs: z.array(artifactRefSchema).min(1).max(20),
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(100),
  coverage: z.array(declaredCoverageSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  uniqueStrings(value.contentArtifactRefs, context, "contentArtifactRefs");
  uniqueStrings(value.evidenceRefs, context, "evidenceRefs");
  uniqueStrings(value.coverage.map((facet) => facet.facetId), context, "coverage");
  if (value.coverage.some((facet) => facet.state === "missing")) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "A ready candidate cannot declare missing coverage." });
  }
});

const specialistCandidateNeedsEvidenceSchema = z.object({
  status: z.literal("needs_more_evidence"),
  summary: summarySchema,
  evidenceRefs: z.array(evidenceRefSchema).max(100),
  coverage: z.array(declaredCoverageSchema).min(1).max(50),
  missingEvidenceQueries: z.array(z.string().trim().min(1).max(1_000)).min(1).max(10),
}).strict().superRefine((value, context) => {
  uniqueStrings(value.evidenceRefs, context, "evidenceRefs");
  uniqueStrings(value.coverage.map((facet) => facet.facetId), context, "coverage");
  uniqueStrings(value.missingEvidenceQueries, context, "missingEvidenceQueries");
  if (!value.coverage.some((facet) => facet.state !== "covered")) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "Evidence requests require an incomplete facet." });
  }
});

export const specialistCandidateSchema = z.discriminatedUnion("status", [
  specialistCandidateReadySchema,
  specialistCandidateNeedsEvidenceSchema,
]);

export type SpecialistCandidate = z.infer<typeof specialistCandidateSchema>;

export const exactSourceLocatorSchema = z.object({
  sourceRef: sourceRefSchema,
  startCodePoint: z.number().int().min(0).max(10_000_000),
  endCodePoint: z.number().int().min(1).max(10_000_000),
  sourceTextSha256: sha256Schema,
}).strict().refine((value) => value.endCodePoint > value.startCodePoint, {
  path: ["endCodePoint"],
  message: "Source range must be non-empty.",
});

export const graphCuratorAssertionSchema = z.object({
  localId: boundedIdSchema,
  subjectRef: graphEntityRefSchema,
  predicate: z.string().trim().min(1).max(240),
  object: z.record(z.string().min(1).max(240), z.json()),
  sourceLocators: z.array(exactSourceLocatorSchema).min(1).max(20),
}).strict();

export const graphCuratorCausalLinkSchema = z.object({
  localId: boundedIdSchema,
  causeRef: graphEntityRefSchema,
  effectRef: graphEntityRefSchema,
  mechanism: z.string().trim().min(1).max(2_000),
  conditions: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
  temporalScope: z.string().trim().min(1).max(1_000),
  epistemicStatus: z.enum(["confirmed", "disputed", "inferred", "unknown"]),
  sourceLocators: z.array(exactSourceLocatorSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  if (value.causeRef === value.effectRef) {
    context.addIssue({ code: "custom", path: ["effectRef"], message: "A causal link cannot point to itself." });
  }
  uniqueStrings(value.conditions, context, "conditions");
});

export const graphCuratorCandidateSchema = z.object({
  summary: summarySchema,
  assertions: z.array(graphCuratorAssertionSchema).max(200),
  causalLinks: z.array(graphCuratorCausalLinkSchema).max(200),
}).strict().superRefine((value, context) => {
  if (value.assertions.length + value.causalLinks.length === 0) {
    context.addIssue({ code: "custom", message: "Graph Curator must return at least one sourced candidate." });
  }
  uniqueStrings([...value.assertions, ...value.causalLinks].map((item) => item.localId), context, "assertions");
});

export type GraphCuratorCandidate = z.infer<typeof graphCuratorCandidateSchema>;

export const checkerFindingSchema = z.object({
  facetId: boundedIdSchema,
  severity: z.enum(["minor", "major", "blocking"]),
  category: z.enum(["fact_conflict", "causality", "source", "coverage"]),
  summary: summarySchema,
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(20),
}).strict().superRefine((value, context) => uniqueStrings(value.evidenceRefs, context, "evidenceRefs"));

export const checkerReviewSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("passed"), summary: summarySchema, findings: z.tuple([]) }).strict(),
  z.object({ decision: z.literal("findings"), summary: summarySchema, findings: z.array(checkerFindingSchema).min(1).max(20) }).strict(),
  z.object({ decision: z.literal("blocked"), summary: summarySchema, findings: z.array(checkerFindingSchema).min(1).max(20) }).strict(),
]);

export type CheckerReview = z.infer<typeof checkerReviewSchema>;

const editorialReasonSchema = z.object({
  facetId: boundedIdSchema,
  reason: summarySchema,
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(20),
}).strict();

export const directorReviewSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("accept"),
    reasons: z.array(editorialReasonSchema).min(1).max(10),
  }).strict(),
  z.object({
    decision: z.literal("revise"),
    reasons: z.array(editorialReasonSchema).min(1).max(10),
    revisionObjective: boundedTextSchema,
  }).strict(),
  z.object({
    decision: z.literal("ask_user"),
    reasons: z.array(editorialReasonSchema).min(1).max(10),
    question: z.string().trim().min(1).max(2_000),
  }).strict(),
]);

export type DirectorReview = z.infer<typeof directorReviewSchema>;

const boundedIdParameter = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" });
const persistedIdParameter = Type.String({ minLength: 1, maxLength: 240 });
const boundedTextParameter = Type.String({ minLength: 1, maxLength: 4_000 });
const summaryParameter = Type.String({ minLength: 1, maxLength: 2_000 });
const artifactRefParameter = Type.String({ pattern: "^@artifact[1-9][0-9]*$" });
const evidenceRefParameter = Type.String({ pattern: "^@evidence[1-9][0-9]*$" });
const scopeRefParameter = Type.String({ pattern: "^@(resource|document|assertion|relation)[1-9][0-9]*$" });
const sourceRefParameter = Type.String({ pattern: "^@(document|evidence)[1-9][0-9]*$" });
const graphEntityRefParameter = Type.String({ pattern: "^(?:@(resource|assertion|evidence)[1-9][0-9]*|local:[a-z][a-z0-9_-]{0,79})$" });
const sha256Parameter = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const agentCapabilityIdParameters = Type.Union([
  Type.Literal("world_director"), Type.Literal("world_system_author"), Type.Literal("geography_ecology_author"),
  Type.Literal("civilization_author"), Type.Literal("organization_author"), Type.Literal("species_culture_author"),
  Type.Literal("character_author"), Type.Literal("story_architect"), Type.Literal("writer"),
  Type.Literal("general_setting_author"), Type.Literal("graph_curator"), Type.Literal("visual_director"),
  Type.Literal("checker"), Type.Literal("gm"), Type.Literal("decomposer"),
]);

const acceptanceFacetParameters = Type.Object({
  id: boundedIdParameter,
  description: boundedTextParameter,
  required: Type.Boolean(),
}, { additionalProperties: false });

export const workOrderDefinitionParameters = Type.Object({
  id: boundedIdParameter,
  objective: boundedTextParameter,
  sourceCheckpointId: persistedIdParameter,
  scopeRefs: Type.Array(scopeRefParameter, { minItems: 1, maxItems: 100, uniqueItems: true }),
  capability: agentCapabilityIdParameters,
  acceptanceFacets: Type.Array(acceptanceFacetParameters, { minItems: 1, maxItems: 50 }),
  dependencies: Type.Array(boundedIdParameter, { maxItems: 19, uniqueItems: true }),
}, { additionalProperties: false });

export const editorialRoundPlanParameters = Type.Object({
  id: boundedIdParameter,
  goalId: persistedIdParameter,
  sourceCheckpointId: persistedIdParameter,
  workOrders: Type.Array(workOrderDefinitionParameters, { minItems: 1, maxItems: 20 }),
}, { additionalProperties: false });

const declaredCoverageParameters = Type.Object({
  facetId: boundedIdParameter,
  state: Type.Union([Type.Literal("covered"), Type.Literal("partial"), Type.Literal("missing")]),
  evidenceRefs: Type.Array(evidenceRefParameter, { maxItems: 20, uniqueItems: true }),
}, { additionalProperties: false });

export const specialistCandidateParameters = Type.Union([
  Type.Object({
    status: Type.Literal("ready"),
    summary: summaryParameter,
    contentArtifactRefs: Type.Array(artifactRefParameter, { minItems: 1, maxItems: 20, uniqueItems: true }),
    evidenceRefs: Type.Array(evidenceRefParameter, { minItems: 1, maxItems: 100, uniqueItems: true }),
    coverage: Type.Array(declaredCoverageParameters, { minItems: 1, maxItems: 50 }),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("needs_more_evidence"),
    summary: summaryParameter,
    evidenceRefs: Type.Array(evidenceRefParameter, { maxItems: 100, uniqueItems: true }),
    coverage: Type.Array(declaredCoverageParameters, { minItems: 1, maxItems: 50 }),
    missingEvidenceQueries: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 10, uniqueItems: true }),
  }, { additionalProperties: false }),
]);

const exactSourceLocatorParameters = Type.Object({
  sourceRef: sourceRefParameter,
  startCodePoint: Type.Integer({ minimum: 0, maximum: 10_000_000 }),
  endCodePoint: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  sourceTextSha256: sha256Parameter,
}, { additionalProperties: false });

const graphCuratorAssertionParameters = Type.Object({
  localId: boundedIdParameter,
  subjectRef: graphEntityRefParameter,
  predicate: Type.String({ minLength: 1, maxLength: 240 }),
  object: Type.Object({}, { additionalProperties: true }),
  sourceLocators: Type.Array(exactSourceLocatorParameters, { minItems: 1, maxItems: 20 }),
}, { additionalProperties: false });

const graphCuratorCausalLinkParameters = Type.Object({
  localId: boundedIdParameter,
  causeRef: graphEntityRefParameter,
  effectRef: graphEntityRefParameter,
  mechanism: Type.String({ minLength: 1, maxLength: 2_000 }),
  conditions: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 20, uniqueItems: true }),
  temporalScope: Type.String({ minLength: 1, maxLength: 1_000 }),
  epistemicStatus: Type.Union([
    Type.Literal("confirmed"), Type.Literal("disputed"), Type.Literal("inferred"), Type.Literal("unknown"),
  ]),
  sourceLocators: Type.Array(exactSourceLocatorParameters, { minItems: 1, maxItems: 20 }),
}, { additionalProperties: false });

export const graphCuratorCandidateParameters = Type.Object({
  summary: summaryParameter,
  assertions: Type.Array(graphCuratorAssertionParameters, { maxItems: 200 }),
  causalLinks: Type.Array(graphCuratorCausalLinkParameters, { maxItems: 200 }),
}, { additionalProperties: false });

const checkerFindingParameters = Type.Object({
  facetId: boundedIdParameter,
  severity: Type.Union([Type.Literal("minor"), Type.Literal("major"), Type.Literal("blocking")]),
  category: Type.Union([
    Type.Literal("fact_conflict"), Type.Literal("causality"), Type.Literal("source"), Type.Literal("coverage"),
  ]),
  summary: summaryParameter,
  evidenceRefs: Type.Array(evidenceRefParameter, { minItems: 1, maxItems: 20, uniqueItems: true }),
}, { additionalProperties: false });

export const checkerReviewParameters = Type.Union([
  Type.Object({ decision: Type.Literal("passed"), summary: summaryParameter, findings: Type.Tuple([]) }, { additionalProperties: false }),
  Type.Object({ decision: Type.Literal("findings"), summary: summaryParameter, findings: Type.Array(checkerFindingParameters, { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
  Type.Object({ decision: Type.Literal("blocked"), summary: summaryParameter, findings: Type.Array(checkerFindingParameters, { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
]);

const editorialReasonParameters = Type.Object({
  facetId: boundedIdParameter,
  reason: summaryParameter,
  evidenceRefs: Type.Array(evidenceRefParameter, { minItems: 1, maxItems: 20, uniqueItems: true }),
}, { additionalProperties: false });

export const directorReviewParameters = Type.Union([
  Type.Object({
    decision: Type.Literal("accept"),
    reasons: Type.Array(editorialReasonParameters, { minItems: 1, maxItems: 10 }),
  }, { additionalProperties: false }),
  Type.Object({
    decision: Type.Literal("revise"),
    reasons: Type.Array(editorialReasonParameters, { minItems: 1, maxItems: 10 }),
    revisionObjective: boundedTextParameter,
  }, { additionalProperties: false }),
  Type.Object({
    decision: Type.Literal("ask_user"),
    reasons: Type.Array(editorialReasonParameters, { minItems: 1, maxItems: 10 }),
    question: Type.String({ minLength: 1, maxLength: 2_000 }),
  }, { additionalProperties: false }),
]);
