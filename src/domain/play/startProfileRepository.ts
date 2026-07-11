import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { StoryProfileRepository } from "../story/storyProfileRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { SourceLibraryRepository } from "../import/sourceLibraryRepository";

const identifier = z.string().trim().min(1).max(240);
export const startProfileStateSchema = z.object({
  openingSituation: z.string().trim().min(1).max(20_000),
  initialState: z.record(z.string().trim().min(1).max(240), z.json()),
  sourceCandidateIds: z.array(identifier).max(10_000),
  excludedFutureEventCandidateIds: z.array(identifier).max(10_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.sourceCandidateIds).size !== value.sourceCandidateIds.length
    || new Set(value.excludedFutureEventCandidateIds).size !== value.excludedFutureEventCandidateIds.length) {
    context.addIssue({ code: "custom", message: "Start Profile candidate ids must be unique." });
  }
  if (value.excludedFutureEventCandidateIds.some((id) => value.sourceCandidateIds.includes(id))) {
    context.addIssue({ code: "custom", message: "Excluded future events cannot also seed the starting state." });
  }
});

export type StartProfileState = z.infer<typeof startProfileStateSchema>;

export interface StartProfileRecord {
  id: string;
  storyProfileId: string;
  sourceId: string | null;
  title: string;
  startState: StartProfileState;
  status: "draft" | "active" | "archived";
  createdAt: string;
}

export class StartProfileRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  create(input: {
    storyProfileId: string;
    sourceId?: string | null;
    title: string;
    startState: unknown;
    status?: "draft" | "active";
  }): StartProfileRecord {
    const storyProfile = new StoryProfileRepository(this.workspace).getRequired(input.storyProfileId);
    if (storyProfile.status !== "active") throw startError("START_PROFILE_STORY_NOT_ACTIVE");
    const title = input.title.trim();
    if (!title || title.length > 500) throw startError("START_PROFILE_TITLE_INVALID");
    const startState = startProfileStateSchema.parse(input.startState);
    const stateJson = JSON.stringify(startState);
    if (Buffer.byteLength(stateJson, "utf8") > 1_000_000) throw startError("START_PROFILE_STATE_TOO_LARGE");
    const sourceId = input.sourceId ?? null;
    this.validateCandidateSources(sourceId, startState);
    const id = randomUUID();
    this.workspace.db.prepare(`
      INSERT INTO start_profiles (id, story_profile_id, source_id, title, start_state_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, storyProfile.id, sourceId, title, stateJson, input.status ?? "draft", new Date().toISOString());
    return this.getRequired(id);
  }

  getRequired(id: string): StartProfileRecord {
    const row = this.workspace.db.prepare("SELECT * FROM start_profiles WHERE id = ?").get(id);
    if (!row) throw startError("START_PROFILE_NOT_FOUND");
    return mapStartProfile(row);
  }

  listForStory(storyProfileId: string): StartProfileRecord[] {
    new StoryProfileRepository(this.workspace).getRequired(storyProfileId);
    return this.workspace.db.prepare(`
      SELECT * FROM start_profiles WHERE story_profile_id = ? ORDER BY created_at, id
    `).all(storyProfileId).map(mapStartProfile);
  }

  setStatus(id: string, status: "active" | "archived"): StartProfileRecord {
    const current = this.getRequired(id);
    if (current.status === "archived") throw startError("START_PROFILE_ARCHIVED");
    const result = this.workspace.db.prepare("UPDATE start_profiles SET status = ? WHERE id = ?").run(status, id);
    if (result.changes !== 1) throw startError("START_PROFILE_NOT_FOUND");
    return this.getRequired(id);
  }

  private validateCandidateSources(sourceId: string | null, state: StartProfileState): void {
    const candidateIds = [...state.sourceCandidateIds, ...state.excludedFutureEventCandidateIds];
    if (!sourceId) {
      if (candidateIds.length) throw startError("START_PROFILE_SOURCE_REQUIRED");
      return;
    }
    const source = new SourceLibraryRepository(this.workspace).getRequired(sourceId);
    if (source.rightsAttestation === "unknown" || source.state !== "parsed") throw startError("START_PROFILE_SOURCE_INVALID");
    for (const candidateId of candidateIds) {
      const candidate = this.workspace.db.prepare(`
        SELECT source_id, kind, status FROM decomposition_candidates WHERE id = ?
      `).get(candidateId) as { source_id: string; kind: string; status: string } | undefined;
      if (!candidate || candidate.source_id !== sourceId || candidate.status !== "accepted") {
        throw startError("START_PROFILE_CANDIDATE_INVALID");
      }
      if (state.excludedFutureEventCandidateIds.includes(candidateId) && candidate.kind !== "event") {
        throw startError("START_PROFILE_FUTURE_EVENT_INVALID");
      }
    }
  }
}

function mapStartProfile(row: Record<string, SQLOutputValue>): StartProfileRecord {
  const status = String(row.status);
  if (status !== "draft" && status !== "active" && status !== "archived") throw startError("START_PROFILE_DATA_INVALID");
  return {
    id: String(row.id), storyProfileId: String(row.story_profile_id), sourceId: row.source_id === null ? null : String(row.source_id),
    title: String(row.title), startState: startProfileStateSchema.parse(JSON.parse(String(row.start_state_json))), status, createdAt: String(row.created_at),
  };
}

function startError(code: string): Error & { code: string } {
  return Object.assign(new Error("Start Profile operation failed."), { code });
}
