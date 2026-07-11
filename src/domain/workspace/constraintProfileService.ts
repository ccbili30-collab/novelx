import { CheckpointRepository } from "../version/checkpointRepository";
import {
  ConstraintProfileRepository,
  type ConstraintProfilePayload,
  type ConstraintProfileRecord,
  type WorkingConstraintProfileRecord,
} from "./constraintProfileRepository";
import { ResourceRepository } from "./resourceRepository";
import type { WorkspaceDatabase } from "./workspaceRepository";

export interface ResolvedConstraintValue<T> {
  value: T | null;
  sourceProfileId: string | null;
  sourceTitle: string | null;
}

export interface ResolvedConstraintListItem {
  value: string;
  sourceProfileId: string;
  sourceTitle: string;
}

export interface ResolvedConstraints {
  narrativePerson: ResolvedConstraintValue<NonNullable<ConstraintProfilePayload["narrativePerson"]>>;
  tense: ResolvedConstraintValue<NonNullable<ConstraintProfilePayload["tense"]>>;
  tone: ResolvedConstraintValue<string>;
  pacing: ResolvedConstraintValue<string>;
  humorLevel: ResolvedConstraintValue<number>;
  prohibitedContent: ResolvedConstraintListItem[];
  requiredContent: ResolvedConstraintListItem[];
  notes: ResolvedConstraintListItem[];
  appliedProfiles: Array<{ profileId: string; title: string; scopeResourceId: string | null }>;
}

export interface ConstraintEditorSnapshot {
  profileId: string;
  title: string;
  payload: ConstraintProfilePayload;
  stableVersionId: string;
  workingRevision: number;
  hasWorkingCopy: boolean;
  dirty: boolean;
}

export class ConstraintProfileService {
  readonly #repository: ConstraintProfileRepository;
  readonly #resources: ResourceRepository;
  readonly #checkpoints: CheckpointRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#repository = new ConstraintProfileRepository(workspace);
    this.#resources = new ResourceRepository(workspace);
    this.#checkpoints = new CheckpointRepository(workspace);
  }

  createStable(input: {
    scopeResourceId: string | null;
    title: string;
    payload: ConstraintProfilePayload;
  }): ConstraintProfileRecord {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const branch = this.#checkpoints.getActiveBranch();
      const checkpointId = this.#checkpoints.appendCheckpoint(branch.id, `创建约束《${input.title.trim()}》`);
      const profile = this.#repository.putVersion({
        checkpointId,
        scopeResourceId: input.scopeResourceId,
        title: input.title,
        payload: input.payload,
        state: "active",
        authorKind: "user",
      });
      this.workspace.db.exec("COMMIT");
      return profile;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveWorkingCopy(input: {
    profileId: string;
    payload: ConstraintProfilePayload;
    expectedRevision: number;
    expectedStableVersionId: string | null;
  }): WorkingConstraintProfileRecord {
    return this.#repository.saveWorkingCopy(input);
  }

  getForEditor(profileId: string): ConstraintEditorSnapshot {
    const current = this.#repository.getCurrent(profileId);
    if (!current) throw serviceError("CONSTRAINT_PROFILE_NOT_ACTIVE", "Constraint profile is not active.");
    const working = this.#repository.getWorkingCopy(profileId);
    return {
      profileId: current.profileId,
      title: current.title,
      payload: working?.payload ?? current.payload,
      stableVersionId: current.versionId,
      workingRevision: working?.workingRevision ?? 0,
      hasWorkingCopy: working !== null,
      dirty: working?.dirty ?? false,
    };
  }

  saveStable(input: { profileId: string; expectedRevision: number }): ConstraintProfileRecord {
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#repository.getCurrent(input.profileId);
      if (!current) throw serviceError("CONSTRAINT_PROFILE_NOT_ACTIVE", "Constraint profile is not active.");
      const working = this.#repository.getWorkingCopy(input.profileId);
      if (!working) throw serviceError("CONSTRAINT_WORKING_COPY_NOT_FOUND", "Save a constraint draft before publication.");
      if (working.workingRevision !== input.expectedRevision) {
        throw serviceError("CONSTRAINT_EDIT_CONFLICT", "Constraint draft changed after this editor snapshot was loaded.");
      }
      if (!working.dirty) throw serviceError("CONSTRAINT_NOT_DIRTY", "Constraint profile has no unpublished changes.");
      if (working.baseVersionId !== current.versionId) {
        throw serviceError("CONSTRAINT_BASE_CHANGED", "Stable constraint profile changed while this draft was edited.");
      }
      const branch = this.#checkpoints.getActiveBranch();
      const checkpointId = this.#checkpoints.appendCheckpoint(branch.id, `保存约束《${current.title}》`);
      const next = this.#repository.putVersion({
        profileId: current.profileId,
        checkpointId,
        scopeResourceId: current.scopeResourceId,
        title: current.title,
        payload: working.payload,
        state: "active",
        authorKind: "user",
      });
      this.#repository.markWorkingCopyStable({
        profileId: current.profileId,
        versionId: next.versionId,
        expectedRevision: input.expectedRevision,
      });
      this.workspace.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  discardWorkingCopy(input: { profileId: string; expectedRevision: number }): ConstraintEditorSnapshot {
    const working = this.#repository.getWorkingCopy(input.profileId);
    if (!working) throw serviceError("CONSTRAINT_WORKING_COPY_NOT_FOUND", "There is no constraint draft to discard.");
    this.#repository.discardWorkingCopy(input);
    return this.getForEditor(input.profileId);
  }

  resolveForResource(resourceId: string): ResolvedConstraints {
    const resources = this.#resources.listCurrent();
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    const target = byId.get(resourceId);
    if (!target || target.objectKind === "domain_root") {
      throw serviceError("CONSTRAINT_TARGET_INVALID", "Constraint target is not an active creative object.");
    }
    const scopeOrder: Array<string | null> = [null];
    const ancestry: string[] = [];
    let cursor = target;
    const seen = new Set<string>();
    while (cursor && cursor.objectKind !== "domain_root") {
      if (seen.has(cursor.id)) throw serviceError("RESOURCE_OWNERSHIP_CYCLE", "Creative object hierarchy contains a cycle.");
      seen.add(cursor.id);
      ancestry.push(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId)! : undefined!;
    }
    scopeOrder.push(...ancestry.reverse());
    const profiles = this.#repository.listCurrent()
      .filter((profile) => scopeOrder.includes(profile.scopeResourceId))
      .sort((left, right) => scopeOrder.indexOf(left.scopeResourceId) - scopeOrder.indexOf(right.scopeResourceId));
    return resolveProfiles(profiles);
  }
}

