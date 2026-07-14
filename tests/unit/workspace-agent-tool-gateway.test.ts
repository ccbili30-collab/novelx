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
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { createWorkspaceAgentToolGateway } from "../../src/main/workspaceAgentToolGateway";
import { ImageAssetRepository } from "../../src/domain/asset/imageAssetRepository";
import { ImageAssetStore } from "../../src/domain/asset/imageAssetStore";
import { ImageGenerationService } from "../../src/domain/asset/imageGenerationService";

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
      .rejects.toMatchObject({ code: "GREENFIELD_CREATE_ONLY_REQUIRED" });
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

  it("persists no output version when Change Set application fails", () => {
    const { workspace } = createWorkspace();
    const branch = new CheckpointRepository(workspace).getActiveBranch();
    const service = new ChangeSetService(workspace, testOnlyLowRiskPolicy, {
      apply: () => {
        throw new Error("forced apply failure");
      },
    });

    expect(() => service.propose({
      idempotencyKey: "greenfield-apply-failure",
      expectedHeadCheckpointId: branch.headCheckpointId,
      mode: "free",
      summary: "失败提交",
      items: [greenfieldWorldItems(new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!.id)[0]],
    })).toThrow("forced apply failure");
    const changeSet = workspace.db.prepare("SELECT id FROM change_sets WHERE idempotency_key = ?")
      .get("greenfield-apply-failure") as { id: string };
    expect(new ChangeSetRepository(workspace).getRequired(changeSet.id)).toMatchObject({ status: "failed" });
    expect(new ChangeSetRepository(workspace).listOutputs(changeSet.id)).toEqual([]);
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

function greenfieldWorldItems(worldRootId: string) {
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

function seedTool(workspace: WorkspaceDatabase, toolName: "propose_change_set" | "generate_image"): void {
  const audit = new AgentAuditRepository(workspace);
  const hash = "a".repeat(64);
  audit.beginRun({
    runId: "run-test-only",
    mode: "assist",
    userInputSha256: hash,
    providerId: "test-provider",
    requestedModelId: "test-model",
    providerConfigSha256: hash,
  });
  audit.beginInvocation({
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
    toolInvocationId: "11111111-1111-4111-8111-111111111111",
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
