import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import {
  ChangeSetService,
  greenfieldDocumentOutputEvidence,
  type ChangeSetPolicyEvaluator,
} from "../../src/domain/changeSet/changeSetService";
import { WorkspaceChangeSetPolicy } from "../../src/domain/changeSet/workspaceChangeSetPolicy";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { CausalRelationRepository } from "../../src/domain/graph/causalRelationRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { createWorkspaceAgentToolGateway } from "../../src/main/workspaceAgentToolGateway";
import { ImageAssetRepository } from "../../src/domain/asset/imageAssetRepository";
import { ImageAssetStore } from "../../src/domain/asset/imageAssetStore";
import { ImageGenerationService } from "../../src/domain/asset/imageGenerationService";
import { ResponsesImageProviderError } from "../../src/domain/asset/responsesImageProviderClient";
import { compileGrowthWorldFragment } from "../../src/agent-worker/growth/growthWorldFragment";
import { compileGrowthStoryFragment } from "../../src/agent-worker/growth/growthStoryFragment";
import { compileGrowthOcFragment } from "../../src/agent-worker/growth/growthOcFragment";
import type { ProposeChangeSetArgs } from "../../src/shared/agentWorkerProtocol";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const opened: Array<{ root: string; workspace: WorkspaceDatabase }> = [];

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.workspace.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

