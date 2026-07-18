import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalAuditHash } from "../../../domain/audit/canonicalAuditHash";
import { agentCapabilityIds } from "../../../shared/growthEditorialContract";
import {
  worldDirectorPacketSchema,
  type WorldDirectorPacket,
} from "../../../shared/growthEditorialWorkerProtocol";

export type { WorldDirectorPacket } from "../../../shared/growthEditorialWorkerProtocol";

const idSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const safeSummarySchema = z.string().trim().min(1).max(2_000);
const evidenceRefSchema = z.string().regex(/^@evidence[1-9][0-9]*$/);
const scopeRefSchema = z.string().regex(/^@resource[1-9][0-9]*$/);

const sourceCheckpointShape = { sourceCheckpointId: idSchema } as const;

const inputSchema = z.object({
  goalId: idSchema,
  branchId: idSchema,
  sourceCheckpointId: idSchema,
  ruleRevision: z.number().int().positive(),
  lens: z.literal("creator"),
  userRules: z.array(z.object({
    id: idSchema,
    revision: z.number().int().positive(),
    text: z.string().trim().min(1).max(4_000),
    contentSha256: sha256Schema,
  }).strict()).max(100),
  closureMatrix: z.array(z.object({
    ...sourceCheckpointShape,
    profileId: idSchema,
    facetId: idSchema,
    state: z.enum(["satisfied", "missing", "conflicted", "blocked", "unknown"]),
    safeSummary: safeSummarySchema,
    evidenceRefs: z.array(evidenceRefSchema).max(100),
  }).strict()).max(1_000),
  causalFrontier: z.array(z.object({
    ...sourceCheckpointShape,
    relationVersionId: idSchema,
    relationKind: z.enum(["causes", "enables", "constrains", "prevents", "amplifies", "mitigates", "depends_on"]),
    causeAssertionId: idSchema,
    effectAssertionId: idSchema,
    mechanismSummary: safeSummarySchema,
    epistemicStatus: z.enum(["confirmed", "inferred", "disputed"]),
    sourceReferences: z.array(z.object({
      kind: z.enum(["document", "evidence", "assertion"]),
      versionId: idSchema,
      locator: z.string().trim().min(1).max(1_000),
    }).strict()).min(1).max(20),
  }).strict()).max(1_000),
  recentChangeSets: z.array(z.object({
    ...sourceCheckpointShape,
    changeSetId: idSchema,
    committedCheckpointId: idSchema,
    summary: safeSummarySchema,
    outputKinds: z.array(z.enum([
      "resource_revision", "document_version", "assertion_version", "creative_document_revision",
      "creative_relation_revision", "constraint_profile_version", "project_file_version", "causal_relation_version",
    ])).max(100),
    committedAt: z.iso.datetime({ offset: true }),
  }).strict()).max(200),
  unresolvedCheckerFindings: z.array(z.object({
    ...sourceCheckpointShape,
    findingId: idSchema,
    workOrderId: idSchema,
    severity: z.enum(["minor", "major", "blocking"]),
    category: z.enum(["fact_conflict", "causality", "source", "coverage", "continuity"]),
    safeSummary: safeSummarySchema,
    evidenceRefs: z.array(evidenceRefSchema).min(1).max(100),
  }).strict()).max(1_000),
  nodeMaturity: z.array(z.object({
    ...sourceCheckpointShape,
    scopeRef: scopeRefSchema,
    profileId: idSchema,
    state: z.enum(["unknown", "seed", "structured", "developed", "closure_ready", "blocked"]),
    satisfiedFacetIds: z.array(idSchema).max(100),
    missingFacetIds: z.array(idSchema).max(100),
  }).strict()).max(1_000),
  graphSummaries: z.array(z.object({
    ...sourceCheckpointShape,
    scopeRef: scopeRefSchema,
    label: z.string().trim().min(1).max(500),
    safeSummary: safeSummarySchema,
    factCount: z.number().int().nonnegative(),
    causalEdgeCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
    sourceVersionIds: z.array(idSchema).min(1).max(100),
    truncated: z.boolean(),
  }).strict()).max(1_000),
  imageQueueSummary: z.object({
    sourceCheckpointId: idSchema,
    requests: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
  }).strict(),
  budget: z.object({
    maxClosureFacets: z.number().int().min(1).max(500),
    maxCausalEdges: z.number().int().min(1).max(500),
    maxRecentChangeSets: z.number().int().min(1).max(100),
    maxCheckerFindings: z.number().int().min(1).max(500),
    maxNodeMaturity: z.number().int().min(1).max(500),
    maxGraphSummaries: z.number().int().min(1).max(500),
    maxTotalChars: z.number().int().min(10_000).max(500_000),
  }).strict().optional(),
}).strict();

