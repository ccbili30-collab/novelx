import type { SQLOutputValue } from "node:sqlite";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { ResourceRepository } from "../workspace/resourceRepository";
import {
  growthCycleAttachChangeSetSchema,
  growthCycleAttachRunSchema,
  growthCycleBeginSchema,
  growthCycleSchema,
  growthCycleTerminalizeSchema,
  growthEventAppendSchema,
  growthEventSchema,
  growthGoalCreateSchema,
  growthGoalSchema,
  growthRetrievalReceiptCreateSchema,
  growthRetrievalReceiptSchema,
  growthRuleAppendSchema,
  growthRuleRevisionSchema,
  type GrowthCycle,
  type GrowthEvent,
  type GrowthEventAppend,
  type GrowthGoal,
  type GrowthGoalCreate,
  type GrowthRetrievalReceipt,
  type GrowthRetrievalReceiptCreate,
  type GrowthRuleRevision,
} from "../../shared/growthContract";

type Row = Record<string, SQLOutputValue>;

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

  getCycle(cycleId: string): GrowthCycle | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_cycles WHERE id = ?").get(cycleId) as Row | undefined;
    return row ? mapCycle(row) : null;
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

  appendRule(input: unknown): GrowthRuleRevision {
    const value = growthRuleAppendSchema.parse(input);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const goal = this.#requiredGoal(value.goalId);
      if (goal.currentRuleRevision !== value.expectedRevision) {
        const replay = value.expectedRevision === goal.currentRuleRevision - 1
          ? this.workspace.db.prepare("SELECT * FROM growth_goal_rule_revisions WHERE goal_id = ? AND revision = ?").get(value.goalId, goal.currentRuleRevision) as Row | undefined
          : undefined;
        if (replay && readString(replay, "rule_text") === value.ruleText && readNullableString(replay, "source_message_id") === value.sourceMessageId) {
          this.workspace.db.exec("COMMIT");
          return mapRuleRevision(replay);
        }
        throw growthError("GROWTH_RULE_REVISION_MISMATCH");
      }
      if (goal.status !== "active") throw growthError("GROWTH_GOAL_NOT_ACTIVE");
      if (this.#hasOpenCycle(value.goalId)) throw growthError("GROWTH_RULE_CHANGE_REQUIRES_CYCLE_BOUNDARY");
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
      const expectedInput = previous ? readNullableString(previous, "output_checkpoint_id") : this.#getBranchHead(goal.branchId);
      if (!expectedInput || value.inputCheckpointId !== expectedInput || value.inputCheckpointId !== this.#getBranchHead(goal.branchId)) {
        throw growthError("GROWTH_CYCLE_INPUT_CHECKPOINT_MISMATCH");
      }
      this.#assertCheckpointBranch(value.inputCheckpointId, goal.branchId);
      const sequence = goal.currentCycleSequence + 1;
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_cycles (
          id, goal_id, sequence, idempotency_key, payload_hash, input_checkpoint_id, rule_revision,
          run_id, receipt_id, change_set_id, output_checkpoint_id, status, failure_code, created_at, updated_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'planned', NULL, ?, ?, NULL)
      `).run(value.id, value.goalId, sequence, value.idempotencyKey, payloadHash, value.inputCheckpointId, value.ruleRevision, now, now);
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
      if (cycle.status !== "planned" && cycle.status !== "running") throw growthError("GROWTH_CYCLE_ALREADY_TERMINAL");
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
      if (value.contentRef) this.#assertContentRefVisible(value.contentRef.kind, value.contentRef.targetId, value.contentRef.targetVersionId, cycle, this.#requiredGoal(value.goalId).branchId);
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

  #assertContentRefVisible(kind: "resource" | "document" | "assertion" | "relation" | "change_set", targetId: string, targetVersionId: string, cycle: GrowthCycle, branchId: string): void {
    const checkpointId = cycle.status === "committed" ? cycle.outputCheckpointId : cycle.inputCheckpointId;
    if (!checkpointId) throw growthError("GROWTH_CONTENT_REFERENCE_NOT_VISIBLE");
    this.#assertCheckpointBranch(checkpointId, branchId);
    if (kind === "change_set") {
      const changeSet = this.workspace.db.prepare("SELECT branch_id, committed_checkpoint_id, status FROM change_sets WHERE id = ?").get(targetId) as Row | undefined;
      if (!changeSet || readString(changeSet, "status") !== "committed" || readString(changeSet, "branch_id") !== branchId || readNullableString(changeSet, "committed_checkpoint_id") !== targetVersionId || !this.#checkpointIsVisible(targetVersionId, checkpointId)) {
        throw growthError("GROWTH_CONTENT_REFERENCE_NOT_VISIBLE");
      }
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

function growthError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function fail(code: string): never {
  throw growthError(code);
}
