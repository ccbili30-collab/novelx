import { z } from "zod";
import { createHash } from "node:crypto";
import { graphCuratorSubmissionSchema } from "../../../agent-worker/editorial/graphCuratorContracts";
import { specialistSubmissionSchema } from "../../../agent-worker/editorial/specialistContracts";

const idSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const resourceRefSchema = z.string().regex(/^@resource[1-9][0-9]*$/);
const artifactRefSchema = z.string().regex(/^@artifact[1-9][0-9]*$/);
const evidenceRefSchema = z.string().regex(/^@evidence[1-9][0-9]*$/);
const assertionRefSchema = z.string().regex(/^@assertion[1-9][0-9]*$/);

const resourceBindingSchema = z.object({
  ref: resourceRefSchema,
  resourceId: idSchema,
  state: z.enum(["existing", "create"]),
  type: z.enum(["world", "oc", "story", "graph", "timeline", "asset"]),
  objectKind: z.enum([
    "domain_root", "world", "oc", "story", "volume", "chapter", "location", "faction",
    "oc_variant", "graph_view", "timeline_view", "asset_collection",
  ]).optional(),
  title: z.string().trim().min(1).max(500),
  parentRef: resourceRefSchema.nullable(),
  sortOrder: z.number().int().min(0).max(2_147_483_647),
}).strict();

const evidenceSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("same_change_set_artifact"),
    artifactRef: artifactRefSchema,
    sourceSha256: sha256Schema,
    stableLocator: z.string().trim().min(1).max(2_000),
  }).strict(),
  z.object({
    kind: z.literal("active_document"),
    evidenceId: idSchema,
    sourceId: idSchema,
    sourceSha256: sha256Schema,
    stableLocator: z.string().trim().min(1).max(2_000),
  }).strict(),
]);

export const growthCandidateCompileInputSchema = z.object({
  goalId: idSchema,
  roundId: idSchema,
  workOrderId: idSchema,
  attemptId: idSchema,
  sourceCheckpointId: idSchema,
  mode: z.enum(["free", "assist"]),
  summary: z.string().trim().min(1).max(2_000),
  resources: z.array(resourceBindingSchema).min(1).max(100),
  artifactTargets: z.array(z.object({
    artifactRef: artifactRefSchema,
    resourceRef: resourceRefSchema,
  }).strict()).min(1).max(20),
  evidenceBindings: z.array(z.object({
    evidenceRef: evidenceRefSchema,
    source: evidenceSourceSchema,
  }).strict()).min(1).max(200),
  existingAssertions: z.array(z.object({
    ref: assertionRefSchema,
    assertionId: idSchema,
  }).strict()).max(200),
  causalSupport: z.array(z.object({
    localId: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
    decision: z.enum(["supported", "unsupported"]),
    evidenceRefs: z.array(evidenceRefSchema).min(1).max(20),
  }).strict()).max(200),
  specialist: specialistSubmissionSchema,
  graph: graphCuratorSubmissionSchema,
}).strict();

export type GrowthCandidateCompileInput = z.infer<typeof growthCandidateCompileInputSchema>;

