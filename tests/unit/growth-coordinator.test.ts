import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeSetPolicyEvaluator } from "../../src/domain/changeSet/changeSetService";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { AgentProcessSupervisor, type AgentWorkerProcess } from "../../src/main/agentProcessSupervisor";
import { GrowthCoordinator } from "../../src/main/growthCoordinator";
import { GrowthRunLifecycle } from "../../src/main/growthRunLifecycle";
import { planGrowthFrontier } from "../../src/main/growthFrontierPlanner";
import { WorkspaceSession } from "../../src/main/workspaceIpc";
import { growthStartRequestSchema } from "../../src/shared/ipcContract";
import { compileGrowthWorldFragment } from "../../src/agent-worker/growth/growthWorldFragment";

class FakeWorker extends EventEmitter implements AgentWorkerProcess {
  killed = false;
  readonly sent: unknown[] = [];
  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message); queueMicrotask(() => callback?.(null)); return true;
  }
  kill(): boolean { this.killed = true; return true; }
  spawn(): void { this.emit("spawn"); }
  receive(message: unknown): void { this.emit("message", message); }
}

let root: string | undefined;
let application: ApplicationRegistryRepository | undefined;
let session: WorkspaceSession | undefined;
let workspace: WorkspaceDatabase | undefined;

afterEach(() => {
  session?.close(); application?.close(); workspace?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined; application = undefined; session = undefined; workspace = undefined;
});