describe("Workspace Agent tool gateway", () => {
  it("retrieves scoped evidence without exposing the workspace path", async () => {
    const { workspace } = createWorkspace();
    const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true);
    const result = await gateway.retrieveGraphEvidence(
      { scopeResourceIds: [world.id] },
      invocationContext("assist"),
    );

    expect(result.scopes).toEqual([{ resourceId: world.id, type: "world", title: "世界" }]);
    expect(result.retrieval).toMatchObject({
      budget: {
        maxDocuments: 12,
        maxAssertions: 200,
        maxDocumentChars: 20_000,
        totalChars: 160_000,
      },
      completeness: {
        incomplete: false,
        omittedAssertions: 0,
        omittedDocuments: 0,
        truncatedDocuments: 0,
      },
      ordering: { relevanceRanking: "not_applied" },
    });
    expect(JSON.stringify(result)).not.toContain(workspace.rootPath);
    expect(JSON.stringify(result)).not.toContain("workspace.db");
  });

  it("creates only a policy-evaluated Assist candidate using Main-owned mode and checkpoint", async () => {
    const { workspace } = createWorkspace();
    const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    seedProposeTool(workspace);
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true);
    const result = await gateway.proposeChangeSet({
      summary: "补充海岸形成原因",
      items: [{
        id: "coast-1",
        dependsOn: [],
        kind: "assertion.put",
        payload: {
          assertionId: "silver-bay-coast-origin",
          scopeType: "world",
          scopeId: world.id,
          subject: "银湾海岸",
          predicate: "形成原因",
          object: { cause: "板块抬升与海蚀共同作用" },
          evidenceIds: ["evidence-version-1"],
        },
      }],
    }, invocationContext("assist"));

    expect(result).toMatchObject({
      mode: "assist",
      status: "pending",
      gateStatus: "review_pending",
      itemCount: 1,
    });
  });

  it("commits an explicit Free Greenfield package and returns only output versions recorded for that Change Set", async () => {
    const { workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    seedProposeTool(workspace);
    const gateway = createWorkspaceAgentToolGateway(workspace, new WorkspaceChangeSetPolicy(workspace), () => true);
    const result = await gateway.proposeChangeSet({
      summary: "创建雾港群岛世界包",
      items: greenfieldWorldItems(worldRoot.id),
    }, invocationContext("free", true));

    expect(result).toMatchObject({ mode: "free", status: "committed", gateStatus: "ready", itemCount: 3 });
    const committedOutputs = result.committedOutputs ?? [];
    expect(committedOutputs).toHaveLength(3);
    expect(committedOutputs).toEqual(new ChangeSetRepository(workspace).listOutputs(result.changeSetId)
      .map(({ itemId, kind, outputId }) => ({ itemId, kind, outputId })));
    const documentOutput = committedOutputs.find((output) => output.itemId === "world-document")!;
    const assertion = new AssertionRepository(workspace).listCurrentInScopes(["world.greenfield"])[0]!;
    expect(assertion.sources).toContainEqual({ kind: "evidence_version", ref: documentOutput.outputId });
    expect(assertion.sources.some((source) => source.ref === greenfieldDocumentOutputEvidence("world-document"))).toBe(false);
  });

  it("commits and audits a source-bound causal relation through the real Free Greenfield gateway", async () => {
    const { workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    seedProposeTool(workspace);
    const gateway = createWorkspaceAgentToolGateway(workspace, new WorkspaceChangeSetPolicy(workspace), () => true);
    const items = greenfieldWorldItems(worldRoot.id);
    items.push({
      id: "route-assertion",
      dependsOn: ["world-resource", "world-document"],
      kind: "assertion.put",
      payload: {
        assertionId: "assertion.greenfield.route-shift",
        scopeType: "world",
        scopeId: "world.greenfield",
        subject: "商路",
        predicate: "迁移",
        object: { direction: "north" },
        evidenceIds: [greenfieldDocumentOutputEvidence("world-document")],
      },
    }, {
      id: "causal-relation",
      dependsOn: ["world-document", "world-assertion", "route-assertion"],
      kind: "causal_relation.put",
      payload: {
        relationId: "relation.greenfield.moon-route",
        relationKind: "causes",
        causeAssertionId: "assertion.greenfield.moon-tide",
        causeAssertionItemId: "world-assertion",
        effectAssertionId: "assertion.greenfield.route-shift",
        effectAssertionItemId: "route-assertion",
        mechanism: "月潮改变浅滩可航窗口。",
        conditions: ["强月潮"],
        temporalScope: "涨潮后三小时",
        polarityStrengthSummary: "强正向",
        epistemicStatus: "confirmed",
        sourceBindings: [{
          evidenceId: greenfieldDocumentOutputEvidence("world-document"),
          stableLocator: "paragraph:1",
        }],
      },
    });

    const result = await gateway.proposeChangeSet({ summary: "创建带因果链的雾港世界", items }, invocationContext("free", true));
    expect(result).toMatchObject({ status: "committed", itemCount: 5 });
    expect(result.committedOutputs?.map((output) => output.kind)).toContain("causal_relation_version");
    const causalOutput = result.committedOutputs?.find((output) => output.kind === "causal_relation_version")!;
    const branchId = new CheckpointRepository(workspace).getActiveBranch().id;
    expect(new CausalRelationRepository(workspace).listCurrent(branchId)).toEqual([
      expect.objectContaining({ id: "relation.greenfield.moon-route", kind: "causes" }),
    ]);
    expect(new AgentAuditRepository(workspace).listLinks("run-test-only")).toContainEqual(expect.objectContaining({
      link_kind: "causal_relation_version_output",
      target_id: causalOutput.outputId,
    }));
    expect(new AgentAuditRepository(workspace).getArtifactProvenance(
      "causal_relation_version", causalOutput.outputId,
    )).toMatchObject({
      artifactKind: "causal_relation_version",
      artifactId: causalOutput.outputId,
      changeSetId: result.changeSetId,
      toolInvocationId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("commits an ordering-independent compiled world Fragment through the real Free Greenfield gateway", async () => {
    const { workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    seedProposeTool(workspace);
    const initialCheckpoint = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
    const args = compileGrowthWorldFragment({
      summary: "Create a source-bound world.",
      world: { localId: "world", title: "Tide World" },
      entities: [
        { localId: "pier", kind: "location", title: "Pier", parentRef: "harbor" },
        { localId: "harbor", kind: "location", title: "Harbor", parentRef: "world" },
      ],
      documents: [{ localId: "setting", ownerRef: "world", kind: "setting", title: "Setting", content: "The tide governs the harbor, drawing saltwater through the old piers at dawn and leaving silver channels across the market stones by noon. Harbor families read the moon tables before they trade, while watchkeepers keep the lantern towers lit whenever the current turns rough. Every new voyage is planned around the floodgates, and every home keeps a brass tide bell beside its door." }],
      assertions: [
        { localId: "tide", scopeRef: "world", subject: "tide", predicate: "governs", object: { target: "harbor" }, sourceDocumentRefs: ["setting"] },
        { localId: "moon", scopeRef: "world", subject: "families", predicate: "read", object: { target: "moon tables" }, sourceDocumentRefs: ["setting"] },
        { localId: "lantern", scopeRef: "world", subject: "watchkeepers", predicate: "maintain", object: { target: "lantern towers" }, sourceDocumentRefs: ["setting"] },
      ],
      relations: [{ localId: "world-harbor", sourceRef: "world", targetRef: "harbor" }],
    }, { cycleId: "cycle-compiled", worldRootResourceId: worldRoot.id });
    const gateway = createWorkspaceAgentToolGateway(workspace, new WorkspaceChangeSetPolicy(workspace), () => true);
    const result = await gateway.proposeChangeSet(args, invocationContext("free", true));
    expect(result).toMatchObject({ mode: "free", status: "committed", gateStatus: "ready" });
    const head = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
    expect(head).not.toBe(initialCheckpoint);
    const outputs = new ChangeSetRepository(workspace).listOutputs(result.changeSetId);
    expect(result.committedOutputs).toEqual(outputs.map(({ itemId, kind, outputId }) => ({ itemId, kind, outputId })));
    expect(Number((workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get() as { count: number }).count)).toBe(1);
    const resources = new ResourceRepository(workspace).listCurrent();
    const world = resources.find((resource) => resource.title === "Tide World")!;
    const harbor = resources.find((resource) => resource.title === "Harbor")!;
    const pier = resources.find((resource) => resource.title === "Pier")!;
    expect(harbor.parentId).toBe(world.id);
    expect(pier.parentId).toBe(harbor.id);
    const assertion = new AssertionRepository(workspace).listCurrentInScopes([world.id])[0]!;
    const document = new DocumentRepository(workspace).getCurrentStable(world.id)!;
    const documentOutput = outputs.find((output) => output.kind === "document_version")!;
    expect(document).toBeDefined();
    expect(assertion.sources).toContainEqual({ kind: "evidence_version", ref: documentOutput.outputId });
    expect(assertion.sources.some((source) => source.ref.startsWith("greenfield_document_output:"))).toBe(false);
    expect(outputs.some((output) => output.kind.startsWith("project_file"))).toBe(false);
  });

  it("rejects an invalid Fragment parent kind before Gateway submission leaves any durable state", () => {
    const { workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    let code: string | null = null;
    try { compileGrowthWorldFragment({
      summary: "Invalid parent shape.", world: { localId: "world", title: "World" },
      entities: [{ localId: "faction", kind: "faction", title: "Faction" }, { localId: "location", kind: "location", title: "Location", parentRef: "faction" }],
      documents: [{ localId: "setting", ownerRef: "world", kind: "setting", title: "Setting", content: "Source." }],
      assertions: [
        { localId: "fact", scopeRef: "world", subject: "subject", predicate: "predicate", object: { value: "fact" }, sourceDocumentRefs: ["setting"] },
        { localId: "fact-two", scopeRef: "world", subject: "subject two", predicate: "predicate", object: { value: "fact two" }, sourceDocumentRefs: ["setting"] },
        { localId: "fact-three", scopeRef: "world", subject: "subject three", predicate: "predicate", object: { value: "fact three" }, sourceDocumentRefs: ["setting"] },
      ], relations: [],
    }, { cycleId: "cycle-invalid-parent", worldRootResourceId: worldRoot.id }); } catch (error) { code = (error as { code?: string }).code ?? null; }
    expect(code).toBe("GROWTH_FRAGMENT_PARENT_KIND_INVALID");
    expect(Number((workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get() as { count: number }).count)).toBe(0);
    expect(Number((workspace.db.prepare("SELECT COUNT(*) AS count FROM change_set_outputs").get() as { count: number }).count)).toBe(0);
    expect(Number((workspace.db.prepare("SELECT COUNT(*) AS count FROM resource_revisions WHERE object_kind <> 'domain_root'").get() as { count: number }).count)).toBe(0);
  });

  it("commits a compiled Story Fragment with Writer prose and one uses_world relation", async () => {
    const { workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    seedProposeTool(workspace);
    const gateway = createWorkspaceAgentToolGateway(workspace, new WorkspaceChangeSetPolicy(workspace), () => true);
    const worldResult = await gateway.proposeChangeSet({ summary: "World", items: greenfieldWorldItems(worldRoot.id) }, invocationContext("free", true));
    const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.objectKind === "world")!;
    const storyRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "story" && resource.objectKind === "domain_root")!;
    const initialHead = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
    const args = compileGrowthStoryFragment({ summary: "Story", story: { localId: "story", title: "Story" }, prose: { localId: "prose", title: "Prose" } }, {
      cycleId: "cycle-story", storyRootResourceId: storyRoot.id, writerCandidateText: "Writer prose exactly.", writerEvidenceIds: ["world-evidence"], worldEvidenceId: "world-evidence", worldResourceId: world.id,
    });
    seedTool(workspace, "propose_change_set", "22222222-2222-4222-8222-222222222222");
    const result = await gateway.proposeChangeSet(args, { ...invocationContext("free"), requestId: "22222222-2222-4222-8222-222222222222" });
    expect(result).toMatchObject({ status: "committed", itemCount: 4 });
    expect(new CheckpointRepository(workspace).getActiveBranch().headCheckpointId).not.toBe(initialHead);
    expect(new ChangeSetRepository(workspace).listOutputs(result.changeSetId)).toHaveLength(4);
    const story = new ResourceRepository(workspace).listCurrent().find((resource) => resource.objectKind === "story" && resource.parentId === storyRoot.id)!;
    expect(new DocumentRepository(workspace).getCurrentStable(story.id)?.content).toBe("Writer prose exactly.");
    const relation = workspace.db.prepare("SELECT source_resource_id, target_resource_id, kind FROM creative_relation_versions ORDER BY created_at DESC LIMIT 1").get() as { source_resource_id: string; target_resource_id: string; kind: string };
    expect(relation).toEqual({ source_resource_id: story.id, target_resource_id: world.id, kind: "uses_world" });
    expect(worldResult.changeSetId).not.toBe(result.changeSetId);
  });

  it("commits a compiled OC Fragment with profile documents, uses_oc, and requested related_to relations", async () => {
    const { workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    seedProposeTool(workspace);
    const gateway = createWorkspaceAgentToolGateway(workspace, new WorkspaceChangeSetPolicy(workspace), () => true);
    const worldResult = await gateway.proposeChangeSet({ summary: "World", items: greenfieldWorldItems(worldRoot.id) }, invocationContext("free", true));
    const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.objectKind === "world")!;
    const storyRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "story" && resource.objectKind === "domain_root")!;
    const storyArgs = compileGrowthStoryFragment({ summary: "Story", story: { localId: "story", title: "Story" }, prose: { localId: "prose", title: "Prose" } }, {
      cycleId: "cycle-story", storyRootResourceId: storyRoot.id, writerCandidateText: "Writer prose exactly.", writerEvidenceIds: ["world-evidence"], worldEvidenceId: "world-evidence", worldResourceId: world.id,
    });
    seedTool(workspace, "propose_change_set", "22222222-2222-4222-8222-222222222222");
    const storyResult = await gateway.proposeChangeSet(storyArgs, { ...invocationContext("free"), requestId: "22222222-2222-4222-8222-222222222222" });
    const story = new ResourceRepository(workspace).listCurrent().find((resource) => resource.objectKind === "story" && resource.parentId === storyRoot.id)!;
    const ocRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "oc" && resource.objectKind === "domain_root")!;
    const profile = "A focused OC profile with motives, history, loyalties, fears, and a role in the current story. ".repeat(2).trim();
    const args = compileGrowthOcFragment({
      summary: "OCs", characters: [
        { localId: "captain", title: "Captain", profile: { localId: "captain-profile", title: "Captain profile", content: profile } },
        { localId: "navigator", title: "Navigator", profile: { localId: "navigator-profile", title: "Navigator profile", content: profile } },
      ], relationships: [{ localId: "crew", sourceRef: "captain", targetRef: "navigator" }],
    }, { cycleId: "cycle-oc", ocRootResourceId: ocRoot.id, storyResourceId: story.id });
    const initialHead = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
    seedTool(workspace, "propose_change_set", "33333333-3333-4333-8333-333333333333");
    const result = await gateway.proposeChangeSet(args, { ...invocationContext("free"), requestId: "33333333-3333-4333-8333-333333333333" });
    expect(result).toMatchObject({ status: "committed", itemCount: 9 });
    expect(new CheckpointRepository(workspace).getActiveBranch().headCheckpointId).not.toBe(initialHead);
    const outputs = new ChangeSetRepository(workspace).listOutputs(result.changeSetId);
    expect(result.committedOutputs).toEqual(outputs.map(({ itemId, kind, outputId }) => ({ itemId, kind, outputId })));
    expect(outputs).toHaveLength(9);
    const ocs = new ResourceRepository(workspace).listCurrent().filter((resource) => resource.objectKind === "oc" && resource.parentId === ocRoot.id);
    expect(ocs).toHaveLength(2);
    expect(ocs.map((oc) => new DocumentRepository(workspace).getCurrentStable(oc.id)?.content)).toEqual([profile, profile]);
    const relations = workspace.db.prepare("SELECT source_resource_id, target_resource_id, kind FROM creative_relation_versions ORDER BY created_at, id").all() as Array<{ source_resource_id: string; target_resource_id: string; kind: string }>;
    expect(relations.filter((relation) => relation.kind === "uses_oc")).toEqual(expect.arrayContaining(ocs.map((oc) => ({ source_resource_id: story.id, target_resource_id: oc.id, kind: "uses_oc" }))));
    expect(relations).toContainEqual({ source_resource_id: ocs[0]!.id, target_resource_id: ocs[1]!.id, kind: "related_to" });
    expect(worldResult.changeSetId).not.toBe(result.changeSetId);
    expect(storyResult.changeSetId).not.toBe(result.changeSetId);
    expect(Number((workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get() as { count: number }).count)).toBe(3);
    expect(Number((workspace.db.prepare("SELECT COUNT(*) AS count FROM project_file_versions").get() as { count: number }).count)).toBe(0);
  });

  it("rejects an invalid OC Fragment before any Gateway Change Set side effect", () => {
    const { workspace } = createWorkspace();
    let code: string | null = null;
    try {
      compileGrowthOcFragment({ summary: "Invalid", characters: [
        { localId: "one", title: "One", profile: { localId: "one-profile", title: "One profile", content: "short" } },
        { localId: "two", title: "Two", profile: { localId: "two-profile", title: "Two profile", content: "short" } },
      ] }, { cycleId: "cycle-oc", ocRootResourceId: "oc-root", storyResourceId: "story-formal" });
    } catch (error) { code = (error as { code?: string }).code ?? null; }
    expect(code).toBe("GROWTH_OC_FRAGMENT_INVALID");
    expect(Number((workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get() as { count: number }).count)).toBe(0);
    expect(Number((workspace.db.prepare("SELECT COUNT(*) AS count FROM change_set_outputs").get() as { count: number }).count)).toBe(0);
    expect(Number((workspace.db.prepare("SELECT COUNT(*) AS count FROM resource_revisions WHERE object_kind <> 'domain_root'").get() as { count: number }).count)).toBe(0);
  });

  it("rejects Greenfield requests after formal content exists and never creates a Change Set", async () => {
    const { workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    const checkpointId = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
    new ResourceRepository(workspace).putRevision({
      resourceId: "world.existing",
      create: true,
      checkpointId,
      type: "world",
      objectKind: "world",
      title: "已有世界",
      parentId: worldRoot.id,
      state: "active",
    });
    seedProposeTool(workspace);
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true);

    await expect(gateway.proposeChangeSet({
      summary: "不应创建",
      items: greenfieldWorldItems(worldRoot.id),
    }, invocationContext("free", true))).rejects.toMatchObject({ code: "GREENFIELD_WORKSPACE_NOT_EMPTY" });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()).toEqual({ count: 0 });
  });

  it("rejects Greenfield requests when the domain root has a stable document version", async () => {
    const { workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    new DocumentRepository(workspace).putVersion({
      resourceId: worldRoot.id,
      checkpointId: new CheckpointRepository(workspace).getActiveBranch().headCheckpointId,
      content: "已有稳定根文档。",
      authorKind: "user",
    });
    seedProposeTool(workspace);
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true);

    await expect(gateway.proposeChangeSet({
      summary: "不应创建",
      items: greenfieldWorldItems(worldRoot.id),
    }, invocationContext("free", true))).rejects.toMatchObject({ code: "GREENFIELD_WORKSPACE_NOT_EMPTY" });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()).toEqual({ count: 0 });
  });

  it("rejects Greenfield requests when the domain root has a working document", async () => {
    const { workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    new DocumentRepository(workspace).saveWorkingCopy({ resourceId: worldRoot.id, content: "已有根工作副本。" });
    seedProposeTool(workspace);
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true);

    await expect(gateway.proposeChangeSet({
      summary: "不应创建",
      items: greenfieldWorldItems(worldRoot.id),
    }, invocationContext("free", true))).rejects.toMatchObject({ code: "GREENFIELD_WORKSPACE_NOT_EMPTY" });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()).toEqual({ count: 0 });
  });

  it("rejects Greenfield update and delete proposals before they can enter review", async () => {
    const { workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    seedProposeTool(workspace);
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true);

    await expect(gateway.proposeChangeSet({
      summary: "不得更新",
      items: [{
        id: "delete-world",
        dependsOn: [],
        kind: "resource.put",
        payload: {
          resourceId: "world.greenfield",
          create: false,
          type: "world",
          objectKind: "world",
          title: "雾港群岛",
          parentId: worldRoot.id,
          state: "deleted",
          sortOrder: 0,
        },
      }],
    }, invocationContext("free", true)))
      .rejects.toMatchObject({ code: "GREENFIELD_RESOURCE_CREATE_REQUIRED" });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()).toEqual({ count: 0 });
  });

  it("returns no stable output versions when a Free proposal is blocked", async () => {
    const { workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    seedProposeTool(workspace);
    const gateway = createWorkspaceAgentToolGateway(workspace, new WorkspaceChangeSetPolicy(workspace), () => true);
    const result = await gateway.proposeChangeSet({
      summary: "错误地重用根资源",
      items: [{
        id: "duplicate-root",
        dependsOn: [],
        kind: "resource.put",
        payload: {
          resourceId: worldRoot.id,
          create: true,
          type: "world",
          objectKind: "world",
          title: "重复根",
          parentId: null,
          state: "active",
          sortOrder: 0,
        },
      }],
    }, invocationContext("free", true));

    expect(result).toMatchObject({ status: "pending", gateStatus: "blocked", committedOutputs: [] });
    expect(new ChangeSetRepository(workspace).listOutputs(result.changeSetId)).toEqual([]);
  });

  it("records a failed Change Set without outputs or formal mutations when application fails", () => {
    const { workspace } = createWorkspace();
    const branch = new CheckpointRepository(workspace).getActiveBranch();
    const formalBefore = new ResourceRepository(workspace).listCurrent()
      .filter((resource) => resource.objectKind !== "domain_root").length;
    const service = new ChangeSetService(workspace, testOnlyLowRiskPolicy, {
      apply: () => {
        throw new Error("token=secret forced apply failure");
      },
    });

    let failure: unknown;
    try {
      service.propose({
        idempotencyKey: "greenfield-apply-failure",
        expectedHeadCheckpointId: branch.headCheckpointId,
        mode: "free",
        summary: "失败提交",
        items: [greenfieldWorldItems(new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!.id)[0]],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "CHANGE_SET_APPLY_FAILED", message: "Change Set operation failed safely." });
    const changeSet = workspace.db.prepare("SELECT id FROM change_sets WHERE idempotency_key = ?")
      .get("greenfield-apply-failure") as { id: string };
    expect(new ChangeSetRepository(workspace).getRequired(changeSet.id)).toMatchObject({ status: "failed" });
    expect(new ChangeSetRepository(workspace).listOutputs(changeSet.id)).toEqual([]);
    expect(new ResourceRepository(workspace).listCurrent()
      .filter((resource) => resource.objectKind !== "domain_root")).toHaveLength(formalBefore);
  });

  it("preserves an allowlisted domain validation code after Change Set application begins", () => {
    const { workspace } = createWorkspace();
    const branch = new CheckpointRepository(workspace).getActiveBranch();
    const service = new ChangeSetService(workspace, testOnlyLowRiskPolicy, {
      apply: () => {
        throw Object.assign(new Error("password=hidden https://provider.example/?key=private"), {
          code: "RESOURCE_PARENT_NOT_FOUND",
        });
      },
    });

    let failure: unknown;
    try {
      service.propose({
        idempotencyKey: "greenfield-domain-failure",
        expectedHeadCheckpointId: branch.headCheckpointId,
        mode: "free",
        summary: "safe",
        items: [greenfieldWorldItems(new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!.id)[0]],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "RESOURCE_PARENT_NOT_FOUND", message: "Change Set operation failed safely." });
  });

  it("fails closed if the workspace identity changes during a run", async () => {
    const { workspace } = createWorkspace();
    const world = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => false);

    await expect(gateway.retrieveGraphEvidence(
      { scopeResourceIds: [world.id] },
      invocationContext("assist"),
    )).rejects.toMatchObject({ code: "AGENT_TOOLS_REQUIRED" });
  });

  it("fails closed before creating a job when no image Provider is configured", async () => {
    const { workspace } = createWorkspace();
    const source = imageSource(workspace);
    seedTool(workspace, "generate_image");
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true);

    await expect(gateway.generateImage(imageRequest(source), invocationContext("assist")))
      .rejects.toMatchObject({ code: "IMAGE_PROVIDER_REQUIRED" });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()).toEqual({ count: 0 });
  });

  it("attaches only the persisted allowlisted image failure class for Main diagnostics", async () => {
    const { root, workspace } = createWorkspace();
    const source = imageSource(workspace);
    seedTool(workspace, "generate_image");
    const client = vi.fn().mockRejectedValue(
      new ResponsesImageProviderError("IMAGE_PROVIDER_GENERATION_FAILED", false, 429),
    );
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true, {
      getImageProviderProfile: imageProfile,
      createImageGenerationService: () => new ImageGenerationService(
        new ImageAssetRepository(workspace), new ImageAssetStore(root), client,
      ),
    });

    await expect(gateway.generateImage(imageRequest(source), invocationContext("assist")))
      .rejects.toMatchObject({
        code: "IMAGE_GENERATION_FAILED",
        diagnosticCode: "IMAGE_PROVIDER_RATE_LIMITED",
      });
    expect(new ImageAssetRepository(workspace).getJobByIdempotencyKey("steward:silver-bay-night-tide-v1"))
      .toMatchObject({ status: "failed", errorCode: "IMAGE_PROVIDER_RATE_LIMITED" });
  });

  it("accepts a world_map only for a current formal world and its bound stable version", async () => {
    const { root, workspace } = createWorkspace();
    const worldRoot = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!;
    const receipt = new ResourceRepository(workspace).putRevisionWithReceipt({
      resourceId: "world.map-source", create: true,
      checkpointId: new CheckpointRepository(workspace).getActiveBranch().headCheckpointId,
      type: "world", objectKind: "world", title: "雾港群岛", parentId: worldRoot.id, state: "active",
    });
    seedTool(workspace, "generate_image");
    const client = vi.fn().mockResolvedValue({ bytes: ONE_PIXEL_PNG, responseId: "world-map-1" });
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true, {
      getImageProviderProfile: imageProfile,
      createImageGenerationService: () => new ImageGenerationService(
        new ImageAssetRepository(workspace), new ImageAssetStore(root), client,
      ),
    });

    const result = await gateway.generateImage({
      title: "雾港群岛地图", purpose: "world_map", prompt: "群岛航路地图",
      sourceResourceIds: [receipt.resourceId], sourceVersionIds: [receipt.revisionId], idempotencyKey: "world-map-v1",
    }, invocationContext("assist"));

    expect(result).toMatchObject({ purpose: "world_map", status: "ready" });
    expect(client).toHaveBeenCalledOnce();
  });

  it("accepts the current setting version when a world also has a later active knowledge note, and rejects a superseded setting version", async () => {
    const { root, workspace } = createWorkspace();
    const resources = new ResourceRepository(workspace);
    const checkpoints = new CheckpointRepository(workspace);
    const worldRoot = resources.listCurrent().find((resource) => resource.type === "world")!;
    const world = resources.putRevisionWithReceipt({ resourceId: "world.multi-document", create: true, checkpointId: checkpoints.getActiveBranch().headCheckpointId, type: "world", objectKind: "world", title: "Source World", parentId: worldRoot.id, state: "active" });
    const creative = new CreativeDocumentRepository(workspace);
    const setting = creative.putRevisionWithReceipt({ documentId: "setting.multi-document", create: true, checkpointId: checkpoints.getActiveBranch().headCheckpointId, resourceId: world.resourceId, kind: "setting", title: "Setting", state: "active" });
    const knowledge = creative.putRevisionWithReceipt({ documentId: "knowledge.multi-document", create: true, checkpointId: checkpoints.getActiveBranch().headCheckpointId, resourceId: world.resourceId, kind: "knowledge_note", title: "Knowledge", state: "active" });
    const documents = new DocumentRepository(workspace);
    const settingVersion = documents.putVersion({ resourceId: world.resourceId, creativeDocumentId: setting.documentId, checkpointId: checkpoints.getActiveBranch().headCheckpointId, content: "Current setting." , authorKind: "user" });
    documents.putVersion({ resourceId: world.resourceId, creativeDocumentId: knowledge.documentId, checkpointId: checkpoints.getActiveBranch().headCheckpointId, content: "Later knowledge note.", authorKind: "user" });
    seedTool(workspace, "generate_image");
    const client = vi.fn().mockResolvedValue({ bytes: ONE_PIXEL_PNG, responseId: "multi-document-map" });
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true, { getImageProviderProfile: imageProfile, createImageGenerationService: () => new ImageGenerationService(new ImageAssetRepository(workspace), new ImageAssetStore(root), client) });
    await expect(gateway.generateImage({ title: "Map", purpose: "world_map", prompt: "Map", sourceResourceIds: [world.resourceId], sourceVersionIds: [world.revisionId, settingVersion], idempotencyKey: "multi-document-current" }, invocationContext("assist"))).resolves.toMatchObject({ status: "ready" });
    const nextCheckpoint = checkpoints.appendCheckpoint(checkpoints.getActiveBranch().id, "Supersede setting");
    documents.putVersion({ resourceId: world.resourceId, creativeDocumentId: setting.documentId, checkpointId: nextCheckpoint, content: "New setting.", authorKind: "user" });
    await expect(gateway.generateImage({ title: "Old map", purpose: "world_map", prompt: "Old map", sourceResourceIds: [world.resourceId], sourceVersionIds: [world.revisionId, settingVersion], idempotencyKey: "multi-document-superseded" }, invocationContext("assist"))).rejects.toMatchObject({ code: "WORLD_MAP_SOURCE_VERSION_INVALID" });
  });

  it("rejects a world_map source that is not a formal world before calling the Provider", async () => {
    const { root, workspace } = createWorkspace();
    const source = imageSource(workspace);
    seedTool(workspace, "generate_image");
    const client = vi.fn();
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true, {
      getImageProviderProfile: imageProfile,
      createImageGenerationService: () => new ImageGenerationService(
        new ImageAssetRepository(workspace), new ImageAssetStore(root), client,
      ),
    });

    await expect(gateway.generateImage({
      ...imageRequest(source), purpose: "world_map", title: "非法地图",
    }, invocationContext("assist"))).rejects.toMatchObject({ code: "WORLD_MAP_SOURCE_WORLD_REQUIRED" });
    expect(client).not.toHaveBeenCalled();
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()).toEqual({ count: 0 });
  });

  it("rejects an old world resource revision before calling the Provider", async () => {
    const { workspace } = createWorkspace();
    const resources = new ResourceRepository(workspace);
    const checkpoints = new CheckpointRepository(workspace);
    const worldRoot = resources.listCurrent().find((resource) => resource.type === "world")!;
    const original = resources.putRevisionWithReceipt({
      resourceId: "world.versioned", create: true, checkpointId: checkpoints.getActiveBranch().headCheckpointId,
      type: "world", objectKind: "world", title: "旧雾港", parentId: worldRoot.id, state: "active",
    });
    const replacementCheckpointId = checkpoints.appendCheckpoint(checkpoints.getActiveBranch().id, "更新世界版本");
    resources.putRevisionWithReceipt({
      resourceId: original.resourceId, checkpointId: replacementCheckpointId,
      type: "world", objectKind: "world", title: "新雾港", parentId: worldRoot.id, state: "active",
    });
    seedTool(workspace, "generate_image");
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true, {
      getImageProviderProfile: imageProfile,
    });

    await expect(gateway.generateImage({
      title: "旧版本地图", purpose: "world_map", prompt: "旧版本地图",
      sourceResourceIds: [original.resourceId], sourceVersionIds: [original.revisionId], idempotencyKey: "old-version-map",
    }, invocationContext("assist"))).rejects.toMatchObject({ code: "WORLD_MAP_SOURCE_VERSION_INVALID" });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()).toEqual({ count: 0 });
  });

  it("rejects a current version whose owner is absent from world_map source resources", async () => {
    const { workspace } = createWorkspace();
    const resources = new ResourceRepository(workspace);
    const checkpointId = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
    const worldRoot = resources.listCurrent().find((resource) => resource.type === "world")!;
    const owner = resources.putRevisionWithReceipt({
      resourceId: "world.version-owner", create: true, checkpointId,
      type: "world", objectKind: "world", title: "来源世界", parentId: worldRoot.id, state: "active",
    });
    const reported = resources.putRevisionWithReceipt({
      resourceId: "world.reported", create: true, checkpointId,
      type: "world", objectKind: "world", title: "所报世界", parentId: worldRoot.id, state: "active",
    });
    seedTool(workspace, "generate_image");
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true, {
      getImageProviderProfile: imageProfile,
    });

    await expect(gateway.generateImage({
      title: "错绑地图", purpose: "world_map", prompt: "错绑地图",
      sourceResourceIds: [reported.resourceId], sourceVersionIds: [owner.revisionId], idempotencyKey: "owner-mismatch-map",
    }, invocationContext("assist"))).rejects.toMatchObject({ code: "WORLD_MAP_SOURCE_VERSION_INVALID" });
    expect(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()).toEqual({ count: 0 });
  });

  it("commits one source-bound image and reuses it without a second Provider call", async () => {
    const { root, workspace } = createWorkspace();
    const source = imageSource(workspace);
    seedTool(workspace, "generate_image");
    const client = vi.fn().mockResolvedValue({ bytes: ONE_PIXEL_PNG, responseId: "response-gateway-1" });
    const configuredProfile = imageProfile();
    const gateway = createWorkspaceAgentToolGateway(workspace, testOnlyLowRiskPolicy, () => true, {
      getImageProviderProfile: () => configuredProfile,
      createImageGenerationService: () => new ImageGenerationService(
        new ImageAssetRepository(workspace),
        new ImageAssetStore(root),
        client,
      ),
    });

    const first = await gateway.generateImage(imageRequest(source), invocationContext("assist"));
    const replay = await gateway.generateImage(imageRequest(source), invocationContext("assist"));

    expect(client).toHaveBeenCalledTimes(1);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      status: "ready",
      title: "银湾夜潮",
      sourceResourceIds: [source.resourceId],
      sourceVersionIds: [source.versionId],
      thumbnailUrl: `novax-asset://image/${first.assetId}`,
    });
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(configuredProfile.apiKey).toBe("secret");
    expect(fs.existsSync(path.join(root, ".novax", "assets", "images", `${first.sha256}.png`))).toBe(true);
  });
});

