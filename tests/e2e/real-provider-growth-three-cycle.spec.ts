import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { AssertionRepository, type SourcedAssertionRecord } from "../../src/domain/graph/assertionRepository";
import { CreativeRelationRepository } from "../../src/domain/workspace/creativeRelationRepository";
import { DocumentRepository, type DocumentVersionRecord } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository, type ResourceRecord } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { PROVIDER_STORE_FILE_NAME } from "../../src/main/providerSecureStore";
import type { AgentRunEvent, DesktopApi, GrowthLiveEvent } from "../../src/shared/ipcContract";
import { closeTestElectronApp } from "./support/electronCleanup";
import { watchGrowthTerminal } from "./support/growthWatcher";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const configuredProviderStorePath = process.env.NOVAX_REAL_E2E_PROVIDER_STORE?.trim()
  || (process.env.APPDATA ? path.join(process.env.APPDATA, "novelx-desktop", PROVIDER_STORE_FILE_NAME) : "");

test.skip(!configuredProviderStorePath || !fs.existsSync(configuredProviderStorePath), "A machine-local encrypted gpt-5.4 Provider store is required.");

test("runs one real gpt-5.4 Growth goal through three committed cycles and a later research retrieval", async () => {
  test.setTimeout(990_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-real-growth-three-cycle-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  const evidenceDirectory = path.join(process.cwd(), "notes", "evidence", "novax-desktop-growth");
  let app: ElectronApplication | null = null;
  let providerStarted = false;
  let evidence: SafeEvidence = {
    schemaVersion: 1,
    provider: { providerId: null, modelId: null },
    providerStarted: false,
    outcome: "not_started",
    cycles: [],
    research: null,
    counts: null,
    leakScan: "not_run",
  };

  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.copyFileSync(configuredProviderStorePath, path.join(userDataPath, PROVIDER_STORE_FILE_NAME));
  const localState = path.join(path.dirname(configuredProviderStorePath), "Local State");
  if (!fs.existsSync(localState)) throw new Error("REAL_PROVIDER_LOCAL_STATE_MISSING");
  fs.copyFileSync(localState, path.join(userDataPath, "Local State"));
  initializeProject(userDataPath, workspacePath);

  try {
    app = await launch(userDataPath, workspacePath);
    const page = await app.firstWindow();
    const provider = await providerStatus(page);
    evidence.provider = provider;
    if (provider.modelId !== "gpt-5.4") throw new Error("REAL_PROVIDER_MODEL_ID_MISMATCH");

    providerStarted = true;
    evidence.providerStarted = true;
    const first = await startGrowthAndWatch(page, randomUUID(), 900_000, 300_000);
    evidence.goalId = first.goalId;
    evidence.preTermination = first.preTermination;
    if (first.termination) {
      evidence.termination = await cancelBoundRunAndObserve(page, first);
      await closeTestElectronApp(app);
      app = null;
      evidence.postTermination = captureSqliteEvidence(workspacePath, first.goalId);
      assertNoPlaintextCredentialSurface(workspacePath, userDataPath, first.growthEvents, first.agentEvents);
      evidence.leakScan = "passed";
      evidence.outcome = "failed_after_provider_start";
      evidence.failureCode = first.termination;
      writeEvidence(evidenceDirectory, evidence);
      throw new Error(first.termination);
    }
    evidence.preTermination = safePreTermination(first.snapshot, first.growthEvents, first.agentEvents, first.elapsedMs);
    evidence.cycles = first.snapshot.cycles.map((cycle) => ({
      id: cycle.id,
      sequence: cycle.sequence,
      runId: cycle.runId,
      status: cycle.status,
    }));
    if (first.snapshot.coordinatorStatus !== "completed") throw new Error("GROWTH_COORDINATOR_TERMINAL_NOT_COMPLETED");
    assertPublicGrowth(first.snapshot, first.growthEvents, first.agentEvents);

    await closeTestElectronApp(app);
    app = null;
    const persisted = inspectCommittedGrowth(workspacePath, first.goalId);
    evidence.cycles = persisted.cycles;
    evidence.counts = persisted.counts;

    app = await launch(userDataPath, workspacePath);
    const researchPage = await app.firstWindow();
    const research = await runResearchOnly(researchPage, persisted);
    evidence.research = research.safe;
    await closeTestElectronApp(app);
    app = null;

    inspectResearchAudit(workspacePath, persisted, research.runId);
    assertNoPlaintextCredentialSurface(workspacePath, userDataPath, first.growthEvents, first.agentEvents);
    evidence.leakScan = "passed";
    evidence.outcome = "completed";
  } catch (error) {
    evidence.outcome = providerStarted ? "failed_after_provider_start" : "blocked_before_provider_start";
    evidence.failureCode = safeFailureCode(error);
    if (app) {
      await closeTestElectronApp(app);
      app = null;
    }
    if (providerStarted) {
      evidence.postTermination ??= captureSqliteEvidence(workspacePath, evidence.goalId);
      assertNoPlaintextCredentialSurface(workspacePath, userDataPath, [], []);
      evidence.leakScan = "passed";
      writeEvidence(evidenceDirectory, evidence);
    }
    throw error;
  } finally {
    if (app) await closeTestElectronApp(app);
    if (evidence.outcome === "completed") writeEvidence(evidenceDirectory, evidence);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface SafeEvidence {
  schemaVersion: 1;
  provider: { providerId: string | null; modelId: string | null };
  providerStarted: boolean;
  outcome: "not_started" | "blocked_before_provider_start" | "failed_after_provider_start" | "completed";
  failureCode?: string;
  goalId?: string;
  cycles: Array<{ id: string; sequence: number; runId: string | null; status: string }>;
  research: { runId: string; retrieveSucceeded: boolean; noMutationTools: boolean } | null;
  counts: { resources: number; documents: number; assertions: number; relations: number } | null;
  leakScan: "not_run" | "passed";
  preTermination?: SafePreTermination;
  termination?: SafeTermination;
  postTermination?: SafeSqliteEvidence;
}

interface SafePreTermination {
  elapsedMs: number;
  cycles: Array<{ id: string; sequence: number; status: string; runId: string | null }>;
  growthEvents: Array<{ sequence: number; cycleId: string; runId: string | null; phase: string; durableState: string }>;
  agentEvents: Array<{ type: string; runId: string; activityLabel?: string; phase?: string; code?: string; outcome?: string; changeSetState?: string }>;
}

interface SafeTermination {
  attemptedRunId: string | null;
  cancelRequested: boolean;
  terminalObserved: boolean;
  snapshotStatus: string | null;
}

interface SafeSqliteEvidence {
  cycles: Array<{
    id: string;
    sequence: number;
    status: string;
    failureCode: string | null;
    runId: string | null;
    receiptId: string | null;
    changeSetId: string | null;
    inputCheckpointId: string;
    outputCheckpointId: string | null;
    audit: null | {
      terminal: Array<{ entityType: string; eventType: string; errorCode: string | null }>;
      tools: Array<{ name: string; outcomes: string[] }>;
      requestedProviderId: string | null;
      requestedModelId: string | null;
      actualProviderIds: string[];
      actualModelIds: string[];
    };
  }>;
  counts: { resources: number; documents: number; assertions: number; relations: number };
  changeSets: {
    total: number;
    byStatus: Array<{ status: string; count: number }>;
    outputCount: number;
    checkpointCount: number;
    checkpointDeltaFromInitial: number;
  };
}

function initializeProject(userDataPath: string, workspacePath: string): void {
  openWorkspace(workspacePath).close();
  const registry = new ApplicationRegistryRepository(path.join(userDataPath, "application.db"));
  try {
    const project = registry.registerProject(workspacePath, "ready");
    registry.ensureDefaultSession(project.id);
    registry.selectProject(project.id);
  } finally {
    registry.close();
  }
}

function launch(userDataPath: string, workspacePath: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: ["."],
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      NOVAX_DESKTOP_E2E_USER_DATA: userDataPath,
      NOVAX_DESKTOP_E2E_WORKSPACE: workspacePath,
    },
  });
}

async function providerStatus(page: Page): Promise<{ providerId: string | null; modelId: string | null }> {
  return page.evaluate(async () => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const status = await desktop.provider.getStatus();
    if (!status.ok || !status.state.hasCredential || !status.state.config) throw new Error("REAL_PROVIDER_CONFIG_UNAVAILABLE");
    return { providerId: status.state.config.providerId, modelId: status.state.config.modelId };
  });
}

