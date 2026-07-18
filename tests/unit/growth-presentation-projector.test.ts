import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { GrowthEditorialRepository } from "../../src/domain/growth/editorial/growthEditorialRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { SemanticGraphService } from "../../src/domain/graph/semanticGraphService";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { GrowthPresentationProjector } from "../../src/main/growth/growthPresentationProjector";
import { GrowthIllustrationApplicationService } from "../../src/main/growth/illustration/growthIllustrationApplicationService";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Growth presentation and manual Illustration application", () => {
  it("persists a source-bound request, projects only safe state, and fails closed without a Provider", async () => {
    const setup = createSetup();
    const gateway = { generateImage: vi.fn().mockRejectedValue(Object.assign(new Error("secret provider detail"), { code: "IMAGE_PROVIDER_NOT_CONFIGURED" })) };
    const service = new GrowthIllustrationApplicationService(setup.workspace, gateway);
    new GrowthRepository(setup.workspace).createClosureProfile({
      id: "closure-world", idempotencyKey: "closure-world-key", goalId: setup.goalId, profileKind: "world_birth",
      subjectResourceId: null, componentProfiles: [], focusOcResourceId: null, contractGeneration: "v26",
      checkpointId: setup.checkpointId, ruleRevision: 1,
      facets: [{ id: "history", kind: "content", required: true }],
    });
    createCommittedEditorialHistory(setup.workspace, setup.goalId, setup.checkpointId);
    service.create({
      projectId: "project-1", sessionId: "session-1", goalId: setup.goalId, requestId: "manual-request-1",
      target: { kind: "resource", resourceId: setup.worldId }, purpose: "scene", title: "潮汐港风貌",
      compositionDescription: "用宽幅构图呈现港口与潮汐设施。", variantCount: 2,
    }, setup.context);

    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).getIllustrationRequest("manual-request-1")?.status).toBe("failed"));
    expect(gateway.generateImage).toHaveBeenCalledTimes(2);
    const snapshot = new GrowthPresentationProjector(setup.workspace).project({ goalId: setup.goalId, checkpointId: setup.checkpointId });
    expect(snapshot).toMatchObject({
      capabilityVersion: "growth-presentation-v2",
      goalId: setup.goalId,
      longform: { status: "unavailable" },
      closures: [{ profileId: "closure-world", profileKind: "world", contentState: "growing", missingCount: 1 }],
      illustrationRequests: [{
        id: "manual-request-1", status: "failed", itemCount: 2, readyCount: 0,
        items: [
          { title: "潮汐港风貌 · 变体 1", status: "failed", source: { kind: "resource", sourceResourceId: setup.worldId, label: "潮汐港", excerpt: null } },
          { title: "潮汐港风貌 · 变体 2", status: "failed", source: { kind: "resource", sourceResourceId: setup.worldId, label: "潮汐港", excerpt: null } },
        ],
      }],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|prompt|locator|relativePath|apiKey/i);
    expect(snapshot.activityEvents.map((event) => event.kind)).toEqual([
      "director_planning", "employee_assigned", "candidate_ready", "checking", "checking",
      "revision_requested", "employee_assigned", "candidate_ready", "checking", "checking", "committed",
      "image_failed", "image_failed",
    ]);
    expect(snapshot.activityEvents.find((event) => event.kind === "revision_requested")?.safeSummary)
      .toBe("补足潮汐制度与港口冲突的因果桥梁。");
    expect(JSON.stringify(snapshot.activityEvents)).not.toMatch(/secret-store|@evidence|provider-config|prompt-profile|outputSha256/i);

    service.create({
      projectId: "project-1", sessionId: "session-1", goalId: setup.goalId, requestId: "manual-request-1",
      target: { kind: "resource", resourceId: setup.worldId }, purpose: "scene", title: "潮汐港风貌",
      compositionDescription: "用宽幅构图呈现港口与潮汐设施。", variantCount: 2,
    }, setup.context);
    expect(new GrowthRepository(setup.workspace).listIllustrationRequests(setup.goalId)).toHaveLength(1);
    expect(gateway.generateImage).toHaveBeenCalledTimes(2);
    expect(() => service.create({
      projectId: "project-1", sessionId: "session-1", goalId: setup.goalId, requestId: "manual-request-1",
      target: { kind: "resource", resourceId: setup.worldId }, purpose: "scene", title: "伪造的新标题",
      compositionDescription: "用另一份内容重放同一个请求标识。", variantCount: 2,
    }, setup.context)).toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_BATCH_REPLAY_MISMATCH" }));
    expect(gateway.generateImage).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-scope resources and preserves bounded snapshot text as the visible source", async () => {
    const setup = createSetup();
    const resources = new ResourceRepository(setup.workspace);
    const ocRoot = resources.listCurrent().find((resource) => resource.type === "oc")!;
    const foreign = resources.putRevisionWithReceipt({
      resourceId: "foreign-oc", create: true, checkpointId: setup.checkpointId,
      type: "oc", objectKind: "oc", title: "范围外角色", parentId: ocRoot.id, state: "active",
    });
    const gateway = { generateImage: vi.fn().mockRejectedValue(Object.assign(new Error("offline"), { code: "IMAGE_PROVIDER_NOT_CONFIGURED" })) };
    const service = new GrowthIllustrationApplicationService(setup.workspace, gateway);
    expect(() => service.create({
      projectId: "project-1", sessionId: "session-1", goalId: setup.goalId, requestId: "cross-scope",
      target: { kind: "resource", resourceId: foreign.resourceId }, purpose: "character_portrait", title: "越权角色",
      compositionDescription: "不应执行。", variantCount: 1,
    }, setup.context)).toThrowError(expect.objectContaining({ code: "GROWTH_ILLUSTRATION_SOURCE_NOT_VISIBLE" }));

    const selectedText = "潮水退去时，黑色礁石上的旧灯塔显出被战争灼伤的裂纹。";
    service.create({
      projectId: "project-1", sessionId: "session-1", goalId: setup.goalId, requestId: "snapshot-request",
      target: { kind: "working_text_snapshot", sourceResourceId: setup.worldId, text: selectedText },
      purpose: "scene", title: "旧灯塔", compositionDescription: "表现退潮后的旧灯塔。", variantCount: 1,
    }, setup.context);
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).getIllustrationRequest("snapshot-request")?.status).toBe("failed"));
    const snapshot = new GrowthPresentationProjector(setup.workspace).project({ goalId: setup.goalId, checkpointId: setup.checkpointId });
    expect(snapshot.illustrationRequests.at(-1)?.items[0]?.source).toEqual({
      kind: "working_text_snapshot", sourceResourceId: setup.worldId, label: "潮汐港 · 创作快照", excerpt: selectedText,
    });
    new GrowthRepository(setup.workspace).createClosureProfile({
      id: "closure-foreign-oc", idempotencyKey: "closure-foreign-oc-key", goalId: setup.goalId, profileKind: "oc_saga",
      subjectResourceId: foreign.resourceId, componentProfiles: [], focusOcResourceId: null, contractGeneration: "v26",
      checkpointId: setup.checkpointId, ruleRevision: 1,
      facets: [{ id: "identity", kind: "content", required: true }],
    });
    expect(() => new GrowthPresentationProjector(setup.workspace).project({ goalId: setup.goalId, checkpointId: setup.checkpointId }))
      .toThrowError(expect.objectContaining({ code: "GROWTH_PRESENTATION_SOURCE_NOT_VISIBLE" }));
  });

  it("resolves a Creator-visible graph node in Main and persists only its bounded evidence snapshot", async () => {
    const setup = createSetup();
    new AssertionRepository(setup.workspace).putVersion({
      assertionId: "assertion.tidal-law",
      checkpointId: setup.checkpointId,
      scopeType: "world",
      scopeId: setup.worldId,
      subject: "潮汐法令",
      predicate: "限制",
      object: { text: "港门只在双月低潮时开放。" },
      status: "current",
      source: { kind: "recorded", ref: "growth-presentation-test" },
    });
    const node = new SemanticGraphService(setup.workspace).getSnapshot().nodes.find((candidate) => (
      candidate.kind === "fact" && candidate.label === "潮汐法令 · 限制"
    ))!;
    const gateway = { generateImage: vi.fn().mockRejectedValue(Object.assign(new Error("offline"), { code: "IMAGE_PROVIDER_NOT_CONFIGURED" })) };
    const service = new GrowthIllustrationApplicationService(setup.workspace, gateway);
    service.create({
      projectId: "project-1", sessionId: "session-1", goalId: setup.goalId, requestId: "graph-node-request",
      target: { kind: "graph_node", nodeId: node.id }, purpose: "scene", title: "潮汐法令图解",
      compositionDescription: "表现法令如何改变港门和夜间航行。", variantCount: 1,
    }, setup.context);
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).getIllustrationRequest("graph-node-request")?.status).toBe("failed"));
    const projected = new GrowthPresentationProjector(setup.workspace).project({ goalId: setup.goalId, checkpointId: setup.checkpointId });
    expect(projected.illustrationRequests.at(-1)?.items[0]?.source).toMatchObject({
      kind: "working_text_snapshot", sourceResourceId: setup.worldId,
      excerpt: "潮汐法令\n限制\n港门只在双月低潮时开放。",
    });
    expect(JSON.stringify(projected)).not.toContain(node.id);
  });
});

function createSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-presentation-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  const checkpoints = new CheckpointRepository(workspace);
  const branch = checkpoints.getActiveBranch();
  const checkpointId = branch.headCheckpointId;
  const resources = new ResourceRepository(workspace);
  const worldRoot = resources.listCurrent().find((resource) => resource.type === "world")!;
  const world = resources.putRevisionWithReceipt({
    resourceId: "tidal-harbor", create: true, checkpointId,
    type: "world", objectKind: "world", title: "潮汐港", parentId: worldRoot.id, state: "active",
  });
  const growth = new GrowthRepository(workspace);
  const goal = growth.createGoal({
    id: "growth-goal-1", idempotencyKey: "growth-goal-key-1", branchId: branch.id,
    seed: { kind: "text", text: "潮汐港" }, authorizedScopeResourceIds: [worldRoot.id],
    initialRuleText: "保持原创世界。", sourceMessageId: null,
  });
  const cycle = growth.beginCycle({
    id: "growth-cycle-1", goalId: goal.id, idempotencyKey: "growth-cycle-key-1",
    inputCheckpointId: checkpointId, ruleRevision: 1,
    intent: { kind: "expand", focusKinds: ["world"], resumeFrontier: [] },
  });
  return {
    workspace, checkpointId, goalId: goal.id, worldId: world.resourceId,
    context: { checkpointId, branchId: branch.id, authorizedScopeResourceIds: [worldRoot.id] },
  };
}

