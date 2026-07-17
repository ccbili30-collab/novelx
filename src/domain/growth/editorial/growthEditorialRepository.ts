import type { SQLOutputValue } from "node:sqlite";
import { canonicalAuditHash } from "../../audit/canonicalAuditHash";
import type { WorkspaceDatabase } from "../../workspace/workspaceRepository";
import {
  acceptanceFacetSchema,
  agentCapabilityIdSchema,
  growthEditorialContractVersion,
} from "../../../shared/growthEditorialContract";
import { z } from "zod";
import {
  candidateRecordSchema,
  editorialReviewRecordSchema,
  editorialRoundCreateSchema,
  reconciliationRequiredSchema,
  workOrderAttemptStartSchema,
  workOrderTerminalSchema,
  type CandidateRecord,
  type EditorialReviewRecord,
  type EditorialRoundCreate,
  type GrowthEditorialReview,
  type GrowthEditorialRound,
  type GrowthEditorialRoundSnapshot,
  type GrowthWorkOrder,
  type GrowthWorkOrderArtifact,
  type GrowthWorkOrderAttempt,
  type ReconciliationRequired,
  type WorkOrderAttemptStart,
  type WorkOrderTerminal,
} from "./growthEditorialTypes";

type Row = Record<string, SQLOutputValue>;

