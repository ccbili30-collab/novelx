import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { DecompositionCandidateRepository } from "./decompositionCandidateRepository";
import { SourceLibraryRepository, type RightsAttestation } from "./sourceLibraryRepository";
import { StructuredSourceParserService } from "./structuredSourceParserService";
import { TextSourceParserService } from "./textSourceParserService";

export class SourceImportService {
  constructor(readonly workspace: WorkspaceDatabase) {}

  register(filePath: string, rightsAttestation: RightsAttestation) {
    return new SourceLibraryRepository(this.workspace).register({ filePath, rightsAttestation });
  }

  parse(sourceId: string) {
    const source = new SourceLibraryRepository(this.workspace).getRequired(sourceId);
    const chunks = source.format === "txt" || source.format === "markdown"
      ? new TextSourceParserService(this.workspace).parse(sourceId)
      : new StructuredSourceParserService(this.workspace).parse(sourceId);
    return { source: new SourceLibraryRepository(this.workspace).getRequired(sourceId), chunkCount: chunks.length };
  }

  listCandidateReviews(sourceId: string) {
    new SourceLibraryRepository(this.workspace).getRequired(sourceId);
    const candidates = new DecompositionCandidateRepository(this.workspace).listForSource(sourceId);
    const chunk = this.workspace.db.prepare(`
      SELECT id, locator_json, content, content_sha256 FROM source_chunks WHERE id = ? AND source_id = ?
    `);
    return candidates.map((candidate) => ({
      ...candidate,
      sources: candidate.sourceChunkIds.map((chunkId) => {
        const row = chunk.get(chunkId, sourceId) as { id: string; locator_json: string; content: string; content_sha256: string } | undefined;
        if (!row) throw importError("DECOMPOSITION_SOURCE_MISMATCH");
        return { chunkId: row.id, locator: JSON.parse(row.locator_json) as Record<string, unknown>, excerpt: row.content.slice(0, 2_000), contentSha256: row.content_sha256 };
      }),
    }));
  }

  revise(candidateId: string, payload: unknown) { return new DecompositionCandidateRepository(this.workspace).revise(candidateId, payload); }
  decide(candidateId: string, decision: "accepted" | "rejected") { return new DecompositionCandidateRepository(this.workspace).decide(candidateId, decision); }
}

function importError(code: string): Error & { code: string } {
  return Object.assign(new Error("Source import operation failed."), { code });
}
