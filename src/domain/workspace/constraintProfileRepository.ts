import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import { CheckpointRepository } from "../version/checkpointRepository";
import { ResourceRepository } from "./resourceRepository";
import type { WorkspaceDatabase } from "./workspaceRepository";

export type NarrativePerson = "first" | "second" | "third";
export type NarrativeTense = "past" | "present" | "mixed";

export interface ConstraintProfilePayload {
  narrativePerson: NarrativePerson | null;
  tense: NarrativeTense | null;
  tone: string | null;
  pacing: string | null;
  humorLevel: number | null;
  prohibitedContent: string[];
  requiredContent: string[];
  notes: string;
}

export interface ConstraintProfileRecord {
  profileId: string;
  versionId: string;
  checkpointId: string;
  scopeResourceId: string | null;
  title: string;
  payload: ConstraintProfilePayload;
  payloadHash: string;
  authorKind: "user" | "agent" | "import";
}

export interface WorkingConstraintProfileRecord {
  profileId: string;
  baseVersionId: string | null;
  payload: ConstraintProfilePayload;
  workingRevision: number;
  dirty: boolean;
}

export class ConstraintProfileRepository {
  readonly #checkpoints: CheckpointRepository;
  readonly #resources: ResourceRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#checkpoints = new CheckpointRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
  }

  listCurrent(branchId = this.#checkpoints.getActiveBranch().id): ConstraintProfileRecord[] {
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT head_checkpoint_id, 0 FROM branches WHERE id = ?
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id
        WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT cpv.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY cpv.profile_id ORDER BY ancestry.depth ASC) AS revision_rank
        FROM constraint_profile_versions cpv
        JOIN ancestry ON ancestry.checkpoint_id = cpv.created_checkpoint_id
      )
      SELECT * FROM ranked
      WHERE revision_rank = 1 AND state = 'active'
      ORDER BY CASE WHEN scope_resource_id IS NULL THEN 0 ELSE 1 END, title, profile_id
    `).all(branchId);
    return rows.map(mapProfile);
  }

  listAtCheckpoint(checkpointId: string): ConstraintProfileRecord[] {
    const rows = this.workspace.db.prepare(`
      WITH RECURSIVE ancestry(checkpoint_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT c.parent_checkpoint_id, ancestry.depth + 1 FROM checkpoints c
        JOIN ancestry ON c.id = ancestry.checkpoint_id WHERE c.parent_checkpoint_id IS NOT NULL
      ), ranked AS (
        SELECT cpv.*, ancestry.depth,
          ROW_NUMBER() OVER (PARTITION BY cpv.profile_id ORDER BY ancestry.depth ASC) AS revision_rank
        FROM constraint_profile_versions cpv JOIN ancestry ON ancestry.checkpoint_id = cpv.created_checkpoint_id
      )
      SELECT * FROM ranked WHERE revision_rank = 1 AND state = 'active'
      ORDER BY CASE WHEN scope_resource_id IS NULL THEN 0 ELSE 1 END, title, profile_id
    `).all(checkpointId);
    return rows.map(mapProfile);
  }

  getCurrent(profileId: string, branchId = this.#checkpoints.getActiveBranch().id): ConstraintProfileRecord | null {
    return this.listCurrent(branchId).find((profile) => profile.profileId === profileId) ?? null;
  }

  putVersion(input: {
    profileId?: string;
    create?: boolean;
    checkpointId: string;
    scopeResourceId: string | null;
    title: string;
    payload: ConstraintProfilePayload;
    state: "active" | "deleted";
    authorKind: ConstraintProfileRecord["authorKind"];
  }): ConstraintProfileRecord {
    requireRow(this.workspace.db.prepare("SELECT id FROM checkpoints WHERE id = ?").get(input.checkpointId), "CHECKPOINT_NOT_FOUND");
    const profileId = input.profileId ?? randomUUID();
    const identity = this.workspace.db.prepare("SELECT id FROM constraint_profiles WHERE id = ?").get(profileId);
    const current = input.profileId ? this.getCurrent(profileId) : null;
    if (input.profileId && !input.create && !identity) throw profileError("CONSTRAINT_PROFILE_NOT_FOUND", "Constraint profile not found.");
    if (input.create && identity) throw profileError("CONSTRAINT_PROFILE_ALREADY_EXISTS", "Constraint profile already exists.");
    if (current && current.scopeResourceId !== input.scopeResourceId) {
      throw profileError("CONSTRAINT_PROFILE_SCOPE_IMMUTABLE", "Constraint profile scope cannot be changed.");
    }
    if (input.state === "deleted" && !current) throw profileError("CONSTRAINT_PROFILE_NOT_ACTIVE", "Constraint profile is not active.");
    if (input.scopeResourceId) {
      const scope = this.#resources.getCurrent(input.scopeResourceId);
      if (!scope || scope.objectKind === "domain_root") {
        throw profileError("CONSTRAINT_PROFILE_SCOPE_INVALID", "Constraint profile scope is not an active creative object.");
      }
    }
    const payload = normalizePayload(input.payload);
    const payloadHash = hashPayload(payload);
    if (!identity) this.workspace.db.prepare("INSERT INTO constraint_profiles (id) VALUES (?)").run(profileId);
    const versionId = randomUUID();
    this.workspace.db.prepare(`
      INSERT INTO constraint_profile_versions (
        id, profile_id, scope_resource_id, created_checkpoint_id, state, title,
        narrative_person, tense, tone, pacing, humor_level,
        prohibited_content, required_content, notes, payload_hash, author_kind, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      versionId,
      profileId,
      input.scopeResourceId,
      input.checkpointId,
      input.state,
      input.title.trim(),
      payload.narrativePerson,
      payload.tense,
      payload.tone,
      payload.pacing,
      payload.humorLevel,
      JSON.stringify(payload.prohibitedContent),
      JSON.stringify(payload.requiredContent),
      payload.notes,
      payloadHash,
      input.authorKind,
      new Date().toISOString(),
    );
    return this.getCurrent(profileId) ?? {
      profileId,
      versionId,
      checkpointId: input.checkpointId,
      scopeResourceId: input.scopeResourceId,
      title: input.title.trim(),
      payload,
      payloadHash,
      authorKind: input.authorKind,
    };
  }

  saveWorkingCopy(input: {
    profileId: string;
    payload: ConstraintProfilePayload;
    expectedRevision?: number;
    expectedStableVersionId?: string | null;
  }): WorkingConstraintProfileRecord {
    const current = this.getCurrent(input.profileId);
    if (!current) throw profileError("CONSTRAINT_PROFILE_NOT_ACTIVE", "Constraint profile is not active.");
    const branch = this.#checkpoints.getActiveBranch();
    const existing = this.getWorkingCopy(input.profileId, branch.id);
    const currentRevision = existing?.workingRevision ?? 0;
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw profileError("CONSTRAINT_EDIT_CONFLICT", "Constraint profile changed after this editor snapshot was loaded.");
    }
    if (!existing && input.expectedStableVersionId !== undefined && input.expectedStableVersionId !== current.versionId) {
      throw profileError("CONSTRAINT_BASE_CHANGED", "Stable constraint profile changed before the draft was created.");
    }
    const payload = normalizePayload(input.payload);
    const dirty = hashPayload(payload) !== current.payloadHash;
    const result = this.workspace.db.prepare(`
      INSERT INTO working_constraint_profiles (
        branch_id, profile_id, base_version_id, payload_json, edit_revision, dirty, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(branch_id, profile_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        edit_revision = working_constraint_profiles.edit_revision + 1,
        dirty = excluded.dirty,
        updated_at = excluded.updated_at
      WHERE working_constraint_profiles.edit_revision = ?
    `).run(
      branch.id,
      input.profileId,
      existing?.baseVersionId ?? current.versionId,
      JSON.stringify(payload),
      dirty ? 1 : 0,
      new Date().toISOString(),
      input.expectedRevision ?? currentRevision,
    );
    if (result.changes !== 1) throw profileError("CONSTRAINT_EDIT_CONFLICT", "Constraint draft changed before it could be saved.");
    return this.getWorkingCopy(input.profileId)!;
  }

  getWorkingCopy(profileId: string, branchId = this.#checkpoints.getActiveBranch().id): WorkingConstraintProfileRecord | null {
    const row = this.workspace.db.prepare("SELECT * FROM working_constraint_profiles WHERE branch_id = ? AND profile_id = ?")
      .get(branchId, profileId);
    if (!row) return null;
    return {
      profileId: readString(row, "profile_id"),
      baseVersionId: readNullableString(row, "base_version_id"),
      payload: parsePayload(readString(row, "payload_json")),
      workingRevision: readNumber(row, "edit_revision"),
      dirty: readNumber(row, "dirty") === 1,
    };
  }

  discardWorkingCopy(input: { profileId: string; expectedRevision: number }): void {
    const branch = this.#checkpoints.getActiveBranch();
    const result = this.workspace.db.prepare(`
      DELETE FROM working_constraint_profiles
      WHERE branch_id = ? AND profile_id = ? AND edit_revision = ?
    `).run(branch.id, input.profileId, input.expectedRevision);
    if (result.changes !== 1) throw profileError("CONSTRAINT_EDIT_CONFLICT", "Constraint draft changed before it could be discarded.");
  }

  markWorkingCopyStable(input: { profileId: string; versionId: string; expectedRevision: number }): void {
    const branch = this.#checkpoints.getActiveBranch();
    const result = this.workspace.db.prepare(`
      UPDATE working_constraint_profiles SET base_version_id = ?, dirty = 0, updated_at = ?
      WHERE branch_id = ? AND profile_id = ? AND edit_revision = ?
    `).run(input.versionId, new Date().toISOString(), branch.id, input.profileId, input.expectedRevision);
    if (result.changes !== 1) throw profileError("CONSTRAINT_EDIT_CONFLICT", "Constraint draft changed before publication.");
  }
}