export class GrowthEditorialRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  createRound(input: EditorialRoundCreate): GrowthEditorialRoundSnapshot {
    const value = editorialRoundCreateSchema.parse(input);
    const payloadHash = canonicalAuditHash({
      contractVersion: growthEditorialContractVersion,
      goalId: value.goalId,
      sourceCheckpointId: value.sourceCheckpointId,
      ruleRevision: value.ruleRevision,
      workOrders: value.workOrders,
    });
    return this.#transaction(() => {
      const replay = this.workspace.db.prepare(`
        SELECT id, payload_hash FROM growth_editorial_rounds WHERE idempotency_key = ?
      `).get(value.idempotencyKey) as Row | undefined;
      if (replay) {
        if (readString(replay, "payload_hash") !== payloadHash) fail("GROWTH_EDITORIAL_IDEMPOTENCY_KEY_REUSED");
        return this.#requiredSnapshot(readString(replay, "id"));
      }
      const goal = this.workspace.db.prepare(`
        SELECT status, current_rule_revision FROM growth_goals WHERE id = ?
      `).get(value.goalId) as Row | undefined;
      if (!goal) fail("GROWTH_EDITORIAL_GOAL_NOT_FOUND");
      if (readString(goal, "status") !== "active") fail("GROWTH_EDITORIAL_GOAL_NOT_ACTIVE");
      if (value.ruleRevision > readNumber(goal, "current_rule_revision")) fail("GROWTH_EDITORIAL_RULE_REVISION_NOT_FOUND");
      if (this.workspace.db.prepare("SELECT 1 FROM growth_editorial_rounds WHERE id = ?").get(value.id)) {
        fail("GROWTH_EDITORIAL_ROUND_ID_CONFLICT");
      }

      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_editorial_rounds (
          id, goal_id, contract_version, source_checkpoint_id, rule_revision, idempotency_key,
          payload_hash, status, failure_code, created_at, updated_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL)
      `).run(value.id, value.goalId, growthEditorialContractVersion, value.sourceCheckpointId,
        value.ruleRevision, value.idempotencyKey, payloadHash, now, now);

      const insertOrder = this.workspace.db.prepare(`
        INSERT INTO growth_work_orders (
          id, round_id, goal_id, ordinal, objective, source_checkpoint_id, scope_refs_json,
          capability_id, acceptance_facets_json, status, failure_code, idempotency_key,
          payload_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?, ?, ?, ?)
      `);
      const insertDependency = this.workspace.db.prepare(`
        INSERT INTO growth_work_order_dependencies (
          round_id, goal_id, work_order_id, depends_on_work_order_id, ordinal
        ) VALUES (?, ?, ?, ?, ?)
      `);
      value.workOrders.forEach((order, ordinal) => {
        const orderPayloadHash = canonicalAuditHash({ roundId: value.id, goalId: value.goalId, ordinal, ...order });
        insertOrder.run(order.id, value.id, value.goalId, ordinal, order.objective, order.sourceCheckpointId,
          JSON.stringify(order.scopeRefs), order.capability, JSON.stringify(order.acceptanceFacets),
          `${value.idempotencyKey}:work-order:${ordinal}`, orderPayloadHash, now, now);
        order.dependencies.forEach((dependency, dependencyOrdinal) => {
          insertDependency.run(value.id, value.goalId, order.id, dependency, dependencyOrdinal);
        });
      });
      this.#unlockReadyWorkOrders(value.id, now);
      return this.#requiredSnapshot(value.id);
    });
  }

  getRound(roundId: string): GrowthEditorialRound | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_editorial_rounds WHERE id = ?").get(roundId) as Row | undefined;
    return row ? mapRound(row) : null;
  }

  getWorkOrder(workOrderId: string): GrowthWorkOrder | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_work_orders WHERE id = ?").get(workOrderId) as Row | undefined;
    return row ? this.#mapWorkOrder(row) : null;
  }

  getAttempt(attemptId: string): GrowthWorkOrderAttempt | null {
    const row = this.workspace.db.prepare("SELECT * FROM growth_work_order_attempts WHERE id = ?").get(attemptId) as Row | undefined;
    return row ? mapAttempt(row) : null;
  }

  getRoundSnapshot(roundId: string): GrowthEditorialRoundSnapshot | null {
    return this.getRound(roundId) ? this.#requiredSnapshot(roundId) : null;
  }

  unlockReadyWorkOrders(roundId: string): GrowthWorkOrder[] {
    return this.#transaction(() => {
      this.#requiredRound(roundId);
      this.#unlockReadyWorkOrders(roundId, new Date().toISOString());
      return this.#listWorkOrders(roundId).filter((order) => order.status === "ready");
    });
  }

  startAttempt(input: WorkOrderAttemptStart): GrowthWorkOrderAttempt {
    const value = workOrderAttemptStartSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    return this.#transaction(() => {
      const replay = this.workspace.db.prepare(`
        SELECT * FROM growth_work_order_attempts WHERE idempotency_key = ?
      `).get(value.idempotencyKey) as Row | undefined;
      if (replay) {
        if (readString(replay, "payload_hash") !== payloadHash) fail("GROWTH_EDITORIAL_IDEMPOTENCY_KEY_REUSED");
        return mapAttempt(replay);
      }
      if (this.workspace.db.prepare("SELECT 1 FROM growth_work_order_attempts WHERE id = ?").get(value.id)) {
        fail("GROWTH_EDITORIAL_ATTEMPT_ID_CONFLICT");
      }
      const orderRow = this.#requiredWorkOrderRow(value.workOrderId);
      const order = this.#mapWorkOrder(orderRow);
      if (!(["ready", "revision_requested"] as const).includes(order.status as "ready" | "revision_requested")) {
        fail("GROWTH_EDITORIAL_WORK_ORDER_NOT_STARTABLE");
      }
      const round = this.#requiredRound(order.roundId);
      if (round.status !== "active") fail("GROWTH_EDITORIAL_ROUND_NOT_ACTIVE");
      if (value.sourceCheckpointId !== order.sourceCheckpointId || value.sourceCheckpointId !== round.sourceCheckpointId) {
        fail("GROWTH_EDITORIAL_CHECKPOINT_MISMATCH");
      }
      if (value.ruleRevision !== round.ruleRevision) fail("GROWTH_EDITORIAL_RULE_REVISION_MISMATCH");
      if (value.capability !== order.capability) fail("GROWTH_EDITORIAL_CAPABILITY_OWNER_MISMATCH");
      const attemptNumber = readNumber(this.workspace.db.prepare(`
        SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt
        FROM growth_work_order_attempts WHERE work_order_id = ?
      `).get(order.id) as Row, "next_attempt");
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_work_order_attempts (
          id, round_id, goal_id, work_order_id, attempt_number, status, failure_code,
          source_checkpoint_id, rule_revision, capability_id,
          capability_profile_id, capability_profile_version, capability_profile_sha256,
          prompt_id, prompt_version, prompt_sha256, provider_id, model_id, provider_config_sha256,
          side_effect_state, idempotency_key, payload_hash, output_sha256,
          created_at, updated_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'none', ?, ?, NULL, ?, ?, NULL)
      `).run(value.id, order.roundId, order.goalId, order.id, attemptNumber,
        value.sourceCheckpointId, value.ruleRevision, value.capability,
        value.capabilityProfile.id, value.capabilityProfile.version, value.capabilityProfile.sha256,
        value.prompt.id, value.prompt.version, value.prompt.sha256,
        value.model.providerId, value.model.modelId, value.model.providerConfigSha256,
        value.idempotencyKey, payloadHash, now, now);
      const updated = this.workspace.db.prepare(`
        UPDATE growth_work_orders SET status = 'running', failure_code = NULL, updated_at = ?
        WHERE id = ? AND status = ?
      `).run(now, order.id, order.status);
      if (Number(updated.changes) !== 1) fail("GROWTH_EDITORIAL_STATE_CONFLICT");
      return this.#requiredAttempt(value.id);
    });
  }

  recordCandidate(input: CandidateRecord): GrowthWorkOrderAttempt {
    const value = candidateRecordSchema.parse(input);
    return this.#transaction(() => {
      const attempt = this.#requiredAttempt(value.attemptId);
      if (attempt.status !== "running") {
        if (attempt.outputSha256 === value.outputSha256 && this.#artifactsMatch(attempt.id, value.artifacts)) return attempt;
        fail("GROWTH_EDITORIAL_CANDIDATE_STATE_INVALID");
      }
      const now = new Date().toISOString();
      const insertArtifact = this.workspace.db.prepare(`
        INSERT INTO growth_work_order_artifacts (
          round_id, goal_id, work_order_id, attempt_id, artifact_kind, ordinal,
          artifact_store_ref, content_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const artifact of value.artifacts) {
        insertArtifact.run(attempt.roundId, attempt.goalId, attempt.workOrderId, attempt.id,
          artifact.kind, artifact.ordinal, artifact.storeRef, artifact.contentSha256, now);
      }
      this.#transitionAttempt(attempt.id, "running", "candidate_ready", now, {
        outputSha256: value.outputSha256,
      });
      this.#transitionWorkOrder(attempt.workOrderId, "running", "candidate_ready", now);
      return this.#requiredAttempt(attempt.id);
    });
  }

  beginReview(attemptId: string): GrowthWorkOrderAttempt {
    return this.#transaction(() => {
      const attempt = this.#requiredAttempt(attemptId);
      if (attempt.status === "reviewing") return attempt;
      if (attempt.status !== "candidate_ready") fail("GROWTH_EDITORIAL_REVIEW_STATE_INVALID");
      const now = new Date().toISOString();
      this.#transitionAttempt(attempt.id, "candidate_ready", "reviewing", now);
      this.#transitionWorkOrder(attempt.workOrderId, "candidate_ready", "reviewing", now);
      return this.#requiredAttempt(attempt.id);
    });
  }

  recordReview(input: EditorialReviewRecord): GrowthEditorialReview {
    const value = editorialReviewRecordSchema.parse(input);
    const payloadHash = canonicalAuditHash(value);
    return this.#transaction(() => {
      const replay = this.workspace.db.prepare(`
        SELECT * FROM growth_editorial_reviews WHERE idempotency_key = ?
      `).get(value.idempotencyKey) as Row | undefined;
      if (replay) {
        if (readString(replay, "payload_hash") !== payloadHash) fail("GROWTH_EDITORIAL_IDEMPOTENCY_KEY_REUSED");
        return mapReview(replay);
      }
      const attempt = this.#requiredAttempt(value.attemptId);
      if (attempt.status !== "reviewing") fail("GROWTH_EDITORIAL_REVIEW_STATE_INVALID");
      if (value.reviewerKind === "director") {
        const checker = this.workspace.db.prepare(`
          SELECT 1 FROM growth_editorial_reviews WHERE attempt_id = ? AND reviewer_kind = 'checker'
        `).get(attempt.id);
        if (!checker) fail("GROWTH_EDITORIAL_CHECKER_REVIEW_REQUIRED");
      }
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        INSERT INTO growth_editorial_reviews (
          id, round_id, goal_id, work_order_id, attempt_id, reviewer_kind, decision,
          safe_summary, evidence_refs_json, review_artifact_ref, review_sha256,
          idempotency_key, payload_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(value.id, attempt.roundId, attempt.goalId, attempt.workOrderId, attempt.id,
        value.reviewerKind, value.decision, value.safeSummary, JSON.stringify(value.evidenceRefs),
        value.artifactRef, value.artifactSha256, value.idempotencyKey, payloadHash, now);
      this.#insertReviewArtifact(attempt, value, now);

      if (value.reviewerKind === "director") {
        const next = value.decision === "accept" ? "accepted" : "revision_requested";
        this.#transitionAttempt(attempt.id, "reviewing", next, now, { terminal: true });
        this.#transitionWorkOrder(attempt.workOrderId, "reviewing", next, now);
      }
      return this.#requiredReview(value.id);
    });
  }

  queueCommit(workOrderId: string): GrowthWorkOrder {
    return this.#transaction(() => {
      const order = this.#requiredWorkOrder(workOrderId);
      if (order.status === "commit_queued") return order;
      if (order.status !== "accepted") fail("GROWTH_EDITORIAL_COMMIT_QUEUE_STATE_INVALID");
      const attempt = this.#latestAttempt(order.id);
      if (!attempt || attempt.status !== "accepted") fail("GROWTH_EDITORIAL_ACCEPTED_ATTEMPT_REQUIRED");
      const now = new Date().toISOString();
      this.#transitionWorkOrder(order.id, "accepted", "commit_queued", now);
      return this.#requiredWorkOrder(order.id);
    });
  }

  markCommitRequested(workOrderId: string): GrowthWorkOrderAttempt {
    return this.#transaction(() => {
      const order = this.#requiredWorkOrder(workOrderId);
      if (order.status !== "commit_queued") fail("GROWTH_EDITORIAL_COMMIT_QUEUE_STATE_INVALID");
      const attempt = this.#latestAttempt(order.id);
      if (!attempt || attempt.status !== "accepted") fail("GROWTH_EDITORIAL_ACCEPTED_ATTEMPT_REQUIRED");
      if (attempt.sideEffectState === "commit_requested") return attempt;
      if (attempt.sideEffectState !== "none") fail("GROWTH_EDITORIAL_COMMIT_ATTEMPT_INVALID");
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        UPDATE growth_work_order_attempts SET side_effect_state = 'commit_requested', updated_at = ?
        WHERE id = ? AND status = 'accepted' AND side_effect_state = 'none'
      `).run(now, attempt.id);
      return this.#requiredAttempt(attempt.id);
    });
  }

  markCommitted(workOrderId: string): GrowthWorkOrder {
    return this.#transaction(() => {
      const order = this.#requiredWorkOrder(workOrderId);
      if (order.status === "committed") return order;
      if (order.status !== "commit_queued") fail("GROWTH_EDITORIAL_COMMIT_STATE_INVALID");
      const attempt = this.#latestAttempt(order.id);
      if (!attempt || attempt.status !== "accepted" || attempt.sideEffectState !== "commit_requested") {
        fail("GROWTH_EDITORIAL_COMMIT_ATTEMPT_INVALID");
      }
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        UPDATE growth_work_order_attempts SET side_effect_state = 'committed', updated_at = ? WHERE id = ?
      `).run(now, attempt.id);
      this.#transitionWorkOrder(order.id, "commit_queued", "committed", now);
      this.#unlockReadyWorkOrders(order.roundId, now);
      const unfinished = this.workspace.db.prepare(`
        SELECT 1 FROM growth_work_orders WHERE round_id = ? AND status <> 'committed' LIMIT 1
      `).get(order.roundId);
      if (!unfinished) {
        this.workspace.db.prepare(`
          UPDATE growth_editorial_rounds
          SET status = 'completed', updated_at = ?, terminal_at = ?
          WHERE id = ? AND status = 'active'
        `).run(now, now, order.roundId);
      }
      return this.#requiredWorkOrder(order.id);
    });
  }

  terminalizeWorkOrder(input: WorkOrderTerminal): GrowthWorkOrder {
    const value = workOrderTerminalSchema.parse(input);
    return this.#transaction(() => {
      const order = this.#requiredWorkOrder(value.workOrderId);
      if (order.status === value.status && order.failureCode === value.failureCode) return order;
      if (["commit_queued", "committed", "reconciliation_required", "cancelled", "failed"].includes(order.status)) {
        fail("GROWTH_EDITORIAL_TERMINAL_STATE_INVALID");
      }
      const now = new Date().toISOString();
      const attempt = this.#latestAttempt(order.id);
      if (attempt && ["running", "candidate_ready", "reviewing", "revision_requested", "accepted"].includes(attempt.status)) {
        this.#transitionAttempt(attempt.id, attempt.status, value.status, now, {
          terminal: true,
          failureCode: value.failureCode,
        });
      }
      this.#transitionWorkOrder(order.id, order.status, value.status, now, value.failureCode);
      return this.#requiredWorkOrder(order.id);
    });
  }

  markReconciliationRequired(input: ReconciliationRequired): GrowthWorkOrder {
    const value = reconciliationRequiredSchema.parse(input);
    return this.#transaction(() => {
      const order = this.#requiredWorkOrder(value.workOrderId);
      const attempt = this.#requiredAttempt(value.attemptId);
      if (attempt.workOrderId !== order.id) fail("GROWTH_EDITORIAL_ATTEMPT_OWNER_MISMATCH");
      if (order.status === "reconciliation_required"
        && attempt.status === "reconciliation_required"
        && order.failureCode === value.failureCode
        && attempt.failureCode === value.failureCode) return order;
      if (order.status !== "commit_queued" || attempt.status !== "accepted" || attempt.sideEffectState !== "commit_requested") {
        fail("GROWTH_EDITORIAL_RECONCILIATION_STATE_INVALID");
      }
      const now = new Date().toISOString();
      this.workspace.db.prepare(`
        UPDATE growth_work_order_attempts
        SET status = 'reconciliation_required', failure_code = ?, side_effect_state = 'outcome_unknown',
          updated_at = ?, terminal_at = ?
        WHERE id = ? AND status = 'accepted' AND side_effect_state = 'commit_requested'
      `).run(value.failureCode, now, now, attempt.id);
      this.#transitionWorkOrder(order.id, "commit_queued", "reconciliation_required", now, value.failureCode);
      this.workspace.db.prepare(`
        UPDATE growth_editorial_rounds
        SET status = 'reconciliation_required', failure_code = ?, updated_at = ?, terminal_at = ?
        WHERE id = ? AND status = 'active'
      `).run(value.failureCode, now, now, order.roundId);
      return this.#requiredWorkOrder(order.id);
    });
  }

  #unlockReadyWorkOrders(roundId: string, now: string): void {
    this.workspace.db.prepare(`
      UPDATE growth_work_orders AS candidate
      SET status = 'ready', updated_at = ?
      WHERE candidate.round_id = ? AND candidate.status = 'planned'
        AND NOT EXISTS (
          SELECT 1
          FROM growth_work_order_dependencies dependency
          JOIN growth_work_orders predecessor ON predecessor.id = dependency.depends_on_work_order_id
          WHERE dependency.work_order_id = candidate.id AND predecessor.status <> 'committed'
        )
    `).run(now, roundId);
  }

  #transitionWorkOrder(id: string, from: string, to: string, now: string, failureCode: string | null = null): void {
    const result = this.workspace.db.prepare(`
      UPDATE growth_work_orders SET status = ?, failure_code = ?, updated_at = ? WHERE id = ? AND status = ?
    `).run(to, failureCode, now, id, from);
    if (Number(result.changes) !== 1) fail("GROWTH_EDITORIAL_STATE_CONFLICT");
  }

  #transitionAttempt(
    id: string,
    from: string,
    to: string,
    now: string,
    options: { terminal?: boolean; failureCode?: string; outputSha256?: string } = {},
  ): void {
    const result = this.workspace.db.prepare(`
      UPDATE growth_work_order_attempts
      SET status = ?, failure_code = ?, output_sha256 = COALESCE(?, output_sha256),
        updated_at = ?, terminal_at = ?
      WHERE id = ? AND status = ?
    `).run(to, options.failureCode ?? null, options.outputSha256 ?? null, now, options.terminal ? now : null, id, from);
    if (Number(result.changes) !== 1) fail("GROWTH_EDITORIAL_STATE_CONFLICT");
  }

  #insertReviewArtifact(attempt: GrowthWorkOrderAttempt, review: EditorialReviewRecord, now: string): void {
    this.workspace.db.prepare(`
      INSERT INTO growth_work_order_artifacts (
        round_id, goal_id, work_order_id, attempt_id, artifact_kind, ordinal,
        artifact_store_ref, content_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(attempt.roundId, attempt.goalId, attempt.workOrderId, attempt.id,
      review.reviewerKind === "checker" ? "checker_review" : "director_review",
      review.artifactRef, review.artifactSha256, now);
  }

  #artifactsMatch(attemptId: string, expected: CandidateRecord["artifacts"]): boolean {
    const actual = this.workspace.db.prepare(`
      SELECT artifact_kind, ordinal, artifact_store_ref, content_sha256
      FROM growth_work_order_artifacts WHERE attempt_id = ?
        AND artifact_kind NOT IN ('checker_review', 'director_review')
      ORDER BY artifact_kind, ordinal
    `).all(attemptId) as Row[];
    const normalizedExpected = [...expected].sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.ordinal - right.ordinal);
    return actual.length === normalizedExpected.length && actual.every((row, index) => {
      const artifact = normalizedExpected[index]!;
      return readString(row, "artifact_kind") === artifact.kind
        && readNumber(row, "ordinal") === artifact.ordinal
        && readString(row, "artifact_store_ref") === artifact.storeRef
        && readString(row, "content_sha256") === artifact.contentSha256;
    });
  }

  #requiredSnapshot(roundId: string): GrowthEditorialRoundSnapshot {
    const round = this.#requiredRound(roundId);
    const workOrders = this.#listWorkOrders(roundId);
    const attempts = (this.workspace.db.prepare(`
      SELECT * FROM growth_work_order_attempts WHERE round_id = ? ORDER BY work_order_id, attempt_number
    `).all(roundId) as Row[]).map(mapAttempt);
    const reviews = (this.workspace.db.prepare(`
      SELECT * FROM growth_editorial_reviews WHERE round_id = ? ORDER BY created_at, id
    `).all(roundId) as Row[]).map(mapReview);
    const artifacts = (this.workspace.db.prepare(`
      SELECT * FROM growth_work_order_artifacts WHERE round_id = ?
      ORDER BY work_order_id, attempt_id, artifact_kind, ordinal
    `).all(roundId) as Row[]).map(mapArtifact);
    return { round, workOrders, attempts, reviews, artifacts };
  }

  #listWorkOrders(roundId: string): GrowthWorkOrder[] {
    return (this.workspace.db.prepare(`
      SELECT * FROM growth_work_orders WHERE round_id = ? ORDER BY ordinal
    `).all(roundId) as Row[]).map((row) => this.#mapWorkOrder(row));
  }

  #mapWorkOrder(row: Row): GrowthWorkOrder {
    const id = readString(row, "id");
    const dependencies = (this.workspace.db.prepare(`
      SELECT depends_on_work_order_id FROM growth_work_order_dependencies
      WHERE work_order_id = ? ORDER BY ordinal
    `).all(id) as Row[]).map((dependency) => readString(dependency, "depends_on_work_order_id"));
    return {
      id,
      roundId: readString(row, "round_id"),
      goalId: readString(row, "goal_id"),
      ordinal: readNumber(row, "ordinal"),
      objective: readString(row, "objective"),
      sourceCheckpointId: readString(row, "source_checkpoint_id"),
      scopeRefs: z.array(z.string()).parse(readJson(row, "scope_refs_json")),
      capability: agentCapabilityIdSchema.parse(readString(row, "capability_id")),
      acceptanceFacets: z.array(acceptanceFacetSchema).parse(readJson(row, "acceptance_facets_json")),
      dependencies,
      status: readString(row, "status") as GrowthWorkOrder["status"],
      failureCode: readNullableString(row, "failure_code"),
      createdAt: readString(row, "created_at"),
      updatedAt: readString(row, "updated_at"),
    };
  }

  #requiredRound(id: string): GrowthEditorialRound {
    const round = this.getRound(id);
    return round ?? fail("GROWTH_EDITORIAL_ROUND_NOT_FOUND");
  }

  #requiredWorkOrder(id: string): GrowthWorkOrder {
    const order = this.getWorkOrder(id);
    return order ?? fail("GROWTH_EDITORIAL_WORK_ORDER_NOT_FOUND");
  }

  #requiredWorkOrderRow(id: string): Row {
    return (this.workspace.db.prepare("SELECT * FROM growth_work_orders WHERE id = ?").get(id) as Row | undefined)
      ?? fail("GROWTH_EDITORIAL_WORK_ORDER_NOT_FOUND");
  }

  #requiredAttempt(id: string): GrowthWorkOrderAttempt {
    return this.getAttempt(id) ?? fail("GROWTH_EDITORIAL_ATTEMPT_NOT_FOUND");
  }

  #latestAttempt(workOrderId: string): GrowthWorkOrderAttempt | null {
    const row = this.workspace.db.prepare(`
      SELECT * FROM growth_work_order_attempts WHERE work_order_id = ? ORDER BY attempt_number DESC LIMIT 1
    `).get(workOrderId) as Row | undefined;
    return row ? mapAttempt(row) : null;
  }

  #requiredReview(id: string): GrowthEditorialReview {
    const row = this.workspace.db.prepare("SELECT * FROM growth_editorial_reviews WHERE id = ?").get(id) as Row | undefined;
    return row ? mapReview(row) : fail("GROWTH_EDITORIAL_REVIEW_NOT_FOUND");
  }

  #transaction<T>(operation: () => T): T {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.workspace.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapRound(row: Row): GrowthEditorialRound {
  const contractVersion = readString(row, "contract_version");
  if (contractVersion !== growthEditorialContractVersion) fail("GROWTH_EDITORIAL_CONTRACT_VERSION_UNSUPPORTED");
  return {
    id: readString(row, "id"),
    goalId: readString(row, "goal_id"),
    contractVersion,
    sourceCheckpointId: readString(row, "source_checkpoint_id"),
    ruleRevision: readNumber(row, "rule_revision"),
    status: readString(row, "status") as GrowthEditorialRound["status"],
    failureCode: readNullableString(row, "failure_code"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    terminalAt: readNullableString(row, "terminal_at"),
  };
}

