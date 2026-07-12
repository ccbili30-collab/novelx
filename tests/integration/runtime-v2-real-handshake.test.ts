import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  RuntimeV2ProcessSupervisor,
  RuntimeV2SupervisorError,
  type RuntimeV2RuntimeEvent,
} from "../../src/main/runtimeV2ProcessSupervisor";
import { RUNTIME_V2_PROTOCOL_VERSION } from "../../src/shared/runtimeV2Protocol";
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";
import type {
  RuntimeV2ContextCompilePayload,
  RuntimeV2ProviderInferenceStartPayload,
  RuntimeV2RunStartPayload,
} from "../../src/shared/runtimeV2Protocol";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runtimeRoot = path.join(appRoot, "runtime");
const runtimeExecutable = path.join(
  runtimeRoot,
  "target",
  "debug",
  process.platform === "win32" ? "novelx-runtime.exe" : "novelx-runtime",
);

let supervisor: RuntimeV2ProcessSupervisor | null = null;
const tempRoots: string[] = [];
const providerServers: ControlledProviderServer[] = [];

beforeAll(() => {
  const build = spawnSync("cargo", [
    "build",
    "--manifest-path",
    path.join(runtimeRoot, "Cargo.toml"),
    "--bin",
    "novelx-runtime",
  ], {
    cwd: runtimeRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    throw new Error(`Runtime V2 Cargo build failed.\n${build.stdout}\n${build.stderr}`);
  }
}, 120_000);

afterEach(async () => {
  await supervisor?.stop();
  supervisor = null;
  await Promise.all(providerServers.splice(0).map((server) => server.close()));
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Runtime V2 real Rust handshake", () => {
  it("builds and completes hello/initialize/ready before exiting cleanly on stop", async () => {
    supervisor = new RuntimeV2ProcessSupervisor({
      executablePath: runtimeExecutable,
      application: {
        id: "novelx.desktop.integration_test",
        version: "0.2.7",
        commit: "runtime-v2-real-handshake-test",
      },
      workspaceDatabasePath: null,
      projectRootPath: null,
      projectId: null,
      workspaceId: null,
      featureFlags: { runtime_v2: true },
      hostCapabilityVersions: {
        project_tools: "1.0.0",
        runtime_supervisor: "1.0.0",
      },
      startupTimeoutMs: 10_000,
      stopTimeoutMs: 2_000,
    });

    const handshake = await supervisor.start();
    const ownedPid = supervisor.pid;

    expect(ownedPid).toEqual(expect.any(Number));
    expect(handshake.hello.protocolVersion).toBe(RUNTIME_V2_PROTOCOL_VERSION);
    expect(handshake.hello.payload.protocolVersions).toContain(RUNTIME_V2_PROTOCOL_VERSION);
    expect(handshake.hello.payload.capabilities).toEqual(expect.arrayContaining(["runtime_control", "runs_v1"]));
    expect(handshake.ready.protocolVersion).toBe(RUNTIME_V2_PROTOCOL_VERSION);
    expect(handshake.ready.payload.selectedProtocolVersion).toBe(RUNTIME_V2_PROTOCOL_VERSION);
    expect(handshake.ready.correlationId).not.toBeNull();
    expect(handshake.ready.payload.runtime).toEqual({
      version: handshake.hello.payload.runtimeVersion,
      build: handshake.hello.payload.build,
    });

    await expect(supervisor.status()).resolves.toEqual({
      initialized: true,
      workspaceDatabaseConfigured: false,
      recoveredRunCount: 0,
      protocolVersion: RUNTIME_V2_PROTOCOL_VERSION,
      runtimeVersion: handshake.hello.payload.runtimeVersion,
    });
    const secret = "real-handshake-sensitive-key";
    await expect(supervisor.bindProvider(
      runtimeProviderConfig(),
      "bc9267f85e52b4ac2945b81966aa9a4cc7f513642cfa8f0057f7fc35b90586c8",
      secret,
    )).resolves.toMatchObject({
      profileId: "profile-1",
      providerId: "deepseek",
      modelId: "deepseek-chat",
      contextWindow: 1_000_000,
    });
    expect(supervisor.stderr).not.toContain(secret);

    await supervisor.stop();

    expect(supervisor.pid).toBeNull();
    expect(isProcessAlive(ownedPid!)).toBe(false);
  }, 30_000);

  it("persists a pinned Run and recovers the same snapshot after a real process restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-runtime-v2-run-"));
    tempRoots.push(root);
    const databasePath = path.join(root, "runtime.db");
    const runId = "f25772f3-b0aa-4449-92eb-8ddf611a810d";
    const payload = runStartPayload();

    supervisor = createWorkspaceSupervisor(databasePath, root);
    await supervisor.start();
    const mismatched = runStartPayload();
    mismatched.pinnedIdentity.projectId = "another-project";
    const rejection = await supervisor.startRun("447d5fb8-bfc0-4565-bb32-a87afce72224", mismatched)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(RuntimeV2SupervisorError);
    expect(rejection).toMatchObject({
      code: "RUNTIME_V2_RUN_REJECTED",
      publicPayload: { code: "RUN_WORKSPACE_BINDING_CONFLICT", class: "source_conflict", retryable: false },
    });
    await expect(supervisor.status()).resolves.toMatchObject({ initialized: true });

    const created = await supervisor.startRun(runId, payload);
    expect(created).toMatchObject({
      runId,
      state: "created",
      recoveryClassification: "resumable",
      aggregateSequence: 1,
      pinnedIdentity: payload.pinnedIdentity,
    });
    await supervisor.stop();

    supervisor = createWorkspaceSupervisor(databasePath, root);
    const restarted = await supervisor.start();
    expect(restarted.ready.payload.recoveredRunCount).toBe(1);
    await expect(supervisor.getRun(runId)).resolves.toEqual(created);

    const cancelled = await supervisor.cancelRun(runId, {
      cancelIdempotencyKey: "integration-cancel-1",
      reason: "集成测试取消",
    });
    expect(cancelled).toMatchObject({ state: "cancelled", recoveryClassification: "terminal", aggregateSequence: 2 });
    await expect(supervisor.cancelRun(runId, {
      cancelIdempotencyKey: "integration-cancel-1",
      reason: "集成测试取消",
    })).resolves.toEqual(cancelled);
    await supervisor.stop();

    supervisor = createWorkspaceSupervisor(databasePath, root);
    const terminalRestart = await supervisor.start();
    expect(terminalRestart.ready.payload.recoveredRunCount).toBe(0);
    await expect(supervisor.getRun(runId)).resolves.toEqual(cancelled);
  }, 30_000);

  it("persists REAL_GM_PROVIDER_REQUIRED from run.prepare and recovers it after restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-runtime-v2-provider-required-"));
    tempRoots.push(root);
    const databasePath = path.join(root, "runtime.db");
    const runId = "3f7202b5-e640-4c9c-b86a-a549fd7e6ac8";

    supervisor = createWorkspaceSupervisor(databasePath, root);
    await supervisor.start();
    await supervisor.startRun(runId, runStartPayload());
    const failed = await supervisor.prepareRun(runId, {
      prepareIdempotencyKey: "integration-prepare-provider-required-1",
    });

    expect(failed).toMatchObject({
      runId,
      state: "failed",
      recoveryClassification: "terminal",
      aggregateSequence: 2,
      terminalError: {
        code: "REAL_GM_PROVIDER_REQUIRED",
        class: "provider_auth",
        retryable: false,
        stage: "run.prepare.provider",
      },
    });
    await supervisor.stop();
    expect(countRuntimeEvents(databasePath, runId)).toBe(2);

    supervisor = createWorkspaceSupervisor(databasePath, root);
    const restarted = await supervisor.start();
    expect(restarted.ready.payload.recoveredRunCount).toBe(0);
    await expect(supervisor.getRun(runId)).resolves.toEqual(failed);
  }, 30_000);

  it("prepares with the exact bound Provider and does not append an event for the same idempotency key", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-runtime-v2-provider-bound-"));
    tempRoots.push(root);
    const databasePath = path.join(root, "runtime.db");
    const runId = "21752d5a-8878-45ba-ad9f-3e9400e80ae6";
    const configSha256 = "bc9267f85e52b4ac2945b81966aa9a4cc7f513642cfa8f0057f7fc35b90586c8";
    const payload = runStartPayload();
    payload.pinnedIdentity.provider.profileId = "profile-1";
    payload.pinnedIdentity.provider.configSha256 = configSha256;

    supervisor = createWorkspaceSupervisor(databasePath, root);
    await supervisor.start();
    await supervisor.bindProvider(runtimeProviderConfig(), configSha256, "integration-provider-secret");
    await supervisor.startRun(runId, payload);

    const prepare = { prepareIdempotencyKey: "integration-prepare-bound-1" };
    const first = await supervisor.prepareRun(runId, prepare);
    const retried = await supervisor.prepareRun(runId, prepare);

    expect(first).toMatchObject({
      runId,
      state: "preparing",
      recoveryClassification: "resumable",
      aggregateSequence: 2,
      terminalError: null,
    });
    expect(retried).toEqual(first);
    await supervisor.stop();
    expect(countRuntimeEvents(databasePath, runId)).toBe(2);
  }, 30_000);

  it("persists one authoritative context compilation and recovers the same receipt after restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-runtime-v2-context-"));
    tempRoots.push(root);
    const databasePath = path.join(root, "runtime.db");
    const runId = "57b943bd-422f-448d-b0ca-ab0c27a10f38";
    const configSha256 = "bc9267f85e52b4ac2945b81966aa9a4cc7f513642cfa8f0057f7fc35b90586c8";
    const start = runStartPayload();
    start.pinnedIdentity.provider.profileId = "profile-1";
    start.pinnedIdentity.provider.configSha256 = configSha256;
    const compile = contextCompilePayload(start);

    supervisor = createWorkspaceSupervisor(databasePath, root);
    const handshake = await supervisor.start();
    expect(handshake.hello.payload.capabilities).toContain("contexts_v1");
    await supervisor.bindProvider(runtimeProviderConfig(), configSha256, "context-integration-secret");
    await supervisor.startRun(runId, start);
    await supervisor.prepareRun(runId, { prepareIdempotencyKey: "integration-context-prepare-1" });
    const first = await supervisor.compileContext(runId, compile);
    const retried = await supervisor.compileContext(runId, compile);

    expect(first).toMatchObject({
      requestNumber: 1,
      compilerVersion: "1.0.0",
      tokenizer: {
        kind: "fallback_estimate",
        providerId: "deepseek",
        modelId: "deepseek-chat",
      },
      representation: "normalized_messages",
      contextWindow: 1_000_000,
      accepted: true,
      includedItemIds: ["system-1", "current-1"],
      omittedItemIds: [],
      incomplete: false,
    });
    expect(retried).toEqual(first);
    await supervisor.stop();
    expect(countRuntimeEvents(databasePath, runId)).toBe(3);

    supervisor = createWorkspaceSupervisor(databasePath, root);
    await supervisor.start();
    await expect(supervisor.compileContext(runId, compile)).resolves.toEqual(first);
    expect(countRuntimeEvents(databasePath, runId)).toBe(3);
  }, 30_000);

  it("answers status while real Provider inference is held behind an HTTP barrier, then emits completion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-runtime-v2-inference-actor-"));
    tempRoots.push(root);
    const databasePath = path.join(root, "runtime.db");
    const runId = "bdcbf1ca-7b5d-4204-9804-f7857d846baf";
    const providerServer = await ControlledProviderServer.start();
    providerServers.push(providerServer);
    const providerConfig = runtimeProviderConfig(providerServer.baseUrl);
    const configSha256 = canonicalAuditHash(providerConfig);
    const start = runStartPayload();
    start.pinnedIdentity.provider.profileId = providerConfig.profileId;
    start.pinnedIdentity.provider.configSha256 = configSha256;
    const compile = contextCompilePayload(start);
    const terminal = deferred<RuntimeV2RuntimeEvent>();

    supervisor = createWorkspaceSupervisor(databasePath, root);
    supervisor.subscribeRuntimeEvents((event) => {
      if (event.name.startsWith("provider.inference.")) terminal.resolve(event);
    });
    await supervisor.start();
    await supervisor.bindProvider(providerConfig, configSha256, "actor-integration-secret");
    await supervisor.startRun(runId, start);
    await supervisor.prepareRun(runId, { prepareIdempotencyKey: "integration-inference-prepare-1" });
    const compilation = await supervisor.compileContext(runId, compile);
    const inference = inferenceStartPayload(compilation.compilationId);

    const accepted = await supervisor.startProviderInference(runId, inference);
    expect(accepted).toMatchObject({
      runId,
      inferenceId: inference.inferenceId,
      attemptId: inference.attemptId,
      contextCompilationId: compilation.compilationId,
    });
    const providerRequest = await providerServer.waitForRequest();
    expect(providerRequest.method).toBe("POST");
    expect(providerRequest.url).toBe("/v1/chat/completions");
    expect(terminal.settled()).toBe(false);

    await expect(supervisor.status()).resolves.toMatchObject({ initialized: true });
    expect(terminal.settled()).toBe(false);

    providerServer.releaseSuccess("潮声越过银湾旧港。 ");
    const completed = await terminal.promise;
    expect(completed).toMatchObject({
      name: "provider.inference.completed",
      correlationId: expect.any(String),
      runId,
      payload: {
        inferenceId: inference.inferenceId,
        attemptId: inference.attemptId,
        output: { text: "潮声越过银湾旧港。 " },
      },
    });
  }, 45_000);

  it("recovers a killed sent inference as reconciliation-required without automatically resending", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-runtime-v2-inference-kill-"));
    tempRoots.push(root);
    const databasePath = path.join(root, "runtime.db");
    const runId = "32f27af7-a98d-4058-9828-a2878a6a64d6";
    const providerServer = await ControlledProviderServer.start();
    providerServers.push(providerServer);
    const providerConfig = runtimeProviderConfig(providerServer.baseUrl);
    const configSha256 = canonicalAuditHash(providerConfig);
    const start = runStartPayload();
    start.pinnedIdentity.provider.profileId = providerConfig.profileId;
    start.pinnedIdentity.provider.configSha256 = configSha256;
    const runtimeFailure = deferred<RuntimeV2SupervisorError>();

    supervisor = createWorkspaceSupervisor(databasePath, root, (error) => runtimeFailure.resolve(error));
    await supervisor.start();
    await supervisor.bindProvider(providerConfig, configSha256, "kill-integration-secret");
    await supervisor.startRun(runId, start);
    await supervisor.prepareRun(runId, { prepareIdempotencyKey: "integration-kill-prepare-1" });
    const compilation = await supervisor.compileContext(runId, contextCompilePayload(start));
    await supervisor.startProviderInference(runId, inferenceStartPayload(compilation.compilationId));
    await providerServer.waitForRequest();
    const ownedPid = supervisor.pid;
    expect(ownedPid).toEqual(expect.any(Number));

    terminateRecordedProcess(ownedPid!);
    await expect(runtimeFailure.promise).resolves.toMatchObject({ code: "RUNTIME_V2_EXITED_AFTER_READY" });
    await providerServer.waitForDisconnect();
    expect(supervisor.pid).toBeNull();
    expect(providerServer.requestCount).toBe(1);
    expect(runtimeEventTypes(databasePath, runId, "provider_attempt")).toEqual([
      "provider.requested",
      "provider.sent",
    ]);

    supervisor = createWorkspaceSupervisor(databasePath, root);
    const restarted = await supervisor.start();
    expect(restarted.ready.payload.recoveredRunCount).toBe(1);
    await expect(supervisor.status()).resolves.toMatchObject({ initialized: true });
    await expect(supervisor.getRun(runId)).resolves.toMatchObject({
      state: "waiting_for_reconciliation",
      recoveryClassification: "waiting_for_reconciliation",
    });
    expect(providerServer.requestCount).toBe(1);
  }, 45_000);

  it("cancels a held inference by closing the Provider connection and never emits completed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-runtime-v2-inference-cancel-"));
    tempRoots.push(root);
    const databasePath = path.join(root, "runtime.db");
    const runId = "bff23b24-f19b-4dda-acf1-faa2e3050bba";
    const providerServer = await ControlledProviderServer.start();
    providerServers.push(providerServer);
    const providerConfig = runtimeProviderConfig(providerServer.baseUrl);
    const configSha256 = canonicalAuditHash(providerConfig);
    const start = runStartPayload();
    start.pinnedIdentity.provider.profileId = providerConfig.profileId;
    start.pinnedIdentity.provider.configSha256 = configSha256;
    const terminal = deferred<RuntimeV2RuntimeEvent>();
    const terminalNames: string[] = [];

    supervisor = createWorkspaceSupervisor(databasePath, root);
    supervisor.subscribeRuntimeEvents((event) => {
      if (!event.name.startsWith("provider.inference.")) return;
      terminalNames.push(event.name);
      terminal.resolve(event);
    });
    await supervisor.start();
    await supervisor.bindProvider(providerConfig, configSha256, "cancel-integration-secret");
    await supervisor.startRun(runId, start);
    await supervisor.prepareRun(runId, { prepareIdempotencyKey: "integration-cancel-prepare-1" });
    const compilation = await supervisor.compileContext(runId, contextCompilePayload(start));
    await supervisor.startProviderInference(runId, inferenceStartPayload(compilation.compilationId));
    await providerServer.waitForRequest();

    await expect(supervisor.cancelRun(runId, {
      cancelIdempotencyKey: "integration-active-inference-cancel-1",
      reason: "取消挂起的模型请求",
    })).resolves.toMatchObject({
      state: "waiting_for_reconciliation",
      recoveryClassification: "waiting_for_reconciliation",
    });
    await providerServer.waitForDisconnect();
    const terminalEvent = await terminal.promise;

    expect(terminalEvent).toMatchObject({
      name: "provider.inference.reconciliation_required",
      payload: {
        reason: "outcome_unknown",
        error: { code: "PROVIDER_OUTCOME_UNKNOWN", retryable: false },
      },
    });
    expect(terminalNames).not.toContain("provider.inference.completed");
    expect(providerServer.requestCount).toBe(1);
    await expect(supervisor.getRun(runId)).resolves.toMatchObject({
      state: "waiting_for_reconciliation",
      recoveryClassification: "waiting_for_reconciliation",
    });
    expect(runtimeEventRecords(databasePath, runId, "run")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "run.cancellation_requested",
        payload: expect.objectContaining({
          cancellationReason: "取消挂起的模型请求",
          attemptIds: [expect.any(String)],
        }),
      }),
    ]));
    expect(runtimeEventTypes(databasePath, runId, "run")).not.toContain("run.cancelled");
  }, 45_000);

  it("reconciles an unknown Provider outcome as cancelled and preserves it across restart", async () => {
    const runId = "7800e97d-48c7-4517-b17f-6d6dfbd998c2";
    const { databasePath, projectRootPath, providerServer, attemptId } = await createOutcomeUnknownRun(runId);

    await expect(supervisor!.reconcileRun(runId, {
      reconciliationIdempotencyKey: "integration-reconcile-cancel-1",
      attemptId,
      decision: "cancel_run",
      duplicateExecutionAcknowledged: false,
    })).resolves.toMatchObject({
      receipt: {
        attemptId,
        decision: "cancel_run",
        state: "cancelled",
      },
      snapshot: {
        state: "cancelled",
        recoveryClassification: "terminal",
      },
    });
    expect(providerServer.requestCount).toBe(1);

    await supervisor!.stop();
    supervisor = createWorkspaceSupervisor(databasePath, projectRootPath);
    await supervisor.start();
    await expect(supervisor.getRun(runId)).resolves.toMatchObject({
      state: "cancelled",
      recoveryClassification: "terminal",
    });
    expect(providerServer.requestCount).toBe(1);
  }, 45_000);

  it("reconciles an unknown Provider outcome as an explicit retry without dispatching it", async () => {
    const runId = "36d79b24-3378-4b79-9d53-22412b9cfa58";
    const { databasePath, providerServer, attemptId } = await createOutcomeUnknownRun(runId);

    await expect(supervisor!.reconcileRun(runId, {
      reconciliationIdempotencyKey: "integration-reconcile-retry-1",
      attemptId,
      decision: "retry_as_new_attempt_acknowledging_duplicate",
      duplicateExecutionAcknowledged: true,
    })).resolves.toMatchObject({
      receipt: {
        attemptId,
        decision: "retry_as_new_attempt_acknowledging_duplicate",
        state: "retrying",
      },
      snapshot: {
        state: "retrying",
        recoveryClassification: "resumable",
      },
    });
    expect(runtimeEventTypes(databasePath, runId, "provider_attempt")).toEqual([
      "provider.requested",
      "provider.sent",
      "provider.outcome_unknown",
    ]);
    expect(providerServer.requestCount).toBe(1);
  }, 45_000);
});

