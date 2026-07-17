import { z } from "zod";

export const causalRelationKinds = [
  "causes",
  "enables",
  "constrains",
  "prevents",
  "amplifies",
  "mitigates",
  "depends_on",
] as const;

export const causalRelationKindSchema = z.enum(causalRelationKinds);
export type CausalRelationKind = z.infer<typeof causalRelationKindSchema>;

export const causalEpistemicStatuses = ["confirmed", "inferred", "disputed"] as const;
export const causalEpistemicStatusSchema = z.enum(causalEpistemicStatuses);
export type CausalEpistemicStatus = z.infer<typeof causalEpistemicStatusSchema>;

const identitySchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/);
const boundedTextSchema = z.string().trim().min(1).max(2_000);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const causalSourceReferenceSchema = z.object({
  sourceId: identitySchema,
  sourceKind: z.enum(["document", "evidence", "assertion"]),
  sourceVersionId: identitySchema,
  stableLocator: z.string().trim().min(1).max(2_000),
  sourceSha256: sha256Schema,
}).strict();

export type CausalSourceReference = z.infer<typeof causalSourceReferenceSchema>;

export const causalRelationDefinitionSchema = z.object({
  id: identitySchema,
  kind: causalRelationKindSchema,
  causeAssertionId: identitySchema,
  effectAssertionId: identitySchema,
  mechanism: boundedTextSchema,
  conditions: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
  temporalScope: z.string().trim().min(1).max(1_000),
  polarityStrengthSummary: z.string().trim().min(1).max(1_000),
  epistemicStatus: causalEpistemicStatusSchema,
  sourceReferences: z.array(causalSourceReferenceSchema).min(1).max(50),
}).strict();

export type CausalRelationDefinition = z.infer<typeof causalRelationDefinitionSchema>;

export interface CausalExtractionRelevance {
  describesOnly: boolean;
  claimsDevelopmentImpact: boolean;
}
