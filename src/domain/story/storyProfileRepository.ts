import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { CreativeCommitRepository } from "../commit/creativeCommitRepository";
import { ResourceRepository } from "../workspace/resourceRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export interface StoryProfileRecord {
  id: string;
  storyResourceId: string;
  worldResourceId: string;
  canonCommitId: string;
  title: string;
  status: "draft" | "active" | "archived";
  ocBindings: Array<{ ocResourceId: string; variantResourceId: string | null }>;
  createdAt: string;
}

export class StoryProfileRepository {
  readonly #resources: ResourceRepository;
  readonly #commits: CreativeCommitRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#resources = new ResourceRepository(workspace);
    this.#commits = new CreativeCommitRepository(workspace);
  }

  create(input: {
    storyResourceId: string;
    worldResourceId: string;
    canonCommitId: string;
    title: string;
    status?: StoryProfileRecord["status"];
    ocBindings?: Array<{ ocResourceId: string; variantResourceId?: string | null }>;
  }): StoryProfileRecord {
    const story = this.#resources.getCurrent(input.storyResourceId);
    const world = this.#resources.getCurrent(input.worldResourceId);
    if (story?.objectKind !== "story") throw storyError("STORY_PROFILE_STORY_INVALID");
    if (world?.objectKind !== "world") throw storyError("STORY_PROFILE_WORLD_INVALID");
    const commit = this.#commits.getRequired(input.canonCommitId);
    if (!commit.sealedAt || !commit.manifestSha256) throw storyError("STORY_PROFILE_CANON_UNSEALED");
    const title = input.title.trim();
    if (!title) throw storyError("STORY_PROFILE_TITLE_REQUIRED");
    const bindings = normalizeBindings(input.ocBindings ?? [], this.#resources);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      this.workspace.db.prepare(`
        INSERT INTO story_profiles (id, story_resource_id, world_resource_id, canon_commit_id, title, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, story.id, world.id, commit.id, title, input.status ?? "active", createdAt);
      const insert = this.workspace.db.prepare(`
        INSERT INTO story_profile_oc_bindings (story_profile_id, oc_resource_id, variant_resource_id) VALUES (?, ?, ?)
      `);
      for (const binding of bindings) insert.run(id, binding.ocResourceId, binding.variantResourceId);
      this.workspace.db.exec("COMMIT");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRequired(id);
  }

  getRequired(id: string): StoryProfileRecord {
    const row = this.workspace.db.prepare("SELECT * FROM story_profiles WHERE id = ?").get(id);
    if (!row) throw storyError("STORY_PROFILE_NOT_FOUND");
    const profile = mapProfile(row);
    profile.ocBindings = this.workspace.db.prepare(`
      SELECT oc_resource_id, variant_resource_id FROM story_profile_oc_bindings
      WHERE story_profile_id = ? ORDER BY oc_resource_id
    `).all(id).map((binding) => {
      const value = binding as { oc_resource_id: string; variant_resource_id: string | null };
      return { ocResourceId: value.oc_resource_id, variantResourceId: value.variant_resource_id };
    });
    return profile;
  }

  list(): StoryProfileRecord[] {
    return (this.workspace.db.prepare("SELECT id FROM story_profiles ORDER BY created_at, id").all() as Array<{ id: string }>)
      .map((row) => this.getRequired(row.id));
  }
}

function normalizeBindings(bindings: Array<{ ocResourceId: string; variantResourceId?: string | null }>, resources: ResourceRepository) {
  const seen = new Set<string>();
  return bindings.map((binding) => {
    if (seen.has(binding.ocResourceId)) throw storyError("STORY_PROFILE_OC_DUPLICATE");
    seen.add(binding.ocResourceId);
    const oc = resources.getCurrent(binding.ocResourceId);
    if (oc?.objectKind !== "oc") throw storyError("STORY_PROFILE_OC_INVALID");
    const variantId = binding.variantResourceId ?? null;
    if (variantId && resources.getCurrent(variantId)?.objectKind !== "oc_variant") throw storyError("STORY_PROFILE_VARIANT_INVALID");
    return { ocResourceId: oc.id, variantResourceId: variantId };
  });
}

function mapProfile(row: Record<string, SQLOutputValue>): StoryProfileRecord {
  const status = String(row.status);
  if (status !== "draft" && status !== "active" && status !== "archived") throw storyError("STORY_PROFILE_DATA_INVALID");
  return {
    id: String(row.id), storyResourceId: String(row.story_resource_id), worldResourceId: String(row.world_resource_id),
    canonCommitId: String(row.canon_commit_id), title: String(row.title), status, ocBindings: [], createdAt: String(row.created_at),
  };
}

function storyError(code: string): Error & { code: string } {
  return Object.assign(new Error("Story Profile operation failed."), { code });
}
