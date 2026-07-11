import { createHash, randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { CheckpointRepository } from "../version/checkpointRepository";

export type ChangeSetMode = "free" | "assist";
export type ChangeSetStatus = "pending" | "committed" | "rejected" | "failed";
export type ChangeSetGateStatus = "review_pending" | "ready" | "blocked";
export type ChangeSetItemDecision = "pending" | "accepted" | "rejected" | "draft";
export type ChangeSetRisk = "low" | "elevated";

export interface ChangeSetConflictRecord {
  severity: "warning" | "major";
  code: string;
}

export interface ChangeSetItemRecord {
  id: string;
  kind: string;
  payload: unknown;
  dependsOn: string[];
  risk: ChangeSetRisk;
  conflicts: ChangeSetConflictRecord[];
  decision: ChangeSetItemDecision;
  ordinal: number;
}

export interface ChangeSetRecord {
  id: string;
  idempotencyKey: string;
  branchId: string;
  baseCheckpointId: string;
  committedCheckpointId: string | null;
  mode: ChangeSetMode;
  status: ChangeSetStatus;
  gateStatus: ChangeSetGateStatus;
  blockedReason: string | null;
  failureCode: string | null;
  summary: string;
  payloadHash: string;
  producerToolInvocationId: string | null;
  items: ChangeSetItemRecord[];
}

export interface ChangeSetOutputRecord {
  changeSetId: string;
  itemId: string;
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

export interface InsertChangeSetInput {
  idempotencyKey: string;
  payloadHash: string;
  branchId: string;
  baseCheckpointId: string;
  mode: ChangeSetMode;
  summary: string;
  gateStatus: ChangeSetGateStatus;
  blockedReason: string | null;
  producerToolInvocationId: string | null;
  items: Array<Omit<ChangeSetItemRecord, "decision" | "ordinal"> & {
    decision: ChangeSetItemDecision;
  }>;
}

/**
 * SQLite persistence for Change Sets. Runtime callers should use ChangeSetService;
 * this repository does not perform policy evaluation or dependency validation.
 */
export class ChangeSetRepository {
  readonly #checkpoints: CheckpointRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#checkpoints = new CheckpointRepository(workspace);
  }

  /**
   * @deprecated Historical test/setup compatibility. Runtime Agent code is
   * forbidden from importing repositories and must call ChangeSetService.
   */
  propose(input: { idempotencyKey: string; mode: ChangeSetMode; summary: string }): ChangeSetRecord {
    const payloadHash = createHash("sha256")
      .update(JSON.stringify({ mode: input.mode, summary: input.summary.trim() }), "utf8")
      .digest("hex");
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw repositoryError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with different content.");
      }
      return existing;
    }
    const branch = this.#checkpoints.getActiveBranch();
    return this.insert({
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      branchId: branch.id,
      baseCheckpointId: branch.headCheckpointId,
      mode: input.mode,
      summary: input.summary,
      gateStatus: "review_pending",
      blockedReason: null,
      producerToolInvocationId: null,
      items: [],
    });
  }

  /**
   * @deprecated Historical test/setup compatibility. Production commits must
   * use ChangeSetService so policy, item decisions and dependencies are enforced.
   */
  commit(id: string, label: string, apply: (checkpointId: string) => void): string {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const changeSet = this.getRequired(id);
      if (changeSet.status === "committed" && changeSet.committedCheckpointId) {
        this.workspace.db.exec("COMMIT");
        return changeSet.committedCheckpointId;
      }
      if (changeSet.status !== "pending") throw repositoryError("CHANGE_SET_NOT_PENDING", "Change Set is not pending.");
      const activeBranch = this.#checkpoints.getActiveBranch();
      if (activeBranch.id !== changeSet.branchId) throw repositoryError("CHANGE_SET_BRANCH_MISMATCH", "Change Set belongs to another branch.");
      if (activeBranch.headCheckpointId !== changeSet.baseCheckpointId) throw repositoryError("CHANGE_SET_BASE_STALE", "Change Set base is stale.");
      const checkpointId = this.#checkpoints.appendCheckpoint(changeSet.branchId, label);
      apply(checkpointId);
      this.markCommitted(id, checkpointId);
      this.workspace.db.exec("COMMIT");
      return checkpointId;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: string): ChangeSetRecord | null {
    const row = this.workspace.db.prepare("SELECT * FROM change_sets WHERE id = ?").get(id);
    return row ? this.mapChangeSet(row) : null;
  }

  getRequired(id: string): ChangeSetRecord {
    const record = this.get(id);
    if (!record) throw repositoryError("CHANGE_SET_NOT_FOUND", "Change Set not found.");
    return record;
  }

  findByIdempotencyKey(idempotencyKey: string): ChangeSetRecord | null {
    const row = this.workspace.db.prepare("SELECT * FROM change_sets WHERE idempotency_key = ?")
      .get(idempotencyKey);
    return row ? this.mapChangeSet(row) : null;
  }

  listPending(branchId: string): ChangeSetRecord[] {
    const rows = this.workspace.db.prepare(`
      SELECT * FROM change_sets
      WHERE branch_id = ? AND status = 'pending'
      ORDER BY created_at DESC, id DESC
    `).all(branchId);
    return rows.map((row) => this.mapChangeSet(row));
  }

  insert(input: InsertChangeSetInput): ChangeSetRecord {
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) {
        throw repositoryError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with different content.");
      }
      return existing;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.workspace.db.prepare(`
      INSERT INTO change_sets (
        id, idempotency_key, payload_hash, branch_id, base_checkpoint_id, committed_checkpoint_id,
        mode, status, summary, created_at, committed_at, gate_status, blocked_reason, failure_code,
        producer_tool_invocation_id
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'pending', ?, ?, NULL, ?, ?, NULL, ?)
    `).run(
      id,
      input.idempotencyKey,
      input.payloadHash,
      input.branchId,
      input.baseCheckpointId,
      input.mode,
      input.summary.trim(),
      now,
      input.gateStatus,
      input.blockedReason,
      input.producerToolInvocationId,
    );

    const insertItem = this.workspace.db.prepare(`
      INSERT INTO change_set_items (
        change_set_id, id, ordinal, kind, payload_json, risk, conflicts_json, decision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDependency = this.workspace.db.prepare(`
      INSERT INTO change_set_item_dependencies (change_set_id, item_id, depends_on_item_id)
      VALUES (?, ?, ?)
    `);
    input.items.forEach((item, ordinal) => {
      insertItem.run(
        id,
        item.id,
        ordinal,
        item.kind,
        JSON.stringify(item.payload),
        item.risk,
        JSON.stringify(item.conflicts),
        item.decision,
      );
    });
    input.items.forEach((item) => {
      item.dependsOn.forEach((dependencyId) => insertDependency.run(id, item.id, dependencyId));
    });
    return this.getRequired(id);
  }

  setItemDecision(changeSetId: string, itemId: string, decision: ChangeSetItemDecision): void {
    const result = this.workspace.db.prepare(`
      UPDATE change_set_items SET decision = ? WHERE change_set_id = ? AND id = ?
    `).run(decision, changeSetId, itemId);
    if (result.changes !== 1) throw repositoryError("CHANGE_SET_ITEM_NOT_FOUND", "Change Set item not found.");
  }

  setGate(changeSetId: string, gateStatus: ChangeSetGateStatus, blockedReason: string | null): void {
    this.workspace.db.prepare(`
      UPDATE change_sets SET gate_status = ?, blocked_reason = ? WHERE id = ?
    `).run(gateStatus, blockedReason, changeSetId);
  }

  markCommitted(changeSetId: string, checkpointId: string): void {
    this.workspace.db.prepare(`
      UPDATE change_sets
      SET status = 'committed', committed_checkpoint_id = ?, committed_at = ?, gate_status = 'ready',
          blocked_reason = NULL, failure_code = NULL
      WHERE id = ?
    `).run(checkpointId, new Date().toISOString(), changeSetId);
  }

  markRejected(changeSetId: string): void {
    this.workspace.db.prepare(`
      UPDATE change_sets
      SET status = 'rejected', gate_status = 'ready', blocked_reason = NULL, failure_code = NULL
      WHERE id = ?
    `).run(changeSetId);
  }

  markFailed(changeSetId: string, failureCode: string): void {
    this.workspace.db.prepare(`
      UPDATE change_sets
      SET status = 'failed', gate_status = 'blocked', blocked_reason = 'APPLY_FAILED', failure_code = ?
      WHERE id = ? AND status = 'pending'
    `).run(failureCode, changeSetId);
  }

  recordOutput(changeSetId: string, itemId: string, output: Omit<ChangeSetOutputRecord, "changeSetId" | "itemId">): void {
    this.workspace.db.prepare(`
      INSERT INTO change_set_outputs (
        change_set_id, item_id, output_kind, output_id, output_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      changeSetId,
      itemId,
      output.kind,
      output.outputId,
      output.outputSha256,
      new Date().toISOString(),
    );
  }

  listOutputs(changeSetId: string): ChangeSetOutputRecord[] {
    const rows = this.workspace.db.prepare(`
      SELECT change_set_id, item_id, output_kind, output_id, output_sha256
      FROM change_set_outputs WHERE change_set_id = ? ORDER BY item_id
    `).all(changeSetId);
    return rows.map((row) => ({
      changeSetId: readString(row, "change_set_id"),
      itemId: readString(row, "item_id"),
      kind: readEnum(row, "output_kind", [
        "resource_revision", "document_version", "assertion_version",
        "creative_document_revision", "creative_relation_revision", "constraint_profile_version",
      ] as const),
      outputId: readString(row, "output_id"),
      outputSha256: readString(row, "output_sha256"),
    }));
  }

  private mapChangeSet(row: Record<string, SQLOutputValue>): ChangeSetRecord {
    const id = readString(row, "id");
    const mode = readEnum(row, "mode", ["free", "assist"] as const);
    const status = readEnum(row, "status", ["pending", "committed", "rejected", "failed"] as const);
    const gateStatus = readEnum(row, "gate_status", ["review_pending", "ready", "blocked"] as const);
    const itemRows = this.workspace.db.prepare(`
      SELECT * FROM change_set_items WHERE change_set_id = ? ORDER BY ordinal
    `).all(id);
    const dependencyRows = this.workspace.db.prepare(`
      SELECT item_id, depends_on_item_id FROM change_set_item_dependencies
      WHERE change_set_id = ? ORDER BY item_id, depends_on_item_id
    `).all(id) as Array<Record<string, SQLOutputValue>>;
    const dependencies = new Map<string, string[]>();
    for (const dependency of dependencyRows) {
      const itemId = readString(dependency, "item_id");
      const values = dependencies.get(itemId) ?? [];
      values.push(readString(dependency, "depends_on_item_id"));
      dependencies.set(itemId, values);
    }
    return {
      id,
      idempotencyKey: readString(row, "idempotency_key"),
      payloadHash: readString(row, "payload_hash"),
      producerToolInvocationId: readNullableString(row, "producer_tool_invocation_id"),
      branchId: readString(row, "branch_id"),
      baseCheckpointId: readString(row, "base_checkpoint_id"),
      committedCheckpointId: readNullableString(row, "committed_checkpoint_id"),
      mode,
      status,
      gateStatus,
      blockedReason: readNullableString(row, "blocked_reason"),
      failureCode: readNullableString(row, "failure_code"),
      summary: readString(row, "summary"),
      items: itemRows.map((itemRow) => mapItem(itemRow, dependencies)),
    };
  }
}