function mapProfile(row: Record<string, SQLOutputValue>): ConstraintProfileRecord {
  const authorKind = readString(row, "author_kind");
  if (authorKind !== "user" && authorKind !== "agent" && authorKind !== "import") {
    throw profileError("CONSTRAINT_AUTHOR_INVALID", "Constraint profile author kind is invalid.");
  }
  return {
    profileId: readString(row, "profile_id"),
    versionId: readString(row, "id"),
    checkpointId: readString(row, "created_checkpoint_id"),
    scopeResourceId: readNullableString(row, "scope_resource_id"),
    title: readString(row, "title"),
    payload: normalizePayload({
      narrativePerson: readNullableString(row, "narrative_person") as NarrativePerson | null,
      tense: readNullableString(row, "tense") as NarrativeTense | null,
      tone: readNullableString(row, "tone"),
      pacing: readNullableString(row, "pacing"),
      humorLevel: readNullableNumber(row, "humor_level"),
      prohibitedContent: parseStringArray(readString(row, "prohibited_content")),
      requiredContent: parseStringArray(readString(row, "required_content")),
      notes: readString(row, "notes"),
    }),
    payloadHash: readString(row, "payload_hash"),
    authorKind,
  };
}

export function normalizePayload(payload: ConstraintProfilePayload): ConstraintProfilePayload {
  if (payload.humorLevel !== null && (!Number.isInteger(payload.humorLevel) || payload.humorLevel < 0 || payload.humorLevel > 5)) {
    throw profileError("CONSTRAINT_HUMOR_LEVEL_INVALID", "Humor level must be an integer between 0 and 5.");
  }
  return {
    narrativePerson: payload.narrativePerson,
    tense: payload.tense,
    tone: normalizeNullableText(payload.tone),
    pacing: normalizeNullableText(payload.pacing),
    humorLevel: payload.humorLevel,
    prohibitedContent: normalizeList(payload.prohibitedContent),
    requiredContent: normalizeList(payload.requiredContent),
    notes: payload.notes.trim(),
  };
}

