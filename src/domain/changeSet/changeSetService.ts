import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { AssertionRepository } from "../graph/assertionRepository";
import { CheckpointRepository } from "../version/checkpointRepository";
import { DocumentRepository } from "../workspace/documentRepository";
import { ResourceRepository } from "../workspace/resourceRepository";
import { CreativeDocumentRepository } from "../workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../workspace/creativeRelationRepository";
import { ConstraintProfileRepository } from "../workspace/constraintProfileRepository";
import { AgentAuditRepository } from "../audit/agentAuditRepository";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import { CreativeCommitService } from "../commit/creativeCommitService";
import { ProjectionCoordinator } from "../projection/projectionCoordinator";
import { createDefaultProjectors } from "../projection/defaultProjectors";
import {
  ChangeSetRepository,
  type ChangeSetConflictRecord,
  type ChangeSetItemDecision,
  type ChangeSetItemRecord,
  type ChangeSetRecord,
  type ChangeSetRisk,
} from "./changeSetRepository";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const dependencyIdSchema = z.string().trim().min(1).max(160);
const commonItemShape = {
  id: z.string().trim().min(1).max(160),
  dependsOn: z.array(dependencyIdSchema).default([]),
};

const assertionItemSchema = z.object({
  ...commonItemShape,
  kind: z.literal("assertion.put"),
  payload: z.object({
    assertionId: z.string().trim().min(1).max(240),
    scopeType: z.string().trim().min(1).max(80),
    scopeId: z.string().trim().min(1).max(240),
    subject: z.string().trim().min(1).max(500),
    predicate: z.string().trim().min(1).max(240),
    object: z.record(z.string(), jsonValueSchema),
    evidenceIds: z.array(z.string().trim().min(1).max(240)).max(200).default([]),
    status: z.enum(["current", "conflict", "superseded", "rejected", "draft"]),
    source: z.object({
      kind: z.string().trim().min(1).max(120),
      ref: z.string().trim().min(1).max(1000),
    }).optional(),
  }).strict(),
}).strict();

const resourceItemSchema = z.object({
  ...commonItemShape,
  kind: z.literal("resource.put"),
  payload: z.object({
    resourceId: z.string().trim().min(1).max(240),
    create: z.boolean(),
    type: z.enum(["world", "oc", "story", "graph", "timeline", "asset"]),
    objectKind: z.enum([
      "domain_root", "world", "oc", "story", "volume", "chapter", "location", "faction",
      "oc_variant", "graph_view", "timeline_view", "asset_collection",
    ]).optional(),
    title: z.string().trim().min(1).max(500),
    parentId: z.string().trim().min(1).max(240).nullable(),
    state: z.enum(["active", "deleted"]),
    sortOrder: z.number().int().min(0).max(2_147_483_647).default(0),
  }).strict(),
}).strict();

const documentItemSchema = z.object({
  ...commonItemShape,
  kind: z.literal("document.put"),
  payload: z.object({
    resourceId: z.string().trim().min(1).max(240),
    creativeDocumentId: z.string().trim().min(1).max(240).optional(),
    content: z.string(),
    authorKind: z.enum(["agent", "import"]),
  }).strict(),
}).strict();

const creativeDocumentItemSchema = z.object({
  ...commonItemShape,
  kind: z.literal("creative_document.put"),
  payload: z.object({
    documentId: z.string().trim().min(1).max(240),
    create: z.boolean(),
    resourceId: z.string().trim().min(1).max(240),
    kind: z.enum([
      "prose", "setting", "character_profile", "location_profile", "faction_profile",
      "knowledge_note", "style_guide", "writing_constraints",
    ]),
    title: z.string().trim().min(1).max(500),
    state: z.enum(["active", "deleted"]),
    sortOrder: z.number().int().min(0).max(2_147_483_647).default(0),
  }).strict(),
}).strict();

const creativeRelationItemSchema = z.object({
  ...commonItemShape,
  kind: z.literal("creative_relation.put"),
  payload: z.object({
    relationId: z.string().trim().min(1).max(240),
    create: z.boolean(),
    relationKind: z.enum(["uses_world", "uses_oc", "variant_of", "related_to"]),
    sourceResourceId: z.string().trim().min(1).max(240),
    targetResourceId: z.string().trim().min(1).max(240),
    state: z.enum(["active", "deleted"]),
  }).strict(),
}).strict();

