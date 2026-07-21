import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import type { ChangeSetPolicyEvaluator } from "../../src/domain/changeSet/changeSetService";
import { GrowthEditorialRepository } from "../../src/domain/growth/editorial/growthEditorialRepository";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { requireAgentCapability } from "../../src/agent-worker/editorial/agentCapabilityRegistry";
import {
  AgentProcessSupervisor,
  type AgentWorkerProcess,
} from "../../src/main/agentProcessSupervisor";
import { GrowthCoordinator } from "../../src/main/growthCoordinator";
import { GrowthEditorialArtifactStore } from "../../src/main/growth/editorial/growthEditorialArtifactStore";
import { WorkspaceSession } from "../../src/main/workspaceIpc";
import type {
  GrowthEditorialPrompt,
  GrowthEditorialSpecialistStart,
} from "../../src/shared/growthEditorialWorkerProtocol";

class FakeWorker extends EventEmitter implements AgentWorkerProcess {
  killed = false;
  readonly sent: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    queueMicrotask(() => callback?.(null));
    return true;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  spawn(): void {
    this.emit("spawn");
  }

  receive(message: unknown): void {
    this.emit("message", message);
  }
}

let root: string | undefined;
let workspace: WorkspaceDatabase | undefined;
let session: WorkspaceSession | undefined;
let application: ApplicationRegistryRepository | undefined;
let coordinator: GrowthCoordinator | undefined;
let supervisor: AgentProcessSupervisor | undefined;

afterEach(() => {
  coordinator?.dispose();
  supervisor?.dispose();
  session?.close();
  application?.close();
  workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  workspace = undefined;
  session = undefined;
  application = undefined;
  coordinator = undefined;
  supervisor = undefined;
});