describe("GrowthCoordinator", () => {
  it.each([
    { label: "persisted world", seedKinds: ["world"], formalCoverageKinds: ["world"], focusKinds: ["story"], resumeFrontier: ["oc"] },
    { label: "persisted story", seedKinds: ["story"], formalCoverageKinds: ["story"], focusKinds: ["world"], resumeFrontier: ["oc"] },
    { label: "persisted oc", seedKinds: ["oc"], formalCoverageKinds: ["oc"], focusKinds: ["story"], resumeFrontier: ["world"] },
    { label: "unknown text", seedKinds: [], formalCoverageKinds: [], focusKinds: ["world"], resumeFrontier: ["story", "oc"] },
  ] as const)("routes a $label seed through a single focus without text keyword guessing", ({ seedKinds, formalCoverageKinds, focusKinds, resumeFrontier }) => {
    expect(planGrowthFrontier({
      seedKinds: [...seedKinds], formalCoverageKinds: [...formalCoverageKinds], currentRuleRevision: 1, latestCycle: null, closureStates: [],
    })).toEqual({ state: "plan", intent: { kind: "expand", focusKinds: [...focusKinds], resumeFrontier: [...resumeFrontier] } });
  });

  it("persists guidance during C1 and awaits a safe revision boundary without creating a Cycle or Worker", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const started = coordinator.start(growthRequest(setup));

    const guided = coordinator.guide({
      goalId: started.goal.id,
      expectedRevision: 1,
      ruleText: "Use the revised rule.",
      requestId: "22222222-2222-4222-8222-222222222222",
    });

    expect(guided).toEqual({
      goalId: started.goal.id,
      persistedRevision: 2,
      currentCycleRevision: 1,
      appliesAt: "next_cycle_boundary",
      nextCycleSequence: 2,
      nextCycleKind: "revision",
      focusKinds: ["world"],
      status: "persisted_pending_boundary",
    });
    workers[0]!.spawn();
    await vi.waitFor(() => expect(workers[0]!.sent).toHaveLength(1));
    expect((workers[0]!.sent[0] as { userInput: string }).userInput).toContain("Keep sources.");
    expect((workers[0]!.sent[0] as { userInput: string }).userInput).not.toContain("Use the revised rule.");

    await completeCycle(setup.workspace, workers[0]!);
    await vi.waitFor(() => expect(coordinator.get({
      projectId: setup.projectId, sessionId: setup.sessionId, goalId: started.goal.id,
    }).coordinatorStatus).toBe("awaiting_guidance"));
    const repository = new GrowthRepository(setup.workspace);
    expect(repository.listCycles(started.goal.id).map((cycle) => cycle.status)).toEqual(["committed"]);
    expect(repository.listEvents(started.goal.id).some((event) => event.cycleId.endsWith(":cycle:2"))).toBe(false);
    expect(workers).toHaveLength(1);
  });

  it("replays one guidance identity exactly and rejects a competing CAS write", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const started = coordinator.start(growthRequest(setup));
    const request = {
      goalId: started.goal.id, expectedRevision: 1, ruleText: "Revision two.",
      sourceMessageId: "message-guidance-2",
    };

    const first = coordinator.guide(request);
    expect(coordinator.guide(request)).toEqual(first);
    expect(() => coordinator.guide({
      goalId: started.goal.id, expectedRevision: 1, ruleText: "Competing revision.",
      requestId: "33333333-3333-4333-8333-333333333333",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_RULE_REVISION_MISMATCH" }));
    expect(coordinator.guide({
      goalId: started.goal.id, expectedRevision: 2, ruleText: "Revision three.",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })).toMatchObject({ persistedRevision: 3, currentCycleRevision: 1, nextCycleSequence: 2 });
    expect(coordinator.guide(request)).toEqual(first);
    expect(coordinator.get({ projectId: setup.projectId, sessionId: setup.sessionId, goalId: started.goal.id })).toMatchObject({
      currentRuleRevision: 3,
      activeCycleRuleRevision: 1,
      guidanceStatus: "persisted_pending_boundary",
    });

    await completeCycle(setup.workspace, workers[0]!);
    await vi.waitFor(() => expect(coordinator.get({
      projectId: setup.projectId, sessionId: setup.sessionId, goalId: started.goal.id,
    }).coordinatorStatus).toBe("awaiting_guidance"));
    const repository = new GrowthRepository(setup.workspace);
    expect(repository.listCycles(started.goal.id)).toHaveLength(1);
    expect(repository.listRuleRevisions(started.goal.id, { limit: 10 }).map((rule) => rule.revision)).toEqual([1, 2, 3]);
    expect(workers).toHaveLength(1);
  });

  it("persists guidance while the automatic Closure evaluation is running without creating Cycle 5", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const started = coordinator.start(growthRequest(setup));
    await completeCycle(setup.workspace, workers[0]!);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await completeCycle(setup.workspace, workers[1]!);
    await vi.waitFor(() => expect(workers).toHaveLength(3));

    await completeCycle(setup.workspace, workers[2]!);
    await vi.waitFor(() => expect(workers).toHaveLength(4));
    const getRequest = { projectId: setup.projectId, sessionId: setup.sessionId, goalId: started.goal.id };
    const routed: Array<{ event: { cycleId: string; phase: string } }> = [];
    const initiallyAwaiting = coordinator.get(getRequest, { growth: (event) => routed.push(event) });
    expect(initiallyAwaiting.coordinatorStatus).toBe("running");
    expect(initiallyAwaiting.cycles).toHaveLength(4);
    expect(new GrowthRepository(setup.workspace).getCycleIntent(initiallyAwaiting.cycles[3]!.id))
      .toMatchObject({ kind: "closure_evaluation", provenance: "persisted_v26" });
    const response = coordinator.guide({
      goalId: started.goal.id, expectedRevision: 1, ruleText: "Save revision two.",
      requestId: "99999999-9999-4999-8999-999999999999",
    });
    expect(response).toMatchObject({ nextCycleSequence: 5, nextCycleKind: "revision", persistedRevision: 2 });
    const afterRevisionTwo = coordinator.get(getRequest);
    expect(afterRevisionTwo.coordinatorStatus).toBe("running");
    expect(afterRevisionTwo.cycles).toHaveLength(4);
    expect(workers).toHaveLength(4);
    expect(coordinator.guide({
      goalId: started.goal.id, expectedRevision: 2, ruleText: "Save revision three.",
      requestId: "88888888-8888-4888-8888-888888888888",
    })).toMatchObject({ nextCycleSequence: 5, nextCycleKind: "revision", persistedRevision: 3 });
    const afterRevisionThree = coordinator.get(getRequest);
    expect(afterRevisionThree.coordinatorStatus).toBe("running");
    expect(afterRevisionThree.cycles).toHaveLength(4);
    const repository = new GrowthRepository(setup.workspace);
    expect(repository.listCycles(started.goal.id).map((cycle) => cycle.status)).toEqual(["committed", "committed", "committed", "running"]);
    expect(repository.listRuleRevisions(started.goal.id, { limit: 10 }).map((rule) => rule.revision)).toEqual([1, 2, 3]);
    expect(workers).toHaveLength(4);
    expect(routed).toEqual([]);
    supervisor.cancel(initiallyAwaiting.cycles[3]!.runId!);
    await vi.waitFor(() => expect(repository.getCycle(initiallyAwaiting.cycles[3]!.id)?.status).toBe("cancelled"));
  });

  it("rebuilds active workspace authority after restart and rejects unknown or cross-project Goals", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const started = new GrowthCoordinator(setup.session, setup.application, supervisor).start(growthRequest(setup));
    const restarted = new GrowthCoordinator(setup.session, setup.application, supervisor);
    expect(restarted.guide({
      goalId: started.goal.id, expectedRevision: 1, ruleText: "Restart-safe revision.",
      requestId: "55555555-5555-4555-8555-555555555555",
    }).persistedRevision).toBe(2);
    expect(() => restarted.guide({
      goalId: "unknown-goal", expectedRevision: 1, ruleText: "Unknown.",
      requestId: "66666666-6666-4666-8666-666666666666",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_GOAL_NOT_FOUND" }));

    const otherRoot = path.join(root!, "other-project");
    fs.mkdirSync(otherRoot);
    const other = setup.application.registerProject(otherRoot, "ready");
    setup.application.selectProject(other.id);
    expect(() => restarted.guide({
      goalId: started.goal.id, expectedRevision: 2, ruleText: "Cross project.",
      requestId: "77777777-7777-4777-8777-777777777777",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_WORKSPACE_REQUIRED" }));
    setup.application.selectProject(setup.projectId);

    workers[0]!.spawn();
    supervisor.cancel(runId(workers[0]!));
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).listCycles(started.goal.id)[0]!.status).toBe("cancelled"));
  });

  it("reopens a committed crash boundary through get, registers its route, and starts exactly one next expand Cycle", async () => {
    const setup = createSetup();
    const firstWorkers: FakeWorker[] = [];
    const firstSupervisor = createSupervisor(setup, firstWorkers);
    const repository = new GrowthRepository(setup.workspace);
    const request = growthRequest(setup);
    const context = setup.session.getGrowthCoordinatorContext();
    if (!context) throw new Error("Expected Growth coordinator context.");
    const checkpointId = new CheckpointRepository(setup.workspace).getActiveBranch().headCheckpointId;
    const goal = repository.createGoal({
      id: goalIdForRequest(request),
      idempotencyKey: `growth-start:${setup.projectId}:${request.requestId}`,
      branchId: new CheckpointRepository(setup.workspace).getActiveBranch().id,
      seed: request.seed,
      authorizedScopeResourceIds: context.authorizedScopeResourceIds,
      initialRuleText: request.initialRuleText,
      sourceMessageId: null,
    });
    const cycle = repository.beginCycle({
      id: `${goal.id}:cycle:1`, goalId: goal.id, idempotencyKey: `${goal.id}:cycle:1`,
      inputCheckpointId: checkpointId, ruleRevision: 1,
      intent: { kind: "expand", focusKinds: ["world"], resumeFrontier: ["story", "oc"] },
    });
    new GrowthRunLifecycle(setup.workspace, firstSupervisor).start({
      goalId: goal.id,
      cycleId: cycle.id,
      request: {
        projectId: setup.projectId, sessionId: setup.sessionId, userInput: "persisted crash boundary",
        mode: "free", scopeResourceIds: [],
      },
      emit: () => undefined,
    });
    await commitCycleWithoutRunTerminal(setup.workspace, firstWorkers[0]!);
    expect(repository.getCycle(cycle.id)?.status).toBe("committed");
    firstSupervisor.dispose();
    await vi.waitFor(() => {
      const lease = setup.session.acquireAgentRuntimeLease();
      expect(lease).not.toBeNull();
      lease?.release();
    });

    const reopenedWorkers: FakeWorker[] = [];
    const reopenedSupervisor = createSupervisor(setup, reopenedWorkers);
    const reopened = new GrowthCoordinator(setup.session, setup.application, reopenedSupervisor);
    const growthEvents: Array<{ event: { cycleId: string; phase: string } }> = [];
    const getRequest = { projectId: setup.projectId, sessionId: setup.sessionId, goalId: goal.id };
    const snapshot = reopened.get(getRequest, {
      growth: (event) => growthEvents.push(event),
    });
    expect(snapshot.coordinatorStatus).toBe("running");
    expect(snapshot.cycles.map((entry) => entry.status)).toEqual(["committed", "running"]);
    expect(repository.getCycleIntent(snapshot.cycles[1]!.id)).toMatchObject({ kind: "expand", focusKinds: ["story"], resumeFrontier: ["oc"] });
    expect(growthEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ cycleId: snapshot.cycles[1]!.id, phase: "cycle_planned" }) }),
    ]));
    expect(reopenedWorkers).toHaveLength(1);

    expect(reopened.get(getRequest, { growth: (event) => growthEvents.push(event) }).cycles).toHaveLength(2);
    expect(new GrowthRepository(setup.workspace).listCycles(goal.id)).toHaveLength(2);
    expect(reopenedWorkers).toHaveLength(1);
    reopenedWorkers[0]!.spawn();
    reopenedSupervisor.cancel(runId(reopenedWorkers[0]!));
    await vi.waitFor(() => expect(repository.getCycle(snapshot.cycles[1]!.id)?.status).toBe("cancelled"));
  });

  it("runs three content cycles then automatically starts one persisted Closure evaluation", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => setup.session.acquireAgentRuntimeLease(),
      spawnWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    });
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const live: unknown[] = [];
    const agentEvents: Array<{ type: string; sessionId?: string }> = [];
    const request = growthRequest(setup);

    const initial = coordinator.start(request, {
      growth: (event) => live.push(event),
      agent: (event) => agentEvents.push(event),
    });
    expect(initial.cycles).toHaveLength(1);
    await completeCycle(setup.workspace, workers[0]!);
    expect((workers[0]!.sent[0] as { userInput: string }).userInput).toContain("Keep sources.");
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await completeCycle(setup.workspace, workers[1]!);
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    await completeCycle(setup.workspace, workers[2]!);

    await vi.waitFor(() => expect(coordinator.get({ projectId: setup.projectId, sessionId: setup.sessionId, goalId: initial.goal.id }).cycles).toHaveLength(4));
    const snapshot = coordinator.get({ projectId: setup.projectId, sessionId: setup.sessionId, goalId: initial.goal.id });
    expect(snapshot.goal.status).toBe("active");
    expect(snapshot.coordinatorStatus).toBe("running");
    expect(snapshot.activeCycleRuleRevision).toBe(1);
    expect(snapshot.cycles.map((cycle) => cycle.status)).toEqual(["committed", "committed", "committed", "running"]);
    expect(snapshot.cycles.slice(0, 3).map((cycle) => cycle.runId)).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(new Set(snapshot.cycles.slice(0, 3).map((cycle) => cycle.runId)).size).toBe(3);
    const repository = new GrowthRepository(setup.workspace);
    const cycles = repository.listCycles(initial.goal.id);
    expect(repository.listCycleIntents(initial.goal.id).slice(0, 3).every((intent) => (
      (intent.kind === "expand" || intent.kind === "revision") && intent.focusKinds.length === 1
    ))).toBe(true);
    expect(repository.listCycleIntents(initial.goal.id)[3]).toMatchObject({ kind: "closure_evaluation", provenance: "persisted_v26" });
    expect(cycles[1]!.inputCheckpointId).toBe(cycles[0]!.outputCheckpointId);
    expect(cycles[2]!.inputCheckpointId).toBe(cycles[1]!.outputCheckpointId);
    expect(cycles.slice(0, 3).every((cycle) => cycle.receiptId && cycle.changeSetId && cycle.outputCheckpointId)).toBe(true);
    const closureStates = repository.listClosureStates(initial.goal.id);
    expect(closureStates).toHaveLength(1);
    const closureProfile = repository.getClosureProfile(closureStates[0]!.profileId);
    expect(closureProfile).toMatchObject({
      profileKind: "mixed_birth",
      contractGeneration: "v26",
      componentProfiles: ["world_birth", "story_universe", "oc_saga"],
      focusOcResourceId: `oc-${runId(workers[2]!)}`,
    });
    expect(repository.getClosureRevision(closureProfile!.id, 1)?.facets).toEqual(expect.arrayContaining([
      { id: "closure.world.fact.history_timeline", kind: "content", required: true },
      { id: "closure.story.fact.stage_resolution", kind: "content", required: true },
      { id: "closure.oc.structure.personal_story_10000", kind: "content", required: true },
      { id: "closure.oc.binding.personal_story", kind: "content", required: true },
    ]));
    expect(snapshot.events.map((event) => event.sequence)).toEqual([...snapshot.events.keys()].map((index) => index + 1));
    expect(snapshot.events.find((event) => event.phase === "receipt_recorded")).toHaveProperty("targetVersionId");
    expect(snapshot.events.find((event) => event.phase === "receipt_recorded")).toHaveProperty("contentRef", null);
    expect(live).toEqual(expect.arrayContaining(snapshot.events.map((event) => expect.objectContaining({ event }))));
    expect(agentEvents.map((event) => event.type)).toEqual(expect.arrayContaining(["run.started", "run.activity", "run.completed"]));
    expect(agentEvents.every((event) => event.sessionId === setup.sessionId)).toBe(true);
    expect(coordinator.start(request).cycles).toHaveLength(4);
    expect(workers).toHaveLength(4);
    supervisor.cancel(snapshot.cycles[3]!.runId!);
    await vi.waitFor(() => expect(repository.getCycle(cycles[3]!.id)?.status).toBe("cancelled"));
  });

  it("automatically repairs one Checker finding, rechecks the new checkpoint, and completes only after acceptance", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const request = growthRequest(setup);
    const started = coordinator.start(request);

    await completeCycle(setup.workspace, workers[0]!);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await completeCycle(setup.workspace, workers[1]!);
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    await completeCycle(setup.workspace, workers[2]!);
    await vi.waitFor(() => expect(workers).toHaveLength(4));

    const firstEvaluation = await sealCoordinatorClosureEvaluation(
      setup.workspace, workers[3]!, "repairs_required", "repair-before",
    );
    workers[3]!.receive({
      type: "run.completed", runId: runId(workers[3]!), outcome: "completed",
      message: "repair required", changeSetState: "none", artifacts: [],
    });
    await vi.waitFor(() => expect(workers).toHaveLength(5));

    const repairWorker = workers[4]!;
    repairWorker.spawn();
    await vi.waitFor(() => expect(repairWorker.sent).toHaveLength(1));
    const repairRunId = runId(repairWorker);
    const repairCommand = repairWorker.sent[0] as {
      growthBinding: {
        kind: string;
        closureProfile: null;
        closureRepair: {
          originalReviewId: string;
          selectedFindingId: string;
          selectedFindingFingerprint: string;
          targetEvidenceIds: string[];
        };
      };
    };
    expect(repairCommand.growthBinding).toMatchObject({
      kind: "repair", closureProfile: null,
      closureRepair: {
        originalReviewId: firstEvaluation.review.id,
        selectedFindingId: firstEvaluation.finding!.id,
        selectedFindingFingerprint: firstEvaluation.finding!.fingerprint,
        targetEvidenceIds: [firstEvaluation.targetEvidenceId],
      },
    });
    repairWorker.receive({ type: "run.started", runId: repairRunId });
    beginStewardInvocation(setup.workspace, repairRunId);
    requestCoordinatorRetrieval(repairWorker, repairRunId, "repair target");
    await vi.waitFor(() => expect(repairWorker.sent.at(-1)).toMatchObject({
      ok: true, result: { evidence: [expect.objectContaining({ evidenceId: firstEvaluation.targetEvidenceId })] },
    }));
    const worldResourceId = new ResourceRepository(setup.workspace).listCurrent()
      .find((resource) => resource.objectKind === "world")!.id;
    repairWorker.receive({
      type: "tool.request", runId: repairRunId, requestId: randomUUID(), tool: "propose_change_set",
      args: {
        summary: "Apply only the reviewed world correction.",
        items: [{
          id: "repair-reviewed-world", dependsOn: [], kind: "resource.put",
          payload: {
            resourceId: worldResourceId, create: false, type: "world", objectKind: "world",
            title: "The Reviewed Tidemark", parentId: setup.scopeId, state: "active", sortOrder: 0,
          },
        }],
      },
    });
    await vi.waitFor(() => expect(repairWorker.sent.at(-1)).toMatchObject({
      ok: true, result: { status: "committed", changeSetId: expect.any(String) },
    }));
    repairWorker.receive({
      type: "run.completed", runId: repairRunId, outcome: "completed",
      message: "repair committed", changeSetState: "committed", artifacts: [],
    });
    await vi.waitFor(() => expect(workers).toHaveLength(6));

    const repository = new GrowthRepository(setup.workspace);
    const repairCycle = repository.listCycles(started.goal.id).find((cycle) => (
      repository.getCycleIntent(cycle.id).kind === "repair"
    ))!;
    const repairLineage = repository.getClosureRepairLineageForCycle(repairCycle.id)!;
    expect(repairCycle).toMatchObject({
      status: "committed", changeSetId: expect.any(String), outputCheckpointId: expect.any(String),
    });
    expect(repairLineage.resolutionState).toBe("planned");
    const recheckCycle = repository.listCycles(started.goal.id).at(-1)!;
    expect(repository.getCycleIntent(recheckCycle.id)).toMatchObject({
      kind: "closure_evaluation", revision: 2, checkpointId: repairCycle.outputCheckpointId,
    });
    expect(recheckCycle.inputCheckpointId).toBe(repairCycle.outputCheckpointId);

    await sealCoordinatorClosureEvaluation(setup.workspace, workers[5]!, "accepted", "repair-after");
    workers[5]!.receive({
      type: "run.completed", runId: runId(workers[5]!), outcome: "completed",
      message: "accepted", changeSetState: "none", artifacts: [],
    });
    await vi.waitFor(() => expect(coordinator.get({
      projectId: setup.projectId, sessionId: setup.sessionId, goalId: started.goal.id,
    }).coordinatorStatus).toBe("completed"));
    expect(repository.getClosureRepairLineage(repairLineage.id)?.resolutionState).toBe("resolved");
    expect(repository.listCycles(started.goal.id).map((cycle) => cycle.status)).toEqual([
      "committed", "committed", "committed", "evaluated", "committed", "evaluated",
    ]);
    expect(workers).toHaveLength(6);
  });

  it("fails closed when a planned repair is recovered without durable lineage", async () => {
    const setup = createSetup();
    const originalWorkers: FakeWorker[] = [];
    const originalSupervisor = createSupervisor(setup, originalWorkers);
    const original = new GrowthCoordinator(setup.session, setup.application, originalSupervisor);
    const boundary = await preparePlannedRepairRecoveryBoundary(setup, original, originalWorkers, "missing-lineage");
    originalSupervisor.dispose();

    const reopenedWorkers: FakeWorker[] = [];
    const reopened = new GrowthCoordinator(setup.session, setup.application, createSupervisor(setup, reopenedWorkers));
    const snapshot = reopened.get({
      projectId: setup.projectId, sessionId: setup.sessionId, goalId: boundary.goalId,
    });
    expect(snapshot.cycles.at(-1)).toMatchObject({
      id: boundary.repairCycle.id, status: "failed", runId: null,
    });
    expect(boundary.repository.getCycle(boundary.repairCycle.id)?.failureCode)
      .toBe("GROWTH_CLOSURE_REPAIR_LINEAGE_INVALID");
    expect(reopenedWorkers).toHaveLength(0);
    originalWorkers[3]!.receive({
      type: "run.completed", runId: runId(originalWorkers[3]!), outcome: "completed",
      message: "release missing-lineage crash boundary", changeSetState: "none", artifacts: [],
    });
  });

  it("blocks a planned repair recovered after its durable lineage became stalled", async () => {
    const setup = createSetup();
    const originalWorkers: FakeWorker[] = [];
    const originalSupervisor = createSupervisor(setup, originalWorkers);
    const original = new GrowthCoordinator(setup.session, setup.application, originalSupervisor);
    const boundary = await preparePlannedRepairRecoveryBoundary(setup, original, originalWorkers, "stalled-lineage");
    const lineage = boundary.repository.createClosureRepairLineage({
      id: "lineage-stalled-recovery", profileId: boundary.evaluation.review.profileId,
      revision: boundary.evaluation.review.revision, originalReviewId: boundary.evaluation.review.id,
      selectedFindingId: boundary.evaluation.finding!.id,
      selectedFindingFingerprint: boundary.evaluation.finding!.fingerprint,
      repairCycleId: boundary.repairCycle.id, backlogFindingIds: [],
      idempotencyKey: "lineage-stalled-recovery-key",
    });
    setup.workspace.db.prepare(`
      UPDATE growth_closure_repair_lineage SET resolution_state = 'stalled' WHERE id = ?
    `).run(lineage.id);
    originalSupervisor.dispose();

    const reopenedWorkers: FakeWorker[] = [];
    const reopened = new GrowthCoordinator(setup.session, setup.application, createSupervisor(setup, reopenedWorkers));
    const snapshot = reopened.get({
      projectId: setup.projectId, sessionId: setup.sessionId, goalId: boundary.goalId,
    });
    expect(snapshot.cycles.at(-1)).toMatchObject({
      id: boundary.repairCycle.id, status: "blocked", runId: null,
    });
    expect(boundary.repository.getCycle(boundary.repairCycle.id)?.failureCode)
      .toBe("GROWTH_CLOSURE_REPAIR_STALLED");
    expect(reopenedWorkers).toHaveLength(0);
    originalWorkers[3]!.receive({
      type: "run.completed", runId: runId(originalWorkers[3]!), outcome: "completed",
      message: "release stalled-lineage crash boundary", changeSetState: "none", artifacts: [],
    });
  });

  it("stops without another Worker when the same Checker finding survives the repair recheck", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const started = coordinator.start(growthRequest(setup));

    await completeCycle(setup.workspace, workers[0]!);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await completeCycle(setup.workspace, workers[1]!);
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    await completeCycle(setup.workspace, workers[2]!);
    await vi.waitFor(() => expect(workers).toHaveLength(4));
    await sealCoordinatorClosureEvaluation(setup.workspace, workers[3]!, "repairs_required", "stall-before");
    workers[3]!.receive({
      type: "run.completed", runId: runId(workers[3]!), outcome: "completed",
      message: "repair required", changeSetState: "none", artifacts: [],
    });
    await vi.waitFor(() => expect(workers).toHaveLength(5));
    await completeCoordinatorRepair(setup.workspace, workers[4]!, setup.scopeId, "The First Reviewed Tidemark");
    await vi.waitFor(() => expect(workers).toHaveLength(6));

    await sealCoordinatorClosureEvaluation(setup.workspace, workers[5]!, "repairs_required", "stall-after");
    workers[5]!.receive({
      type: "run.completed", runId: runId(workers[5]!), outcome: "completed",
      message: "same finding remains", changeSetState: "none", artifacts: [],
    });
    await vi.waitFor(() => expect(coordinator.get({
      projectId: setup.projectId, sessionId: setup.sessionId, goalId: started.goal.id,
    }).coordinatorStatus).toBe("blocked"));

    const repository = new GrowthRepository(setup.workspace);
    const cycles = repository.listCycles(started.goal.id);
    expect(cycles.at(-1)).toMatchObject({
      status: "blocked", runId: null, changeSetId: null, outputCheckpointId: null,
      failureCode: "GROWTH_CLOSURE_REPAIR_STALLED",
    });
    const lineages = cycles
      .map((cycle) => repository.getClosureRepairLineageForCycle(cycle.id))
      .filter((lineage) => lineage !== null);
    expect(lineages.map((lineage) => lineage.resolutionState)).toEqual(["no_progress", "stalled"]);
    expect(workers).toHaveLength(6);
  });

  it("treats a replacement Checker finding as progress and starts one newly bounded repair", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const started = coordinator.start(growthRequest(setup));

    await completeCycle(setup.workspace, workers[0]!);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await completeCycle(setup.workspace, workers[1]!);
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    await completeCycle(setup.workspace, workers[2]!);
    await vi.waitFor(() => expect(workers).toHaveLength(4));
    await sealCoordinatorClosureEvaluation(
      setup.workspace, workers[3]!, "repairs_required", "replacement-before", "a".repeat(64),
    );
    workers[3]!.receive({
      type: "run.completed", runId: runId(workers[3]!), outcome: "completed",
      message: "first repair required", changeSetState: "none", artifacts: [],
    });
    await vi.waitFor(() => expect(workers).toHaveLength(5));
    await completeCoordinatorRepair(setup.workspace, workers[4]!, setup.scopeId, "The Reviewed Tidemark");
    await vi.waitFor(() => expect(workers).toHaveLength(6));

    await sealCoordinatorClosureEvaluation(
      setup.workspace, workers[5]!, "repairs_required", "replacement-after", "b".repeat(64),
    );
    workers[5]!.receive({
      type: "run.completed", runId: runId(workers[5]!), outcome: "completed",
      message: "a different finding remains", changeSetState: "none", artifacts: [],
    });
    await vi.waitFor(() => expect(workers).toHaveLength(7));

    const repository = new GrowthRepository(setup.workspace);
    const lineages = repository.listCycles(started.goal.id)
      .map((cycle) => repository.getClosureRepairLineageForCycle(cycle.id))
      .filter((lineage) => lineage !== null);
    expect(lineages.map((lineage) => lineage.resolutionState)).toEqual(["committed", "planned"]);
    expect(lineages.map((lineage) => lineage.selectedFindingFingerprint)).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(repository.getClosureRepairStallState(
      lineages[1]!.profileId, lineages[1]!.revision, lineages[1]!.selectedFindingFingerprint,
    )).toMatchObject({ stalled: false, sameFingerprintAttempts: 1, noProgressAttempts: 0 });
    expect(repository.getClosureRepairStallState(
      lineages[0]!.profileId, lineages[1]!.revision, lineages[0]!.selectedFindingFingerprint,
    )).toMatchObject({ stalled: false, sameFingerprintAttempts: 0, noProgressAttempts: 0 });
    workers[6]!.spawn();
    await vi.waitFor(() => expect(workers[6]!.sent).toHaveLength(1));
    supervisor.cancel(runId(workers[6]!));
  });

  it("stops after a failed Cycle and recovers a running Cycle to reconciliation", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => setup.session.acquireAgentRuntimeLease(),
      spawnWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    });
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const first = coordinator.start(growthRequest(setup));
    workers[0]!.spawn();
    workers[0]!.receive({ type: "run.failed", runId: runId(workers[0]!), code: "PROVIDER_RUNTIME_FAILED", message: "safe", artifacts: [] });
    await vi.waitFor(() => expect(coordinator.get({ projectId: setup.projectId, sessionId: setup.sessionId, goalId: first.goal.id }).cycles[0]!.status).toBe("failed"));
    expect(coordinator.start(growthRequest(setup)).cycles).toHaveLength(1);
    expect(workers).toHaveLength(1);

    const runningSetup = createSetup();
    const runningWorkers: FakeWorker[] = [];
    const runningSupervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => runningSetup.session.acquireAgentRuntimeLease(),
      spawnWorker: () => { const worker = new FakeWorker(); runningWorkers.push(worker); return worker; },
    });
    const runningCoordinator = new GrowthCoordinator(runningSetup.session, runningSetup.application, runningSupervisor);
    const runningRequest = growthRequest(runningSetup);
    const running = runningCoordinator.start(runningRequest);
    expect(running.cycles[0]!.status).toBe("running");
    expect(runningCoordinator.start(runningRequest).cycles[0]!.status).toBe("running");
    expect(runningWorkers).toHaveLength(1);
    const restartedCoordinator = new GrowthCoordinator(runningSetup.session, runningSetup.application, runningSupervisor);
    expect(restartedCoordinator.get({ projectId: runningSetup.projectId, sessionId: runningSetup.sessionId, goalId: running.goal.id }).cycles[0]!.status)
      .toBe("reconciliation_required");
    runningWorkers[0]!.spawn();
    runningSupervisor.cancel(runId(runningWorkers[0]!));
  });

  it("rejects client-supplied authority fields through the strict request contract", () => {
    const setup = createSetup();
    expect(growthStartRequestSchema.safeParse({ ...growthRequest(setup), scopeResourceIds: ["forged"] }).success).toBe(false);
    expect(growthStartRequestSchema.safeParse({ ...growthRequest(setup), checkpointId: "forged", lens: "player", credential: "secret" }).success).toBe(false);
  });

  it("fails closed for mismatched request replay and never duplicates an intermediate Cycle", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const request = growthRequest(setup);
    const first = coordinator.start(request);
    expect(() => coordinator.start({ ...request, initialRuleText: "Changed rule." })).toThrowError(expect.objectContaining({ code: "GROWTH_IDEMPOTENCY_KEY_REUSED" }));
    await completeCycle(setup.workspace, workers[0]!);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    const replay = coordinator.start(request);
    expect(replay.cycles).toHaveLength(2);
    expect(replay.cycles[0]!.status).toBe("committed");
    expect(workers).toHaveLength(2);
    expect(replay.goal.id).toBe(first.goal.id);
    workers[1]!.spawn();
    await vi.waitFor(() => expect(workers[1]!.sent).toHaveLength(1));
    supervisor.cancel(runId(workers[1]!));
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).listCycles(first.goal.id)[1]!.status).toBe("cancelled"));
  });

  it("isolates throwing delivery routes and deduplicates a repeated session route", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const request = growthRequest(setup);
    coordinator.start(request, { growth: () => { throw new Error("destroyed growth listener"); }, agent: () => { throw new Error("destroyed agent listener"); } });
    const delivered: number[] = [];
    coordinator.start(request, { growth: (event) => delivered.push(event.event.sequence) });
    await completeCycle(setup.workspace, workers[0]!);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await completeCycle(setup.workspace, workers[1]!);
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    await completeCycle(setup.workspace, workers[2]!);
    await vi.waitFor(() => expect(workers).toHaveLength(4));
    const snapshot = coordinator.get({ projectId: setup.projectId, sessionId: setup.sessionId, goalId: goalIdForRequest(request) });
    expect(snapshot.coordinatorStatus).toBe("running");
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(new GrowthRepository(setup.workspace).listEvents(snapshot.goal.id)).toHaveLength(snapshot.events.length);
    supervisor.cancel(snapshot.cycles[3]!.runId!);
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).getCycle(snapshot.cycles[3]!.id)?.status).toBe("cancelled"));
  });

  it("compensates a failed cycle_planned event without starting a Worker", () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    setup.workspace.db.exec("CREATE TRIGGER reject_cycle_planned BEFORE INSERT ON growth_events WHEN NEW.phase = 'cycle_planned' BEGIN SELECT RAISE(FAIL, 'injected'); END");
    expect(() => coordinator.start(growthRequest(setup))).toThrowError(expect.objectContaining({ code: "GROWTH_PLAN_EVENT_PERSISTENCE_FAILED" }));
    const repository = new GrowthRepository(setup.workspace);
    const cycle = repository.listCycles(goalIdForRequest(growthRequest(setup)))[0]!;
    expect(cycle).toMatchObject({ status: "failed", runId: null, failureCode: "GROWTH_PLAN_EVENT_PERSISTENCE_FAILED" });
    expect(repository.listEvents(cycle.goalId).map((event) => event.phase)).toEqual(["cycle_terminal"]);
    expect(workers).toHaveLength(0);
  });

  it("contains a failed next Cycle plan during a prior Run terminal callback and releases the prior lease", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const request = growthRequest(setup);
    const started = coordinator.start(request);
    setup.workspace.db.exec("CREATE TRIGGER reject_second_cycle_planned BEFORE INSERT ON growth_events WHEN NEW.phase = 'cycle_planned' AND NEW.cycle_id LIKE '%:cycle:2' BEGIN SELECT RAISE(FAIL, 'injected'); END");
    await expect(completeCycle(setup.workspace, workers[0]!)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).listCycles(started.goal.id).map((cycle) => cycle.status))
      .toEqual(["committed", "failed"]));
    const repository = new GrowthRepository(setup.workspace);
    expect(repository.listEvents(started.goal.id).some((event) => event.cycleId.endsWith(":cycle:2") && event.phase === "cycle_terminal")).toBe(true);
    expect(workers).toHaveLength(1);
    await vi.waitFor(() => {
      const lease = setup.session.acquireAgentRuntimeLease();
      if (!lease) throw new Error("Expected prior Growth Run lease to be released.");
      lease.release();
    });
  });

  it("keeps authoritative failure and Supervisor cleanup when a planned-start terminal event also cannot persist", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const started = coordinator.start(growthRequest(setup));
    setup.workspace.db.exec("CREATE TRIGGER reject_second_cycle_planned_again BEFORE INSERT ON growth_events WHEN NEW.phase = 'cycle_planned' AND NEW.cycle_id LIKE '%:cycle:2' BEGIN SELECT RAISE(FAIL, 'injected'); END");
    setup.workspace.db.exec("CREATE TRIGGER reject_second_cycle_terminal BEFORE INSERT ON growth_events WHEN NEW.phase = 'cycle_terminal' AND NEW.cycle_id LIKE '%:cycle:2' BEGIN SELECT RAISE(FAIL, 'injected'); END");
    await expect(completeCycle(setup.workspace, workers[0]!)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).listCycles(started.goal.id)[1]).toMatchObject({
      status: "failed", failureCode: "GROWTH_PLAN_EVENT_PERSISTENCE_FAILED",
    }));
    expect(workers).toHaveLength(1);
    await vi.waitFor(() => {
      const lease = setup.session.acquireAgentRuntimeLease();
      if (!lease) throw new Error("Expected prior Growth Run lease to be released.");
      lease.release();
    });
  });

  it("routes one replayed Goal to each verified session without cross-session event labels", async () => {
    const setup = createSetup();
    const second = setup.application.createSession(setup.projectId, "Growth replay");
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const request = growthRequest(setup);
    const firstSessions: string[] = [];
    const secondSessions: string[] = [];
    coordinator.start(request, {
      growth: (event) => firstSessions.push(event.sessionId),
      agent: (event) => firstSessions.push(event.sessionId ?? ""),
    });
    coordinator.start({ ...request, sessionId: second.id }, {
      growth: (event) => secondSessions.push(event.sessionId),
      agent: (event) => secondSessions.push(event.sessionId ?? ""),
    });
    workers[0]!.spawn();
    supervisor.cancel(runId(workers[0]!));
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).listCycles(goalIdForRequest(request))[0]!.status).toBe("cancelled"));
    expect(firstSessions.length).toBeGreaterThan(0);
    expect(secondSessions.length).toBeGreaterThan(0);
    expect(new Set(firstSessions)).toEqual(new Set([setup.sessionId]));
    expect(new Set(secondSessions)).toEqual(new Set([second.id]));
    expect(workers).toHaveLength(1);
  });

  it("stops replay after a blocked automatic Cycle", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const coordinator = new GrowthCoordinator(setup.session, setup.application, createSupervisor(setup, workers));
    const request = growthRequest(setup);
    const started = coordinator.start(request);
    workers[0]!.spawn();
    workers[0]!.receive({
      type: "run.completed", runId: runId(workers[0]!), outcome: "completed", message: "done", changeSetState: "none", artifacts: [],
    });
    await vi.waitFor(() => expect(coordinator.get({ projectId: setup.projectId, sessionId: setup.sessionId, goalId: started.goal.id }).coordinatorStatus).toBe("blocked"));
    expect(coordinator.start(request).cycles).toHaveLength(1);
    expect(workers).toHaveLength(1);
  });

  it("stops replay after a cancelled automatic Cycle", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const request = growthRequest(setup);
    const started = coordinator.start(request);
    workers[0]!.spawn();
    supervisor.cancel(runId(workers[0]!));
    await vi.waitFor(() => expect(coordinator.get({ projectId: setup.projectId, sessionId: setup.sessionId, goalId: started.goal.id }).coordinatorStatus).toBe("cancelled"));
    expect(coordinator.start(request).cycles).toHaveLength(1);
    expect(workers).toHaveLength(1);
  });

  it("pins root scope despite many descendants and preserves a trusted resource seed in the worker binding", async () => {
    const setup = createSetup();
    const worldRootId = new ResourceRepository(setup.workspace).listCurrent().find((resource) => resource.type === "world")!.id;
    const checkpointId = new CheckpointRepository(setup.workspace).getActiveBranch().headCheckpointId;
    const resources = new ResourceRepository(setup.workspace);
    resources.putRevision({
      resourceId: "seed-world", create: true, checkpointId,
      type: "world", objectKind: "world", title: "Seed world", parentId: worldRootId, state: "active", sortOrder: 0,
    });
    for (let index = 0; index < 101; index += 1) {
      resources.putRevision({
        resourceId: `descendant-${index}`, create: true, checkpointId,
        type: "world", objectKind: "location", title: `Location ${index}`, parentId: "seed-world", state: "active", sortOrder: index,
      });
    }
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    coordinator.start(growthRequest(setup, { seed: { kind: "resource", resourceId: "descendant-100", resourceVersionId: null } }));
    workers[0]!.spawn();
    const command = workers[0]!.sent[0] as { scopeResourceIds: string[]; growthBinding: { seedResourceIds: string[] } };
    expect(command.scopeResourceIds.length).toBeLessThanOrEqual(100);
    expect(command.scopeResourceIds).not.toContain("descendant-100");
    expect(command.growthBinding.seedResourceIds).toEqual(["descendant-100"]);
    supervisor.cancel(runId(workers[0]!));
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).listCycles(goalIdForRequest(growthRequest(setup)))[0]!.status).toBe("cancelled"));
  });
});

