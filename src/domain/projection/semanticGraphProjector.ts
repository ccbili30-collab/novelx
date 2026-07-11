import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { CreativeCommitRecord } from "../commit/creativeCommitRepository";
import { SemanticGraphService } from "../graph/semanticGraphService";
import { CheckpointRepository } from "../version/checkpointRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import type { CreativeProjector, ProjectionResult } from "./projectionCoordinator";

export class SemanticGraphProjector implements CreativeProjector {
  readonly kind = "semantic_graph";
  readonly #checkpoints: CheckpointRepository;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#checkpoints = new CheckpointRepository(workspace);
  }

  inputSha256(commit: CreativeCommitRecord): string {
    return canonicalAuditHash({
      commitId: commit.id,
      manifestSha256: commit.manifestSha256,
      branchHeadCheckpointId: this.#checkpoints.getBranch(commit.branchId).headCheckpointId,
    });
  }

  project(commit: CreativeCommitRecord): ProjectionResult {
    const branch = this.#checkpoints.getBranch(commit.branchId);
    if (branch.headCheckpointId !== commit.id) {
      throw Object.assign(new Error("Semantic graph projection only runs for the current branch head."), { code: "PROJECTION_COMMIT_NOT_BRANCH_HEAD" });
    }
    return { outputSha256: canonicalAuditHash(new SemanticGraphService(this.workspace).getSnapshot()) };
  }
}