function mapItem(row: Record<string, SQLOutputValue>, dependencies: ReadonlyMap<string, string[]>): ChangeSetItemRecord {
  const id = readString(row, "id");
  const conflicts = parseJson(row, "conflicts_json");
  if (!Array.isArray(conflicts) || !conflicts.every(isConflictRecord)) {
    throw repositoryError("CHANGE_SET_DATA_INVALID", "Stored Change Set conflicts are invalid.");
  }
  return {
    id,
    kind: readString(row, "kind"),
    payload: parseJson(row, "payload_json"),
    dependsOn: dependencies.get(id) ?? [],
    risk: readEnum(row, "risk", ["low", "elevated"] as const),
    conflicts,
    decision: readEnum(row, "decision", ["pending", "accepted", "rejected", "draft"] as const),
    ordinal: readNumber(row, "ordinal"),
  };
}

function isConflictRecord(value: unknown): value is ChangeSetConflictRecord {
  if (!value || typeof value !== "object") return false;
  const conflict = value as Record<string, unknown>;
  return (conflict.severity === "warning" || conflict.severity === "major") && typeof conflict.code === "string";
}

function parseJson(row: Record<string, SQLOutputValue>, key: string): unknown {
  const raw = readString(row, key);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw repositoryError("CHANGE_SET_DATA_INVALID", `Stored Change Set JSON is invalid: ${key}`);
  }
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw repositoryError("WORKSPACE_DATA_INVALID", `Expected string column: ${key}`);
  return value;
}

function readNullableString(row: Record<string, SQLOutputValue>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw repositoryError("WORKSPACE_DATA_INVALID", `Expected nullable string column: ${key}`);
  return value;
}

function readNumber(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw repositoryError("WORKSPACE_DATA_INVALID", `Expected number column: ${key}`);
  return value;
}

function readEnum<const Values extends readonly string[]>(
  row: Record<string, SQLOutputValue>,
  key: string,
  allowed: Values,
): Values[number] {
  const value = readString(row, key);
  if (!allowed.includes(value)) throw repositoryError("WORKSPACE_DATA_INVALID", `Invalid enum column: ${key}`);
  return value as Values[number];
}

function repositoryError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