function createSetup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-coordinator-"));
  workspace = openWorkspace(root);
  const policy: ChangeSetPolicyEvaluator = { assess: (candidate) => candidate.items.map((item) => ({ itemId: item.id, risk: "low" as const, conflicts: [] })) };
  session = new WorkspaceSession(() => policy);
  session.openPath(root);
  application = new ApplicationRegistryRepository(path.join(root, "application.db"));
  const project = application.registerProject(root, "ready"); application.selectProject(project.id);
  const agentSession = application.createSession(project.id, "Growth");
  const scopeId = new ResourceRepository(workspace).listCurrent().find((resource) => resource.type === "world")!.id;
  return { workspace, session, application, projectId: project.id, sessionId: agentSession.id, scopeId };
}

function growthRequest(setup: ReturnType<typeof createSetup>, overrides: Partial<{
  seed: { kind: "text"; text: string } | { kind: "resource"; resourceId: string; resourceVersionId: string | null };
  initialRuleText: string;
}> = {}) {
  return {
    requestId: "11111111-1111-4111-8111-111111111111", projectId: setup.projectId, sessionId: setup.sessionId,
    seed: { kind: "text" as const, text: "A user seed." }, initialRuleText: "Keep sources.", strategy: "grow_world_story_oc_closure_v4" as const,
    ...overrides,
  };
}