const testOnlyLowRiskPolicy: ChangeSetPolicyEvaluator = {
  assess: (candidate) => candidate.items.map((item) => ({
    itemId: item.id,
    risk: "low",
    conflicts: [],
  })),
};

function invocationContext(mode: "free" | "assist", greenfieldCreateRequested = false) {
  return {
    runId: "run-test-only",
    invocationId: "run-test-only:steward",
    requestId: "11111111-1111-4111-8111-111111111111",
    mode,
    greenfieldCreateRequested,
    signal: new AbortController().signal,
  };
}

function greenfieldWorldItems(worldRootId: string): ProposeChangeSetArgs["items"] {
  return [{
    id: "world-resource",
    dependsOn: [],
    kind: "resource.put" as const,
    payload: {
      resourceId: "world.greenfield",
      create: true,
      type: "world" as const,
      objectKind: "world" as const,
      title: "雾港群岛",
      parentId: worldRootId,
      state: "active" as const,
      sortOrder: 1,
    },
  }, {
    id: "world-document",
    dependsOn: ["world-resource"],
    kind: "document.put" as const,
    payload: {
      resourceId: "world.greenfield",
      content: "雾港群岛的航路受月潮影响。",
    },
  }, {
    id: "world-assertion",
    dependsOn: ["world-resource", "world-document"],
    kind: "assertion.put" as const,
    payload: {
      assertionId: "assertion.greenfield.moon-tide",
      scopeType: "world",
      scopeId: "world.greenfield",
      subject: "月潮",
      predicate: "影响",
      object: { target: "航路" },
      evidenceIds: [greenfieldDocumentOutputEvidence("world-document")],
    },
  }];
}

