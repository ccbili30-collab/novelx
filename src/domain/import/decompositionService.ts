import type { ProviderRuntimeProfile } from "../../shared/providerContract";
import { runDecomposer } from "../../agent-worker/import/decomposerRuntime";
import type { DecomposerPrompt } from "../../agent-worker/import/decomposerPromptRegistry";
import type { RuntimeAdapter } from "../../agent-worker/pi/runtimeAdapterContract";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";
import { DecompositionCandidateRepository, type DecompositionCandidateRecord } from "./decompositionCandidateRepository";
import { ImportJobRepository } from "./importJobRepository";
import { SourceLibraryRepository } from "./sourceLibraryRepository";

export class DecompositionService {
  constructor(readonly workspace: WorkspaceDatabase) {}

  async decompose(input: {
    sourceId: string;
    providerProfile: ProviderRuntimeProfile;
    prompt: DecomposerPrompt;
    createAdapter(profile: ProviderRuntimeProfile): RuntimeAdapter;
    signal: AbortSignal;
  }): Promise<DecompositionCandidateRecord[]> {
    new SourceLibraryRepository(this.workspace).assertCanDecompose(input.sourceId);
    const chunks = this.workspace.db.prepare(`
      SELECT id, locator_json, content, content_sha256 FROM source_chunks WHERE source_id = ? ORDER BY ordinal
    `).all(input.sourceId) as Array<{ id: string; locator_json: string; content: string; content_sha256: string }>;
    if (!chunks.length) throw serviceError("DECOMPOSER_SOURCE_NOT_PARSED");
    const jobs = new ImportJobRepository(this.workspace);
    const job = jobs.start(input.sourceId, "decompose");
    try {
      const output = await runDecomposer({
        chunks: chunks.map((chunk) => ({ id: chunk.id, locator: JSON.parse(chunk.locator_json) as Record<string, unknown>, content: chunk.content, contentSha256: chunk.content_sha256 })),
        providerProfile: input.providerProfile,
        prompt: input.prompt,
        createAdapter: input.createAdapter,
        signal: input.signal,
      });
      const candidates = new DecompositionCandidateRepository(this.workspace).appendOutput({ sourceId: input.sourceId, jobId: job.id, output });
      jobs.succeed(job.id);
      return candidates;
    } catch (error) {
      jobs.fail(job.id, publicCode(error));
      throw error;
    }
  }
}

function publicCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code).slice(0, 120) : "DECOMPOSITION_FAILED";
}

function serviceError(code: string): Error & { code: string } {
  return Object.assign(new Error("Decomposition service failed."), { code });
}