async function startGrowthAndWatch(
  page: Page,
  requestId: string,
  overallTimeoutMs: number,
  cycleTimeoutMs: number,
): Promise<{
  projectId: string;
  sessionId: string;
  goalId: string;
  snapshot: Awaited<ReturnType<DesktopApi["growth"]["get"]>>;
  growthEvents: GrowthLiveEvent[];
  agentEvents: AgentRunEvent[];
  elapsedMs: number;
  preTermination?: SafePreTermination;
  termination?: "GROWTH_CYCLE_WATCHDOG_TIMEOUT" | "GROWTH_OVERALL_TIMEOUT";
}> {
  const bufferKey = `__novaxGrowthWatch_${randomUUID()}`;
  const started = await page.evaluate(async ({ receivedRequestId, receivedBufferKey }) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const project = (await desktop.project.list()).projects[0];
    if (!project) throw new Error("GROWTH_PROJECT_MISSING");
    const sessions = await desktop.session.list({ projectId: project.id });
    const session = sessions.sessions[0] ?? await desktop.session.create({ projectId: project.id, title: "真实 Growth 验收" });
    const growthEvents: GrowthLiveEvent[] = [];
    const agentEvents: AgentRunEvent[] = [];
    const releaseGrowth = desktop.growth.subscribe((event) => { if (event.sessionId === session.id) growthEvents.push(event); });
    const releaseAgent = desktop.agent.subscribe((event) => { if (event.sessionId === session.id) agentEvents.push(event); });
    const state = globalThis as typeof globalThis & { [key: string]: unknown };
    state[receivedBufferKey] = { growthEvents, agentEvents, releaseGrowth, releaseAgent };
    try {
      const response = await desktop.growth.start({
        requestId: receivedRequestId,
        projectId: project.id,
        sessionId: session.id,
        seed: { kind: "text", text: "一座港湾会在潮汐倒转时显出被遗忘的石阶，城民据此安排誓约、航行与继承。" },
        initialRuleText: "所有正式事实必须建立在稳定来源上；不确定内容保持候选，不得把推测写成确认。",
        strategy: "grow_world_story_oc_v1",
      });
      return { projectId: project.id, sessionId: session.id, goalId: response.goal.id };
    } catch {
      releaseGrowth();
      releaseAgent();
      delete state[receivedBufferKey];
      throw new Error("GROWTH_START_FAILED");
    }
  }, { receivedRequestId: requestId, receivedBufferKey: bufferKey });

  const watched = await watchGrowthTerminal({
    overallTimeoutMs,
    cycleTimeoutMs,
    pollMs: 500,
    getSnapshot: () => page.evaluate(async ({ projectId, sessionId, goalId }) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.growth.get({ projectId, sessionId, goalId });
    }, started),
    readEvents: () => page.evaluate((receivedBufferKey) => {
      const buffer = (globalThis as typeof globalThis & { [key: string]: unknown })[receivedBufferKey] as { growthEvents: GrowthLiveEvent[]; agentEvents: AgentRunEvent[] } | undefined;
      if (!buffer) throw new Error("GROWTH_EVENT_BUFFER_MISSING");
      return { growthEvents: [...buffer.growthEvents], agentEvents: [...buffer.agentEvents] };
    }, bufferKey),
    release: () => page.evaluate((receivedBufferKey) => {
      const state = globalThis as typeof globalThis & { [key: string]: unknown };
      const buffer = state[receivedBufferKey] as { releaseGrowth(): void; releaseAgent(): void } | undefined;
      buffer?.releaseGrowth();
      buffer?.releaseAgent();
      delete state[receivedBufferKey];
    }, bufferKey),
  });
  const { growthEvents, agentEvents } = watched.events;
  return {
    ...started,
    snapshot: watched.snapshot,
    growthEvents,
    agentEvents,
    elapsedMs: watched.elapsedMs,
    ...(watched.termination ? { termination: watched.termination, preTermination: safePreTermination(watched.snapshot, growthEvents, agentEvents, watched.elapsedMs) } : {}),
  };
}