function createSupervisor(setup: ReturnType<typeof createSetup>, workers: FakeWorker[]): AgentProcessSupervisor {
  return new AgentProcessSupervisor("worker.js", {
    acquireRuntimeLease: () => setup.session.acquireAgentRuntimeLease(),
    spawnWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
  });
}

function goalIdForRequest(request: { requestId: string }): string { return `growth-goal:${request.requestId}`; }

async function completeCycle(workspace: WorkspaceDatabase, worker: FakeWorker): Promise<void> {
  await commitCycleWithoutRunTerminal(workspace, worker);
  worker.receive({ type: "run.completed", runId: runId(worker), outcome: "completed", message: "done", changeSetState: "committed", artifacts: [] });
}

async function commitCycleWithoutRunTerminal(workspace: WorkspaceDatabase, worker: FakeWorker): Promise<void> {
  if (worker.sent.length === 0) worker.spawn();
  await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
  const id = runId(worker);
  const command = worker.sent[0] as { growthBinding: { cycleId: string; focusKinds: Array<"world" | "story" | "oc"> } };
  const focus = command.growthBinding.focusKinds[0]!;
  worker.receive({ type: "run.started", runId: id });
  beginStewardInvocation(workspace, id);
  worker.receive({ type: "tool.request", runId: id, requestId: randomUUID(), tool: "retrieve_graph_evidence", args: {
    variant: "growth_v1", query: "growth", aliases: [], seedResourceIds: [], maxHops: 0, cpuBudgetMs: 1000,
    expansionBudget: 20, resultBudget: 10, tokenBudget: 1000, contentBudgetChars: 4000, policyVersion: "graph-retrieval-v1",
  } });
  await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
  const retrievalResponse = worker.sent[1] as {
    ok: true;
    result: { evidence: Array<{ evidenceId: string }> };
  };
  const evidenceIds = retrievalResponse.result.evidence.map((evidence) => evidence.evidenceId);
  const evidenceState = evidenceIds.length > 0 ? "known" as const : "unknown" as const;
  worker.receive({
    type: "tool.request",
    runId: id,
    requestId: randomUUID(),
    tool: "submit_growth_inquiry",
    args: {
      inquiries: [3, 2, 1].map((priority, index) => ({
        localId: `question_${index + 1}`,
        question: `Which ${focus} consequence should cycle ${command.growthBinding.cycleId} pursue at priority ${priority}?`,
        evidenceIds,
        evidenceState,
        safeSummary: `Evaluating ${focus} consequence ${index + 1}.`,
        proposedAction: `Apply bounded ${focus} consequence ${index + 1}.`,
        provisionalAssumption: evidenceState === "unknown" ? `Assume bounded ${focus} continuity.` : null,
        priority,
        requiresCreatorChoice: false,
      })),
      selectedLocalId: "question_1",
      priorTransitions: [],
    },
  });
  await vi.waitFor(() => expect(worker.sent).toHaveLength(3));
  const roots = new ResourceRepository(workspace).listCurrent().filter((resource) => resource.objectKind === "domain_root");
  const scopeId = roots.find((resource) => resource.type === focus)!.id;
  const items = focus === "world"
    ? compileGrowthWorldFragment({
        summary: "Growth world",
        world: { localId: "world", title: "World" },
        entities: [
          { localId: "harbor", kind: "location", title: "Harbor" },
          { localId: "guild", kind: "faction", title: "Guild" },
        ],
        documents: [{
          localId: "setting", ownerRef: "world", kind: "setting", title: "Setting",
          content: "A sourced setting document for the coordinator fixture. ".repeat(5),
        }],
        assertions: [1, 2, 3].map((index) => ({
          localId: `fact_${index}`, scopeRef: "world", subject: "World", predicate: `rule_${index}`,
          object: { value: index }, sourceDocumentRefs: ["setting"],
        })),
        relations: [],
      }, { cycleId: command.growthBinding.cycleId, worldRootResourceId: scopeId }).items
    : focus === "oc" ? [{
        id: `resource-${id}`, dependsOn: [], kind: "resource.put" as const,
        payload: {
          resourceId: `${focus}-${id}`, create: true,
          type: focus, objectKind: focus,
          title: `${focus} primary fixture`, parentId: scopeId, state: "active" as const, sortOrder: 1,
        },
      }, {
        id: `resource-0-secondary-${id}`, dependsOn: [], kind: "resource.put" as const,
        payload: {
          resourceId: `${focus}-secondary-${id}`, create: true,
          type: focus, objectKind: focus,
          title: `${focus} secondary fixture`, parentId: scopeId, state: "active" as const, sortOrder: 0,
        },
      }] : [{
        id: `resource-${id}`, dependsOn: [], kind: "resource.put" as const,
        payload: {
          resourceId: `${focus}-${id}`, create: true,
          type: focus, objectKind: focus,
          title: `${focus} fixture`, parentId: scopeId, state: "active" as const, sortOrder: 0,
        },
      }];
  worker.receive({ type: "tool.request", runId: id, requestId: randomUUID(), tool: "propose_change_set", args: {
    summary: "Growth change", items,
  } });
  await vi.waitFor(() => expect(worker.sent).toHaveLength(4));
}

