import { z } from "zod";
import {
  causalRelationDefinitionSchema,
  type CausalExtractionRelevance,
  type CausalRelationDefinition,
} from "./causalRelationTypes";

export function validateCausalRelation(input: unknown): CausalRelationDefinition {
  const parsed = causalRelationDefinitionSchema.safeParse(input);
  if (!parsed.success) throw causalPolicyError(classifyIssue(parsed.error));
  const relation = parsed.data;
  if (relation.causeAssertionId === relation.effectAssertionId) {
    throw causalPolicyError("DOMAIN_CAUSAL_SELF_EDGE_FORBIDDEN");
  }
  if (new Set(relation.conditions).size !== relation.conditions.length) {
    throw causalPolicyError("DOMAIN_CAUSAL_CONDITIONS_DUPLICATED");
  }
  const sourceKeys = relation.sourceReferences.map((source) =>
    `${source.sourceKind}\u0000${source.sourceId}\u0000${source.sourceVersionId}\u0000${source.stableLocator}`);
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw causalPolicyError("DOMAIN_CAUSAL_SOURCE_DUPLICATED");
  }
  return Object.freeze({
    ...relation,
    conditions: Object.freeze([...relation.conditions]),
    sourceReferences: Object.freeze(relation.sourceReferences.map((source) => Object.freeze({ ...source }))),
  }) as CausalRelationDefinition;
}

export function validateCausalRelationSet(input: readonly unknown[]): readonly CausalRelationDefinition[] {
  const relations = input.map(validateCausalRelation);
  const ids = relations.map((relation) => relation.id);
  if (new Set(ids).size !== ids.length) throw causalPolicyError("DOMAIN_CAUSAL_RELATION_ID_DUPLICATED");
  const semanticKeys = relations.map((relation) =>
    `${relation.kind}\u0000${relation.causeAssertionId}\u0000${relation.effectAssertionId}`);
  if (new Set(semanticKeys).size !== semanticKeys.length) {
    throw causalPolicyError("DOMAIN_CAUSAL_RELATION_DUPLICATED");
  }
  return Object.freeze(relations);
}

export function requiresCausalExtraction(value: CausalExtractionRelevance): boolean {
  return !value.describesOnly && value.claimsDevelopmentImpact;
}

function classifyIssue(error: z.ZodError): string {
  const path = error.issues[0]?.path[0];
  if (path === "causeAssertionId" || path === "effectAssertionId") return "DOMAIN_CAUSAL_ENDPOINT_INVALID";
  if (path === "mechanism") return "DOMAIN_CAUSAL_MECHANISM_REQUIRED";
  if (path === "conditions") return "DOMAIN_CAUSAL_CONDITIONS_REQUIRED";
  if (path === "temporalScope") return "DOMAIN_CAUSAL_TEMPORAL_SCOPE_REQUIRED";
  if (path === "polarityStrengthSummary") return "DOMAIN_CAUSAL_POLARITY_STRENGTH_REQUIRED";
  if (path === "epistemicStatus") return "DOMAIN_CAUSAL_EPISTEMIC_STATUS_INVALID";
  if (path === "sourceReferences") return "DOMAIN_CAUSAL_SOURCE_REQUIRED";
  if (path === "kind") return "DOMAIN_CAUSAL_KIND_INVALID";
  return "DOMAIN_CAUSAL_DEFINITION_INVALID";
}

function causalPolicyError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
