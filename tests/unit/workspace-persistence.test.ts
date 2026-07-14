import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("local workspace persistence", () => {
  it("creates schema 21 creative, audit, import, playthrough, task-note, and image asset storage", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-schema-6-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    opened.push(workspace);

    expect(workspace.db.prepare("SELECT version FROM schema_meta WHERE singleton = 1").get())
      .toEqual({ version: 22 });
    expect(listTables(workspace)).toEqual(expect.arrayContaining([
      "creative_documents",
      "creative_relation_versions",
      "constraint_profile_versions",
      "working_constraint_profiles",
      "creative_commits",
      "creative_commit_entries",
      "projection_runs",
      "projection_artifacts",
      "story_profiles",
      "story_profile_oc_bindings",
      "playthroughs",
      "play_turns",
      "canon_reconciliation_decisions",
      "source_library_entries",
      "source_chunks",
      "import_jobs",
      "decomposition_candidates",
      "decomposition_candidate_revisions",
      "import_review_decisions",
      "start_profiles",
      "player_agent_runs",
      "player_agent_invocations",
      "player_agent_tool_invocations",
      "player_agent_audit_events",
      "player_agent_evidence_links",
      "decomposer_run_audits",
      "decomposer_run_sources",
      "import_candidate_change_set_links",
      "project_file_versions",
      "image_generation_jobs",
      "image_assets",
    ]));
    expect(listIndexes(workspace)).toEqual(expect.arrayContaining([
      "creative_documents_resource_idx",
      "creative_relation_versions_identity_idx",
      "creative_relation_versions_target_idx",
      "constraint_profile_versions_scope_idx",
      "creative_commits_branch_idx",
      "projection_runs_commit_idx",
      "projection_artifacts_run_idx",
      "image_generation_jobs_status_idx",
      "image_assets_sha256_idx",
    ]));
    expect(workspace.db.prepare("SELECT id, kind, sealed_at FROM creative_commits").all()).toMatchObject([
      { kind: "initialization", sealed_at: null },
    ]);
  });

  it("keeps logical domain roots internal until they contain user content or are renamed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-domain-roots-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    opened.push(workspace);
    const resources = new ResourceRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const checkpoints = new CheckpointRepository(workspace);

    expect(resources.listCurrent()).toHaveLength(6);
    expect(resources.listVisibleCurrent()).toEqual([]);

    const worldRoot = resources.listCurrent().find((resource) => resource.type === "world")!;
    documents.putVersion({
      resourceId: worldRoot.id,
      checkpointId: checkpoints.getActiveBranch().headCheckpointId,
      content: "这个世界由潮汐纪元塑造。",
      authorKind: "user",
    });
    expect(resources.listVisibleCurrent()).toEqual([worldRoot]);

    const ocRoot = resources.listCurrent().find((resource) => resource.type === "oc")!;
    const renamed = new ChangeSetRepository(workspace).propose({
      idempotencyKey: "rename-legacy-oc-root",
      mode: "free",
      summary: "保留被用户改写的旧 OC 根资源",
    });
    new ChangeSetRepository(workspace).commit(renamed.id, "改写 OC 根资源", (checkpointId) => {
      resources.putRevision({
        resourceId: ocRoot.id,
        checkpointId,
        type: "oc",
        title: "群星旅者",
        parentId: null,
        state: "active",
      });
    });
    expect(resources.listVisibleCurrent().map((resource) => resource.title)).toEqual([
      "世界",
      "群星旅者",
    ]);
  });

  it("persists typed creative objects and rejects invalid ownership", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-creative-objects-"));
    roots.push(root);
    const workspace = openWorkspace(root);
    opened.push(workspace);
    const resources = new ResourceRepository(workspace);
    const changes = new ChangeSetRepository(workspace);
    const domainRoots = resources.listCurrent();
    const worldRoot = domainRoots.find((resource) => resource.type === "world")!;
    const storyRoot = domainRoots.find((resource) => resource.type === "story")!;
    expect(worldRoot.objectKind).toBe("domain_root");
    expect(storyRoot.objectKind).toBe("domain_root");

    const proposed = changes.propose({
      idempotencyKey: "typed-creative-object-tree",
      mode: "free",
      summary: "创建世界和故事层级",
    });
    changes.commit(proposed.id, "创建创作对象", (checkpointId) => {
      expect(resources.getCurrent(worldRoot.id)?.objectKind).toBe("domain_root");
      const worldId = resources.putRevision({
        checkpointId,
        type: "world",
        objectKind: "world",
        title: "潮汐世界",
        parentId: worldRoot.id,
        state: "active",
      });
      resources.putRevision({
        checkpointId,
        type: "world",
        objectKind: "location",
        title: "银湾",
        parentId: worldId,
        state: "active",
      });
      const storyId = resources.putRevision({
        checkpointId,
        type: "story",
        objectKind: "story",
        title: "潮痕",
        parentId: storyRoot.id,
        state: "active",
      });
      const volumeId = resources.putRevision({
        checkpointId,
        type: "story",
        objectKind: "volume",
        title: "第一卷",
        parentId: storyId,
        state: "active",
      });
      resources.putRevision({
        checkpointId,
        type: "story",
        objectKind: "chapter",
        title: "归潮",
        parentId: volumeId,
        state: "active",
      });

      expect(() => resources.putRevision({
        checkpointId,
        type: "story",
        objectKind: "chapter",
        title: "非法章节",
        parentId: worldId,
        state: "active",
      })).toThrowError(expect.objectContaining({ code: "RESOURCE_PARENT_KIND_INVALID" }));
    });

    expect(resources.listVisibleCurrent().map(({ title, objectKind }) => ({ title, objectKind })))
      .toEqual(expect.arrayContaining([
        { title: "潮汐世界", objectKind: "world" },
        { title: "银湾", objectKind: "location" },
        { title: "潮痕", objectKind: "story" },
        { title: "第一卷", objectKind: "volume" },
        { title: "归潮", objectKind: "chapter" },
      ]));
  });

  it("persists an idempotent committed Change Set and sourced assertion across restart", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-workspace-"));
    roots.push(root);
    let workspace = openWorkspace(root);
    opened.push(workspace);
    const changes = new ChangeSetRepository(workspace);
    const assertions = new AssertionRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const proposed = changes.propose({
      idempotencyKey: "coastline-1",
      mode: "assist",
      summary: "记录银湾海岸成因",
    });

    expect(changes.propose({
      idempotencyKey: "coastline-1",
      mode: "assist",
      summary: "记录银湾海岸成因",
    }).id).toBe(proposed.id);

    changes.commit(proposed.id, "接受海岸设定", (checkpointId) => {
      const resourceId = resources.putRevision({
        checkpointId,
        type: "world",
        title: "银湾海岸",
        parentId: resources.listCurrent().find((resource) => resource.type === "world")!.id,
        state: "active",
      });
      documents.putVersion({
        resourceId,
        checkpointId,
        content: "银湾海岸由沉降纪元塑造。",
        authorKind: "user",
      });
      assertions.putVersion({
        assertionId: "assertion.coastline",
        checkpointId,
        scopeType: "world",
        scopeId: "world.silver-bay",
        subject: "银湾海岸",
        predicate: "形成原因",
        object: { text: "沉降纪元造成差异侵蚀与海水倒灌。" },
        status: "current",
        source: { kind: "confirmed_change_set", ref: proposed.id },
      });
    });
    const coastResource = resources.listCurrent().find((resource) => resource.title === "银湾海岸")!;
    documents.saveWorkingCopy({ resourceId: coastResource.id, content: "尚未形成检查点的海岸补充。" });

    workspace.close();
    opened.splice(opened.indexOf(workspace), 1);
    workspace = openWorkspace(root);
    opened.push(workspace);

    expect(new ChangeSetRepository(workspace).get(proposed.id)?.status).toBe("committed");
    expect(new ResourceRepository(workspace).listCurrent()
      .filter((resource) => resource.parentId === null)
      .map(({ type, title }) => ({ type, title }))).toEqual([
      { type: "world", title: "世界" },
      { type: "oc", title: "OC" },
      { type: "story", title: "故事" },
      { type: "graph", title: "图谱" },
      { type: "timeline", title: "时间线" },
      { type: "asset", title: "资产" },
    ]);
    expect(new AssertionRepository(workspace).listCurrent()).toMatchObject([
      { assertionId: "assertion.coastline", object: { text: "沉降纪元造成差异侵蚀与海水倒灌。" } },
    ]);
    const reopenedResources = new ResourceRepository(workspace);
    const reopenedCoast = reopenedResources.listCurrent().find((resource) => resource.title === "银湾海岸")!;
    const reopenedDocuments = new DocumentRepository(workspace);
    expect(reopenedDocuments.getCurrentStable(reopenedCoast.id)?.content).toBe("银湾海岸由沉降纪元塑造。");
    expect(reopenedDocuments.getWorkingCopy(reopenedCoast.id)).toMatchObject({
      content: "尚未形成检查点的海岸补充。",
      dirty: true,
    });
  });
});

function listTables(workspace: WorkspaceDatabase): string[] {
  return (workspace.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function listIndexes(workspace: WorkspaceDatabase): string[] {
  return (workspace.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}