const constraintPayloadSchema = z.object({
  narrativePerson: z.enum(["first", "second", "third"]).nullable(),
  tense: z.enum(["past", "present", "mixed"]).nullable(),
  tone: z.string().max(500).nullable(),
  pacing: z.string().max(500).nullable(),
  humorLevel: z.number().int().min(0).max(5).nullable(),
  prohibitedContent: z.array(z.string().trim().min(1).max(1000)).max(500),
  requiredContent: z.array(z.string().trim().min(1).max(1000)).max(500),
  notes: z.string().max(20_000),
}).strict();

const constraintProfileItemSchema = z.object({
  ...commonItemShape,
  kind: z.literal("constraint_profile.put"),
  payload: z.object({
    profileId: z.string().trim().min(1).max(240),
    create: z.boolean(),
    scopeResourceId: z.string().trim().min(1).max(240).nullable(),
    title: z.string().trim().min(1).max(500),
    profile: constraintPayloadSchema,
    state: z.enum(["active", "deleted"]),
    authorKind: z.enum(["agent", "import"]),
  }).strict(),
}).strict();

const changeSetItemSchema = z.discriminatedUnion("kind", [
  assertionItemSchema,
  resourceItemSchema,
  documentItemSchema,
  creativeDocumentItemSchema,
  creativeRelationItemSchema,
  constraintProfileItemSchema,
]);

const proposalSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(240),
  expectedHeadCheckpointId: z.string().trim().min(1).max(240),
  mode: z.enum(["free", "assist"]),
  summary: z.string().trim().min(1).max(2000),
  items: z.array(changeSetItemSchema).min(1).max(500),
}).strict();

export type ChangeSetItem = z.infer<typeof changeSetItemSchema>;

export interface ChangeSetCandidate {
  mode: "free" | "assist";
  summary: string;
  items: ChangeSetItem[];
}

export interface ChangeSetPolicyAssessment {
  itemId: string;
  risk: ChangeSetRisk;
  conflicts: ChangeSetConflictRecord[];
}

export interface ChangeSetPolicyEvaluator {
  assess(candidate: ChangeSetCandidate): ChangeSetPolicyAssessment[];
}

export type PublicChangeSetItemKind = "fact" | "resource" | "document" | "relation" | "constraint";
export type PublicChangeSetBlockedReason =
  | "MAJOR_CONFLICT"
  | "FREE_REVIEW_REQUIRED"
  | "DEPENDENCY_UNRESOLVED"
  | "APPLY_FAILED"
  | "POLICY_BLOCKED";

export interface ChangeSetReviewSummary {
  id: string;
  summary: string;
  mode: "free" | "assist";
  status: "pending" | "committed" | "rejected" | "failed";
  gateStatus: "review_pending" | "ready" | "blocked";
  blockedReason: PublicChangeSetBlockedReason | null;
  itemCount: number;
  pendingCount: number;
}

export interface ChangeSetReviewItem {
  id: string;
  kind: PublicChangeSetItemKind;
  kindLabel: string;
  decision: ChangeSetItemDecision;
  risk: ChangeSetRisk;
  conflicts: Array<{ severity: "warning" | "major"; code: "POLICY_WARNING" | "MAJOR_CONFLICT" }>;
  semanticSummary: string;
  contentPreview: string | null;
  dependsOn: string[];
}

export interface ChangeSetReviewDetail extends ChangeSetReviewSummary {
  items: ChangeSetReviewItem[];
}

export interface ChangeSetApplier {
  apply(item: ChangeSetItem, context: { changeSetId: string; checkpointId: string }): ChangeSetApplyReceipt;
}

export interface ChangeSetApplyReceipt {
  kind:
    | "resource_revision"
    | "document_version"
    | "assertion_version"
    | "creative_document_revision"
    | "creative_relation_revision"
    | "constraint_profile_version";
  outputId: string;
  outputSha256: string;
}

