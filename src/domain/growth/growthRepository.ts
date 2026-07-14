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
  growthEventSchema,
  growthGoalCreateSchema,
  growthGoalSchema,
  growthRetrievalReceiptSchema,
  growthRuleAppendSchema,
  growthRuleRevisionSchema,
  type GrowthCycle,
  type GrowthEvent,
  type GrowthGoal,
  type GrowthGoalCreate,
  type GrowthRetrievalReceipt,
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
      if (this.workspace.db.prepare("SELECT 1 FROM growth_goals WHERE id = ?").get(value.id)) {
        throw growthError("GROWTH_GOAL_ID_CONFLICT");
      }
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
    const scopes = this.workspace.db.prepare("SELECT resource_id FROM growth_goal_scopes WHERE goal_id = ? ORDER BY ordinal")
      .all(goalId) as Array<{ resource_id: string }>;
    return growthGoalSchema.parse({
      id: readString(row, "id"), branchId: readString(row, "branch_id"), seed: readSeed(row),
      authorizedScopeResourceIds: scopes.map((scope) => scope.resource_id), status: readString(row, "status"),
      currentRuleRevision: readNumber(row, "current_rule_revision"), currentCycleSequence: readNumber(row, "current_cycle_sequence"),
      createdAt: readString(row, "created_at"), updatedAt: readString(row, "updated_at"),
    });
  }

  getCycle(cycleId: string): GrowthCycle | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_cycles WHERE id = ?").get(cycleId) as Row | undefined;
    return row ? mapCycle(row) : null;
  }

  appendRule(input: unknown): GrowthRuleRevision {
    const value = growthRuleAppendSchema.parse(input);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const goal = this.#requiredGoal(value.goalId);
      if (goal.status !== "active") throw growthError("GROWTH_GOAL_NOT_ACTIVE");
      if (goal.currentRuleRevision !== value.expectedRevision) throw growthError("GROWTH_RULE_REVISION_MISMATCH");
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
      const previous = this.workspace.db.prepare("SELECT * FROM growth_cycles WHERE goal_id = ? ORDER BY sequence DESC LIMIT 1")
        .get(goal.id) as Row | undefined;
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
      this.workspace.db.prepare("UPDATE growth_goals SET current_cycle_sequence = ?, updated_at = ? WHERE id = ?")
        .run(sequence, now, value.goalId);
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
      if (cycle.status !== "planned" || cycle.runId) throw growthError("GROWTH_RUN_ALREADY_BOUND");
      const goal = this.#requiredGoal(cycle.goalId);
      const run = this.workspace.db.prepare("SELECT branch_id, base_checkpoint_id FROM agent_runs WHERE id = ?").get(value.runId) as Row | undefined;
      if (!run || readString(run, "branch_id") !== goal.branchId || readString(run, "base_checkpoint_id") !== cycle.inputCheckpointId) {
        throw growthError("GROWTH_RUN_REFERENCE_MISMATCH");
      }
      const now = new Date().toISOString();
      this.workspace.db.prepare("UPDATE growth_cycles SET run_id = ?, status = 'running', updated_at = ? WHERE id = ?")
        .run(value.runId, now, value.cycleId);
      this.workspace.db.exec("COMMIT");
      return this.getCycle(value.cycleId) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordReceipt(input: unknown): GrowthRetrievalReceipt {
    const value = growthRetrievalReceiptSchema.parse(input);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
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
      if (this.workspace.db.prepare("SELECT 1 FROM growth_retrieval_receipts WHERE id = ?").get(value.id)) throw growthError("GROWTH_RECEIPT_ID_CONFLICT");
      this.workspace.db.prepare(`
        INSERT INTO growth_retrieval_receipts (
          id, cycle_id, run_id, tool_invocation_id, branch_id, checkpoint_id, lens, query_text,
          valid_time_from, valid_time_to, recorded_time_from, recorded_time_to, max_hops, cpu_budget_ms,
          expansion_budget, result_budget, token_budget, policy_version, query_hash, result_hash, hit_count,
          conflict_count, locator_count, coverage_state, coverage_searched_scope_count, coverage_omitted_count,
          truncated, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'creator', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(value.id, value.cycleId, value.runId, value.toolInvocationId, value.branchId, value.checkpointId, value.query,
        value.validTime?.from ?? null, value.validTime?.to ?? null, value.recordedTime?.from ?? null, value.recordedTime?.to ?? null,
        value.maxHops, value.cpuBudgetMs, value.expansionBudget, value.resultBudget, value.tokenBudget, value.policyVersion,
        value.queryHash, value.resultHash, value.hitCount, value.conflictCount, value.locatorCount, value.coverage.state,
        value.coverage.searchedScopeCount, value.coverage.omittedCount, value.truncated ? 1 : 0, value.createdAt);
      const insertScope = this.workspace.db.prepare("INSERT INTO growth_retrieval_receipt_scopes (receipt_id, resource_id, ordinal) VALUES (?, ?, ?)");
      value.effectiveScopeResourceIds.forEach((resourceId, ordinal) => insertScope.run(value.id, resourceId, ordinal));
      const insertAlias = this.workspace.db.prepare("INSERT INTO growth_retrieval_receipt_aliases (receipt_id, alias, ordinal) VALUES (?, ?, ?)");
      value.aliases.forEach((alias, ordinal) => insertAlias.run(value.id, alias, ordinal));
      const insertLink = this.workspace.db.prepare(`
        INSERT INTO growth_retrieval_receipt_links (
          receipt_id, rank, target_kind, target_id, target_version_id, score, reason_codes_json,
          path_target_ids_json, stable_locator, stable_version_id, stable_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      value.links.forEach((link) => insertLink.run(value.id, link.rank, link.targetKind, link.targetId, link.targetVersionId,
        link.score, JSON.stringify(link.reasonCodes), JSON.stringify(link.pathTargetIds), link.stableLocator, link.stableVersionId, link.stableHash));
      this.workspace.db.prepare("UPDATE growth_cycles SET receipt_id = ?, updated_at = ? WHERE id = ?")
        .run(value.id, new Date().toISOString(), value.cycleId);
      this.workspace.db.exec("COMMIT");
      return value;
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
      if (cycle.status !== "running" || !cycle.runId || !cycle.receiptId || cycle.changeSetId) throw growthError("GROWTH_CHANGE_SET_BINDING_INVALID");
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
      this.workspace.db.prepare(`
        UPDATE growth_cycles SET status = ?, failure_code = ?, updated_at = ?, terminal_at = ? WHERE id = ?
      `).run(value.status, value.failureCode, now, now, value.cycleId);
      const goalStatus = value.status === "cancelled" ? "cancelled" : value.status === "reconciliation_required" ? "reconciliation_required" : "blocked";
      this.workspace.db.prepare("UPDATE growth_goals SET status = ?, updated_at = ? WHERE id = ?")
        .run(goalStatus, now, cycle.goalId);
      this.workspace.db.exec("COMMIT");
      return this.getCycle(value.cycleId) ?? fail("GROWTH_DATA_INVALID");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendEvent(input: unknown): GrowthEvent {
    const value = growthEventSchema.parse(input);
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const cycle = this.#requiredCycle(value.cycleId);
      if (cycle.goalId !== value.goalId || cycle.runId !== value.runId || cycle.status !== value.durableState) {
        throw growthError("GROWTH_EVENT_REFERENCE_MISMATCH");
      }
      if (value.contentRef) this.#assertStableContentRef(value.contentRef.kind, value.contentRef.targetId, value.contentRef.targetVersionId);
      const last = this.workspace.db.prepare("SELECT MAX(sequence) AS sequence FROM growth_events WHERE goal_id = ?")
        .get(value.goalId) as { sequence: number | null };
      if (value.sequence !== (last.sequence ?? 0) + 1) throw growthError("GROWTH_EVENT_SEQUENCE_INVALID");
      this.workspace.db.prepare(`
        INSERT INTO growth_events (
          goal_id, cycle_id, run_id, sequence, safe_summary, phase, target_kind, target_id, target_version_id,
          durable_state, content_ref_kind, content_ref_id, content_ref_version_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(value.goalId, value.cycleId, value.runId, value.sequence, value.safeSummary, value.phase, value.targetKind,
        value.targetId, value.targetVersionId, value.durableState, value.contentRef?.kind ?? null, value.contentRef?.targetId ?? null,
        value.contentRef?.targetVersionId ?? null, value.createdAt);
      this.workspace.db.exec("COMMIT");
      return value;
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
    return Boolean(this.workspace.db.prepare("SELECT 1 FROM growth_cycles WHERE goal_id = ? AND status IN ('planned', 'running')")
      .get(goalId));
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
      if (seed.resourceVersionId && !this.workspace.db.prepare("SELECT 1 FROM resource_revisions WHERE id = ? AND resource_id = ?").get(seed.resourceVersionId, seed.resourceId)) {
        throw growthError("GROWTH_SEED_REFERENCE_INVALID");
      }
      return;
    }
    if (!this.workspace.db.prepare("SELECT 1 FROM document_versions WHERE id = ? AND creative_document_id = ?")
      .get(seed.sourceVersionId, seed.sourceDocumentId)) throw growthError("GROWTH_SEED_REFERENCE_INVALID");
  }

  #assertStableContentRef(kind: string, targetId: string, targetVersionId: string): void {
    const valid = kind === "resource"
      ? this.workspace.db.prepare("SELECT 1 FROM resource_revisions WHERE resource_id = ? AND id = ?").get(targetId, targetVersionId)
      : kind === "document"
        ? this.workspace.db.prepare("SELECT 1 FROM document_versions WHERE creative_document_id = ? AND id = ?").get(targetId, targetVersionId)
        : kind === "assertion"
          ? this.workspace.db.prepare("SELECT 1 FROM assertion_versions WHERE assertion_id = ? AND id = ?").get(targetId, targetVersionId)
          : kind === "relation"
            ? this.workspace.db.prepare("SELECT 1 FROM creative_relation_versions WHERE relation_id = ? AND id = ?").get(targetId, targetVersionId)
            : kind === "image"
              ? this.workspace.db.prepare("SELECT 1 FROM image_assets WHERE id = ? AND job_id = ?").get(targetId, targetVersionId)
              : this.workspace.db.prepare("SELECT 1 FROM change_sets WHERE id = ? AND committed_checkpoint_id = ? AND status = 'committed'").get(targetId, targetVersionId);
    if (!valid) throw growthError("GROWTH_CONTENT_REFERENCE_NOT_STABLE");
  }
}

function mapCycle(row: Row): GrowthCycle {
  return growthCycleSchema.parse({
    id: readString(row, "id"), goalId: readString(row, "goal_id"), sequence: readNumber(row, "sequence"),
    idempotencyKey: readString(row, "idempotency_key"), inputCheckpointId: readString(row, "input_checkpoint_id"),
    ruleRevision: readNumber(row, "rule_revision"), runId: readNullableString(row, "run_id"), receiptId: readNullableString(row, "receipt_id"),
    changeSetId: readNullableString(row, "change_set_id"), outputCheckpointId: readNullableString(row, "output_checkpoint_id"),
    status: readString(row, "status"), failureCode: readNullableString(row, "failure_code"), createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"), terminalAt: readNullableString(row, "terminal_at"),
  });
}

function readSeed(row: Row): GrowthGoal["seed"] {
  const kind = readString(row, "seed_kind");
  if (kind === "text") return { kind, text: readString(row, "seed_text") };
  if (kind === "source_document") return {
    kind, sourceDocumentId: readString(row, "seed_source_document_id"), sourceVersionId: readString(row, "seed_source_version_id"),
  };
  if (kind === "resource") return {
    kind, resourceId: readString(row, "seed_resource_id"), resourceVersionId: readNullableString(row, "seed_resource_version_id"),
  };
  throw growthError("GROWTH_DATA_INVALID");
}

function seedColumns(seed: GrowthGoalCreate["seed"]): {
  kind: string; text: string | null; sourceDocumentId: string | null; sourceVersionId: string | null; resourceId: string | null; resourceVersionId: string | null;
} {
  if (seed.kind === "text") return { kind: seed.kind, text: seed.text, sourceDocumentId: null, sourceVersionId: null, resourceId: null, resourceVersionId: null };
  if (seed.kind === "source_document") return { kind: seed.kind, text: null, sourceDocumentId: seed.sourceDocumentId, sourceVersionId: seed.sourceVersionId, resourceId: null, resourceVersionId: null };
  return { kind: seed.kind, text: null, sourceDocumentId: null, sourceVersionId: null, resourceId: seed.resourceId, resourceVersionId: seed.resourceVersionId };
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
