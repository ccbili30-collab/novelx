import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  EditorialReviewRecord,
  GrowthEditorialRoundSnapshot,
  GrowthWorkOrder,
  GrowthWorkOrderAttempt,
  WorkOrderAttemptStart,
} from "../../../domain/growth/editorial/growthEditorialTypes";
import { editorialReviewRecordSchema } from "../../../domain/growth/editorial/growthEditorialTypes";
import {
  checkerReviewSchema,
  directorReviewSchema,
  type CheckerReview,
  type DirectorReview,
} from "../../../shared/growthEditorialContract";

const findingSchema = z.object({
  facetId: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
  severity: z.enum(["minor", "major", "blocking"]),
  summary: z.string().trim().min(1).max(2_000),
  evidenceRefs: z.array(z.string().regex(/^@evidence[1-9][0-9]*$/)).min(1).max(20),
}).strict();

export type EditorialPipelineFinding = z.infer<typeof findingSchema>;

export interface PersistedReviewArtifact {
  ref: string;
  sha256: string;
}

export interface GrowthEditorialReviewDependencies {
  deterministicValidate(input: ReviewStageInput): Promise<{ findings: EditorialPipelineFinding[] }>;
  curateGraph(input: ReviewStageInput & { deterministicFindings: EditorialPipelineFinding[] }): Promise<{
    findings: EditorialPipelineFinding[];
    artifact: PersistedReviewArtifact;
  }>;
  check(input: ReviewStageInput & {
    deterministicFindings: EditorialPipelineFinding[];
    graphFindings: EditorialPipelineFinding[];
    graphArtifact: PersistedReviewArtifact;
  }): Promise<{ review: CheckerReview; safeSummary: string; artifact: PersistedReviewArtifact }>;
  direct(input: ReviewStageInput & {
    hardBlocked: boolean;
    acceptanceFacetGaps: string[];
    checkerReview: CheckerReview;
    checkerArtifact: PersistedReviewArtifact;
  }): Promise<{ review: DirectorReview; safeSummary: string; artifact: PersistedReviewArtifact }>;
  persistPolicyDecision(input: {
    attempt: GrowthWorkOrderAttempt;
    review: DirectorReview;
    reason: "hard_finding" | "revision_limit" | "no_progress";
  }): Promise<PersistedReviewArtifact>;
}

interface ReviewStageInput {
  order: GrowthWorkOrder;
  attempt: GrowthWorkOrderAttempt;
  snapshot: GrowthEditorialRoundSnapshot;
  signal: AbortSignal;
}

export interface GrowthEditorialReviewCoordinatorOptions {
  maximumEditorialRevisions?: number;
}

export class GrowthEditorialReviewCoordinator {
  readonly #maximumEditorialRevisions: number;

  constructor(
    readonly dependencies: GrowthEditorialReviewDependencies,
    options: GrowthEditorialReviewCoordinatorOptions = {},
  ) {
    const maximum = options.maximumEditorialRevisions ?? 2;
    if (!Number.isInteger(maximum) || maximum < 0 || maximum > 10) throw reviewError("GROWTH_EDITORIAL_REVISION_LIMIT_INVALID");
    this.#maximumEditorialRevisions = maximum;
  }

