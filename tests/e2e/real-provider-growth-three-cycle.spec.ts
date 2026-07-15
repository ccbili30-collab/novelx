import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import { AssertionRepository, type SourcedAssertionRecord } from "../../src/domain/graph/assertionRepository";
import { CreativeRelationRepository } from "../../src/domain/workspace/creativeRelationRepository";
import { ImageAssetRepository } from "../../src/domain/asset/imageAssetRepository";
import { ImageAssetStore } from "../../src/domain/asset/imageAssetStore";
import { DocumentRepository, type DocumentVersionRecord } from "../../src/domain/workspace/documentRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { ResourceRepository, type ResourceRecord } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { ApplicationRegistryRepository } from "../../src/domain/application/applicationRegistryRepository";
import { PROVIDER_STORE_FILE_NAME } from "../../src/main/providerSecureStore";
import { IMAGE_PROVIDER_STORE_FILE_NAME } from "../../src/main/imageProviderSecureStore";
import type { AgentRunEvent, DesktopApi, GrowthLiveEvent } from "../../src/shared/ipcContract";
import { closeTestElectronApp } from "./support/electronCleanup";
import { watchGrowthTerminal } from "./support/growthWatcher";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const configuredProviderStorePath = process.env.NOVAX_REAL_E2E_PROVIDER_STORE?.trim()
  || (process.env.APPDATA ? path.join(process.env.APPDATA, "novelx-desktop", PROVIDER_STORE_FILE_NAME) : "");
const configuredImageProviderStorePath = process.env.NOVAX_REAL_E2E_IMAGE_PROVIDER_STORE?.trim()
  || (process.env.APPDATA ? path.join(process.env.APPDATA, "novelx-desktop", IMAGE_PROVIDER_STORE_FILE_NAME) : "");

test.skip(!configuredProviderStorePath || !configuredImageProviderStorePath || !fs.existsSync(configuredProviderStorePath) || !fs.existsSync(configuredImageProviderStorePath), "Machine-local encrypted gpt-5.4 and gpt-image-2 Provider stores are required.");

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
    provider: { providerId: null, modelId: null }, imageProvider: { providerId: null, modelId: null },
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
  fs.copyFileSync(configuredImageProviderStorePath, path.join(userDataPath, IMAGE_PROVIDER_STORE_FILE_NAME));
  const textLocalState = path.join(path.dirname(configuredProviderStorePath), "Local State");
  const imageLocalState = path.join(path.dirname(configuredImageProviderStorePath), "Local State");
  if (!fs.existsSync(textLocalState) || !fs.existsSync(imageLocalState)) throw new Error("REAL_PROVIDER_LOCAL_STATE_MISSING");
  if (path.resolve(textLocalState) !== path.resolve(imageLocalState)
    && !fs.readFileSync(textLocalState).equals(fs.readFileSync(imageLocalState))) throw new Error("REAL_PROVIDER_LOCAL_STATE_MISMATCH");
  fs.copyFileSync(textLocalState, path.join(userDataPath, "Local State"));
  initializeProject(userDataPath, workspacePath);
  evidence.initialGreenfield = captureInitialGreenfieldEligibility(workspacePath);
  if (!evidence.initialGreenfield.eligible) {
    evidence.outcome = "blocked_before_provider_start";
    evidence.failureCode = "INITIAL_GREENFIELD_INELIGIBLE";
    evidence.leakScan = "not_run";
    writeEvidence(evidenceDirectory, evidence);
    throw new Error("INITIAL_GREENFIELD_INELIGIBLE");
  }

  try {
    app = await launch(userDataPath, workspacePath);
    const page = await app.firstWindow();
    const provider = await providerStatus(page);
    evidence.provider = provider;
    if (provider.modelId !== "gpt-5.4") throw new Error("REAL_PROVIDER_MODEL_ID_MISMATCH");
    const imageProvider = await imageProviderStatus(page);
    evidence.imageProvider = imageProvider;
    if (imageProvider.modelId !== "gpt-image-2") throw new Error("REAL_IMAGE_PROVIDER_MODEL_ID_MISMATCH");

    providerStarted = true;
    evidence.providerStarted = true;
    const first = await startGrowthAndWatch(page, 900_000, 420_000, (visual) => {
      evidence.visual = visual;
    });
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
    evidence.visual = first.visual;

    await closeTestElectronApp(app);
    app = null;
    const persisted = inspectCommittedGrowth(workspacePath, first.goalId);
    evidence.cycles = persisted.cycles;
    evidence.counts = persisted.counts;
    evidence.worldMap = persisted.worldMap;

    app = await launch(userDataPath, workspacePath);
    const researchPage = await app.firstWindow();
    await assertShowcaseWorldMap(researchPage, persisted);
    const research = await runResearchOnly(researchPage, persisted);
    evidence.research = research.safe;
    await closeTestElectronApp(app);
    app = null;

    inspectResearchAudit(workspacePath, persisted, research.runId);
    assertNoPlaintextCredentialSurface(workspacePath, userDataPath, first.growthEvents, first.agentEvents);
    evidence.leakScan = "passed";
    evidence.outcome = "completed";
  } catch (error) {
    if (error instanceof AutoShowcaseDiagnosticError) {
      evidence.goalId = error.safe.goalId;
      evidence.cycles = error.safe.snapshot.cycles.map((cycle) => ({
        id: cycle.id,
        sequence: cycle.sequence,
        runId: cycle.runId,
        status: cycle.status,
      }));
      evidence.preTermination = safePreTermination(error.safe.snapshot, error.safe.growthEvents, error.safe.agentEvents, error.safe.elapsedMs);
      evidence.visual = error.safe.visual;
    }
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
  imageProvider: { providerId: string | null; modelId: string | null };
  providerStarted: boolean;
  outcome: "not_started" | "blocked_before_provider_start" | "failed_after_provider_start" | "completed";
  failureCode?: string;
  goalId?: string;
  cycles: Array<{ id: string; sequence: number; runId: string | null; status: string }>;
  research: { runId: string; retrieveSucceeded: boolean; noMutationTools: boolean } | null;
  counts: { resources: number; documents: number; assertions: number; relations: number } | null;
  worldMap?: { jobId: string; assetId: string; providerId: string; modelId: string; sourceResourceCount: number; sourceVersionCount: number; mimeType: string; width: number; height: number; byteLength: number; sha256: string };
  leakScan: "not_run" | "passed";
  preTermination?: SafePreTermination;
  termination?: SafeTermination;
  postTermination?: SafeSqliteEvidence;
  initialGreenfield?: SafeInitialGreenfieldEligibility;
  visual?: SafeVisualEvidence;
}