function mapAttempt(row: Row): GrowthWorkOrderAttempt {
  return {
    id: readString(row, "id"),
    roundId: readString(row, "round_id"),
    goalId: readString(row, "goal_id"),
    workOrderId: readString(row, "work_order_id"),
    attemptNumber: readNumber(row, "attempt_number"),
    status: readString(row, "status") as GrowthWorkOrderAttempt["status"],
    failureCode: readNullableString(row, "failure_code"),
    sourceCheckpointId: readString(row, "source_checkpoint_id"),
    ruleRevision: readNumber(row, "rule_revision"),
    capability: agentCapabilityIdSchema.parse(readString(row, "capability_id")),
    capabilityProfile: {
      id: readString(row, "capability_profile_id"),
      version: readString(row, "capability_profile_version"),
      sha256: readString(row, "capability_profile_sha256"),
    },
    prompt: {
      id: readString(row, "prompt_id"),
      version: readString(row, "prompt_version"),
      sha256: readString(row, "prompt_sha256"),
    },
    model: {
      providerId: readString(row, "provider_id"),
      modelId: readString(row, "model_id"),
      providerConfigSha256: readString(row, "provider_config_sha256"),
    },
    sideEffectState: readString(row, "side_effect_state") as GrowthWorkOrderAttempt["sideEffectState"],
    outputSha256: readNullableString(row, "output_sha256"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    terminalAt: readNullableString(row, "terminal_at"),
  };
}

function mapReview(row: Row): GrowthEditorialReview {
  return {
    id: readString(row, "id"),
    roundId: readString(row, "round_id"),
    goalId: readString(row, "goal_id"),
    workOrderId: readString(row, "work_order_id"),
    attemptId: readString(row, "attempt_id"),
    reviewerKind: readString(row, "reviewer_kind") as GrowthEditorialReview["reviewerKind"],
    decision: readString(row, "decision") as GrowthEditorialReview["decision"],
    safeSummary: readString(row, "safe_summary"),
    evidenceRefs: z.array(z.string()).parse(readJson(row, "evidence_refs_json")),
    artifactRef: readString(row, "review_artifact_ref"),
    artifactSha256: readString(row, "review_sha256"),
    createdAt: readString(row, "created_at"),
  };
}

function mapArtifact(row: Row): GrowthWorkOrderArtifact {
  return {
    roundId: readString(row, "round_id"),
    goalId: readString(row, "goal_id"),
    workOrderId: readString(row, "work_order_id"),
    attemptId: readString(row, "attempt_id"),
    kind: readString(row, "artifact_kind") as GrowthWorkOrderArtifact["kind"],
    ordinal: readNumber(row, "ordinal"),
    storeRef: readString(row, "artifact_store_ref"),
    contentSha256: readString(row, "content_sha256"),
    createdAt: readString(row, "created_at"),
  };
}

function readJson(row: Row, key: string): unknown {
  try {
    return JSON.parse(readString(row, key));
  } catch {
    return fail("GROWTH_EDITORIAL_DATA_INVALID");
  }
}

function readString(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : fail("GROWTH_EDITORIAL_DATA_INVALID");
}

function readNullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return typeof value === "string" ? value : fail("GROWTH_EDITORIAL_DATA_INVALID");
}

function readNumber(row: Row, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : fail("GROWTH_EDITORIAL_DATA_INVALID");
}

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
