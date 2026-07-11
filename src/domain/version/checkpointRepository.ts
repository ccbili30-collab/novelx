import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { CreativeCommitRepository, type CreativeCommitKind } from "../commit/creativeCommitRepository";

export interface BranchRecord {
  id: string;
  name: string;
  headCheckpointId: string;
  status: "open" | "archived";
}

export interface CheckpointHistoryRecord {
  id: string;
  label: string;
  createdAt: string;
  isHead: boolean;
}

export class CheckpointRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  getActiveBranch(): BranchRecord {
    const row = this.workspace.db.prepare(`
      SELECT b.id, b.name, b.head_checkpoint_id, b.status
      FROM workspace_state ws JOIN branches b ON b.id = ws.active_branch_id
      WHERE ws.singleton = 1
    `).get();
    if (!row) throw repositoryError("BRANCH_NOT_FOUND", "Active branch not found.");
    return mapBranch(row);
  }

  getBranch(branchId: string): BranchRecord {
    const row = this.workspace.db.prepare("SELECT id, name, head_checkpoint_id, status FROM branches WHERE id = ?")
      .get(branchId);
    if (!row) throw repositoryError("BRANCH_NOT_FOUND", "Branch not found.");
    return mapBranch(row);
  }

  listActiveHistory(): CheckpointHistoryRecord[] {
    const branch = this.getActiveBranch();
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(id, parent_checkpoint_id, label, created_at, depth) AS (
        SELECT id, parent_checkpoint_id, label, created_at, 0
        FROM checkpoints WHERE id = ?
        UNION ALL
        SELECT checkpoint.id, checkpoint.parent_checkpoint_id, checkpoint.label, checkpoint.created_at, ancestry.depth + 1
        FROM checkpoints checkpoint
        JOIN ancestry ON checkpoint.id = ancestry.parent_checkpoint_id
      )
      SELECT id, label, created_at, depth FROM ancestry ORDER BY depth ASC
    `).all(branch.headCheckpointId);
    return rows.map((row) => ({
      id: readString(row, "id"),
      label: readString(row, "label"),
      createdAt: readString(row, "created_at"),
      isHead: readNumber(row, "depth") === 0,
    }));
  }

  createBranchFromCheckpoint(checkpointId: string, name: string): BranchRecord {
    const checkpoint = this.workspace.db.prepare("SELECT id FROM checkpoints WHERE id = ?").get(checkpointId);
    if (!checkpoint) throw repositoryError("CHECKPOINT_NOT_FOUND", "Checkpoint not found.");
    const id = randomUUID();
    this.workspace.db.prepare("INSERT INTO branches (id, name, head_checkpoint_id, status, created_at) VALUES (?, ?, ?, 'open', ?)")
      .run(id, name.trim(), checkpointId, new Date().toISOString());
    return this.getBranch(id);
  }

  setActiveBranch(branchId: string): void {
    this.getBranch(branchId);
    this.workspace.db.prepare("UPDATE workspace_state SET active_branch_id = ? WHERE singleton = 1").run(branchId);
  }

  restoreFromCheckpoint(checkpointId: string, name: string): BranchRecord {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getActiveBranch();
      const restored = this.createBranchFromCheckpoint(checkpointId, name);
      this.workspace.db.prepare("UPDATE branches SET status = 'archived' WHERE id = ?").run(current.id);
      this.setActiveBranch(restored.id);
      this.workspace.db.exec("COMMIT");
      return this.getBranch(restored.id);
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendCheckpoint(branchId: string, label: string, attribution: { actorKind?: "user" | "agent" | "import"; sourceChangeSetId?: string | null } = {}): string {
    const branch = this.getBranch(branchId);
    const parent = this.workspace.db.prepare("SELECT sequence FROM checkpoints WHERE id = ?")
      .get(branch.headCheckpointId) as { sequence: number };
    const id = randomUUID();
    const actorKind = attribution.actorKind ?? "user";
    const sourceChangeSetId = attribution.sourceChangeSetId ?? null;
    const createdAt = new Date().toISOString();
    this.workspace.db.prepare(`
      INSERT INTO checkpoints (id, branch_id, parent_checkpoint_id, sequence, label, actor_kind, source_change_set_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, branchId, branch.headCheckpointId, parent.sequence + 1, label.trim(), actorKind, sourceChangeSetId, createdAt);
    new CreativeCommitRepository(this.workspace).createEnvelope({
      id,
      branchId,
      parentCommitId: branch.headCheckpointId,
      kind: commitKind(actorKind, sourceChangeSetId),
      actorKind,
      sourceChangeSetId,
      label: label.trim(),
      createdAt,
    });
    this.workspace.db.prepare("UPDATE branches SET head_checkpoint_id = ? WHERE id = ?").run(id, branchId);
    return id;
  }
}

function commitKind(actorKind: "user" | "agent" | "import", sourceChangeSetId: string | null): CreativeCommitKind {
  if (sourceChangeSetId) return "change_set";
  return actorKind === "import" ? "import" : "manual";
}

function mapBranch(row: Record<string, SQLOutputValue>): BranchRecord {
  const status = readString(row, "status");
  if (status !== "open" && status !== "archived") throw repositoryError("BRANCH_STATUS_INVALID", "Branch status is invalid.");
  return {
    id: readString(row, "id"),
    name: readString(row, "name"),
    headCheckpointId: readString(row, "head_checkpoint_id"),
    status,
  };
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw repositoryError("WORKSPACE_DATA_INVALID", `Expected string column: ${key}`);
  return value;
}

function readNumber(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw repositoryError("WORKSPACE_DATA_INVALID", `Expected number column: ${key}`);
  return value;
}

function repositoryError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