describe("formal World Director geography delegation", () => {
  it("dispatches one geography Agent, persists its handoff, and stops before Domain mutation", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => setup.session.acquireAgentRuntimeLease(),
      getProviderProfile: () => ({
        providerId: "test-provider",
        displayName: "Test Provider",
        baseUrl: "https://provider.example/v1",
        modelId: "test-model",
        contextWindow: 128_000,
        maxTokens: 8_000,
        reasoning: false,
        input: ["text"],
        apiKey: "test-secret-key",
      }),
      spawnWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor, {
      route: "world_director_geography",
      requireEditorialPrompt: () => activeGeographyPrompt(),
    });
    const resourcesBefore = new ResourceRepository(setup.workspace).listCurrent();

    const started = coordinator.start({
      requestId: "11111111-1111-4111-8111-111111111111",
      projectId: setup.projectId,
      sessionId: setup.sessionId,
      seed: {
        kind: "text",
        text: "创建一个古老、辽阔、适合多文明兴衰的中土式原创魔幻世界。",
      },
      initialRuleText: "先建立地理与生态基本面貌；不要提前生成国家、人物、故事或图片。",
      strategy: "grow_world_story_oc_closure_v4",
    });

    expect(started.cycles).toEqual([]);
    const editorial = new GrowthEditorialRepository(setup.workspace);
    const initialRounds = editorial.listRoundSnapshotsForGoal(started.goal.id);
    expect(initialRounds).toHaveLength(1);
    expect(initialRounds[0]).toMatchObject({
      round: { status: "active", sourceCheckpointId: setup.checkpointId },
      workOrders: [{ capability: "geography_ecology_author", status: "running", dependencies: [] }],
      attempts: [{ capability: "geography_ecology_author", status: "running" }],
      artifacts: [],
    });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0]!.spawn();
    await vi.waitFor(() => expect(workers[0]!.sent).toHaveLength(1));
    const command = workers[0]!.sent[0] as GrowthEditorialSpecialistStart;
    expect(command).toMatchObject({
      type: "growth.editorial.specialist.start",
      binding: {
        capabilityId: "geography_ecology_author",
        sourceCheckpointId: setup.checkpointId,
      },
      packet: {
        capabilityId: "geography_ecology_author",
        sourceCheckpointId: setup.checkpointId,
        scopeRefs: ["@resource1"],
        artifactSlots: ["@artifact1"],
        revisionFeedback: [],
      },
    });
    expect(command.packet.evidence).toEqual([
      expect.objectContaining({
        ref: "@evidence1",
        kind: "goal_seed",
        content: "创建一个古老、辽阔、适合多文明兴衰的中土式原创魔幻世界。",
      }),
      expect.objectContaining({
        ref: "@evidence2",
        kind: "user_rule",
        content: "先建立地理与生态基本面貌；不要提前生成国家、人物、故事或图片。",
      }),
    ]);

    const markdown = [
      "# 地理与生态基本面貌",
      "",
      "世界由西部风暴海岸、中央裂谷高原、北方冰冠山系与东南季风盆地构成。",
      "山脉截留水汽，融雪形成贯穿高原的河网；裂谷火山土支持农业，但周期性灰灾迫使聚落沿交通瓶颈迁移。",
      "这些地形、气候、资源与迁徙约束将作为后续国家模型的输入，不在本交接中生成国家。",
    ].join("\n");
    workers[0]!.receive({
      type: "growth.editorial.specialist.started",
      runId: command.runId,
      attemptId: command.attemptId,
      capabilityId: "geography_ecology_author",
    });
    workers[0]!.receive({
      type: "growth.editorial.specialist.completed",
      runId: command.runId,
      attemptId: command.attemptId,
      candidate: {
        status: "ready",
        summary: "完成地理与生态基本面貌，并明确了可传递给下游国家模型的约束。",
        contentArtifactRefs: ["@artifact1"],
        evidenceRefs: ["@evidence1", "@evidence2"],
        coverage: command.packet.acceptanceFacets.map((facet) => ({
          facetId: facet.id,
          state: "covered" as const,
          evidenceRefs: ["@evidence1", "@evidence2"],
        })),
      },
      artifacts: [{
        ref: "@artifact1",
        title: "地理与生态基本面貌",
        mediaType: "text/markdown",
        content: markdown,
      }],
      receipt: {
        actualProviderId: "test-provider",
        actualModelId: "test-model",
        responseIdSha256: "a".repeat(64),
        inputTokens: 120,
        outputTokens: 240,
        totalTokens: 360,
        correctionAttempts: 0,
      },
    });

    await vi.waitFor(() => {
      const snapshot = editorial.listRoundSnapshotsForGoal(started.goal.id)[0]!;
      expect(snapshot.workOrders[0]?.status).toBe("candidate_ready");
      expect(snapshot.attempts[0]?.status).toBe("candidate_ready");
      expect(snapshot.artifacts.map((artifact) => artifact.kind)).toEqual([
        "content_artifact",
        "specialist_candidate",
      ]);
    });

    const completed = editorial.listRoundSnapshotsForGoal(started.goal.id)[0]!;
    const store = new GrowthEditorialArtifactStore(setup.root);
    const contentArtifact = completed.artifacts.find((artifact) => artifact.kind === "content_artifact")!;
    const handoffArtifact = completed.artifacts.find((artifact) => artifact.kind === "specialist_candidate")!;
    expect(store.readText(contentArtifact.storeRef, contentArtifact.contentSha256)).toBe(markdown);
    expect(store.readJson(handoffArtifact.storeRef, handoffArtifact.contentSha256)).toMatchObject({
      contract: "novax.growth-editorial-handoff@1.0.0",
      goalId: started.goal.id,
      sourceCheckpointId: setup.checkpointId,
      candidate: { status: "ready", contentArtifactRefs: ["@artifact1"] },
      artifacts: [{ ref: "@artifact1", storeRef: contentArtifact.storeRef }],
      receipt: { actualProviderId: "test-provider", actualModelId: "test-model" },
    });
    expect(new GrowthRepository(setup.workspace).listCycles(started.goal.id)).toEqual([]);
    expect(new ResourceRepository(setup.workspace).listCurrent()).toEqual(resourcesBefore);
    expect(readCount(setup.workspace, "change_sets")).toBe(0);
    expect(readCount(setup.workspace, "image_generation_jobs")).toBe(0);
    expect(workers[0]!.killed).toBe(true);

    coordinator.dispose();
    supervisor.dispose();
    coordinator = undefined;
    supervisor = undefined;
  });

  it("fails closed before Worker spawn when the text Provider is missing", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => setup.session.acquireAgentRuntimeLease(),
      spawnWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor, {
      route: "world_director_geography",
      requireEditorialPrompt: () => activeGeographyPrompt(),
    });

    const started = coordinator.start(growthRequest(setup));
    const editorial = new GrowthEditorialRepository(setup.workspace);
    await vi.waitFor(() => {
      const snapshot = editorial.listRoundSnapshotsForGoal(started.goal.id)[0]!;
      expect(snapshot.round).toMatchObject({ status: "failed", failureCode: "GROWTH_SPECIALIST_PROVIDER_REQUIRED" });
      expect(snapshot.workOrders[0]).toMatchObject({ status: "failed", failureCode: "GROWTH_SPECIALIST_PROVIDER_REQUIRED" });
      expect(snapshot.attempts).toEqual([]);
      expect(snapshot.artifacts).toEqual([]);
    });
    expect(workers).toEqual([]);
    expect(new GrowthRepository(setup.workspace).listCycles(started.goal.id)).toEqual([]);
    expect(readCount(setup.workspace, "change_sets")).toBe(0);
  });

  it("times out a silent Worker and persists no candidate", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => setup.session.acquireAgentRuntimeLease(),
      getProviderProfile: providerProfile,
      editorialTimeoutMs: 25,
      spawnWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor, {
      route: "world_director_geography",
      requireEditorialPrompt: () => activeGeographyPrompt(),
    });

    const started = coordinator.start(growthRequest(setup));
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0]!.spawn();
    await vi.waitFor(() => expect(workers[0]!.sent).toHaveLength(1));
    const editorial = new GrowthEditorialRepository(setup.workspace);
    await vi.waitFor(() => {
      const snapshot = editorial.listRoundSnapshotsForGoal(started.goal.id)[0]!;
      expect(snapshot.round).toMatchObject({ status: "failed", failureCode: "GROWTH_SPECIALIST_TIMEOUT" });
      expect(snapshot.workOrders[0]).toMatchObject({ status: "failed", failureCode: "GROWTH_SPECIALIST_TIMEOUT" });
      expect(snapshot.artifacts).toEqual([]);
    });
    expect(workers[0]!.killed).toBe(true);
  });

  it("cancels an active geography delegation without persisting a candidate", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => setup.session.acquireAgentRuntimeLease(),
      getProviderProfile: providerProfile,
      cancelGraceMs: 1,
      spawnWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor, {
      route: "world_director_geography",
      requireEditorialPrompt: () => activeGeographyPrompt(),
    });

    const started = coordinator.start(growthRequest(setup));
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0]!.spawn();
    await vi.waitFor(() => expect(workers[0]!.sent).toHaveLength(1));
    coordinator.dispose();
    coordinator = undefined;
    const editorial = new GrowthEditorialRepository(setup.workspace);
    await vi.waitFor(() => {
      const snapshot = editorial.listRoundSnapshotsForGoal(started.goal.id)[0]!;
      expect(snapshot.round).toMatchObject({ status: "cancelled", failureCode: "AGENT_RUN_CANCELLED" });
      expect(snapshot.workOrders[0]).toMatchObject({ status: "cancelled", failureCode: "AGENT_RUN_CANCELLED" });
      expect(snapshot.artifacts).toEqual([]);
    });
    await vi.waitFor(() => expect(workers[0]!.killed).toBe(true));
  });
});