export type WorldDirectorPacketCompileInput = z.input<typeof inputSchema>;

export const WORLD_DIRECTOR_PACKET_VERSION = "1.0.0" as const;
export interface WorldDirectorPacketBudget {
  maxClosureFacets: number;
  maxCausalEdges: number;
  maxRecentChangeSets: number;
  maxCheckerFindings: number;
  maxNodeMaturity: number;
  maxGraphSummaries: number;
  maxTotalChars: number;
}

export const DEFAULT_WORLD_DIRECTOR_PACKET_BUDGET: Readonly<WorldDirectorPacketBudget> = Object.freeze({
  maxClosureFacets: 100,
  maxCausalEdges: 100,
  maxRecentChangeSets: 20,
  maxCheckerFindings: 100,
  maxNodeMaturity: 200,
  maxGraphSummaries: 100,
  maxTotalChars: 160_000,
});

const editorialCharter = Object.freeze([
  "World Director owns editorial planning and review, not Provider, tools, persistence or Canon writes.",
  "Specialists create source-bound candidates; deterministic Domain policy and Checker findings remain blocking authority.",
  "Every accepted mutation must pass one serialized Change Set lane against the latest checkpoint.",
  "Creator choices, unresolved evidence and truncated context must be surfaced rather than guessed.",
]);

