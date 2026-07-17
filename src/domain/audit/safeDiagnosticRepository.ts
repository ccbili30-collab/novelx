import type { SQLOutputValue } from "node:sqlite";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import {
  safeDiagnosticEnvelopeV1Schema,
  type SafeDiagnosticEnvelopeV1,
  type SafeDiagnosticOperationKind,
} from "../../shared/diagnostics/safeDiagnosticContract";

export type SafeDiagnosticRepositoryErrorCode =
  | "SAFE_DIAGNOSTIC_INPUT_INVALID"
  | "SAFE_DIAGNOSTIC_REPLAY_CONFLICT"
  | "SAFE_DIAGNOSTIC_SEQUENCE_CONFLICT"
  | "SAFE_DIAGNOSTIC_SEQUENCE_INVALID"
  | "SAFE_DIAGNOSTIC_PARENT_NOT_FOUND"
  | "SAFE_DIAGNOSTIC_PARENT_CONTEXT_INVALID"
  | "SAFE_DIAGNOSTIC_PERSISTENCE_FAILED";

export class SafeDiagnosticRepositoryError extends Error {
  readonly code: SafeDiagnosticRepositoryErrorCode;

  constructor(code: SafeDiagnosticRepositoryErrorCode) {
    super(code);
    this.name = "SafeDiagnosticRepositoryError";
    this.code = code;
  }
}

export class SafeDiagnosticRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  append(input: SafeDiagnosticEnvelopeV1): SafeDiagnosticEnvelopeV1 {
    const parsed = safeDiagnosticEnvelopeV1Schema.safeParse(input);
    if (!parsed.success) throw diagnosticError("SAFE_DIAGNOSTIC_INPUT_INVALID");
    const value = parsed.data;
    const replay = this.get(value.diagnosticId);
    if (replay) {
      if (!sameDiagnostic(replay, value)) throw diagnosticError("SAFE_DIAGNOSTIC_REPLAY_CONFLICT");
      return replay;
    }

    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const occupied = this.workspace.db.prepare(`
        SELECT id FROM safe_diagnostic_events
        WHERE operation_kind = ? AND operation_id = ? AND sequence = ?
      `).get(value.operationKind, value.operationId, value.sequence);
      if (occupied) throw diagnosticError("SAFE_DIAGNOSTIC_SEQUENCE_CONFLICT");

      const latest = this.workspace.db.prepare(`
        SELECT MAX(sequence) AS sequence FROM safe_diagnostic_events
        WHERE operation_kind = ? AND operation_id = ?
      `).get(value.operationKind, value.operationId) as { sequence: number | null };
      const expectedSequence = (latest.sequence ?? 0) + 1;
      if (value.sequence !== expectedSequence) throw diagnosticError("SAFE_DIAGNOSTIC_SEQUENCE_INVALID");

