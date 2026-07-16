import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileDefaultGrowthIllustrationPlan } from "../../src/main/growth/illustration/growthDefaultIllustrationPlan";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

const roots: string[] = [];
const opened: WorkspaceDatabase[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("default Growth illustration planning", () => {
  it("covers every place, faction, story and OC without duplicating the existing world map", () => {
    const setup = createSetup();
    const compiled = compileDefaultGrowthIllustrationPlan(setup.workspace, {
      checkpointId: setup.checkpointId,
      authorizedScopeResourceIds: setup.scopeRootIds,
      ruleRevision: 1,
      resourceRevisionOutputIds: setup.resourceRevisionOutputIds,
    });

    expect(compiled.coverageMode).toBe("default");
    expect(compiled.items).toHaveLength(5);
    expect(compiled.items.map((item) => [item.purpose, item.title])).toEqual([
      ["character_portrait", "白鸦 · 角色立绘"],
      ["character_portrait", "铃兰 · 角色立绘"],
      ["scene", "月港 · 世界风貌"],
      ["scene", "潮汐公会 · 世界风貌"],
      ["scene", "失落潮痕 · 故事场景"],
    ]);
    expect(compiled.items.some((item) => item.purpose === "world_map")).toBe(false);
    expect(compiled.items.every((item) => item.normalizedSources.length >= 2)).toBe(true);
    expect(JSON.stringify(compiled)).not.toContain("旁观者");
    expect(new Set(compiled.items.map((item) => item.variantKey)).size).toBe(compiled.items.length);
  });

  it("fails closed when the accepted checkpoint lacks one default visual category", () => {
    const setup = createSetup({ omitStory: true });
    expect(() => compileDefaultGrowthIllustrationPlan(setup.workspace, {
      checkpointId: setup.checkpointId,
      authorizedScopeResourceIds: setup.scopeRootIds,
      ruleRevision: 1,
      resourceRevisionOutputIds: setup.resourceRevisionOutputIds,
    })).toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_DEFAULT_TARGETS_INCOMPLETE" }));
  });
});

function createSetup(options: { omitStory?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-default-illustration-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  const checkpointId = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
  const resources = new ResourceRepository(workspace);
  const domainRoots = resources.listCurrent().filter((resource) => resource.objectKind === "domain_root");
  const worldRoot = domainRoots.find((resource) => resource.type === "world")!;
  const storyRoot = domainRoots.find((resource) => resource.type === "story")!;
  const ocRoot = domainRoots.find((resource) => resource.type === "oc")!;
  const resourceRevisionOutputIds = [
    put(resources, checkpointId, "world", "world", "潮月世界", worldRoot.id),
    put(resources, checkpointId, "location", "location", "月港", "world"),
    put(resources, checkpointId, "faction", "faction", "潮汐公会", "world"),
    ...(options.omitStory ? [] : [put(resources, checkpointId, "story", "story", "失落潮痕", storyRoot.id)]),
    put(resources, checkpointId, "oc-a", "oc", "白鸦", ocRoot.id),
    put(resources, checkpointId, "oc-b", "oc", "铃兰", ocRoot.id),
  ];
  put(resources, checkpointId, "unrelated-oc", "oc", "旁观者", ocRoot.id);
  return {
    workspace,
    checkpointId,
    scopeRootIds: [worldRoot.id, storyRoot.id, ocRoot.id],
    resourceRevisionOutputIds,
  };
}

function put(
  resources: ResourceRepository,
  checkpointId: string,
  resourceId: string,
  objectKind: "world" | "location" | "faction" | "story" | "oc",
  title: string,
  parentId: string,
): string {
  return resources.putRevisionWithReceipt({
    resourceId,
    create: true,
    checkpointId,
    type: objectKind === "story" ? "story" : objectKind === "oc" ? "oc" : "world",
    objectKind,
    title,
    parentId,
    state: "active",
  }).revisionId;
}