function seedProposeTool(workspace: WorkspaceDatabase): void {
  seedTool(workspace, "propose_change_set");
}

function seedTool(workspace: WorkspaceDatabase, toolName: "propose_change_set" | "generate_image", requestId = "11111111-1111-4111-8111-111111111111"): void {
  const audit = new AgentAuditRepository(workspace);
  const hash = "a".repeat(64);
  const existing = Boolean(workspace.db.prepare("SELECT 1 FROM agent_runs WHERE id = ?").get("run-test-only"));
  if (!existing) audit.beginRun({
    runId: "run-test-only",
    mode: "assist",
    userInputSha256: hash,
    providerId: "test-provider",
    requestedModelId: "test-model",
    providerConfigSha256: hash,
  });
  if (!existing) audit.beginInvocation({
    invocationId: "run-test-only:steward",
    runId: "run-test-only",
    parentInvocationId: null,
    role: "steward",
    promptId: "novax.steward",
    promptVersion: "test",
    promptSha256: hash,
    agentProfileId: "novax.steward",
    agentProfileVersion: "test",
    agentProfileSha256: hash,
    providerId: "test-provider",
    requestedModelId: "test-model",
    providerConfigSha256: hash,
    toolPolicyId: "novax.steward.tools",
    toolPolicyVersion: "test",
    toolPolicySha256: hash,
    authorizedTools: [toolName],
    handoffContractId: null,
    handoffVersion: null,
    handoffPayloadSha256: null,
    inputSha256: hash,
  });
  audit.beginTool({
    toolInvocationId: requestId,
    runId: "run-test-only",
    invocationId: "run-test-only:steward",
    toolName,
    argumentsSha256: hash,
  });
}