      if (value.parentDiagnosticId) this.assertParent(value);
      this.workspace.db.prepare(`
        INSERT INTO safe_diagnostic_events (
          id, operation_kind, operation_id, run_id, cycle_id, tool_invocation_id,
          parent_diagnostic_id, sequence, owner, boundary, code, tool_name, attempt,
          max_attempts, side_effect_state, disposition, retryability, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        value.diagnosticId,
        value.operationKind,
        value.operationId,
        value.runId,
        value.cycleId,
        value.toolInvocationId,
        value.parentDiagnosticId,
        value.sequence,
        value.owner,
        value.boundary,
        value.code,
        value.toolName,
        value.attempt,
        value.maxAttempts,
        value.sideEffectState,
        value.disposition,
        value.retryability,
        value.occurredAt,
      );
      this.workspace.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      if (error instanceof SafeDiagnosticRepositoryError) throw error;
      throw diagnosticError("SAFE_DIAGNOSTIC_PERSISTENCE_FAILED");
    }
  }

  get(diagnosticId: string): SafeDiagnosticEnvelopeV1 | null {
    const row = this.workspace.db.prepare("SELECT * FROM safe_diagnostic_events WHERE id = ?").get(diagnosticId);
    return row ? readDiagnostic(row) : null;
  }

  listOperation(operationKind: SafeDiagnosticOperationKind, operationId: string): SafeDiagnosticEnvelopeV1[] {
    return this.workspace.db.prepare(`
      SELECT * FROM safe_diagnostic_events
      WHERE operation_kind = ? AND operation_id = ? ORDER BY sequence
    `).all(operationKind, operationId).map(readDiagnostic);
  }

  listRun(runId: string): SafeDiagnosticEnvelopeV1[] {
    return this.workspace.db.prepare(`
      SELECT * FROM safe_diagnostic_events WHERE run_id = ? ORDER BY occurred_at, id
    `).all(runId).map(readDiagnostic);
  }

  listCycle(cycleId: string): SafeDiagnosticEnvelopeV1[] {
    return this.workspace.db.prepare(`
      SELECT * FROM safe_diagnostic_events WHERE cycle_id = ? ORDER BY occurred_at, id
    `).all(cycleId).map(readDiagnostic);
  }

  private assertParent(value: SafeDiagnosticEnvelopeV1): void {
    const parent = this.get(value.parentDiagnosticId!);
    if (!parent) throw diagnosticError("SAFE_DIAGNOSTIC_PARENT_NOT_FOUND");
    if (
      parent.runId !== value.runId
      || parent.cycleId !== value.cycleId
      || (parent.operationKind === value.operationKind
        && parent.operationId === value.operationId
        && parent.sequence >= value.sequence)
    ) {
      throw diagnosticError("SAFE_DIAGNOSTIC_PARENT_CONTEXT_INVALID");
    }
  }
}

function readDiagnostic(row: Record<string, SQLOutputValue>): SafeDiagnosticEnvelopeV1 {
  return safeDiagnosticEnvelopeV1Schema.parse({
    schemaVersion: 1,
    diagnosticId: readString(row, "id"),
    operationKind: readString(row, "operation_kind"),
    operationId: readString(row, "operation_id"),
    runId: readNullableString(row, "run_id"),
    cycleId: readNullableString(row, "cycle_id"),
    toolInvocationId: readNullableString(row, "tool_invocation_id"),
    parentDiagnosticId: readNullableString(row, "parent_diagnostic_id"),
    sequence: readNumber(row, "sequence"),
    owner: readString(row, "owner"),
    boundary: readString(row, "boundary"),
    code: readString(row, "code"),
    toolName: readNullableString(row, "tool_name"),
    attempt: readNullableNumber(row, "attempt"),
    maxAttempts: readNullableNumber(row, "max_attempts"),
    sideEffectState: readString(row, "side_effect_state"),
    disposition: readString(row, "disposition"),
    retryability: readString(row, "retryability"),
    occurredAt: readString(row, "occurred_at"),
  });
}

function sameDiagnostic(left: SafeDiagnosticEnvelopeV1, right: SafeDiagnosticEnvelopeV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw diagnosticError("SAFE_DIAGNOSTIC_PERSISTENCE_FAILED");
  return value;
}

function readNullableString(row: Record<string, SQLOutputValue>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw diagnosticError("SAFE_DIAGNOSTIC_PERSISTENCE_FAILED");
  return value;
}

function readNumber(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw diagnosticError("SAFE_DIAGNOSTIC_PERSISTENCE_FAILED");
  return value;
}

function readNullableNumber(row: Record<string, SQLOutputValue>, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number") throw diagnosticError("SAFE_DIAGNOSTIC_PERSISTENCE_FAILED");
  return value;
}

function diagnosticError(code: SafeDiagnosticRepositoryErrorCode): SafeDiagnosticRepositoryError {
  return new SafeDiagnosticRepositoryError(code);
}