function runId(worker: FakeWorker): string {
  const command = worker.sent[0] as { runId?: string } | undefined;
  if (!command?.runId) throw new Error("Worker run was not started.");
  return command.runId;
}

function beginStewardInvocation(workspace: WorkspaceDatabase, runId: string): void {
  const hash = "a".repeat(64);
  new AgentAuditRepository(workspace).beginInvocation({
    invocationId: `${runId}:steward`, runId, parentInvocationId: null, role: "steward",
    promptId: "novax.steward", promptVersion: "1.12.0", promptSha256: hash,
    agentProfileId: "novax.steward", agentProfileVersion: "1.12.0", agentProfileSha256: hash,
    providerId: "provider", requestedModelId: "model", providerConfigSha256: hash,
    toolPolicyId: "novax.steward.tools", toolPolicyVersion: "1.0.0", toolPolicySha256: hash,
    authorizedTools: ["retrieve_graph_evidence", "submit_growth_inquiry", "propose_change_set"], handoffContractId: null,
    handoffVersion: null, handoffPayloadSha256: null, inputSha256: hash,
  });
}

function requestCoordinatorRetrieval(worker: FakeWorker, runId: string, query: string): void {
  worker.receive({
    type: "tool.request", runId, requestId: randomUUID(), tool: "retrieve_graph_evidence",
    args: {
      variant: "growth_v1", query, aliases: [], seedResourceIds: [], maxHops: 0, cpuBudgetMs: 1000,
      expansionBudget: 20, resultBudget: 20, tokenBudget: 1000, contentBudgetChars: 4000,
      policyVersion: "graph-retrieval-v1",
    },
  });
}