async function startGrowthAndWatchLegacy(
  page: Page,
  requestId: string,
  overallTimeoutMs: number,
  cycleTimeoutMs: number,
): Promise<{
  projectId: string;
  sessionId: string;
  goalId: string;
  snapshot: Awaited<ReturnType<DesktopApi["growth"]["get"]>>;
  growthEvents: GrowthLiveEvent[];
  agentEvents: AgentRunEvent[];
  elapsedMs: number;
  preTermination?: SafePreTermination;
  termination?: "GROWTH_CYCLE_WATCHDOG_TIMEOUT" | "GROWTH_OVERALL_TIMEOUT";
}> {
  return page.evaluate(async ({ requestId: receivedRequestId, overallTimeout: receivedOverallTimeout, cycleTimeout: receivedCycleTimeout }) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const project = (await desktop.project.list()).projects[0];
    if (!project) throw new Error("GROWTH_PROJECT_MISSING");
    const sessions = await desktop.session.list({ projectId: project.id });
    const session = sessions.sessions[0] ?? await desktop.session.create({ projectId: project.id, title: "真实 Growth 验收" });
    return new Promise<{
      projectId: string;
      sessionId: string;
      goalId: string;
      snapshot: Awaited<ReturnType<DesktopApi["growth"]["get"]>>;
      growthEvents: GrowthLiveEvent[];
      agentEvents: AgentRunEvent[];
      elapsedMs: number;
      preTermination?: SafePreTermination;
      termination?: "GROWTH_CYCLE_WATCHDOG_TIMEOUT" | "GROWTH_OVERALL_TIMEOUT";
    }>((resolve, reject) => {
      const growthEvents: GrowthLiveEvent[] = [];
      const agentEvents: AgentRunEvent[] = [];
      const startedAt = Date.now();
      let latestSnapshot: Awaited<ReturnType<DesktopApi["growth"]["get"]>> | null = null;
      let watchedCycleId: string | null = null;
      let watchedCycleAt: number | null = null;
      const releaseGrowth = desktop.growth.subscribe((event) => {
        if (event.sessionId === session.id) growthEvents.push(event);
      });
      const releaseAgent = desktop.agent.subscribe((event) => {
        if (event.sessionId === session.id) agentEvents.push(event);
      });
      let goalId: string | null = null;
      const finish = (result?: Awaited<ReturnType<DesktopApi["growth"]["get"]>>, error?: Error, termination?: "GROWTH_CYCLE_WATCHDOG_TIMEOUT" | "GROWTH_OVERALL_TIMEOUT") => {
        globalThis.clearInterval(poll);
        globalThis.clearInterval(watchdog);
        releaseGrowth();
        releaseAgent();
        if (error) reject(error); else if (result && goalId) resolve({
          projectId: project.id, sessionId: session.id, goalId, snapshot: result, growthEvents, agentEvents,
          elapsedMs: Date.now() - startedAt,
          ...(termination ? { termination, preTermination: safePreTermination(result, growthEvents, agentEvents, Date.now() - startedAt) } : {}),
        });
      };
      const poll = globalThis.setInterval(() => {
        if (!goalId) return;
        void desktop.growth.get({ projectId: project.id, sessionId: session.id, goalId }).then((snapshot) => {
          latestSnapshot = snapshot;
          const running = snapshot.cycles.find((cycle) => cycle.status === "running" && cycle.runId !== null);
          if (running?.id !== watchedCycleId) {
            watchedCycleId = running?.id ?? null;
            watchedCycleAt = running ? Date.now() : null;
          }
          if (snapshot.coordinatorStatus !== "running") finish(snapshot);
        }).catch(() => finish(undefined, new Error("GROWTH_GET_FAILED")));
      }, 750);
      const watchdog = globalThis.setInterval(() => {
        if (!goalId) return;
        const now = Date.now();
        const timeout = now - startedAt >= receivedOverallTimeout
          ? "GROWTH_OVERALL_TIMEOUT"
          : watchedCycleAt !== null && now - watchedCycleAt >= receivedCycleTimeout
            ? "GROWTH_CYCLE_WATCHDOG_TIMEOUT"
            : null;
        if (!timeout) return;
        void desktop.growth.get({ projectId: project.id, sessionId: session.id, goalId }).then((snapshot) => {
          latestSnapshot = snapshot;
          finish(snapshot, undefined, timeout);
        }).catch(() => {
          if (latestSnapshot) finish(latestSnapshot, undefined, timeout);
          else finish(undefined, new Error("GROWTH_GET_FAILED"));
        });
      }, 500);
      void desktop.growth.start({
        requestId: receivedRequestId,
        projectId: project.id,
        sessionId: session.id,
        seed: { kind: "text", text: "一座港湾会在潮汐倒转时显出被遗忘的石阶，城民据此安排誓约、航行与继承。" },
        initialRuleText: "所有正式事实必须建立在稳定来源上；不确定内容保持候选，不得把推测写成确认。",
        strategy: "grow_world_story_oc_v1",
      }).then((started) => { goalId = started.goal.id; }).catch(() => finish(undefined, new Error("GROWTH_START_FAILED")));
    });
  }, { requestId, overallTimeout: overallTimeoutMs, cycleTimeout: cycleTimeoutMs });
}

