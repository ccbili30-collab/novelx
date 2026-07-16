import type { SQLOutputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { ResourceRepository } from "../workspace/resourceRepository";
import {
  growthCycleAttachChangeSetSchema,
  growthCycleAttachRunSchema,
  growthCycleBeginSchema,
  growthCycleIntentSchema,
  growthCycleSchema,
  growthCycleTerminalizeSchema,
  growthEventAppendSchema,
  growthEventSchema,
  growthGoalCreateSchema,
  growthGoalSchema,
  growthInquiryBatchSchema,
  growthInquiryBatchSealSchema,
  growthInquiryCreatorAnswerCreateSchema,
  growthInquiryCreatorAnswerSchema,
  growthInquiryLifecycleAppendSchema,
  growthInquiryLifecycleSchema,
  growthClosureAssessmentAppendSchema,
  growthClosureAssessmentSchema,
  growthClosureProfileCreateSchema,
  growthClosureProfileSchema,
  growthClosureRevisionAppendSchema,
  growthClosureRevisionSchema,
  growthClosureReviewSchema,
  growthClosureReviewSealSchema,
  growthClosureStewardSubmissionSchema,
  growthClosureCheckerSubmissionSchema,
  growthClosureReviewV4SealSchema,
  growthClosureEvaluationOutcomeSealSchema,
  growthClosureEvaluationOutcomeSchema,
  growthClosureRepairLineageCreateSchema,
  growthClosureRepairLineageSchema,
  growthClosureStateSchema,
  growthIllustrationBatchSchema,
  growthIllustrationBatchSealSchema,
  growthIllustrationImageJobBindSchema,
  growthIllustrationItemSchema,
  growthIllustrationMarkStaleSchema,
  growthIllustrationRequestCreateSchema,
  growthIllustrationRequestSchema,
  growthRetrievalReceiptCreateSchema,
  growthRetrievalReceiptSchema,
  growthRuleAppendSchema,
  growthRuleRevisionSchema,
  type GrowthCycle,
  type GrowthCycleIntent,
  type GrowthEvent,
  type GrowthEventAppend,
  type GrowthGoal,
  type GrowthGoalCreate,
  type GrowthInquiryBatch,
  type GrowthInquiryCreatorAnswer,
  type GrowthInquiryLifecycle,
  type GrowthClosureAssessment,
  type GrowthClosureProfile,
  type GrowthClosureRevision,
  type GrowthClosureReview,
  type GrowthClosureState,
  type GrowthClosureStewardSubmission,
  type GrowthClosureCheckerSubmission,
  type GrowthClosureEvaluationOutcome,
  type GrowthClosureRepairLineage,
  type GrowthClosureFacetResult,
  type GrowthClosureAdverseFinding,
  type GrowthIllustrationBatch,
  type GrowthIllustrationItem,
  type GrowthIllustrationRequest,
  type GrowthRetrievalReceipt,
  type GrowthRetrievalReceiptCreate,
  type GrowthRuleRevision,
} from "../../shared/growthContract";

type Row = Record<string, SQLOutputValue>;
type ClosureAssessmentRowInput = {
  id: string; profileId: string; revision: number; role: "steward" | "checker";
  decision: "continue_growing" | "ready_for_checker" | "accepted" | "repairs_required" | "blocked";
  cycleId: string; checkpointId: string; ruleRevision: number; receiptId: string;
  agentInvocationId: string; outputSha256: string; idempotencyKey: string;
};

export interface GrowthPriorInquiryContext {
  inquiryId: string;
  question: string;
  evidenceState: "known" | "conflicted" | "unknown";
  safeSummary: string;
  priority: number;
  lifecycleSequence: number;
  lifecyclePhase: "backlog" | "selected" | "creator_answered";
}

export class GrowthRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  createGoal(input: unknown): GrowthGoal {
    const value = growthGoalCreateSchema.parse(input);
    const payloadHash = canonicalAuditHash({
      id: value.id, branchId: value.branchId, seed: value.seed, scopes: value.authorizedScopeResourceIds,
      initialRuleText: value.initialRuleText, sourceMessageId: value.sourceMessageId,
    });
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.workspace.db.prepare("SELECT id, payload_hash FROM growth_goals WHERE idempotency_key = ?")
        .get(value.idempotencyKey) as { id: string; payload_hash: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw growthError("GROWTH_IDEMPOTENCY_KEY_REUSED");
        const goal = this.getGoal(existing.id);
        if (!goal) throw growthError("GROWTH_DATA_INVALID");
        this.workspace.db.exec("COMMIT");
        return goal;
      }
      if (this.workspace.db.prepare("SELECT 1 FROM growth_goals WHERE id = ?").get(value.id)) throw growthError("GROWTH_GOAL_ID_CONFLICT");
      const checkpointId = this.#getBranchHead(value.branchId);
      this.#assertScopesVisible(value.authorizedScopeResourceIds, checkpointId);
      this.#assertSeedVisible(value.seed, checkpointId);
      const now = new Date().toISOString();
      const seed = seedColumns(value.seed);
      this.workspace.db.prepare(`
        INSERT INTO growth_goals (
          id, idempotency_key, payload_hash, branch_id, seed_kind, seed_text, seed_source_document_id,
          seed_source_version_id, seed_resource_id, seed_resource_version_id, status, current_rule_revision,
          current_cycle_sequence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 0, ?, ?)
      `).run(value.id, value.idempotencyKey, payloadHash, value.branchId, seed.kind, seed.text, seed.sourceDocumentId,
        seed.sourceVersionId, seed.resourceId, seed.resourceVersionId, now, now);
      const insertScope = this.workspace.db.prepare("INSERT INTO growth_goal_scopes (goal_id, resource_id, ordinal) VALUES (?, ?, ?)");
      value.authorizedScopeResourceIds.forEach((resourceId, ordinal) => insertScope.run(value.id, resourceId, ordinal));
      this.workspace.db.prepare(`
        INSERT INTO growth_goal_rule_revisions (goal_id, revision, rule_text, source_message_id, created_at)
        VALUES (?, 1, ?, ?, ?)
      `).run(value.id, value.initialRuleText, value.sourceMessageId, now);
      this.workspace.db.exec("COMMIT");
      return this.getGoal(value.id) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  getGoal(goalId: string): GrowthGoal | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_goals WHERE id = ?").get(goalId) as Row | undefined;
    if (!row) return null;
    return growthGoalSchema.parse({
      id: readString(row, "id"), branchId: readString(row, "branch_id"), seed: readSeed(row),
      authorizedScopeResourceIds: this.#goalScopes(goalId), status: readString(row, "status"),
      currentRuleRevision: readNumber(row, "current_rule_revision"), currentCycleSequence: readNumber(row, "current_cycle_sequence"),
      createdAt: readString(row, "created_at"), updatedAt: readString(row, "updated_at"),
    });
  }

  getRuleRevision(goalId: string, revision: number): GrowthRuleRevision {
    this.#requiredGoal(goalId);
    const row = this.workspace.db.prepare(`
      SELECT * FROM growth_goal_rule_revisions WHERE goal_id = ? AND revision = ?
    `).get(goalId, revision) as Row | undefined;
    if (!row) throw growthError("GROWTH_RULE_REVISION_NOT_FOUND");
    return mapRuleRevision(row);
  }

  listRuleRevisions(
    goalId: string,
    options: { fromRevision?: number; limit: number },
  ): GrowthRuleRevision[] {
    this.#requiredGoal(goalId);
    const fromRevision = options.fromRevision ?? 1;
    if (!Number.isInteger(fromRevision) || fromRevision < 1 || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw growthError("GROWTH_RULE_LIST_BOUNDS_INVALID");
    }
    return (this.workspace.db.prepare(`
      SELECT * FROM growth_goal_rule_revisions
      WHERE goal_id = ? AND revision >= ?
      ORDER BY revision
      LIMIT ?
    `).all(goalId, fromRevision, options.limit) as Row[]).map(mapRuleRevision);
  }

  getCycle(cycleId: string): GrowthCycle | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_cycles WHERE id = ?").get(cycleId) as Row | undefined;
    return row ? mapCycle(row) : null;
  }

  listCycles(goalId: string): GrowthCycle[] {
    this.#requiredGoal(goalId);
    return (this.workspace.db.prepare("SELECT * FROM growth_cycles WHERE goal_id = ? ORDER BY sequence").all(goalId) as Row[])
      .map(mapCycle);
  }

  getCycleIntent(cycleId: string): GrowthCycleIntent {
    const cycle = this.#requiredCycle(cycleId);
    const row = this.workspace.db.prepare("SELECT * FROM growth_cycle_intents WHERE cycle_id = ?").get(cycleId) as Row | undefined;
    if (!row) {
      const legacyPayloadHash = canonicalAuditHash({
        id: cycle.id,
        goalId: cycle.goalId,
        idempotencyKey: cycle.idempotencyKey,
        inputCheckpointId: cycle.inputCheckpointId,
        ruleRevision: cycle.ruleRevision,
      });
      const stored = this.workspace.db.prepare("SELECT payload_hash FROM growth_cycles WHERE id = ?")
        .get(cycle.id) as Row | undefined;
      if (!stored || readString(stored, "payload_hash") !== legacyPayloadHash) throw growthError("GROWTH_CYCLE_INTENT_REQUIRED");
      return legacyCycleIntent(cycle);
    }
    const kind = readString(row, "kind");
    if (kind === "closure_evaluation") return growthCycleIntentSchema.parse({
      cycleId, kind, provenance: readString(row, "contract_generation"), profileId: readString(row, "profile_id"),
      revision: readNumber(row, "revision"), checkpointId: readString(row, "checkpoint_id"),
    });
    if (kind === "repair") return growthCycleIntentSchema.parse({
      cycleId, kind, provenance: readString(row, "contract_generation"), profileId: readString(row, "profile_id"),
      revision: readNumber(row, "revision"), originalReviewId: readString(row, "original_review_id"),
      selectedFindingId: readString(row, "selected_finding_id"),
      selectedFindingFingerprint: readString(row, "selected_finding_fingerprint"),
    });
    const focusKinds = (this.workspace.db.prepare(`
      SELECT focus_kind FROM growth_cycle_intent_focuses WHERE cycle_id = ? ORDER BY ordinal
    `).all(cycleId) as Array<{ focus_kind: string }>).map((entry) => entry.focus_kind);
    const resumeFrontier = (this.workspace.db.prepare(`
      SELECT frontier_kind FROM growth_cycle_intent_frontier WHERE cycle_id = ? ORDER BY ordinal
    `).all(cycleId) as Array<{ frontier_kind: string }>).map((entry) => entry.frontier_kind);
    return growthCycleIntentSchema.parse({
      cycleId, kind, focusKinds, resumeFrontier, provenance: readString(row, "contract_generation"),
    });
  }

  listCycleIntents(goalId: string): GrowthCycleIntent[] {
    return this.listCycles(goalId).map((cycle) => this.getCycleIntent(cycle.id));
  }

  listClosureStates(goalId: string): GrowthClosureState[] {
    this.#requiredGoal(goalId);
    const rows = this.workspace.db.prepare(`
      SELECT id FROM growth_closure_profiles WHERE goal_id = ? ORDER BY created_at, id
    `).all(goalId) as Array<{ id: string }>;
    return rows.map((row) => this.getClosureState(row.id));
  }

  getReceipt(receiptId: string): GrowthRetrievalReceipt | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_retrieval_receipts WHERE id = ?").get(receiptId) as Row | undefined;
    if (!row) return null;
    const scopes = this.workspace.db.prepare("SELECT resource_id FROM growth_retrieval_receipt_scopes WHERE receipt_id = ? ORDER BY ordinal")
      .all(receiptId) as Array<{ resource_id: string }>;
    const aliases = this.workspace.db.prepare("SELECT alias FROM growth_retrieval_receipt_aliases WHERE receipt_id = ? ORDER BY ordinal")
      .all(receiptId) as Array<{ alias: string }>;
    const links = (this.workspace.db.prepare("SELECT * FROM growth_retrieval_receipt_links WHERE receipt_id = ? ORDER BY rank")
      .all(receiptId) as Row[]).map((link) => ({
      rank: readNumber(link, "rank"), targetKind: readString(link, "target_kind"), targetId: readString(link, "target_id"),
      targetVersionId: readNullableString(link, "target_version_id"), score: readNumber(link, "score"),
      reasonCodes: parseJsonArray(readString(link, "reason_codes_json")), pathTargetIds: parseJsonArray(readString(link, "path_target_ids_json")),
      stableLocator: readNullableString(link, "stable_locator"), stableVersionId: readNullableString(link, "stable_version_id"),
      stableHash: readNullableString(link, "stable_hash"),
    }));
    return growthRetrievalReceiptSchema.parse({
      id: readString(row, "id"), cycleId: readString(row, "cycle_id"), runId: readString(row, "run_id"),
      toolInvocationId: readString(row, "tool_invocation_id"), branchId: readString(row, "branch_id"), checkpointId: readString(row, "checkpoint_id"),
      lens: readString(row, "lens"), effectiveScopeResourceIds: scopes.map((scope) => scope.resource_id), query: readString(row, "query_text"),
      aliases: aliases.map((alias) => alias.alias),
      validTime: timeRange(row, "valid_time_from", "valid_time_to"), recordedTime: timeRange(row, "recorded_time_from", "recorded_time_to"),
      maxHops: readNumber(row, "max_hops"), cpuBudgetMs: readNumber(row, "cpu_budget_ms"), expansionBudget: readNumber(row, "expansion_budget"),
      resultBudget: readNumber(row, "result_budget"), tokenBudget: readNumber(row, "token_budget"), policyVersion: readString(row, "policy_version"),
      queryHash: readString(row, "query_hash"), resultHash: readString(row, "result_hash"), hitCount: readNumber(row, "hit_count"),
      conflictCount: readNumber(row, "conflict_count"), locatorCount: readNumber(row, "locator_count"),
      coverage: { state: readString(row, "coverage_state"), searchedScopeCount: readNumber(row, "coverage_searched_scope_count"), omittedCount: readNumber(row, "coverage_omitted_count") },
      truncated: readNumber(row, "truncated") === 1, createdAt: readString(row, "created_at"), links,
    });
  }

  listEvents(goalId: string): GrowthEvent[] {
    return (this.workspace.db.prepare("SELECT * FROM growth_events WHERE goal_id = ? ORDER BY sequence").all(goalId) as Row[]).map(mapEvent);
  }

  getInquiryBatch(batchId: string): GrowthInquiryBatch | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_inquiry_batches WHERE id = ?").get(batchId) as Row | undefined;
    if (!row) return null;
    try {
      const contract = this.workspace.db.prepare(`
        SELECT contract_version, creator_choice_required_inquiry_id
        FROM growth_inquiry_batch_contracts WHERE batch_id = ?
      `).get(batchId) as Row | undefined;
      if (!contract) throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
      const contractVersion = readString(contract, "contract_version");
      const questionRows = this.workspace.db.prepare(`
        SELECT * FROM growth_inquiries WHERE batch_id = ? ORDER BY ordinal
      `).all(batchId) as Row[];
      if (questionRows.length !== readNumber(row, "question_count")) throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
      const storedSelectedIds = questionRows
        .filter((question) => readNumber(question, "selected") === 1)
        .map((question) => readString(question, "id"));
      const evidenceFor = (inquiryId: string) => (this.workspace.db.prepare(`
        SELECT receipt_id, rank FROM growth_inquiry_evidence_links
        WHERE batch_id = ? AND inquiry_id = ? ORDER BY ordinal
      `).all(batchId, inquiryId) as Array<{ receipt_id: string; rank: number }>).map((link) => ({
        receiptId: link.receipt_id, rank: link.rank,
      }));
      const common = {
        id: readString(row, "id"), cycleId: readString(row, "cycle_id"), receiptId: readString(row, "receipt_id"),
        checkpointId: readString(row, "checkpoint_id"), ruleRevision: readNumber(row, "rule_revision"),
        idempotencyKey: readString(row, "idempotency_key"), payloadHash: readString(row, "payload_hash"),
        status: readString(row, "status"), selectedInquiryId: readNullableString(row, "selected_inquiry_id"),
        sealedAt: readString(row, "sealed_at"),
      };
      if (contractVersion === "legacy_v24") {
        const v25OnlyFact = this.workspace.db.prepare(`
          SELECT 1 AS contaminated FROM (
            SELECT batch_id FROM growth_inquiry_details WHERE batch_id = ?
            UNION ALL
            SELECT batch_id FROM growth_inquiry_lifecycle WHERE batch_id = ?
            UNION ALL
            SELECT batch_id FROM growth_inquiry_creator_answers WHERE batch_id = ?
            UNION ALL
            SELECT batch_id FROM growth_inquiry_event_sources WHERE batch_id = ?
          ) LIMIT 1
        `).get(batchId, batchId, batchId, batchId);
        if (v25OnlyFact) throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
        const questions = questionRows.map((question) => ({
          id: readString(question, "id"), question: readString(question, "question"), evidenceState: readString(question, "evidence_state"),
          safeSummary: readString(question, "safe_summary"), priority: readNumber(question, "priority"),
          fingerprint: readString(question, "fingerprint"), selected: readNumber(question, "selected") === 1,
          evidenceLinks: evidenceFor(readString(question, "id")),
        }));
        return growthInquiryBatchSchema.parse({
          ...common, contractVersion, creatorChoiceBlocked: readNumber(row, "creator_choice_blocked") === 1, questions,
        });
      }
      if (contractVersion !== "v25") throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
      const creatorChoiceRequiredInquiryId = readNullableString(contract, "creator_choice_required_inquiry_id");
      if ((creatorChoiceRequiredInquiryId !== null) !== (readNumber(row, "creator_choice_blocked") === 1)) {
        throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
      }
      if (creatorChoiceRequiredInquiryId === null
        ? storedSelectedIds.length !== 1 || storedSelectedIds[0] !== common.selectedInquiryId
        : storedSelectedIds.length !== 0 || common.selectedInquiryId !== null) {
        throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
      }
      const questions = questionRows.map((question) => {
        const inquiryId = readString(question, "id");
        const detail = this.workspace.db.prepare(`
          SELECT * FROM growth_inquiry_details WHERE batch_id = ? AND inquiry_id = ?
        `).get(batchId, inquiryId) as Row | undefined;
        const initial = this.workspace.db.prepare(`
          SELECT phase FROM growth_inquiry_lifecycle
          WHERE batch_id = ? AND inquiry_id = ? AND sequence = 1
        `).get(batchId, inquiryId) as Row | undefined;
        if (!detail || !initial) throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
        return {
          id: inquiryId, question: readString(question, "question"), evidenceState: readString(question, "evidence_state"),
          safeSummary: readString(question, "safe_summary"), proposedAction: readString(detail, "proposed_action"),
          provisionalAssumption: readNullableString(detail, "provisional_assumption"),
          requiresCreatorChoice: readNumber(detail, "requires_creator_choice") === 1,
          priority: readNumber(question, "priority"), fingerprint: readString(question, "fingerprint"),
          evidenceLinks: evidenceFor(inquiryId), initialState: readString(initial, "phase"),
        };
      });
      return growthInquiryBatchSchema.parse({
        ...common, contractVersion, creatorChoiceRequiredInquiryId, questions,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "GROWTH_INQUIRY_DATA_CORRUPT") throw error;
      throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
    }
  }

  listUnresolvedInquiryContexts(goalId: string): GrowthPriorInquiryContext[] {
    this.#requiredGoal(goalId);
    const rows = this.workspace.db.prepare(`
      SELECT inquiries.id, inquiries.question, inquiries.evidence_state, inquiries.safe_summary,
        inquiries.priority, cycles.sequence AS cycle_sequence, inquiries.ordinal
      FROM growth_inquiries inquiries
      JOIN growth_inquiry_batches batches ON batches.id = inquiries.batch_id
      JOIN growth_inquiry_batch_contracts contracts ON contracts.batch_id = batches.id
      JOIN growth_cycles cycles ON cycles.id = batches.cycle_id
      WHERE cycles.goal_id = ? AND contracts.contract_version = 'v25'
      ORDER BY cycles.sequence, inquiries.ordinal
    `).all(goalId) as Row[];
    return rows.flatMap((row): GrowthPriorInquiryContext[] => {
      const inquiryId = readString(row, "id");
      const lifecycle = this.listInquiryLifecycle(inquiryId);
      const last = lifecycle.at(-1);
      if (!last || !["backlog", "selected", "creator_answered"].includes(last.phase)) return [];
      return [{
        inquiryId,
        question: readString(row, "question"),
        evidenceState: readString(row, "evidence_state") as GrowthPriorInquiryContext["evidenceState"],
        safeSummary: readString(row, "safe_summary"),
        priority: readNumber(row, "priority"),
        lifecycleSequence: last.sequence,
        lifecyclePhase: last.phase as GrowthPriorInquiryContext["lifecyclePhase"],
      }];
    });
  }

  sealInquiryBatch(input: unknown): GrowthInquiryBatch {
    const value = growthInquiryBatchSealSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.workspace.db.prepare("SELECT id, payload_hash FROM growth_inquiry_batches WHERE idempotency_key = ?")
        .get(value.idempotencyKey) as { id: string; payload_hash: string } | undefined;
      if (replay) {
        if (replay.payload_hash !== payloadHash) throw growthError("GROWTH_INQUIRY_REPLAY_MISMATCH");
        const existing = this.getInquiryBatch(replay.id);
        if (!existing) throw growthError("GROWTH_DATA_INVALID");
        this.workspace.db.exec("COMMIT");
        return existing;
      }
      if (this.workspace.db.prepare("SELECT 1 FROM growth_inquiry_batches WHERE id = ?").get(value.id)) {
        throw growthError("GROWTH_INQUIRY_BATCH_ID_CONFLICT");
      }
      const cycle = this.#requiredCycle(value.cycleId);
      if (!cycle.receiptId) throw growthError("GROWTH_INQUIRY_RECEIPT_REQUIRED");
      if (cycle.status !== "running" || !cycle.runId) throw growthError("GROWTH_INQUIRY_CYCLE_STATE_INVALID");
      const receipt = this.getReceipt(cycle.receiptId);
      if (!receipt || receipt.cycleId !== cycle.id || receipt.checkpointId !== cycle.inputCheckpointId) {
        throw growthError("GROWTH_INQUIRY_RECEIPT_MISMATCH");
      }
      for (const question of value.questions) {
        for (const rank of question.evidenceRanks) {
          if (!this.workspace.db.prepare(`
            SELECT 1 FROM growth_retrieval_receipt_links WHERE receipt_id = ? AND rank = ?
          `).get(receipt.id, rank)) throw growthError("GROWTH_INQUIRY_EVIDENCE_RANK_INVALID");
        }
      }
      this.#assertInquiryNotStalled(cycle, receipt, value);
      this.#assertInquiryNotDuplicate(cycle, receipt, value);
      const sealedAt = new Date().toISOString();
      const creatorChoiceBlocked = value.creatorChoiceRequiredInquiryId !== null;
      this.workspace.db.prepare(`
        INSERT INTO growth_inquiry_batches (
          id, cycle_id, receipt_id, checkpoint_id, rule_revision, idempotency_key, payload_hash, status,
          question_count, creator_choice_blocked, selected_inquiry_id, sealed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'sealed', ?, ?, ?, ?)
      `).run(value.id, cycle.id, receipt.id, cycle.inputCheckpointId, cycle.ruleRevision, value.idempotencyKey,
        payloadHash, value.questions.length, creatorChoiceBlocked ? 1 : 0, value.selectedInquiryId, sealedAt);
      const insertQuestion = this.workspace.db.prepare(`
        INSERT INTO growth_inquiries (
          id, batch_id, question, evidence_state, safe_summary, priority, fingerprint, selected, ordinal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertEvidence = this.workspace.db.prepare(`
        INSERT INTO growth_inquiry_evidence_links (batch_id, inquiry_id, receipt_id, rank, ordinal)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insertDetail = this.workspace.db.prepare(`
        INSERT INTO growth_inquiry_details (
          batch_id, inquiry_id, requires_creator_choice, provisional_assumption, proposed_action
        ) VALUES (?, ?, ?, ?, ?)
      `);
      const insertLifecycle = this.workspace.db.prepare(`
        INSERT INTO growth_inquiry_lifecycle (
          batch_id, inquiry_id, sequence, phase, idempotency_key, payload_hash,
          source_cycle_id, source_receipt_id, source_checkpoint_id, source_rule_revision,
          successor_inquiry_id, answer_rule_revision, close_reason, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
      `);
      value.questions.forEach((question, ordinal) => {
        insertQuestion.run(question.id, value.id, question.question, question.evidenceState, question.safeSummary,
          question.priority, question.fingerprint, question.id === value.selectedInquiryId ? 1 : 0, ordinal);
        insertDetail.run(value.id, question.id, question.requiresCreatorChoice ? 1 : 0,
          question.provisionalAssumption, question.proposedAction);
        question.evidenceRanks.forEach((rank, evidenceOrdinal) => {
          insertEvidence.run(value.id, question.id, receipt.id, rank, evidenceOrdinal);
        });
        const phase = question.id === value.selectedInquiryId
          ? "selected"
          : question.id === value.creatorChoiceRequiredInquiryId
            ? "creator_choice_required"
            : "backlog";
        const lifecycleIdentity = canonicalAuditHash({ batchId: value.id, inquiryId: question.id, phase });
        const lifecyclePayloadHash = canonicalAuditHash({
          batchId: value.id, inquiryId: question.id, phase, sourceCycleId: cycle.id, sourceReceiptId: receipt.id,
          sourceCheckpointId: cycle.inputCheckpointId, sourceRuleRevision: cycle.ruleRevision,
        });
        insertLifecycle.run(value.id, question.id, phase, `growth-inquiry-initial:${lifecycleIdentity}`,
          lifecyclePayloadHash, cycle.id, receipt.id, cycle.inputCheckpointId, cycle.ruleRevision, sealedAt);
      });
      this.workspace.db.prepare(`
        INSERT INTO growth_inquiry_batch_contracts (
          batch_id, contract_version, creator_choice_required_inquiry_id
        ) VALUES (?, 'v25', ?)
      `).run(value.id, value.creatorChoiceRequiredInquiryId);

      for (const transition of value.priorTransitions ?? []) {
        const context = this.#requiredInquiryContext(transition.inquiryId);
        if (context.contractVersion !== "v25" || context.goalId !== cycle.goalId) {
          throw growthError("GROWTH_INQUIRY_LIFECYCLE_SOURCE_INVALID");
        }
        const sourceCycle = this.#requiredCycle(context.cycleId);
        if (sourceCycle.sequence >= cycle.sequence || sourceCycle.id === cycle.id
          || context.receiptId === receipt.id || context.checkpointId === cycle.inputCheckpointId) {
          throw growthError("GROWTH_INQUIRY_NEW_EVIDENCE_REQUIRED");
        }
        const lifecycle = this.listInquiryLifecycle(transition.inquiryId);
        const last = lifecycle.at(-1);
        if (!last || last.sequence !== transition.expectedSequence) {
          throw growthError("GROWTH_INQUIRY_LIFECYCLE_CAS_MISMATCH");
        }
        if (["promoted", "answered", "closed"].includes(last.phase)) {
          throw growthError("GROWTH_INQUIRY_LIFECYCLE_TERMINAL");
        }
        if (last.phase === "creator_choice_required") {
          throw growthError("GROWTH_INQUIRY_CREATOR_ANSWER_REQUIRED");
        }
        const successorInquiryId = transition.phase === "promoted" ? transition.successorInquiryId : null;
        if (successorInquiryId !== null) {
          const successor = this.#requiredInquiryContext(successorInquiryId);
          if (successor.contractVersion !== "v25" || successor.goalId !== cycle.goalId || successor.cycleId !== cycle.id) {
            throw growthError("GROWTH_INQUIRY_SUCCESSOR_INVALID");
          }
        }
        const transitionPayload = {
          ...transition,
          sourceCycleId: cycle.id,
          sourceReceiptId: receipt.id,
          sourceCheckpointId: cycle.inputCheckpointId,
          sourceRuleRevision: cycle.ruleRevision,
        };
        const transitionKey = `growth-inquiry-transition:${canonicalAuditHash({
          batchId: value.id,
          inquiryId: transition.inquiryId,
          phase: transition.phase,
        })}`;
        this.workspace.db.prepare(`
          INSERT INTO growth_inquiry_lifecycle (
            batch_id, inquiry_id, sequence, phase, idempotency_key, payload_hash,
            source_cycle_id, source_receipt_id, source_checkpoint_id, source_rule_revision,
            successor_inquiry_id, answer_rule_revision, close_reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `).run(context.batchId, transition.inquiryId, last.sequence + 1, transition.phase, transitionKey,
          canonicalAuditHash(transitionPayload), cycle.id, receipt.id, cycle.inputCheckpointId, cycle.ruleRevision,
          successorInquiryId, transition.phase === "closed" ? transition.reason : null, sealedAt);
      }

      const frontierInquiryId = value.creatorChoiceRequiredInquiryId ?? value.selectedInquiryId!;
      const frontier = value.questions.find((question) => question.id === frontierInquiryId);
      if (!frontier) throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
      const eventSequenceRow = this.workspace.db.prepare(`
        SELECT MAX(sequence) AS sequence FROM growth_events WHERE goal_id = ?
      `).get(cycle.goalId) as { sequence: number | null };
      const eventSequence = (eventSequenceRow.sequence ?? 0) + 1;
      if (creatorChoiceBlocked) {
        this.workspace.db.prepare(`
          UPDATE growth_cycles
          SET status = 'blocked', failure_code = 'GROWTH_CREATOR_CHOICE_REQUIRED', updated_at = ?, terminal_at = ?
          WHERE id = ? AND status = 'running'
        `).run(sealedAt, sealedAt, cycle.id);
        this.workspace.db.prepare("UPDATE growth_goals SET status = 'blocked', updated_at = ? WHERE id = ?")
          .run(sealedAt, cycle.goalId);
      }
      const event = growthEventSchema.parse({
        goalId: cycle.goalId, cycleId: cycle.id, runId: cycle.runId, sequence: eventSequence,
        safeSummary: frontier.safeSummary,
        phase: creatorChoiceBlocked ? "creator_choice_required" : "inquiry_selected",
        targetKind: "inquiry", targetId: frontierInquiryId, targetVersionId: null,
        durableState: creatorChoiceBlocked ? "blocked" : "running", contentRef: null, createdAt: sealedAt,
      });
      this.workspace.db.prepare(`
        INSERT INTO growth_events (
          goal_id, cycle_id, run_id, sequence, safe_summary, phase, target_kind, target_id, target_version_id,
          durable_state, content_ref_kind, content_ref_id, content_ref_version_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)
      `).run(event.goalId, event.cycleId, event.runId, event.sequence, event.safeSummary, event.phase,
        event.targetKind, event.targetId, event.durableState, event.createdAt);
      this.workspace.db.prepare(`
        INSERT INTO growth_inquiry_event_sources (
          goal_id, event_sequence, batch_id, inquiry_id, lifecycle_sequence
        ) VALUES (?, ?, ?, ?, 1)
      `).run(event.goalId, event.sequence, value.id, frontierInquiryId);
      this.workspace.db.exec("COMMIT");
      return this.getInquiryBatch(value.id) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      if (readErrorCode(error) === "GROWTH_INQUIRY_STALLED") {
        const cycle = this.#requiredCycle(value.cycleId);
        const now = new Date().toISOString();
        this.workspace.db.prepare(`
          UPDATE growth_cycles
          SET status = 'blocked', failure_code = 'GROWTH_INQUIRY_STALLED', updated_at = ?, terminal_at = ?
          WHERE id = ? AND status = 'running'
        `).run(now, now, cycle.id);
        this.workspace.db.prepare("UPDATE growth_goals SET status = 'blocked', updated_at = ? WHERE id = ?")
          .run(now, cycle.goalId);
        this.workspace.db.exec("COMMIT");
      } else {
        this.workspace.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  listInquiryLifecycle(inquiryId: string): GrowthInquiryLifecycle[] {
    const rows = this.workspace.db.prepare(`
      SELECT * FROM growth_inquiry_lifecycle WHERE inquiry_id = ? ORDER BY sequence
    `).all(inquiryId) as Row[];
    if (rows.length === 0 && !this.workspace.db.prepare("SELECT 1 FROM growth_inquiries WHERE id = ?").get(inquiryId)) {
      throw growthError("GROWTH_INQUIRY_NOT_FOUND");
    }
    const lifecycle = rows.map(mapInquiryLifecycle);
    lifecycle.forEach((entry, index) => {
      if (entry.sequence !== index + 1) throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
    });
    return lifecycle;
  }

  appendInquiryLifecycle(input: unknown): GrowthInquiryLifecycle {
    const value = growthInquiryLifecycleAppendSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.workspace.db.prepare(`
        SELECT * FROM growth_inquiry_lifecycle WHERE idempotency_key = ?
      `).get(value.idempotencyKey) as Row | undefined;
      if (replay) {
        if (readString(replay, "payload_hash") !== payloadHash) throw growthError("GROWTH_INQUIRY_LIFECYCLE_REPLAY_MISMATCH");
        const result = mapInquiryLifecycle(replay);
        this.workspace.db.exec("COMMIT");
        return result;
      }
      const context = this.#requiredInquiryContext(value.inquiryId);
      if (context.contractVersion !== "v25") throw growthError("GROWTH_INQUIRY_V25_REQUIRED");
      const lifecycle = this.listInquiryLifecycle(value.inquiryId);
      const last = lifecycle.at(-1);
      if (!last || last.sequence !== value.expectedSequence) throw growthError("GROWTH_INQUIRY_LIFECYCLE_CAS_MISMATCH");
      if (["promoted", "answered", "closed"].includes(last.phase)) throw growthError("GROWTH_INQUIRY_LIFECYCLE_TERMINAL");
      if (last.phase === "creator_choice_required") throw growthError("GROWTH_INQUIRY_CREATOR_ANSWER_REQUIRED");
      const sourceCycle = this.#requiredCycle(value.sourceCycleId);
      if (sourceCycle.goalId !== context.goalId || !sourceCycle.receiptId) throw growthError("GROWTH_INQUIRY_LIFECYCLE_SOURCE_INVALID");
      if (sourceCycle.sequence <= context.cycleSequence) throw growthError("GROWTH_INQUIRY_SOURCE_NOT_LATER");
      const sourceReceipt = this.getReceipt(sourceCycle.receiptId);
      if (!sourceReceipt || sourceReceipt.cycleId !== sourceCycle.id || sourceReceipt.checkpointId !== sourceCycle.inputCheckpointId) {
        throw growthError("GROWTH_INQUIRY_LIFECYCLE_SOURCE_INVALID");
      }
      if (sourceCycle.id === context.cycleId || sourceReceipt.id === context.receiptId
        || sourceCycle.inputCheckpointId === context.checkpointId) {
        throw growthError("GROWTH_INQUIRY_NEW_EVIDENCE_REQUIRED");
      }
      let successorInquiryId: string | null = null;
      if (value.phase === "promoted") {
        const successor = this.#requiredInquiryContext(value.successorInquiryId);
        if (successor.contractVersion !== "v25" || successor.goalId !== context.goalId || successor.cycleId !== sourceCycle.id) {
          throw growthError("GROWTH_INQUIRY_SUCCESSOR_INVALID");
        }
        successorInquiryId = value.successorInquiryId;
      }
      const sequence = last.sequence + 1;
      const createdAt = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_inquiry_lifecycle (
          batch_id, inquiry_id, sequence, phase, idempotency_key, payload_hash,
          source_cycle_id, source_receipt_id, source_checkpoint_id, source_rule_revision,
          successor_inquiry_id, answer_rule_revision, close_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(context.batchId, value.inquiryId, sequence, value.phase, value.idempotencyKey, payloadHash,
        sourceCycle.id, sourceReceipt.id, sourceCycle.inputCheckpointId, sourceCycle.ruleRevision,
        successorInquiryId, value.phase === "closed" ? value.reason : null, createdAt);
      const result = mapInquiryLifecycle(this.workspace.db.prepare(`
        SELECT * FROM growth_inquiry_lifecycle WHERE batch_id = ? AND inquiry_id = ? AND sequence = ?
      `).get(context.batchId, value.inquiryId, sequence) as Row);
      this.workspace.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  getInquiryCreatorAnswer(inquiryId: string): GrowthInquiryCreatorAnswer | null {
    const row = this.workspace.db.prepare(`
      SELECT * FROM growth_inquiry_creator_answers WHERE inquiry_id = ?
    `).get(inquiryId) as Row | undefined;
    return row ? mapInquiryCreatorAnswer(row) : null;
  }

  answerCreatorInquiry(input: unknown): GrowthInquiryCreatorAnswer {
    const value = growthInquiryCreatorAnswerCreateSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.workspace.db.prepare(`
        SELECT * FROM growth_inquiry_creator_answers WHERE idempotency_key = ?
      `).get(value.idempotencyKey) as Row | undefined;
      if (replay) {
        if (readString(replay, "payload_hash") !== payloadHash) throw growthError("GROWTH_INQUIRY_ANSWER_REPLAY_MISMATCH");
        const answer = mapInquiryCreatorAnswer(replay);
        this.workspace.db.exec("COMMIT");
        return answer;
      }
      const context = this.#requiredInquiryContext(value.inquiryId);
      if (context.contractVersion !== "v25" || context.creatorChoiceRequiredInquiryId !== value.inquiryId
        || !context.requiresCreatorChoice) throw growthError("GROWTH_INQUIRY_CREATOR_CHOICE_REQUIRED");
      if (this.getInquiryCreatorAnswer(value.inquiryId)) throw growthError("GROWTH_INQUIRY_ALREADY_ANSWERED");
      const cycle = this.#requiredCycle(context.cycleId);
      const goal = this.#requiredGoal(context.goalId);
      if (cycle.status !== "blocked" || cycle.failureCode !== "GROWTH_CREATOR_CHOICE_REQUIRED" || goal.status !== "blocked") {
        throw growthError("GROWTH_INQUIRY_CREATOR_CHOICE_STATE_INVALID");
      }
      const lifecycle = this.listInquiryLifecycle(value.inquiryId);
      const last = lifecycle.at(-1);
      if (!last || last.sequence !== value.expectedLifecycleSequence || last.phase !== "creator_choice_required") {
        throw growthError("GROWTH_INQUIRY_LIFECYCLE_CAS_MISMATCH");
      }
      if (goal.currentRuleRevision !== value.expectedRuleRevision) throw growthError("GROWTH_RULE_REVISION_MISMATCH");
      const ruleRevision = value.expectedRuleRevision + 1;
      const createdAt = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_goal_rule_revisions (goal_id, revision, rule_text, source_message_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(goal.id, ruleRevision, value.answerText, value.sourceMessageId, createdAt);
      this.workspace.db.prepare(`
        UPDATE growth_goals SET current_rule_revision = ?, status = 'active', updated_at = ?
        WHERE id = ? AND current_rule_revision = ? AND status = 'blocked'
      `).run(ruleRevision, createdAt, goal.id, value.expectedRuleRevision);
      this.workspace.db.prepare(`
        INSERT INTO growth_inquiry_creator_answers (
          inquiry_id, batch_id, goal_id, rule_revision, idempotency_key, payload_hash,
          answer_text, source_message_id, checkpoint_id, receipt_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(value.inquiryId, context.batchId, goal.id, ruleRevision, value.idempotencyKey, payloadHash,
        value.answerText, value.sourceMessageId, context.checkpointId, context.receiptId, createdAt);
      this.workspace.db.prepare(`
        INSERT INTO growth_inquiry_lifecycle (
          batch_id, inquiry_id, sequence, phase, idempotency_key, payload_hash,
          source_cycle_id, source_receipt_id, source_checkpoint_id, source_rule_revision,
          successor_inquiry_id, answer_rule_revision, close_reason, created_at
        ) VALUES (?, ?, ?, 'creator_answered', ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)
      `).run(context.batchId, value.inquiryId, last.sequence + 1, value.idempotencyKey, payloadHash,
        context.cycleId, context.receiptId, context.checkpointId, context.ruleRevision, ruleRevision, createdAt);
      const answer = this.getInquiryCreatorAnswer(value.inquiryId) ?? fail("GROWTH_INQUIRY_DATA_CORRUPT");
      this.workspace.db.exec("COMMIT");
      return answer;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  getClosureProfile(profileId: string): GrowthClosureProfile | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_closure_profiles WHERE id = ?").get(profileId) as Row | undefined;
    if (!row) return null;
    const generation = readString(row, "contract_generation");
    const components = generation === "v26" ? this.#closureComponents(profileId, readNumber(row, "current_revision")) : null;
    return mapClosureProfile(row, components);
  }

  getClosureRevision(profileId: string, revision: number): GrowthClosureRevision | null {
    const row = this.workspace.db.prepare(`
      SELECT * FROM growth_closure_profile_revisions WHERE profile_id = ? AND revision = ?
    `).get(profileId, revision) as Row | undefined;
    if (!row) return null;
    const facets = (this.workspace.db.prepare(`
      SELECT facet_id, facet_kind, required FROM growth_closure_facets
      WHERE profile_id = ? AND revision = ? ORDER BY ordinal
    `).all(profileId, revision) as Array<{ facet_id: string; facet_kind: string; required: number }>).map((facet) => ({
      id: facet.facet_id, kind: facet.facet_kind, required: facet.required === 1,
    }));
    const generation = readString(row, "contract_generation");
    return growthClosureRevisionSchema.parse({
      profileId, revision: readNumber(row, "revision"), epoch: readNumber(row, "epoch"),
      checkpointId: readString(row, "checkpoint_id"), ruleRevision: readNumber(row, "rule_revision"),
      contractGeneration: generation,
      componentProfiles: generation === "v26" ? this.#closureComponents(profileId, revision) : null,
      focusOcResourceId: generation === "v26" ? readNullableString(row, "focus_oc_resource_id") : null,
      facets, createdAt: readString(row, "created_at"),
    });
  }

  createClosureProfile(input: unknown): GrowthClosureProfile {
    const value = growthClosureProfileCreateSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.workspace.db.prepare("SELECT id, payload_hash FROM growth_closure_profiles WHERE idempotency_key = ?")
        .get(value.idempotencyKey) as { id: string; payload_hash: string } | undefined;
      if (replay) {
        if (replay.payload_hash !== payloadHash) throw growthError("GROWTH_CLOSURE_PROFILE_REPLAY_MISMATCH");
        const profile = this.getClosureProfile(replay.id);
        if (!profile) throw growthError("GROWTH_DATA_INVALID");
        this.workspace.db.exec("COMMIT");
        return profile;
      }
      if (this.workspace.db.prepare("SELECT 1 FROM growth_closure_profiles WHERE id = ?").get(value.id)) {
        throw growthError("GROWTH_CLOSURE_PROFILE_ID_CONFLICT");
      }
      this.#assertClosureRevisionAuthority(value.goalId, value.checkpointId, value.ruleRevision);
      if (value.profileKind === "oc_saga") this.#assertOcSubject(value.subjectResourceId!, value.checkpointId);
      if (value.focusOcResourceId) this.#assertOcSubject(value.focusOcResourceId, value.checkpointId);
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_closure_profiles (
          id, idempotency_key, payload_hash, goal_id, profile_kind, subject_resource_id,
          current_revision, current_epoch, created_at, updated_at, contract_generation, focus_oc_resource_id
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 'v26', ?)
      `).run(value.id, value.idempotencyKey, payloadHash, value.goalId, value.profileKind, value.subjectResourceId, now, now, value.focusOcResourceId);
      this.workspace.db.prepare(`
        INSERT INTO growth_closure_profile_revisions (
          profile_id, revision, epoch, checkpoint_id, rule_revision, idempotency_key, payload_hash, created_at,
          contract_generation, focus_oc_resource_id
        ) VALUES (?, 1, 1, ?, ?, ?, ?, ?, 'v26', ?)
      `).run(value.id, value.checkpointId, value.ruleRevision,
        canonicalAuditHash({ profileId: value.id, revision: 1, idempotencyKey: value.idempotencyKey }),
        canonicalAuditHash({ checkpointId: value.checkpointId, ruleRevision: value.ruleRevision, facets: value.facets,
          componentProfiles: value.componentProfiles, focusOcResourceId: value.focusOcResourceId }), now, value.focusOcResourceId);
      this.#insertClosureFacets(value.id, 1, value.facets);
      this.#insertClosureComponents(value.id, 1, value.componentProfiles);
      this.workspace.db.exec("COMMIT");
      return this.getClosureProfile(value.id) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendClosureRevision(input: unknown): GrowthClosureRevision {
    const value = growthClosureRevisionAppendSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.workspace.db.prepare(`
        SELECT profile_id, revision, payload_hash FROM growth_closure_profile_revisions WHERE idempotency_key = ?
      `).get(value.idempotencyKey) as { profile_id: string; revision: number; payload_hash: string } | undefined;
      if (replay) {
        if (replay.payload_hash !== payloadHash) throw growthError("GROWTH_CLOSURE_REVISION_REPLAY_MISMATCH");
        const revision = this.getClosureRevision(replay.profile_id, replay.revision);
        if (!revision) throw growthError("GROWTH_DATA_INVALID");
        this.workspace.db.exec("COMMIT");
        return revision;
      }
      const profile = this.getClosureProfile(value.profileId);
      if (!profile) throw growthError("GROWTH_CLOSURE_PROFILE_NOT_FOUND");
      if (profile.currentRevision !== value.expectedRevision) throw growthError("GROWTH_CLOSURE_REVISION_MISMATCH");
      this.#assertClosureRevisionShape(profile.profileKind, value.componentProfiles, value.focusOcResourceId);
      this.#assertClosureRevisionAuthority(profile.goalId, value.checkpointId, value.ruleRevision);
      if (profile.profileKind === "oc_saga") this.#assertOcSubject(profile.subjectResourceId!, value.checkpointId);
      if (value.focusOcResourceId) this.#assertOcSubject(value.focusOcResourceId, value.checkpointId);
      const revision = profile.currentRevision + 1;
      const epoch = profile.currentEpoch + 1;
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_closure_profile_revisions (
          profile_id, revision, epoch, checkpoint_id, rule_revision, idempotency_key, payload_hash, created_at,
          contract_generation, focus_oc_resource_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'v26', ?)
      `).run(profile.id, revision, epoch, value.checkpointId, value.ruleRevision, value.idempotencyKey, payloadHash, now, value.focusOcResourceId);
      this.#insertClosureFacets(profile.id, revision, value.facets);
      this.#insertClosureComponents(profile.id, revision, value.componentProfiles);
      this.workspace.db.prepare(`
        UPDATE growth_closure_profiles
        SET current_revision = ?, current_epoch = ?, updated_at = ?, contract_generation = 'v26', focus_oc_resource_id = ?
        WHERE id = ?
      `).run(revision, epoch, now, value.focusOcResourceId, profile.id);
      const output = this.getClosureRevision(profile.id, revision) ?? fail("GROWTH_DATA_INVALID");
      this.workspace.db.exec("COMMIT");
      return output;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  getClosureAssessment(assessmentId: string): GrowthClosureAssessment | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_closure_assessments WHERE id = ?").get(assessmentId) as Row | undefined;
    return row ? mapClosureAssessment(row) : null;
  }

  appendClosureAssessment(input: unknown): GrowthClosureAssessment {
    growthClosureAssessmentAppendSchema.parse(input);
    throw growthError("GROWTH_CLOSURE_LEGACY_WRITE_FORBIDDEN");
  }

  appendClosureStewardSubmission(
    input: unknown,
  ): GrowthClosureAssessment & { facetResults: GrowthClosureFacetResult[] } {
    const value = growthClosureStewardSubmissionSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const assessment = this.#appendClosureAssessmentRow(value, payloadHash, "v26");
      const existing = this.workspace.db.prepare(`
        SELECT COUNT(*) AS count FROM growth_closure_facet_results WHERE assessment_id = ?
      `).get(assessment.id) as { count: number };
      if (existing.count === 0) {
        const revision = this.getClosureRevision(value.profileId, value.revision) ?? fail("GROWTH_CLOSURE_REVISION_NOT_FOUND");
        const facetIds = new Set(revision.facets.map((facet) => facet.id));
        if (value.facetResults.some((result) => !facetIds.has(result.facetId)
          || result.evidence.some((link) => link.receiptId !== value.receiptId))) {
          throw growthError("GROWTH_CLOSURE_FACET_RESULT_REFERENCE_MISMATCH");
        }
        const insertResult = this.workspace.db.prepare(`
          INSERT INTO growth_closure_facet_results (
            assessment_id, profile_id, revision, facet_id, state, coverage, safe_summary, ordinal
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertEvidence = this.workspace.db.prepare(`
          INSERT INTO growth_closure_facet_result_evidence (
            assessment_id, facet_id, receipt_id, rank, ordinal
          ) VALUES (?, ?, ?, ?, ?)
        `);
        value.facetResults.forEach((result, ordinal) => {
          insertResult.run(assessment.id, value.profileId, value.revision, result.facetId,
            result.state, result.coverage, result.safeSummary, ordinal);
          result.evidence.forEach((link, evidenceOrdinal) => insertEvidence.run(
            assessment.id, result.facetId, link.receiptId, link.rank, evidenceOrdinal,
          ));
        });
      }
      const output = this.getClosureStewardSubmission(assessment.id) ?? fail("GROWTH_DATA_INVALID");
      if (canonicalAuditHash({ ...assessmentInputFromOutput(output), facetResults: output.facetResults }) !== payloadHash) {
        throw growthError("GROWTH_CLOSURE_ASSESSMENT_REPLAY_MISMATCH");
      }
      this.workspace.db.exec("COMMIT");
      return output;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  getClosureStewardSubmission(
    assessmentId: string,
  ): (GrowthClosureAssessment & { facetResults: GrowthClosureFacetResult[] }) | null {
    const assessment = this.getClosureAssessment(assessmentId);
    if (!assessment || assessment.role !== "steward") return null;
    const facetResults = (this.workspace.db.prepare(`
      SELECT * FROM growth_closure_facet_results WHERE assessment_id = ? ORDER BY ordinal
    `).all(assessmentId) as Row[]).map((row) => ({
      facetId: readString(row, "facet_id"), state: readString(row, "state"), coverage: readString(row, "coverage"),
      safeSummary: readString(row, "safe_summary"),
      evidence: (this.workspace.db.prepare(`
        SELECT receipt_id, rank FROM growth_closure_facet_result_evidence
        WHERE assessment_id = ? AND facet_id = ? ORDER BY ordinal
      `).all(assessmentId, readString(row, "facet_id")) as Array<{ receipt_id: string; rank: number }>)
        .map((link) => ({ receiptId: link.receipt_id, rank: link.rank })),
    })) as GrowthClosureFacetResult[];
    return { ...assessment, facetResults };
  }

  appendClosureCheckerSubmission(
    input: unknown,
  ): GrowthClosureAssessment & { adverseFindings: GrowthClosureAdverseFinding[] } {
    const value = growthClosureCheckerSubmissionSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const assessment = this.#appendClosureAssessmentRow(value, payloadHash, "v26");
      const existing = this.workspace.db.prepare(`
        SELECT COUNT(*) AS count FROM growth_closure_adverse_findings WHERE assessment_id = ?
      `).get(assessment.id) as { count: number };
      if (existing.count === 0 && value.adverseFindings.length > 0) {
        if (value.adverseFindings.some((finding) => finding.targetEvidence.some((link) => link.receiptId !== value.receiptId))) {
          throw growthError("GROWTH_CLOSURE_FINDING_REFERENCE_MISMATCH");
        }
        const insertFinding = this.workspace.db.prepare(`
          INSERT INTO growth_closure_adverse_findings (
            id, assessment_id, fingerprint, severity, category, safe_summary, repair_objective, ordinal
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertEvidence = this.workspace.db.prepare(`
          INSERT INTO growth_closure_adverse_finding_evidence (finding_id, receipt_id, rank, ordinal)
          VALUES (?, ?, ?, ?)
        `);
        value.adverseFindings.forEach((finding, ordinal) => {
          insertFinding.run(finding.id, assessment.id, finding.fingerprint, finding.severity, finding.category,
            finding.safeSummary, finding.repairObjective, ordinal);
          finding.targetEvidence.forEach((link, evidenceOrdinal) => insertEvidence.run(
            finding.id, link.receiptId, link.rank, evidenceOrdinal,
          ));
        });
      }
      const output = this.getClosureCheckerSubmission(assessment.id) ?? fail("GROWTH_DATA_INVALID");
      if (canonicalAuditHash({ ...assessmentInputFromOutput(output), adverseFindings: output.adverseFindings }) !== payloadHash) {
        throw growthError("GROWTH_CLOSURE_ASSESSMENT_REPLAY_MISMATCH");
      }
      this.workspace.db.exec("COMMIT");
      return output;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  getClosureCheckerSubmission(
    assessmentId: string,
  ): (GrowthClosureAssessment & { adverseFindings: GrowthClosureAdverseFinding[] }) | null {
    const assessment = this.getClosureAssessment(assessmentId);
    if (!assessment || assessment.role !== "checker") return null;
    const adverseFindings = (this.workspace.db.prepare(`
      SELECT * FROM growth_closure_adverse_findings WHERE assessment_id = ? ORDER BY ordinal
    `).all(assessmentId) as Row[]).map((row) => ({
      id: readString(row, "id"), fingerprint: readString(row, "fingerprint"),
      severity: readString(row, "severity"), category: readString(row, "category"),
      safeSummary: readString(row, "safe_summary"), repairObjective: readString(row, "repair_objective"),
      targetEvidence: (this.workspace.db.prepare(`
        SELECT receipt_id, rank FROM growth_closure_adverse_finding_evidence
        WHERE finding_id = ? ORDER BY ordinal
      `).all(readString(row, "id")) as Array<{ receipt_id: string; rank: number }>)
        .map((link) => ({ receiptId: link.receipt_id, rank: link.rank })),
    })) as GrowthClosureAdverseFinding[];
    return { ...assessment, adverseFindings };
  }

  sealClosureReviewV4(input: unknown): ReturnType<typeof growthClosureReviewV4SealSchema.parse> & {
    checkerDecision: "accepted" | "repairs_required" | "blocked"; payloadHash: string; createdAt: string;
  } {
    const value = growthClosureReviewV4SealSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.workspace.db.prepare(`
        SELECT * FROM growth_closure_reviews WHERE idempotency_key = ?
      `).get(value.idempotencyKey) as Row | undefined;
      if (replay) {
        if (readString(replay, "payload_hash") !== payloadHash || readString(replay, "contract_generation") !== "v26") {
          throw growthError("GROWTH_CLOSURE_REVIEW_REPLAY_MISMATCH");
        }
        const output = this.getClosureReviewV4(readString(replay, "id")) ?? fail("GROWTH_DATA_INVALID");
        this.workspace.db.exec("COMMIT");
        return output;
      }
      const revision = this.getClosureRevision(value.profileId, value.revision);
      const steward = this.getClosureStewardSubmission(value.stewardAssessmentId);
      const checker = this.getClosureCheckerSubmission(value.checkerAssessmentId);
      if (!revision || revision.contractGeneration !== "v26" || !steward || !checker
        || steward.profileId !== value.profileId || checker.profileId !== value.profileId
        || steward.revision !== value.revision || checker.revision !== value.revision
        || steward.decision !== "ready_for_checker" || steward.agentInvocationId === checker.agentInvocationId
        || steward.cycleId !== checker.cycleId || steward.checkpointId !== checker.checkpointId
        || steward.ruleRevision !== checker.ruleRevision || steward.receiptId !== checker.receiptId
        || canonicalAuditHash(steward.facetResults) !== canonicalAuditHash(value.facetResults)
        || canonicalAuditHash(checker.adverseFindings) !== canonicalAuditHash(value.adverseFindings)) {
        throw growthError("GROWTH_CLOSURE_REVIEW_ASSESSMENT_MISMATCH");
      }
      const required = revision.facets.filter((facet) => facet.required);
      const resultByFacet = new Map(value.facetResults.map((result) => [result.facetId, result]));
      if (checker.decision === "accepted" && (value.adverseFindings.length > 0
        || required.some((facet) => resultByFacet.get(facet.id)?.state !== "satisfied"))) {
        throw growthError("GROWTH_CLOSURE_ACCEPTANCE_INCOMPLETE");
      }
      if (checker.decision === "repairs_required"
        && !value.adverseFindings.some((finding) => ["major", "blocking"].includes(finding.severity))) {
        throw growthError("GROWTH_CLOSURE_REPAIR_FINDING_REQUIRED");
      }
      if (checker.decision === "blocked" && !value.adverseFindings.some((finding) => finding.severity === "blocking")) {
        throw growthError("GROWTH_CLOSURE_BLOCK_FINDING_REQUIRED");
      }
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_closure_reviews (
          id, profile_id, revision, steward_assessment_id, checker_assessment_id, checker_decision,
          idempotency_key, payload_hash, created_at, contract_generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'v26')
      `).run(value.id, value.profileId, value.revision, value.stewardAssessmentId, value.checkerAssessmentId,
        checker.decision, value.idempotencyKey, payloadHash, now);
      this.workspace.db.exec("COMMIT");
      return this.getClosureReviewV4(value.id) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  getClosureReviewV4(reviewId: string): (ReturnType<typeof growthClosureReviewV4SealSchema.parse> & {
    checkerDecision: "accepted" | "repairs_required" | "blocked"; payloadHash: string; createdAt: string;
  }) | null {
    const row = this.workspace.db.prepare(`
      SELECT * FROM growth_closure_reviews WHERE id = ? AND contract_generation = 'v26'
    `).get(reviewId) as Row | undefined;
    if (!row) return null;
    const steward = this.getClosureStewardSubmission(readString(row, "steward_assessment_id")) ?? fail("GROWTH_DATA_INVALID");
    const checker = this.getClosureCheckerSubmission(readString(row, "checker_assessment_id")) ?? fail("GROWTH_DATA_INVALID");
    return {
      id: readString(row, "id"), profileId: readString(row, "profile_id"), revision: readNumber(row, "revision"),
      stewardAssessmentId: steward.id, checkerAssessmentId: checker.id, idempotencyKey: readString(row, "idempotency_key"),
      facetResults: steward.facetResults, adverseFindings: checker.adverseFindings,
      checkerDecision: readString(row, "checker_decision") as "accepted" | "repairs_required" | "blocked",
      payloadHash: readString(row, "payload_hash"), createdAt: readString(row, "created_at"),
    };
  }

  getClosureEvaluationOutcome(outcomeId: string): GrowthClosureEvaluationOutcome | null {
    const row = this.workspace.db.prepare(`
      SELECT * FROM growth_closure_evaluation_outcomes WHERE id = ?
    `).get(outcomeId) as Row | undefined;
    return row ? growthClosureEvaluationOutcomeSchema.parse({
      id: readString(row, "id"), cycleId: readString(row, "cycle_id"), profileId: readString(row, "profile_id"),
      revision: readNumber(row, "revision"), receiptId: readString(row, "receipt_id"),
      stewardAssessmentId: readString(row, "steward_assessment_id"),
      checkerAssessmentId: readNullableString(row, "checker_assessment_id"), reviewId: readNullableString(row, "review_id"),
      decision: readString(row, "decision"), idempotencyKey: readString(row, "idempotency_key"),
      payloadHash: readString(row, "payload_hash"), createdAt: readString(row, "created_at"),
    }) : null;
  }

  sealClosureEvaluationOutcome(input: unknown): GrowthClosureEvaluationOutcome {
    const value = growthClosureEvaluationOutcomeSealSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.workspace.db.prepare(`
        SELECT id, payload_hash FROM growth_closure_evaluation_outcomes WHERE idempotency_key = ?
      `).get(value.idempotencyKey) as Row | undefined;
      if (replay) {
        if (readString(replay, "payload_hash") !== payloadHash) throw growthError("GROWTH_CLOSURE_OUTCOME_REPLAY_MISMATCH");
        const outcome = this.getClosureEvaluationOutcome(readString(replay, "id")) ?? fail("GROWTH_DATA_INVALID");
        this.#ensureClosureEvaluationEvent(outcome);
        this.workspace.db.exec("COMMIT");
        return outcome;
      }
      if (this.workspace.db.prepare("SELECT 1 FROM growth_closure_evaluation_outcomes WHERE id = ?").get(value.id)) {
        throw growthError("GROWTH_CLOSURE_OUTCOME_ID_CONFLICT");
      }
      const cycle = this.#requiredCycle(value.cycleId);
      const intent = this.getCycleIntent(cycle.id);
      const steward = this.getClosureStewardSubmission(value.stewardAssessmentId);
      if (cycle.status !== "running" || !cycle.runId || cycle.receiptId !== value.receiptId
        || intent.kind !== "closure_evaluation" || intent.profileId !== value.profileId || intent.revision !== value.revision
        || intent.checkpointId !== cycle.inputCheckpointId || !steward || steward.cycleId !== cycle.id
        || steward.receiptId !== value.receiptId || steward.profileId !== value.profileId || steward.revision !== value.revision) {
        throw growthError("GROWTH_CLOSURE_OUTCOME_REFERENCE_MISMATCH");
      }
      if (value.decision === "continue_growing") {
        if (steward.decision !== "continue_growing") throw growthError("GROWTH_CLOSURE_OUTCOME_DECISION_MISMATCH");
      } else {
        const checker = this.getClosureCheckerSubmission(value.checkerAssessmentId);
        const review = this.getClosureReviewV4(value.reviewId);
        if (steward.decision !== "ready_for_checker" || !checker || !review
          || checker.cycleId !== cycle.id || checker.receiptId !== value.receiptId
          || checker.profileId !== value.profileId || checker.revision !== value.revision
          || review.checkerAssessmentId !== checker.id || review.stewardAssessmentId !== steward.id
          || checker.decision !== value.decision || review.checkerDecision !== value.decision) {
          throw growthError("GROWTH_CLOSURE_OUTCOME_DECISION_MISMATCH");
        }
      }
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_closure_evaluation_outcomes (
          id, cycle_id, profile_id, revision, receipt_id, steward_assessment_id,
          checker_assessment_id, review_id, decision, idempotency_key, payload_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(value.id, value.cycleId, value.profileId, value.revision, value.receiptId, value.stewardAssessmentId,
        value.checkerAssessmentId, value.reviewId, value.decision, value.idempotencyKey, payloadHash, now);
      this.workspace.db.prepare(`
        UPDATE growth_cycles
        SET status = 'evaluated', failure_code = NULL, change_set_id = NULL, output_checkpoint_id = NULL,
          updated_at = ?, terminal_at = ?
        WHERE id = ? AND status = 'running'
      `).run(now, now, cycle.id);
      const outcome = this.getClosureEvaluationOutcome(value.id) ?? fail("GROWTH_DATA_INVALID");
      this.#ensureClosureEvaluationEvent(outcome);
      this.workspace.db.exec("COMMIT");
      return outcome;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  repairClosureEvaluationEvent(cycleId: string): GrowthEvent {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.workspace.db.prepare(`
        SELECT id FROM growth_closure_evaluation_outcomes WHERE cycle_id = ?
      `).get(cycleId) as Row | undefined;
      if (!row) throw growthError("GROWTH_CLOSURE_OUTCOME_NOT_FOUND");
      const outcome = this.getClosureEvaluationOutcome(readString(row, "id")) ?? fail("GROWTH_DATA_INVALID");
      const event = this.#ensureClosureEvaluationEvent(outcome);
      this.workspace.db.exec("COMMIT");
      return event;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  createClosureRepairLineage(input: unknown): GrowthClosureRepairLineage {
    const value = growthClosureRepairLineageCreateSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.workspace.db.prepare(`
        SELECT id, payload_hash FROM growth_closure_repair_lineage WHERE idempotency_key = ?
      `).get(value.idempotencyKey) as Row | undefined;
      if (replay) {
        if (readString(replay, "payload_hash") !== payloadHash) throw growthError("GROWTH_CLOSURE_REPAIR_REPLAY_MISMATCH");
        const lineage = this.getClosureRepairLineage(readString(replay, "id")) ?? fail("GROWTH_DATA_INVALID");
        this.workspace.db.exec("COMMIT");
        return lineage;
      }
      const cycle = this.#requiredCycle(value.repairCycleId);
      const intent = this.getCycleIntent(cycle.id);
      const review = this.getClosureReviewV4(value.originalReviewId);
      if (cycle.status !== "planned" || intent.kind !== "repair" || !review || review.checkerDecision !== "repairs_required"
        || intent.profileId !== value.profileId || intent.revision !== value.revision
        || intent.originalReviewId !== value.originalReviewId || intent.selectedFindingId !== value.selectedFindingId
        || intent.selectedFindingFingerprint !== value.selectedFindingFingerprint) {
        throw growthError("GROWTH_CLOSURE_REPAIR_LINEAGE_INVALID");
      }
      const selected = review.adverseFindings.find((finding) => finding.id === value.selectedFindingId);
      const expectedBacklog = review.adverseFindings.filter((finding) => finding.id !== value.selectedFindingId).map((finding) => finding.id);
      if (!selected || !["major", "blocking"].includes(selected.severity)
        || selected.fingerprint !== value.selectedFindingFingerprint
        || !sameStrings(value.backlogFindingIds, expectedBacklog)) {
        throw growthError("GROWTH_CLOSURE_REPAIR_FINDING_INVALID");
      }
      const prior = this.getClosureRepairStallState(value.profileId, value.revision, value.selectedFindingFingerprint);
      const now = new Date().toISOString();
      const resolutionState = prior.sameFingerprintAttempts >= 1 || prior.noProgressAttempts >= 2 ? "stalled" : "planned";
      this.workspace.db.prepare(`
        INSERT INTO growth_closure_repair_lineage (
          id, profile_id, revision, original_review_id, selected_finding_id, selected_finding_fingerprint,
          repair_cycle_id, resolution_state, idempotency_key, payload_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(value.id, value.profileId, value.revision, value.originalReviewId, value.selectedFindingId,
        value.selectedFindingFingerprint, value.repairCycleId, resolutionState, value.idempotencyKey, payloadHash, now, now);
      const insertBacklog = this.workspace.db.prepare(`
        INSERT INTO growth_closure_repair_backlog (lineage_id, finding_id, ordinal) VALUES (?, ?, ?)
      `);
      value.backlogFindingIds.forEach((findingId, ordinal) => insertBacklog.run(value.id, findingId, ordinal));
      this.workspace.db.exec("COMMIT");
      return this.getClosureRepairLineage(value.id) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  getClosureRepairLineage(lineageId: string): GrowthClosureRepairLineage | null {
    const row = this.workspace.db.prepare(`
      SELECT * FROM growth_closure_repair_lineage WHERE id = ?
    `).get(lineageId) as Row | undefined;
    if (!row) return null;
    const backlogFindingIds = (this.workspace.db.prepare(`
      SELECT finding_id FROM growth_closure_repair_backlog WHERE lineage_id = ? ORDER BY ordinal
    `).all(lineageId) as Array<{ finding_id: string }>).map((entry) => entry.finding_id);
    return growthClosureRepairLineageSchema.parse({
      id: readString(row, "id"), profileId: readString(row, "profile_id"), revision: readNumber(row, "revision"),
      originalReviewId: readString(row, "original_review_id"), selectedFindingId: readString(row, "selected_finding_id"),
      selectedFindingFingerprint: readString(row, "selected_finding_fingerprint"),
      repairCycleId: readString(row, "repair_cycle_id"), backlogFindingIds,
      idempotencyKey: readString(row, "idempotency_key"), resolutionState: readString(row, "resolution_state"),
      payloadHash: readString(row, "payload_hash"), createdAt: readString(row, "created_at"), updatedAt: readString(row, "updated_at"),
    });
  }

  markClosureRepairResolution(
    lineageId: string,
    resolutionState: "committed" | "resolved" | "no_progress",
  ): GrowthClosureRepairLineage {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const lineage = this.getClosureRepairLineage(lineageId);
      if (!lineage) throw growthError("GROWTH_CLOSURE_REPAIR_NOT_FOUND");
      const cycle = this.#requiredCycle(lineage.repairCycleId);
      const cycleCommitted = cycle.status === "committed" && cycle.changeSetId !== null && cycle.outputCheckpointId !== null;
      if (lineage.resolutionState === resolutionState
        || (lineage.resolutionState === "stalled" && resolutionState === "no_progress" && cycleCommitted)) {
        this.workspace.db.exec("COMMIT");
        return lineage;
      }
      if (lineage.resolutionState === "stalled" || lineage.resolutionState === "resolved"
        || lineage.resolutionState === "no_progress"
        || (lineage.resolutionState === "committed" && resolutionState !== "resolved")) {
        throw growthError("GROWTH_CLOSURE_REPAIR_TRANSITION_INVALID");
      }
      if (!cycleCommitted) {
        throw growthError("GROWTH_CLOSURE_REPAIR_CYCLE_NOT_COMMITTED");
      }
      if (resolutionState === "resolved") {
        if (lineage.resolutionState !== "committed") {
          throw growthError("GROWTH_CLOSURE_REPAIR_TRANSITION_INVALID");
        }
        const accepted = this.workspace.db.prepare(`
          SELECT outcomes.id
          FROM growth_closure_evaluation_outcomes outcomes
          JOIN growth_cycles evaluation_cycles ON evaluation_cycles.id = outcomes.cycle_id
          JOIN growth_cycles repair_cycles ON repair_cycles.id = ?
          JOIN growth_closure_profile_revisions revisions
            ON revisions.profile_id = outcomes.profile_id AND revisions.revision = outcomes.revision
          WHERE outcomes.profile_id = ? AND outcomes.revision > ? AND outcomes.decision = 'accepted'
            AND evaluation_cycles.status = 'evaluated'
            AND evaluation_cycles.goal_id = repair_cycles.goal_id
            AND evaluation_cycles.sequence > repair_cycles.sequence
            AND evaluation_cycles.input_checkpoint_id = repair_cycles.output_checkpoint_id
            AND revisions.checkpoint_id = repair_cycles.output_checkpoint_id
          ORDER BY evaluation_cycles.sequence, outcomes.created_at, outcomes.id
          LIMIT 1
        `).get(cycle.id, lineage.profileId, lineage.revision) as Row | undefined;
        if (!accepted) throw growthError("GROWTH_CLOSURE_REPAIR_RESOLUTION_UNPROVEN");
      }
      const now = new Date().toISOString();
      const updated = this.workspace.db.prepare(`
        UPDATE growth_closure_repair_lineage SET resolution_state = ?, updated_at = ?
        WHERE id = ? AND resolution_state = ?
      `).run(resolutionState, now, lineageId, lineage.resolutionState);
      if (updated.changes !== 1) throw growthError("GROWTH_CLOSURE_REPAIR_TRANSITION_INVALID");
      if (resolutionState === "no_progress") {
        const state = this.getClosureRepairStallState(lineage.profileId, lineage.revision, lineage.selectedFindingFingerprint);
        if (state.noProgressAttempts >= 2) {
          this.workspace.db.prepare(`
            UPDATE growth_closure_repair_lineage SET resolution_state = 'stalled', updated_at = ? WHERE id = ?
          `).run(now, lineageId);
        }
      }
      this.workspace.db.exec("COMMIT");
      return this.getClosureRepairLineage(lineageId) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  getClosureRepairStallState(profileId: string, revision: number, fingerprint: string): {
    stalled: boolean; sameFingerprintAttempts: number; noProgressAttempts: number;
  } {
    const same = this.workspace.db.prepare(`
      SELECT COUNT(*) AS count FROM growth_closure_repair_lineage
      WHERE profile_id = ? AND revision = ? AND selected_finding_fingerprint = ?
    `).get(profileId, revision, fingerprint) as { count: number };
    const noProgress = this.workspace.db.prepare(`
      SELECT COUNT(*) AS count FROM growth_closure_repair_lineage
      WHERE profile_id = ? AND revision = ? AND resolution_state IN ('no_progress', 'stalled')
    `).get(profileId, revision) as { count: number };
    return {
      stalled: same.count >= 2 || noProgress.count >= 2,
      sameFingerprintAttempts: same.count,
      noProgressAttempts: noProgress.count,
    };
  }

  getClosureReview(reviewId: string): GrowthClosureReview | null {
    const row = this.workspace.db.prepare(`
      SELECT * FROM growth_closure_reviews WHERE id = ? AND contract_generation = 'legacy_pre_v26'
    `).get(reviewId) as Row | undefined;
    if (!row) return null;
    const findings = (this.workspace.db.prepare(`
      SELECT * FROM growth_closure_review_findings WHERE review_id = ? ORDER BY ordinal
    `).all(reviewId) as Row[]).map((finding) => ({
      facetId: readString(finding, "facet_id"), state: readString(finding, "state"),
      safeSummary: readString(finding, "safe_summary"),
      evidence: { receiptId: readString(finding, "receipt_id"), rank: readNumber(finding, "rank") },
    }));
    return growthClosureReviewSchema.parse({
      id: readString(row, "id"), profileId: readString(row, "profile_id"), revision: readNumber(row, "revision"),
      stewardAssessmentId: readString(row, "steward_assessment_id"), checkerAssessmentId: readString(row, "checker_assessment_id"),
      idempotencyKey: readString(row, "idempotency_key"), findings, checkerDecision: readString(row, "checker_decision"),
      payloadHash: readString(row, "payload_hash"), createdAt: readString(row, "created_at"),
    });
  }

  sealClosureReview(input: unknown): GrowthClosureReview {
    growthClosureReviewSealSchema.parse(input);
    throw growthError("GROWTH_CLOSURE_LEGACY_WRITE_FORBIDDEN");
  }

  getClosureState(profileId: string): GrowthClosureState {
    const profile = this.getClosureProfile(profileId);
    if (!profile) throw growthError("GROWTH_CLOSURE_PROFILE_NOT_FOUND");
    const revision = this.getClosureRevision(profile.id, profile.currentRevision);
    if (!revision) throw growthError("GROWTH_DATA_INVALID");
    const outcomeRow = this.workspace.db.prepare(`
      SELECT outcomes.id
      FROM growth_closure_evaluation_outcomes outcomes
      JOIN growth_cycles cycles ON cycles.id = outcomes.cycle_id
      WHERE outcomes.profile_id = ? AND outcomes.revision = ? AND cycles.status = 'evaluated'
      ORDER BY cycles.sequence DESC, outcomes.created_at DESC, outcomes.id DESC
      LIMIT 1
    `).get(profile.id, revision.revision) as Row | undefined;
    const outcome = outcomeRow
      ? this.getClosureEvaluationOutcome(readString(outcomeRow, "id")) ?? fail("GROWTH_DATA_INVALID")
      : null;
    const steward = outcome
      ? this.getClosureStewardSubmission(outcome.stewardAssessmentId) ?? fail("GROWTH_DATA_INVALID")
      : null;
    const contentFacets = revision.facets.filter((facet) => facet.kind === "content" && facet.required);
    const satisfied = steward?.facetResults.filter((result) => result.state === "satisfied").map((result) => result.facetId) ?? [];
    const satisfiedSet = new Set(satisfied);
    const missing = contentFacets.filter((facet) => !satisfiedSet.has(facet.id)).map((facet) => facet.id);
    const contentState = outcome?.decision === "accepted" ? "closed"
      : outcome?.decision === "blocked" ? "blocked" : "growing";
    const visualRows = this.workspace.db.prepare(`
      SELECT items.status FROM growth_illustration_items items
      JOIN growth_illustration_requests requests ON requests.id = items.request_id
      WHERE requests.closure_profile_id = ? AND requests.closure_revision = ?
        AND items.required_for_visual_closure = 1
    `).all(profile.id, revision.revision) as Array<{ status: string }>;
    const visualStatuses = visualRows.map((row) => row.status);
    const visualState = visualStatuses.length === 0 || visualStatuses.some((status) => ["planned", "cancelled", "stale"].includes(status))
      ? "planning"
      : visualStatuses.some((status) => ["failed", "reconciliation_required"].includes(status))
        ? "blocked"
        : visualStatuses.some((status) => ["queued", "running"].includes(status))
          ? "generating" : "ready";
    const progress = outcome ? this.workspace.db.prepare(`
      SELECT cycles.sequence FROM growth_closure_assessments assessments
      JOIN growth_cycles cycles ON cycles.id = assessments.cycle_id
      WHERE assessments.id = ?
    `).get(outcome.stewardAssessmentId) as { sequence: number } | undefined : undefined;
    return growthClosureStateSchema.parse({
      profileId: profile.id, goalId: profile.goalId, profileKind: profile.profileKind,
      subjectResourceId: profile.subjectResourceId, revision: revision.revision, epoch: revision.epoch,
      contentState, visualState, satisfiedFacetIds: satisfied, missingFacetIds: missing,
      lastProgressCycleSequence: progress?.sequence ?? 0,
    });
  }

  getIllustrationRequest(requestId: string): GrowthIllustrationRequest | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_illustration_requests WHERE id = ?").get(requestId) as Row | undefined;
    if (!row) return null;
    const counts = this.workspace.db.prepare(`
      SELECT COUNT(*) AS item_count, COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_count
      FROM growth_illustration_items WHERE request_id = ?
    `).get(requestId) as { item_count: number; ready_count: number };
    return growthIllustrationRequestSchema.parse({
      id: readString(row, "id"), goalId: readString(row, "goal_id"), cycleId: readString(row, "cycle_id"),
      ruleRevision: readNumber(row, "rule_revision"), coverageMode: readString(row, "coverage_mode"),
      closureProfileId: readNullableString(row, "closure_profile_id"), closureRevision: readNullableNumber(row, "closure_revision"),
      status: readString(row, "status"), itemCount: counts.item_count, readyCount: counts.ready_count,
      createdAt: readString(row, "created_at"), updatedAt: readString(row, "updated_at"),
    });
  }

  getIllustrationItem(itemId: string): GrowthIllustrationItem | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_illustration_items WHERE id = ?").get(itemId) as Row | undefined;
    if (!row) return null;
    const sources = (this.workspace.db.prepare(`
      SELECT * FROM growth_illustration_item_sources WHERE item_id = ? ORDER BY ordinal
    `).all(itemId) as Row[]).map(readIllustrationSource);
    return growthIllustrationItemSchema.parse({
      id: readString(row, "id"), requestId: readString(row, "request_id"), batchId: readString(row, "batch_id"),
      ruleRevision: readNumber(row, "rule_revision"), purpose: readString(row, "purpose"), title: readString(row, "title"),
      variantKey: readString(row, "variant_key"), compiledPromptSha256: readString(row, "compiled_prompt_sha256"),
      requiredForVisualClosure: readNumber(row, "required_for_visual_closure") === 1,
      anchor: readIllustrationAnchor(row), sources, anchorHash: readString(row, "anchor_hash"),
      sourceVersionSetHash: readString(row, "source_version_set_hash"), status: readString(row, "status"),
      imageJobId: readNullableString(row, "image_job_id"), createdAt: readString(row, "created_at"), updatedAt: readString(row, "updated_at"),
    });
  }

  getIllustrationBatch(batchId: string): GrowthIllustrationBatch | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_illustration_request_batches WHERE id = ?").get(batchId) as Row | undefined;
    if (!row) return null;
    const items = (this.workspace.db.prepare(`
      SELECT id FROM growth_illustration_items WHERE batch_id = ? ORDER BY rowid
    `).all(batchId) as Array<{ id: string }>).map((item) => this.getIllustrationItem(item.id) ?? fail("GROWTH_DATA_INVALID"));
    return growthIllustrationBatchSchema.parse({
      id: readString(row, "id"), requestId: readString(row, "request_id"), sequence: readNumber(row, "sequence"),
      cursor: readNullableString(row, "cursor"), nextCursor: readNullableString(row, "next_cursor"),
      idempotencyKey: readString(row, "idempotency_key"), payloadHash: readString(row, "payload_hash"),
      itemCount: readNumber(row, "item_count"), status: readString(row, "status"), items,
      sealedAt: readString(row, "sealed_at"),
    });
  }

  createIllustrationRequest(input: unknown): GrowthIllustrationRequest {
    const value = growthIllustrationRequestCreateSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.workspace.db.prepare("SELECT id, payload_hash FROM growth_illustration_requests WHERE idempotency_key = ?")
        .get(value.idempotencyKey) as { id: string; payload_hash: string } | undefined;
      if (replay) {
        if (replay.payload_hash !== payloadHash) throw growthError("GROWTH_ILLUSTRATION_REQUEST_REPLAY_MISMATCH");
        const request = this.getIllustrationRequest(replay.id);
        if (!request) throw growthError("GROWTH_DATA_INVALID");
        this.workspace.db.exec("COMMIT");
        return request;
      }
      if (this.workspace.db.prepare("SELECT 1 FROM growth_illustration_requests WHERE id = ?").get(value.id)) {
        throw growthError("GROWTH_ILLUSTRATION_REQUEST_ID_CONFLICT");
      }
      const cycle = this.#requiredCycle(value.cycleId);
      if (cycle.goalId !== value.goalId || cycle.ruleRevision !== value.ruleRevision) {
        throw growthError("GROWTH_ILLUSTRATION_REQUEST_REFERENCE_MISMATCH");
      }
      if (value.closureProfileId !== null) {
        const profile = this.getClosureProfile(value.closureProfileId);
        const revision = this.getClosureRevision(value.closureProfileId, value.closureRevision!);
        if (!profile || !revision || profile.goalId !== value.goalId) throw growthError("GROWTH_ILLUSTRATION_CLOSURE_MISMATCH");
      }
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_illustration_requests (
          id, idempotency_key, payload_hash, goal_id, cycle_id, rule_revision, coverage_mode,
          closure_profile_id, closure_revision, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
      `).run(value.id, value.idempotencyKey, payloadHash, value.goalId, value.cycleId, value.ruleRevision,
        value.coverageMode, value.closureProfileId, value.closureRevision, now, now);
      this.workspace.db.exec("COMMIT");
      return this.getIllustrationRequest(value.id) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  sealIllustrationBatch(input: unknown): GrowthIllustrationBatch {
    const value = growthIllustrationBatchSealSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.workspace.db.prepare(`
        SELECT id, payload_hash FROM growth_illustration_request_batches WHERE idempotency_key = ?
      `).get(value.idempotencyKey) as { id: string; payload_hash: string } | undefined;
      if (replay) {
        if (replay.payload_hash !== payloadHash) throw growthError("GROWTH_ILLUSTRATION_BATCH_REPLAY_MISMATCH");
        const batch = this.getIllustrationBatch(replay.id);
        if (!batch) throw growthError("GROWTH_DATA_INVALID");
        this.workspace.db.exec("COMMIT");
        return batch;
      }
      if (this.workspace.db.prepare("SELECT 1 FROM growth_illustration_request_batches WHERE id = ?").get(value.id)) {
        throw growthError("GROWTH_ILLUSTRATION_BATCH_ID_CONFLICT");
      }
      const request = this.getIllustrationRequest(value.requestId);
      if (!request) throw growthError("GROWTH_ILLUSTRATION_REQUEST_NOT_FOUND");
      const expected = this.workspace.db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM growth_illustration_request_batches WHERE request_id = ?
      `).get(request.id) as { sequence: number };
      if (value.sequence !== expected.sequence) throw growthError("GROWTH_ILLUSTRATION_BATCH_SEQUENCE_INVALID");
      const cycle = this.#requiredCycle(request.cycleId);
      const pinnedCheckpointId = cycle.outputCheckpointId ?? cycle.inputCheckpointId;
      const snapshots = new Map(value.snapshots.map((snapshot) => [snapshot.id, snapshot]));
      for (const snapshot of value.snapshots) {
        if (sha256(snapshot.text) !== snapshot.textSha256) throw growthError("GROWTH_ILLUSTRATION_SNAPSHOT_HASH_MISMATCH");
        const existing = this.workspace.db.prepare(`
          SELECT goal_id, kind, snapshot_text, text_sha256 FROM growth_illustration_text_snapshots WHERE id = ?
        `).get(snapshot.id) as Row | undefined;
        if (existing && (readString(existing, "goal_id") !== request.goalId || readString(existing, "kind") !== snapshot.kind
          || readString(existing, "snapshot_text") !== snapshot.text || readString(existing, "text_sha256") !== snapshot.textSha256)) {
          throw growthError("GROWTH_ILLUSTRATION_SNAPSHOT_IMMUTABLE");
        }
      }
      const preparedItems = value.items.map((item) => {
        this.#assertIllustrationAnchor(item.anchor, request.goalId, pinnedCheckpointId, snapshots);
        item.sources.forEach((source) => this.#assertIllustrationSource(source, pinnedCheckpointId));
        return {
          item,
          anchorHash: canonicalAuditHash(item.anchor),
          sourceVersionSetHash: canonicalAuditHash(normalizeIllustrationSourceSet(item.sources)),
        };
      });
      const now = new Date().toISOString();
      for (const snapshot of value.snapshots) {
        this.workspace.db.prepare(`
          INSERT OR IGNORE INTO growth_illustration_text_snapshots (id, goal_id, kind, snapshot_text, text_sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(snapshot.id, request.goalId, snapshot.kind, snapshot.text, snapshot.textSha256, now);
      }
      this.workspace.db.prepare(`
        INSERT INTO growth_illustration_request_batches (
          id, request_id, sequence, cursor, next_cursor, item_count, idempotency_key, payload_hash, status, sealed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)
      `).run(value.id, request.id, value.sequence, value.cursor, value.nextCursor, value.items.length,
        value.idempotencyKey, payloadHash, now);
      const insertItem = this.workspace.db.prepare(`
        INSERT INTO growth_illustration_items (
          id, request_id, batch_id, rule_revision, purpose, title, variant_key, compiled_prompt_sha256,
          required_for_visual_closure, anchor_kind, anchor_resource_id, anchor_resource_version_id,
          anchor_document_id, anchor_document_version_id, start_code_point, end_code_point, source_snapshot_id,
          text_sha256, anchor_hash, source_version_set_hash, image_job_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'planned', ?, ?)
      `);
      const insertSource = this.workspace.db.prepare(`
        INSERT INTO growth_illustration_item_sources (
          item_id, ordinal, source_kind, resource_id, resource_version_id, document_id, document_version_id, content_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const prepared of preparedItems) {
        const anchor = illustrationAnchorColumns(prepared.item.anchor);
        insertItem.run(prepared.item.id, request.id, value.id, request.ruleRevision, prepared.item.purpose, prepared.item.title,
          prepared.item.variantKey, prepared.item.compiledPromptSha256, prepared.item.requiredForVisualClosure ? 1 : 0,
          anchor.kind, anchor.resourceId, anchor.resourceVersionId, anchor.documentId, anchor.documentVersionId,
          anchor.startCodePoint, anchor.endCodePoint, anchor.sourceSnapshotId, anchor.textSha256,
          prepared.anchorHash, prepared.sourceVersionSetHash, now, now);
        prepared.item.sources.forEach((source, ordinal) => {
          const columns = illustrationSourceColumns(source);
          insertSource.run(prepared.item.id, ordinal, columns.kind, columns.resourceId, columns.resourceVersionId,
            columns.documentId, columns.documentVersionId, columns.contentSha256);
        });
      }
      this.#syncIllustrationAggregates(request.id, now);
      this.workspace.db.exec("COMMIT");
      return this.getIllustrationBatch(value.id) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  bindIllustrationImageJob(input: unknown): GrowthIllustrationItem {
    const value = growthIllustrationImageJobBindSchema.parse(input);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getIllustrationItem(value.itemId);
      if (!item) throw growthError("GROWTH_ILLUSTRATION_ITEM_NOT_FOUND");
      if (item.imageJobId && item.imageJobId !== value.imageJobId) throw growthError("GROWTH_ILLUSTRATION_JOB_ALREADY_BOUND");
      const job = this.workspace.db.prepare(`
        SELECT purpose, prompt_sha256, source_resource_ids_json, source_version_ids_json
        FROM image_generation_jobs WHERE id = ?
      `).get(value.imageJobId) as Row | undefined;
      if (!job) throw growthError("GROWTH_ILLUSTRATION_JOB_NOT_FOUND");
      if (readString(job, "prompt_sha256") !== item.compiledPromptSha256) {
        throw growthError("GROWTH_ILLUSTRATION_JOB_PROMPT_MISMATCH");
      }
      if (readString(job, "purpose") !== item.purpose) {
        throw growthError("GROWTH_ILLUSTRATION_JOB_PURPOSE_MISMATCH");
      }
      const expectedSources = this.#illustrationImageJobSources(item.sources);
      const jobResourceIds = parseNormalizedImageJobSourceIds(job.source_resource_ids_json);
      const jobVersionIds = parseNormalizedImageJobSourceIds(job.source_version_ids_json);
      if (!sameStrings(jobResourceIds, expectedSources.resourceIds)
        || !sameStrings(jobVersionIds, expectedSources.versionIds)) {
        throw growthError("GROWTH_ILLUSTRATION_JOB_SOURCE_MISMATCH");
      }
      if (!item.imageJobId) {
        this.workspace.db.prepare("UPDATE growth_illustration_items SET image_job_id = ?, updated_at = ? WHERE id = ?")
          .run(value.imageJobId, new Date().toISOString(), item.id);
      }
      const refreshed = this.#refreshIllustrationItemFromJob(item.id);
      this.workspace.db.exec("COMMIT");
      return refreshed;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  refreshIllustrationItemFromJob(itemId: string): GrowthIllustrationItem {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.#refreshIllustrationItemFromJob(itemId);
      this.workspace.db.exec("COMMIT");
      return item;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  markIllustrationItemStale(input: unknown): GrowthIllustrationItem {
    const value = growthIllustrationMarkStaleSchema.parse(input);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getIllustrationItem(value.itemId);
      if (!item) throw growthError("GROWTH_ILLUSTRATION_ITEM_NOT_FOUND");
      if (item.anchorHash !== value.expectedAnchorHash) throw growthError("GROWTH_ILLUSTRATION_STALE_CAS_MISMATCH");
      if (item.status !== "stale") {
        const now = new Date().toISOString();
        this.workspace.db.prepare("UPDATE growth_illustration_items SET status = 'stale', updated_at = ? WHERE id = ?").run(now, item.id);
        this.#syncIllustrationAggregates(item.requestId, now);
      }
      this.workspace.db.exec("COMMIT");
      return this.getIllustrationItem(item.id) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendRule(input: unknown): GrowthRuleRevision {
    const value = growthRuleAppendSchema.parse(input);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const goal = this.#requiredGoal(value.goalId);
      const sourceReplay = value.sourceMessageId === null
        ? undefined
        : this.workspace.db.prepare(`
          SELECT * FROM growth_goal_rule_revisions
          WHERE goal_id = ? AND source_message_id = ?
          ORDER BY revision
          LIMIT 1
        `).get(value.goalId, value.sourceMessageId) as Row | undefined;
      if (sourceReplay) {
        if (readNumber(sourceReplay, "revision") === value.expectedRevision + 1 && readString(sourceReplay, "rule_text") === value.ruleText) {
          this.workspace.db.exec("COMMIT");
          return mapRuleRevision(sourceReplay);
        }
        throw growthError("GROWTH_RULE_REVISION_MISMATCH");
      }
      if (goal.currentRuleRevision !== value.expectedRevision) {
        const replay = this.workspace.db.prepare("SELECT * FROM growth_goal_rule_revisions WHERE goal_id = ? AND revision = ?")
          .get(value.goalId, value.expectedRevision + 1) as Row | undefined;
        if (replay && readString(replay, "rule_text") === value.ruleText && readNullableString(replay, "source_message_id") === value.sourceMessageId) {
          this.workspace.db.exec("COMMIT");
          return mapRuleRevision(replay);
        }
        throw growthError("GROWTH_RULE_REVISION_MISMATCH");
      }
      if (!["active", "blocked", "reconciliation_required"].includes(goal.status)) throw growthError("GROWTH_GOAL_NOT_ACTIVE");
      const revision = value.expectedRevision + 1;
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_goal_rule_revisions (goal_id, revision, rule_text, source_message_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(value.goalId, revision, value.ruleText, value.sourceMessageId, now);
      this.workspace.db.prepare("UPDATE growth_goals SET current_rule_revision = ?, updated_at = ? WHERE id = ?")
        .run(revision, now, value.goalId);
      this.workspace.db.exec("COMMIT");
      return growthRuleRevisionSchema.parse({ goalId: value.goalId, revision, ruleText: value.ruleText, sourceMessageId: value.sourceMessageId, createdAt: now });
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  beginCycle(input: unknown): GrowthCycle {
    const value = growthCycleBeginSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.workspace.db.prepare("SELECT id, payload_hash FROM growth_cycles WHERE idempotency_key = ?")
        .get(value.idempotencyKey) as { id: string; payload_hash: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw growthError("GROWTH_IDEMPOTENCY_KEY_REUSED");
        const cycle = this.getCycle(existing.id);
        if (!cycle) throw growthError("GROWTH_DATA_INVALID");
        this.workspace.db.exec("COMMIT");
        return cycle;
      }
      if (this.workspace.db.prepare("SELECT 1 FROM growth_cycles WHERE id = ?").get(value.id)) throw growthError("GROWTH_CYCLE_ID_CONFLICT");
      const goal = this.#requiredGoal(value.goalId);
      if (goal.status !== "active") throw growthError("GROWTH_GOAL_NOT_ACTIVE");
      if (goal.currentRuleRevision !== value.ruleRevision) throw growthError("GROWTH_RULE_REVISION_MISMATCH");
      if (this.#hasOpenCycle(goal.id)) throw growthError("GROWTH_OPEN_CYCLE_EXISTS");
      const previous = this.workspace.db.prepare("SELECT * FROM growth_cycles WHERE goal_id = ? ORDER BY sequence DESC LIMIT 1").get(goal.id) as Row | undefined;
      const branchHead = this.#getBranchHead(goal.branchId);
      const previousOutput = previous ? readNullableString(previous, "output_checkpoint_id") : null;
      const resumesCreatorAnswer = previous
        ? readString(previous, "status") === "blocked"
          && readNullableString(previous, "failure_code") === "GROWTH_CREATOR_CHOICE_REQUIRED"
          && Boolean(this.workspace.db.prepare(`
            SELECT 1
            FROM growth_inquiry_batches batches
            JOIN growth_inquiry_batch_contracts contracts ON contracts.batch_id = batches.id
            JOIN growth_inquiry_creator_answers answers
              ON answers.inquiry_id = contracts.creator_choice_required_inquiry_id
            WHERE batches.cycle_id = ? AND contracts.contract_version = 'v25'
          `).get(readString(previous, "id")))
        : false;
      const previousStatus = previous ? readString(previous, "status") : null;
      const expectedInput = previous
        ? previousOutput ?? (resumesCreatorAnswer || previousStatus === "evaluated" ? readString(previous, "input_checkpoint_id") : null)
        : branchHead;
      if (!expectedInput || value.inputCheckpointId !== expectedInput || value.inputCheckpointId !== branchHead) {
        throw growthError("GROWTH_CYCLE_INPUT_CHECKPOINT_MISMATCH");
      }
      this.#assertCheckpointBranch(value.inputCheckpointId, goal.branchId);
      const sequence = goal.currentCycleSequence + 1;
      const intent = value.intent;
      if (intent.kind === "closure_evaluation") {
        const profile = this.getClosureProfile(intent.profileId);
        const revision = this.getClosureRevision(intent.profileId, intent.revision);
        if (!profile || profile.goalId !== goal.id || profile.contractGeneration !== "v26" || !revision
          || revision.contractGeneration !== "v26" || intent.checkpointId !== value.inputCheckpointId
          || revision.checkpointId !== value.inputCheckpointId || revision.ruleRevision !== value.ruleRevision) {
          throw growthError("GROWTH_CLOSURE_EVALUATION_INTENT_INVALID");
        }
      } else if (intent.kind === "repair") {
        const repairSource = this.workspace.db.prepare(`
          SELECT reviews.profile_id, reviews.revision, reviews.checker_decision, reviews.contract_generation,
            findings.id AS finding_id, findings.fingerprint, findings.severity
          FROM growth_closure_reviews reviews
          JOIN growth_closure_assessments checker ON checker.id = reviews.checker_assessment_id
          JOIN growth_closure_adverse_findings findings ON findings.assessment_id = checker.id
          WHERE reviews.id = ? AND findings.id = ?
        `).get(intent.originalReviewId, intent.selectedFindingId) as Row | undefined;
        if (!repairSource || readString(repairSource, "profile_id") !== intent.profileId
          || readNumber(repairSource, "revision") !== intent.revision
          || readString(repairSource, "checker_decision") !== "repairs_required"
          || readString(repairSource, "contract_generation") !== "v26"
          || readString(repairSource, "fingerprint") !== intent.selectedFindingFingerprint
          || !["major", "blocking"].includes(readString(repairSource, "severity"))) {
          throw growthError("GROWTH_CLOSURE_REPAIR_INTENT_INVALID");
        }
      }
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_cycles (
          id, goal_id, sequence, idempotency_key, payload_hash, input_checkpoint_id, rule_revision,
          run_id, receipt_id, change_set_id, output_checkpoint_id, status, failure_code, created_at, updated_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'planned', NULL, ?, ?, NULL)
      `).run(value.id, value.goalId, sequence, value.idempotencyKey, payloadHash, value.inputCheckpointId, value.ruleRevision, now, now);
      this.workspace.db.prepare(`
        INSERT INTO growth_cycle_intents (
          cycle_id, kind, contract_generation, profile_id, revision, checkpoint_id, original_review_id,
          selected_finding_id, selected_finding_fingerprint, created_at
        ) VALUES (?, ?, 'persisted_v26', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        value.id, intent.kind,
        intent.kind === "closure_evaluation" || intent.kind === "repair" ? intent.profileId : null,
        intent.kind === "closure_evaluation" || intent.kind === "repair" ? intent.revision : null,
        intent.kind === "closure_evaluation" ? intent.checkpointId : null,
        intent.kind === "repair" ? intent.originalReviewId : null,
        intent.kind === "repair" ? intent.selectedFindingId : null,
        intent.kind === "repair" ? intent.selectedFindingFingerprint : null,
        now,
      );
      if (intent.kind === "expand" || intent.kind === "revision") {
        const insertFocus = this.workspace.db.prepare(`
          INSERT INTO growth_cycle_intent_focuses (cycle_id, ordinal, focus_kind) VALUES (?, ?, ?)
        `);
        intent.focusKinds.forEach((focusKind, ordinal) => insertFocus.run(value.id, ordinal, focusKind));
        const insertFrontier = this.workspace.db.prepare(`
          INSERT INTO growth_cycle_intent_frontier (cycle_id, ordinal, frontier_kind) VALUES (?, ?, ?)
        `);
        intent.resumeFrontier.forEach((frontierKind, ordinal) => insertFrontier.run(value.id, ordinal, frontierKind));
      }
      this.workspace.db.prepare("UPDATE growth_goals SET current_cycle_sequence = ?, updated_at = ? WHERE id = ?").run(sequence, now, value.goalId);
      this.workspace.db.exec("COMMIT");
      return this.getCycle(value.id) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  attachRun(input: unknown): GrowthCycle {
    const value = growthCycleAttachRunSchema.parse(input);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const cycle = this.#requiredCycle(value.cycleId);
      if (cycle.runId) {
        if (cycle.runId === value.runId) {
          this.workspace.db.exec("COMMIT");
          return cycle;
        }
        throw growthError("GROWTH_RUN_ALREADY_BOUND");
      }
      if (cycle.status !== "planned") throw growthError("GROWTH_RUN_ALREADY_BOUND");
      const goal = this.#requiredGoal(cycle.goalId);
      const run = this.workspace.db.prepare("SELECT branch_id, base_checkpoint_id FROM agent_runs WHERE id = ?").get(value.runId) as Row | undefined;
      if (!run || readString(run, "branch_id") !== goal.branchId || readString(run, "base_checkpoint_id") !== cycle.inputCheckpointId) {
        throw growthError("GROWTH_RUN_REFERENCE_MISMATCH");
      }
      const now = new Date().toISOString();
      this.workspace.db.prepare("UPDATE growth_cycles SET run_id = ?, status = 'running', updated_at = ? WHERE id = ?").run(value.runId, now, value.cycleId);
      this.workspace.db.exec("COMMIT");
      return this.getCycle(value.cycleId) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordReceipt(input: unknown): GrowthRetrievalReceipt {
    const value = growthRetrievalReceiptCreateSchema.parse(input);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getReceipt(value.id);
      if (existing) {
        if (canonicalAuditHash(receiptInputFromOutput(existing)) !== canonicalAuditHash(value)) throw growthError("GROWTH_RECEIPT_REPLAY_MISMATCH");
        this.workspace.db.exec("COMMIT");
        return existing;
      }
      const cycle = this.#requiredCycle(value.cycleId);
      const goal = this.#requiredGoal(cycle.goalId);
      if (cycle.status !== "running" || !cycle.runId || cycle.receiptId) throw growthError("GROWTH_RECEIPT_BINDING_INVALID");
      if (cycle.runId !== value.runId || goal.branchId !== value.branchId || cycle.inputCheckpointId !== value.checkpointId) {
        throw growthError("GROWTH_RECEIPT_REFERENCE_MISMATCH");
      }
      if (!sameStrings(this.#goalScopes(goal.id), value.effectiveScopeResourceIds)) throw growthError("GROWTH_RECEIPT_SCOPE_MISMATCH");
      this.#assertScopesVisible(value.effectiveScopeResourceIds, value.checkpointId);
      const tool = this.workspace.db.prepare("SELECT run_id, tool_name FROM agent_tool_invocations WHERE id = ?").get(value.toolInvocationId) as Row | undefined;
      if (!tool || readString(tool, "run_id") !== value.runId || readString(tool, "tool_name") !== "retrieve_graph_evidence") {
        throw growthError("GROWTH_RECEIPT_TOOL_MISMATCH");
      }
      value.links.forEach((link) => this.#assertReceiptLinkVisible(link, value.checkpointId, value.branchId));
      const receipt = receiptOutput(value, new Date().toISOString());
      this.workspace.db.prepare(`
        INSERT INTO growth_retrieval_receipts (
          id, cycle_id, run_id, tool_invocation_id, branch_id, checkpoint_id, lens, query_text,
          valid_time_from, valid_time_to, recorded_time_from, recorded_time_to, max_hops, cpu_budget_ms,
          expansion_budget, result_budget, token_budget, policy_version, query_hash, result_hash, hit_count,
          conflict_count, locator_count, coverage_state, coverage_searched_scope_count, coverage_omitted_count,
          truncated, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'creator', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(receipt.id, receipt.cycleId, receipt.runId, receipt.toolInvocationId, receipt.branchId, receipt.checkpointId, receipt.query,
        receipt.validTime?.from ?? null, receipt.validTime?.to ?? null, receipt.recordedTime?.from ?? null, receipt.recordedTime?.to ?? null,
        receipt.maxHops, receipt.cpuBudgetMs, receipt.expansionBudget, receipt.resultBudget, receipt.tokenBudget, receipt.policyVersion,
        receipt.queryHash, receipt.resultHash, receipt.hitCount, receipt.conflictCount, receipt.locatorCount, receipt.coverage.state,
        receipt.coverage.searchedScopeCount, receipt.coverage.omittedCount, receipt.truncated ? 1 : 0, receipt.createdAt);
      const insertScope = this.workspace.db.prepare("INSERT INTO growth_retrieval_receipt_scopes (receipt_id, resource_id, ordinal) VALUES (?, ?, ?)");
      receipt.effectiveScopeResourceIds.forEach((resourceId, ordinal) => insertScope.run(receipt.id, resourceId, ordinal));
      const insertAlias = this.workspace.db.prepare("INSERT INTO growth_retrieval_receipt_aliases (receipt_id, alias, ordinal) VALUES (?, ?, ?)");
      receipt.aliases.forEach((alias, ordinal) => insertAlias.run(receipt.id, alias, ordinal));
      const insertLink = this.workspace.db.prepare(`
        INSERT INTO growth_retrieval_receipt_links (
          receipt_id, rank, target_kind, target_id, target_version_id, score, reason_codes_json,
          path_target_ids_json, stable_locator, stable_version_id, stable_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      receipt.links.forEach((link) => insertLink.run(receipt.id, link.rank, link.targetKind, link.targetId, link.targetVersionId,
        link.score, JSON.stringify(link.reasonCodes), JSON.stringify(link.pathTargetIds), link.stableLocator, link.stableVersionId, link.stableHash));
      this.workspace.db.prepare("UPDATE growth_cycles SET receipt_id = ?, updated_at = ? WHERE id = ?").run(receipt.id, new Date().toISOString(), receipt.cycleId);
      this.workspace.db.exec("COMMIT");
      return this.getReceipt(receipt.id) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  attachCommittedChangeSet(input: unknown): GrowthCycle {
    const value = growthCycleAttachChangeSetSchema.parse(input);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const cycle = this.#requiredCycle(value.cycleId);
      if (cycle.changeSetId) {
        if (cycle.changeSetId === value.changeSetId) {
          this.workspace.db.exec("COMMIT");
          return cycle;
        }
        throw growthError("GROWTH_CHANGE_SET_BINDING_INVALID");
      }
      if (cycle.status !== "running" || !cycle.runId || !cycle.receiptId) throw growthError("GROWTH_CHANGE_SET_BINDING_INVALID");
      const changeSet = this.workspace.db.prepare(`
        SELECT branch_id, base_checkpoint_id, committed_checkpoint_id, status FROM change_sets WHERE id = ?
      `).get(value.changeSetId) as Row | undefined;
      const goal = this.#requiredGoal(cycle.goalId);
      if (!changeSet || readString(changeSet, "status") !== "committed" || readString(changeSet, "branch_id") !== goal.branchId
        || readString(changeSet, "base_checkpoint_id") !== cycle.inputCheckpointId || !readNullableString(changeSet, "committed_checkpoint_id")) {
        throw growthError("GROWTH_CHANGE_SET_REFERENCE_MISMATCH");
      }
      const outputCheckpointId = readString(changeSet, "committed_checkpoint_id");
      this.#assertCheckpointBranch(outputCheckpointId, goal.branchId);
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        UPDATE growth_cycles SET change_set_id = ?, output_checkpoint_id = ?, status = 'committed', updated_at = ?, terminal_at = ? WHERE id = ?
      `).run(value.changeSetId, outputCheckpointId, now, now, value.cycleId);
      this.workspace.db.exec("COMMIT");
      return this.getCycle(value.cycleId) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  terminalizeCycle(input: unknown): GrowthCycle {
    const value = growthCycleTerminalizeSchema.parse(input);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const cycle = this.#requiredCycle(value.cycleId);
      if (cycle.status !== "planned" && cycle.status !== "running") {
        if (cycle.status === value.status && cycle.failureCode === value.failureCode) {
          this.workspace.db.exec("COMMIT");
          return cycle;
        }
        throw growthError("GROWTH_CYCLE_ALREADY_TERMINAL");
      }
      const now = new Date().toISOString();
      this.workspace.db.prepare("UPDATE growth_cycles SET status = ?, failure_code = ?, updated_at = ?, terminal_at = ? WHERE id = ?")
        .run(value.status, value.failureCode, now, now, value.cycleId);
      const goalStatus = value.status === "cancelled" ? "cancelled" : value.status === "reconciliation_required" ? "reconciliation_required" : "blocked";
      this.workspace.db.prepare("UPDATE growth_goals SET status = ?, updated_at = ? WHERE id = ?").run(goalStatus, now, cycle.goalId);
      this.workspace.db.exec("COMMIT");
      return this.getCycle(value.cycleId) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendEvent(input: unknown): GrowthEvent {
    const value = growthEventAppendSchema.parse(input);
    if (value.targetKind === "inquiry") throw growthError("GROWTH_INQUIRY_EVENT_REPOSITORY_OWNED");
    if (value.targetKind === "closure_evaluation") throw growthError("GROWTH_CLOSURE_EVENT_REPOSITORY_OWNED");
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = this.workspace.db.prepare("SELECT * FROM growth_events WHERE goal_id = ? AND sequence = ?").get(value.goalId, value.sequence) as Row | undefined;
      if (existingRow) {
        const existing = mapEvent(existingRow);
        if (canonicalAuditHash(eventInputFromOutput(existing)) !== canonicalAuditHash(value)) throw growthError("GROWTH_EVENT_REPLAY_MISMATCH");
        this.workspace.db.exec("COMMIT");
        return existing;
      }
      const cycle = this.#requiredCycle(value.cycleId);
      if (cycle.goalId !== value.goalId || cycle.runId !== value.runId || cycle.status !== value.durableState) {
        throw growthError("GROWTH_EVENT_REFERENCE_MISMATCH");
      }
      const last = this.workspace.db.prepare("SELECT MAX(sequence) AS sequence FROM growth_events WHERE goal_id = ?").get(value.goalId) as { sequence: number | null };
      if (value.sequence !== (last.sequence ?? 0) + 1) throw growthError("GROWTH_EVENT_SEQUENCE_INVALID");
      if (value.phase === "change_set_committed" && (value.targetId !== cycle.changeSetId || value.targetVersionId !== cycle.outputCheckpointId)) {
        throw growthError("GROWTH_EVENT_CHANGE_SET_MISMATCH");
      }
      const goal = this.#requiredGoal(value.goalId);
      this.#assertEventTargetVisible(value.targetKind, value.targetId, value.targetVersionId, value.phase, cycle, goal.branchId);
      if (value.contentRef) this.#assertContentRefVisible(value.contentRef.kind, value.contentRef.targetId, value.contentRef.targetVersionId, cycle, goal.branchId);
      const event = growthEventSchema.parse({ ...value, createdAt: new Date().toISOString() });
      this.workspace.db.prepare(`
        INSERT INTO growth_events (
          goal_id, cycle_id, run_id, sequence, safe_summary, phase, target_kind, target_id, target_version_id,
          durable_state, content_ref_kind, content_ref_id, content_ref_version_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(event.goalId, event.cycleId, event.runId, event.sequence, event.safeSummary, event.phase, event.targetKind,
        event.targetId, event.targetVersionId, event.durableState, event.contentRef?.kind ?? null, event.contentRef?.targetId ?? null,
        event.contentRef?.targetVersionId ?? null, event.createdAt);
      this.workspace.db.exec("COMMIT");
      return event;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  #assertInquiryNotStalled(
    cycle: GrowthCycle,
    receipt: GrowthRetrievalReceipt,
    value: ReturnType<typeof growthInquiryBatchSealSchema.parse>,
  ): void {
    if (cycle.sequence < 2) return;
    const frontierId = value.selectedInquiryId ?? value.creatorChoiceRequiredInquiryId;
    const frontier = value.questions.find((question) => question.id === frontierId);
    if (!frontier) throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
    const prior = this.workspace.db.prepare(`
      SELECT batches.id AS batch_id, batches.sealed_at, inquiries.id AS inquiry_id,
        inquiries.fingerprint, inquiries.evidence_state
      FROM growth_cycles cycles
      JOIN growth_inquiry_batches batches ON batches.cycle_id = cycles.id
      JOIN growth_inquiry_batch_contracts contracts ON contracts.batch_id = batches.id
      JOIN growth_inquiries inquiries ON inquiries.id = batches.selected_inquiry_id
      WHERE cycles.goal_id = ? AND cycles.sequence = ?
        AND contracts.contract_version = 'v25' AND batches.status = 'sealed'
    `).get(cycle.goalId, cycle.sequence - 1) as Row | undefined;
    if (!prior || readString(prior, "fingerprint") !== frontier.fingerprint
      || readString(prior, "evidence_state") !== frontier.evidenceState) return;
    const priorEvidence = (this.workspace.db.prepare(`
      SELECT evidence.rank, links.target_kind, links.target_id, links.target_version_id
      FROM growth_inquiry_evidence_links evidence
      JOIN growth_retrieval_receipt_links links
        ON links.receipt_id = evidence.receipt_id AND links.rank = evidence.rank
      WHERE evidence.batch_id = ? AND evidence.inquiry_id = ?
      ORDER BY evidence.rank
    `).all(readString(prior, "batch_id"), readString(prior, "inquiry_id")) as Row[]).map((row) => ({
      rank: readNumber(row, "rank"),
      targetKind: readString(row, "target_kind"),
      targetId: readString(row, "target_id"),
      targetVersionId: readNullableString(row, "target_version_id"),
    }));
    const receiptLinks = new Map(receipt.links.map((link) => [link.rank, link]));
    const currentEvidence = [...frontier.evidenceRanks].sort((left, right) => left - right).map((rank) => {
      const link = receiptLinks.get(rank);
      if (!link) throw growthError("GROWTH_INQUIRY_EVIDENCE_RANK_INVALID");
      return { rank, targetKind: link.targetKind, targetId: link.targetId, targetVersionId: link.targetVersionId };
    });
    if (canonicalAuditHash(priorEvidence) !== canonicalAuditHash(currentEvidence)) return;
    const priorClosure = this.#closureFacetEvidenceSignature(cycle.goalId, readString(prior, "sealed_at"));
    const currentClosure = this.#closureFacetEvidenceSignature(cycle.goalId, new Date().toISOString());
    if (priorClosure === currentClosure) throw growthError("GROWTH_INQUIRY_STALLED");
  }

  #assertInquiryNotDuplicate(
    cycle: GrowthCycle,
    receipt: GrowthRetrievalReceipt,
    value: ReturnType<typeof growthInquiryBatchSealSchema.parse>,
  ): void {
    if (cycle.sequence < 2) return;
    const existing = this.workspace.db.prepare(`
      SELECT inquiries.batch_id, inquiries.id AS inquiry_id, inquiries.fingerprint, cycles.sequence, lifecycle.phase
      FROM growth_inquiries inquiries
      JOIN growth_inquiry_batches batches ON batches.id = inquiries.batch_id
      JOIN growth_inquiry_batch_contracts contracts ON contracts.batch_id = batches.id
      JOIN growth_cycles cycles ON cycles.id = batches.cycle_id
      JOIN growth_inquiry_lifecycle lifecycle ON lifecycle.inquiry_id = inquiries.id
      WHERE cycles.goal_id = ? AND cycles.id <> ? AND contracts.contract_version = 'v25'
        AND lifecycle.sequence = (
          SELECT MAX(candidate.sequence) FROM growth_inquiry_lifecycle candidate
          WHERE candidate.inquiry_id = inquiries.id
        )
        AND (cycles.sequence = ? OR lifecycle.phase IN ('backlog', 'selected', 'creator_answered'))
    `).all(cycle.goalId, cycle.id, cycle.sequence - 1) as Row[];
    const receiptLinks = new Map(receipt.links.map((link) => [link.rank, link]));
    const duplicated = value.questions.some((question) => {
      const currentIdentity = [...question.evidenceRanks].sort((left, right) => left - right).map((rank) => {
        const link = receiptLinks.get(rank);
        if (!link) throw growthError("GROWTH_INQUIRY_EVIDENCE_RANK_INVALID");
        return { rank, targetKind: link.targetKind, targetId: link.targetId, targetVersionId: link.targetVersionId };
      });
      return existing.some((row) => {
        if (readString(row, "fingerprint") !== question.fingerprint) return false;
        const priorIdentity = (this.workspace.db.prepare(`
          SELECT evidence.rank, links.target_kind, links.target_id, links.target_version_id
          FROM growth_inquiry_evidence_links evidence
          JOIN growth_retrieval_receipt_links links
            ON links.receipt_id = evidence.receipt_id AND links.rank = evidence.rank
          WHERE evidence.batch_id = ? AND evidence.inquiry_id = ?
          ORDER BY evidence.rank
        `).all(readString(row, "batch_id"), readString(row, "inquiry_id")) as Row[]).map((linkRow) => ({
          rank: readNumber(linkRow, "rank"),
          targetKind: readString(linkRow, "target_kind"),
          targetId: readString(linkRow, "target_id"),
          targetVersionId: readNullableString(linkRow, "target_version_id"),
        }));
        return canonicalAuditHash(priorIdentity) === canonicalAuditHash(currentIdentity);
      });
    });
    if (duplicated) {
      throw growthError("GROWTH_INQUIRY_DUPLICATE");
    }
  }

  #closureFacetEvidenceSignature(goalId: string, cutoff: string): string {
    const facets = this.workspace.db.prepare(`
      SELECT profiles.id AS profile_id, revisions.revision, revisions.epoch,
        revisions.checkpoint_id, revisions.rule_revision, facets.facet_id,
        facets.facet_kind, facets.required, facets.ordinal
      FROM growth_closure_profiles profiles
      JOIN growth_closure_profile_revisions revisions ON revisions.profile_id = profiles.id
      JOIN growth_closure_facets facets
        ON facets.profile_id = revisions.profile_id AND facets.revision = revisions.revision
      WHERE profiles.goal_id = ? AND revisions.created_at <= ?
      ORDER BY profiles.id, revisions.revision, facets.ordinal
    `).all(goalId, cutoff) as Row[];
    const findings = this.workspace.db.prepare(`
      SELECT profiles.id AS profile_id, reviews.revision, reviews.id AS review_id,
        reviews.checker_decision, findings.facet_id, findings.state,
        findings.receipt_id, findings.rank, findings.ordinal
      FROM growth_closure_profiles profiles
      JOIN growth_closure_reviews reviews ON reviews.profile_id = profiles.id
      LEFT JOIN growth_closure_review_findings findings ON findings.review_id = reviews.id
      WHERE profiles.goal_id = ? AND reviews.created_at <= ?
      ORDER BY profiles.id, reviews.revision, reviews.created_at, reviews.id, findings.ordinal
    `).all(goalId, cutoff) as Row[];
    return canonicalAuditHash({ facets, findings });
  }

  #requiredInquiryContext(inquiryId: string): {
    batchId: string;
    cycleId: string;
    cycleSequence: number;
    receiptId: string;
    checkpointId: string;
    ruleRevision: number;
    goalId: string;
    contractVersion: string;
    creatorChoiceRequiredInquiryId: string | null;
    requiresCreatorChoice: boolean;
  } {
    const row = this.workspace.db.prepare(`
      SELECT inquiries.batch_id, batches.cycle_id, batches.receipt_id, batches.checkpoint_id,
        batches.rule_revision, cycles.goal_id, cycles.sequence AS cycle_sequence, contracts.contract_version,
        contracts.creator_choice_required_inquiry_id, details.requires_creator_choice
      FROM growth_inquiries inquiries
      JOIN growth_inquiry_batches batches ON batches.id = inquiries.batch_id
      JOIN growth_cycles cycles ON cycles.id = batches.cycle_id
      LEFT JOIN growth_inquiry_batch_contracts contracts ON contracts.batch_id = batches.id
      LEFT JOIN growth_inquiry_details details
        ON details.batch_id = inquiries.batch_id AND details.inquiry_id = inquiries.id
      WHERE inquiries.id = ?
    `).get(inquiryId) as Row | undefined;
    if (!row) throw growthError("GROWTH_INQUIRY_NOT_FOUND");
    if (row.contract_version === null) throw growthError("GROWTH_INQUIRY_DATA_CORRUPT");
    return {
      batchId: readString(row, "batch_id"), cycleId: readString(row, "cycle_id"),
      cycleSequence: readNumber(row, "cycle_sequence"),
      receiptId: readString(row, "receipt_id"), checkpointId: readString(row, "checkpoint_id"),
      ruleRevision: readNumber(row, "rule_revision"), goalId: readString(row, "goal_id"),
      contractVersion: readString(row, "contract_version"),
      creatorChoiceRequiredInquiryId: readNullableString(row, "creator_choice_required_inquiry_id"),
      requiresCreatorChoice: row.requires_creator_choice === 1,
    };
  }

  #assertClosureRevisionAuthority(goalId: string, checkpointId: string, ruleRevision: number): void {
    const goal = this.#requiredGoal(goalId);
    this.#assertCheckpointBranch(checkpointId, goal.branchId);
    this.getRuleRevision(goal.id, ruleRevision);
  }

  #assertClosureRevisionShape(
    profileKind: "world_birth" | "oc_saga" | "story_universe" | "mixed_birth",
    componentProfiles: ReadonlyArray<"world_birth" | "oc_saga" | "story_universe">,
    focusOcResourceId: string | null,
  ): void {
    if (profileKind === "mixed_birth") {
      if (componentProfiles.length === 0
        || componentProfiles.includes("oc_saga") !== (focusOcResourceId !== null)) {
        throw growthError("GROWTH_CLOSURE_REVISION_SHAPE_INVALID");
      }
      return;
    }
    if (componentProfiles.length > 0 || focusOcResourceId !== null) {
      throw growthError("GROWTH_CLOSURE_REVISION_SHAPE_INVALID");
    }
  }

  #appendClosureAssessmentRow(
    value: ClosureAssessmentRowInput,
    payloadHash: string,
    contractGeneration: "legacy_pre_v26" | "v26",
  ): GrowthClosureAssessment {
    const replay = this.workspace.db.prepare(`
      SELECT id, payload_hash, contract_generation FROM growth_closure_assessments WHERE idempotency_key = ?
    `).get(value.idempotencyKey) as Row | undefined;
    if (replay) {
      if (readString(replay, "payload_hash") !== payloadHash
        || readString(replay, "contract_generation") !== contractGeneration) {
        throw growthError("GROWTH_CLOSURE_ASSESSMENT_REPLAY_MISMATCH");
      }
      return this.getClosureAssessment(readString(replay, "id")) ?? fail("GROWTH_DATA_INVALID");
    }
    if (this.workspace.db.prepare("SELECT 1 FROM growth_closure_assessments WHERE id = ?").get(value.id)) {
      throw growthError("GROWTH_CLOSURE_ASSESSMENT_ID_CONFLICT");
    }
    const profile = this.getClosureProfile(value.profileId);
    const revision = this.getClosureRevision(value.profileId, value.revision);
    if (!profile || !revision) throw growthError("GROWTH_CLOSURE_REVISION_NOT_FOUND");
    if (contractGeneration === "v26" && (profile.contractGeneration !== "v26" || revision.contractGeneration !== "v26")) {
      throw growthError("GROWTH_CLOSURE_LEGACY_REVISION_REQUIRES_EXPLICIT_REVISION");
    }
    const cycle = this.#requiredCycle(value.cycleId);
    const receipt = this.getReceipt(value.receiptId);
    if (cycle.goalId !== profile.goalId || cycle.status !== "running" || !cycle.runId
      || cycle.inputCheckpointId !== value.checkpointId || cycle.ruleRevision !== value.ruleRevision
      || cycle.receiptId !== value.receiptId || !receipt || receipt.cycleId !== cycle.id
      || receipt.runId !== cycle.runId || receipt.checkpointId !== cycle.inputCheckpointId
      || receipt.checkpointId !== revision.checkpointId || receipt.checkpointId !== value.checkpointId
      || revision.ruleRevision !== value.ruleRevision) {
      throw growthError("GROWTH_CLOSURE_ASSESSMENT_REFERENCE_MISMATCH");
    }
    if (contractGeneration === "v26") {
      const intent = this.getCycleIntent(cycle.id);
      if (intent.kind !== "closure_evaluation" || intent.profileId !== profile.id || intent.revision !== revision.revision
        || intent.checkpointId !== cycle.inputCheckpointId) {
        throw growthError("GROWTH_CLOSURE_EVALUATION_INTENT_INVALID");
      }
    }
    const invocation = this.workspace.db.prepare(`
      SELECT invocations.role, invocations.run_id, events.run_id AS event_run_id,
        events.event_type, events.output_sha256, events.error_code
      FROM agent_invocations invocations
      JOIN agent_audit_events events ON events.invocation_id = invocations.id
      WHERE invocations.id = ? AND events.entity_type = 'invocation' AND events.terminal = 1
    `).get(value.agentInvocationId) as Row | undefined;
    if (!invocation || readString(invocation, "role") !== value.role || readString(invocation, "run_id") !== cycle.runId
      || readString(invocation, "event_run_id") !== cycle.runId || readString(invocation, "event_type") !== "completed"
      || readNullableString(invocation, "error_code") !== null || readNullableString(invocation, "output_sha256") !== value.outputSha256) {
      throw growthError("GROWTH_CLOSURE_INVOCATION_MISMATCH");
    }
    const now = new Date().toISOString();
    this.workspace.db.prepare(`
      INSERT INTO growth_closure_assessments (
        id, profile_id, revision, role, decision, cycle_id, checkpoint_id, rule_revision, receipt_id,
        agent_invocation_id, output_sha256, idempotency_key, payload_hash, created_at, contract_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(value.id, value.profileId, value.revision, value.role, value.decision, value.cycleId, value.checkpointId,
      value.ruleRevision, value.receiptId, value.agentInvocationId, value.outputSha256, value.idempotencyKey,
      payloadHash, now, contractGeneration);
    return this.getClosureAssessment(value.id) ?? fail("GROWTH_DATA_INVALID");
  }

  #ensureClosureEvaluationEvent(outcome: GrowthClosureEvaluationOutcome): GrowthEvent {
    const cycle = this.#requiredCycle(outcome.cycleId);
    if (cycle.status !== "evaluated" || !cycle.runId || cycle.receiptId !== outcome.receiptId
      || cycle.changeSetId !== null || cycle.outputCheckpointId !== null || cycle.failureCode !== null) {
      throw growthError("GROWTH_CLOSURE_OUTCOME_REFERENCE_MISMATCH");
    }
    const existing = this.workspace.db.prepare(`
      SELECT * FROM growth_events WHERE cycle_id = ? AND phase = 'cycle_evaluated'
    `).get(cycle.id) as Row | undefined;
    if (existing) {
      const event = mapEvent(existing);
      if (event.goalId !== cycle.goalId || event.runId !== cycle.runId || event.targetKind !== "closure_evaluation"
        || event.targetId !== outcome.id || event.targetVersionId !== null || event.durableState !== "evaluated"
        || event.contentRef !== null) {
        throw growthError("GROWTH_CLOSURE_EVENT_REPLAY_MISMATCH");
      }
      return event;
    }
    const last = this.workspace.db.prepare(`
      SELECT MAX(sequence) AS sequence FROM growth_events WHERE goal_id = ?
    `).get(cycle.goalId) as { sequence: number | null };
    const event = growthEventSchema.parse({
      goalId: cycle.goalId, cycleId: cycle.id, runId: cycle.runId, sequence: (last.sequence ?? 0) + 1,
      safeSummary: "Closure evaluation recorded.", phase: "cycle_evaluated", targetKind: "closure_evaluation",
      targetId: outcome.id, targetVersionId: null, durableState: "evaluated", contentRef: null,
      createdAt: new Date().toISOString(),
    });
    this.workspace.db.prepare(`
      INSERT INTO growth_events (
        goal_id, cycle_id, run_id, sequence, safe_summary, phase, target_kind, target_id,
        target_version_id, durable_state, content_ref_kind, content_ref_id, content_ref_version_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)
    `).run(event.goalId, event.cycleId, event.runId, event.sequence, event.safeSummary, event.phase,
      event.targetKind, event.targetId, event.durableState, event.createdAt);
    return event;
  }

  #assertOcSubject(resourceId: string, checkpointId: string): void {
    const subject = new ResourceRepository(this.workspace).listAtCheckpoint(checkpointId)
      .find((resource) => resource.id === resourceId);
    if (!subject || subject.type !== "oc") throw growthError("GROWTH_CLOSURE_OC_SUBJECT_INVALID");
  }

  #insertClosureFacets(
    profileId: string,
    revision: number,
    facets: ReadonlyArray<{ id: string; kind: "content" | "visual"; required: boolean }>,
  ): void {
    const insert = this.workspace.db.prepare(`
      INSERT INTO growth_closure_facets (profile_id, revision, facet_id, facet_kind, required, ordinal)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    facets.forEach((facet, ordinal) => insert.run(profileId, revision, facet.id, facet.kind, facet.required ? 1 : 0, ordinal));
  }

  #insertClosureComponents(profileId: string, revision: number, components: readonly string[]): void {
    const insert = this.workspace.db.prepare(`
      INSERT INTO growth_closure_profile_components (profile_id, revision, component_profile, ordinal)
      VALUES (?, ?, ?, ?)
    `);
    components.forEach((component, ordinal) => insert.run(profileId, revision, component, ordinal));
  }

  #closureComponents(profileId: string, revision: number): Array<"world_birth" | "oc_saga" | "story_universe"> {
    return (this.workspace.db.prepare(`
      SELECT component_profile FROM growth_closure_profile_components
      WHERE profile_id = ? AND revision = ? ORDER BY ordinal
    `).all(profileId, revision) as Array<{ component_profile: "world_birth" | "oc_saga" | "story_universe" }>)
      .map((row) => row.component_profile);
  }

  #assertIllustrationAnchor(
    anchor: GrowthIllustrationItem["anchor"],
    goalId: string,
    checkpointId: string,
    pendingSnapshots: Map<string, { id: string; kind: "working_text_snapshot" | "conversation_text_snapshot"; text: string; textSha256: string }>,
  ): void {
    if (anchor.kind === "resource") {
      this.#assertVersionVisible("resource_revisions", "resource_id", anchor.resourceId, anchor.resourceVersionId,
        checkpointId, "GROWTH_ILLUSTRATION_ANCHOR_NOT_VISIBLE");
      return;
    }
    if (anchor.kind === "stable_text_span") {
      this.#assertVersionVisible("document_versions", "creative_document_id", anchor.documentId, anchor.documentVersionId,
        checkpointId, "GROWTH_ILLUSTRATION_ANCHOR_NOT_VISIBLE");
      const row = this.workspace.db.prepare("SELECT content FROM document_versions WHERE id = ?").get(anchor.documentVersionId) as Row | undefined;
      if (!row) throw growthError("GROWTH_ILLUSTRATION_ANCHOR_NOT_VISIBLE");
      const codePoints = [...readString(row, "content")];
      if (anchor.endCodePoint > codePoints.length
        || sha256(codePoints.slice(anchor.startCodePoint, anchor.endCodePoint).join("")) !== anchor.textSha256) {
        throw growthError("GROWTH_ILLUSTRATION_TEXT_SPAN_MISMATCH");
      }
      return;
    }
    const pending = pendingSnapshots.get(anchor.sourceSnapshotId);
    if (pending) {
      if (pending.kind !== anchor.kind || pending.textSha256 !== anchor.textSha256) {
        throw growthError("GROWTH_ILLUSTRATION_SNAPSHOT_MISMATCH");
      }
      return;
    }
    const persisted = this.workspace.db.prepare(`
      SELECT goal_id, kind, text_sha256 FROM growth_illustration_text_snapshots WHERE id = ?
    `).get(anchor.sourceSnapshotId) as Row | undefined;
    if (!persisted || readString(persisted, "goal_id") !== goalId || readString(persisted, "kind") !== anchor.kind
      || readString(persisted, "text_sha256") !== anchor.textSha256) {
      throw growthError("GROWTH_ILLUSTRATION_SNAPSHOT_MISMATCH");
    }
  }

  #assertIllustrationSource(source: GrowthIllustrationItem["sources"][number], checkpointId: string): void {
    if (source.kind === "resource") {
      this.#assertVersionVisible("resource_revisions", "resource_id", source.resourceId, source.resourceVersionId,
        checkpointId, "GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
      return;
    }
    this.#assertVersionVisible("document_versions", "creative_document_id", source.documentId, source.documentVersionId,
      checkpointId, "GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
    const row = this.workspace.db.prepare("SELECT content_hash FROM document_versions WHERE id = ?").get(source.documentVersionId) as Row | undefined;
    if (!row || readString(row, "content_hash") !== source.contentSha256) {
      throw growthError("GROWTH_ILLUSTRATION_SOURCE_HASH_MISMATCH");
    }
  }

  #illustrationImageJobSources(sources: GrowthIllustrationItem["sources"]): { resourceIds: string[]; versionIds: string[] } {
    const resourceIds: string[] = [];
    const versionIds: string[] = [];
    for (const source of sources) {
      versionIds.push(source.kind === "resource" ? source.resourceVersionId : source.documentVersionId);
      if (source.kind === "resource") {
        const revision = this.workspace.db.prepare("SELECT resource_id FROM resource_revisions WHERE id = ?")
          .get(source.resourceVersionId) as Row | undefined;
        if (!revision || readString(revision, "resource_id") !== source.resourceId) {
          throw growthError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
        }
        resourceIds.push(source.resourceId);
      } else {
        const version = this.workspace.db.prepare(`
          SELECT resource_id FROM document_versions WHERE id = ? AND creative_document_id = ?
        `).get(source.documentVersionId, source.documentId) as Row | undefined;
        if (!version) throw growthError("GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE");
        resourceIds.push(readString(version, "resource_id"));
      }
    }
    return { resourceIds: normalizeStableIds(resourceIds), versionIds: normalizeStableIds(versionIds) };
  }

  #refreshIllustrationItemFromJob(itemId: string): GrowthIllustrationItem {
    const item = this.getIllustrationItem(itemId);
    if (!item) throw growthError("GROWTH_ILLUSTRATION_ITEM_NOT_FOUND");
    if (!item.imageJobId) throw growthError("GROWTH_ILLUSTRATION_JOB_NOT_BOUND");
    if (item.status === "stale") return item;
    const job = this.workspace.db.prepare("SELECT status FROM image_generation_jobs WHERE id = ?").get(item.imageJobId) as Row | undefined;
    if (!job) throw growthError("GROWTH_ILLUSTRATION_JOB_NOT_FOUND");
    const jobStatus = readString(job, "status");
    let status: GrowthIllustrationItem["status"];
    if (jobStatus === "queued") status = "queued";
    else if (jobStatus === "running") status = "running";
    else if (jobStatus === "failed") status = "failed";
    else if (jobStatus === "reconciliation_required") status = "reconciliation_required";
    else {
      const asset = this.workspace.db.prepare("SELECT status FROM image_assets WHERE job_id = ?").get(item.imageJobId) as Row | undefined;
      status = !asset ? "reconciliation_required" : readString(asset, "status") === "ready" ? "ready" : "stale";
    }
    const now = new Date().toISOString();
    this.workspace.db.prepare("UPDATE growth_illustration_items SET status = ?, updated_at = ? WHERE id = ?").run(status, now, item.id);
    this.#syncIllustrationAggregates(item.requestId, now);
    return this.getIllustrationItem(item.id) ?? fail("GROWTH_DATA_INVALID");
  }

  #syncIllustrationAggregates(requestId: string, now: string): void {
    const batches = this.workspace.db.prepare(`
      SELECT id FROM growth_illustration_request_batches WHERE request_id = ?
    `).all(requestId) as Array<{ id: string }>;
    for (const batch of batches) {
      const statuses = (this.workspace.db.prepare("SELECT status FROM growth_illustration_items WHERE batch_id = ?")
        .all(batch.id) as Array<{ status: string }>).map((row) => row.status);
      this.workspace.db.prepare("UPDATE growth_illustration_request_batches SET status = ? WHERE id = ?")
        .run(deriveIllustrationAggregateStatus(statuses), batch.id);
    }
    const statuses = (this.workspace.db.prepare("SELECT status FROM growth_illustration_items WHERE request_id = ?")
      .all(requestId) as Array<{ status: string }>).map((row) => row.status);
    this.workspace.db.prepare("UPDATE growth_illustration_requests SET status = ?, updated_at = ? WHERE id = ?")
      .run(deriveIllustrationAggregateStatus(statuses), now, requestId);
  }

  #requiredGoal(goalId: string): GrowthGoal {
    return this.getGoal(goalId) ?? fail("GROWTH_GOAL_NOT_FOUND");
  }

  #requiredCycle(cycleId: string): GrowthCycle {
    return this.getCycle(cycleId) ?? fail("GROWTH_CYCLE_NOT_FOUND");
  }

  #hasOpenCycle(goalId: string): boolean {
    return Boolean(this.workspace.db.prepare("SELECT 1 FROM growth_cycles WHERE goal_id = ? AND status IN ('planned', 'running')").get(goalId));
  }

  #goalScopes(goalId: string): string[] {
    return (this.workspace.db.prepare("SELECT resource_id FROM growth_goal_scopes WHERE goal_id = ? ORDER BY ordinal").all(goalId) as Array<{ resource_id: string }>)
      .map((row) => row.resource_id);
  }

  #getBranchHead(branchId: string): string {
    const row = this.workspace.db.prepare("SELECT head_checkpoint_id FROM branches WHERE id = ?").get(branchId) as { head_checkpoint_id: string | null } | undefined;
    if (!row?.head_checkpoint_id) throw growthError("GROWTH_BRANCH_NOT_FOUND");
    return row.head_checkpoint_id;
  }

  #assertCheckpointBranch(checkpointId: string, branchId: string): void {
    if (!this.workspace.db.prepare("SELECT 1 FROM checkpoints WHERE id = ? AND branch_id = ?").get(checkpointId, branchId)) {
      throw growthError("GROWTH_CHECKPOINT_BRANCH_MISMATCH");
    }
  }

  #assertScopesVisible(scopeIds: readonly string[], checkpointId: string): void {
    const visible = new Set(new ResourceRepository(this.workspace).listAtCheckpoint(checkpointId).map((resource) => resource.id));
    if (scopeIds.some((scopeId) => !visible.has(scopeId))) throw growthError("GROWTH_SCOPE_NOT_VISIBLE_AT_CHECKPOINT");
  }

  #assertSeedVisible(seed: GrowthGoalCreate["seed"], checkpointId: string): void {
    if (seed.kind === "text") return;
    if (seed.kind === "resource") {
      this.#assertScopesVisible([seed.resourceId], checkpointId);
      if (seed.resourceVersionId) this.#assertVersionVisible("resource_revisions", "resource_id", seed.resourceId, seed.resourceVersionId, checkpointId, "GROWTH_SEED_REFERENCE_INVALID");
      return;
    }
    this.#assertVersionVisible("document_versions", "creative_document_id", seed.sourceDocumentId, seed.sourceVersionId, checkpointId, "GROWTH_SEED_REFERENCE_INVALID");
  }

  #assertReceiptLinkVisible(link: GrowthRetrievalReceiptCreate["links"][number], checkpointId: string, branchId: string): void {
    if (link.targetKind === "change_set") {
      this.#assertChangeSetVisible(link.targetId, link.targetVersionId, checkpointId, branchId, "GROWTH_RECEIPT_LINK_NOT_VISIBLE");
    } else {
      const definition = link.targetKind === "resource"
        ? ["resource_revisions", "resource_id"] as const
        : link.targetKind === "document"
          ? ["document_versions", "creative_document_id"] as const
          : link.targetKind === "assertion"
            ? ["assertion_versions", "assertion_id"] as const
            : ["creative_relation_versions", "relation_id"] as const;
      this.#assertVersionVisible(definition[0], definition[1], link.targetId, link.targetVersionId, checkpointId, "GROWTH_RECEIPT_LINK_NOT_VISIBLE");
    }
    if (link.stableLocator !== null) this.#assertStableLocator(link.stableVersionId!, link.stableHash!, checkpointId);
  }

  #assertStableLocator(versionId: string, contentHash: string, checkpointId: string): void {
    const row = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id) AS (
        SELECT ?
        UNION ALL
        SELECT checkpoints.parent_checkpoint_id FROM checkpoints JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
        WHERE checkpoints.parent_checkpoint_id IS NOT NULL
      )
      SELECT document_versions.content_hash FROM document_versions JOIN ancestry ON ancestry.checkpoint_id = document_versions.created_checkpoint_id
      WHERE document_versions.id = ?
    `).get(checkpointId, versionId) as Row | undefined;
    if (!row || readString(row, "content_hash") !== contentHash) throw growthError("GROWTH_RECEIPT_LOCATOR_INVALID");
  }

  #assertEventTargetVisible(kind: "resource" | "document" | "assertion" | "relation" | "change_set", targetId: string, targetVersionId: string | null, phase: string, cycle: GrowthCycle, branchId: string): void {
    const checkpointId = cycle.status === "committed" ? cycle.outputCheckpointId : cycle.inputCheckpointId;
    if (!checkpointId) throw growthError("GROWTH_EVENT_TARGET_NOT_VISIBLE");
    this.#assertCheckpointBranch(checkpointId, branchId);
    if (kind === "change_set") {
      if (phase !== "change_set_committed" || targetVersionId === null) throw growthError("GROWTH_EVENT_TARGET_NOT_VISIBLE");
      return;
    }
    if (kind === "resource" && targetVersionId === null) {
      const visible = new ResourceRepository(this.workspace).listAtCheckpoint(checkpointId).some((resource) => resource.id === targetId);
      if (!visible) throw growthError("GROWTH_EVENT_TARGET_NOT_VISIBLE");
      return;
    }
    if (targetVersionId === null) throw growthError("GROWTH_EVENT_TARGET_NOT_VISIBLE");
    const definition = kind === "resource"
      ? ["resource_revisions", "resource_id"] as const
      : kind === "document"
        ? ["document_versions", "creative_document_id"] as const
        : kind === "assertion"
          ? ["assertion_versions", "assertion_id"] as const
          : ["creative_relation_versions", "relation_id"] as const;
    this.#assertVersionVisible(definition[0], definition[1], targetId, targetVersionId, checkpointId, "GROWTH_EVENT_TARGET_NOT_VISIBLE");
  }

  #assertContentRefVisible(kind: "resource" | "document" | "assertion" | "relation" | "change_set", targetId: string, targetVersionId: string, cycle: GrowthCycle, branchId: string): void {
    const checkpointId = cycle.status === "committed" ? cycle.outputCheckpointId : cycle.inputCheckpointId;
    if (!checkpointId) throw growthError("GROWTH_CONTENT_REFERENCE_NOT_VISIBLE");
    this.#assertCheckpointBranch(checkpointId, branchId);
    if (kind === "change_set") {
      this.#assertChangeSetVisible(targetId, targetVersionId, checkpointId, branchId, "GROWTH_CONTENT_REFERENCE_NOT_VISIBLE");
      return;
    }
    const definition = kind === "resource"
      ? ["resource_revisions", "resource_id"] as const
      : kind === "document"
        ? ["document_versions", "creative_document_id"] as const
        : kind === "assertion"
          ? ["assertion_versions", "assertion_id"] as const
          : ["creative_relation_versions", "relation_id"] as const;
    this.#assertVersionVisible(definition[0], definition[1], targetId, targetVersionId, checkpointId, "GROWTH_CONTENT_REFERENCE_NOT_VISIBLE");
  }

  #assertChangeSetVisible(changeSetId: string, checkpointId: string, pinnedCheckpointId: string, branchId: string, code: string): void {
    const changeSet = this.workspace.db.prepare("SELECT branch_id, committed_checkpoint_id, status FROM change_sets WHERE id = ?").get(changeSetId) as Row | undefined;
    if (!changeSet || readString(changeSet, "status") !== "committed" || readString(changeSet, "branch_id") !== branchId || readNullableString(changeSet, "committed_checkpoint_id") !== checkpointId || !this.#checkpointIsVisible(checkpointId, pinnedCheckpointId)) {
      throw growthError(code);
    }
  }

  #assertVersionVisible(table: "resource_revisions" | "document_versions" | "assertion_versions" | "creative_relation_versions", ownerColumn: "resource_id" | "creative_document_id" | "assertion_id" | "relation_id", targetId: string, versionId: string, checkpointId: string, code: string): void {
    const valid = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id) AS (
        SELECT ?
        UNION ALL
        SELECT checkpoints.parent_checkpoint_id FROM checkpoints JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
        WHERE checkpoints.parent_checkpoint_id IS NOT NULL
      )
      SELECT 1 FROM ${table} versions JOIN ancestry ON ancestry.checkpoint_id = versions.created_checkpoint_id
      WHERE versions.id = ? AND versions.${ownerColumn} = ?
    `).get(checkpointId, versionId, targetId);
    if (!valid) throw growthError(code);
  }

  #checkpointIsVisible(candidateCheckpointId: string, checkpointId: string): boolean {
    return Boolean(this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id) AS (
        SELECT ?
        UNION ALL
        SELECT checkpoints.parent_checkpoint_id FROM checkpoints JOIN ancestry ON checkpoints.id = ancestry.checkpoint_id
        WHERE checkpoints.parent_checkpoint_id IS NOT NULL
      ) SELECT 1 FROM ancestry WHERE checkpoint_id = ?
    `).get(checkpointId, candidateCheckpointId));
  }
}

const legacyCycleIntentMapping: Record<number, { focusKinds: Array<"world" | "story" | "oc">; resumeFrontier: Array<"world" | "story" | "oc"> }> = {
  1: { focusKinds: ["world"], resumeFrontier: ["story", "oc"] },
  2: { focusKinds: ["story"], resumeFrontier: ["oc"] },
  3: { focusKinds: ["oc"], resumeFrontier: [] },
};

function legacyCycleIntent(cycle: GrowthCycle): GrowthCycleIntent {
  const intent = legacyCycleIntentMapping[cycle.sequence];
  if (!intent) throw growthError("GROWTH_LEGACY_INTENT_UNMAPPABLE");
  return growthCycleIntentSchema.parse({
    cycleId: cycle.id, kind: "expand", ...intent, provenance: "legacy_v23_projection",
  });
}

function mapClosureProfile(
  row: Row,
  componentProfiles: Array<"world_birth" | "oc_saga" | "story_universe"> | null,
): GrowthClosureProfile {
  const contractGeneration = readString(row, "contract_generation");
  return growthClosureProfileSchema.parse({
    id: readString(row, "id"), goalId: readString(row, "goal_id"), profileKind: readString(row, "profile_kind"),
    subjectResourceId: readNullableString(row, "subject_resource_id"), currentRevision: readNumber(row, "current_revision"),
    currentEpoch: readNumber(row, "current_epoch"), contractGeneration,
    componentProfiles,
    focusOcResourceId: contractGeneration === "v26" ? readNullableString(row, "focus_oc_resource_id") : null,
    createdAt: readString(row, "created_at"), updatedAt: readString(row, "updated_at"),
  });
}

function mapClosureAssessment(row: Row): GrowthClosureAssessment {
  return growthClosureAssessmentSchema.parse({
    id: readString(row, "id"), profileId: readString(row, "profile_id"), revision: readNumber(row, "revision"),
    role: readString(row, "role"), decision: readString(row, "decision"), cycleId: readString(row, "cycle_id"),
    checkpointId: readString(row, "checkpoint_id"), ruleRevision: readNumber(row, "rule_revision"),
    receiptId: readString(row, "receipt_id"), agentInvocationId: readString(row, "agent_invocation_id"),
    outputSha256: readString(row, "output_sha256"), idempotencyKey: readString(row, "idempotency_key"),
    payloadHash: readString(row, "payload_hash"), createdAt: readString(row, "created_at"),
  });
}

function readIllustrationAnchor(row: Row): GrowthIllustrationItem["anchor"] {
  const kind = readString(row, "anchor_kind");
  if (kind === "resource") return {
    kind, resourceId: readString(row, "anchor_resource_id"), resourceVersionId: readString(row, "anchor_resource_version_id"),
  };
  if (kind === "stable_text_span") return {
    kind, documentId: readString(row, "anchor_document_id"), documentVersionId: readString(row, "anchor_document_version_id"),
    startCodePoint: readNumber(row, "start_code_point"), endCodePoint: readNumber(row, "end_code_point"),
    textSha256: readString(row, "text_sha256"),
  };
  if (kind === "working_text_snapshot" || kind === "conversation_text_snapshot") return {
    kind, sourceSnapshotId: readString(row, "source_snapshot_id"), textSha256: readString(row, "text_sha256"),
  };
  throw growthError("GROWTH_DATA_INVALID");
}

function readIllustrationSource(row: Row): GrowthIllustrationItem["sources"][number] {
  const kind = readString(row, "source_kind");
  if (kind === "resource") return {
    kind, resourceId: readString(row, "resource_id"), resourceVersionId: readString(row, "resource_version_id"),
  };
  if (kind === "document") return {
    kind, documentId: readString(row, "document_id"), documentVersionId: readString(row, "document_version_id"),
    contentSha256: readString(row, "content_sha256"),
  };
  throw growthError("GROWTH_DATA_INVALID");
}

function illustrationAnchorColumns(anchor: GrowthIllustrationItem["anchor"]): {
  kind: string; resourceId: string | null; resourceVersionId: string | null; documentId: string | null;
  documentVersionId: string | null; startCodePoint: number | null; endCodePoint: number | null;
  sourceSnapshotId: string | null; textSha256: string | null;
} {
  if (anchor.kind === "resource") return {
    kind: anchor.kind, resourceId: anchor.resourceId, resourceVersionId: anchor.resourceVersionId,
    documentId: null, documentVersionId: null, startCodePoint: null, endCodePoint: null, sourceSnapshotId: null, textSha256: null,
  };
  if (anchor.kind === "stable_text_span") return {
    kind: anchor.kind, resourceId: null, resourceVersionId: null, documentId: anchor.documentId,
    documentVersionId: anchor.documentVersionId, startCodePoint: anchor.startCodePoint, endCodePoint: anchor.endCodePoint,
    sourceSnapshotId: null, textSha256: anchor.textSha256,
  };
  return {
    kind: anchor.kind, resourceId: null, resourceVersionId: null, documentId: null, documentVersionId: null,
    startCodePoint: null, endCodePoint: null, sourceSnapshotId: anchor.sourceSnapshotId, textSha256: anchor.textSha256,
  };
}

function illustrationSourceColumns(source: GrowthIllustrationItem["sources"][number]): {
  kind: string; resourceId: string | null; resourceVersionId: string | null; documentId: string | null;
  documentVersionId: string | null; contentSha256: string | null;
} {
  return source.kind === "resource"
    ? { kind: source.kind, resourceId: source.resourceId, resourceVersionId: source.resourceVersionId, documentId: null, documentVersionId: null, contentSha256: null }
    : { kind: source.kind, resourceId: null, resourceVersionId: null, documentId: source.documentId, documentVersionId: source.documentVersionId, contentSha256: source.contentSha256 };
}

function normalizeIllustrationSourceSet(sources: GrowthIllustrationItem["sources"]): GrowthIllustrationItem["sources"] {
  return [...sources].sort((left, right) => compareStrings(illustrationSourceIdentity(left), illustrationSourceIdentity(right)));
}

function illustrationSourceIdentity(source: GrowthIllustrationItem["sources"][number]): string {
  return source.kind === "resource"
    ? `resource\u0000${source.resourceId}\u0000${source.resourceVersionId}`
    : `document\u0000${source.documentId}\u0000${source.documentVersionId}`;
}

function parseNormalizedImageJobSourceIds(value: unknown): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw growthError("GROWTH_ILLUSTRATION_JOB_SOURCE_MALFORMED");
  }
  if (!Array.isArray(parsed) || parsed.length === 0
    || parsed.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.trim() !== entry)
    || new Set(parsed).size !== parsed.length) {
    throw growthError("GROWTH_ILLUSTRATION_JOB_SOURCE_MALFORMED");
  }
  return normalizeStableIds(parsed as string[]);
}

function normalizeStableIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deriveIllustrationAggregateStatus(statuses: readonly string[]): "planned" | "running" | "completed" | "failed" | "cancelled" | "stale" | "reconciliation_required" {
  if (statuses.length === 0) return "planned";
  if (statuses.includes("reconciliation_required")) return "reconciliation_required";
  if (statuses.includes("stale")) return "stale";
  if (statuses.some((status) => ["queued", "running"].includes(status))) return "running";
  if (statuses.includes("failed")) return "failed";
  if (statuses.every((status) => status === "ready")) return "completed";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  return "planned";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readErrorCode(value: unknown): string | null {
  return value && typeof value === "object" && "code" in value && typeof value.code === "string"
    ? value.code
    : null;
}

function receiptOutput(value: GrowthRetrievalReceiptCreate, createdAt: string): GrowthRetrievalReceipt {
  const links = [...value.links].sort((left, right) => left.rank - right.rank);
  const queryHash = canonicalAuditHash({
    branchId: value.branchId, checkpointId: value.checkpointId, lens: value.lens, effectiveScopeResourceIds: value.effectiveScopeResourceIds,
    query: value.query, aliases: value.aliases, validTime: value.validTime, recordedTime: value.recordedTime, maxHops: value.maxHops,
    cpuBudgetMs: value.cpuBudgetMs, expansionBudget: value.expansionBudget, resultBudget: value.resultBudget, tokenBudget: value.tokenBudget,
    policyVersion: value.policyVersion,
  });
  const resultHash = canonicalAuditHash({ coverage: value.coverage, truncated: value.truncated, links });
  return growthRetrievalReceiptSchema.parse({
    ...value, links, queryHash, resultHash, hitCount: links.length,
    conflictCount: links.filter((link) => link.reasonCodes.includes("conflict")).length,
    locatorCount: links.filter((link) => link.stableLocator !== null).length,
    createdAt,
  });
}

function receiptInputFromOutput(value: GrowthRetrievalReceipt): GrowthRetrievalReceiptCreate {
  const { queryHash: _queryHash, resultHash: _resultHash, hitCount: _hitCount, conflictCount: _conflictCount, locatorCount: _locatorCount, createdAt: _createdAt, ...input } = value;
  return growthRetrievalReceiptCreateSchema.parse(input);
}

function eventInputFromOutput(value: GrowthEvent): GrowthEventAppend {
  const { createdAt: _createdAt, ...input } = value;
  return growthEventAppendSchema.parse(input);
}

function assessmentInputFromOutput(value: GrowthClosureAssessment): ClosureAssessmentRowInput {
  return {
    id: value.id, profileId: value.profileId, revision: value.revision, role: value.role,
    decision: value.decision, cycleId: value.cycleId, checkpointId: value.checkpointId,
    ruleRevision: value.ruleRevision, receiptId: value.receiptId, agentInvocationId: value.agentInvocationId,
    outputSha256: value.outputSha256, idempotencyKey: value.idempotencyKey,
  };
}

function mapCycle(row: Row): GrowthCycle {
  return growthCycleSchema.parse({
    id: readString(row, "id"), goalId: readString(row, "goal_id"), sequence: readNumber(row, "sequence"),
    idempotencyKey: readString(row, "idempotency_key"), inputCheckpointId: readString(row, "input_checkpoint_id"), ruleRevision: readNumber(row, "rule_revision"),
    runId: readNullableString(row, "run_id"), receiptId: readNullableString(row, "receipt_id"), changeSetId: readNullableString(row, "change_set_id"),
    outputCheckpointId: readNullableString(row, "output_checkpoint_id"), status: readString(row, "status"), failureCode: readNullableString(row, "failure_code"),
    createdAt: readString(row, "created_at"), updatedAt: readString(row, "updated_at"), terminalAt: readNullableString(row, "terminal_at"),
  });
}

function mapRuleRevision(row: Row): GrowthRuleRevision {
  return growthRuleRevisionSchema.parse({
    goalId: readString(row, "goal_id"), revision: readNumber(row, "revision"), ruleText: readString(row, "rule_text"),
    sourceMessageId: readNullableString(row, "source_message_id"), createdAt: readString(row, "created_at"),
  });
}

function mapInquiryLifecycle(row: Row): GrowthInquiryLifecycle {
  return growthInquiryLifecycleSchema.parse({
    inquiryId: readString(row, "inquiry_id"), sequence: readNumber(row, "sequence"),
    phase: readString(row, "phase"), idempotencyKey: readString(row, "idempotency_key"),
    payloadHash: readString(row, "payload_hash"), sourceCycleId: readString(row, "source_cycle_id"),
    sourceReceiptId: readString(row, "source_receipt_id"), sourceCheckpointId: readString(row, "source_checkpoint_id"),
    sourceRuleRevision: readNumber(row, "source_rule_revision"),
    successorInquiryId: readNullableString(row, "successor_inquiry_id"),
    answerRuleRevision: readNullableNumber(row, "answer_rule_revision"), closeReason: readNullableString(row, "close_reason"),
    createdAt: readString(row, "created_at"),
  });
}

function mapInquiryCreatorAnswer(row: Row): GrowthInquiryCreatorAnswer {
  return growthInquiryCreatorAnswerSchema.parse({
    inquiryId: readString(row, "inquiry_id"), goalId: readString(row, "goal_id"),
    ruleRevision: readNumber(row, "rule_revision"), idempotencyKey: readString(row, "idempotency_key"),
    payloadHash: readString(row, "payload_hash"), answerText: readString(row, "answer_text"),
    sourceMessageId: readNullableString(row, "source_message_id"), checkpointId: readString(row, "checkpoint_id"),
    receiptId: readString(row, "receipt_id"), createdAt: readString(row, "created_at"),
  });
}

function mapEvent(row: Row): GrowthEvent {
  const contentRefKind = readNullableString(row, "content_ref_kind");
  return growthEventSchema.parse({
    goalId: readString(row, "goal_id"), cycleId: readString(row, "cycle_id"), runId: readNullableString(row, "run_id"), sequence: readNumber(row, "sequence"),
    safeSummary: readString(row, "safe_summary"), phase: readString(row, "phase"), targetKind: readString(row, "target_kind"),
    targetId: readString(row, "target_id"), targetVersionId: readNullableString(row, "target_version_id"), durableState: readString(row, "durable_state"),
    contentRef: contentRefKind === null ? null : { kind: contentRefKind, targetId: readString(row, "content_ref_id"), targetVersionId: readString(row, "content_ref_version_id") },
    createdAt: readString(row, "created_at"),
  });
}

function readSeed(row: Row): GrowthGoal["seed"] {
  const kind = readString(row, "seed_kind");
  if (kind === "text") return { kind, text: readString(row, "seed_text") };
  if (kind === "source_document") return { kind, sourceDocumentId: readString(row, "seed_source_document_id"), sourceVersionId: readString(row, "seed_source_version_id") };
  if (kind === "resource") return { kind, resourceId: readString(row, "seed_resource_id"), resourceVersionId: readNullableString(row, "seed_resource_version_id") };
  throw growthError("GROWTH_DATA_INVALID");
}

function seedColumns(seed: GrowthGoalCreate["seed"]): { kind: string; text: string | null; sourceDocumentId: string | null; sourceVersionId: string | null; resourceId: string | null; resourceVersionId: string | null } {
  if (seed.kind === "text") return { kind: seed.kind, text: seed.text, sourceDocumentId: null, sourceVersionId: null, resourceId: null, resourceVersionId: null };
  if (seed.kind === "source_document") return { kind: seed.kind, text: null, sourceDocumentId: seed.sourceDocumentId, sourceVersionId: seed.sourceVersionId, resourceId: null, resourceVersionId: null };
  return { kind: seed.kind, text: null, sourceDocumentId: null, sourceVersionId: null, resourceId: seed.resourceId, resourceVersionId: seed.resourceVersionId };
}

function timeRange(row: Row, fromKey: string, toKey: string): { from: string | null; to: string | null } | null {
  const from = readNullableString(row, fromKey);
  const to = readNullableString(row, toKey);
  return from === null && to === null ? null : { from, to };
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("invalid array");
    return parsed;
  } catch {
    throw growthError("GROWTH_DATA_INVALID");
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw growthError("GROWTH_DATA_INVALID");
  return value;
}

function readNullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw growthError("GROWTH_DATA_INVALID");
  return value;
}

function readNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw growthError("GROWTH_DATA_INVALID");
  return value;
}

function readNullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number") throw growthError("GROWTH_DATA_INVALID");
  return value;
}

function growthError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function fail(code: string): never {
  throw growthError(code);
}