async function createOutcomeUnknownRun(runId: string): Promise<{
  databasePath: string;
  projectRootPath: string;
  providerServer: ControlledProviderServer;
  attemptId: string;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-runtime-v2-reconcile-"));
  tempRoots.push(root);
  const databasePath = path.join(root, "runtime.db");
  const providerServer = await ControlledProviderServer.start();
  providerServers.push(providerServer);
  const providerConfig = runtimeProviderConfig(providerServer.baseUrl);
  const configSha256 = canonicalAuditHash(providerConfig);
  const start = runStartPayload();
  start.startIdempotencyKey = `integration-reconcile-start-${runId}`;
  start.pinnedIdentity.provider.profileId = providerConfig.profileId;
  start.pinnedIdentity.provider.configSha256 = configSha256;
  supervisor = createWorkspaceSupervisor(databasePath, root);
  await supervisor.start();
  await supervisor.bindProvider(providerConfig, configSha256, "reconcile-integration-secret");
  await supervisor.startRun(runId, start);
  await supervisor.prepareRun(runId, { prepareIdempotencyKey: `integration-reconcile-prepare-${runId}` });
  const compilation = await supervisor.compileContext(runId, {
    ...contextCompilePayload(start),
    compileIdempotencyKey: `integration-reconcile-compile-${runId}`,
  });
  const inference = inferenceStartPayload(compilation.compilationId);
  inference.inferenceId = randomUUID();
  inference.attemptId = randomUUID();
  inference.inferenceIdempotencyKey = `integration-reconcile-inference-${runId}`;
  await supervisor.startProviderInference(runId, inference);
  await providerServer.waitForRequest();
  await expect(supervisor.cancelRun(runId, {
    cancelIdempotencyKey: `integration-reconcile-cancel-request-${runId}`,
    reason: "等待人工对账后处理模型请求",
  })).resolves.toMatchObject({
    state: "waiting_for_reconciliation",
    recoveryClassification: "waiting_for_reconciliation",
  });
  await providerServer.waitForDisconnect();
  expect(providerServer.requestCount).toBe(1);

  await supervisor.stop();
  supervisor = createWorkspaceSupervisor(databasePath, root);
  await supervisor.start();
  await expect(supervisor.getRun(runId)).resolves.toMatchObject({
    state: "waiting_for_reconciliation",
    recoveryClassification: "waiting_for_reconciliation",
  });
  expect(providerServer.requestCount).toBe(1);
  return { databasePath, projectRootPath: root, providerServer, attemptId: inference.attemptId };
}

