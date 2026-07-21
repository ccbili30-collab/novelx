import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentAuditRepository } from "../../src/domain/audit/agentAuditRepository";
import { SafeDiagnosticRepository } from "../../src/domain/audit/safeDiagnosticRepository";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { GrowthRepository } from "../../src/domain/growth/growthRepository";
import {
  GrowthLongformProgressResolver,
  type GrowthLongformProgressBlockedReason,
} from "../../src/domain/growth/growthLongformProgress";
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
import { GROWTH_LONGFORM_MIN_CODE_POINTS } from "../../src/shared/growthLongformPolicy";
import { closeTestElectronApp } from "./support/electronCleanup";
import {
  projectSafeGrowthAgentEvent,
  shouldValidateCompletedGrowthShowcase,
  watchGrowthTerminal,
} from "./support/growthWatcher";
import { exportLatestGrowthWorldPackage } from "./support/growthWorldPackageExport";
import {
  projectGrowthClosureSafeEvaluation,
  type GrowthClosureSafeEvaluation,
} from "./support/growthClosureSafeEvidence";
import { verifyRealProviderProfilePreflight } from "./support/realProviderProfilePreflight";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const guidanceRule = "日式指轻小说叙事风格，不出现真实日本元素，世界仍为原创西幻。";
const lightNovelMarkerPattern = /轻小说/;
const originalFantasyMarkerPattern = /原创西幻|西幻|原创.*奇幻|奇幻.*原创/;
const forbiddenRealJapaneseMarkerPattern = /东京|京都|大阪|江户|德川|明治|日本国|幕府/;
const maximumAutomatedCreatorChoiceAnswers = 3;
const configuredProviderStorePath = process.env.NOVAX_REAL_E2E_PROVIDER_STORE?.trim()
  || (process.env.APPDATA ? path.join(process.env.APPDATA, "novelx-desktop", PROVIDER_STORE_FILE_NAME) : "");
const configuredImageProviderStorePath = process.env.NOVAX_REAL_E2E_IMAGE_PROVIDER_STORE?.trim()
  || (process.env.APPDATA ? path.join(process.env.APPDATA, "novelx-desktop", IMAGE_PROVIDER_STORE_FILE_NAME) : "");

test.skip(!configuredProviderStorePath || !configuredImageProviderStorePath || !fs.existsSync(configuredProviderStorePath) || !fs.existsSync(configuredImageProviderStorePath), "Machine-local encrypted gpt-5.6-luna and image Provider stores are required.");