async function preparePlannedRepairRecoveryBoundary(
  setup: ReturnType<typeof createSetup>,
  coordinator: GrowthCoordinator,
  workers: FakeWorker[],
  suffix: string,
) {
  const started = coordinator.start(growthRequest(setup));
  await completeCycle(setup.workspace, workers[0]!);
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  await completeCycle(setup.workspace, workers[1]!);
  await vi.waitFor(() => expect(workers).toHaveLength(3));
  await completeCycle(setup.workspace, workers[2]!);
  await vi.waitFor(() => expect(workers).toHaveLength(4));
  const evaluation = await sealCoordinatorClosureEvaluation(
    setup.workspace, workers[3]!, "repairs_required", suffix,
  );
  const repository = new GrowthRepository(setup.workspace);
  const evaluationCycle = repository.listCycles(started.goal.id).at(-1)!;
  const repairCycle = repository.beginCycle({
    id: `repair-recovery-${suffix}`, goalId: started.goal.id,
    idempotencyKey: `repair-recovery-${suffix}-key`,
    inputCheckpointId: evaluationCycle.inputCheckpointId, ruleRevision: evaluationCycle.ruleRevision,
    intent: {
      kind: "repair", profileId: evaluation.review.profileId, revision: evaluation.review.revision,
      originalReviewId: evaluation.review.id, selectedFindingId: evaluation.finding!.id,
      selectedFindingFingerprint: evaluation.finding!.fingerprint,
    },
  });
  return { goalId: started.goal.id, repository, evaluation, repairCycle };
}