function safePreTermination(
  snapshot: Awaited<ReturnType<DesktopApi["growth"]["get"]>>,
  growthEvents: GrowthLiveEvent[],
  agentEvents: AgentRunEvent[],
  elapsedMs: number,
): SafePreTermination {
  return {
    elapsedMs,
    cycles: snapshot.cycles.map((cycle) => ({ id: cycle.id, sequence: cycle.sequence, status: cycle.status, runId: cycle.runId })),
    growthEvents: growthEvents.map(({ event }) => ({
      sequence: event.sequence, cycleId: event.cycleId, runId: event.runId, phase: event.phase, durableState: event.durableState,
    })),
    agentEvents: agentEvents.map((event) => {
      if (event.type === "run.activity") return { type: event.type, runId: event.runId, activityLabel: event.label, phase: event.phase };
      if (event.type === "run.failed") return { type: event.type, runId: event.runId, code: event.code };
      if (event.type === "run.completed") return { type: event.type, runId: event.runId, outcome: event.outcome, changeSetState: event.changeSetState };
      return { type: event.type, runId: event.runId };
    }),
  };
}

async function cancelBoundRunAndObserve(
  page: Page,
  watched: Awaited<ReturnType<typeof startGrowthAndWatch>>,
): Promise<SafeTermination> {
  const runId = watched.snapshot.cycles.find((cycle) => cycle.status === "running" && cycle.runId !== null)?.runId ?? null;
  if (!runId) return { attemptedRunId: null, cancelRequested: false, terminalObserved: false, snapshotStatus: watched.snapshot.coordinatorStatus };
  return page.evaluate(async ({ projectId, sessionId, goalId, runId: receivedRunId }) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    let cancelRequested = false;
    try {
      await desktop.agent.cancel({ runId: receivedRunId });
      cancelRequested = true;
    } catch { /* Cancellation remains best-effort and does not expose a raw error. */ }
    const deadline = Date.now() + 45_000;
    let snapshotStatus: string | null = null;
    while (Date.now() < deadline) {
      try {
        const snapshot = await desktop.growth.get({ projectId, sessionId, goalId });
        snapshotStatus = snapshot.coordinatorStatus;
        if (snapshot.coordinatorStatus !== "running") return { attemptedRunId: receivedRunId, cancelRequested, terminalObserved: true, snapshotStatus };
      } catch { return { attemptedRunId: receivedRunId, cancelRequested, terminalObserved: false, snapshotStatus }; }
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 500));
    }
    return { attemptedRunId: receivedRunId, cancelRequested, terminalObserved: false, snapshotStatus };
  }, { projectId: watched.projectId, sessionId: watched.sessionId, goalId: watched.goalId, runId });
}