test("runs real gpt-5.6-luna interactive Growth through Closure, Longform, illustrations, reopen and later retrieval", async () => {
  test.setTimeout(4_800_000);
  const providerPreflight = verifyRealProviderProfilePreflight({
    textStorePath: configuredProviderStorePath,
    imageStorePath: configuredImageProviderStorePath,
    expectedText: { providerId: "openai-compatible", modelId: "gpt-5.6-luna" },
    expectedImageProviderId: "openai-compatible-image",
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-real-interactive-growth-"));
  const userDataPath = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  const evidenceDirectory = path.join(process.cwd(), "notes", "evidence", "novax-desktop-growth");
  const latestPackageDirectory = path.join(process.cwd(), "artifacts", "latest-growth-world-package");
  let app: ElectronApplication | null = null;
  let exportGoalId: string | null = null;
  let providerStarted = false;
  let evidence: SafeEvidence = {
    schemaVersion: 3,
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
    if (provider.providerId !== providerPreflight.text.providerId || provider.modelId !== providerPreflight.text.modelId) {
      throw new Error("REAL_PROVIDER_MODEL_ID_MISMATCH");
    }
    const imageProvider = await imageProviderStatus(page);
    evidence.imageProvider = imageProvider;
    if (imageProvider.providerId !== providerPreflight.image.providerId
      || imageProvider.modelId !== providerPreflight.image.modelId) throw new Error("REAL_IMAGE_PROVIDER_MODEL_ID_MISMATCH");

    providerStarted = true;
    evidence.providerStarted = true;
    const first = await startGrowthAndWatch(page, 2_100_000, 420_000, (visual) => {
      evidence.visual = visual;
    });
    exportGoalId = first.goalId;
    evidence.guidance = first.guidance;
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
      throw new Error(first.termination);
    }
    evidence.preTermination = safePreTermination(first.snapshot, first.growthEvents, first.agentEvents);
    evidence.cycles = first.snapshot.cycles.map((cycle) => ({ sequence: cycle.sequence, status: cycle.status }));
    if (first.snapshot.coordinatorStatus !== "completed") throw new Error("GROWTH_COORDINATOR_TERMINAL_NOT_COMPLETED");
    assertPublicGrowth(first.snapshot, first.growthEvents, first.agentEvents);
    evidence.illustrations = (await waitForIllustrationClosureAndCreateExtra(page, first)).safe;
    evidence.visual = first.visual;
    evidence.guidance = {
      ...evidence.guidance!,
      showcaseStoryNodePresent: first.visual.showcase?.storyNodePresent,
      showcaseOcNodePresent: first.visual.showcase?.ocNodePresent,
      showcaseRelationsPresent: first.visual.showcase?.relationPresent,
    };

    await closeTestElectronApp(app);
    app = null;
    const persisted = inspectCommittedGrowth(workspacePath, first.goalId);
    evidence.cycles = persisted.cycles;
    evidence.counts = persisted.counts;
    evidence.worldMap = persisted.worldMap.safe;
    evidence.closure = persisted.closure.safe;
    evidence.longform = persisted.longform.safe;
    evidence.illustrations = persisted.illustrations.safe;
    evidence.guidance = { ...evidence.guidance!, ...persisted.guidance };

    app = await launch(userDataPath, workspacePath);
    const researchPage = await app.firstWindow();
    await assertShowcaseWorldMap(researchPage, persisted);
    evidence.guidance = { ...evidence.guidance!, ...await assertReopenedGuidanceContent(researchPage, persisted) };
    const research = await runResearchOnly(researchPage, persisted);
    await closeTestElectronApp(app);
    app = null;

    evidence.guidance = { ...evidence.guidance!, ...inspectReopenedGuidanceRepository(workspacePath, persisted) };
    inspectResearchAudit(workspacePath, persisted, research.runId);
    evidence.research = { ...research.safe, ruleRevisionUnchanged: true, mutationCountsUnchanged: true };
    assertNoPlaintextCredentialSurface(workspacePath, userDataPath, first.growthEvents, first.agentEvents);
    evidence.leakScan = "passed";
    evidence.outcome = "completed";
  } catch (error) {
    if (error instanceof AutoShowcaseDiagnosticError) {
      evidence.cycles = error.safe.snapshot.cycles.map((cycle) => ({ sequence: cycle.sequence, status: cycle.status }));
      evidence.preTermination = safePreTermination(error.safe.snapshot, error.safe.growthEvents, error.safe.agentEvents);
      evidence.visual = error.safe.visual;
      evidence.guidance = error.safe.guidance;
    }
    evidence.outcome = providerStarted ? "failed_after_provider_start" : "blocked_before_provider_start";
    evidence.failureCode = safeFailureCode(error);
    if (app) {
      await closeTestElectronApp(app);
      app = null;
    }
    if (providerStarted) {
      evidence.postTermination ??= captureSqliteEvidence(workspacePath);
      assertNoPlaintextCredentialSurface(workspacePath, userDataPath, [], []);
      evidence.leakScan = "passed";
      writeEvidence(evidenceDirectory, evidence);
    }
    throw error;
  } finally {
    if (app) await closeTestElectronApp(app);
    if (evidence.outcome === "completed") writeEvidence(evidenceDirectory, evidence);
    if (providerStarted) {
      exportLatestGrowthWorldPackage({
        workspacePath,
        outputDirectory: latestPackageDirectory,
        failedImagePlaceholderPath: path.join(process.cwd(), "src", "renderer", "src", "assets", "image-generation-failed.jpg"),
        outcome: evidence.outcome === "completed" ? "completed" : "incomplete",
        goalId: exportGoalId,
        provider: evidence.provider,
        imageProvider: evidence.imageProvider,
      });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface SafeEvidence {
  schemaVersion: 3;
  provider: { providerId: string | null; modelId: string | null };
  imageProvider: { providerId: string | null; modelId: string | null };
  providerStarted: boolean;
  outcome: "not_started" | "blocked_before_provider_start" | "failed_after_provider_start" | "completed";
  failureCode?: string;
  cycles: Array<{ sequence: number; status: string; ruleRevision?: number; intentKind?: string; hasRun?: boolean; hasReceipt?: boolean; hasChangeSet?: boolean; hasOutputCheckpoint?: boolean }>;
  research: { retrieveSucceeded: boolean; noMutationTools: boolean; ruleRevisionUnchanged: boolean; mutationCountsUnchanged: boolean } | null;
  counts: { resources: number; documents: number; assertions: number; relations: number } | null;
  worldMap?: { providerId: string; modelId: string; sourceResourceCount: number; sourceVersionCount: number; mimeType: string; width: number; height: number; byteLength: number; sha256: string };
  closure?: { profileCount: number; evaluatedCycleCount: number; repairCycleCount: number; finalDecision: "accepted" };
  longform?: { focusOcPresent: boolean; sectionCount: number; totalCodePoints: number; complete: boolean };
  illustrations?: { defaultRequestCount: number; defaultReadyCount: number; customRequestCount: number; customReadyCount: number };
  leakScan: "not_run" | "passed";
  preTermination?: SafePreTermination;
  termination?: SafeTermination;
  postTermination?: SafeSqliteEvidence;
  initialGreenfield?: SafeInitialGreenfieldEligibility;
  visual?: SafeVisualEvidence;
  guidance?: SafeGuidanceEvidence;
}

interface SafeGuidanceEvidence {
  formEnabledOnCycle1?: boolean;
  preSaveAcknowledgementAbsent?: boolean;
  persistedRevision?: number;
  currentCycleRevisionAtSave?: number;
  nextCycleSequence?: number;
  nextCycleRevisionBoundary?: boolean;
  pendingBoundaryVisible?: boolean;
  notShownAsAppliedBeforeBoundary?: boolean;
  screenshotSha256?: string;
  revisionNumbers?: number[];
  cycleRuleRevisions?: number[];
  revision2PersistedNoLaterThanCycle2?: boolean;
  revisionCycleCommitted?: boolean;
  worldReflectsRule?: boolean;
  storyReflectsRule?: boolean;
  characterProfileReflectsRule?: boolean;
  noRealJapaneseElements?: boolean;
  showcaseStoryNodePresent?: boolean;
  showcaseOcNodePresent?: boolean;
  showcaseRelationsPresent?: boolean;
  reopenedRevision2Present?: boolean;
  reopenedStoryRulePresent?: boolean;
  reopenedCharacterRulePresent?: boolean;
  creatorChoiceAnswered?: boolean;
  creatorChoiceAnswerCount?: number;
  creatorAnswerRevision?: number;
  creatorAnswerSuccessorSequence?: number;
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
    graphEdgeCount: number;
    storyNodePresent: boolean;
    ocNodePresent: boolean;
    relationPresent: boolean;
    failureBannerVisible: boolean;
  };
  screenshots: {
    agentStage?: SafeScreenshotEvidence;
    showcase?: SafeScreenshotEvidence;
  };
}

interface SafeScreenshotEvidence {
  sha256: string;
}

function hasAppliedLightNovelFantasyRule(content: string): boolean {
  return lightNovelMarkerPattern.test(content)
    && originalFantasyMarkerPattern.test(content)
    && !forbiddenRealJapaneseMarkerPattern.test(content);
}

class AutoShowcaseDiagnosticError extends Error {
  constructor(readonly safe: {
    goalId: string;
    snapshot: Awaited<ReturnType<DesktopApi["growth"]["get"]>>;
    growthEvents: GrowthLiveEvent[];
    agentEvents: AgentRunEvent[];
    elapsedMs: number;
    visual: SafeVisualEvidence;
    guidance: SafeGuidanceEvidence;
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
  cycles: Array<{ sequence: number; status: string; hasRun: boolean }>;
  growthEvents: Array<{ sequence: number; phase: string; durableState: string }>;
  agentEvents: Array<{ type: string; phase?: string; code?: string; outcome?: string; changeSetState?: string; escalationCodes?: string[] }>;
}

interface SafeTermination {
  attemptedRunPresent: boolean;
  cancelRequested: boolean;
  terminalObserved: boolean;
  snapshotStatus: string | null;
}

interface SafeSqliteEvidence {
  cycles: Array<{
    sequence: number;
    status: string;
    ruleRevision: number;
    failureCode: string | null;
    hasRun: boolean;
    hasReceipt: boolean;
    hasChangeSet: boolean;
    hasInputCheckpoint: boolean;
    hasOutputCheckpoint: boolean;
    receiptLinkCount: number | null;
    audit: null | {
      terminalCount: number;
      terminalErrorCodes: string[];
      toolOutcomes: Array<{ toolName: string; status: string }>;
      retrieveSucceeded: boolean;
      proposeSucceeded: boolean;
      imageSucceeded: boolean;
      requestedProviderId: string | null;
      requestedModelId: string | null;
      actualProviderIds: string[];
      actualModelIds: string[];
    };
  }>;
  diagnostics: Array<{
    cycleSequence: number;
    operationKind: string;
    owner: string;
    boundary: string;
    code: string;
    toolName: string | null;
    attempt: number | null;
    maxAttempts: number | null;
    sideEffectState: string;
    disposition: string;
    retryability: string;
  }>;
  counts: { resources: number; documents: number; assertions: number; relations: number };
  changeSets: {
    total: number;
    byStatus: Array<{ status: string; count: number }>;
    outputCount: number;
    checkpointCount: number;
    checkpointDeltaFromInitial: number;
  };
  closure: {
    profileCount: number;
    decisions: string[];
    evaluations: GrowthClosureSafeEvaluation[];
  };
  longform: {
    status: "unavailable" | "blocked" | "ready";
    reason: GrowthLongformProgressBlockedReason | null;
    complete: boolean;
    totalCodePoints: number;
    sectionCount: number;
  };
  illustrations: {
    requests: Array<{ coverageMode: string; status: string; itemCount: number; readyCount: number }>;
    itemStatuses: Array<{ status: string; count: number }>;
    jobs: Array<{ purpose: string; status: string; requestSent: boolean; errorCode: string | null }>;
    imageJobCount: number;
    imageAssetCount: number;
  };
}

const SAFE_IMAGE_JOB_ERROR_CODES = new Set([
  "IMAGE_PROVIDER_CONNECTION_FAILED",
  "IMAGE_PROVIDER_GENERATION_FAILED",
  "IMAGE_PROVIDER_PROTOCOL_FAILED",
  "IMAGE_PROVIDER_RUNTIME_FAILED",
  "IMAGE_PROVIDER_OUTCOME_UNKNOWN",
  "IMAGE_ASSET_COMMIT_FAILED",
  "IMAGE_JOB_CANCELLED",
]);

function safeImageJobErrorCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_IMAGE_JOB_ERROR_CODES.has(value)
    ? value
    : value === null || value === undefined
      ? null
      : "IMAGE_JOB_ERROR_OTHER";
}

function safeImageJobPurpose(value: unknown): string {
  return value === "world_map" || value === "character_portrait" || value === "scene" ? value : "unknown";
}

function safeImageJobStatus(value: unknown): string {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "reconciliation_required"
    ? value
    : "unknown";
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
  guidance: SafeGuidanceEvidence;
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

  const seed = "在横跨古老大陆的群山、林海、草原与内海之间，多个原创王国、游牧联盟、矿城邦与古老族群因魔法衰退、贸易通道和失落王权相互塑造；请构建具有深层历史、国家演化和跨系统因果链的原创史诗高魔世界。";
  const growthMode = page.getByRole("radio", { name: "生长", exact: true });
  try {
    await growthMode.click({ timeout: 8_000 });
    await expect(growthMode).toHaveAttribute("aria-checked", "true");
    const composer = page.getByLabel("给世界总编发送消息");
    await expect(composer).toBeEnabled({ timeout: 8_000 });
    await composer.fill(seed);
    const send = page.getByTitle("发送");
    await expect(send).toBeEnabled({ timeout: 8_000 });
    await send.click({ timeout: 8_000 });
    const submittedSeed = page.locator(".steward-message--user").filter({ hasText: seed });
    await expect(submittedSeed).toHaveCount(1, { timeout: 8_000 });
    await expect(submittedSeed).toBeVisible({ timeout: 8_000 });
    const operationalActivity = page.locator("details.growth-operational-activity");
    await expect(operationalActivity).toBeVisible({ timeout: 8_000 });
    await page.getByText("大管家运行活动", { exact: true }).click();
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
  const guidance = await saveGuidanceDuringCycleOne(page, started);
  let creatorChoiceAnswerCount = 0;

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
    resumeAtBoundary: async (snapshot, events) => {
      if (creatorChoiceAnswerCount >= maximumAutomatedCreatorChoiceAnswers || snapshot.coordinatorStatus !== "blocked") return false;
      const current = snapshot.cycles.at(-1);
      if (!current || current.status !== "blocked") return false;
      const choice = [...events.growthEvents].reverse().find((item) => item.event.cycleId === current.id
        && item.event.phase === "creator_choice_required");
      if (!choice) return false;
      const terminalObserved = current.runId === null || events.agentEvents.some((event) => event.runId === current.runId
        && (event.type === "run.completed" || event.type === "run.failed"));
      if (!terminalObserved) return false;
      const answered = await answerCreatorChoiceViaUi(page, started, snapshot.currentRuleRevision ?? 1);
      creatorChoiceAnswerCount += 1;
      guidance.creatorChoiceAnswered = true;
      guidance.creatorChoiceAnswerCount = creatorChoiceAnswerCount;
      guidance.creatorAnswerRevision = answered.persistedRevision;
      guidance.creatorAnswerSuccessorSequence = answered.successorSequence;
      return true;
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
  if (!watched.termination && shouldValidateCompletedGrowthShowcase(watched.snapshot)) {
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
        guidance,
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
    guidance,
    ...(watched.termination ? { termination: watched.termination, preTermination: safePreTermination(watched.snapshot, growthEvents, agentEvents) } : {}),
  };
}

async function answerCreatorChoiceViaUi(
  page: Page,
  started: { projectId: string; sessionId: string; goalId: string },
  expectedRevision: number,
): Promise<{ persistedRevision: number; successorSequence: number }> {
  const decision = "保留既有正典与已经提交的因果；采用最小改动原则解决当前取舍，并只修改确实受影响的世界、故事或角色节点。后续未知若不涉及正典破坏，必须记录明确的临时假设并自主推进，不再要求创作者选择。";
  const editor = page.getByRole("textbox", { name: "追加世界规则或指导" });
  const save = page.getByRole("button", { name: "保存规则修订" });
  await expect(editor).toBeEnabled({ timeout: 15_000 });
  await editor.fill(decision);
  await expect(save).toBeEnabled({ timeout: 5_000 });
  await save.click();
  await expect(page.getByText(new RegExp(`已保存为规则修订 #${expectedRevision + 1}`))).toBeVisible({ timeout: 30_000 });
  const snapshot = await page.evaluate(async (input) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    return desktop.growth.get(input);
  }, started);
  if (snapshot.currentRuleRevision !== expectedRevision + 1 || snapshot.coordinatorStatus !== "running") {
    throw new Error("GROWTH_CREATOR_CHOICE_RESUME_INVALID");
  }
  return { persistedRevision: snapshot.currentRuleRevision, successorSequence: snapshot.goal.currentCycleSequence };
}

async function saveGuidanceDuringCycleOne(
  page: Page,
  started: { projectId: string; sessionId: string; goalId: string },
): Promise<SafeGuidanceEvidence> {
  const deadline = Date.now() + 30_000;
  let active = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async (input) => {
      const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
      const snapshot = await desktop.growth.get(input);
      return {
        coordinatorStatus: snapshot.coordinatorStatus,
        currentRuleRevision: snapshot.currentRuleRevision,
        activeCycleRuleRevision: snapshot.activeCycleRuleRevision,
        cycles: snapshot.cycles.map((cycle) => ({ sequence: cycle.sequence, status: cycle.status })),
      };
    }, started);
    const first = state.cycles[0];
    if (state.cycles.some((cycle) => cycle.sequence > 1) || first?.status === "committed" || state.coordinatorStatus !== "running") {
      throw new Error("GROWTH_GUIDANCE_CYCLE_ONE_WINDOW_MISSED");
    }
    if (first?.sequence === 1 && first.status === "running"
      && state.currentRuleRevision === 1 && state.activeCycleRuleRevision === 1) {
      active = true;
      break;
    }
    await page.waitForTimeout(100);
  }
  if (!active) throw new Error("GROWTH_GUIDANCE_CYCLE_ONE_WINDOW_MISSED");

  const editor = page.getByRole("textbox", { name: "追加世界规则或指导" });
  const save = page.getByRole("button", { name: "保存规则修订" });
  try {
    await expect(editor).toBeEnabled({ timeout: 8_000 });
    await expect(page.getByText(/已保存为规则修订/)).toHaveCount(0);
    await editor.fill(guidanceRule);
    await expect(save).toBeEnabled();
    await save.click();
  } catch (cause) {
    throw Object.assign(new Error("GROWTH_GUIDANCE_CYCLE_ONE_WINDOW_MISSED"), { cause });
  }

  const acknowledgement = page.getByText(/已保存为规则修订 #2，等待安全修订轮；第 2 轮仅为候选边界，不承诺一定执行。预计范围：/);
  const acknowledgementDeadline = Date.now() + 15_000;
  while (Date.now() < acknowledgementDeadline && await acknowledgement.count() === 0) {
    if (await page.getByRole("alert").count() > 0) throw new Error("GROWTH_GUIDANCE_REVISION_CONFLICT");
    await page.waitForTimeout(100);
  }
  if (await acknowledgement.count() !== 1) throw new Error("GROWTH_GUIDANCE_ACK_TIMEOUT");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".growth-guidance-card")).toContainText("规则修订 #2");
  await expect(page.locator(".growth-guidance-card")).toContainText("已保存，等待安全修订轮");
  await expect(page.locator(".growth-guidance-card")).toContainText("候选边界为第 2 轮");
  const revisions = page.getByLabel("Growth 规则修订");
  await expect(revisions).toContainText("当前轮使用 #1");
  await expect(revisions).toContainText("最新已保存 #2");
  await expect(revisions).toContainText("已保存，等待安全修订轮 · 候选第 2 轮");
  await expect(revisions).not.toContainText("当前无待生效规则");

  const boundary = await page.evaluate(async (input) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const snapshot = await desktop.growth.get(input);
    return {
      persistedRevision: snapshot.currentRuleRevision,
      currentCycleRevision: snapshot.activeCycleRuleRevision,
      guidanceStatus: snapshot.guidanceStatus,
      currentSequence: snapshot.cycles.at(-1)?.sequence ?? null,
      currentStatus: snapshot.cycles.at(-1)?.status ?? null,
    };
  }, started);
  if (boundary.persistedRevision !== 2 || boundary.currentCycleRevision !== 1
    || boundary.guidanceStatus !== "persisted_pending_boundary" || boundary.currentSequence !== 1
    || boundary.currentStatus !== "running") {
    throw new Error("GROWTH_GUIDANCE_BOUNDARY_STATE_INVALID");
  }
  const screenshot = await captureVisualScreenshot(page, "test-results/real-growth-live-guidance-pending.png");
  return {
    formEnabledOnCycle1: true,
    preSaveAcknowledgementAbsent: true,
    persistedRevision: 2,
    currentCycleRevisionAtSave: 1,
    nextCycleSequence: 2,
    nextCycleRevisionBoundary: true,
    pendingBoundaryVisible: true,
    notShownAsAppliedBeforeBoundary: true,
    screenshotSha256: screenshot.sha256,
  };
}

async function waitForIllustrationClosureAndCreateExtra(
  page: Page,
  started: { projectId: string; sessionId: string; goalId: string },
): Promise<{ safe: NonNullable<SafeEvidence["illustrations"]> }> {
  const inspect = () => page.evaluate(async (input) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    return desktop.growth.inspect(input);
  }, started);
  const defaultDeadline = Date.now() + 1_800_000;
  let presentation = await inspect();
  while (Date.now() < defaultDeadline) {
    const defaults = presentation.illustrationRequests.filter((request) => request.coverageMode === "default");
    if (defaults.some((request) => ["failed", "cancelled", "stale", "reconciliation_required"].includes(request.status))) {
      throw new Error("DEFAULT_ILLUSTRATIONS_TERMINAL_FAILURE");
    }
    if (defaults.length === 1 && defaults[0]!.status === "completed"
      && defaults[0]!.itemCount > 0 && defaults[0]!.readyCount === defaults[0]!.itemCount
      && defaults[0]!.items.every((item) => item.status === "ready" && item.imageJobId && item.assetId && item.thumbnailUrl)) {
      break;
    }
    await page.waitForTimeout(1_000);
    presentation = await inspect();
  }
  const defaults = presentation.illustrationRequests.filter((request) => request.coverageMode === "default");
  if (defaults.length !== 1 || defaults[0]!.status !== "completed"
    || defaults[0]!.itemCount === 0 || defaults[0]!.readyCount !== defaults[0]!.itemCount) {
    throw new Error("DEFAULT_ILLUSTRATIONS_TIMEOUT");
  }
  const acceptedClosures = presentation.closures.filter((closure) => (
    closure.contentState === "closed" && closure.visualState === "ready" && closure.checkerDecision === "accepted"
  ));
  expect(acceptedClosures.length).toBeGreaterThanOrEqual(1);
  expect(presentation.longform).toMatchObject({ status: "ready", complete: true });
  if (presentation.longform.status !== "ready" || !presentation.longform.complete
    || presentation.longform.totalCodePoints < GROWTH_LONGFORM_MIN_CODE_POINTS) {
    throw new Error("GROWTH_LONGFORM_INCOMPLETE");
  }

  const requestId = `growth-live-graph-${randomUUID()}`;
  await page.evaluate(async ({ input, illustrationRequestId }) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const graph = await desktop.graph.getSnapshot();
    if (!graph.ok || graph.graph.nodes.length === 0) throw new Error("GROWTH_GRAPH_NODE_MISSING");
    const node = graph.graph.nodes.find((candidate) => candidate.status === "current") ?? graph.graph.nodes[0]!;
    await desktop.growth.illustrate({
      ...input,
      requestId: illustrationRequestId,
      target: { kind: "graph_node", nodeId: node.id },
      purpose: "scene",
      title: "图谱节点补充插图",
      compositionDescription: "仅依据该已提交图谱节点及其来源，绘制一张能帮助理解世界关系的漫画感手绘场景图。",
      variantCount: 1,
    });
  }, { input: started, illustrationRequestId: requestId });

  const customDeadline = Date.now() + 600_000;
  presentation = await inspect();
  while (Date.now() < customDeadline) {
    const request = presentation.illustrationRequests.find((candidate) => candidate.id === requestId);
    if (request && ["failed", "cancelled", "stale", "reconciliation_required"].includes(request.status)) {
      throw new Error("EXTRA_ILLUSTRATION_TERMINAL_FAILURE");
    }
    if (request?.status === "completed" && request.itemCount === 1 && request.readyCount === 1
      && request.items[0]?.status === "ready" && request.items[0].assetId && request.items[0].imageJobId) {
      const customRequests = presentation.illustrationRequests.filter((candidate) => candidate.coverageMode === "custom");
      const readyCount = defaults[0]!.readyCount + customRequests.reduce((total, candidate) => total + candidate.readyCount, 0);
      await page.getByRole("radio", { name: "Agent 模式" }).click();
      const gallery = page.getByRole("region", { name: "图文图鉴" });
      await expect(gallery).toBeVisible({ timeout: 30_000 });
      await expect(gallery.locator(".growth-illustration-gallery__items article[data-status='ready']"))
        .toHaveCount(readyCount, { timeout: 30_000 });
      const impact = page.locator(".growth-impact-summary");
      await expect(impact).toBeVisible({ timeout: 30_000 });
      await impact.locator("summary").click();
      await expect(impact).toContainText("Checker 已接受，复检通过");
      await expect(impact).toContainText(/1\d{4,} 字符/);
      return {
        safe: {
          defaultRequestCount: defaults.length,
          defaultReadyCount: defaults[0]!.readyCount,
          customRequestCount: customRequests.length,
          customReadyCount: customRequests.reduce((total, candidate) => total + candidate.readyCount, 0),
        },
      };
    }
    await page.waitForTimeout(1_000);
    presentation = await inspect();
  }
  throw new Error("EXTRA_ILLUSTRATION_TIMEOUT");
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
      graphEdgeCount: result.showcase.graph.edges.length,
      storyNodePresent: result.showcase.graph.nodes.some((node) => node.scope.id === story.id),
      ocNodePresent: result.showcase.characters.some((character) => (
        result.showcase.graph.nodes.some((node) => node.scope.id === character.id)
      )),
      relationPresent: result.showcase.graph.edges.some((edge) => {
        const nodes = new Map(result.showcase.graph.nodes.map((node) => [node.id, node]));
        const source = nodes.get(edge.sourceNodeId);
        const target = nodes.get(edge.targetNodeId);
        const characterIds = new Set(result.showcase.characters.map((character) => character.id));
        return Boolean(source && target && (
          source.scope.id === story.id || target.scope.id === story.id
          || characterIds.has(source.scope.id) || characterIds.has(target.scope.id)
        ));
      }),
      failureBannerVisible: document.querySelector(".creative-showcase .showcase-error") !== null,
    };
  });
  expect(projection.readyWorldMapCount).toBe(1);
  expect(projection.proseDocumentCount).toBeGreaterThan(0);
  expect(projection.characterCardCount).toBeGreaterThanOrEqual(2);
  expect(projection.graphNodeCount).toBeGreaterThan(0);
  expect(projection.graphEdgeCount).toBeGreaterThan(0);
  expect(projection.storyNodePresent).toBe(true);
  expect(projection.ocNodePresent).toBe(true);
  expect(projection.relationPresent).toBe(true);
  expect(projection.failureBannerVisible).toBe(false);
  return projection;
}

