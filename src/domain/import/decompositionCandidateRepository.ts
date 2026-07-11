import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { decomposerOutputSchema, type DecompositionCandidateInput } from "../../agent-worker/import/decomposerContracts";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export interface DecompositionCandidateRecord {
  id: string;
  sourceId: string;
  jobId: string;
  kind: DecompositionCandidateInput["kind"];
  payload: DecompositionCandidateInput["payload"];
  sourceChunkIds: string[];
  confidence: number;
  status: "pending" | "accepted" | "rejected";
  revision: number;
  createdAt: string;
}

export class DecompositionCandidateRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  appendOutput(input: { sourceId: string; jobId: string; output: unknown }): DecompositionCandidateRecord[] {
    const output = decomposerOutputSchema.parse(input.output);
    const job = this.workspace.db.prepare("SELECT status, kind FROM import_jobs WHERE id = ? AND source_id = ?").get(input.jobId, input.sourceId) as { status: string; kind: string } | undefined;
    if (!job || job.kind !== "decompose" || job.status !== "running") throw candidateError("DECOMPOSITION_JOB_NOT_RUNNING");
    const validChunks = new Set((this.workspace.db.prepare("SELECT id FROM source_chunks WHERE source_id = ?").all(input.sourceId) as Array<{ id: string }>).map((row) => row.id));
    if (output.candidates.some((candidate) => candidate.sourceChunkIds.some((id) => !validChunks.has(id)))) throw candidateError("DECOMPOSITION_SOURCE_MISMATCH");
    const created: string[] = [];
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of output.candidates) {
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        this.workspace.db.prepare(`
          INSERT INTO decomposition_candidates (
            id, source_id, job_id, kind, payload_json, confidence_milli, source_locator_json, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(id, input.sourceId, input.jobId, candidate.kind, JSON.stringify(candidate.payload), Math.round(candidate.confidence * 1000), JSON.stringify({ sourceChunkIds: candidate.sourceChunkIds }), createdAt);
        this.workspace.db.prepare(`
          INSERT INTO decomposition_candidate_revisions (id, candidate_id, revision, payload_json, editor_kind, created_at)
          VALUES (?, ?, 1, ?, 'agent', ?)
        `).run(randomUUID(), id, JSON.stringify(candidate.payload), createdAt);
        created.push(id);
      }
      this.workspace.db.exec("COMMIT");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
    return created.map((id) => this.getRequired(id));
  }

  revise(candidateId: string, payload: unknown): DecompositionCandidateRecord {
    const candidate = this.getRequired(candidateId);
    if (candidate.status !== "pending") throw candidateError("DECOMPOSITION_CANDIDATE_ALREADY_DECIDED");
    const validated = decomposerOutputSchema.parse({
      candidates: [{ kind: candidate.kind, payload, sourceChunkIds: candidate.sourceChunkIds, confidence: candidate.confidence }],
      unresolvedSourceChunkIds: [],
    }).candidates[0]!.payload;
    const revision = candidate.revision + 1;
    this.workspace.db.prepare(`
      INSERT INTO decomposition_candidate_revisions (id, candidate_id, revision, payload_json, editor_kind, created_at)
      VALUES (?, ?, ?, ?, 'user', ?)
    `).run(randomUUID(), candidate.id, revision, JSON.stringify(validated), new Date().toISOString());
    return this.getRequired(candidate.id);
  }

  decide(candidateId: string, decision: "accepted" | "rejected"): DecompositionCandidateRecord {
    const candidate = this.getRequired(candidateId);
    if (candidate.status !== "pending") throw candidateError("DECOMPOSITION_CANDIDATE_ALREADY_DECIDED");
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      this.workspace.db.prepare("UPDATE decomposition_candidates SET status = ? WHERE id = ? AND status = 'pending'").run(decision, candidate.id);
      this.workspace.db.prepare(`
        INSERT INTO import_review_decisions (id, candidate_id, decision, candidate_revision, decided_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), candidate.id, decision, candidate.revision, new Date().toISOString());
      this.workspace.db.exec("COMMIT");
    } catch (error) {
      this.workspace.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRequired(candidate.id);
  }

  getRequired(id: string): DecompositionCandidateRecord {
    const row = this.workspace.db.prepare(`
      SELECT dc.*, dcr.payload_json AS revision_payload_json, dcr.revision
      FROM decomposition_candidates dc
      JOIN decomposition_candidate_revisions dcr ON dcr.candidate_id = dc.id
      WHERE dc.id = ? ORDER BY dcr.revision DESC LIMIT 1
    `).get(id);
    if (!row) throw candidateError("DECOMPOSITION_CANDIDATE_NOT_FOUND");
    return mapCandidate(row);
  }

  listForSource(sourceId: string): DecompositionCandidateRecord[] {
    const ids = this.workspace.db.prepare(`
      SELECT id FROM decomposition_candidates WHERE source_id = ? ORDER BY created_at, id
    `).all(sourceId) as Array<{ id: string }>;
    return ids.map((row) => this.getRequired(row.id));
  }
}

function mapCandidate(row: Record<string, SQLOutputValue>): DecompositionCandidateRecord {
  const locator = JSON.parse(String(row.source_locator_json)) as { sourceChunkIds: string[] };
  return { id: String(row.id), sourceId: String(row.source_id), jobId: String(row.job_id), kind: String(row.kind) as DecompositionCandidateRecord["kind"],
    payload: JSON.parse(String(row.revision_payload_json)) as DecompositionCandidateRecord["payload"], sourceChunkIds: locator.sourceChunkIds,
    confidence: Number(row.confidence_milli) / 1000, status: String(row.status) as DecompositionCandidateRecord["status"], revision: Number(row.revision), createdAt: String(row.created_at) };
}

function candidateError(code: string): Error & { code: string } { return Object.assign(new Error("Decomposition candidate operation failed."), { code }); }