export function validateGrowthCandidateCompilation(rawInput: unknown): GrowthCandidateCompileInput {
  const parsed = growthCandidateCompileInputSchema.safeParse(rawInput);
  if (!parsed.success) throw policyError("GROWTH_CANDIDATE_INPUT_INVALID");
  const input = parsed.data;
  if (input.specialist.candidate.status !== "ready" || input.graph.status !== "ready") {
    throw policyError("GROWTH_CANDIDATE_NOT_READY");
  }
  assertUnique(input.resources.map((item) => item.ref), "GROWTH_CANDIDATE_RESOURCE_REF_DUPLICATED");
  assertUnique(input.resources.map((item) => item.resourceId), "GROWTH_CANDIDATE_RESOURCE_ID_DUPLICATED");
  assertUnique(input.artifactTargets.map((item) => item.artifactRef), "GROWTH_CANDIDATE_ARTIFACT_TARGET_DUPLICATED");
  assertUnique(input.evidenceBindings.map((item) => item.evidenceRef), "GROWTH_CANDIDATE_EVIDENCE_DUPLICATED");
  assertUnique(input.existingAssertions.map((item) => item.ref), "GROWTH_CANDIDATE_ASSERTION_REF_DUPLICATED");
  assertUnique(input.existingAssertions.map((item) => item.assertionId), "GROWTH_CANDIDATE_ASSERTION_ID_DUPLICATED");
  assertUnique(input.causalSupport.map((item) => item.localId), "GROWTH_CANDIDATE_CAUSAL_SUPPORT_DUPLICATED");
  assertUnique(input.graph.candidate.assertions.map((item) => item.localId), "GROWTH_CANDIDATE_GRAPH_ASSERTION_DUPLICATED");
  assertUnique(input.graph.candidate.causalLinks.map((item) => item.localId), "GROWTH_CANDIDATE_GRAPH_CAUSAL_DUPLICATED");

  const resources = new Map(input.resources.map((item, index) => [item.ref, { item, index }]));
  for (const { item, index } of resources.values()) {
    if (item.state === "create" && item.parentRef === null) throw policyError("GROWTH_CANDIDATE_PARENT_REQUIRED");
    if (item.parentRef) {
      const parent = resources.get(item.parentRef);
      if (!parent || parent.index >= index) throw policyError("GROWTH_CANDIDATE_PARENT_ORDER_INVALID");
    }
  }
  const artifactRefs = input.specialist.artifacts.map((artifact) => artifact.ref);
  if (!sameStringSet(input.specialist.candidate.contentArtifactRefs, artifactRefs)) {
    throw policyError("GROWTH_CANDIDATE_SPECIALIST_ARTIFACT_MISMATCH");
  }
  if (artifactRefs.length !== input.artifactTargets.length
    || artifactRefs.some((reference) => !input.artifactTargets.some((target) => target.artifactRef === reference))) {
    throw policyError("GROWTH_CANDIDATE_ARTIFACT_TARGET_MISMATCH");
  }
  if (input.artifactTargets.some((target) => !resources.has(target.resourceRef))) {
    throw policyError("GROWTH_CANDIDATE_RESOURCE_SCOPE_MISMATCH");
  }
  const evidence = new Map(input.evidenceBindings.map((item) => [item.evidenceRef, item]));
  const artifactSet = new Set(artifactRefs);
  for (const binding of input.evidenceBindings) {
    const source = binding.source;
    if (source.kind === "same_change_set_artifact" && !artifactSet.has(source.artifactRef)) {
      throw policyError("GROWTH_CANDIDATE_EVIDENCE_ARTIFACT_MISMATCH");
    }
    if (source.kind === "same_change_set_artifact") {
      const artifactRef = source.artifactRef;
      const artifact = input.specialist.artifacts.find((item) => item.ref === artifactRef)!;
      if (source.sourceSha256 !== sha256(artifact.content)) throw policyError("GROWTH_CANDIDATE_ARTIFACT_HASH_MISMATCH");
    }
  }
  const citedEvidence = new Set([
    ...input.graph.candidate.assertions.flatMap((item) => item.sourceLocators.map((locator) => locator.sourceRef)),
    ...input.graph.candidate.causalLinks.flatMap((item) => item.sourceLocators.map((locator) => locator.sourceRef)),
  ]);
  if ([...citedEvidence].some((reference) => !evidence.has(reference))) {
    throw policyError("GROWTH_CANDIDATE_EVIDENCE_BINDING_MISSING");
  }
  for (const candidate of [...input.graph.candidate.assertions, ...input.graph.candidate.causalLinks]) {
    for (const locator of candidate.sourceLocators) {
      const binding = evidence.get(locator.sourceRef)!;
      if (binding.source.kind !== "same_change_set_artifact") continue;
      const artifactRef = binding.source.artifactRef;
      const artifact = input.specialist.artifacts.find((item) => item.ref === artifactRef)!;
      const codePoints = Array.from(artifact.content);
      if (locator.startCodePoint >= locator.endCodePoint || locator.endCodePoint > codePoints.length
        || sha256(codePoints.slice(locator.startCodePoint, locator.endCodePoint).join("")) !== locator.sourceTextSha256) {
        throw policyError("GROWTH_CANDIDATE_SOURCE_LOCATOR_INVALID");
      }
    }
  }
  const specialistEvidence = new Set([
    ...input.specialist.candidate.evidenceRefs,
    ...input.specialist.candidate.coverage.flatMap((item) => item.evidenceRefs),
  ]);
  if ([...specialistEvidence].some((reference) => !evidence.has(reference))) {
    throw policyError("GROWTH_CANDIDATE_SPECIALIST_EVIDENCE_MISSING");
  }
  const support = new Map(input.causalSupport.map((item) => [item.localId, item]));
  if (!sameStringSet(input.graph.candidate.causalLinks.map((link) => link.localId), input.causalSupport.map((item) => item.localId))) {
    throw policyError("GROWTH_CANDIDATE_CAUSAL_SUPPORT_SET_MISMATCH");
  }
  if (input.graph.candidate.causalLinks.some((link) => support.get(link.localId)?.decision !== "supported")) {
    throw policyError("GROWTH_CANDIDATE_CAUSAL_SUPPORT_REQUIRED");
  }
  for (const link of input.graph.candidate.causalLinks) {
    const cited = new Set(link.sourceLocators.map((locator) => locator.sourceRef));
    const decision = support.get(link.localId)!;
    if (decision.evidenceRefs.some((reference) => !cited.has(reference))) {
      throw policyError("GROWTH_CANDIDATE_CAUSAL_SUPPORT_EVIDENCE_MISMATCH");
    }
  }
  return input;
}

function assertUnique(values: string[], code: string): void {
  if (new Set(values).size !== values.length) throw policyError(code);
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function policyError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
