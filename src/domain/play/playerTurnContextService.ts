import { createHash } from "node:crypto";
import { ContextPacketService } from "../retrieval/contextPacketService";
import { ConstraintProfileRepository, type ConstraintProfileRecord } from "../workspace/constraintProfileRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import type { PlayerWorkerTurnStartCommand } from "../../shared/playerWorkerProtocol";
import { StoryProfileRepository } from "../story/storyProfileRepository";
import { PlaythroughReconciliationService } from "./playthroughReconciliationService";
import { PlaythroughRepository } from "./playthroughRepository";

export type PreparedPlayerTurn = Omit<PlayerWorkerTurnStartCommand, "type" | "runId" | "providerProfile">;

export class PlayerTurnContextService {
  constructor(readonly workspace: WorkspaceDatabase) {}

  prepare(input: { playthroughId: string; playerAction: string }): PreparedPlayerTurn {
    const playerAction = input.playerAction.trim();
    if (!playerAction || playerAction.length > 12_000) throw contextError("PLAYER_ACTION_INVALID");
    const plays = new PlaythroughRepository(this.workspace);
    const playthrough = plays.getRequired(input.playthroughId);
    if (playthrough.status !== "active") throw contextError("PLAYTHROUGH_NOT_ACTIVE");
    if (new PlaythroughReconciliationService(this.workspace).inspect(playthrough.id).state !== "current") {
      throw contextError("PLAYTHROUGH_RECONCILIATION_REQUIRED");
    }
    const story = new StoryProfileRepository(this.workspace).getRequired(playthrough.storyProfileId);
    const scopeIds = [...new Set([
      story.worldResourceId,
      story.storyResourceId,
      ...story.ocBindings.flatMap((binding) => [binding.ocResourceId, binding.variantResourceId].filter((id): id is string => Boolean(id))),
    ])];
    const packet = new ContextPacketService(this.workspace).build({
      scopeResourceIds: scopeIds,
      checkpointId: playthrough.baselineCommitId,
      budget: { maxAssertions: 180, maxDocuments: 12, maxDocumentChars: 100_000, totalChars: 500_000 },
    });
    if (packet.retrieval.completeness.incomplete) throw contextError("PLAYER_CONTEXT_INCOMPLETE");
    const evidence = [
      ...packet.assertions.map((assertion) => {
        const content = JSON.stringify({ subject: assertion.subject, predicate: assertion.predicate, object: assertion.object, sources: assertion.sources });
        return { id: assertion.versionId, content, sha256: createHash("sha256").update(content, "utf8").digest("hex") };
      }),
      ...packet.documents.map((document) => ({
        id: document.source.version.id,
        content: document.content,
        sha256: document.source.version.contentHash,
      })),
    ];
    if (!evidence.length) throw contextError("GM_EVIDENCE_REQUIRED");
    if (evidence.some((item) => item.content.length > 100_000) || evidence.length > 200
      || evidence.reduce((total, item) => total + item.content.length, 0) > 500_000) {
      throw contextError("PLAYER_CONTEXT_INCOMPLETE");
    }
    const currentState = this.currentState(playthrough.id, playthrough.currentTurnId, playthrough.initialStateSnapshot);
    return {
      playthroughId: playthrough.id,
      playerAction,
      evidence,
      currentState,
      recentMemory: this.recentMemory(playthrough.id),
      luck: readLuck(currentState),
      styleConstraints: this.styleConstraints(playthrough.baselineCommitId, new Set(scopeIds)),
    };
  }

  private currentState(playthroughId: string, currentTurnId: string | null, initial: Record<string, unknown> | null): PreparedPlayerTurn["currentState"] {
    if (!currentTurnId) return normalizeState(initial ?? {});
    const turn = new PlaythroughRepository(this.workspace).getTurnRequired(currentTurnId);
    if (turn.playthroughId !== playthroughId || !turn.stateSnapshot || typeof turn.stateSnapshot !== "object" || Array.isArray(turn.stateSnapshot)) {
      throw contextError("PLAY_TURN_STATE_INVALID");
    }
    return normalizeState(turn.stateSnapshot as Record<string, unknown>);
  }

  private recentMemory(playthroughId: string): string {
    const rows = this.workspace.db.prepare(`
      SELECT sequence, player_action, writer_text FROM play_turns
      WHERE playthrough_id = ? ORDER BY sequence DESC LIMIT 12
    `).all(playthroughId) as Array<{ sequence: number; player_action: string; writer_text: string }>;
    const entries = rows.reverse().map((row) => `回合 ${row.sequence}\n玩家：${row.player_action}\n正文：${row.writer_text}`);
    while (entries.join("\n\n").length > 100_000) entries.shift();
    return entries.join("\n\n");
  }

  private styleConstraints(checkpointId: string, scopeIds: Set<string>) {
    const profiles = new ConstraintProfileRepository(this.workspace).listAtCheckpoint(checkpointId)
      .filter((profile) => profile.scopeResourceId === null || scopeIds.has(profile.scopeResourceId));
    const values = profiles.flatMap(expandConstraintProfile);
    if (values.length > 100) throw contextError("PLAYER_STYLE_CONTEXT_INCOMPLETE");
    return values;
  }
}

function expandConstraintProfile(profile: ConstraintProfileRecord) {
  const values: string[] = [];
  const add = (label: string, value: string | number | null) => {
    if (value !== null && String(value).trim()) values.push(`${profile.title} · ${label}：${String(value).trim()}`);
  };
  add("叙事人称", profile.payload.narrativePerson);
  add("时态", profile.payload.tense);
  add("语气", profile.payload.tone);
  add("节奏", profile.payload.pacing);
  add("幽默等级", profile.payload.humorLevel);
  profile.payload.prohibitedContent.forEach((value) => add("禁止内容", value));
  profile.payload.requiredContent.forEach((value) => add("必须内容", value));
  for (let offset = 0; offset < profile.payload.notes.length; offset += 1_800) add("补充说明", profile.payload.notes.slice(offset, offset + 1_800));
  return values.map((content, index) => ({
    id: `${profile.versionId}:${index}`,
    content,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  }));
}

function readLuck(state: PreparedPlayerTurn["currentState"]): number {
  const value = state.luck;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.5;
}

function normalizeState(value: Record<string, unknown>): PreparedPlayerTurn["currentState"] {
  try {
    return JSON.parse(JSON.stringify(value)) as PreparedPlayerTurn["currentState"];
  } catch {
    throw contextError("PLAY_TURN_STATE_INVALID");
  }
}

function contextError(code: string): Error & { code: string } {
  return Object.assign(new Error("Player turn context preparation failed."), { code });
}