function resolveProfiles(profiles: ConstraintProfileRecord[]): ResolvedConstraints {
  const result: ResolvedConstraints = {
    narrativePerson: emptyValue(),
    tense: emptyValue(),
    tone: emptyValue(),
    pacing: emptyValue(),
    humorLevel: emptyValue(),
    prohibitedContent: [],
    requiredContent: [],
    notes: [],
    appliedProfiles: [],
  };
  for (const profile of profiles) {
    result.appliedProfiles.push({ profileId: profile.profileId, title: profile.title, scopeResourceId: profile.scopeResourceId });
    assignValue(result.narrativePerson, profile.payload.narrativePerson, profile);
    assignValue(result.tense, profile.payload.tense, profile);
    assignValue(result.tone, profile.payload.tone, profile);
    assignValue(result.pacing, profile.payload.pacing, profile);
    assignValue(result.humorLevel, profile.payload.humorLevel, profile);
    appendList(result.prohibitedContent, profile.payload.prohibitedContent, profile);
    appendList(result.requiredContent, profile.payload.requiredContent, profile);
    if (profile.payload.notes) appendList(result.notes, [profile.payload.notes], profile);
  }
  return result;
}

function emptyValue<T>(): ResolvedConstraintValue<T> {
  return { value: null, sourceProfileId: null, sourceTitle: null };
}

function assignValue<T>(target: ResolvedConstraintValue<T>, value: T | null, profile: ConstraintProfileRecord): void {
  if (value === null) return;
  target.value = value;
  target.sourceProfileId = profile.profileId;
  target.sourceTitle = profile.title;
}

function appendList(target: ResolvedConstraintListItem[], values: string[], profile: ConstraintProfileRecord): void {
  for (const value of values) {
    if (target.some((item) => item.value === value)) continue;
    target.push({ value, sourceProfileId: profile.profileId, sourceTitle: profile.title });
  }
}

function serviceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