export class WorkspaceChangeSetApplier implements ChangeSetApplier {
  readonly #assertions: AssertionRepository;
  readonly #resources: ResourceRepository;
  readonly #documents: DocumentRepository;
  readonly #creativeDocuments: CreativeDocumentRepository;
  readonly #creativeRelations: CreativeRelationRepository;
  readonly #constraintProfiles: ConstraintProfileRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#assertions = new AssertionRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
    this.#documents = new DocumentRepository(workspace);
    this.#creativeDocuments = new CreativeDocumentRepository(workspace);
    this.#creativeRelations = new CreativeRelationRepository(workspace);
    this.#constraintProfiles = new ConstraintProfileRepository(workspace);
  }

  apply(item: ChangeSetItem, context: { changeSetId: string; checkpointId: string }): ChangeSetApplyReceipt {
    switch (item.kind) {
      case "assertion.put": {
        const { evidenceIds, source: _proposalSource, ...assertion } = item.payload;
        const sources = [
          { kind: "confirmed_change_set", ref: `${context.changeSetId}:${item.id}` },
          ...evidenceIds.map((ref) => ({ kind: "evidence_version", ref })),
        ];
        const outputId = this.#assertions.putVersion({
          ...assertion,
          checkpointId: context.checkpointId,
          sources,
        });
        return {
          kind: "assertion_version",
          outputId,
          outputSha256: canonicalAuditHash({ ...assertion, checkpointId: context.checkpointId, sources }),
        };
      }
      case "resource.put": {
        const receipt = this.#resources.putRevisionWithReceipt({
          ...item.payload,
          checkpointId: context.checkpointId,
        });
        return {
          kind: "resource_revision",
          outputId: receipt.revisionId,
          outputSha256: receipt.revisionSha256,
        };
      }
      case "document.put": {
        const outputId = this.#documents.putVersion({
          ...item.payload,
          checkpointId: context.checkpointId,
        });
        const version = this.#documents.getVersion(outputId);
        if (!version) throw serviceError("DOCUMENT_VERSION_NOT_FOUND", "Committed document version was not found.");
        return {
          kind: "document_version",
          outputId,
          outputSha256: version.contentHash,
        };
      }
      case "creative_document.put": {
        const { documentId, ...payload } = item.payload;
        const receipt = this.#creativeDocuments.putRevisionWithReceipt({
          ...payload,
          documentId,
          checkpointId: context.checkpointId,
        });
        return {
          kind: "creative_document_revision",
          outputId: receipt.revisionId,
          outputSha256: receipt.revisionSha256,
        };
      }
      case "creative_relation.put": {
        const { relationKind, ...payload } = item.payload;
        const receipt = this.#creativeRelations.putRevisionWithReceipt({
          ...payload,
          kind: relationKind,
          checkpointId: context.checkpointId,
        });
        return {
          kind: "creative_relation_revision",
          outputId: receipt.revisionId,
          outputSha256: receipt.revisionSha256,
        };
      }
      case "constraint_profile.put": {
        const { profile, ...payload } = item.payload;
        const version = this.#constraintProfiles.putVersion({
          ...payload,
          payload: profile,
          checkpointId: context.checkpointId,
        });
        return {
          kind: "constraint_profile_version",
          outputId: version.versionId,
          outputSha256: version.payloadHash,
        };
      }
    }
  }
}

export class ChangeSetService {
  readonly #repository: ChangeSetRepository;
  readonly #checkpoints: CheckpointRepository;

  constructor(
    readonly workspace: WorkspaceDatabase,
    readonly policy?: ChangeSetPolicyEvaluator,
    readonly applier: ChangeSetApplier = new WorkspaceChangeSetApplier(workspace),
  ) {
    this.#repository = new ChangeSetRepository(workspace);
    this.#checkpoints = new CheckpointRepository(workspace);
  }