function createWorkspaceSupervisor(
  databasePath: string,
  projectRootPath: string,
  onRuntimeFailure?: (error: RuntimeV2SupervisorError) => void,
): RuntimeV2ProcessSupervisor {
  return new RuntimeV2ProcessSupervisor({
    executablePath: runtimeExecutable,
    application: {
      id: "novelx.desktop.integration_test",
      version: "0.2.7",
      commit: "runtime-v2-real-run-test",
    },
    workspaceDatabasePath: databasePath,
    projectRootPath,
    projectId: "project-1",
    workspaceId: "workspace-1",
    featureFlags: { runtime_v2: true },
    hostCapabilityVersions: { runtime_supervisor: "1.0.0" },
    startupTimeoutMs: 10_000,
    commandTimeoutMs: 10_000,
    stopTimeoutMs: 2_000,
    onRuntimeFailure,
  });
}

function runStartPayload(): RuntimeV2RunStartPayload {
  const policy = (id: string, digit: string) => ({ id, version: "1.0.0", sha256: digit.repeat(64) });
  return {
    startIdempotencyKey: "integration-start-1",
    pinnedIdentity: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sessionBranchId: "session-branch-1",
      userMessageId: "user-message-1",
      projectBranchId: "project-branch-1",
      goal: null,
      plan: null,
      provider: {
        profileId: "provider-profile-1",
        providerId: "deepseek",
        modelId: "deepseek-chat",
        configSha256: "a".repeat(64),
      },
      promptBundle: policy("novelx.steward", "b"),
      agentProfile: policy("novelx.agent.steward", "c"),
      toolPolicy: policy("novelx.tools", "d"),
      contextPolicy: policy("novelx.context", "e"),
      runtimePolicy: policy("novelx.runtime", "f"),
      runtimeContractVersion: "1.0.0",
      mode: "assist",
      sourceCheckpointId: "checkpoint-1",
      scopeResourceIds: ["resource-1", "resource-2"],
      resourceScopeSha256: "1".repeat(64),
      userInputSha256: "2".repeat(64),
    },
  };
}