function createSetup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-world-director-geography-"));
  workspace = openWorkspace(root);
  const policy: ChangeSetPolicyEvaluator = {
    assess: (candidate) => candidate.items.map((item) => ({ itemId: item.id, risk: "low" as const, conflicts: [] })),
  };
  session = new WorkspaceSession(() => policy);
  session.openPath(root);
  application = new ApplicationRegistryRepository(path.join(root, "application.db"));
  const project = application.registerProject(root, "ready");
  application.selectProject(project.id);
  const agentSession = application.createSession(project.id, "Growth");
  return {
    root,
    workspace,
    session,
    application,
    projectId: project.id,
    sessionId: agentSession.id,
    checkpointId: new CheckpointRepository(workspace).getActiveBranch().headCheckpointId,
  };
}

function activeGeographyPrompt(): GrowthEditorialPrompt {
  const capability = requireAgentCapability("geography_ecology_author");
  const content = [
    "# Capability: geography_ecology_author",
    "Use evidence only and call submit_specialist_candidate exactly once.",
  ].join("\n");
  return {
    id: capability.promptAsset.id,
    version: capability.promptAsset.version,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    status: "active",
    content,
    publicationEvidence: {
      reportPath: "notes/evidence/editorial/geography-test.json",
      reportSha256: "e".repeat(64),
    },
  };
}

function growthRequest(setup: ReturnType<typeof createSetup>) {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    projectId: setup.projectId,
    sessionId: setup.sessionId,
    seed: {
      kind: "text" as const,
      text: "创建一个古老、辽阔、适合多文明兴衰的中土式原创魔幻世界。",
    },
    initialRuleText: "先建立地理与生态基本面貌；不要提前生成国家、人物、故事或图片。",
    strategy: "grow_world_story_oc_closure_v4" as const,
  };
}

function providerProfile() {
  return {
    providerId: "test-provider",
    displayName: "Test Provider",
    baseUrl: "https://provider.example/v1",
    modelId: "test-model",
    contextWindow: 128_000,
    maxTokens: 8_000,
    reasoning: false,
    input: ["text" as const],
    apiKey: "test-secret-key",
  };
}

function readCount(database: WorkspaceDatabase, table: string): number {
  const row = database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}