async function completeCoordinatorRepair(
  workspace: WorkspaceDatabase,
  worker: FakeWorker,
  worldRootId: string,
  title: string,
): Promise<void> {
  if (worker.sent.length === 0) worker.spawn();
  await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
  const id = runId(worker);
  const binding = (worker.sent[0] as {
    growthBinding: { kind: string; closureRepair: { targetEvidenceIds: string[] } };
  }).growthBinding;
  expect(binding).toMatchObject({ kind: "repair", closureRepair: { targetEvidenceIds: [expect.any(String)] } });
  worker.receive({ type: "run.started", runId: id });
  beginStewardInvocation(workspace, id);
  requestCoordinatorRetrieval(worker, id, "repeat repair target");
  await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({
    ok: true, result: { evidence: [expect.objectContaining({ evidenceId: binding.closureRepair.targetEvidenceIds[0] })] },
  }));
  const worldResourceId = new ResourceRepository(workspace).listCurrent()
    .find((resource) => resource.objectKind === "world")!.id;
  worker.receive({
    type: "tool.request", runId: id, requestId: randomUUID(), tool: "propose_change_set",
    args: {
      summary: "Apply the selected repair only.",
      items: [{
        id: "repair-reviewed-world", dependsOn: [], kind: "resource.put",
        payload: {
          resourceId: worldResourceId, create: false, type: "world", objectKind: "world",
          title, parentId: worldRootId, state: "active", sortOrder: 0,
        },
      }],
    },
  });
  await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({
    ok: true, result: { status: "committed", changeSetId: expect.any(String) },
  }));
  worker.receive({
    type: "run.completed", runId: id, outcome: "completed",
    message: "repair committed", changeSetState: "committed", artifacts: [],
  });
}

