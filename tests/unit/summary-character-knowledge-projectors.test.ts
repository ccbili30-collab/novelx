import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { CharacterKnowledgeProjector } from "../../src/domain/projection/characterKnowledgeProjector";
import { ProjectionArtifactRepository } from "../../src/domain/projection/projectionArtifactRepository";
import { ProjectionCoordinator } from "../../src/domain/projection/projectionCoordinator";
import { SummaryProjector } from "../../src/domain/projection/summaryProjector";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let workspace: WorkspaceDatabase | null = null;
let root = "";

afterEach(() => {
  workspace?.close();
  workspace = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("summary and character knowledge projections", () => {
  it("creates source-linked extractive summaries and only explicit epistemic records", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-summary-knowledge-"));
    workspace = openWorkspace(root);
    const changes = new ChangeSetRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const assertions = new AssertionRepository(workspace);
    const change = changes.propose({ idempotencyKey: "summary-knowledge", mode: "assist", summary: "记录角色认知" });
    const commitId = changes.commit(change.id, "记录角色认知", (checkpointId) => {
      const ocId = resources.putRevision({
        checkpointId, type: "oc", objectKind: "oc", title: "伊澜",
        parentId: resources.listCurrent().find((resource) => resource.type === "oc")!.id, state: "active",
      });
      const versionId = documents.putVersion({ resourceId: ocId, checkpointId, content: "伊澜在退潮时看见了沉船。\n\n她没有看见船舱里的信。", authorKind: "user" });
      assertions.putVersion({
        assertionId: "knowledge.yilan.wreck", checkpointId, scopeType: "oc", scopeId: ocId,
        subject: "伊澜", predicate: "知道", object: { knowledge: { characterId: ocId, status: "observed", fact: "退潮时出现沉船" } },
        status: "current", sources: [{ kind: "document_version", ref: versionId }],
      });
      assertions.putVersion({
        assertionId: "fact.hidden-letter", checkpointId, scopeType: "oc", scopeId: ocId,
        subject: "船舱", predicate: "藏有", object: { text: "一封信" }, status: "current",
        sources: [{ kind: "document_version", ref: versionId }],
      });
    });

    const runs = new ProjectionCoordinator(workspace, [new SummaryProjector(workspace), new CharacterKnowledgeProjector(workspace)]).runAll(commitId);
    const artifacts = new ProjectionArtifactRepository(workspace);
    const summaries = artifacts.listForRun(runs.find((run) => run.projectionKind === "summary")!.id);
    const knowledge = artifacts.listForRun(runs.find((run) => run.projectionKind === "character_knowledge")!.id);

    expect(summaries[0]).toMatchObject({ payload: { method: "extractive_first_paragraph", text: "伊澜在退潮时看见了沉船。" } });
    expect(knowledge).toHaveLength(1);
    expect(knowledge[0]).toMatchObject({ payload: { status: "observed", fact: "退潮时出现沉船" } });
    expect(JSON.stringify(knowledge)).not.toContain("一封信");
  });
});
