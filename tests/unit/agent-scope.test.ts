import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "../../src/shared/ipcContract";
import { resolveAgentScopeResourceIds } from "../../src/shared/agentScope";

describe("Agent project scope", () => {
  it("uses the selected object when one is explicit", () => {
    expect(resolveAgentScopeResourceIds(workspace(), "story-1")).toEqual(["story-1"]);
  });

  it("uses existing project objects when Agent mode has no explicit selection", () => {
    expect(resolveAgentScopeResourceIds(workspace(), null)).toEqual(["world-1", "story-1"]);
  });

  it("falls back to project domain roots when an initialized project has no creative objects", () => {
    const empty = workspace();
    empty.resources = empty.resources.filter((resource) => resource.objectKind === "domain_root");
    expect(resolveAgentScopeResourceIds(empty, null)).toEqual(["root-world", "root-story"]);
  });
});

function workspace(): WorkspaceSnapshot {
  return {
    workspaceId: "workspace-1",
    name: "project",
    activeBranchId: "branch-1",
    resources: [
      { id: "root-world", type: "world", objectKind: "domain_root", title: "worlds", parentId: null },
      { id: "root-story", type: "story", objectKind: "domain_root", title: "stories", parentId: null },
      { id: "world-1", type: "world", objectKind: "world", title: "world", parentId: "root-world" },
      { id: "story-1", type: "story", objectKind: "story", title: "story", parentId: "root-story" },
    ],
    documents: [],
    relations: [],
    constraintProfiles: [],
  };
}