interface SafeVisualEvidence {
  userMessageVisible: boolean;
  timelineVisible: boolean;
  maximumTimelineRows: number;
  mapLifecycleSequenceObserved: boolean;
  rightReadyWorldMapObserved: boolean;
  autoShowcaseObserved: boolean;
  autoShowcaseOpenCount: number;
  finalTimelineStatus: "completed" | "blocked" | "failed" | "other" | null;
  finalTimelineTerminalCategory: "completed" | "blocked" | "failed" | "other" | null;
  rightWorldMapStatus: "queued" | "generating" | "ready" | "failed" | "reconciliation_required" | "other" | null;
  manualActionPresent: boolean;
  manualDomClickDispatched: boolean;
  manualShowcaseObserved: boolean;
  manualShowcaseOpenCount: number;
  finalRouteAgent: boolean;
  finalRouteShowcase: boolean;
  route: "agent" | "showcase" | "other";
  finalReadyMapEvidenced: boolean;
  showcase?: {
    readyWorldMapCount: number;
    proseDocumentCount: number;
    characterCardCount: number;
    graphNodeCount: number;
    failureBannerVisible: boolean;
  };
  screenshots: {
    agentStage?: SafeScreenshotEvidence;
    showcase?: SafeScreenshotEvidence;
  };
}

interface SafeScreenshotEvidence {
  relativePath: string;
  sha256: string;
}

class AutoShowcaseDiagnosticError extends Error {
  constructor(readonly safe: {
    goalId: string;
    snapshot: Awaited<ReturnType<DesktopApi["growth"]["get"]>>;
    growthEvents: GrowthLiveEvent[];
    agentEvents: AgentRunEvent[];
    elapsedMs: number;
    visual: SafeVisualEvidence;
  }) {
    super("AUTO_SHOWCASE_NOT_OBSERVED");
  }
}