function assertPublicGrowth(
  snapshot: Awaited<ReturnType<DesktopApi["growth"]["get"]>>,
  growthEvents: GrowthLiveEvent[],
  agentEvents: AgentRunEvent[],
): void {
  expect(snapshot.coordinatorStatus).toBe("completed");
  expect(snapshot.cycles).toHaveLength(3);
  expect(snapshot.cycles.every((cycle) => cycle.status === "committed" && cycle.runId !== null)).toBe(true);
  expect(new Set(snapshot.cycles.map((cycle) => cycle.runId)).size).toBe(3);
  const persisted = snapshot.events;
  expect(persisted.length).toBeGreaterThanOrEqual(12);
  expect(persisted.every((event, index) => index === 0 || event.sequence > persisted[index - 1]!.sequence)).toBe(true);
  for (const cycle of snapshot.cycles) {
    const events = persisted.filter((event) => event.cycleId === cycle.id);
    const committedIndex = events.findIndex((event) => event.phase === "change_set_committed");
    expect(committedIndex).toBeGreaterThanOrEqual(0);
    expect(events.slice(0, committedIndex).some((event) => event.durableState === "committed")).toBe(false);
  }
  expect(growthEvents.every((event) => event.strategy === "grow_world_story_oc_v1")).toBe(true);
  expect(agentEvents.filter((event) => event.type === "run.completed").length).toBeGreaterThanOrEqual(3);
}

interface PersistedGrowth {
  goalId: string;
  cycles: Array<{ id: string; sequence: number; runId: string | null; status: string }>;
  world: ResourceRecord;
  story: ResourceRecord;
  ocs: ResourceRecord[];
  distinctive: SourcedAssertionRecord;
  counts: { resources: number; documents: number; assertions: number; relations: number };
  changeSetCount: number;
  checkpointCount: number;
}