function safePreTermination(
  snapshot: Awaited<ReturnType<DesktopApi["growth"]["get"]>>,
  growthEvents: GrowthLiveEvent[],
  agentEvents: AgentRunEvent[],
): SafePreTermination {
  return {
    cycles: snapshot.cycles.map((cycle) => ({ sequence: cycle.sequence, status: cycle.status, hasRun: cycle.runId !== null })),
    growthEvents: growthEvents.map(({ event }) => ({
      sequence: event.sequence, phase: event.phase, durableState: event.durableState,
    })),
    agentEvents: agentEvents.map(projectSafeGrowthAgentEvent),
  };
}

async function cancelBoundRunAndObserve(
  page: Page,
  watched: Awaited<ReturnType<typeof startGrowthAndWatch>>,
): Promise<SafeTermination> {
  const runId = watched.snapshot.cycles.find((cycle) => cycle.status === "running" && cycle.runId !== null)?.runId ?? null;
  if (!runId) return { attemptedRunPresent: false, cancelRequested: false, terminalObserved: false, snapshotStatus: watched.snapshot.coordinatorStatus };
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
        if (snapshot.coordinatorStatus !== "running") return { attemptedRunPresent: true, cancelRequested, terminalObserved: true, snapshotStatus };
      } catch { return { attemptedRunPresent: true, cancelRequested, terminalObserved: false, snapshotStatus }; }
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 500));
    }
    return { attemptedRunPresent: true, cancelRequested, terminalObserved: false, snapshotStatus };
  }, { projectId: watched.projectId, sessionId: watched.sessionId, goalId: watched.goalId, runId });
}

