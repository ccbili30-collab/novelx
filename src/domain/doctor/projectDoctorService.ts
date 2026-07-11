import { CreativeCommitRepository } from "../commit/creativeCommitRepository";
import { CreativeCommitService } from "../commit/creativeCommitService";
import { ProjectionCoordinator } from "../projection/projectionCoordinator";
import { SemanticGraphProjector } from "../projection/semanticGraphProjector";
import { listProjectionCapabilities } from "../projection/projectionCatalog";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export type ProjectDoctorIssueCode =
  | "COMMIT_UNSEALED"
  | "COMMIT_MANIFEST_MISMATCH"
  | "PROJECTION_MISSING"
  | "PROJECTION_FAILED"
  | "PROJECTION_STALE";

export interface ProjectDoctorIssue {
  code: ProjectDoctorIssueCode;
  severity: "warning" | "blocked";
  commitId: string;
  projectionKind: string | null;
  repairAvailable: boolean;
}

export interface ProjectDoctorReport {
  status: "healthy" | "warning" | "blocked";
  checkedAt: string;
  counts: {
    commits: number;
    sealedCommits: number;
    openBranchHeads: number;
    successfulHeadProjections: number;
  };
  issues: ProjectDoctorIssue[];
  deferredCapabilities: Array<"timeline" | "retrieval" | "summary" | "character_knowledge">;
}

export class ProjectDoctorService {
  readonly #commits: CreativeCommitRepository;
  readonly #commitService: CreativeCommitService;
  readonly #graphProjector: SemanticGraphProjector;
  readonly #projections: ProjectionCoordinator;

  constructor(readonly workspace: WorkspaceDatabase) {
    this.#commits = new CreativeCommitRepository(workspace);
    this.#commitService = new CreativeCommitService(workspace);
    this.#graphProjector = new SemanticGraphProjector(workspace);
    this.#projections = new ProjectionCoordinator(workspace, [this.#graphProjector]);
  }

  inspect(): ProjectDoctorReport {
    const commits = this.#commits.listAll();
    const issues: ProjectDoctorIssue[] = [];
    let sealedCommits = 0;
    for (const commit of commits) {
      if (!commit.sealedAt) {
        issues.push(issue("COMMIT_UNSEALED", "warning", commit.id, null, true));
        continue;
      }
      sealedCommits += 1;
      try {
        if (!this.#commitService.verify(commit.id).matches) {
          issues.push(issue("COMMIT_MANIFEST_MISMATCH", "blocked", commit.id, null, false));
        }
      } catch {
        issues.push(issue("COMMIT_MANIFEST_MISMATCH", "blocked", commit.id, null, false));
      }
    }

    const branchHeads = this.workspace.db.prepare(`
      SELECT head_checkpoint_id AS commit_id FROM branches WHERE status = 'open' ORDER BY id
    `).all() as Array<{ commit_id: string }>;
    let successfulHeadProjections = 0;
    for (const { commit_id: commitId } of branchHeads) {
      const commit = this.#commits.getRequired(commitId);
      if (!commit.sealedAt || !commit.manifestSha256) continue;
      const runs = this.#projections.listRuns(commitId).filter((run) => run.projectionKind === this.#graphProjector.kind);
      const latest = runs.at(-1);
      if (!latest) {
        issues.push(issue("PROJECTION_MISSING", "warning", commitId, this.#graphProjector.kind, true));
        continue;
      }
      if (latest.status === "failed") {
        issues.push(issue("PROJECTION_FAILED", "warning", commitId, this.#graphProjector.kind, true));
        continue;
      }
      if (latest.inputSha256 !== this.#graphProjector.inputSha256(commit)) {
        issues.push(issue("PROJECTION_STALE", "warning", commitId, this.#graphProjector.kind, true));
        continue;
      }
      successfulHeadProjections += 1;
    }

    return {
      status: issues.some((entry) => entry.severity === "blocked")
        ? "blocked"
        : issues.length ? "warning" : "healthy",
      checkedAt: new Date().toISOString(),
      counts: {
        commits: commits.length,
        sealedCommits,
        openBranchHeads: branchHeads.length,
        successfulHeadProjections,
      },
      issues,
      deferredCapabilities: listProjectionCapabilities()
        .filter((capability) => capability.status === "planned" && capability.kind !== "semantic_graph")
        .map((capability) => capability.kind as "timeline" | "retrieval" | "summary" | "character_knowledge"),
    };
  }
}

function issue(
  code: ProjectDoctorIssueCode,
  severity: ProjectDoctorIssue["severity"],
  commitId: string,
  projectionKind: string | null,
  repairAvailable: boolean,
): ProjectDoctorIssue {
  return { code, severity, commitId, projectionKind, repairAvailable };
}
