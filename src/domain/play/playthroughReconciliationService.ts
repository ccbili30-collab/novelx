import { randomUUID } from "node:crypto";
import { CreativeCommitRepository } from "../commit/creativeCommitRepository";
import { StoryProfileRepository } from "../story/storyProfileRepository";
import { CheckpointRepository } from "../version/checkpointRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { PlaythroughRepository, type PlaythroughRecord } from "./playthroughRepository";

export interface PlaythroughReconciliationStatus {
  state: "current" | "canon_diverged";
  playthroughId: string;
  pinnedCommitId: string;
  currentCommitId: string;
  allowedDecisions: Array<"continue_pinned" | "fork_from_current">;
}

export class PlaythroughReconciliationService {
  readonly #plays: PlaythroughRepository;
  readonly #profiles: StoryProfileRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#plays = new PlaythroughRepository(workspace);
    this.#profiles = new StoryProfileRepository(workspace);
  }

  inspect(playthroughId: string): PlaythroughReconciliationStatus {
    const playthrough = this.#plays.getRequired(playthroughId);
    const currentCommitId = new CheckpointRepository(this.workspace).getActiveBranch().headCheckpointId;
    const diverged = playthrough.baselineCommitId !== currentCommitId;
    return {
      state: diverged ? "canon_diverged" : "current",
      playthroughId: playthrough.id,
      pinnedCommitId: playthrough.baselineCommitId,
      currentCommitId,
      allowedDecisions: diverged ? ["continue_pinned", "fork_from_current"] : ["continue_pinned"],
    };
  }

  resolve(input: { playthroughId: string; decision: "continue_pinned" | "fork_from_current" }): PlaythroughRecord {
    const status = this.inspect(input.playthroughId);
    if (!status.allowedDecisions.includes(input.decision)) throw reconciliationError("PLAYTHROUGH_RECONCILIATION_DECISION_INVALID");
    const original = this.#plays.getRequired(input.playthroughId);
    let result = original;
    if (input.decision === "fork_from_current") {
      const commit = new CreativeCommitRepository(this.workspace).getRequired(status.currentCommitId);
      if (!commit.sealedAt || !commit.manifestSha256) throw reconciliationError("PLAYTHROUGH_CURRENT_CANON_UNSEALED");
      const previousProfile = this.#profiles.getRequired(original.storyProfileId);
      const nextProfile = this.#profiles.create({
        storyResourceId: previousProfile.storyResourceId,
        worldResourceId: previousProfile.worldResourceId,
        canonCommitId: commit.id,
        title: `${previousProfile.title} · ${commit.label}`,
        ocBindings: previousProfile.ocBindings,
      });
      result = this.#plays.create({ storyProfileId: nextProfile.id, parentPlaythroughId: original.id });
    }
    this.workspace.db.prepare(`
      INSERT INTO canon_reconciliation_decisions (
        id, playthrough_id, current_commit_id, decision, forked_playthrough_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), original.id, status.currentCommitId, input.decision, result.id === original.id ? null : result.id, new Date().toISOString());
    return result;
  }
}

function reconciliationError(code: string): Error & { code: string } {
  return Object.assign(new Error("Playthrough reconciliation failed."), { code });
}