function assertPublicGrowth(
  snapshot: Awaited<ReturnType<DesktopApi["growth"]["get"]>>,
  growthEvents: GrowthLiveEvent[],
  agentEvents: AgentRunEvent[],
): void {
  expect(snapshot.coordinatorStatus).toBe("completed");
  expect(snapshot.cycles.length).toBeGreaterThanOrEqual(9);
  expect(snapshot.cycles.every((cycle) => ["committed", "evaluated"].includes(cycle.status) && cycle.runId !== null)).toBe(true);
  expect(snapshot.cycles.filter((cycle) => cycle.status === "committed").length).toBeGreaterThanOrEqual(7);
  expect(snapshot.cycles.filter((cycle) => cycle.status === "evaluated").length).toBeGreaterThanOrEqual(2);
  expect(new Set(snapshot.cycles.map((cycle) => cycle.runId)).size).toBe(snapshot.cycles.length);
  const persisted = snapshot.events;
  expect(persisted.length).toBeGreaterThanOrEqual(snapshot.cycles.length * 4);
  expect(persisted.every((event, index) => index === 0 || event.sequence > persisted[index - 1]!.sequence)).toBe(true);
  for (const cycle of snapshot.cycles) {
    const events = persisted.filter((event) => event.cycleId === cycle.id);
    if (cycle.status === "committed") {
      const committedIndex = events.findIndex((event) => event.phase === "change_set_committed");
      expect(committedIndex).toBeGreaterThanOrEqual(0);
      expect(events.slice(0, committedIndex).some((event) => event.durableState === "committed")).toBe(false);
      expect(events.filter((event) => event.phase === "change_set_committed")).toHaveLength(1);
    } else {
      expect(events.filter((event) => event.phase === "cycle_evaluated")).toHaveLength(1);
      expect(events.some((event) => event.phase === "change_set_committed")).toBe(false);
    }
  }
  expect(growthEvents.every((event) => event.strategy === "grow_world_story_oc_closure_v4")).toBe(true);
  const terminalRunIds = new Set(agentEvents
    .filter((event) => event.type === "run.completed" || event.type === "run.failed")
    .map((event) => event.runId));
  expect(snapshot.cycles.every((cycle) => terminalRunIds.has(cycle.runId!))).toBe(true);
  expect(agentEvents.filter((event) => event.type === "run.failed")).toHaveLength(0);
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
  cycles: Array<{ sequence: number; status: string; ruleRevision: number; intentKind: string; hasRun: boolean; hasReceipt: boolean; hasChangeSet: boolean; hasOutputCheckpoint: boolean }>;
  world: ResourceRecord;
  story: ResourceRecord;
  ocs: ResourceRecord[];
  distinctive: SourcedAssertionRecord;
  counts: { resources: number; documents: number; assertions: number; relations: number };
  changeSetCount: number;
  checkpointCount: number;
  imageJobCount: number;
  imageAssetCount: number;
  guidance: Required<Pick<SafeGuidanceEvidence,
    "revisionNumbers" | "cycleRuleRevisions" | "revision2PersistedNoLaterThanCycle2" | "revisionCycleCommitted"
    | "worldReflectsRule" | "storyReflectsRule" | "characterProfileReflectsRule" | "noRealJapaneseElements">>;
  closure: {
    safe: NonNullable<SafeEvidence["closure"]>;
    profileId: string;
    revision: number;
  };
  longform: {
    safe: NonNullable<SafeEvidence["longform"]>;
    personalStoryResourceId: string;
    sectionDocumentIds: string[];
  };
  illustrations: {
    safe: NonNullable<SafeEvidence["illustrations"]>;
    requestIds: string[];
    assetIds: string[];
  };
  worldMap: {
    jobId: string;
    assetId: string;
    safe: NonNullable<SafeEvidence["worldMap"]>;
  };
}

