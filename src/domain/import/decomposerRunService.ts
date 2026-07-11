import { randomUUID } from "node:crypto";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { decomposerOutputSchema, type DecomposerOutput } from "../../shared/decomposerContracts";
import type { ProviderRuntimeProfile } from "../../shared/providerContract";
import type { DecomposerPrompt } from "../../agent-worker/import/decomposerPromptRegistry";
import { SourceLibraryRepository } from "./sourceLibraryRepository";

export interface PreparedDecomposerRun {
  runId: string; jobId: string; sourceId: string;
  chunks: Array<{ id: string; locator: Record<string, unknown>; content: string; contentSha256: string }>;
}

export class DecomposerRunService {
  constructor(readonly workspace: WorkspaceDatabase) {}

  prepare(input: { sourceId: string; provider: ProviderRuntimeProfile; prompt: DecomposerPrompt }): PreparedDecomposerRun {
    if (input.prompt.status !== "active" || !input.prompt.publicationEvidence) throw runError("DECOMPOSER_PROMPT_NOT_PUBLISHED");
    new SourceLibraryRepository(this.workspace).assertCanDecompose(input.sourceId);
    const chunks = this.workspace.db.prepare(`SELECT id, locator_json, content, content_sha256 FROM source_chunks WHERE source_id = ? ORDER BY ordinal`)
      .all(input.sourceId) as Array<{ id: string; locator_json: string; content: string; content_sha256: string }>;
    if (!chunks.length) throw runError("DECOMPOSER_SOURCE_NOT_PARSED");
    const runId = randomUUID(); const jobId = randomUUID(); const now = new Date().toISOString();
    const attempt = this.workspace.db.prepare(`SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM import_jobs WHERE source_id = ? AND kind = 'decompose'`)
      .get(input.sourceId) as { attempt: number };
    const { apiKey: _apiKey, ...safeProvider } = input.provider;
    const packet = chunks.map((chunk) => ({ id: chunk.id, locator: JSON.parse(chunk.locator_json), content: chunk.content, contentSha256: chunk.content_sha256 }));
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      this.workspace.db.prepare(`INSERT INTO import_jobs (id, source_id, kind, attempt, status, started_at) VALUES (?, ?, 'decompose', ?, 'running', ?)`)
        .run(jobId, input.sourceId, attempt.attempt, now);
      this.workspace.db.prepare(`INSERT INTO decomposer_run_audits (id, job_id, source_id, provider_id, requested_model_id, provider_config_sha256,
        prompt_id, prompt_version, prompt_sha256, input_sha256, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
        .run(runId, jobId, input.sourceId, input.provider.providerId, input.provider.modelId, canonicalAuditHash(safeProvider),
          input.prompt.id, input.prompt.version, input.prompt.sha256, canonicalAuditHash(packet), now);
      const link = this.workspace.db.prepare(`INSERT INTO decomposer_run_sources (audit_id, chunk_id, content_sha256, ordinal) VALUES (?, ?, ?, ?)`);
      chunks.forEach((chunk, ordinal) => link.run(runId, chunk.id, chunk.content_sha256, ordinal));
      this.workspace.db.exec("COMMIT");
    } catch (error) { this.workspace.db.exec("ROLLBACK"); throw error; }
    return { runId, jobId, sourceId: input.sourceId, chunks: packet };
  }

  complete(input: { runId: string; output: unknown; receipt: Record<string, unknown> }): void {
    const output = decomposerOutputSchema.parse(input.output); const state = this.state(input.runId);
    const valid = new Set((this.workspace.db.prepare(`SELECT chunk_id FROM decomposer_run_sources WHERE audit_id = ?`).all(input.runId) as Array<{ chunk_id: string }>).map((row) => row.chunk_id));
    if (output.candidates.some((candidate) => candidate.sourceChunkIds.some((id) => !valid.has(id)))
      || output.unresolvedSourceChunkIds.some((id) => !valid.has(id))) throw runError("DECOMPOSER_SOURCE_MISMATCH");
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of output.candidates) {
        const id = randomUUID(); const createdAt = new Date().toISOString();
        this.workspace.db.prepare(`INSERT INTO decomposition_candidates (id, source_id, job_id, kind, payload_json, confidence_milli, source_locator_json, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
          .run(id, state.sourceId, state.jobId, candidate.kind, JSON.stringify(candidate.payload), Math.round(candidate.confidence * 1000), JSON.stringify({ sourceChunkIds: candidate.sourceChunkIds }), createdAt);
        this.workspace.db.prepare(`INSERT INTO decomposition_candidate_revisions (id, candidate_id, revision, payload_json, editor_kind, created_at) VALUES (?, ?, 1, ?, 'agent', ?)`)
          .run(randomUUID(), id, JSON.stringify(candidate.payload), createdAt);
      }
      this.finishRows(state, "succeeded", null, canonicalAuditHash(output), input.receipt);
      this.workspace.db.exec("COMMIT");
    } catch (error) { this.workspace.db.exec("ROLLBACK"); throw error; }
  }

  fail(runId: string, status: "failed" | "cancelled" | "interrupted", errorCode: string): void {
    const state = this.state(runId); this.workspace.db.exec("BEGIN IMMEDIATE");
    try { this.finishRows(state, status, errorCode.slice(0, 120), null, null); this.workspace.db.exec("COMMIT"); }
    catch (error) { this.workspace.db.exec("ROLLBACK"); throw error; }
  }

  private state(runId: string) {
    const row = this.workspace.db.prepare(`SELECT dra.job_id, dra.source_id FROM decomposer_run_audits dra JOIN import_jobs ij ON ij.id = dra.job_id
      WHERE dra.id = ? AND dra.status = 'running' AND ij.status = 'running'`).get(runId) as { job_id: string; source_id: string } | undefined;
    if (!row) throw runError("DECOMPOSER_RUN_NOT_RUNNING"); return { runId, jobId: row.job_id, sourceId: row.source_id };
  }

  private finishRows(state: { runId: string; jobId: string }, status: "succeeded" | "failed" | "cancelled" | "interrupted", errorCode: string | null, outputSha256: string | null, receipt: Record<string, unknown> | null) {
    const now = new Date().toISOString(); const jobStatus = status === "succeeded" ? "succeeded" : "failed";
    const job = this.workspace.db.prepare(`UPDATE import_jobs SET status = ?, error_code = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
      .run(jobStatus, errorCode, now, state.jobId);
    const audit = this.workspace.db.prepare(`UPDATE decomposer_run_audits SET status = ?, error_code = ?, output_sha256 = ?, receipt_json = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
      .run(status, errorCode, outputSha256, receipt ? JSON.stringify(receipt) : null, now, state.runId);
    if (job.changes !== 1 || audit.changes !== 1) throw runError("DECOMPOSER_RUN_NOT_RUNNING");
  }
}

function runError(code: string): Error & { code: string } { return Object.assign(new Error("Decomposer run operation failed."), { code }); }
