import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DecomposerAuditRepository } from "../../src/domain/import/decomposerAuditRepository";
import { ImportJobRepository } from "../../src/domain/import/importJobRepository";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { TextSourceParserService } from "../../src/domain/import/textSourceParserService";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

it("records immutable Decomposer identity, source links, and one terminal receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-decomposer-audit-")); roots.push(root);
  const filePath = path.join(root, "source.txt"); fs.writeFileSync(filePath, "source", "utf8");
  const workspace = openWorkspace(root);
  try {
    const source = new SourceLibraryRepository(workspace).register({ filePath, rightsAttestation: "user_owned" });
    const chunks = new TextSourceParserService(workspace).parse(source.id);
    const job = new ImportJobRepository(workspace).start(source.id, "decompose");
    const audit = new DecomposerAuditRepository(workspace);
    const id = audit.begin({ jobId: job.id, sourceId: source.id, providerId: "deepseek", requestedModelId: "deepseek-chat",
      providerConfigSha256: "a".repeat(64), promptId: "novax.decomposer", promptVersion: "1.0.0",
      promptSha256: "b".repeat(64), inputSha256: "c".repeat(64), sources: chunks.map((chunk) => ({ chunkId: chunk.id, contentSha256: chunk.contentSha256 })) });
    audit.terminalize({ auditId: id, status: "succeeded", errorCode: null, outputSha256: "d".repeat(64), receipt: { totalTokens: 42 } });
    expect(workspace.db.prepare("SELECT status, output_sha256, receipt_json FROM decomposer_run_audits WHERE id = ?").get(id))
      .toEqual({ status: "succeeded", output_sha256: "d".repeat(64), receipt_json: '{"totalTokens":42}' });
    try {
      audit.terminalize({ auditId: id, status: "failed", errorCode: "LATE", outputSha256: null, receipt: null });
      throw new Error("Expected terminal audit rejection.");
    } catch (error) {
      expect(error).toMatchObject({ code: "DECOMPOSER_AUDIT_NOT_RUNNING" });
    }
  } finally { workspace.close(); }
});