function inspectCommittedGrowth(workspacePath: string, goalId: string): PersistedGrowth {
  const workspace = openWorkspace(workspacePath);
  try {
    const growth = new GrowthRepository(workspace);
    const cycles = growth.listCycles(goalId);
    const intents = cycles.map((cycle) => growth.getCycleIntent(cycle.id));
    expect(cycles.length).toBeGreaterThanOrEqual(9);
    expect(cycles.every((cycle) => ["committed", "evaluated"].includes(cycle.status) && cycle.runId && cycle.receiptId)).toBe(true);
    expect(new Set(cycles.map((cycle) => cycle.runId)).size).toBe(cycles.length);
    expect(new Set(cycles.map((cycle) => cycle.receiptId)).size).toBe(cycles.length);
    const committedCycles = cycles.filter((cycle) => cycle.status === "committed");
    const evaluatedCycles = cycles.filter((cycle) => cycle.status === "evaluated");
    expect(committedCycles.length).toBeGreaterThanOrEqual(7);
    expect(evaluatedCycles.length).toBeGreaterThanOrEqual(2);
    expect(committedCycles.every((cycle) => cycle.changeSetId && cycle.outputCheckpointId)).toBe(true);
    expect(evaluatedCycles.every((cycle) => cycle.changeSetId === null && cycle.outputCheckpointId === null)).toBe(true);
    expect(new Set(committedCycles.map((cycle) => cycle.changeSetId)).size).toBe(committedCycles.length);
    let checkpointId = cycles[0]!.inputCheckpointId;
    for (const cycle of cycles) {
      expect(cycle.inputCheckpointId).toBe(checkpointId);
      if (cycle.status === "committed") checkpointId = cycle.outputCheckpointId!;
    }
    const rules = growth.listRuleRevisions(goalId, { limit: 100 });
    expect(rules.map((rule) => rule.revision)).toEqual([1, 2]);
    expect(rules[1]!.ruleText).toBe(guidanceRule);
    expect(cycles[0]!.ruleRevision).toBe(1);
    expect(cycles.slice(1).every((cycle) => cycle.ruleRevision === 2)).toBe(true);
    const receipts = cycles.map((cycle) => growth.getReceipt(cycle.receiptId!));
    expect(receipts.every((receipt, index) => receipt?.runId === cycles[index]!.runId && receipt.links.length >= 0)).toBe(true);

    const revisionIndexes = intents.flatMap((intent, index) => intent.kind === "revision" ? [index] : []);
    expect(revisionIndexes).toHaveLength(1);
    const revisionIndex = revisionIndexes[0]!;
    const revisionCycle = cycles[revisionIndex]!;
    const revisionIntent = intents[revisionIndex]!;
    expect(revisionCycle).toMatchObject({ status: "committed", ruleRevision: 2 });
    expect(Date.parse(rules[1]!.createdAt)).toBeLessThanOrEqual(Date.parse(revisionCycle.createdAt));
    if (revisionIntent.kind !== "revision") throw new Error("GROWTH_REVISION_INTENT_MISSING");
    expect(revisionIntent.focusKinds).toContain("world");

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
    const characterProfiles = ocs.flatMap((oc) => new CreativeDocumentRepository(workspace).listCurrent(oc.id)
      .filter((document) => document.kind === "character_profile")
      .map((document) => documents.getCurrentStableForCreativeDocument(document.id))
      .filter((document): document is DocumentVersionRecord => document !== null));
    expect(characterProfiles.length).toBeGreaterThanOrEqual(1);
    const currentCreativeVersions = formal.flatMap((resource) => new CreativeDocumentRepository(workspace).listCurrent(resource.id)
      .map((document) => documents.getCurrentStableForCreativeDocument(document.id))
      .filter((document): document is DocumentVersionRecord => document !== null));
    const currentDocuments = [...new Map([worldDocument!, storyDocument, ...ocDocuments, ...currentCreativeVersions]
      .map((document) => [document.id, document] as const)).values()];
    const combinedCurrentContent = currentDocuments.map((document) => document.content).join("\n");
    expect(lightNovelMarkerPattern.test(combinedCurrentContent)).toBe(true);
    expect(originalFantasyMarkerPattern.test(combinedCurrentContent)).toBe(true);
    expect(forbiddenRealJapaneseMarkerPattern.test(combinedCurrentContent)).toBe(false);

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
    const closureOutcomes = new Map(evaluatedCycles.map((cycle) => {
      const outcome = growth.getClosureEvaluationOutcomeForCycle(cycle.id);
      expect(outcome).not.toBeNull();
      return [cycle.id, outcome!] as const;
    }));
    for (const [index, cycle] of cycles.entries()) {
      const intent = intents[index]!;
      if (cycle.status === "committed") {
        const changeSet = changeSets.get(cycle.changeSetId!);
        expect(changeSet?.status).toBe("committed");
        expect(changeSets.listOutputs(cycle.changeSetId!).length).toBeGreaterThan(0);
      }
      assertGrowthRunAudit(
        new AgentAuditRepository(workspace), cycle.runId!, cycle.sequence, cycle.status, intent.kind,
        closureOutcomes.get(cycle.id)?.decision,
      );
    }
    const revisionOutputs = changeSets.listOutputs(revisionCycle.changeSetId!);
    const revisionDocumentOwners = new Set(revisionOutputs
      .filter((output) => output.kind === "document_version")
      .flatMap((output) => documents.getVersion(output.outputId)?.resourceId ?? []));
    const resourcesBeforeRevision = new Set(new ResourceRepository(workspace).listAtCheckpoint(revisionCycle.inputCheckpointId)
      .filter((resource) => resource.objectKind !== "domain_root").map((resource) => resource.id));
    const resourcesAfterRevision = new Set(new ResourceRepository(workspace).listAtCheckpoint(revisionCycle.outputCheckpointId!)
      .filter((resource) => resource.objectKind !== "domain_root").map((resource) => resource.id));
    expect([...resourcesBeforeRevision].every((resourceId) => resourcesAfterRevision.has(resourceId))).toBe(true);
    expect(revisionDocumentOwners.has(world!.id)).toBe(true);
    const postRevisionStoryCycle = cycles.find((cycle, index) => index > revisionIndex && cycle.status === "committed"
      && intents[index]?.kind === "expand" && intents[index].focusKinds.includes("story"));
    const postRevisionOcCycle = cycles.find((cycle, index) => index > revisionIndex && cycle.status === "committed"
      && intents[index]?.kind === "expand" && intents[index].focusKinds.includes("oc"));
    expect(postRevisionStoryCycle?.ruleRevision).toBe(2);
    expect(postRevisionOcCycle?.ruleRevision).toBe(2);
    expect(changeSets.listOutputs(postRevisionStoryCycle!.changeSetId!).some((output) => output.kind === "creative_relation_revision")).toBe(true);
    expect(changeSets.listOutputs(postRevisionOcCycle!.changeSetId!).some((output) => output.kind === "creative_relation_revision")).toBe(true);

    const closureStates = growth.listClosureStates(goalId);
    expect(closureStates).toHaveLength(1);
    const closureState = closureStates[0]!;
    expect(closureState).toMatchObject({ contentState: "closed", visualState: "ready", missingFacetIds: [] });
    const closureProfile = growth.getClosureProfile(closureState.profileId);
    expect(closureProfile?.contractGeneration).toBe("v26");
    if (!closureProfile || closureProfile.contractGeneration !== "v26" || !closureProfile.focusOcResourceId) {
      throw new Error("GROWTH_CLOSURE_FOCUS_OC_MISSING");
    }
    const orderedOutcomes = evaluatedCycles.map((cycle) => closureOutcomes.get(cycle.id)!);
    expect(orderedOutcomes.at(-1)?.decision).toBe("accepted");
    expect(orderedOutcomes.some((outcome) => outcome.decision === "continue_growing")).toBe(true);
    const repairCycleCount = intents.filter((intent) => intent.kind === "repair").length;
    if (orderedOutcomes.some((outcome) => outcome.decision === "repairs_required")) expect(repairCycleCount).toBeGreaterThan(0);

    const longform = new GrowthLongformProgressResolver(workspace).resolve({
      checkpointId,
      focusOcResourceId: closureProfile.focusOcResourceId,
    });
    expect(longform).toMatchObject({ status: "ready", complete: true });
    if (longform.status !== "ready") throw new Error("GROWTH_LONGFORM_PROGRESS_BLOCKED");
    expect(longform.totalCodePoints).toBeGreaterThanOrEqual(GROWTH_LONGFORM_MIN_CODE_POINTS);
    expect(longform.completedSections).toHaveLength(longform.outline.sections.length);
    expect(longform.nextSection).toBeNull();
    for (const section of longform.completedSections) {
      const version = documents.getVersion(section.documentVersionId);
      expect(version).toMatchObject({ id: section.documentVersionId, creativeDocumentId: section.documentId, contentHash: section.contentSha256, status: "stable" });
      expect(Array.from(version!.content).length).toBe(section.codePoints);
    }

    const checkpointCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM checkpoints").get()?.count ?? 0);
    const changeSetCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM change_sets").get()?.count ?? 0);
    const imageJobCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()?.count ?? 0);
    const imageAssetCount = Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_assets").get()?.count ?? 0);
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
    expect(worldMapJob.sourceVersionIds.some((versionId) => documents.getVersion(versionId)?.resourceId === world!.id)).toBe(true);
    const asset = worldMapJob.asset!;
    const bytes = new ImageAssetStore(workspacePath).readVerified(asset.relativePath, asset.sha256);
    expect(bytes.byteLength).toBe(asset.byteLength);
    expect(asset.byteLength).toBeGreaterThan(0);
    expect(asset.mimeType).toBe("image/png");
    expect(asset.width).toBeGreaterThan(0);
    expect(asset.height).toBeGreaterThan(0);
    const illustrationRequests = growth.listIllustrationRequests(goalId);
    const defaultRequests = illustrationRequests.filter((request) => request.coverageMode === "default");
    const customRequests = illustrationRequests.filter((request) => request.coverageMode === "custom");
    expect(defaultRequests).toHaveLength(1);
    expect(customRequests).toHaveLength(1);
    expect(defaultRequests[0]).toMatchObject({
      status: "completed", closureProfileId: closureProfile.id, closureRevision: orderedOutcomes.at(-1)!.revision,
    });
    const defaultItems = growth.listIllustrationItems(defaultRequests[0]!.id);
    const customItems = growth.listIllustrationItems(customRequests[0]!.id);
    const resourceRevisionOutputIds = committedCycles.flatMap((cycle) => changeSets.listOutputs(cycle.changeSetId!)
      .filter((output) => output.kind === "resource_revision").map((output) => output.outputId));
    const expectedDefaultTargets = [...new Map(resourceRevisionOutputIds.flatMap((revisionId) => {
      const resource = new ResourceRepository(workspace).getVisibleByRevisionIdAtCheckpoint(revisionId, checkpointId);
      return resource && ["oc", "location", "faction", "story"].includes(resource.objectKind)
        ? [[resource.id, resource] as const] : [];
    })).values()].filter((resource) => resource.objectKind !== "volume");
    expect(defaultItems).toHaveLength(expectedDefaultTargets.length);
    expect(defaultItems.length).toBeGreaterThanOrEqual(4);
    expect(defaultItems.every((item) => item.status === "ready" && item.imageJobId !== null && item.anchor.kind === "resource")).toBe(true);
    expect(new Set(defaultItems.flatMap((item) => item.anchor.kind === "resource" ? [item.anchor.resourceId] : [])))
      .toEqual(new Set(expectedDefaultTargets.map((resource) => resource.id)));
    expect(defaultItems.filter((item) => item.purpose === "character_portrait")).toHaveLength(ocs.length);
    expect(defaultItems.filter((item) => item.purpose === "scene").length).toBe(expectedDefaultTargets.length - ocs.length);
    expect(customItems).toHaveLength(1);
    expect(customItems[0]).toMatchObject({ status: "ready", purpose: "scene" });
    expect(customItems[0]!.anchor.kind).toBe("working_text_snapshot");
    const illustrationItems = [...defaultItems, ...customItems];
    expect(imageJobCount).toBe(1 + illustrationItems.length);
    expect(imageAssetCount).toBe(1 + illustrationItems.length);
    const imageRepository = new ImageAssetRepository(workspace);
    const illustrationAssetIds: string[] = [];
    for (const item of illustrationItems) {
      const job = imageRepository.getRequiredJob(item.imageJobId!);
      expect(job).toMatchObject({ status: "succeeded", providerId: "openai-compatible-image", modelId: "gpt-image-2", purpose: item.purpose });
      if (item.requestId === defaultRequests[0]!.id) {
        expect(job.sourceResourceIds).toContain(world!.id);
        expect(job.sourceVersionIds).toContain(worldDocument!.id);
      }
      const itemAsset = imageRepository.getAssetByJob(job.id);
      expect(itemAsset).toMatchObject({ status: "ready", mimeType: "image/png" });
      const itemBytes = new ImageAssetStore(workspacePath).readVerified(itemAsset!.relativePath, itemAsset!.sha256);
      expect(itemBytes.byteLength).toBe(itemAsset!.byteLength);
      illustrationAssetIds.push(itemAsset!.id);
    }
    return {
      goalId,
      cycles: cycles.map((cycle, index) => ({
        sequence: cycle.sequence,
        status: cycle.status,
        ruleRevision: cycle.ruleRevision,
        intentKind: intents[index]!.kind,
        hasRun: cycle.runId !== null,
        hasReceipt: cycle.receiptId !== null,
        hasChangeSet: cycle.changeSetId !== null,
        hasOutputCheckpoint: cycle.outputCheckpointId !== null,
      })),
      world: world!, story: story!, ocs, distinctive: distinctive!,
      counts: { resources: formal.length, documents: currentDocuments.length, assertions: sourced.length, relations: relations.length },
      changeSetCount,
      checkpointCount,
      imageJobCount,
      imageAssetCount,
      guidance: {
        revisionNumbers: rules.map((rule) => rule.revision),
        cycleRuleRevisions: cycles.map((cycle) => cycle.ruleRevision),
        revision2PersistedNoLaterThanCycle2: true,
        revisionCycleCommitted: true,
        worldReflectsRule: revisionDocumentOwners.has(world!.id) && !forbiddenRealJapaneseMarkerPattern.test(worldDocument!.content),
        storyReflectsRule: postRevisionStoryCycle !== undefined && lightNovelMarkerPattern.test(combinedCurrentContent),
        characterProfileReflectsRule: postRevisionOcCycle !== undefined && characterProfiles.length > 0,
        noRealJapaneseElements: !forbiddenRealJapaneseMarkerPattern.test(combinedCurrentContent),
      },
      closure: {
        safe: { profileCount: closureStates.length, evaluatedCycleCount: evaluatedCycles.length, repairCycleCount, finalDecision: "accepted" },
        profileId: closureProfile.id,
        revision: orderedOutcomes.at(-1)!.revision,
      },
      longform: {
        safe: { focusOcPresent: true, sectionCount: longform.completedSections.length, totalCodePoints: longform.totalCodePoints, complete: true },
        personalStoryResourceId: longform.personalStoryResourceId,
        sectionDocumentIds: longform.completedSections.map((section) => section.documentId),
      },
      illustrations: {
        safe: { defaultRequestCount: 1, defaultReadyCount: defaultItems.length, customRequestCount: 1, customReadyCount: 1 },
        requestIds: illustrationRequests.map((request) => request.id),
        assetIds: illustrationAssetIds,
      },
      worldMap: {
        jobId: worldMapJob.jobId,
        assetId: asset.id,
        safe: { providerId: authoritativeJob.providerId, modelId: authoritativeJob.modelId, sourceResourceCount: worldMapJob.sourceResourceIds.length, sourceVersionCount: worldMapJob.sourceVersionIds.length, mimeType: asset.mimeType, width: asset.width, height: asset.height, byteLength: asset.byteLength, sha256: asset.sha256 },
      },
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

function assertGrowthRunAudit(
  audit: AgentAuditRepository,
  runId: string,
  sequence: number,
  status: string,
  intentKind: string,
  closureDecision?: string,
): void {
  const tools = audit.listTools(runId);
  const toolNames = tools.map((row) => String(row.tool_name));
  expect(toolNames.filter((name) => name === "retrieve_graph_evidence")).toHaveLength(1);
  expect(toolNames.filter((name) => name === "propose_change_set")).toHaveLength(status === "committed" ? 1 : 0);
  expect(toolNames.filter((name) => name === "generate_image")).toHaveLength(sequence === 1 ? 1 : 0);
  expect(toolNames.filter((name) => name === "submit_closure_self_assessment"))
    .toHaveLength(intentKind === "closure_evaluation" ? 1 : 0);
  expect(toolNames.filter((name) => name === "submit_closure_checker_review"))
    .toHaveLength(intentKind === "closure_evaluation" && closureDecision !== "continue_growing" ? 1 : 0);
  const events = audit.listEvents(runId);
  const required = ["retrieve_graph_evidence"];
  if (status === "committed") required.push("propose_change_set");
  if (sequence === 1) required.push("generate_image");
  if (intentKind === "closure_evaluation") required.push("submit_closure_self_assessment");
  if (intentKind === "closure_evaluation" && closureDecision !== "continue_growing") required.push("submit_closure_checker_review");
  for (const name of required) {
    const invocationIds = new Set(tools.filter((row) => row.tool_name === name).map((row) => String(row.id)));
    expect(events.some((event) => invocationIds.has(String(event.tool_invocation_id)) && event.event_type === "succeeded")).toBe(true);
  }
}

async function assertShowcaseWorldMap(page: Page, persisted: PersistedGrowth): Promise<void> {
  const result = await page.evaluate(async ({ storyResourceId, jobId, assetId, illustrationAssetIds }) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const result = await desktop.showcase.get({ storyResourceId });
    if (!result.ok) throw new Error("SHOWCASE_WORLD_MAP_UNAVAILABLE");
    const match = result.showcase.images.find((candidate) => candidate.jobId === jobId && candidate.assetId === assetId);
    if (!match) throw new Error("SHOWCASE_WORLD_MAP_MISSING");
    return {
      worldMap: {
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
      },
      illustrationAssets: illustrationAssetIds.map((expectedAssetId) => {
        const image = result.showcase.images.find((candidate) => candidate.assetId === expectedAssetId);
        return image ? { assetId: image.assetId, purpose: image.purpose, status: image.status, thumbnailUrl: image.thumbnailUrl } : null;
      }),
    };
  }, {
    storyResourceId: persisted.story.id,
    jobId: persisted.worldMap.jobId,
    assetId: persisted.worldMap.assetId,
    illustrationAssetIds: persisted.illustrations.assetIds,
  });
  const image = result.worldMap;
  expect(image).toMatchObject({ jobId: persisted.worldMap.jobId, assetId: persisted.worldMap.assetId, purpose: "world_map", status: "ready", mimeType: persisted.worldMap.safe.mimeType });
  expect(image.sourceResourceIds).toContain(persisted.world.id);
  expect(image.sourceVersionIds).toHaveLength(2);
  expect(image.width).toBeGreaterThan(0);
  expect(image.height).toBeGreaterThan(0);
  expect(image.thumbnailUrl).toMatch(/^novax-asset:\/\/image\//);
  expect(result.illustrationAssets).toHaveLength(persisted.illustrations.assetIds.length);
  expect(result.illustrationAssets.every((candidate) => candidate?.status === "ready" && /^novax-asset:\/\/image\//.test(candidate.thumbnailUrl ?? ""))).toBe(true);
  expect(result.illustrationAssets.some((candidate) => candidate?.purpose === "character_portrait")).toBe(true);
  expect(result.illustrationAssets.some((candidate) => candidate?.purpose === "scene")).toBe(true);
}

async function assertReopenedGuidanceContent(
  page: Page,
  persisted: PersistedGrowth,
): Promise<Pick<SafeGuidanceEvidence, "reopenedStoryRulePresent" | "reopenedCharacterRulePresent">> {
  const anchors = await page.evaluate(async ({ storyResourceId, lightNovelPattern, fantasyPattern, forbiddenPattern }) => {
    const desktop = (globalThis as typeof globalThis & { novaxDesktop: DesktopApi }).novaxDesktop;
    const result = await desktop.showcase.get({ storyResourceId });
    if (!result.ok) throw new Error("SHOWCASE_GUIDANCE_CONTENT_UNAVAILABLE");
    const lightNovel = new RegExp(lightNovelPattern);
    const fantasy = new RegExp(fantasyPattern);
    const forbidden = new RegExp(forbiddenPattern);
    const storyContent = result.showcase.proseDocuments.map((document) => document.content).join("\n");
    const characterContents = result.showcase.characters.flatMap((character) => character.documents)
      .filter((document) => document.kind === "character_profile")
      .map((document) => document.content);
    return {
      story: lightNovel.test(storyContent) && !forbidden.test(storyContent),
      character: characterContents.length > 0
        && characterContents.every((content) => !forbidden.test(content))
        && characterContents.some((content) => lightNovel.test(content) || fantasy.test(content)),
    };
  }, {
    storyResourceId: persisted.story.id,
    lightNovelPattern: lightNovelMarkerPattern.source,
    fantasyPattern: originalFantasyMarkerPattern.source,
    forbiddenPattern: forbiddenRealJapaneseMarkerPattern.source,
  });
  expect(anchors).toEqual({ story: true, character: true });
  return { reopenedStoryRulePresent: true, reopenedCharacterRulePresent: true };
}

function inspectReopenedGuidanceRepository(
  workspacePath: string,
  persisted: PersistedGrowth,
): Pick<SafeGuidanceEvidence, "reopenedRevision2Present"> {
  const workspace = openWorkspace(workspacePath);
  try {
    const growth = new GrowthRepository(workspace);
    const rules = growth.listRuleRevisions(persisted.goalId, { limit: 100 });
    expect(rules.map((rule) => rule.revision)).toEqual([1, 2]);
    expect(rules[1]!.ruleText).toBe(guidanceRule);
    const cycles = growth.listCycles(persisted.goalId);
    expect(cycles.map((cycle) => cycle.ruleRevision)).toEqual(persisted.cycles.map((cycle) => cycle.ruleRevision));
    expect(cycles.map((cycle) => cycle.status)).toEqual(persisted.cycles.map((cycle) => cycle.status));
    expect(growth.listIllustrationRequests(persisted.goalId).map((request) => request.id)).toEqual(persisted.illustrations.requestIds);
    const finalCheckpointId = cycles.at(-1)!.inputCheckpointId;
    const closureProfile = growth.getClosureProfile(persisted.closure.profileId);
    if (!closureProfile || closureProfile.contractGeneration !== "v26" || !closureProfile.focusOcResourceId) {
      throw new Error("GROWTH_REOPEN_CLOSURE_INVALID");
    }
    expect(new GrowthLongformProgressResolver(workspace).resolve({
      checkpointId: finalCheckpointId,
      focusOcResourceId: closureProfile.focusOcResourceId,
    })).toMatchObject({ status: "ready", complete: true, totalCodePoints: persisted.longform.safe.totalCodePoints });
    return { reopenedRevision2Present: true };
  } finally {
    workspace.close();
  }
}

async function runResearchOnly(page: Page, persisted: PersistedGrowth): Promise<{ runId: string; safe: { retrieveSucceeded: boolean; noMutationTools: boolean } }> {
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
  return { runId: result.runId, safe: { retrieveSucceeded: true, noMutationTools: true } };
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
    const growth = new GrowthRepository(workspace);
    expect(growth.listRuleRevisions(persisted.goalId, { limit: 100 }).map((rule) => rule.revision)).toEqual([1, 2]);
    expect(growth.listCycles(persisted.goalId).map((cycle) => cycle.ruleRevision)).toEqual(persisted.cycles.map((cycle) => cycle.ruleRevision));
    expect(growth.listIllustrationRequests(persisted.goalId).map((request) => request.id)).toEqual(persisted.illustrations.requestIds);
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
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  JSON.parse(serialized);
  if (serialized.includes(guidanceRule)
    || /"(?:ruleText|content|prompt|toolArgs|locator|path|relativePath)"\s*:/i.test(serialized)
    || containsCredentialMarkerInText(serialized)) {
    throw new Error("GROWTH_GUIDANCE_EVIDENCE_LEAK_DETECTED");
  }
  const file = path.join(directory, `growth-guidance-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, serialized, "utf8");
}

function captureSqliteEvidence(workspacePath: string, goalId?: string): SafeSqliteEvidence | undefined {
  const workspace = openWorkspace(workspacePath);
  try {
    const resolvedGoalId = goalId ?? (workspace.db.prepare("SELECT id FROM growth_goals ORDER BY created_at DESC LIMIT 1").get() as { id?: unknown } | undefined)?.id;
    if (typeof resolvedGoalId !== "string") return undefined;
    const growth = new GrowthRepository(workspace);
    const cycles = growth.listCycles(resolvedGoalId);
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
    const closureStates = growth.listClosureStates(resolvedGoalId);
    const decisions = cycles.flatMap((cycle) => {
      const outcome = growth.getClosureEvaluationOutcomeForCycle(cycle.id);
      return outcome ? [outcome.decision] : [];
    });
    const closureEvaluations = cycles.flatMap((cycle) => {
      const outcome = growth.getClosureEvaluationOutcomeForCycle(cycle.id);
      if (!outcome) return [];
      const steward = growth.getClosureStewardSubmission(outcome.stewardAssessmentId);
      if (!steward) return [];
      const checker = outcome.checkerAssessmentId
        ? growth.getClosureCheckerSubmission(outcome.checkerAssessmentId)
        : null;
      return [projectGrowthClosureSafeEvaluation({
        cycleSequence: cycle.sequence,
        decision: outcome.decision,
        facetResults: steward.facetResults,
        adverseFindings: checker?.adverseFindings ?? [],
      })];
    });
    const closureProfile = closureStates[0] ? growth.getClosureProfile(closureStates[0].profileId) : null;
    let longform: SafeSqliteEvidence["longform"] = {
      status: "unavailable", reason: null, complete: false, totalCodePoints: 0, sectionCount: 0,
    };
    if (closureProfile?.contractGeneration === "v26" && closureProfile.focusOcResourceId && cycles.length > 0) {
      try {
        const progress = new GrowthLongformProgressResolver(workspace).resolve({
          checkpointId: cycles.at(-1)!.outputCheckpointId ?? cycles.at(-1)!.inputCheckpointId,
          focusOcResourceId: closureProfile.focusOcResourceId,
        });
        longform = progress.status === "ready"
          ? { status: "ready", reason: null, complete: progress.complete,
              totalCodePoints: progress.totalCodePoints, sectionCount: progress.completedSections.length }
          : { status: "blocked", reason: progress.reason, complete: false, totalCodePoints: 0, sectionCount: 0 };
      } catch {
        longform = { status: "blocked", reason: null, complete: false, totalCodePoints: 0, sectionCount: 0 };
      }
    }
    const illustrationRequests = growth.listIllustrationRequests(resolvedGoalId);
    const illustrationItems = illustrationRequests.flatMap((request) => growth.listIllustrationItems(request.id));
    const imageJobs = workspace.db.prepare(`
      SELECT purpose, status, request_sent_at, error_code
      FROM image_generation_jobs
      ORDER BY created_at ASC, id ASC
    `).all() as Array<{ purpose?: unknown; status?: unknown; request_sent_at?: unknown; error_code?: unknown }>;
    const itemStatusCounts = [...new Set(illustrationItems.map((item) => item.status))].sort().map((status) => ({
      status,
      count: illustrationItems.filter((item) => item.status === status).length,
    }));
    const diagnosticRepository = new SafeDiagnosticRepository(workspace);
    return {
      cycles: cycles.map((cycle) => ({
        sequence: cycle.sequence,
        status: cycle.status,
        ruleRevision: cycle.ruleRevision,
        failureCode: cycle.failureCode,
        hasRun: cycle.runId !== null,
        hasReceipt: cycle.receiptId !== null,
        hasChangeSet: cycle.changeSetId !== null,
        hasInputCheckpoint: cycle.inputCheckpointId.length > 0,
        hasOutputCheckpoint: cycle.outputCheckpointId !== null,
        receiptLinkCount: cycle.receiptId ? growth.getReceipt(cycle.receiptId)?.links.length ?? null : null,
        audit: cycle.runId ? safeRunAudit(workspace, cycle.runId) : null,
      })),
      diagnostics: cycles.flatMap((cycle) => diagnosticRepository.listCycle(cycle.id).map((diagnostic) => ({
        cycleSequence: cycle.sequence,
        operationKind: diagnostic.operationKind,
        owner: diagnostic.owner,
        boundary: diagnostic.boundary,
        code: diagnostic.code,
        toolName: diagnostic.toolName,
        attempt: diagnostic.attempt,
        maxAttempts: diagnostic.maxAttempts,
        sideEffectState: diagnostic.sideEffectState,
        disposition: diagnostic.disposition,
        retryability: diagnostic.retryability,
      }))),
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
      closure: { profileCount: closureStates.length, decisions, evaluations: closureEvaluations },
      longform,
      illustrations: {
        requests: illustrationRequests.map((request) => ({
          coverageMode: request.coverageMode, status: request.status, itemCount: request.itemCount, readyCount: request.readyCount,
        })),
        itemStatuses: itemStatusCounts,
        jobs: imageJobs.map((job) => ({
          purpose: safeImageJobPurpose(job.purpose),
          status: safeImageJobStatus(job.status),
          requestSent: typeof job.request_sent_at === "string",
          errorCode: safeImageJobErrorCode(job.error_code),
        })),
        imageJobCount: Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_generation_jobs").get()?.count ?? 0),
        imageAssetCount: Number(workspace.db.prepare("SELECT COUNT(*) AS count FROM image_assets").get()?.count ?? 0),
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
  const toolSucceeded = (name: string) => {
    const invocationIds = new Set(tools.filter((tool) => String(tool.tool_name) === name).map((tool) => String(tool.id)));
    return auditEvents.some((event) => invocationIds.has(String(event.tool_invocation_id)) && event.event_type === "succeeded");
  };
  const terminal = auditEvents.filter((event) => Number(event.terminal) === 1);
  const safeToolNames = new Set([
    "retrieve_graph_evidence", "submit_growth_inquiry", "submit_closure_self_assessment",
    "checker", "submit_closure_checker_review", "writer", "propose_change_set",
    "generate_image", "submit_steward_result",
  ]);
  const safeTerminalStatuses = new Set([
    "succeeded", "failed", "blocked", "cancelled", "interrupted", "awaiting_confirmation",
  ]);
  const toolOutcomes = tools.map((tool) => {
    const toolName = String(tool.tool_name);
    const terminalEvent = auditEvents.find((event) => String(event.tool_invocation_id) === String(tool.id)
      && Number(event.terminal) === 1);
    const eventType = terminalEvent ? String(terminalEvent.event_type) : "unknown";
    return {
      toolName: safeToolNames.has(toolName) ? toolName : "unknown",
      status: safeTerminalStatuses.has(eventType) ? eventType : "unknown",
    };
  });
  return {
    terminalCount: terminal.length,
    terminalErrorCodes: terminal.map((event) => event.error_code).filter((value): value is string => typeof value === "string"),
    toolOutcomes,
    retrieveSucceeded: toolSucceeded("retrieve_graph_evidence"),
    proposeSucceeded: toolSucceeded("propose_change_set"),
    imageSucceeded: toolSucceeded("generate_image"),
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
    "GROWTH_GUIDANCE_CYCLE_ONE_WINDOW_MISSED", "GROWTH_GUIDANCE_REVISION_CONFLICT", "GROWTH_GUIDANCE_ACK_TIMEOUT",
    "GROWTH_GUIDANCE_BOUNDARY_STATE_INVALID", "GROWTH_GUIDANCE_EVIDENCE_LEAK_DETECTED",
    "DEFAULT_ILLUSTRATIONS_TERMINAL_FAILURE", "DEFAULT_ILLUSTRATIONS_TIMEOUT",
    "EXTRA_ILLUSTRATION_TERMINAL_FAILURE", "EXTRA_ILLUSTRATION_TIMEOUT", "GROWTH_LONGFORM_INCOMPLETE",
  ]);
  if (allowlisted.has(error.message)) return error.message;
  if (/^RESEARCH_TERMINAL_[A-Z0-9_]+$/.test(error.message)) return "AGENT_RUN_FAILED";
  return "GROWTH_LIVE_ACCEPTANCE_FAILED";
}