  async review(input: ReviewStageInput): Promise<{
    checker: EditorialReviewRecord;
    director: EditorialReviewRecord;
    escalation: "ask_user" | null;
  }> {
    assertReviewBinding(input);
    const deterministic = await this.dependencies.deterministicValidate(input);
    assertNotAborted(input.signal);
    const deterministicFindings = parseFindings(deterministic.findings);
    const graph = await this.dependencies.curateGraph({ ...input, deterministicFindings });
    assertNotAborted(input.signal);
    const graphFindings = parseFindings(graph.findings);
    const checker = await this.dependencies.check({
      ...input,
      deterministicFindings,
      graphFindings,
      graphArtifact: parseArtifact(graph.artifact),
    });
    assertNotAborted(input.signal);
    const checkerReview = checkerReviewSchema.parse(checker.review);
    const checkerArtifact = parseArtifact(checker.artifact);
    const checkerFindings = readCheckerFindings(checkerReview);
    validateFindingFacetBindings([...deterministicFindings, ...graphFindings, ...checkerFindings], input.order);
    const hardFindings = [
      ...deterministicFindings,
      ...graphFindings,
      ...checkerFindings,
    ].filter((finding) => finding.severity === "blocking");
    const gapFacetIds = unique([
      ...hardFindings.map((finding) => finding.facetId),
      ...checkerFindings
        .filter((finding) => finding.severity !== "minor")
        .map((finding) => finding.facetId),
    ]).filter((facetId) => input.order.acceptanceFacets.some((facet) => facet.id === facetId));
    const hardBlocked = hardFindings.length > 0 || checkerReview.decision === "blocked";
    const directed = await this.dependencies.direct({
      ...input,
      hardBlocked,
      acceptanceFacetGaps: gapFacetIds,
      checkerReview,
      checkerArtifact,
    });
    assertNotAborted(input.signal);
    const proposed = directorReviewSchema.parse(directed.review);
    validateDirectorFacetBindings(proposed, input.order);

    const priorChecker = input.snapshot.reviews
      .filter((review) => review.workOrderId === input.order.id && review.reviewerKind === "checker"
        && review.attemptId !== input.attempt.id)
      .at(-1);
    const repeatedFinding = priorChecker?.artifactSha256 === checkerArtifact.sha256
      && checkerReview.decision !== "passed";
    const revisionCount = input.attempt.attemptNumber - 1;
    let finalReview = proposed;
    let finalArtifact = parseArtifact(directed.artifact);
    let policyReason: "hard_finding" | "revision_limit" | "no_progress" | null = null;

    if (hardBlocked && proposed.decision === "accept") {
      finalReview = revisionReview(input.order,
        hardFindings.length > 0 ? hardFindings : checkerFindings);
      policyReason = "hard_finding";
    }
    if (finalReview.decision === "revise" && revisionCount >= this.#maximumEditorialRevisions) {
      finalReview = escalationReview(finalReview, "已达到编辑返工上限，需要创作者决定继续、降级或记录债务。");
      policyReason = "revision_limit";
    } else if (finalReview.decision === "revise" && repeatedFinding) {
      finalReview = escalationReview(finalReview, "相同检查结果再次出现，继续自动返工没有可验证进展。");
      policyReason = "no_progress";
    }
    if (policyReason) {
      finalArtifact = parseArtifact(await this.dependencies.persistPolicyDecision({
        attempt: input.attempt,
        review: finalReview,
        reason: policyReason,
      }));
    }

    const checkerRecord = toCheckerRecord(input.attempt, checkerReview, checker.safeSummary, checkerArtifact, graph.artifact.ref);
    const directorRecord = toDirectorRecord(input.attempt, finalReview, finalArtifact,
      policyReason ? policySummary(policyReason) : directed.safeSummary);
    return {
      checker: checkerRecord,
      director: directorRecord,
      escalation: finalReview.decision === "ask_user" ? "ask_user" : null,
    };
  }
}

export function prepareSameOwnerRevisionAttempt(input: {
  order: GrowthWorkOrder;
  snapshot: GrowthEditorialRoundSnapshot;
  attemptId: string;
  idempotencyKey: string;
}): WorkOrderAttemptStart {
  const latest = input.snapshot.attempts.filter((attempt) => attempt.workOrderId === input.order.id).at(-1);
  if (!latest) throw reviewError("GROWTH_EDITORIAL_REVISION_OWNER_NOT_FOUND");
  if (latest.capability !== input.order.capability) throw reviewError("GROWTH_EDITORIAL_REVISION_OWNER_MISMATCH");
  return {
    id: input.attemptId,
    workOrderId: input.order.id,
    idempotencyKey: input.idempotencyKey,
    sourceCheckpointId: input.snapshot.round.sourceCheckpointId,
    ruleRevision: input.snapshot.round.ruleRevision,
    capability: latest.capability,
    capabilityProfile: { ...latest.capabilityProfile },
    prompt: { ...latest.prompt },
    model: { ...latest.model },
  };
}

