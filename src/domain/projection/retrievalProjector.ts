import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { CreativeCommitRecord } from "../commit/creativeCommitRepository";
import { AssertionRepository } from "../graph/assertionRepository";
import { CreativeDocumentRepository } from "../workspace/creativeDocumentRepository";
import { DocumentRepository } from "../workspace/documentRepository";
import { ResourceRepository } from "../workspace/resourceRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { ProjectionArtifactRepository } from "./projectionArtifactRepository";
import type { CreativeProjector, ProjectionResult } from "./projectionCoordinator";

export class RetrievalProjector implements CreativeProjector {
  readonly kind = "retrieval";

  constructor(readonly workspace: WorkspaceDatabase) {}

  inputSha256(commit: CreativeCommitRecord): string {
    return canonicalAuditHash({ kind: this.kind, commitId: commit.id, manifestSha256: commit.manifestSha256 });
  }

  project(commit: CreativeCommitRecord, runId: string): ProjectionResult {
    const capability = this.workspace.db.prepare("SELECT available FROM retrieval_index_capability WHERE singleton = 1").get() as { available: number } | undefined;
    if (capability?.available !== 1) throw Object.assign(new Error("FTS5 retrieval is unavailable."), { code: "RETRIEVAL_FTS5_UNAVAILABLE" });
    const records = collectRecords(this.workspace, commit.branchId);
    const artifacts = new ProjectionArtifactRepository(this.workspace);
    const insert = this.workspace.db.prepare(`
      INSERT INTO retrieval_fts (run_id, commit_id, artifact_key, title, content) VALUES (?, ?, ?, ?, ?)
    `);
    for (const record of records) {
      artifacts.append({ runId, artifactKey: record.key, payload: record, sourceRefs: record.sourceRefs });
      insert.run(runId, commit.id, record.key, record.title, record.content);
    }
    return { outputSha256: canonicalAuditHash(records) };
  }
}

function collectRecords(workspace: WorkspaceDatabase, branchId: string) {
  const assertions = new AssertionRepository(workspace).listLatestForGraph(branchId).map((assertion) => ({
    key: `assertion:${assertion.versionId}`,
    kind: "assertion" as const,
    resourceId: assertion.scopeId,
    title: `${assertion.subject} ${assertion.predicate}`,
    content: `${assertion.subject}\n${assertion.predicate}\n${JSON.stringify(assertion.object)}`,
    sourceRefs: [assertion.versionId, ...assertion.sources.map((source) => source.ref)].sort(),
  }));
  const documents = new DocumentRepository(workspace);
  const creativeDocuments = new CreativeDocumentRepository(workspace);
  const documentRecords = new ResourceRepository(workspace).listCurrent(branchId).flatMap((resource) => {
    const creative = creativeDocuments.listCurrent(resource.id, branchId).flatMap((document) => {
      const version = documents.getCurrentStableForCreativeDocument(document.id, branchId);
      return version ? [{
        key: `document:${version.id}`,
        kind: "document" as const,
        resourceId: resource.id,
        title: document.title,
        content: version.content,
        sourceRefs: [version.id],
      }] : [];
    });
    if (creative.length) return creative;
    const legacy = documents.getCurrentStable(resource.id, branchId);
    return legacy ? [{
      key: `document:${legacy.id}`,
      kind: "document" as const,
      resourceId: resource.id,
      title: resource.title,
      content: legacy.content,
      sourceRefs: [legacy.id],
    }] : [];
  });
  return [...assertions, ...documentRecords].sort((left, right) => left.key.localeCompare(right.key));
}