  propose(input: unknown, trusted: { producerToolInvocationId: string } | null = null): ChangeSetRecord {
    const proposal = proposalSchema.parse(input);
    validateDependencyGraph(proposal.items);
    const payloadHash = hashProposal(proposal);
    const existing = this.#repository.findByIdempotencyKey(proposal.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw serviceError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with different content.");
      }
      assertProducerIdentity(existing, trusted?.producerToolInvocationId ?? null);
      if (existing.mode === "free" && existing.status === "pending" && existing.gateStatus === "ready") {
        return this.#commitPrepared(existing.id, existing.baseCheckpointId, existing.summary);
      }
      return existing;
    }

    if (!this.policy) {
      throw serviceError("CHANGE_SET_POLICY_REQUIRED", "A trusted Change Set policy evaluator is required.");
    }
    const candidate: ChangeSetCandidate = {
      mode: proposal.mode,
      summary: proposal.summary,
      items: proposal.items,
    };
    const assessments = validateAssessments(candidate, this.policy.assess(candidate));
    const assessmentByItem = new Map(assessments.map((assessment) => [assessment.itemId, assessment]));
    const hasMajorConflict = assessments.some((assessment) =>
      assessment.conflicts.some((conflict) => conflict.severity === "major"));
    const freeNeedsReview = proposal.mode === "free" && assessments.some((assessment) => assessment.risk !== "low");
    const blockedReason = hasMajorConflict
      ? "MAJOR_CONFLICT"
      : freeNeedsReview
        ? "FREE_REVIEW_REQUIRED"
        : null;
    const gateStatus = blockedReason
      ? "blocked" as const
      : proposal.mode === "free"
        ? "ready" as const
        : "review_pending" as const;

    this.workspace.db.exec("BEGIN IMMEDIATE");
    let stored: ChangeSetRecord;
    try {
      const retry = this.#repository.findByIdempotencyKey(proposal.idempotencyKey);
      if (retry) {
        if (retry.payloadHash !== payloadHash) {
          throw serviceError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with different content.");
        }
        assertProducerIdentity(retry, trusted?.producerToolInvocationId ?? null);
        this.workspace.db.exec("COMMIT");
        return retry;
      }
      this.#assertExpectedHead(proposal.expectedHeadCheckpointId);
      const branch = this.#checkpoints.getActiveBranch();
      stored = this.#repository.insert({
        idempotencyKey: proposal.idempotencyKey,
        payloadHash,
        branchId: branch.id,
        baseCheckpointId: branch.headCheckpointId,
        mode: proposal.mode,
        summary: proposal.summary,
        gateStatus,
        blockedReason,
        producerToolInvocationId: trusted?.producerToolInvocationId ?? null,
        items: proposal.items.map((item) => {
          const assessment = assessmentByItem.get(item.id)!;
          return {
            ...item,
            risk: assessment.risk,
            conflicts: assessment.conflicts,
            decision: proposal.mode === "free" && !blockedReason ? "accepted" : "pending",
          };
        }),
      });
      this.workspace.db.exec("COMMIT");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }

    if (proposal.mode === "free" && stored.gateStatus === "ready") {
      return this.#commitPrepared(stored.id, proposal.expectedHeadCheckpointId, proposal.summary);
    }
    return stored;
  }

  listPendingForReview(): ChangeSetReviewSummary[] {
    const branch = this.#checkpoints.getActiveBranch();
    return this.#repository.listPending(branch.id).map(projectSummary);
  }

  getReviewDetail(changeSetId: string): ChangeSetReviewDetail {
    const changeSet = this.#repository.getRequired(changeSetId);
    this.#assertBranch(changeSet);
    return projectDetail(changeSet, this.workspace);
  }

  decideItem(changeSetId: string, itemId: string, decision: Exclude<ChangeSetItemDecision, "pending">): ChangeSetRecord {
    if (!changeSetId.trim() || !itemId.trim()) throw serviceError("CHANGE_SET_INPUT_INVALID", "Change Set decision input is invalid.");
    if (!(["accepted", "rejected", "draft"] as const).includes(decision)) {
      throw serviceError("CHANGE_SET_DECISION_INVALID", "Change Set item decision is invalid.");
    }
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const changeSet = this.#repository.getRequired(changeSetId);
      if (changeSet.mode !== "assist") throw serviceError("CHANGE_SET_REVIEW_NOT_ALLOWED", "Only Assist Change Sets support item review.");
      if (changeSet.status !== "pending") throw serviceError("CHANGE_SET_NOT_PENDING", "Change Set is not pending.");
      this.#assertBranch(changeSet);
      this.#repository.setItemDecision(changeSetId, itemId, decision);
      const updated = this.#repository.getRequired(changeSetId);
      const gate = evaluateAssistGate(updated.items);
      const hasMajorConflict = updated.items.some((item) =>
        item.conflicts.some((conflict) => conflict.severity === "major"));
      this.#repository.setGate(
        changeSetId,
        hasMajorConflict ? "blocked" : gate.status,
        hasMajorConflict ? "MAJOR_CONFLICT" : gate.blockedReason,
      );
      this.workspace.db.exec("COMMIT");
      return this.#repository.getRequired(changeSetId);
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  finalizeAssist(
    changeSetId: string,
    input: { expectedHeadCheckpointId: string; label: string },
  ): ChangeSetRecord {
    const expectedHead = input.expectedHeadCheckpointId.trim();
    const label = input.label.trim();
    if (!expectedHead || !label) throw serviceError("CHANGE_SET_INPUT_INVALID", "Finalize input is invalid.");
    const changeSet = this.#repository.getRequired(changeSetId);
    if (changeSet.mode !== "assist") throw serviceError("CHANGE_SET_REVIEW_NOT_ALLOWED", "Only Assist Change Sets can be finalized here.");
    if (changeSet.status !== "pending") {
      if (changeSet.status === "committed" || changeSet.status === "rejected") return changeSet;
      throw serviceError("CHANGE_SET_NOT_PENDING", "Change Set is not pending.");
    }
    this.#assertCommitHead(changeSet, expectedHead);
    if (changeSet.items.some((item) => item.conflicts.some((conflict) => conflict.severity === "major"))) {
      throw serviceError("CHANGE_SET_MAJOR_CONFLICT", "A major conflict blocks this Change Set.");
    }
    if (changeSet.items.some((item) => item.decision === "pending")) {
      throw serviceError("CHANGE_SET_REVIEW_INCOMPLETE", "Every Change Set item requires a decision.");
    }
    const dependencyFailure = findUnresolvedDependency(changeSet.items);
    if (dependencyFailure) {
      throw serviceError("CHANGE_SET_DEPENDENCY_UNRESOLVED", "An accepted item depends on an item that was not accepted.");
    }
    if (!changeSet.items.some((item) => item.decision === "accepted")) {
      this.workspace.db.exec("BEGIN IMMEDIATE");
      try {
        this.#assertCommitHead(this.#repository.getRequired(changeSetId), expectedHead);
        this.#repository.markRejected(changeSetId);
        this.workspace.db.exec("COMMIT");
        return this.#repository.getRequired(changeSetId);
      } catch (error) {
        this.workspace.db.exec("ROLLBACK");
        throw error;
      }
    }
    return this.#commitPrepared(changeSetId, expectedHead, label);
  }

  finalizeAssistReview(changeSetId: string, label: string): ChangeSetRecord {
    const changeSet = this.#repository.getRequired(changeSetId);
    return this.finalizeAssist(changeSetId, {
      expectedHeadCheckpointId: changeSet.baseCheckpointId,
      label,
    });
  }

  getRequired(changeSetId: string): ChangeSetRecord {
    return this.#repository.getRequired(changeSetId);
  }

  #commitPrepared(changeSetId: string, expectedHead: string, label: string): ChangeSetRecord {
    let applyStarted = false;
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const changeSet = this.#repository.getRequired(changeSetId);
      if (changeSet.status === "committed") {
        this.workspace.db.exec("COMMIT");
        return changeSet;
      }
      if (changeSet.status !== "pending") throw serviceError("CHANGE_SET_NOT_PENDING", "Change Set is not pending.");
      if (changeSet.gateStatus !== "ready") throw serviceError("CHANGE_SET_BLOCKED", "Change Set policy gate is not ready.");
      this.#assertCommitHead(changeSet, expectedHead);
      const accepted = changeSet.items.filter((item) => item.decision === "accepted");
      const ordered = orderAcceptedItems(accepted);
      applyStarted = true;
      const checkpointId = this.#checkpoints.appendCheckpoint(changeSet.branchId, label, { actorKind: "agent", sourceChangeSetId: changeSetId });
      for (const item of ordered) {
        const parsedItem = changeSetItemSchema.parse({
          id: item.id,
          kind: item.kind,
          payload: item.payload,
          dependsOn: item.dependsOn,
        });
        const output = this.applier.apply(parsedItem, { changeSetId, checkpointId });
        this.#repository.recordOutput(changeSetId, item.id, output);
      }
      this.#repository.markCommitted(changeSetId, checkpointId);
      new AgentAuditRepository(this.workspace).linkChangeSetOutputs(changeSetId);
      new CreativeCommitService(this.workspace).sealCheckpoint(checkpointId);
      this.workspace.db.exec("COMMIT");
      new ProjectionCoordinator(this.workspace, createDefaultProjectors(this.workspace)).runAll(checkpointId);
      return this.#repository.getRequired(changeSetId);
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      if (applyStarted) this.#recordApplyFailure(changeSetId);
      throw error;
    }
  }

  #recordApplyFailure(changeSetId: string): void {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      this.#repository.markFailed(changeSetId, "CHANGE_SET_APPLY_FAILED");
      this.workspace.db.exec("COMMIT");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  #assertExpectedHead(expectedHead: string): void {
    const branch = this.#checkpoints.getActiveBranch();
    if (branch.headCheckpointId !== expectedHead) {
      throw serviceError("CHANGE_SET_EXPECTED_HEAD_MISMATCH", "Expected head does not match the active branch head.");
    }
  }

  #assertBranch(changeSet: ChangeSetRecord): void {
    const branch = this.#checkpoints.getActiveBranch();
    if (branch.id !== changeSet.branchId) {
      throw serviceError("CHANGE_SET_BRANCH_MISMATCH", "Change Set belongs to another branch.");
    }
  }

  #assertCommitHead(changeSet: ChangeSetRecord, expectedHead: string): void {
    this.#assertBranch(changeSet);
    if (expectedHead !== changeSet.baseCheckpointId) {
      throw serviceError("CHANGE_SET_EXPECTED_HEAD_MISMATCH", "Expected head does not match the Change Set base.");
    }
    const branch = this.#checkpoints.getActiveBranch();
    if (branch.headCheckpointId !== changeSet.baseCheckpointId) {
      throw serviceError("CHANGE_SET_BASE_STALE", "Change Set base is stale.");
    }
  }
}

