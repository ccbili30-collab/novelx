import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RuntimeV2ProcessSupervisor } from "../../src/main/runtimeV2ProcessSupervisor";
import { RuntimeV2SupervisorError } from "../../src/main/runtimeV2ProcessSupervisor";
import { RUNTIME_V2_PROTOCOL_VERSION } from "../../src/shared/runtimeV2Protocol";
import type { RuntimeV2RunStartPayload } from "../../src/shared/runtimeV2Protocol";

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

    supervisor = createWorkspaceSupervisor(databasePath);
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

    supervisor = createWorkspaceSupervisor(databasePath);
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

    supervisor = createWorkspaceSupervisor(databasePath);
    const terminalRestart = await supervisor.start();
    expect(terminalRestart.ready.payload.recoveredRunCount).toBe(0);
    await expect(supervisor.getRun(runId)).resolves.toEqual(cancelled);
  }, 30_000);

  it("persists REAL_GM_PROVIDER_REQUIRED from run.prepare and recovers it after restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-runtime-v2-provider-required-"));
    tempRoots.push(root);
    const databasePath = path.join(root, "runtime.db");
    const runId = "3f7202b5-e640-4c9c-b86a-a549fd7e6ac8";

    supervisor = createWorkspaceSupervisor(databasePath);
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

    supervisor = createWorkspaceSupervisor(databasePath);
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

    supervisor = createWorkspaceSupervisor(databasePath);
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
});

function createWorkspaceSupervisor(databasePath: string): RuntimeV2ProcessSupervisor {
  return new RuntimeV2ProcessSupervisor({
    executablePath: runtimeExecutable,
    application: {
      id: "novelx.desktop.integration_test",
      version: "0.2.7",
      commit: "runtime-v2-real-run-test",
    },
    workspaceDatabasePath: databasePath,
    projectId: "project-1",
    workspaceId: "workspace-1",
    featureFlags: { runtime_v2: true },
    hostCapabilityVersions: { runtime_supervisor: "1.0.0" },
    startupTimeoutMs: 10_000,
    commandTimeoutMs: 10_000,
    stopTimeoutMs: 2_000,
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

function runtimeProviderConfig() {
  return {
    schemaVersion: 1 as const,
    profileId: "profile-1",
    providerId: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
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
