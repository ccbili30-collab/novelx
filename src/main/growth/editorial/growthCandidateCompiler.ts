import { createHash } from "node:crypto";
import { canonicalAuditHash } from "../../../domain/audit/canonicalAuditHash";
import { greenfieldDocumentOutputEvidence } from "../../../domain/changeSet/changeSetService";
import { validateCausalRelationSet } from "../../../domain/graph/causalRelationPolicy";
import { proposeChangeSetArgsSchema, type ProposeChangeSetArgs } from "../../../shared/agentWorkerProtocol";
import {
  validateGrowthCandidateCompilation,
  type GrowthCandidateCompileInput,
} from "./growthCandidatePolicy";

export interface CompiledGrowthCandidate {
  sourceCheckpointId: string;
  mode: "free" | "assist";
  proposal: ProposeChangeSetArgs;
  proposalSha256: string;
  generated: {
    resourceIds: Record<string, string>;
    assertionIds: Record<string, string>;
    relationIds: Record<string, string>;
  };
}

export function compileGrowthCandidate(rawInput: unknown): CompiledGrowthCandidate {
  const input = validateGrowthCandidateCompilation(rawInput);
  if (input.specialist.candidate.status !== "ready" || input.graph.status !== "ready") {
    throw compilerError("GROWTH_CANDIDATE_NOT_READY");
  }
  const resources = new Map(input.resources.map((resource) => [resource.ref, resource]));
  const resourceItemIds = new Map<string, string>();
  const items: ProposeChangeSetArgs["items"] = [];
  for (const resource of input.resources) {
    if (resource.state !== "create") continue;
    const itemId = generatedId("resource", input.attemptId, resource.ref);
    resourceItemIds.set(resource.ref, itemId);
    const parentItemId = resource.parentRef ? resourceItemIds.get(resource.parentRef) : undefined;
    items.push({
      id: itemId,
      kind: "resource.put",
      dependsOn: parentItemId ? [parentItemId] : [],
      payload: {
        resourceId: resource.resourceId,
        create: true,
        type: resource.type,
        ...(resource.objectKind ? { objectKind: resource.objectKind } : {}),
        title: resource.title,
        parentId: resource.parentRef ? resources.get(resource.parentRef)!.resourceId : null,
        state: "active",
        sortOrder: resource.sortOrder,
      },
    });
  }

  const artifactTargets = new Map(input.artifactTargets.map((target) => [target.artifactRef, target.resourceRef]));
  const documentItemIds = new Map<string, string>();
  for (const artifact of input.specialist.artifacts) {
    const resourceRef = artifactTargets.get(artifact.ref)!;
    const resource = resources.get(resourceRef)!;
    const itemId = generatedId("document", input.attemptId, artifact.ref);
    documentItemIds.set(artifact.ref, itemId);
    items.push({
      id: itemId,
      kind: "document.put",
      dependsOn: dependencyList(resourceItemIds.get(resourceRef)),
      payload: { resourceId: resource.resourceId, content: artifact.content },
    });
  }

  const evidence = new Map(input.evidenceBindings.map((binding) => [binding.evidenceRef, compileEvidence(binding, input, documentItemIds, resources, artifactTargets)]));
  const assertionIds = new Map<string, string>();
  const assertionItemIds = new Map<string, string>();
  for (const assertion of input.graph.candidate.assertions) {
    if (!assertion.subjectRef.startsWith("@resource")) throw compilerError("GROWTH_CANDIDATE_ASSERTION_SUBJECT_UNSUPPORTED");
    const resource = resources.get(assertion.subjectRef);
    if (!resource) throw compilerError("GROWTH_CANDIDATE_RESOURCE_SCOPE_MISMATCH");
    const assertionId = generatedId("assertion-id", input.attemptId, assertion.localId);
    const itemId = generatedId("assertion", input.attemptId, assertion.localId);
    assertionIds.set(`local:${assertion.localId}`, assertionId);
    assertionItemIds.set(`local:${assertion.localId}`, itemId);
    const cited = assertion.sourceLocators.map((locator) => requiredEvidence(evidence, locator.sourceRef, locator));
    items.push({
      id: itemId,
      kind: "assertion.put",
      dependsOn: dependencyList(resourceItemIds.get(assertion.subjectRef), ...cited.map((item) => item.documentItemId)),
      payload: {
        assertionId,
        scopeType: resource.type,
        scopeId: resource.resourceId,
        subject: resource.resourceId,
        predicate: assertion.predicate,
        object: assertion.object,
        evidenceIds: unique(cited.map((item) => item.evidenceId)),
      },
    });
  }
  const existingAssertions = new Map(input.existingAssertions.map((item) => [item.ref, item.assertionId]));
  const relationIds = new Map<string, string>();
  const causalDefinitions: unknown[] = [];
  for (const link of input.graph.candidate.causalLinks) {
    if (link.epistemicStatus === "unknown") throw compilerError("GROWTH_CANDIDATE_CAUSAL_EPISTEMIC_UNRESOLVED");
    const cause = resolveEndpoint(link.causeRef, assertionIds, assertionItemIds, existingAssertions);
    const effect = resolveEndpoint(link.effectRef, assertionIds, assertionItemIds, existingAssertions);
    const relationId = generatedId("causal-id", input.attemptId, link.localId);
    const itemId = generatedId("causal", input.attemptId, link.localId);
    relationIds.set(link.localId, relationId);
    const cited = link.sourceLocators.map((locator) => requiredEvidence(evidence, locator.sourceRef, locator));
    const stableSources = uniqueBy(cited, (item) => `${item.evidenceId}\0${item.stableLocator}`);
    causalDefinitions.push({
      id: relationId,
      kind: link.relationKind,
      causeAssertionId: cause.assertionId,
      effectAssertionId: effect.assertionId,
      mechanism: link.mechanism,
      conditions: link.conditions,
      temporalScope: link.temporalScope,
      polarityStrengthSummary: link.polarityStrengthSummary,
      epistemicStatus: link.epistemicStatus,
      sourceReferences: stableSources.map((source) => source.policySource),
    });
    items.push({
      id: itemId,
      kind: "causal_relation.put",
      dependsOn: dependencyList(cause.itemId, effect.itemId, ...stableSources.map((source) => source.documentItemId)),
      payload: {
        relationId,
        relationKind: link.relationKind,
        causeAssertionId: cause.assertionId,
        causeAssertionItemId: cause.itemId,
        effectAssertionId: effect.assertionId,
        effectAssertionItemId: effect.itemId,
        mechanism: link.mechanism,
        conditions: link.conditions,
        temporalScope: link.temporalScope,
        polarityStrengthSummary: link.polarityStrengthSummary,
        epistemicStatus: link.epistemicStatus,
        sourceBindings: stableSources.map((source) => ({ evidenceId: source.evidenceId, stableLocator: source.stableLocator })),
      },
    });
  }
  validateCausalRelationSet(causalDefinitions);
  const proposal = proposeChangeSetArgsSchema.parse({ summary: input.summary, items });
  return {
    sourceCheckpointId: input.sourceCheckpointId,
    mode: input.mode,
    proposal,
    proposalSha256: canonicalAuditHash(proposal),
    generated: {
      resourceIds: Object.fromEntries(input.resources.map((resource) => [resource.ref, resource.resourceId])),
      assertionIds: Object.fromEntries(assertionIds),
      relationIds: Object.fromEntries(relationIds),
    },
  };
}