export function compileWorldDirectorPacket(rawInput: unknown): { packet: WorldDirectorPacket; packetSha256: string } {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) throw packetError("WORLD_DIRECTOR_PACKET_INPUT_INVALID");
  const input = parsed.data;
  assertNoCredentialLikeContent(input);
  if (input.userRules.some((rule) => sha256(rule.text) !== rule.contentSha256)) {
    throw packetError("WORLD_DIRECTOR_PACKET_RULE_HASH_MISMATCH");
  }
  assertCheckpointConsistency(input);
  assertUniqueInput(input);
  const budget = Object.freeze({ ...DEFAULT_WORLD_DIRECTOR_PACKET_BUDGET, ...input.budget });

  const closureMatrix = takeSorted(input.closureMatrix, budget.maxClosureFacets,
    (item) => `${item.profileId}\0${item.facetId}`);
  const causalFrontier = takeSorted(input.causalFrontier, budget.maxCausalEdges,
    (item) => `${item.causeAssertionId}\0${item.effectAssertionId}\0${item.relationVersionId}`);
  const recentChangeSets = [...input.recentChangeSets]
    .sort((left, right) => right.committedAt.localeCompare(left.committedAt) || left.changeSetId.localeCompare(right.changeSetId))
    .slice(0, budget.maxRecentChangeSets);
  const unresolvedCheckerFindings = takeSorted(input.unresolvedCheckerFindings, budget.maxCheckerFindings,
    (item) => `${severityRank(item.severity)}\0${item.findingId}`);
  const nodeMaturity = takeSorted(input.nodeMaturity, budget.maxNodeMaturity,
    (item) => `${item.scopeRef}\0${item.profileId}`);
  const graphSummaries = takeSorted(input.graphSummaries, budget.maxGraphSummaries,
    (item) => `${item.scopeRef}\0${item.label}`);
  const omitted = {
    closureFacets: input.closureMatrix.length - closureMatrix.length,
    causalEdges: input.causalFrontier.length - causalFrontier.length,
    recentChangeSets: input.recentChangeSets.length - recentChangeSets.length,
    checkerFindings: input.unresolvedCheckerFindings.length - unresolvedCheckerFindings.length,
    nodeMaturity: input.nodeMaturity.length - nodeMaturity.length,
    graphSummaries: input.graphSummaries.length - graphSummaries.length,
  };
  const packet: WorldDirectorPacket = {
    version: WORLD_DIRECTOR_PACKET_VERSION,
    identity: {
      goalId: input.goalId,
      branchId: input.branchId,
      sourceCheckpointId: input.sourceCheckpointId,
      ruleRevision: input.ruleRevision,
      lens: input.lens,
    },
    editorialCharter: [...editorialCharter],
    availableCapabilities: [...agentCapabilityIds],
    userRules: [...input.userRules].sort((left, right) => left.revision - right.revision || left.id.localeCompare(right.id)),
    closureMatrix,
    causalFrontier,
    recentChangeSets,
    unresolvedCheckerFindings,
    nodeMaturity,
    graphSummaries,
    imageQueueSummary: input.imageQueueSummary,
    retrieval: {
      budget,
      omitted,
      incomplete: Object.values(omitted).some((count) => count > 0)
        || graphSummaries.some((summary) => summary.truncated),
    },
  };
  if (JSON.stringify(packet).length > budget.maxTotalChars) throw packetError("WORLD_DIRECTOR_PACKET_BUDGET_EXCEEDED");
  const validated = worldDirectorPacketSchema.safeParse(packet);
  if (!validated.success) throw packetError("WORLD_DIRECTOR_PACKET_OUTPUT_INVALID");
  return { packet: validated.data, packetSha256: canonicalAuditHash(validated.data) };
}

function assertCheckpointConsistency(input: z.output<typeof inputSchema>): void {
  const checkpointIds = [
    ...input.closureMatrix,
    ...input.causalFrontier,
    ...input.recentChangeSets,
    ...input.unresolvedCheckerFindings,
    ...input.nodeMaturity,
    ...input.graphSummaries,
    input.imageQueueSummary,
  ].map((item) => item.sourceCheckpointId);
  if (checkpointIds.some((checkpointId) => checkpointId !== input.sourceCheckpointId)) {
    throw packetError("WORLD_DIRECTOR_PACKET_CHECKPOINT_MISMATCH");
  }
}

function assertUniqueInput(input: z.output<typeof inputSchema>): void {
  const groups: string[][] = [
    input.userRules.map((item) => item.id),
    input.closureMatrix.map((item) => `${item.profileId}:${item.facetId}`),
    input.causalFrontier.map((item) => item.relationVersionId),
    input.recentChangeSets.map((item) => item.changeSetId),
    input.unresolvedCheckerFindings.map((item) => item.findingId),
    input.nodeMaturity.map((item) => `${item.scopeRef}:${item.profileId}`),
    input.graphSummaries.map((item) => item.scopeRef),
  ];
  if (groups.some((values) => new Set(values).size !== values.length)) {
    throw packetError("WORLD_DIRECTOR_PACKET_DUPLICATE_INPUT");
  }
}

function assertNoCredentialLikeContent(input: z.output<typeof inputSchema>): void {
  const content = JSON.stringify(input);
  if (/(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key\s*[:=]\s*[^\s"}]+)/i.test(content)) {
    throw packetError("WORLD_DIRECTOR_PACKET_CREDENTIAL_REJECTED");
  }
}

function takeSorted<T>(values: readonly T[], limit: number, key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right))).slice(0, limit);
}

function severityRank(severity: "minor" | "major" | "blocking"): string {
  return severity === "blocking" ? "0" : severity === "major" ? "1" : "2";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function packetError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
