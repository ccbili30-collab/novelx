import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { DecompositionCandidateRepository } from "../../src/domain/import/decompositionCandidateRepository";
import { ImportCandidateChangeSetService } from "../../src/domain/import/importCandidateChangeSetService";
import { ImportJobRepository } from "../../src/domain/import/importJobRepository";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { TextSourceParserService } from "../../src/domain/import/textSourceParserService";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";

const roots: string[] = []; afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

it("proposes accepted imported facts and objects with immutable candidate provenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-import-change-set-")); roots.push(root); const workspace = openWorkspace(root);
  try {
    const resources = new ResourceRepository(workspace); const changes = new ChangeSetRepository(workspace); const setup = changes.propose({ idempotencyKey: "target-world", mode: "assist", summary: "建立目标世界" }); let worldId = "";
    changes.commit(setup.id, "建立目标世界", (checkpointId) => { const rootResource = resources.listCurrent().find((item) => item.type === "world")!; worldId = resources.putRevision({ checkpointId, type: "world", objectKind: "world", title: "银湾", parentId: rootResource.id, state: "active" }); });
    const filePath = path.join(root, "source.txt"); fs.writeFileSync(filePath, "银湾只在退潮时开放。", "utf8"); const source = new SourceLibraryRepository(workspace).register({ filePath, rightsAttestation: "user_owned" }); const chunks = new TextSourceParserService(workspace).parse(source.id); const job = new ImportJobRepository(workspace).start(source.id, "decompose");
    const [rule, location] = new DecompositionCandidateRepository(workspace).appendOutput({ sourceId: source.id, jobId: job.id, output: { candidates: [
      { kind: "world_rule", sourceChunkIds: [chunks[0]!.id], confidence: 0.95, payload: { subject: "银湾", predicate: "开放条件", value: "退潮" } },
      { kind: "location", sourceChunkIds: [chunks[0]!.id], confidence: 0.8, payload: { name: "银湾洞穴", description: "退潮时开放" } },
    ], unresolvedSourceChunkIds: [] } }); new ImportJobRepository(workspace).succeed(job.id);
    const candidates = new DecompositionCandidateRepository(workspace); candidates.decide(rule!.id, "accepted"); candidates.decide(location!.id, "accepted");
    const proposal = new ImportCandidateChangeSetService(workspace).propose({ sourceId: source.id, targetResourceId: worldId, candidateIds: [rule!.id, location!.id] });
    expect(proposal).toMatchObject({ mode: "assist", status: "pending", gateStatus: "review_pending" }); expect(proposal.items.map((item) => item.kind).sort()).toEqual(["assertion.put", "creative_document.put", "document.put", "resource.put"]);
    expect(workspace.db.prepare("SELECT candidate_id, candidate_revision, change_set_id, item_id FROM import_candidate_change_set_links ORDER BY candidate_id, item_id").all()).toHaveLength(4);
    const assertion = proposal.items.find((item) => item.kind === "assertion.put")!; expect(assertion.payload).toMatchObject({ scopeType: "world", scopeId: worldId, evidenceIds: [rule!.id] });
  } finally { workspace.close(); }
});
