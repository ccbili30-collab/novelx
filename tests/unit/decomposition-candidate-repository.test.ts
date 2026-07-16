import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DecompositionCandidateRepository } from "../../src/domain/import/decompositionCandidateRepository";
import { ImportJobRepository } from "../../src/domain/import/importJobRepository";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { TextSourceParserService } from "../../src/domain/import/textSourceParserService";
import { removePostV22GrowthSchema } from "../support/legacyWorkspaceFixture";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let workspace: WorkspaceDatabase | null = null;
let root = "";
afterEach(() => { workspace?.close(); workspace = null; if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("DecompositionCandidateRepository", () => {
  it("keeps source-linked candidates non-canonical until immutable human review", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-decomposition-candidate-"));
    const filePath = path.join(root, "world.md");
    fs.writeFileSync(filePath, "# 世界\n银湾海岸由沉降形成。", "utf8");
    workspace = openWorkspace(root);
    const source = new SourceLibraryRepository(workspace).register({ filePath, rightsAttestation: "user_owned" });
    const [chunk] = new TextSourceParserService(workspace).parse(source.id);
    const jobs = new ImportJobRepository(workspace);
    const job = jobs.start(source.id, "decompose");
    const candidates = new DecompositionCandidateRepository(workspace);
    const [candidate] = candidates.appendOutput({ sourceId: source.id, jobId: job.id, output: {
      candidates: [{ kind: "world_rule", sourceChunkIds: [chunk!.id], confidence: 0.92, payload: { subject: "银湾海岸", predicate: "形成原因", value: "沉降" } }],
      unresolvedSourceChunkIds: [],
    } });

    expect(candidate).toMatchObject({ kind: "world_rule", status: "pending", revision: 1, sourceChunkIds: [chunk!.id] });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM assertion_versions").get()).toEqual({ count: 0 });
    const revised = candidates.revise(candidate!.id, { subject: "银湾海岸", predicate: "形成原因", value: "沉降纪元的地壳下陷" });
    expect(revised).toMatchObject({ revision: 2, payload: { value: "沉降纪元的地壳下陷" } });
    const accepted = candidates.decide(candidate!.id, "accepted");
    expect(accepted.status).toBe("accepted");
    expect(() => candidates.revise(candidate!.id, revised.payload)).toThrow();
    expect(workspace.db.prepare("SELECT decision, candidate_revision FROM import_review_decisions").get()).toEqual({ decision: "accepted", candidate_revision: 2 });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM assertion_versions").get()).toEqual({ count: 0 });
  });

  it("rejects candidate evidence from a different source", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-decomposition-source-"));
    const one = path.join(root, "one.txt"); const two = path.join(root, "two.txt");
    fs.writeFileSync(one, "来源一", "utf8"); fs.writeFileSync(two, "来源二", "utf8");
    workspace = openWorkspace(root);
    const sources = new SourceLibraryRepository(workspace);
    const sourceOne = sources.register({ filePath: one, rightsAttestation: "user_owned" });
    const sourceTwo = sources.register({ filePath: two, rightsAttestation: "user_owned" });
    const foreignChunk = new TextSourceParserService(workspace).parse(sourceTwo.id)[0]!;
    const job = new ImportJobRepository(workspace).start(sourceOne.id, "decompose");
    expect(() => new DecompositionCandidateRepository(workspace!).appendOutput({ sourceId: sourceOne.id, jobId: job.id, output: {
      candidates: [{ kind: "style", sourceChunkIds: [foreignChunk.id], confidence: 0.5, payload: { description: "冷峻" } }], unresolvedSourceChunkIds: [],
    } })).toThrow();
  });

  it("backfills revision one when upgrading a v13 candidate", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-decomposition-migration-"));
    const filePath = path.join(root, "legacy.txt");
    fs.writeFileSync(filePath, "旧版候选来源", "utf8");
    workspace = openWorkspace(root);
    const source = new SourceLibraryRepository(workspace).register({ filePath, rightsAttestation: "user_owned" });
    const chunk = new TextSourceParserService(workspace).parse(source.id)[0]!;
    const job = new ImportJobRepository(workspace).start(source.id, "decompose");
    const [candidate] = new DecompositionCandidateRepository(workspace).appendOutput({ sourceId: source.id, jobId: job.id, output: {
      candidates: [{ kind: "style", sourceChunkIds: [chunk.id], confidence: 0.7, payload: { description: "克制" } }], unresolvedSourceChunkIds: [],
    } });
    workspace.db.prepare("DELETE FROM decomposition_candidate_revisions WHERE candidate_id = ?").run(candidate!.id);
    removePostV22GrowthSchema(workspace.db);
    workspace.db.prepare("UPDATE schema_meta SET version = 13 WHERE singleton = 1").run();
    workspace.close();
    workspace = null;
    workspace = openWorkspace(root);

    expect(new DecompositionCandidateRepository(workspace).getRequired(candidate!.id)).toMatchObject({
      id: candidate!.id, revision: 1, payload: { description: "克制" },
    });
  });
});