function assertReviewBinding(input: ReviewStageInput): void {
  assertNotAborted(input.signal);
  if (input.attempt.workOrderId !== input.order.id || input.attempt.roundId !== input.snapshot.round.id
    || input.attempt.status !== "reviewing" || input.order.status !== "reviewing") {
    throw reviewError("GROWTH_EDITORIAL_REVIEW_BINDING_INVALID");
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw reviewError("AGENT_RUN_CANCELLED");
}

function parseFindings(findings: EditorialPipelineFinding[]): EditorialPipelineFinding[] {
  return z.array(findingSchema).max(100).parse(findings);
}

function parseArtifact(artifact: PersistedReviewArtifact): PersistedReviewArtifact {
  return z.object({
    ref: z.string().trim().min(1).max(2_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().parse(artifact);
}

function readCheckerFindings(review: CheckerReview): EditorialPipelineFinding[] {
  if (review.decision === "passed") return [];
  return review.findings.map((finding) => findingSchema.parse({
    facetId: finding.facetId,
    severity: finding.severity,
    summary: finding.summary,
    evidenceRefs: finding.evidenceRefs,
  }));
}

function validateDirectorFacetBindings(review: DirectorReview, order: GrowthWorkOrder): void {
  const allowed = new Set(order.acceptanceFacets.map((facet) => facet.id));
  if (review.reasons.some((reason) => !allowed.has(reason.facetId))) {
    throw reviewError("GROWTH_EDITORIAL_DIRECTOR_FACET_MISMATCH");
  }
  if (review.decision === "revise" && review.reasons.length === 0) {
    throw reviewError("GROWTH_EDITORIAL_REVISION_GAP_REQUIRED");
  }
}

function validateFindingFacetBindings(findings: EditorialPipelineFinding[], order: GrowthWorkOrder): void {
  const allowed = new Set(order.acceptanceFacets.map((facet) => facet.id));
  if (findings.some((finding) => !allowed.has(finding.facetId))) {
    throw reviewError("GROWTH_EDITORIAL_REVIEW_FACET_MISMATCH");
  }
}

function revisionReview(
  order: GrowthWorkOrder,
  hardFindings: EditorialPipelineFinding[],
): DirectorReview {
  const reasons = policyReasons(order, hardFindings);
  return {
    decision: "revise",
    reasons,
    revisionObjective: `修复 ${reasons.map((reason) => reason.facetId).join("、")} 的阻塞问题，并保持原 Work Order 范围。`,
  };
}

function escalationReview(review: Extract<DirectorReview, { decision: "revise" }>, question: string): DirectorReview {
  return { decision: "ask_user", reasons: review.reasons, question };
}

function policyReasons(
  order: GrowthWorkOrder,
  findings: EditorialPipelineFinding[],
): DirectorReview["reasons"] {
  const allowed = new Set(order.acceptanceFacets.map((facet) => facet.id));
  const reasons = findings.filter((finding) => allowed.has(finding.facetId)).map((finding) => ({
    facetId: finding.facetId,
    reason: finding.summary,
    evidenceRefs: finding.evidenceRefs,
  }));
  if (reasons.length > 0) return reasons.slice(0, 10);
  throw reviewError("GROWTH_EDITORIAL_ACCEPTANCE_EVIDENCE_REQUIRED");
}

function toCheckerRecord(
  attempt: GrowthWorkOrderAttempt,
  review: CheckerReview,
  safeSummary: string,
  artifact: PersistedReviewArtifact,
  graphArtifactRef: string,
): EditorialReviewRecord {
  const evidenceRefs = review.decision === "passed"
    ? [graphArtifactRef]
    : unique([...review.findings.flatMap((finding) => finding.evidenceRefs), graphArtifactRef]);
  return editorialReviewRecordSchema.parse({
    id: stableId(attempt.id, "checker"),
    attemptId: attempt.id,
    reviewerKind: "checker",
    decision: review.decision,
    safeSummary,
    evidenceRefs,
    artifactRef: artifact.ref,
    artifactSha256: artifact.sha256,
    idempotencyKey: stableId(attempt.id, "checker-key"),
  });
}

function toDirectorRecord(
  attempt: GrowthWorkOrderAttempt,
  review: DirectorReview,
  artifact: PersistedReviewArtifact,
  safeSummary: string,
): EditorialReviewRecord {
  return editorialReviewRecordSchema.parse({
    id: stableId(attempt.id, "director"),
    attemptId: attempt.id,
    reviewerKind: "director",
    decision: review.decision,
    safeSummary,
    evidenceRefs: unique(review.reasons.flatMap((reason) => reason.evidenceRefs)),
    artifactRef: artifact.ref,
    artifactSha256: artifact.sha256,
    idempotencyKey: stableId(attempt.id, "director-key"),
  });
}

function policySummary(reason: "hard_finding" | "revision_limit" | "no_progress"): string {
  if (reason === "hard_finding") return "阻塞发现覆盖了 Director 接受决定，已要求同所有者返工。";
  if (reason === "revision_limit") return "已达到自动编辑返工上限，等待创作者决定。";
  return "相同发现重复出现且没有进展，等待创作者决定。";
}

function stableId(attemptId: string, kind: string): string {
  return `editorial-${kind}-${createHash("sha256").update(`${attemptId}\0${kind}`, "utf8").digest("hex").slice(0, 32)}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function reviewError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
