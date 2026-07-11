import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { CreativeCommitRecord } from "../commit/creativeCommitRepository";
import { AssertionRepository, type SourcedAssertionRecord } from "../graph/assertionRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { ProjectionArtifactRepository } from "./projectionArtifactRepository";
import type { CreativeProjector, ProjectionResult } from "./projectionCoordinator";

type EpistemicStatus = "observed" | "told" | "inferred" | "unknown";

export class CharacterKnowledgeProjector implements CreativeProjector {
  readonly kind = "character_knowledge";

  constructor(readonly workspace: WorkspaceDatabase) {}

  inputSha256(commit: CreativeCommitRecord): string {
    return canonicalAuditHash({ kind: this.kind, commitId: commit.id, manifestSha256: commit.manifestSha256 });
  }

  project(commit: CreativeCommitRecord, runId: string): ProjectionResult {
    const records = new AssertionRepository(this.workspace).listLatestForGraph(commit.branchId)
      .flatMap(projectKnowledge)
      .sort((left, right) => left.characterId.localeCompare(right.characterId) || left.assertionId.localeCompare(right.assertionId));
    const artifacts = new ProjectionArtifactRepository(this.workspace);
    for (const record of records) {
      artifacts.append({
        runId,
        artifactKey: `knowledge:${record.characterId}:${record.assertionId}`,
        payload: record,
        sourceRefs: [record.versionId, ...record.sourceRefs],
      });
    }
    return { outputSha256: canonicalAuditHash(records) };
  }
}

function projectKnowledge(assertion: SourcedAssertionRecord) {
  const value = assertion.object.knowledge;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.characterId !== "string" || !record.characterId.trim()) return [];
  if (!isEpistemicStatus(record.status)) return [];
  if (typeof record.fact !== "string" || !record.fact.trim()) return [];
  return [{
    characterId: record.characterId.trim(),
    status: record.status,
    fact: record.fact.trim(),
    assertionId: assertion.assertionId,
    versionId: assertion.versionId,
    scopeId: assertion.scopeId,
    sourceRefs: assertion.sources.map((source) => source.ref).sort(),
  }];
}

function isEpistemicStatus(value: unknown): value is EpistemicStatus {
  return value === "observed" || value === "told" || value === "inferred" || value === "unknown";
}