async function sealCoordinatorClosureEvaluation(
  workspace: WorkspaceDatabase,
  worker: FakeWorker,
  decision: "accepted" | "repairs_required",
  suffix: string,
  findingFingerprint = "f".repeat(64),
) {
  if (worker.sent.length === 0) worker.spawn();
  await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
  const id = runId(worker);
  const command = worker.sent[0] as {
    growthBinding: {
      cycleId: string;
      kind: string;
      closureProfile: { profileId: string; revision: number };
    };
  };
  expect(command.growthBinding.kind).toBe("closure_evaluation");
  worker.receive({ type: "run.started", runId: id });
  beginStewardInvocation(workspace, id);
  requestCoordinatorRetrieval(worker, id, `closure ${suffix}`);
  await vi.waitFor(() => expect(worker.sent).toHaveLength(2));

  const repository = new GrowthRepository(workspace);
  const cycle = repository.getCycle(command.growthBinding.cycleId)!;
  const receipt = repository.getReceipt(cycle.receiptId!)!;
  expect(receipt.links.length).toBeGreaterThan(0);
  const worldResourceIds = new Set(new ResourceRepository(workspace).listAtCheckpoint(cycle.inputCheckpointId)
    .filter((resource) => resource.objectKind === "world")
    .map((resource) => resource.id));
  const repairTarget = receipt.links.find((link) => (
    link.targetKind === "resource" && worldResourceIds.has(link.targetId)
  ));
  if (!repairTarget) throw new Error("Expected a pinned formal world repair target.");
  const targetEvidenceId = repairTarget.targetVersionId;
  const profile = repository.getClosureProfile(command.growthBinding.closureProfile.profileId)!;
  const revision = repository.getClosureRevision(profile.id, command.growthBinding.closureProfile.revision)!;
  const stewardOutputHash = createHash("sha256").update(`steward-${suffix}`, "utf8").digest("hex");
  const checkerOutputHash = createHash("sha256").update(`checker-${suffix}`, "utf8").digest("hex");
  terminalizeCoordinatorInvocation(workspace, id, `${id}:steward`, stewardOutputHash);
  const checkerInvocationId = beginCoordinatorCheckerInvocation(workspace, id, checkerOutputHash);
  const facetResults = revision.facets.map((facet) => ({
    facetId: facet.id, state: "satisfied" as const, coverage: "complete" as const,
    safeSummary: `${facet.id} is present but still receives independent consistency review.`,
    evidence: [{ receiptId: receipt.id, rank: 1 }],
  }));
  const finding = decision === "repairs_required" ? {
    id: `finding-${suffix}`, fingerprint: findingFingerprint, severity: "major" as const,
    category: "world_consistency" as const,
    targetEvidence: [{ receiptId: receipt.id, rank: repairTarget.rank }],
    safeSummary: "The reviewed world identity is too generic.",
    repairObjective: "Give the existing world a distinctive title without changing unrelated nodes.",
  } : null;
  const steward = repository.appendClosureStewardSubmission({
    id: `steward-${suffix}`, profileId: profile.id, revision: revision.revision, role: "steward",
    decision: "ready_for_checker", cycleId: cycle.id, checkpointId: cycle.inputCheckpointId,
    ruleRevision: cycle.ruleRevision, receiptId: receipt.id, agentInvocationId: `${id}:steward`,
    outputSha256: stewardOutputHash, idempotencyKey: `steward-${suffix}-key`, facetResults,
  });
  const checker = repository.appendClosureCheckerSubmission({
    id: `checker-${suffix}`, profileId: profile.id, revision: revision.revision, role: "checker",
    decision, cycleId: cycle.id, checkpointId: cycle.inputCheckpointId,
    ruleRevision: cycle.ruleRevision, receiptId: receipt.id, agentInvocationId: checkerInvocationId,
    outputSha256: checkerOutputHash, idempotencyKey: `checker-${suffix}-key`,
    adverseFindings: finding ? [finding] : [],
  });
  const review = repository.sealClosureReviewV4({
    id: `review-${suffix}`, profileId: profile.id, revision: revision.revision,
    stewardAssessmentId: steward.id, checkerAssessmentId: checker.id,
    idempotencyKey: `review-${suffix}-key`, facetResults, adverseFindings: finding ? [finding] : [],
  });
  const outcome = repository.sealClosureEvaluationOutcome({
    id: `outcome-${suffix}`, cycleId: cycle.id, profileId: profile.id, revision: revision.revision,
    receiptId: receipt.id, stewardAssessmentId: steward.id, checkerAssessmentId: checker.id,
    reviewId: review.id, decision, idempotencyKey: `outcome-${suffix}-key`,
  });
  return { outcome, review, finding, targetEvidenceId };
}

function beginCoordinatorCheckerInvocation(workspace: WorkspaceDatabase, runId: string, outputSha256: string): string {
  const hash = "b".repeat(64);
  const invocationId = `${runId}:checker`;
  new AgentAuditRepository(workspace).beginInvocation({
    invocationId, runId, parentInvocationId: `${runId}:steward`, role: "checker",
    promptId: "novax.checker", promptVersion: "1.9.0", promptSha256: hash,
    agentProfileId: "novax.checker", agentProfileVersion: "1.9.0", agentProfileSha256: hash,
    providerId: "provider", requestedModelId: "model", providerConfigSha256: hash,
    toolPolicyId: "novax.checker.tools", toolPolicyVersion: "1.0.0", toolPolicySha256: hash,
    authorizedTools: [], handoffContractId: "novax.closure-review", handoffVersion: "1.0.0",
    handoffPayloadSha256: hash, inputSha256: hash,
  });
  terminalizeCoordinatorInvocation(workspace, runId, invocationId, outputSha256);
  return invocationId;
}

function terminalizeCoordinatorInvocation(
  workspace: WorkspaceDatabase,
  runId: string,
  invocationId: string,
  outputSha256: string,
): void {
  new AgentAuditRepository(workspace).appendInvocationTerminal({
    runId, invocationId, eventType: "completed", errorCode: null, actualProviderId: "provider",
    actualModelId: "model", responseIdSha256: createHash("sha256").update(`${invocationId}:response`, "utf8").digest("hex"),
    stopReason: "stop", inputTokens: 10, outputTokens: 10, totalTokens: 20,
    contextPolicyVersion: "test", maxChargedInputBytes: 100, configuredContextWindow: 1000,
    safetyReserve: 100, outputReserve: 100, correctionAttempts: 0, structuredSubmissionCount: 1,
    outputSha256,
  });
}