function runtimeProviderConfig(baseUrl = "https://api.deepseek.com/v1") {
  return {
    schemaVersion: 1 as const,
    profileId: "profile-1",
    providerId: "deepseek",
    displayName: "DeepSeek",
    baseUrl,
    modelId: "deepseek-chat",
    apiFlavor: "open_ai_chat_completions" as const,
    authScheme: "bearer" as const,
    contextWindow: 1_000_000,
    maxTokens: null,
    reasoning: false,
    input: ["text" as const],
    requestTimeoutMs: 30_000,
    totalDeadlineMs: 120_000,
    retryPolicy: { maxAttempts: 3, maxTotalDelayMs: 30_000 },
  };
}

function inferenceStartPayload(contextCompilationId: string): RuntimeV2ProviderInferenceStartPayload {
  return {
    inferenceId: "a5a491e2-ae65-4939-9f71-3f10f32104cb",
    attemptId: "f6add75e-ea2e-41c7-aa84-25fbbb94f380",
    invocationId: "steward-invocation-1",
    contextCompilationId,
    requestNumber: 1,
    attemptNumber: 1,
    inferenceIdempotencyKey: "integration-inference-start-1",
  };
}

function contextCompilePayload(start: RuntimeV2RunStartPayload): RuntimeV2ContextCompilePayload {
  const system = "Stay within the pinned project and cite stable sources.";
  const current = "Continue the coastline discussion.";
  return {
    compileIdempotencyKey: "integration-context-compile-1",
    invocationId: "steward-invocation-1",
    requestNumber: 1,
    provider: start.pinnedIdentity.provider,
    contextPolicy: start.pinnedIdentity.contextPolicy,
    compilerVersion: "1.0.0",
    contextWindow: 1_000_000,
    configuredMaxOutputTokens: null,
    safetyReserveTokens: 100_000,
    items: [
      {
        type: "system_prompt",
        itemId: "system-1",
        content: system,
        contentSha256: sha256Text(system),
        disclosure: "agent_internal",
        required: true,
      },
      {
        type: "session_message",
        itemId: "current-1",
        messageId: "message-current-1",
        role: "user",
        content: current,
        contentSha256: sha256Text(current),
        createdAt: "2026-07-12T00:00:01Z",
        disclosure: "project_private",
        required: true,
      },
    ],
  };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function countRuntimeEvents(databasePath: string, runId: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ?").get(runId) as {
      count: number;
    };
    return row.count;
  } finally {
    database.close();
  }
}

