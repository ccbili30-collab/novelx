import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  it("persists guidance during C1 and applies its pinned rule only when C2 starts", async () => {
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
      nextCyclePhase: "story",
      status: "persisted_pending_boundary",
    });
    workers[0]!.spawn();
    await vi.waitFor(() => expect(workers[0]!.sent).toHaveLength(1));
    expect((workers[0]!.sent[0] as { userInput: string }).userInput).toContain("Keep sources.");
    expect((workers[0]!.sent[0] as { userInput: string }).userInput).not.toContain("Use the revised rule.");

    await completeCycle(setup.workspace, workers[0]!);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    workers[1]!.spawn();
    await vi.waitFor(() => expect(workers[1]!.sent).toHaveLength(1));
    expect((workers[1]!.sent[0] as { userInput: string }).userInput).toContain("Use the revised rule.");
    await completeCycle(setup.workspace, workers[1]!);
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    expect(new GrowthRepository(setup.workspace).listCycles(started.goal.id)[1]).toMatchObject({
      ruleRevision: 2,
      receiptId: expect.any(String),
      status: "committed",
    });
    workers[2]!.spawn();
    supervisor.cancel(runId(workers[2]!));
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).listCycles(started.goal.id)[2]!.status).toBe("cancelled"));
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

    workers[0]!.spawn();
    supervisor.cancel(runId(workers[0]!));
    await vi.waitFor(() => expect(new GrowthRepository(setup.workspace).listCycles(started.goal.id)[0]!.status).toBe("cancelled"));
  });

  it("fails closed while C3 is running and after three completed Cycles because Cycle 4 is outside the bounded strategy", async () => {
    const setup = createSetup();
    const workers: FakeWorker[] = [];
    const supervisor = createSupervisor(setup, workers);
    const coordinator = new GrowthCoordinator(setup.session, setup.application, supervisor);
    const started = coordinator.start(growthRequest(setup));
    await completeCycle(setup.workspace, workers[0]!);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await completeCycle(setup.workspace, workers[1]!);
    await vi.waitFor(() => expect(workers).toHaveLength(3));

    expect(() => coordinator.guide({
      goalId: started.goal.id, expectedRevision: 1, ruleText: "Do not create Cycle 4.",
      requestId: "44444444-4444-4444-8444-444444444444",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_GUIDANCE_NO_NEXT_CYCLE" }));
    expect(new GrowthRepository(setup.workspace).getGoal(started.goal.id)?.currentRuleRevision).toBe(1);
    await completeCycle(setup.workspace, workers[2]!);
    await vi.waitFor(() => expect(coordinator.get({ projectId: setup.projectId, sessionId: setup.sessionId, goalId: started.goal.id }).coordinatorStatus).toBe("completed"));
    expect(() => coordinator.guide({
      goalId: started.goal.id, expectedRevision: 1, ruleText: "Still no Cycle 4.",
      requestId: "99999999-9999-4999-8999-999999999999",
    })).toThrowError(expect.objectContaining({ code: "GROWTH_GUIDANCE_NO_NEXT_CYCLE" }));
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

  it("runs three persisted, sequential Cycle/Run pairs from one idempotent start", async () => {
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

    await vi.waitFor(() => expect(coordinator.get({ projectId: setup.projectId, sessionId: setup.sessionId, goalId: initial.goal.id }).cycles).toHaveLength(3));
    const snapshot = coordinator.get({ projectId: setup.projectId, sessionId: setup.sessionId, goalId: initial.goal.id });
    expect(snapshot.goal.status).toBe("active");
    expect(snapshot.coordinatorStatus).toBe("completed");
    expect(snapshot.cycles.map((cycle) => cycle.status)).toEqual(["committed", "committed", "committed"]);
    expect(snapshot.cycles.map((cycle) => cycle.runId)).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(new Set(snapshot.cycles.map((cycle) => cycle.runId)).size).toBe(3);
    const repository = new GrowthRepository(setup.workspace);
    const cycles = repository.listCycles(initial.goal.id);
    expect(cycles[1]!.inputCheckpointId).toBe(cycles[0]!.outputCheckpointId);
    expect(cycles[2]!.inputCheckpointId).toBe(cycles[1]!.outputCheckpointId);
    expect(cycles.every((cycle) => cycle.receiptId && cycle.changeSetId && cycle.outputCheckpointId)).toBe(true);
    expect(snapshot.events.map((event) => event.sequence)).toEqual([...snapshot.events.keys()].map((index) => index + 1));
    expect(snapshot.events.find((event) => event.phase === "receipt_recorded")).toHaveProperty("targetVersionId");
    expect(snapshot.events.find((event) => event.phase === "receipt_recorded")).toHaveProperty("contentRef", null);
    expect(live).toEqual(expect.arrayContaining(snapshot.events.map((event) => expect.objectContaining({ event }))));
    expect(agentEvents.map((event) => event.type)).toEqual(expect.arrayContaining(["run.started", "run.activity", "run.completed"]));
    expect(agentEvents.every((event) => event.sessionId === setup.sessionId)).toBe(true);
    expect(coordinator.start(request).cycles).toHaveLength(3);
    expect(workers).toHaveLength(3);
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
    const snapshot = coordinator.get({ projectId: setup.projectId, sessionId: setup.sessionId, goalId: goalIdForRequest(request) });
    expect(snapshot.coordinatorStatus).toBe("completed");
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(new GrowthRepository(setup.workspace).listEvents(snapshot.goal.id)).toHaveLength(snapshot.events.length);
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
    seed: { kind: "text" as const, text: "A user seed." }, initialRuleText: "Keep sources.", strategy: "grow_world_story_oc_v1" as const,
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
  if (worker.sent.length === 0) worker.spawn();
  await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
  const id = runId(worker);
  const command = worker.sent[0] as { growthBinding: { cycleId: string; phase: "world" | "story" | "oc" } };
  worker.receive({ type: "run.started", runId: id });
  beginStewardInvocation(workspace, id);
  worker.receive({ type: "tool.request", runId: id, requestId: randomUUID(), tool: "retrieve_graph_evidence", args: {
    variant: "growth_v1", query: "growth", aliases: [], seedResourceIds: [], maxHops: 0, cpuBudgetMs: 1000,
    expansionBudget: 20, resultBudget: 10, tokenBudget: 1000, contentBudgetChars: 4000, policyVersion: "graph-retrieval-v1",
  } });
  await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
  const roots = new ResourceRepository(workspace).listCurrent().filter((resource) => resource.objectKind === "domain_root");
  const scopeId = roots.find((resource) => resource.type === command.growthBinding.phase)!.id;
  const items = command.growthBinding.phase === "world"
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
    : [{
        id: `resource-${id}`, dependsOn: [], kind: "resource.put" as const,
        payload: {
          resourceId: `${command.growthBinding.phase}-${id}`, create: true,
          type: command.growthBinding.phase, objectKind: command.growthBinding.phase,
          title: `${command.growthBinding.phase} fixture`, parentId: scopeId, state: "active" as const, sortOrder: 0,
        },
      }];
  worker.receive({ type: "tool.request", runId: id, requestId: randomUUID(), tool: "propose_change_set", args: {
    summary: "Growth change", items,
  } });
  await vi.waitFor(() => expect(worker.sent).toHaveLength(3));
  worker.receive({ type: "run.completed", runId: id, outcome: "completed", message: "done", changeSetState: "committed", artifacts: [] });
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
    authorizedTools: ["retrieve_graph_evidence", "propose_change_set"], handoffContractId: null,
    handoffVersion: null, handoffPayloadSha256: null, inputSha256: hash,
  });
}
