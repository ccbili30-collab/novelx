import { z } from "zod";
import { growthReceiptLinkReasonCodeSchema, type GrowthRetrievalReceiptCreate } from "../../shared/growthContract";

const idSchema = z.string().trim().min(1).max(240);
const timeFilterSchema = z.object({ from: z.string().min(1).nullable(), to: z.string().min(1).nullable() }).strict();

export const graphRetrievalRequestSchema = z.object({
  id: idSchema,
  cycleId: idSchema,
  runId: idSchema,
  toolInvocationId: idSchema,
  branchId: idSchema,
  checkpointId: idSchema,
  lens: z.literal("creator"),
  authorizedScopeResourceIds: z.array(idSchema).min(1).max(100),
  seedResourceIds: z.array(idSchema).max(100).default([]),
  /** Main-authoritative resources that must be retained as evidence hits. */
  requiredResourceIds: z.array(idSchema).max(100).default([]),
  /** Main-authoritative pinned versions that must be retained as evidence hits. */
  requiredTargetVersionIds: z.array(idSchema).max(100).default([]),
  query: z.string().trim().min(1).max(12_000),
  aliases: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
  validTime: timeFilterSchema.nullable().default(null),
  recordedTime: timeFilterSchema.nullable().default(null),
  maxHops: z.number().int().min(0).max(3),
  cpuBudgetMs: z.number().int().min(1).max(60_000),
  expansionBudget: z.number().int().min(1).max(100_000),
  resultBudget: z.number().int().min(1).max(100_000),
  tokenBudget: z.number().int().min(1).max(1_000_000),
  contentBudgetChars: z.number().int().min(1).max(1_000_000),
  policyVersion: z.string().trim().min(1).max(120),
}).strict().superRefine((value, context) => {
  if (new Set(value.authorizedScopeResourceIds).size !== value.authorizedScopeResourceIds.length) {
    context.addIssue({ code: "custom", path: ["authorizedScopeResourceIds"], message: "Scope IDs must be unique." });
  }
  if (new Set(value.seedResourceIds).size !== value.seedResourceIds.length) {
    context.addIssue({ code: "custom", path: ["seedResourceIds"], message: "Seed IDs must be unique." });
  }
  if (new Set(value.requiredResourceIds).size !== value.requiredResourceIds.length) {
    context.addIssue({ code: "custom", path: ["requiredResourceIds"], message: "Required resource IDs must be unique." });
  }
  if (new Set(value.requiredTargetVersionIds).size !== value.requiredTargetVersionIds.length) {
    context.addIssue({ code: "custom", path: ["requiredTargetVersionIds"], message: "Required target version IDs must be unique." });
  }
});

export type GraphRetrievalRequest = z.infer<typeof graphRetrievalRequestSchema>;
export type GraphRetrievalReasonCode = z.infer<typeof growthReceiptLinkReasonCodeSchema>;
export type GraphRetrievalAssertionSource =
  | { type: "stable_document"; document: { resourceId: string; title: string; versionId: string } }
  | { type: "unresolved"; reason: "unsupported_source" | "source_not_active" };

export type GraphRetrievalEvidenceHit = {
  rank: number; targetKind: "resource" | "document" | "assertion" | "relation"; targetId: string; targetVersionId: string;
  score: number; reasonCodes: GraphRetrievalReasonCode[]; pathTargetIds: string[];
} & (
  | { targetKind: "resource"; resource: { id: string; versionId: string; title: string; type: string; objectKind: string }; stableDocument: { excerpt: string; locator: string; versionId: string; contentHash: string } | null }
  | { targetKind: "document"; document: { id: string; versionId: string; title: string; excerpt: string; locator: string; contentHash: string } }
  | { targetKind: "assertion"; assertion: { id: string; versionId: string; scopeResourceId: string; subject: string; predicate: string; object: Record<string, unknown>; status: "current" | "conflict"; sources: GraphRetrievalAssertionSource[] } }
  | { targetKind: "relation"; relation: { id: string; versionId: string; kind: string; sourceResourceId: string; targetResourceId: string } }
);

export interface GraphRetrievalResult {
  receipt: GrowthRetrievalReceiptCreate;
  hits: GraphRetrievalEvidenceHit[];
  effectiveScopeResourceIds: string[];
  diagnostics: {
    candidateCount: number;
    expandedEdges: number;
    consumedContentChars: number;
    coverage: "complete" | "partial" | "unknown";
    truncated: boolean;
  };
}
