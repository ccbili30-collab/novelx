import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import { CreativeCommitRepository } from "../commit/creativeCommitRepository";
import { StoryProfileRepository } from "../story/storyProfileRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export interface PlaythroughRecord {
  id: string;
  storyProfileId: string;
  baselineCommitId: string;
  parentPlaythroughId: string | null;
  currentTurnId: string | null;
  status: "active" | "archived";
  createdAt: string;
}

export interface PlayTurnRecord {
  id: string;
  playthroughId: string;
  parentTurnId: string | null;
  sequence: number;
  playerAction: string;
  gmResolution: unknown;
  gmResolutionSha256: string;
  writerText: string;
  writerSha256: string;
  stateSnapshot: unknown;
  createdAt: string;
}

export class PlaythroughRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  create(input: { storyProfileId: string; parentPlaythroughId?: string | null }): PlaythroughRecord {
    const profile = new StoryProfileRepository(this.workspace).getRequired(input.storyProfileId);
    if (profile.status !== "active") throw playError("STORY_PROFILE_NOT_ACTIVE");
    const commit = new CreativeCommitRepository(this.workspace).getRequired(profile.canonCommitId);
    if (!commit.sealedAt) throw playError("PLAYTHROUGH_BASELINE_UNSEALED");
    if (input.parentPlaythroughId) this.getRequired(input.parentPlaythroughId);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.workspace.db.prepare(`
      INSERT INTO playthroughs (id, story_profile_id, baseline_commit_id, parent_playthrough_id, current_turn_id, status, created_at)
      VALUES (?, ?, ?, ?, NULL, 'active', ?)
    `).run(id, profile.id, profile.canonCommitId, input.parentPlaythroughId ?? null, createdAt);
    return this.getRequired(id);
  }

  appendTurn(input: { playthroughId: string; playerAction: string; gmResolution: unknown; writerText: string; stateSnapshot: unknown }): PlayTurnRecord {
    const playthrough = this.getRequired(input.playthroughId);
    if (playthrough.status !== "active") throw playError("PLAYTHROUGH_NOT_ACTIVE");
    const previous = playthrough.currentTurnId ? this.getTurnRequired(playthrough.currentTurnId) : null;
    const id = randomUUID();
    const sequence = (previous?.sequence ?? 0) + 1;
    const gmJson = canonicalJson(input.gmResolution);
    const stateJson = canonicalJson(input.stateSnapshot);
    const writerText = input.writerText;
    const createdAt = new Date().toISOString();
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      this.workspace.db.prepare(`
        INSERT INTO play_turns (
          id, playthrough_id, parent_turn_id, sequence, player_action, gm_resolution_json,
          gm_resolution_sha256, writer_text, writer_sha256, state_snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, playthrough.id, previous?.id ?? null, sequence, input.playerAction, gmJson,
        canonicalAuditHash(input.gmResolution), writerText, canonicalAuditHash(writerText), stateJson, createdAt);
      const updated = this.workspace.db.prepare("UPDATE playthroughs SET current_turn_id = ? WHERE id = ? AND current_turn_id IS ?")
        .run(id, playthrough.id, previous?.id ?? null);
      if (updated.changes !== 1) throw playError("PLAYTHROUGH_CONCURRENT_TURN");
      this.workspace.db.exec("COMMIT");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
    return this.getTurnRequired(id);
  }

  getRequired(id: string): PlaythroughRecord {
    const row = this.workspace.db.prepare("SELECT * FROM playthroughs WHERE id = ?").get(id);
    if (!row) throw playError("PLAYTHROUGH_NOT_FOUND");
    return mapPlaythrough(row);
  }

  getTurnRequired(id: string): PlayTurnRecord {
    const row = this.workspace.db.prepare("SELECT * FROM play_turns WHERE id = ?").get(id);
    if (!row) throw playError("PLAY_TURN_NOT_FOUND");
    return mapTurn(row);
  }
}

function mapPlaythrough(row: Record<string, SQLOutputValue>): PlaythroughRecord {
  const status = String(row.status);
  if (status !== "active" && status !== "archived") throw playError("PLAYTHROUGH_DATA_INVALID");
  return { id: String(row.id), storyProfileId: String(row.story_profile_id), baselineCommitId: String(row.baseline_commit_id),
    parentPlaythroughId: nullable(row.parent_playthrough_id), currentTurnId: nullable(row.current_turn_id), status, createdAt: String(row.created_at) };
}

function mapTurn(row: Record<string, SQLOutputValue>): PlayTurnRecord {
  return { id: String(row.id), playthroughId: String(row.playthrough_id), parentTurnId: nullable(row.parent_turn_id), sequence: Number(row.sequence),
    playerAction: String(row.player_action), gmResolution: JSON.parse(String(row.gm_resolution_json)), gmResolutionSha256: String(row.gm_resolution_sha256),
    writerText: String(row.writer_text), writerSha256: String(row.writer_sha256), stateSnapshot: JSON.parse(String(row.state_snapshot_json)), createdAt: String(row.created_at) };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw playError("PLAY_TURN_JSON_INVALID");
  return encoded;
}

function nullable(value: SQLOutputValue): string | null { return value === null ? null : String(value); }
function playError(code: string): Error & { code: string } { return Object.assign(new Error("Playthrough operation failed."), { code }); }
