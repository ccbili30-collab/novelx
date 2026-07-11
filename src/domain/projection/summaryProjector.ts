import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { CreativeCommitRecord } from "../commit/creativeCommitRepository";
import { CreativeDocumentRepository } from "../workspace/creativeDocumentRepository";
import { DocumentRepository } from "../workspace/documentRepository";
import { ResourceRepository } from "../workspace/resourceRepository";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { ProjectionArtifactRepository } from "./projectionArtifactRepository";
import type { CreativeProjector, ProjectionResult } from "./projectionCoordinator";

export class SummaryProjector implements CreativeProjector {
  readonly kind = "summary";

  constructor(readonly workspace: WorkspaceDatabase) {}

  inputSha256(commit: CreativeCommitRecord): string {
    return canonicalAuditHash({ kind: this.kind, commitId: commit.id, manifestSha256: commit.manifestSha256 });
  }

  project(commit: CreativeCommitRecord, runId: string): ProjectionResult {
    const summaries = collectStableDocuments(this.workspace, commit.branchId).map((document) => ({
      resourceId: document.resourceId,
      documentId: document.documentId,
      versionId: document.versionId,
      title: document.title,
      method: "extractive_first_paragraph" as const,
      text: extractSummary(document.content),
      complete: document.content.length <= 800,
      originalChars: document.content.length,
    })).sort((left, right) => left.versionId.localeCompare(right.versionId));
    const artifacts = new ProjectionArtifactRepository(this.workspace);
    for (const summary of summaries) {
      artifacts.append({ runId, artifactKey: `summary:${summary.versionId}`, payload: summary, sourceRefs: [summary.versionId] });
    }
    return { outputSha256: canonicalAuditHash(summaries) };
  }
}

interface StableSummaryDocument {
  resourceId: string;
  documentId: string | null;
  versionId: string;
  title: string;
  content: string;
}

function collectStableDocuments(workspace: WorkspaceDatabase, branchId: string): StableSummaryDocument[] {
  const documents = new DocumentRepository(workspace);
  const creativeDocuments = new CreativeDocumentRepository(workspace);
  return new ResourceRepository(workspace).listCurrent(branchId).flatMap<StableSummaryDocument>((resource) => {
    const creative = creativeDocuments.listCurrent(resource.id, branchId).flatMap((document) => {
      const version = documents.getCurrentStableForCreativeDocument(document.id, branchId);
      return version ? [{ resourceId: resource.id, documentId: document.id, versionId: version.id, title: document.title, content: version.content }] : [];
    });
    if (creative.length) return creative;
    const legacy = documents.getCurrentStable(resource.id, branchId);
    return legacy ? [{ resourceId: resource.id, documentId: null, versionId: legacy.id, title: resource.title, content: legacy.content }] : [];
  });
}

function extractSummary(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const paragraph = normalized.split(/\n\s*\n/, 1)[0] ?? "";
  return paragraph.slice(0, 800);
}