function inspectCommittedGrowth(workspacePath: string, goalId: string): PersistedGrowth {
  const workspace = openWorkspace(workspacePath);
  try {
    const growth = new GrowthRepository(workspace);
    const cycles = growth.listCycles(goalId);
    expect(cycles).toHaveLength(3);
    expect(cycles.every((cycle) => cycle.status === "committed" && cycle.runId && cycle.receiptId && cycle.changeSetId && cycle.outputCheckpointId)).toBe(true);
    expect(new Set(cycles.map((cycle) => cycle.runId)).size).toBe(3);
    expect(new Set(cycles.map((cycle) => cycle.receiptId)).size).toBe(3);
    expect(new Set(cycles.map((cycle) => cycle.changeSetId)).size).toBe(3);
    expect(cycles[1]!.inputCheckpointId).toBe(cycles[0]!.outputCheckpointId);
    expect(cycles[2]!.inputCheckpointId).toBe(cycles[1]!.outputCheckpointId);
    const receipts = cycles.map((cycle) => growth.getReceipt(cycle.receiptId!));
    expect(receipts.every((receipt, index) => receipt?.runId === cycles[index]!.runId && receipt.links.length >= 0)).toBe(true);

    const resources = new ResourceRepository(workspace).listCurrent();
    const formal = resources.filter((resource) => resource.objectKind !== "domain_root");
    const world = formal.find((resource) => resource.objectKind === "world");
    const story = formal.find((resource) => resource.objectKind === "story");
    const ocs = formal.filter((resource) => resource.objectKind === "oc");
    expect(world).toBeDefined();
    expect(story).toBeDefined();
    expect(ocs.length).toBeGreaterThanOrEqual(2);
    expect(formal.filter((resource) => resource.objectKind === "location" || resource.objectKind === "faction").length).toBeGreaterThanOrEqual(2);

    const documents = new DocumentRepository(workspace);
    const worldDocument = requiredStable(documents, world!);
    const storyDocument = requiredStable(documents, story!);
    const ocDocuments = ocs.map((oc) => requiredStable(documents, oc));
    expect(worldDocument.content.trim().length).toBeGreaterThanOrEqual(200);
    expect(storyDocument.content.trim().length).toBeGreaterThanOrEqual(300);
    expect(ocDocuments.every((document) => document.content.trim().length >= 100)).toBe(true);
    expect([worldDocument, storyDocument, ...ocDocuments].reduce((total, document) => total + document.content.trim().length, 0)).toBeGreaterThanOrEqual(1_000);

    const assertions = new AssertionRepository(workspace).listCurrentInScopes([world!.id, story!.id, ...ocs.map((oc) => oc.id)]);
    const sourced = assertions.filter((assertion) => assertion.sources.length > 0);
    expect(sourced.length).toBeGreaterThanOrEqual(3);
    const distinctive = sourced.find((assertion) => assertion.subject.trim().length > 0);
    expect(distinctive).toBeDefined();
    const relations = new CreativeRelationRepository(workspace).listCurrent();
    expect(relations.some((relation) => relation.kind === "uses_world" && relation.sourceResourceId === story!.id && relation.targetResourceId === world!.id)).toBe(true);
    expect(relations.some((relation) => relation.kind === "uses_oc" && relation.sourceResourceId === story!.id && ocs.some((oc) => oc.id === relation.targetResourceId))).toBe(true);
    expect(relations.some((relation) => relation.kind === "related_to" && [world!.id, story!.id, ...ocs.map((oc) => oc.id)].includes(relation.sourceResourceId) && [world!.id, story!.id, ...ocs.map((oc) => oc.id)].includes(relation.targetResourceId))).toBe(true);

    const changeSets = new ChangeSetRepository(workspace);
    for (const cycle of cycles) {
      const changeSet = changeSets.get(cycle.changeSetId!);
      expect(changeSet?.status).toBe("committed");
      expect(changeSets.listOutputs(cycle.changeSetId!).length).toBeGreaterThan(0);
      assertGrowthRunAudit(new AgentAuditRepository(workspace), cycle.runId!);
    }
    const checkpointCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM checkpoints").get()?.count ?? 0);
    const changeSetCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()?.count ?? 0);
    return {
      goalId,
      cycles: cycles.map((cycle) => ({ id: cycle.id, sequence: cycle.sequence, runId: cycle.runId, status: cycle.status })),
      world: world!, story: story!, ocs, distinctive: distinctive!,
      counts: { resources: formal.length, documents: 2 + ocDocuments.length, assertions: sourced.length, relations: relations.length },
      changeSetCount,
      checkpointCount,
    };
  } finally {
    workspace.close();
  }
}

function requiredStable(documents: DocumentRepository, resource: ResourceRecord): DocumentVersionRecord {
  const stable = documents.getCurrentStable(resource.id);
  expect(stable).not.toBeNull();
  return stable!;
}

function assertGrowthRunAudit(audit: AgentAuditRepository, runId: string): void {
  const tools = audit.listTools(runId);
  const toolNames = tools.map((row) => String(row.tool_name));
  expect(toolNames.filter((name) => name === "retrieve_graph_evidence")).toHaveLength(1);
  expect(toolNames.filter((name) => name === "propose_change_set")).toHaveLength(1);
  const events = audit.listEvents(runId);
  for (const name of ["retrieve_graph_evidence", "propose_change_set"]) {
    const invocationIds = new Set(tools.filter((row) => row.tool_name === name).map((row) => String(row.id)));
    expect(events.some((event) => invocationIds.has(String(event.tool_invocation_id)) && event.event_type === "succeeded")).toBe(true);
  }
}