function validateAssessments(
  candidate: ChangeSetCandidate,
  assessments: ChangeSetPolicyAssessment[],
): ChangeSetPolicyAssessment[] {
  if (!Array.isArray(assessments)) throw serviceError("CHANGE_SET_POLICY_INVALID", "Policy assessment is invalid.");
  const expected = new Set(candidate.items.map((item) => item.id));
  const seen = new Set<string>();
  for (const assessment of assessments) {
    if (!assessment || typeof assessment.itemId !== "string" || !expected.has(assessment.itemId) || seen.has(assessment.itemId)) {
      throw serviceError("CHANGE_SET_POLICY_INVALID", "Policy assessment item coverage is invalid.");
    }
    if (assessment.risk !== "low" && assessment.risk !== "elevated") {
      throw serviceError("CHANGE_SET_POLICY_INVALID", "Policy assessment risk is invalid.");
    }
    if (!Array.isArray(assessment.conflicts) || !assessment.conflicts.every(isConflict)) {
      throw serviceError("CHANGE_SET_POLICY_INVALID", "Policy assessment conflicts are invalid.");
    }
    seen.add(assessment.itemId);
  }
  if (seen.size !== expected.size) throw serviceError("CHANGE_SET_POLICY_INVALID", "Policy assessment must cover every item.");
  return assessments;
}