interface CompiledEvidence {
  evidenceId: string;
  stableLocator: string;
  documentItemId?: string;
  policySource: {
    sourceId: string;
    sourceKind: "document";
    sourceVersionId: string;
    stableLocator: string;
    sourceSha256: string;
  };
}

function compileEvidence(
  binding: GrowthCandidateCompileInput["evidenceBindings"][number],
  input: GrowthCandidateCompileInput,
  documentItemIds: ReadonlyMap<string, string>,
  resources: ReadonlyMap<string, GrowthCandidateCompileInput["resources"][number]>,
  artifactTargets: ReadonlyMap<string, string>,
): Omit<CompiledEvidence, "stableLocator"> & { baseLocator: string } {
  if (binding.source.kind === "active_document") {
    return {
      evidenceId: binding.source.evidenceId,
      baseLocator: binding.source.stableLocator,
      policySource: {
        sourceId: binding.source.sourceId,
        sourceKind: "document",
        sourceVersionId: binding.source.evidenceId,
        stableLocator: binding.source.stableLocator,
        sourceSha256: binding.source.sourceSha256,
      },
    };
  }
  const documentItemId = documentItemIds.get(binding.source.artifactRef)!;
  const resourceRef = artifactTargets.get(binding.source.artifactRef)!;
  const resource = resources.get(resourceRef)!;
  return {
    evidenceId: greenfieldDocumentOutputEvidence(documentItemId),
    baseLocator: binding.source.stableLocator,
    documentItemId,
    policySource: {
      sourceId: resource.resourceId,
      sourceKind: "document",
      sourceVersionId: documentItemId,
      stableLocator: binding.source.stableLocator,
      sourceSha256: binding.source.sourceSha256,
    },
  };
}

function requiredEvidence(
  evidence: ReadonlyMap<string, Omit<CompiledEvidence, "stableLocator"> & { baseLocator: string }>,
  reference: string,
  locator: { startCodePoint: number; endCodePoint: number; sourceTextSha256: string },
): CompiledEvidence {
  const source = evidence.get(reference);
  if (!source) throw compilerError("GROWTH_CANDIDATE_EVIDENCE_BINDING_MISSING");
  const stableLocator = `${source.baseLocator}#codepoint:${locator.startCodePoint}-${locator.endCodePoint};sha256:${locator.sourceTextSha256}`;
  if (stableLocator.length > 2_000) throw compilerError("GROWTH_CANDIDATE_LOCATOR_TOO_LONG");
  return {
    ...source,
    stableLocator,
    policySource: { ...source.policySource, stableLocator },
  };
}

function resolveEndpoint(
  reference: string,
  localIds: ReadonlyMap<string, string>,
  localItemIds: ReadonlyMap<string, string>,
  existing: ReadonlyMap<string, string>,
): { assertionId: string; itemId: string | null } {
  const local = localIds.get(reference);
  if (local) return { assertionId: local, itemId: localItemIds.get(reference)! };
  const assertionId = existing.get(reference);
  if (assertionId) return { assertionId, itemId: null };
  throw compilerError("GROWTH_CANDIDATE_CAUSAL_ENDPOINT_UNRESOLVED");
}

function generatedId(kind: string, attemptId: string, localRef: string): string {
  return `growth-${kind}-${createHash("sha256").update(`${attemptId}\0${kind}\0${localRef}`, "utf8").digest("hex").slice(0, 32)}`;
}

function dependencyList(...values: Array<string | undefined | null>): string[] {
  return unique(values.filter((value): value is string => Boolean(value)));
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true; });
}
function compilerError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