function createCommittedEditorialHistory(workspace: WorkspaceDatabase, goalId: string, checkpointId: string) {
  const repository = new GrowthEditorialRepository(workspace);
  repository.createRound({
    id: "round-presentation", goalId, sourceCheckpointId: checkpointId, ruleRevision: 1,
    idempotencyKey: "round-presentation-key",
    workOrders: [{
      id: "tidal-system", objective: "构建潮汐制度。", sourceCheckpointId: checkpointId,
      scopeRefs: ["@resource1"], capability: "world_system_author",
      acceptanceFacets: [{ id: "causal-bridge", description: "制度必须产生可追踪后果。", required: true }],
      dependencies: [],
    }],
  });
  const sha = (character: string) => character.repeat(64);
  const start = (id: string, key: string) => repository.startAttempt({
    id, workOrderId: "tidal-system", idempotencyKey: key, sourceCheckpointId: checkpointId, ruleRevision: 1,
    capability: "world_system_author",
    capabilityProfile: { id: "world-system", version: "1", sha256: sha("a") },
    prompt: { id: "secret-prompt-profile", version: "1", sha256: sha("b") },
    model: { providerId: "secret-provider", modelId: "secret-model", providerConfigSha256: sha("c") },
  });
  const first = start("attempt-presentation-1", "attempt-presentation-key-1");
  repository.recordCandidate({
    attemptId: first.id, outputSha256: sha("d"),
    artifacts: [{ kind: "content_artifact", ordinal: 0, storeRef: "secret-store/candidate-one.json", contentSha256: sha("e") }],
  });
  repository.beginReview(first.id);
  repository.recordReview({
    id: "review-checker-1", attemptId: first.id, reviewerKind: "checker", decision: "passed",
    safeSummary: "来源绑定完整。", evidenceRefs: ["@evidence1"], artifactRef: "secret-store/checker-one.json",
    artifactSha256: sha("f"), idempotencyKey: "review-checker-key-1",
  });
  repository.recordReview({
    id: "review-director-1", attemptId: first.id, reviewerKind: "director", decision: "revise",
    safeSummary: "补足潮汐制度与港口冲突的因果桥梁。", evidenceRefs: ["@evidence2"], artifactRef: "secret-store/director-one.json",
    artifactSha256: sha("1"), idempotencyKey: "review-director-key-1",
  });
  const second = start("attempt-presentation-2", "attempt-presentation-key-2");
  repository.recordCandidate({
    attemptId: second.id, outputSha256: sha("2"),
    artifacts: [{ kind: "content_artifact", ordinal: 0, storeRef: "secret-store/candidate-two.json", contentSha256: sha("3") }],
  });
  repository.beginReview(second.id);
  repository.recordReview({
    id: "review-checker-2", attemptId: second.id, reviewerKind: "checker", decision: "passed",
    safeSummary: "因果桥梁已闭合。", evidenceRefs: ["@evidence3"], artifactRef: "secret-store/checker-two.json",
    artifactSha256: sha("4"), idempotencyKey: "review-checker-key-2",
  });
  repository.recordReview({
    id: "review-director-2", attemptId: second.id, reviewerKind: "director", decision: "accept",
    safeSummary: "总编接受候选。", evidenceRefs: ["@evidence4"], artifactRef: "secret-store/director-two.json",
    artifactSha256: sha("5"), idempotencyKey: "review-director-key-2",
  });
  repository.queueCommit("tidal-system");
  repository.markCommitRequested("tidal-system");
  repository.markCommitted("tidal-system");
}
