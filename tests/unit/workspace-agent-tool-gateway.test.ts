import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import type { ChangeSetPolicyEvaluator } from "../../src/domain/changeSet/changeSetService";
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

function invocationContext(mode: "free" | "assist") {
  return {
    runId: "run-test-only",
    invocationId: "run-test-only:steward",
    requestId: "11111111-1111-4111-8111-111111111111",
    mode,
    signal: new AbortController().signal,
  };
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