function validateDependencyGraph(items: ChangeSetItem[]): void {
  const itemIds = new Set<string>();
  for (const item of items) {
    if (itemIds.has(item.id)) throw serviceError("CHANGE_SET_ITEM_DUPLICATE", "Change Set item IDs must be unique.");
    itemIds.add(item.id);
    if (new Set(item.dependsOn).size !== item.dependsOn.length) {
      throw serviceError("CHANGE_SET_DEPENDENCY_DUPLICATE", "Change Set dependencies must be unique.");
    }
  }
  for (const item of items) {
    for (const dependencyId of item.dependsOn) {
      if (!itemIds.has(dependencyId)) throw serviceError("CHANGE_SET_DEPENDENCY_NOT_FOUND", "Change Set dependency not found.");
      if (dependencyId === item.id) throw serviceError("CHANGE_SET_DEPENDENCY_CYCLE", "Change Set item cannot depend on itself.");
    }
  }
  orderByDependencies(items.map((item) => ({ id: item.id, dependsOn: item.dependsOn })));
}

function evaluateAssistGate(items: ChangeSetItemRecord[]): { status: "review_pending" | "ready" | "blocked"; blockedReason: string | null } {
  if (items.some((item) => item.decision === "pending")) return { status: "review_pending", blockedReason: null };
  if (findUnresolvedDependency(items)) return { status: "blocked", blockedReason: "DEPENDENCY_UNRESOLVED" };
  return { status: "ready", blockedReason: null };
}