function imageSource(workspace: WorkspaceDatabase): { resourceId: string; versionId: string } {
  const row = workspace.db.prepare(`
    SELECT resource_id, id FROM resource_revisions ORDER BY created_at, id LIMIT 1
  `).get() as { resource_id: string; id: string };
  return { resourceId: row.resource_id, versionId: row.id };
}

function imageRequest(source: { resourceId: string; versionId: string }) {
  return {
    title: "银湾夜潮",
    purpose: "scene" as const,
    prompt: "月光照在银湾弯曲的海岸线上，潮汐裂隙泛着蓝光。",
    sourceResourceIds: [source.resourceId],
    sourceVersionIds: [source.versionId],
    idempotencyKey: "silver-bay-night-tide-v1",
  };
}

function imageProfile() {
  return {
    providerId: "image-provider",
    displayName: "图片模型",
    baseUrl: "https://proxy.example",
    modelId: "image-model",
    endpoint: "responses" as const,
    defaultSize: "1024x1024",
    defaultQuality: "auto" as const,
    defaultBackground: "auto" as const,
    apiKey: "secret",
  };
}

function createWorkspace(): { root: string; workspace: WorkspaceDatabase } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-agent-tool-test-only-"));
  const workspace = openWorkspace(root);
  opened.push({ root, workspace });
  return { root, workspace };
}
