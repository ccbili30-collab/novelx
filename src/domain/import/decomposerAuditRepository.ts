import { randomUUID } from "node:crypto";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export class DecomposerAuditRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  begin(input: { jobId: string; sourceId: string; providerId: string; requestedModelId: string; providerConfigSha256: string;
    promptId: string; promptVersion: string; promptSha256: string; inputSha256: string;
    sources: Array<{ chunkId: string; contentSha256: string }> }): string {
    const id = randomUUID(); const startedAt = new Date().toISOString();
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      this.workspace.db.prepare(`INSERT INTO decomposer_run_audits (
        id, job_id, source_id, provider_id, requested_model_id, provider_config_sha256,
        prompt_id, prompt_version, prompt_sha256, input_sha256, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
        .run(id, input.jobId, input.sourceId, input.providerId, input.requestedModelId, input.providerConfigSha256,
          input.promptId, input.promptVersion, input.promptSha256, input.inputSha256, startedAt);
      const insert = this.workspace.db.prepare(`INSERT INTO decomposer_run_sources
        (audit_id, chunk_id, content_sha256, ordinal) VALUES (?, ?, ?, ?)`);
      input.sources.forEach((source, ordinal) => insert.run(id, source.chunkId, source.contentSha256, ordinal));
      this.workspace.db.exec("COMMIT"); return id;
    } catch (error) { this.workspace.db.exec("ROLLBACK"); throw error; }
  }

  terminalize(input: { auditId: string; status: "succeeded" | "failed" | "cancelled" | "interrupted";
    errorCode: string | null; outputSha256: string | null; receipt: Record<string, unknown> | null }): void {
    const result = this.workspace.db.prepare(`UPDATE decomposer_run_audits SET status = ?, error_code = ?, output_sha256 = ?,
      receipt_json = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
      .run(input.status, input.errorCode?.slice(0, 120) ?? null, input.outputSha256,
        input.receipt ? JSON.stringify(input.receipt) : null, new Date().toISOString(), input.auditId);
    if (result.changes !== 1) throw auditError("DECOMPOSER_AUDIT_NOT_RUNNING");
  }
}

function auditError(code: string): Error & { code: string } {
  return Object.assign(new Error("Decomposer audit operation failed."), { code });
}