function findUnresolvedDependency(items: ChangeSetItemRecord[]): { itemId: string; dependencyId: string } | null {
  const decisions = new Map(items.map((item) => [item.id, item.decision]));
  for (const item of items) {
    if (item.decision !== "accepted") continue;
    for (const dependencyId of item.dependsOn) {
      if (decisions.get(dependencyId) !== "accepted") return { itemId: item.id, dependencyId };
    }
  }
  return null;
}

function orderAcceptedItems(items: ChangeSetItemRecord[]): ChangeSetItemRecord[] {
  const acceptedIds = new Set(items.map((item) => item.id));
  return orderByDependencies(items.map((item) => ({
    ...item,
    dependsOn: item.dependsOn.filter((dependencyId) => acceptedIds.has(dependencyId)),
  }))) as ChangeSetItemRecord[];
}

function orderByDependencies<T extends { id: string; dependsOn: string[] }>(items: T[]): T[] {
  const remaining = new Map(items.map((item) => [item.id, item]));
  const emitted = new Set<string>();
  const ordered: T[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const [id, item] of remaining) {
      if (item.dependsOn.every((dependencyId) => emitted.has(dependencyId))) {
        ordered.push(item);
        emitted.add(id);
        remaining.delete(id);
        progressed = true;
      }
    }
    if (!progressed) throw serviceError("CHANGE_SET_DEPENDENCY_CYCLE", "Change Set dependencies contain a cycle.");
  }
  return ordered;
}

function isConflict(value: unknown): value is ChangeSetConflictRecord {
  if (!value || typeof value !== "object") return false;
  const conflict = value as Record<string, unknown>;
  return (conflict.severity === "warning" || conflict.severity === "major")
    && typeof conflict.code === "string"
    && conflict.code.trim().length > 0;
}