async function runResearchOnly(page: Page, persisted: PersistedGrowth): Promise<{ runId: string; safe: { runId: string; retrieveSucceeded: boolean; noMutationTools: boolean } }> {
  const result = await page.evaluate(async ({ worldId, storyId, ocIds, subject }) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const project = (await desktop.project.list()).projects[0];
    if (!project) throw new Error("RESEARCH_PROJECT_MISSING");
    const session = await desktop.session.create({ projectId: project.id, title: "真实 Growth 后续检索验收" });
    return new Promise<{ runId: string; terminal: AgentRunEvent; events: AgentRunEvent[] }>((resolve, reject) => {
      const events: AgentRunEvent[] = [];
      let expectedRunId: string | null = null;
      const release = desktop.agent.subscribe((event) => {
        if (event.sessionId !== session.id || (expectedRunId && event.runId !== expectedRunId)) return;
        events.push(event);
        if (event.type === "run.completed" || event.type === "run.failed") {
          globalThis.clearTimeout(timer);
          release();
          resolve({ runId: event.runId, terminal: event, events });
        }
      });
      const timer = globalThis.setTimeout(() => { release(); reject(new Error("RESEARCH_RUN_TIMEOUT")); }, 240_000);
      void desktop.agent.start({
        projectId: project.id,
        sessionId: session.id,
        userInput: `仅做研究，不得创建 Change Set、资源、文档、断言、关系或图片。必须调用 retrieve_graph_evidence 检索正式来源，然后说明“${subject}”是什么以及它与当前世界或故事的关系。`,
        mode: "assist",
        scopeResourceIds: [worldId, storyId, ...ocIds],
      }).then((started) => { expectedRunId = started.runId; }).catch((error: unknown) => {
        globalThis.clearTimeout(timer);
        release();
        reject(error);
      });
    });
  }, { worldId: persisted.world.id, storyId: persisted.story.id, ocIds: persisted.ocs.map((oc) => oc.id), subject: persisted.distinctive.subject });
  if (result.terminal.type === "run.failed") throw new Error(`RESEARCH_TERMINAL_${result.terminal.code}`);
  if (result.terminal.type !== "run.completed") throw new Error("RESEARCH_TERMINAL_INVALID");
  expect(result.terminal).toMatchObject({ type: "run.completed", outcome: "completed", changeSetState: "none" });
  expect(result.terminal.message).toContain(persisted.distinctive.subject);
  expect(result.events.some((event) => event.type === "run.activity" && event.label === "检索项目事实" && event.phase === "completed")).toBe(true);
  return { runId: result.runId, safe: { runId: result.runId, retrieveSucceeded: true, noMutationTools: true } };
}

function inspectResearchAudit(workspacePath: string, persisted: PersistedGrowth, researchRunId: string): void {
  const workspace = openWorkspace(workspacePath);
  try {
    const tools = new AgentAuditRepository(workspace).listTools(researchRunId);
    const names = tools.map((row) => String(row.tool_name));
    expect(names.filter((name) => name === "retrieve_graph_evidence")).toHaveLength(1);
    expect(names.includes("propose_change_set")).toBe(false);
    expect(names.includes("generate_image")).toBe(false);
    const events = new AgentAuditRepository(workspace).listEvents(researchRunId);
    const retrieveIds = new Set(tools.filter((row) => row.tool_name === "retrieve_graph_evidence").map((row) => String(row.id)));
    expect(events.some((event) => retrieveIds.has(String(event.tool_invocation_id)) && event.event_type === "succeeded")).toBe(true);
    expect(Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()?.count ?? 0)).toBe(persisted.changeSetCount);
    expect(Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM checkpoints").get()?.count ?? 0)).toBe(persisted.checkpointCount);
  } finally {
    workspace.close();
  }
}

function assertNoPlaintextCredentialSurface(
  workspacePath: string,
  userDataPath: string,
  growthEvents: GrowthLiveEvent[],
  agentEvents: AgentRunEvent[],
): void {
  expect(containsCredentialMarker(workspacePath, new Set(["provider-profile.v1.json", "Local State"]))).toBe(false);
  expect(containsCredentialMarker(userDataPath, new Set(["provider-profile.v1.json", "Local State"]))).toBe(false);
  const publicSurface = JSON.stringify({ growthEvents, agentEvents });
  expect(containsCredentialMarkerInText(publicSurface)).toBe(false);
}

function containsCredentialMarker(root: string, excludedNames: Set<string>): boolean {
  if (!fs.existsSync(root)) return false;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (containsCredentialMarker(target, excludedNames)) return true;
    } else if (!excludedNames.has(entry.name) && containsCredentialMarkerInText(fs.readFileSync(target, "utf8"))) {
      return true;
    }
  }
  return false;
}

