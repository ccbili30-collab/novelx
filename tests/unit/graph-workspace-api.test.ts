import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { WorkspaceSession } from "../../src/main/workspaceIpc";
import { commitFixtureCheckpoint } from "../helpers/workspaceFixtures";

const roots: string[] = [];
const sessions: WorkspaceSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Semantic Graph workspace API", () => {
  it("returns a safe snapshot and node inspector from a real persisted workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-graph-workspace-api-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    const assertions = new AssertionRepository(workspace);
    const worldRootId = new ResourceRepository(workspace).listCurrent()
      .find((resource) => resource.type === "world")!.id;
    commitFixtureCheckpoint(workspace, {
      idempotencyKey: "graph-workspace-api",
      summary: "确认银湾海岸成因",
      label: "保存银湾海岸成因",
    }, (checkpointId, changeSetId) => {
      assertions.putVersion({
        assertionId: "assertion.graph.workspace-api",
        checkpointId,
        scopeType: "world",
        scopeId: worldRootId,
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { text: "沉降纪元与海水倒灌" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: changeSetId },
      });
    });
    workspace.close();

    const session = new WorkspaceSession();
    sessions.push(session);
    session.openPath(root);
    const snapshot = session.getGraphSnapshot();
    const fact = snapshot.nodes.find((node) => node.kind === "fact")!;
    const inspector = session.inspectGraphNode(fact.id);

    expect(snapshot.lens.characterLensAvailable).toBe(false);
    expect(fact).toMatchObject({
      label: "银湾海岸 · 形成原因",
      description: "沉降纪元与海水倒灌",
      status: "current",
    });
    expect(inspector.detail).toMatchObject({
      kind: "fact",
      sources: [{ type: "change_set", label: "已确认变更：确认银湾海岸成因" }],
    });
    expect(JSON.stringify({ snapshot, inspector }))
      .not.toMatch(/"(?:rawRef|ref|path|locator|checkpointId|payload|databasePath)"|workspace\.db/i);
  });

  it("fails closed when no workspace is open", () => {
    const session = new WorkspaceSession();
    sessions.push(session);
    expect(() => session.getGraphSnapshot()).toThrow(expect.objectContaining({ code: "WORKSPACE_NOT_OPEN" }));
  });
});
