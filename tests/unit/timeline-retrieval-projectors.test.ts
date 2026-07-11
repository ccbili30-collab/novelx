import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { ProjectionArtifactRepository } from "../../src/domain/projection/projectionArtifactRepository";
import { ProjectionCoordinator } from "../../src/domain/projection/projectionCoordinator";
import { RetrievalProjector } from "../../src/domain/projection/retrievalProjector";
import { TimelineProjector } from "../../src/domain/projection/timelineProjector";
import { RetrievalIndexService } from "../../src/domain/retrieval/retrievalIndexService";
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

describe("timeline and retrieval projections", () => {
  it("projects only explicit temporal facts and returns ranked FTS evidence", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-memory-projection-"));
    workspace = openWorkspace(root);
    const changes = new ChangeSetRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const assertions = new AssertionRepository(workspace);
    const change = changes.propose({ idempotencyKey: "memory-projection", mode: "assist", summary: "记录潮汐纪元" });
    let worldId = "";
    const commitId = changes.commit(change.id, "记录潮汐纪元", (checkpointId) => {
      worldId = resources.putRevision({
        checkpointId,
        type: "world",
        objectKind: "world",
        title: "银湾世界",
        parentId: resources.listCurrent().find((resource) => resource.type === "world")!.id,
        state: "active",
      });
      const documentVersionId = documents.putVersion({
        resourceId: worldId,
        checkpointId,
        content: "银湾拥有由沉降纪元塑造的曲折海岸。",
        authorKind: "user",
      });
      assertions.putVersion({
        assertionId: "event.sinking-era",
        checkpointId,
        scopeType: "world",
        scopeId: worldId,
        subject: "沉降纪元",
        predicate: "发生",
        object: { text: "海岸大规模沉降", temporal: { kind: "instant", value: "纪元-1200", label: "沉降纪元" } },
        status: "current",
        sources: [{ kind: "document_version", ref: documentVersionId }],
      });
      assertions.putVersion({
        assertionId: "fact.coast",
        checkpointId,
        scopeType: "world",
        scopeId: worldId,
        subject: "银湾海岸",
        predicate: "地貌",
        object: { text: "曲折海岸" },
        status: "current",
        sources: [{ kind: "document_version", ref: documentVersionId }],
      });
    });

    const runs = new ProjectionCoordinator(workspace, [new TimelineProjector(workspace), new RetrievalProjector(workspace)]).runAll(commitId);
    const timelineRun = runs.find((run) => run.projectionKind === "timeline")!;
    const retrievalRun = runs.find((run) => run.projectionKind === "retrieval")!;
    const timeline = new ProjectionArtifactRepository(workspace).listForRun(timelineRun.id);
    const hits = new RetrievalIndexService(workspace).search({ commitId, query: "曲折海岸" });

    expect(timelineRun.status).toBe("succeeded");
    expect(retrievalRun.status).toBe("succeeded");
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ artifactKey: "event:event.sinking-era", payload: { temporal: { kind: "instant", value: "纪元-1200" } } });
    expect(hits.some((hit) => hit.content.includes("曲折海岸"))).toBe(true);
  });

  it("does not silently fall back when the retrieval index is unavailable", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-memory-unavailable-"));
    workspace = openWorkspace(root);
    workspace.db.prepare("UPDATE retrieval_index_capability SET available = 0 WHERE singleton = 1").run();
    try {
      new RetrievalIndexService(workspace).search({ commitId: "missing", query: "海岸" });
      throw new Error("Expected retrieval to fail closed.");
    } catch (error) {
      expect(error).toMatchObject({ code: "RETRIEVAL_FTS5_UNAVAILABLE" });
    }
  });
});