function hashProposal(proposal: z.infer<typeof proposalSchema>): string {
  return createHash("sha256").update(stableStringify({
    expectedHeadCheckpointId: proposal.expectedHeadCheckpointId,
    mode: proposal.mode,
    summary: proposal.summary,
    items: proposal.items.map((item) => ({ ...item, dependsOn: [...item.dependsOn].sort() })),
  }), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function projectSummary(changeSet: ChangeSetRecord): ChangeSetReviewSummary {
  return {
    id: changeSet.id,
    summary: changeSet.summary,
    mode: changeSet.mode,
    status: changeSet.status,
    gateStatus: changeSet.gateStatus,
    blockedReason: projectBlockedReason(changeSet.blockedReason),
    itemCount: changeSet.items.length,
    pendingCount: changeSet.items.filter((item) => item.decision === "pending").length,
  };
}

function projectDetail(changeSet: ChangeSetRecord, workspace: WorkspaceDatabase): ChangeSetReviewDetail {
  const resourceTitles = new Map(
    new ResourceRepository(workspace).listCurrent().map((resource) => [resource.id, resource.title]),
  );
  const parsedItems = changeSet.items.map((stored) => {
    const parsed = changeSetItemSchema.safeParse({
      id: stored.id,
      kind: stored.kind,
      payload: stored.payload,
      dependsOn: stored.dependsOn,
    });
    if (!parsed.success) throw serviceError("CHANGE_SET_DATA_INVALID", "Stored Change Set item is invalid.");
    if (parsed.data.kind === "resource.put") {
      resourceTitles.set(parsed.data.payload.resourceId, parsed.data.payload.title);
    }
    return { stored, item: parsed.data };
  });

  return {
    ...projectSummary(changeSet),
    items: parsedItems.map(({ stored, item }) => projectReviewItem(stored, item, resourceTitles)),
  };
}

function projectReviewItem(
  stored: ChangeSetItemRecord,
  item: ChangeSetItem,
  resourceTitles: ReadonlyMap<string, string>,
): ChangeSetReviewItem {
  const common = {
    id: item.id,
    decision: stored.decision,
    risk: stored.risk,
    conflicts: stored.conflicts.map((conflict) => ({
      severity: conflict.severity,
      code: conflict.severity === "major" ? "MAJOR_CONFLICT" as const : "POLICY_WARNING" as const,
    })),
    dependsOn: [...item.dependsOn],
  };
  switch (item.kind) {
    case "assertion.put":
      return {
        ...common,
        kind: "fact",
        kindLabel: "世界事实",
        semanticSummary: `${item.payload.subject} · ${item.payload.predicate}`,
        contentPreview: previewText(typeof item.payload.object.text === "string" ? item.payload.object.text : null),
      };
    case "resource.put": {
      const label = RESOURCE_KIND_LABELS[item.payload.type];
      return {
        ...common,
        kind: "resource",
        kindLabel: label,
        semanticSummary: `${item.payload.create ? "创建" : "更新"}${label}：${item.payload.title}`,
        contentPreview: null,
      };
    }
    case "document.put": {
      const title = resourceTitles.get(item.payload.resourceId) ?? "创作内容";
      return {
        ...common,
        kind: "document",
        kindLabel: "知识文档",
        semanticSummary: `更新文档：${title}`,
        contentPreview: previewText(item.payload.content),
      };
    }
    case "creative_document.put":
      return {
        ...common,
        kind: "document",
        kindLabel: "创作文档",
        semanticSummary: `${item.payload.create ? "创建" : "更新"}文档：${item.payload.title}`,
        contentPreview: null,
      };
    case "creative_relation.put":
      return {
        ...common,
        kind: "relation",
        kindLabel: "对象关联",
        semanticSummary: `${item.payload.state === "deleted" ? "移除" : "建立"}对象关联`,
        contentPreview: null,
      };
    case "constraint_profile.put":
      return {
        ...common,
        kind: "constraint",
        kindLabel: "写作约束",
        semanticSummary: `${item.payload.create ? "创建" : "更新"}约束：${item.payload.title}`,
        contentPreview: previewText(item.payload.profile.notes),
      };
  }
}

function projectBlockedReason(value: string | null): PublicChangeSetBlockedReason | null {
  if (value === null) return null;
  if (value === "MAJOR_CONFLICT"
    || value === "FREE_REVIEW_REQUIRED"
    || value === "DEPENDENCY_UNRESOLVED"
    || value === "APPLY_FAILED") return value;
  return "POLICY_BLOCKED";
}

function previewText(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= 2_000 ? value : `${value.slice(0, 1_999)}…`;
}

function assertProducerIdentity(changeSet: ChangeSetRecord, producerToolInvocationId: string | null): void {
  if (changeSet.producerToolInvocationId !== producerToolInvocationId) {
    throw serviceError("CHANGE_SET_PROVENANCE_MISMATCH", "Change Set producer identity does not match the original proposal.");
  }
}

const RESOURCE_KIND_LABELS = {
  world: "世界资料",
  oc: "OC 资料",
  story: "故事内容",
  graph: "图谱内容",
  timeline: "时间线内容",
  asset: "资产资料",
} as const;

function serviceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