interface CapturedProviderRequest {
  method: string | undefined;
  url: string | undefined;
  body: string;
}

class ControlledProviderServer {
  readonly #request = deferred<CapturedProviderRequest>();
  readonly #release = deferred<{ status: number; body: string }>();
  readonly #disconnect = deferred<void>();
  #requestCount = 0;
  #closed = false;

  private constructor(
    readonly baseUrl: string,
    private readonly server: http.Server,
  ) {}

  static async start(): Promise<ControlledProviderServer> {
    let fixture: ControlledProviderServer;
    const server = http.createServer((request, response) => {
      fixture.#requestCount += 1;
      response.once("close", () => fixture.#disconnect.resolve());
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        fixture.#request.resolve({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        void fixture.#release.promise.then(({ status, body }) => {
          if (response.destroyed) return;
          response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
          response.end(body);
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback Provider did not expose a TCP address.");
    fixture = new ControlledProviderServer(`http://127.0.0.1:${address.port}/v1`, server);
    return fixture;
  }

  waitForRequest(): Promise<CapturedProviderRequest> {
    return this.#request.promise;
  }

  waitForDisconnect(): Promise<void> {
    return this.#disconnect.promise;
  }

  get requestCount(): number {
    return this.#requestCount;
  }

  releaseSuccess(text: string): void {
    const body = JSON.stringify({
      id: "actor-response-1",
      model: "deepseek-chat",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    });
    this.#release.resolve({ status: 200, body });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#release.resolve({ status: 503, body: JSON.stringify({ error: "test cleanup" }) });
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function deferred<T>() {
  let resolved = false;
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
  });
  return {
    promise,
    resolve: resolvePromise,
    settled: () => resolved,
  };
}

function runtimeEventTypes(databasePath: string, runId: string, aggregateType: string): string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare(
      "SELECT event_type FROM runtime_events WHERE run_id = ? AND aggregate_type = ? ORDER BY run_sequence",
    ).all(runId, aggregateType) as Array<{ event_type: string }>).map((row) => row.event_type);
  } finally {
    database.close();
  }
}

function runtimeEventRecords(
  databasePath: string,
  runId: string,
  aggregateType: string,
): Array<{ eventType: string; payload: Record<string, unknown> }> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare(
      "SELECT event_type, payload_json FROM runtime_events WHERE run_id = ? AND aggregate_type = ? ORDER BY run_sequence",
    ).all(runId, aggregateType) as Array<{ event_type: string; payload_json: string }>).map((row) => ({
      eventType: row.event_type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  } finally {
    database.close();
  }
}

function terminateRecordedProcess(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Recorded Runtime PID is invalid.");
  process.kill(pid, "SIGKILL");
}
