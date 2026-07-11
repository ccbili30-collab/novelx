import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export interface RetrievalHit {
  artifactKey: string;
  title: string;
  content: string;
  rank: number;
}

export class RetrievalIndexService {
  constructor(readonly workspace: WorkspaceDatabase) {}

  search(input: { commitId: string; query: string; limit?: number }): RetrievalHit[] {
    const query = input.query.trim();
    if (!query) throw retrievalError("RETRIEVAL_QUERY_REQUIRED");
    const capability = this.workspace.db.prepare("SELECT available FROM retrieval_index_capability WHERE singleton = 1").get() as { available: number } | undefined;
    if (capability?.available !== 1) throw retrievalError("RETRIEVAL_FTS5_UNAVAILABLE");
    const run = this.workspace.db.prepare(`
      SELECT id FROM projection_runs
      WHERE commit_id = ? AND projection_kind = 'retrieval' AND status = 'succeeded'
      ORDER BY attempt DESC LIMIT 1
    `).get(input.commitId) as { id: string } | undefined;
    if (!run) throw retrievalError("RETRIEVAL_PROJECTION_REQUIRED");
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    return this.workspace.db.prepare(`
      SELECT artifact_key, title, content, bm25(retrieval_fts) AS rank
      FROM retrieval_fts WHERE retrieval_fts MATCH ? AND run_id = ?
      ORDER BY rank, artifact_key LIMIT ?
    `).all(query, run.id, limit).map((row) => {
      const value = row as { artifact_key: string; title: string; content: string; rank: number };
      return { artifactKey: value.artifact_key, title: value.title, content: value.content, rank: value.rank };
    });
  }
}

function retrievalError(code: string): Error & { code: string } {
  return Object.assign(new Error("Retrieval index operation failed."), { code });
}