function parsePayload(value: string): ConstraintProfilePayload {
  try {
    return normalizePayload(JSON.parse(value) as ConstraintProfilePayload);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw profileError("CONSTRAINT_PAYLOAD_INVALID", "Stored constraint payload is invalid.");
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("invalid");
    return parsed;
  } catch {
    throw profileError("CONSTRAINT_PAYLOAD_INVALID", "Stored constraint list is invalid.");
  }
}

function hashPayload(payload: ConstraintProfilePayload): string {
  return canonicalAuditHash(payload);
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeNullableText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized || null;
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw profileError("WORKSPACE_DATA_INVALID", `Expected string column: ${key}`);
  return value;
}

function readNullableString(row: Record<string, SQLOutputValue>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw profileError("WORKSPACE_DATA_INVALID", `Expected nullable string column: ${key}`);
  return value;
}

function readNumber(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw profileError("WORKSPACE_DATA_INVALID", `Expected number column: ${key}`);
  return value;
}

function readNullableNumber(row: Record<string, SQLOutputValue>, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number") throw profileError("WORKSPACE_DATA_INVALID", `Expected nullable number column: ${key}`);
  return value;
}

function requireRow(row: unknown, code: string): void {
  if (!row) throw profileError(code, "Required workspace record was not found.");
}

function profileError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