interface SafeInitialGreenfieldEligibility {
  eligible: boolean;
  nonRootResourceRevisions: number;
  assertionVersions: number;
  creativeDocumentRevisions: number;
  creativeRelationVersions: number;
  constraintProfileVersions: number;
  documentVersions: number;
  workingDocuments: number;
  workingCreativeDocuments: number;
  workingConstraintProfiles: number;
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

function captureInitialGreenfieldEligibility(workspacePath: string): SafeInitialGreenfieldEligibility {
  const workspace = openWorkspace(workspacePath);
  try {
    const counts = workspace.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM resource_revisions WHERE object_kind <> 'domain_root') AS non_root_resource_revisions,
        (SELECT COUNT(*) FROM assertion_versions) AS assertion_versions,
        (SELECT COUNT(*) FROM creative_document_revisions) AS creative_document_revisions,
        (SELECT COUNT(*) FROM creative_relation_versions) AS creative_relation_versions,
        (SELECT COUNT(*) FROM constraint_profile_versions) AS constraint_profile_versions,
        (SELECT COUNT(*) FROM document_versions) AS document_versions,
        (SELECT COUNT(*) FROM working_documents) AS working_documents,
        (SELECT COUNT(*) FROM working_creative_documents) AS working_creative_documents,
        (SELECT COUNT(*) FROM working_constraint_profiles) AS working_constraint_profiles
    `).get() as Record<string, number>;
    const values = Object.values(counts).map(Number);
    return {
      eligible: values.every((value) => value === 0),
      nonRootResourceRevisions: Number(counts.non_root_resource_revisions),
      assertionVersions: Number(counts.assertion_versions),
      creativeDocumentRevisions: Number(counts.creative_document_revisions),
      creativeRelationVersions: Number(counts.creative_relation_versions),
      constraintProfileVersions: Number(counts.constraint_profile_versions),
      documentVersions: Number(counts.document_versions),
      workingDocuments: Number(counts.working_documents),
      workingCreativeDocuments: Number(counts.working_creative_documents),
      workingConstraintProfiles: Number(counts.working_constraint_profiles),
    };
  } finally {
    workspace.close();
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

async function imageProviderStatus(page: Page): Promise<{ providerId: string | null; modelId: string | null }> {
  return page.evaluate(async () => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const status = await desktop.imageProvider.getStatus();
    if (!status.ok || !status.state.hasCredential || !status.state.config) return { providerId: null, modelId: null };
    return { providerId: status.state.config.providerId, modelId: status.state.config.modelId };
  });
}

async function startGrowthAndWatch(
  page: Page,
  overallTimeoutMs: number,
  cycleTimeoutMs: number,
  onVisualSnapshot?: (visual: SafeVisualEvidence) => void,
): Promise<{
  projectId: string;
  sessionId: string;
  goalId: string;
  snapshot: Awaited<ReturnType<DesktopApi["growth"]["get"]>>;
  growthEvents: GrowthLiveEvent[];
  agentEvents: AgentRunEvent[];
  elapsedMs: number;
  visual: SafeVisualEvidence;
  preTermination?: SafePreTermination;
  termination?: "GROWTH_CYCLE_WATCHDOG_TIMEOUT" | "GROWTH_OVERALL_TIMEOUT" | "GROWTH_AGENT_TERMINAL_PROJECTION_TIMEOUT";
}> {
  const bufferKey = `__novaxGrowthWatch_${randomUUID()}`;
  const prepared = await page.evaluate(async ({ receivedBufferKey }) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const project = (await desktop.project.list()).projects[0];
    if (!project) throw new Error("GROWTH_PROJECT_MISSING");
    const sessions = await desktop.session.list({ projectId: project.id });
    const session = sessions.sessions[0];
    if (!session) throw new Error("GROWTH_UI_SESSION_MISSING");
    const growthEvents: GrowthLiveEvent[] = [];
    const agentEvents: AgentRunEvent[] = [];
    const releaseGrowth = desktop.growth.subscribe((event) => { if (event.sessionId === session.id) growthEvents.push(event); });
    const releaseAgent = desktop.agent.subscribe((event) => { if (event.sessionId === session.id) agentEvents.push(event); });
    const visual = {
      userMessageVisible: false,
      timelineVisible: false,
      maximumTimelineRows: 0,
      mapLifecycleSequenceObserved: false,
      rightReadyWorldMapObserved: false,
      autoShowcaseObserved: false,
      autoShowcaseOpenCount: 0,
      finalTimelineStatus: null as SafeVisualEvidence["finalTimelineStatus"],
      finalTimelineTerminalCategory: null as SafeVisualEvidence["finalTimelineTerminalCategory"],
      rightWorldMapStatus: null as SafeVisualEvidence["rightWorldMapStatus"],
      manualActionPresent: false,
      manualDomClickDispatched: false,
      manualShowcaseObserved: false,
      manualShowcaseOpenCount: 0,
      finalRouteAgent: false,
      finalRouteShowcase: false,
      route: "other" as "agent" | "showcase" | "other",
      finalReadyMapEvidenced: false,
      showcase: undefined as SafeVisualEvidence["showcase"] | undefined,
      screenshots: {} as SafeVisualEvidence["screenshots"],
      showcasePresent: false,
      manualActionClicked: false,
    };
    const observeVisual = () => {
      visual.userMessageVisible ||= document.querySelector(".steward-message--user") !== null;
      const timeline = document.querySelector<HTMLElement>("[aria-label='生长活动时间线']");
      if (timeline) {
        visual.timelineVisible = true;
        visual.maximumTimelineRows = Math.max(visual.maximumTimelineRows, timeline.querySelectorAll(".growth-timeline__row").length);
        const timelineText = timeline.textContent ?? "";
        const queued = timelineText.indexOf("世界地图排队中");
        const generating = timelineText.indexOf("生成世界地图", queued + 1);
        const ready = timelineText.indexOf("世界地图已生成", generating + 1);
        visual.mapLifecycleSequenceObserved ||= queued >= 0 && generating > queued && ready > generating;
        const status = timeline.getAttribute("data-status");
        if (status === "completed" || status === "blocked" || status === "failed") visual.finalTimelineStatus = status;
        else if (status && status !== "running") visual.finalTimelineStatus = "other";
        const terminalLabel = timeline.querySelector("[role='status']")?.textContent ?? "";
        if (terminalLabel.includes("完成")) visual.finalTimelineTerminalCategory = "completed";
        else if (terminalLabel.includes("阻塞")) visual.finalTimelineTerminalCategory = "blocked";
        else if (terminalLabel.includes("失败")) visual.finalTimelineTerminalCategory = "failed";
        else if (terminalLabel.trim()) visual.finalTimelineTerminalCategory = "other";
      }
      const route = document.querySelector("main.workbench")?.getAttribute("data-mode");
      visual.route = route === "agent" || route === "showcase" ? route : "other";
      visual.finalRouteAgent = visual.route === "agent";
      visual.finalRouteShowcase = visual.route === "showcase";
      const readyMap = document.querySelector(".run-work-target-pane__world-map[data-status='ready']");
      if (readyMap && visual.route === "agent") visual.rightReadyWorldMapObserved = true;
      const map = document.querySelector(".run-work-target-pane__world-map");
      const mapStatus = map?.getAttribute("data-status");
      if (mapStatus === "queued" || mapStatus === "generating" || mapStatus === "ready" || mapStatus === "failed" || mapStatus === "reconciliation_required") visual.rightWorldMapStatus = mapStatus;
      else if (mapStatus) visual.rightWorldMapStatus = "other";
      visual.manualActionPresent = Boolean(readyMap?.querySelector("button"));
      const showcasePresent = document.querySelector(".creative-showcase") !== null;
      if (showcasePresent && !visual.showcasePresent && !visual.manualActionClicked) visual.autoShowcaseOpenCount += 1;
      if (showcasePresent && !visual.showcasePresent && visual.manualActionClicked) visual.manualShowcaseOpenCount += 1;
      visual.showcasePresent = showcasePresent;
      visual.autoShowcaseObserved ||= showcasePresent && !visual.manualActionClicked;
      visual.manualShowcaseObserved ||= showcasePresent && visual.manualActionClicked;
    };
    const observer = new MutationObserver(observeVisual);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    observeVisual();
    const state = globalThis as typeof globalThis & { [key: string]: unknown };
    state[receivedBufferKey] = { growthEvents, agentEvents, releaseGrowth, releaseAgent, observer, observeVisual, visual, released: false };
    return { projectId: project.id, sessionId: session.id };
  }, { receivedBufferKey: bufferKey });

  const seed = "一座港湾会在潮汐倒转时显出被遗忘的石阶，城民据此安排誓约、航行与继承。";
  const composer = page.getByLabel("给大管家发送消息");
  const growthMode = page.getByRole("radio", { name: "生长", exact: true });
  try {
    await expect(composer).toBeEnabled({ timeout: 8_000 });
    await growthMode.click({ timeout: 8_000 });
    await expect(growthMode).toHaveAttribute("aria-checked", "true");
    await composer.fill(seed);
    const send = page.getByTitle("发送");
    await expect(send).toBeEnabled({ timeout: 8_000 });
    await send.click({ timeout: 8_000 });
    const submittedSeed = page.locator(".steward-message--user").filter({ hasText: seed });
    await expect(submittedSeed).toHaveCount(1, { timeout: 8_000 });
    await expect(submittedSeed).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole("region", { name: "生长活动时间线" })).toBeVisible({ timeout: 8_000 });
  } catch (cause) {
    await disposeGrowthVisualBuffer(page, bufferKey);
    throw cause;
  }

  await expect.poll(() => page.evaluate((receivedBufferKey) => {
    const state = globalThis as typeof globalThis & { [key: string]: unknown };
    const buffer = state[receivedBufferKey] as { growthEvents: GrowthLiveEvent[] } | undefined;
    return buffer?.growthEvents[0]?.event.goalId ?? null;
  }, bufferKey), { timeout: 30_000 }).not.toBeNull();
  const goalId = await page.evaluate((receivedBufferKey) => {
    const state = globalThis as typeof globalThis & { [key: string]: unknown };
    const buffer = state[receivedBufferKey] as { growthEvents: GrowthLiveEvent[] } | undefined;
    return buffer?.growthEvents[0]?.event.goalId ?? null;
  }, bufferKey);
  if (!goalId) {
    await disposeGrowthVisualBuffer(page, bufferKey);
    throw new Error("GROWTH_UI_GOAL_MISSING");
  }
  const started = { ...prepared, goalId };
  let agentStageScreenshot: SafeScreenshotEvidence | undefined;
  let latestVisual = await readGrowthVisual(page, bufferKey);

  const watched = await watchGrowthTerminal({
    overallTimeoutMs,
    cycleTimeoutMs,
    terminalDeliveryTimeoutMs: 60_000,
    pollMs: 500,
    getSnapshot: () => page.evaluate(async ({ projectId, sessionId, goalId }) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      return desktop.growth.get({ projectId, sessionId, goalId });
    }, started),
    readEvents: async () => {
      const events = await page.evaluate((receivedBufferKey) => {
        const state = globalThis as typeof globalThis & { [key: string]: unknown };
        const buffer = state[receivedBufferKey] as { growthEvents: GrowthLiveEvent[]; agentEvents: AgentRunEvent[]; observeVisual(): void; visual: SafeVisualEvidence } | undefined;
        if (!buffer) throw new Error("GROWTH_EVENT_BUFFER_MISSING");
        buffer.observeVisual();
        return { growthEvents: [...buffer.growthEvents], agentEvents: [...buffer.agentEvents], visual: buffer.visual };
      }, bufferKey);
      latestVisual = events.visual;
      if (!agentStageScreenshot && events.visual.rightReadyWorldMapObserved && events.visual.route === "agent") {
        agentStageScreenshot = await captureVisualScreenshot(page, "test-results/real-growth-live-agent-stage.png");
      }
      return events;
    },
    terminalDeliverySatisfied: (snapshot, events) => {
      const terminalRunIds = new Set(events.agentEvents
        .filter((event) => event.type === "run.completed" || event.type === "run.failed")
        .map((event) => event.runId));
      return snapshot.cycles.every((cycle) => cycle.runId === null || terminalRunIds.has(cycle.runId));
    },
    release: () => page.evaluate((receivedBufferKey) => {
      const state = globalThis as typeof globalThis & { [key: string]: unknown };
      const buffer = state[receivedBufferKey] as { releaseGrowth(): void; releaseAgent(): void; released: boolean } | undefined;
      if (buffer && !buffer.released) {
        buffer.releaseGrowth();
        buffer.releaseAgent();
        buffer.released = true;
      }
    }, bufferKey),
  });
  const { growthEvents, agentEvents } = watched.events;
  if (!watched.termination) {
    const autoShowcaseObserved = await waitForShowcase(page, bufferKey, 30_000, (visual) => visual.autoShowcaseObserved && visual.route === "showcase");
    latestVisual = await readGrowthVisual(page, bufferKey);
    onVisualSnapshot?.(latestVisual);
    if (!autoShowcaseObserved) {
      if (latestVisual.manualActionPresent) {
        try {
          await dispatchManualShowcaseDomClick(page, bufferKey);
          latestVisual = await readGrowthVisual(page, bufferKey);
          onVisualSnapshot?.(latestVisual);
        } catch {
          latestVisual = { ...latestVisual, manualDomClickDispatched: false };
          onVisualSnapshot?.(latestVisual);
        }
      }
      await waitForShowcase(page, bufferKey, 30_000, (visual) => visual.manualShowcaseObserved && visual.route === "showcase");
      latestVisual = await readGrowthVisual(page, bufferKey);
      onVisualSnapshot?.(latestVisual);
      await disposeGrowthVisualBuffer(page, bufferKey);
      throw new AutoShowcaseDiagnosticError({
        goalId: started.goalId,
        snapshot: watched.snapshot,
        growthEvents,
        agentEvents,
        elapsedMs: watched.elapsedMs,
        visual: latestVisual,
      });
    }
    expect(latestVisual.userMessageVisible).toBe(true);
    expect(latestVisual.timelineVisible).toBe(true);
    expect(latestVisual.maximumTimelineRows).toBeGreaterThanOrEqual(3);
    expect(latestVisual.mapLifecycleSequenceObserved).toBe(true);
    expect(latestVisual.rightReadyWorldMapObserved).toBe(true);
    expect(latestVisual.rightWorldMapStatus).toBe("ready");
    expect(latestVisual.autoShowcaseObserved).toBe(true);
    expect(latestVisual.autoShowcaseOpenCount).toBe(1);
    expect(latestVisual.manualDomClickDispatched).toBe(false);
    expect(latestVisual.manualShowcaseObserved).toBe(false);
    expect(latestVisual.manualShowcaseOpenCount).toBe(0);
    expect(latestVisual.finalTimelineStatus).toBe("completed");
    expect(latestVisual.finalTimelineTerminalCategory).toBe("completed");
    expect(latestVisual.finalRouteShowcase).toBe(true);
    latestVisual.showcase = await assertMountedGrowthShowcase(page);
    latestVisual.finalReadyMapEvidenced = latestVisual.rightReadyWorldMapObserved && latestVisual.showcase.readyWorldMapCount === 1;
    expect(latestVisual.finalReadyMapEvidenced).toBe(true);
    latestVisual.screenshots = {
      ...(agentStageScreenshot ? { agentStage: agentStageScreenshot } : {}),
      showcase: await captureVisualScreenshot(page, "test-results/real-growth-live-showcase.png"),
    };
    onVisualSnapshot?.(latestVisual);
  }
  await disposeGrowthVisualBuffer(page, bufferKey);
  return {
    ...started,
    snapshot: watched.snapshot,
    growthEvents,
    agentEvents,
    elapsedMs: watched.elapsedMs,
    visual: latestVisual,
    ...(watched.termination ? { termination: watched.termination, preTermination: safePreTermination(watched.snapshot, growthEvents, agentEvents, watched.elapsedMs) } : {}),
  };
}

async function readGrowthVisual(page: Page, bufferKey: string): Promise<SafeVisualEvidence> {
  return page.evaluate((receivedBufferKey) => {
    const state = globalThis as typeof globalThis & { [key: string]: unknown };
    const buffer = state[receivedBufferKey] as { observeVisual(): void; visual: SafeVisualEvidence } | undefined;
    if (!buffer) throw new Error("GROWTH_VISUAL_BUFFER_MISSING");
    buffer.observeVisual();
    const visual = buffer.visual;
    return {
      userMessageVisible: visual.userMessageVisible,
      timelineVisible: visual.timelineVisible,
      maximumTimelineRows: visual.maximumTimelineRows,
      mapLifecycleSequenceObserved: visual.mapLifecycleSequenceObserved,
      rightReadyWorldMapObserved: visual.rightReadyWorldMapObserved,
      autoShowcaseObserved: visual.autoShowcaseObserved,
      autoShowcaseOpenCount: visual.autoShowcaseOpenCount,
      finalTimelineStatus: visual.finalTimelineStatus,
      finalTimelineTerminalCategory: visual.finalTimelineTerminalCategory,
      rightWorldMapStatus: visual.rightWorldMapStatus,
      manualActionPresent: visual.manualActionPresent,
      manualDomClickDispatched: visual.manualDomClickDispatched,
      manualShowcaseObserved: visual.manualShowcaseObserved,
      manualShowcaseOpenCount: visual.manualShowcaseOpenCount,
      finalRouteAgent: visual.finalRouteAgent,
      finalRouteShowcase: visual.finalRouteShowcase,
      route: visual.route,
      finalReadyMapEvidenced: visual.finalReadyMapEvidenced,
      ...(visual.showcase ? { showcase: visual.showcase } : {}),
      screenshots: visual.screenshots,
    };
  }, bufferKey);
}

async function waitForShowcase(
  page: Page,
  bufferKey: string,
  timeoutMs: number,
  predicate: (visual: SafeVisualEvidence) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visual = await readGrowthVisual(page, bufferKey);
    if (predicate(visual)) return true;
    await page.waitForTimeout(500);
  }
  return predicate(await readGrowthVisual(page, bufferKey));
}

async function dispatchManualShowcaseDomClick(page: Page, bufferKey: string): Promise<boolean> {
  return page.evaluate((receivedBufferKey) => {
    const state = globalThis as typeof globalThis & { [key: string]: unknown };
    const buffer = state[receivedBufferKey] as { visual: { manualActionClicked: boolean; manualDomClickDispatched: boolean } } | undefined;
    if (!buffer) throw new Error("GROWTH_VISUAL_BUFFER_MISSING");
    const action = document.querySelector<HTMLElement>(".run-work-target-pane__world-map[data-status='ready'] button");
    if (!action) return false;
    buffer.visual.manualActionClicked = true;
    try {
      action.click();
      buffer.visual.manualDomClickDispatched = true;
      return true;
    } catch {
      buffer.visual.manualDomClickDispatched = false;
      return false;
    }
  }, bufferKey);
}

async function disposeGrowthVisualBuffer(page: Page, bufferKey: string): Promise<void> {
  await page.evaluate((receivedBufferKey) => {
    const state = globalThis as typeof globalThis & { [key: string]: unknown };
    const buffer = state[receivedBufferKey] as { releaseGrowth(): void; releaseAgent(): void; observer: MutationObserver; released: boolean } | undefined;
    if (!buffer) return;
    if (!buffer.released) {
      buffer.releaseGrowth();
      buffer.releaseAgent();
      buffer.released = true;
    }
    buffer.observer.disconnect();
    delete state[receivedBufferKey];
  }, bufferKey);
}

async function captureVisualScreenshot(page: Page, relativePath: string): Promise<SafeScreenshotEvidence> {
  const absolutePath = path.join(process.cwd(), relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  await page.screenshot({ path: absolutePath, fullPage: true });
  return {
    relativePath: relativePath.replace(/\\/g, "/"),
    sha256: createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"),
  };
}

async function assertMountedGrowthShowcase(page: Page): Promise<NonNullable<SafeVisualEvidence["showcase"]>> {
  const showcase = page.locator(".creative-showcase");
  await expect(showcase).toBeVisible({ timeout: 30_000 });
  await expect(showcase.locator("section[aria-label='视觉资产'] img")).toBeVisible();
  await expect(showcase.locator("section[aria-label='故事正文'] .showcase-story__prose")).toContainText(/\S/);
  await expect.poll(() => showcase.locator(".showcase-character-card").count()).toBeGreaterThanOrEqual(2);
  await expect(showcase.locator("details[aria-label='事件图谱预览']")).toBeVisible();
  await expect(showcase.locator(".showcase-error")).toHaveCount(0);
  const projection = await page.evaluate(async () => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const workspace = await desktop.workspace.getCurrent();
    const story = workspace?.resources.find((resource) => resource.type === "story" && resource.objectKind === "story");
    if (!story) throw new Error("SHOWCASE_STORY_PROJECTION_MISSING");
    const result = await desktop.showcase.get({ storyResourceId: story.id });
    if (!result.ok) throw new Error("SHOWCASE_PROJECTION_UNAVAILABLE");
    return {
      readyWorldMapCount: result.showcase.images.filter((image) => image.purpose === "world_map" && image.status === "ready").length,
      proseDocumentCount: result.showcase.proseDocuments.length,
      characterCardCount: result.showcase.characters.length,
      graphNodeCount: result.showcase.graph.nodes.length,
      failureBannerVisible: document.querySelector(".creative-showcase .showcase-error") !== null,
    };
  });
  expect(projection.readyWorldMapCount).toBe(1);
  expect(projection.proseDocumentCount).toBeGreaterThan(0);
  expect(projection.characterCardCount).toBeGreaterThanOrEqual(2);
  expect(projection.graphNodeCount).toBeGreaterThan(0);
  expect(projection.failureBannerVisible).toBe(false);
  return projection;
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
  expect(growthEvents.every((event) => event.strategy === "grow_world_story_oc_dynamic_v2")).toBe(true);
  expect(agentEvents.filter((event) => event.type === "run.completed").length).toBeGreaterThanOrEqual(3);
  const worldRunId = snapshot.cycles[0]!.runId!;
  const mapActivities = agentEvents.filter((event): event is Extract<AgentRunEvent, { type: "run.activity" }> => event.runId === worldRunId && event.type === "run.activity")
    .map((event) => `${event.label}:${event.phase}`);
  const queued = mapActivities.indexOf("世界地图排队中:started");
  const generating = mapActivities.indexOf("生成世界地图:started", queued + 1);
  const ready = mapActivities.indexOf("世界地图已生成:completed", generating + 1);
  expect(queued).toBeGreaterThanOrEqual(0);
  expect(generating).toBeGreaterThan(queued);
  expect(ready).toBeGreaterThan(generating);
  for (const cycle of snapshot.cycles.slice(1)) {
    const labels = agentEvents.filter((event): event is Extract<AgentRunEvent, { type: "run.activity" }> => event.runId === cycle.runId && event.type === "run.activity").map((event) => event.label);
    for (const forbiddenLabel of ["世界地图排队中", "生成世界地图", "世界地图已生成"]) {
      expect(labels.includes(forbiddenLabel)).toBe(false);
    }
  }
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
  imageJobCount: number;
  imageAssetCount: number;
  worldMap: { jobId: string; assetId: string; providerId: string; modelId: string; sourceResourceCount: number; sourceVersionCount: number; mimeType: string; width: number; height: number; byteLength: number; sha256: string };
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
    const settingDocuments = new CreativeDocumentRepository(workspace).listCurrent(world!.id).filter((document) => document.kind === "setting");
    expect(settingDocuments).toHaveLength(1);
    const worldDocument = documents.getCurrentStableForCreativeDocument(settingDocuments[0]!.id);
    expect(worldDocument).not.toBeNull();
    const storyDocument = requiredStable(documents, story!);
    const ocDocuments = ocs.map((oc) => requiredStable(documents, oc));
    expect(worldDocument!.content.trim().length).toBeGreaterThanOrEqual(200);
    expect(storyDocument.content.trim().length).toBeGreaterThanOrEqual(300);
    expect(ocDocuments.every((document) => document.content.trim().length >= 100)).toBe(true);
    expect([worldDocument!, storyDocument, ...ocDocuments].reduce((total, document) => total + document.content.trim().length, 0)).toBeGreaterThanOrEqual(1_000);

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
      assertGrowthRunAudit(new AgentAuditRepository(workspace), cycle.runId!, cycle.sequence);
    }
    const checkpointCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM checkpoints").get()?.count ?? 0);
    const changeSetCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()?.count ?? 0);
    const imageJobCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()?.count ?? 0);
    const imageAssetCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_assets").get()?.count ?? 0);
    expect(imageJobCount).toBe(1);
    expect(imageAssetCount).toBe(1);
    const worldMap = new ImageAssetRepository(workspace).listShowcaseJobs().filter((job) => job.purpose === "world_map" && job.status === "succeeded");
    expect(worldMap).toHaveLength(1);
    const worldMapJob = worldMap[0]!;
    expect(worldMapJob.asset).not.toBeNull();
    expect(worldMapJob.sourceResourceIds).toEqual([world!.id]);
    expect(worldMapJob.sourceVersionIds).toHaveLength(2);
    expect(new Set(worldMapJob.sourceVersionIds).size).toBe(2);
    const authoritativeJob = new ImageAssetRepository(workspace).getRequiredJob(worldMapJob.jobId);
    expect(authoritativeJob).toMatchObject({ status: "succeeded", providerId: "openai-compatible-image", modelId: "gpt-image-2", purpose: "world_map" });
    const worldOutputs = new Set(changeSets.listOutputs(cycles[0]!.changeSetId!).map((output) => output.outputId));
    expect(worldMapJob.sourceVersionIds.every((versionId) => worldOutputs.has(versionId))).toBe(true);
    const resourceVersions = new ResourceRepository(workspace);
    expect(worldMapJob.sourceVersionIds.some((versionId) => resourceVersions.getVisibleByRevisionIdAtCheckpoint(versionId, cycles[0]!.outputCheckpointId!)?.id === world!.id)).toBe(true);
    expect(worldMapJob.sourceVersionIds).toContain(worldDocument!.id);
    const asset = worldMapJob.asset!;
    const bytes = new ImageAssetStore(workspacePath).readVerified(asset.relativePath, asset.sha256);
    expect(bytes.byteLength).toBe(asset.byteLength);
    expect(asset.byteLength).toBeGreaterThan(0);
    expect(asset.mimeType).toBe("image/png");
    expect(asset.width).toBeGreaterThan(0);
    expect(asset.height).toBeGreaterThan(0);
    return {
      goalId,
      cycles: cycles.map((cycle) => ({ id: cycle.id, sequence: cycle.sequence, runId: cycle.runId, status: cycle.status })),
      world: world!, story: story!, ocs, distinctive: distinctive!,
      counts: { resources: formal.length, documents: 2 + ocDocuments.length, assertions: sourced.length, relations: relations.length },
      changeSetCount,
      checkpointCount,
      imageJobCount,
      imageAssetCount,
      worldMap: { jobId: worldMapJob.jobId, assetId: asset.id, providerId: authoritativeJob.providerId, modelId: authoritativeJob.modelId, sourceResourceCount: worldMapJob.sourceResourceIds.length, sourceVersionCount: worldMapJob.sourceVersionIds.length, mimeType: asset.mimeType, width: asset.width, height: asset.height, byteLength: asset.byteLength, sha256: asset.sha256 },
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

function assertGrowthRunAudit(audit: AgentAuditRepository, runId: string, sequence: number): void {
  const tools = audit.listTools(runId);
  const toolNames = tools.map((row) => String(row.tool_name));
  expect(toolNames.filter((name) => name === "retrieve_graph_evidence")).toHaveLength(1);
  expect(toolNames.filter((name) => name === "propose_change_set")).toHaveLength(1);
  expect(toolNames.filter((name) => name === "generate_image")).toHaveLength(sequence === 1 ? 1 : 0);
  const events = audit.listEvents(runId);
  for (const name of sequence === 1 ? ["retrieve_graph_evidence", "propose_change_set", "generate_image"] : ["retrieve_graph_evidence", "propose_change_set"]) {
    const invocationIds = new Set(tools.filter((row) => row.tool_name === name).map((row) => String(row.id)));
    expect(events.some((event) => invocationIds.has(String(event.tool_invocation_id)) && event.event_type === "succeeded")).toBe(true);
  }
}

async function assertShowcaseWorldMap(page: Page, persisted: PersistedGrowth): Promise<void> {
  const image = await page.evaluate(async ({ storyResourceId, jobId, assetId }) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const result = await desktop.showcase.get({ storyResourceId });
    if (!result.ok) throw new Error("SHOWCASE_WORLD_MAP_UNAVAILABLE");
    const match = result.showcase.images.find((candidate) => candidate.jobId === jobId && candidate.assetId === assetId);
    if (!match) throw new Error("SHOWCASE_WORLD_MAP_MISSING");
    return {
      jobId: match.jobId,
      assetId: match.assetId,
      purpose: match.purpose,
      status: match.status,
      sourceResourceIds: match.sourceResourceIds,
      sourceVersionIds: match.sourceVersionIds,
      mimeType: match.mimeType,
      width: match.width,
      height: match.height,
      thumbnailUrl: match.thumbnailUrl,
    };
  }, { storyResourceId: persisted.story.id, jobId: persisted.worldMap.jobId, assetId: persisted.worldMap.assetId });
  expect(image).toMatchObject({ jobId: persisted.worldMap.jobId, assetId: persisted.worldMap.assetId, purpose: "world_map", status: "ready", mimeType: persisted.worldMap.mimeType });
  expect(image.sourceResourceIds).toContain(persisted.world.id);
  expect(image.sourceVersionIds).toHaveLength(2);
  expect(image.width).toBeGreaterThan(0);
  expect(image.height).toBeGreaterThan(0);
  expect(image.thumbnailUrl).toMatch(/^novax-asset:\/\/image\//);
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
    expect(Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()?.count ?? 0)).toBe(persisted.imageJobCount);
    expect(Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_assets").get()?.count ?? 0)).toBe(persisted.imageAssetCount);
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
  const excluded = new Set([PROVIDER_STORE_FILE_NAME, IMAGE_PROVIDER_STORE_FILE_NAME, "Local State"]);
  expect(containsCredentialMarker(workspacePath, excluded)).toBe(false);
  expect(containsCredentialMarker(userDataPath, excluded)).toBe(false);
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
    "GROWTH_CYCLE_WATCHDOG_TIMEOUT", "GROWTH_OVERALL_TIMEOUT", "GROWTH_AGENT_TERMINAL_PROJECTION_TIMEOUT", "GROWTH_GET_FAILED", "GROWTH_START_FAILED",
    "REAL_PROVIDER_LOCAL_STATE_MISSING", "REAL_PROVIDER_MODEL_ID_MISMATCH", "REAL_PROVIDER_CONFIG_UNAVAILABLE",
    "RESEARCH_RUN_TIMEOUT", "RESEARCH_TERMINAL_INVALID", "GROWTH_COORDINATOR_TERMINAL_NOT_COMPLETED", "AUTO_SHOWCASE_NOT_OBSERVED",
  ]);
  if (allowlisted.has(error.message)) return error.message;
  if (/^RESEARCH_TERMINAL_[A-Z0-9_]+$/.test(error.message)) return "AGENT_RUN_FAILED";
  return "GROWTH_LIVE_ACCEPTANCE_FAILED";
}