function containsCredentialMarkerInText(value: string): boolean {
  return /(?:authorization\s*:\s*(?:basic|bearer)|\bapi[_-]?key\s*[:=]\s*[^\s"']+|\btoken\s*[:=]\s*[^\s"']+|\bsk-[A-Za-z0-9_-]{12,})/i.test(value);
}

function writeEvidence(directory: string, evidence: SafeEvidence): void {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `growth-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function captureSqliteEvidence(workspacePath: string, goalId?: string): SafeSqliteEvidence | undefined {
  const workspace = openWorkspace(workspacePath);
  try {
    const resolvedGoalId = goalId ?? (workspace.db.prepare("SELECT id FROM growth_goals ORDER BY created_at DESC LIMIT 1").get() as { id?: unknown } | undefined)?.id;
    if (typeof resolvedGoalId !== "string") return undefined;
    const cycles = new GrowthRepository(workspace).listCycles(resolvedGoalId);
    const formalResources = new ResourceRepository(workspace).listCurrent().filter((resource) => resource.objectKind !== "domain_root");
    const assertions = new AssertionRepository(workspace).listCurrentInScopes(formalResources.map((resource) => resource.id));
    const relations = new CreativeRelationRepository(workspace).listCurrent();
    const changeSetCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()?.count ?? 0);
    const changeSetStatuses = workspace.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM change_sets
      GROUP BY status
      ORDER BY status ASC
    `).all() as Array<{ status: string; count: number }>;
    const outputCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM change_set_outputs").get()?.count ?? 0);
    const checkpointCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM checkpoints").get()?.count ?? 0);
    return {
      cycles: cycles.map((cycle) => ({
        id: cycle.id,
        sequence: cycle.sequence,
        status: cycle.status,
        failureCode: cycle.failureCode,
        runId: cycle.runId,
        receiptId: cycle.receiptId,
        changeSetId: cycle.changeSetId,
        inputCheckpointId: cycle.inputCheckpointId,
        outputCheckpointId: cycle.outputCheckpointId,
        audit: cycle.runId ? safeRunAudit(workspace, cycle.runId) : null,
      })),
      counts: {
        resources: formalResources.length,
        documents: Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM document_versions").get()?.count ?? 0),
        assertions: assertions.length,
        relations: relations.length,
      },
      changeSets: {
        total: changeSetCount,
        byStatus: changeSetStatuses.map(({ status, count }) => ({ status, count: Number(count) })),
        outputCount,
        checkpointCount,
        checkpointDeltaFromInitial: Math.max(0, checkpointCount - 1),
      },
    };
  } finally {
    workspace.close();
  }
}

function safeRunAudit(workspace: ReturnType<typeof openWorkspace>, runId: string): NonNullable<SafeSqliteEvidence["cycles"][number]["audit"]> {
  const audit = new AgentAuditRepository(workspace);
  const run = workspace.db.prepare(`
    SELECT provider_id, requested_model_id FROM agent_runs WHERE id = ?
  `).get(runId) as { provider_id?: unknown; requested_model_id?: unknown } | undefined;
  const tools = audit.listTools(runId);
  const auditEvents = audit.listEvents(runId);
  const toolOutcomes = tools.map((tool) => {
    const invocationId = String(tool.id);
    return {
      name: String(tool.tool_name),
      outcomes: auditEvents
        .filter((event) => String(event.tool_invocation_id) === invocationId && (event.event_type === "succeeded" || event.event_type === "failed"))
        .map((event) => String(event.event_type)),
    };
  });
  return {
    terminal: auditEvents
      .filter((event) => Number(event.terminal) === 1)
      .map((event) => ({
        entityType: String(event.entity_type),
        eventType: String(event.event_type),
        errorCode: typeof event.error_code === "string" ? event.error_code : null,
      })),
    tools: toolOutcomes,
    requestedProviderId: typeof run?.provider_id === "string" ? run.provider_id : null,
    requestedModelId: typeof run?.requested_model_id === "string" ? run.requested_model_id : null,
    actualProviderIds: [...new Set(auditEvents.map((event) => event.actual_provider_id).filter((value): value is string => typeof value === "string"))],
    actualModelIds: [...new Set(auditEvents.map((event) => event.actual_model_id).filter((value): value is string => typeof value === "string"))],
  };
}

function safeFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "GROWTH_LIVE_ACCEPTANCE_FAILED";
  const allowlisted = new Set([
    "GROWTH_CYCLE_WATCHDOG_TIMEOUT", "GROWTH_OVERALL_TIMEOUT", "GROWTH_GET_FAILED", "GROWTH_START_FAILED",
    "REAL_PROVIDER_LOCAL_STATE_MISSING", "REAL_PROVIDER_MODEL_ID_MISMATCH", "REAL_PROVIDER_CONFIG_UNAVAILABLE",
    "RESEARCH_RUN_TIMEOUT", "RESEARCH_TERMINAL_INVALID", "GROWTH_COORDINATOR_TERMINAL_NOT_COMPLETED",
  ]);
  if (allowlisted.has(error.message)) return error.message;
  if (/^RESEARCH_TERMINAL_[A-Z0-9_]+$/.test(error.message)) return "AGENT_RUN_FAILED";
  return "GROWTH_LIVE_ACCEPTANCE_FAILED";
}
