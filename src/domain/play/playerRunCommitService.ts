import type { PlayerWorkerEvent } from "../../shared/playerWorkerProtocol";
import { PlayerAuditRepository } from "../audit/playerAuditRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { PlaythroughRepository, type PlayTurnRecord } from "./playthroughRepository";
import type { PreparedPlayerTurn } from "./playerTurnContextService";

export class PlayerRunCommitService {
  constructor(readonly workspace: WorkspaceDatabase) {}

  commit(input: {
    runId: string;
    prepared: PreparedPlayerTurn;
    result: Extract<PlayerWorkerEvent, { type: "play.completed" }>["result"];
  }): PlayTurnRecord {
    const allowedEvidence = new Set(input.prepared.evidence.map((item) => item.id));
    if (input.result.evidenceIds.some((id) => !allowedEvidence.has(id))) throw commitError("PLAYER_RESULT_EVIDENCE_MISMATCH");
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const audit = new PlayerAuditRepository(this.workspace);
      audit.assertReadyForCompletion(input.runId);
      const turn = new PlaythroughRepository(this.workspace).appendTurnWithinTransaction({
        playthroughId: input.prepared.playthroughId,
        playerAction: input.prepared.playerAction,
        gmResolution: input.result.gmResolution,
        writerText: input.result.writerText,
        stateSnapshot: input.result.stateSnapshot,
      });
      audit.appendRunTerminal({ runId: input.runId, eventType: "completed", errorCode: null });
      this.workspace.db.exec("COMMIT");
      return turn;
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function commitError(code: string): Error & { code: string } {
  return Object.assign(new Error("Player run commit failed."), { code });
}
