import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeV2ProcessSupervisor, RuntimeV2SupervisorError } from "../../src/main/runtimeV2ProcessSupervisor";

const roots: string[] = [];
const supervisors: RuntimeV2ProcessSupervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("RuntimeV2ProcessSupervisor", () => {
  it("completes a strict correlated handshake and sends the configured initialize payload", async () => {
    const fixture = createFixture("success");
    const supervisor = createSupervisor(fixture);

    const handshake = await supervisor.start();

    expect(handshake.hello.payload.protocolVersions).toContain(1);
    expect(handshake.ready.correlationId).toBe(JSON.parse(fs.readFileSync(fixture.capturePath, "utf8")).messageId);
    expect(JSON.parse(fs.readFileSync(fixture.capturePath, "utf8"))).toMatchObject({
      protocolVersion: 1,
      messageType: "command",
      name: "runtime.initialize",
      payload: {
        application: { id: "novelx.desktop", version: "0.2.7", commit: "desktop-test" },
        workspaceDatabasePath: null,
        projectRootPath: null,
        projectId: null,
        workspaceId: null,
        featureFlags: { runtime_v2: true },
        hostCapabilityVersions: { project_tools: "1.0.0" },
      },
    });
  });

  it("sends projectRootPath independently from workspaceDatabasePath", async () => {
    const fixture = createFixture("success");
    const supervisor = createSupervisor(fixture, {
      workspaceDatabasePath: "D:\\NovelXRuntime\\workspace.db",
      projectRootPath: "C:\\Creators\\SilverBay",
      projectId: "project-1",
      workspaceId: "workspace-1",
    });

    await supervisor.start();

    const initialize = JSON.parse(fs.readFileSync(fixture.capturePath, "utf8"));
    expect(initialize.payload).toMatchObject({
      workspaceDatabasePath: "D:\\NovelXRuntime\\workspace.db",
      projectRootPath: "C:\\Creators\\SilverBay",
    });
  });

  it.each([
    ["invalid-json", "RUNTIME_V2_INVALID_JSON"],
    ["unsupported-version", "RUNTIME_V2_PROTOCOL_VERSION_UNSUPPORTED"],
    ["bad-ready-correlation", "RUNTIME_V2_PROTOCOL_INVALID"],
    ["ready-identity-mismatch", "RUNTIME_V2_PROTOCOL_INVALID"],
    ["initialization-failed-bad-correlation", "RUNTIME_V2_PROTOCOL_INVALID"],
    ["initialization-failed-malformed", "RUNTIME_V2_PROTOCOL_INVALID"],
    ["unknown-second-message", "RUNTIME_V2_PROTOCOL_INVALID"],
    ["early-exit", "RUNTIME_V2_EXITED_BEFORE_READY"],
  ] as const)("rejects %s during startup", async (scenario, code) => {
    const supervisor = createSupervisor(createFixture(scenario), { startupTimeoutMs: 3_000 });
    await expect(supervisor.start()).rejects.toMatchObject({ code });
  });

  it("times out a runtime that produces no startup output", async () => {
    const supervisor = createSupervisor(createFixture("no-output"), { startupTimeoutMs: 200 });
    await expect(supervisor.start()).rejects.toMatchObject({ code: "RUNTIME_V2_START_TIMEOUT" });
  });

  it("captures stderr and includes it when the child exits early", async () => {
    const diagnostics: string[] = [];
    const supervisor = createSupervisor(createFixture("stderr-exit"), { onStderr: (text) => diagnostics.push(text) });

    const error = await supervisor.start().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeV2SupervisorError);
    expect(error).toMatchObject({ code: "RUNTIME_V2_EXITED_BEFORE_READY" });
    expect((error as Error).message).toContain("controlled stderr");
    expect(supervisor.stderr).toContain("controlled stderr");
    expect(diagnostics.join("")).toContain("controlled stderr");
  });

  it("preserves a strict initialization failure payload and bounded stderr separately", async () => {
    const supervisor = createSupervisor(createFixture("initialization-failed"));

    const caught = await supervisor.start().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(RuntimeV2SupervisorError);
    const error = caught as RuntimeV2SupervisorError;
    expect(error.code).toBe("RUNTIME_V2_INITIALIZATION_FAILED");
    expect(error.message).toBe("Runtime storage integrity check failed.");
    expect(error.publicPayload).toEqual({
      code: "RUNTIME_JOURNAL_INTEGRITY_FAILED",
      class: "storage",
      retryable: false,
      publicMessage: "Runtime storage integrity check failed.",
      stage: "runtime.initialize",
      attempt: 1,
      diagnosticId: "d6a03646-04ef-4b3e-9639-47b2a843f3a2",
    });
    expect(error.publicPayload?.publicMessage).not.toContain("internal fixture stderr");
    expect(error.stderr).toContain("internal fixture stderr");
    expect(error.stderr.length).toBeLessThanOrEqual(16_000);
  });

  it("reports an executable spawn failure without touching unrelated processes", async () => {
    const fixture = createFixture("success");
    const supervisor = createSupervisor(fixture, {
      executablePath: path.join(fixture.scriptPath, "missing-runtime.exe"),
      startupTimeoutMs: 100,
      stopTimeoutMs: 100,
    });

    await expect(supervisor.start()).rejects.toMatchObject({ code: "RUNTIME_V2_SPAWN_FAILED" });
    expect(supervisor.pid).toBeNull();
  });

  it("rejects a second start while the recorded runtime process is active", async () => {
    const supervisor = createSupervisor(createFixture("success"));
    await supervisor.start();

    await expect(supervisor.start()).rejects.toMatchObject({ code: "RUNTIME_V2_ALREADY_STARTED" });
  });

  it("keeps the protocol connection open for correlated status and graceful shutdown", async () => {
    const supervisor = createSupervisor(createFixture("success"));
    await supervisor.start();

    await expect(supervisor.status()).resolves.toEqual({
      initialized: true,
      workspaceDatabaseConfigured: false,
      recoveredRunCount: 0,
      protocolVersion: 1,
      runtimeVersion: "0.1.0",
    });

    const pid = supervisor.pid!;
    await supervisor.stop();
    expect(supervisor.pid).toBeNull();
    expect(isAlive(pid)).toBe(false);
  });

  it("delivers strict unsolicited events without completing the pending response", async () => {
    const events: Array<{ name: string; sequence: number; correlationId: string | null }> = [];
    const supervisor = createSupervisor(createFixture("event-before-status"));
    const unsubscribe = supervisor.subscribeRuntimeEvents((event) => events.push({
      name: event.name,
      sequence: event.sequence,
      correlationId: event.correlationId,
    }));
    await supervisor.start();

    await expect(supervisor.status()).resolves.toMatchObject({ initialized: true });
    expect(events).toEqual([{ name: "runtime.error", sequence: 3, correlationId: null }]);

    unsubscribe();
    await expect(supervisor.status()).resolves.toMatchObject({ initialized: true });
    expect(events).toHaveLength(1);
  });

  it.each(["unknown-event-on-status", "bad-event-sequence", "orphan-correlated-event"] as const)(
    "fails closed for %s instead of treating it as a pending response",
    async (scenario) => {
      const failures: RuntimeV2SupervisorError[] = [];
      const supervisor = createSupervisor(createFixture(scenario), {
        onRuntimeFailure: (error) => failures.push(error),
      });
      await supervisor.start();

      await expect(supervisor.status()).rejects.toMatchObject({ code: "RUNTIME_V2_PROTOCOL_INVALID" });
      expect(failures).toHaveLength(1);
    },
  );

  it("registers an accepted inference before an immediately following terminal event", async () => {
    const events: string[] = [];
    const supervisor = createSupervisor(createFixture("inference-terminal-immediate"));
    supervisor.subscribeRuntimeEvents((event) => events.push(event.name));
    await supervisor.start();

    const accepted = await supervisor.startProviderInference(INFERENCE_RUN_ID, inferenceStartPayload());
    await waitUntil(() => events.length === 1);

    expect(accepted).toMatchObject({
      runId: INFERENCE_RUN_ID,
      inferenceId: INFERENCE_ID,
      attemptId: INFERENCE_ATTEMPT_ID,
    });
    expect(events).toEqual(["provider.inference.completed"]);
  });

  it("reconciles a Run through a strict receipt and refreshed snapshot", async () => {
    const supervisor = createSupervisor(createFixture("reconcile-success"));
    await supervisor.start();
    const result = await supervisor.reconcileRun(INFERENCE_RUN_ID, {
      reconciliationIdempotencyKey: "reconcile-1",
      attemptId: INFERENCE_ATTEMPT_ID,
      decision: "retry_as_new_attempt_acknowledging_duplicate",
      duplicateExecutionAcknowledged: true,
    });
    expect(result.receipt).toEqual({
      attemptId: INFERENCE_ATTEMPT_ID,
      decision: "retry_as_new_attempt_acknowledging_duplicate",
      state: "retrying",
    });
    expect(result.snapshot).toMatchObject({ runId: INFERENCE_RUN_ID, state: "retrying" });
  });

  it.each([
    ["reconcile-rejected", "RUNTIME_V2_RUN_REJECTED"],
    ["reconcile-identity-mismatch", "RUNTIME_V2_PROTOCOL_INVALID"],
  ] as const)("fails closed for %s", async (scenario, code) => {
    const supervisor = createSupervisor(createFixture(scenario));
    await supervisor.start();
    await expect(supervisor.reconcileRun(INFERENCE_RUN_ID, {
      reconciliationIdempotencyKey: "reconcile-1", attemptId: INFERENCE_ATTEMPT_ID,
      decision: "retry_as_new_attempt_acknowledging_duplicate", duplicateExecutionAcknowledged: true,
    })).rejects.toMatchObject({ code });
  });

  it.each(["inference-terminal-identity-mismatch", "inference-terminal-duplicate"] as const)(
    "fails closed for %s",
    async (scenario) => {
      const failures: RuntimeV2SupervisorError[] = [];
      const supervisor = createSupervisor(createFixture(scenario), {
        onRuntimeFailure: (error) => failures.push(error),
      });
      await supervisor.start();

      await supervisor.startProviderInference(INFERENCE_RUN_ID, inferenceStartPayload());
      await waitUntil(() => failures.length === 1);

      expect(failures[0]).toMatchObject({ code: "RUNTIME_V2_PROTOCOL_INVALID" });
      expect(supervisor.pid).toBeNull();
    },
  );

  it("binds a Provider through the sensitive command path and exposes only a safe receipt", async () => {
    const supervisor = createSupervisor(createFixture("success"));
    await supervisor.start();

    const receipt = await supervisor.bindProvider(providerConfig(), "a".repeat(64), "unit-secret-key");

    expect(receipt).toEqual({
      profileId: "profile-1",
      providerId: "deepseek",
      modelId: "deepseek-chat",
      configSha256: "a".repeat(64),
      contextWindow: 1_000_000,
      maxTokens: null,
    });
    expect(JSON.stringify(receipt)).not.toContain("unit-secret-key");
    expect(supervisor.stderr).not.toContain("unit-secret-key");
  });

  it("reports an unexpected post-ready crash and rejects an in-flight command", async () => {
    const failures: RuntimeV2SupervisorError[] = [];
    const supervisor = createSupervisor(createFixture("exit-on-status"), {
      onRuntimeFailure: (error) => failures.push(error),
    });
    await supervisor.start();

    await expect(supervisor.status()).rejects.toMatchObject({ code: "RUNTIME_V2_EXITED_AFTER_READY" });
    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe("RUNTIME_V2_EXITED_AFTER_READY");
  });

  it("treats a command timeout as an unknown connection state and tears down the runtime", async () => {
    const failures: RuntimeV2SupervisorError[] = [];
    const supervisor = createSupervisor(createFixture("ignore-status"), {
      commandTimeoutMs: 50,
      stopTimeoutMs: 100,
      onRuntimeFailure: (error) => failures.push(error),
    });
    await supervisor.start();
    const pid = supervisor.pid!;

    await expect(supervisor.status()).rejects.toMatchObject({ code: "RUNTIME_V2_COMMAND_TIMEOUT" });
    await waitUntil(() => supervisor.pid === null && !isAlive(pid));
    expect(failures.map((error) => error.code)).toEqual(["RUNTIME_V2_COMMAND_TIMEOUT"]);
    expect(isAlive(pid)).toBe(false);
  });

  it("stops by stdin EOF and force-terminates only its recorded child tree after timeout", async () => {
    const normal = createSupervisor(createFixture("success"));
    await normal.start();
    const normalPid = normal.pid!;
    await normal.stop();
    expect(isAlive(normalPid)).toBe(false);

    const stubborn = createSupervisor(createFixture("ignore-eof"), { stopTimeoutMs: 100 });
    await stubborn.start();
    const stubbornPid = stubborn.pid!;
    await stubborn.stop();
    expect(isAlive(stubbornPid)).toBe(false);
  });
});

function createSupervisor(
  fixture: Fixture,
  overrides: Partial<ConstructorParameters<typeof RuntimeV2ProcessSupervisor>[0]> = {},
): RuntimeV2ProcessSupervisor {
  const supervisor = new RuntimeV2ProcessSupervisor({
    executablePath: process.execPath,
    executableArgs: [fixture.scriptPath, fixture.scenario, fixture.capturePath],
    application: { id: "novelx.desktop", version: "0.2.7", commit: "desktop-test" },
    workspaceDatabasePath: null,
    projectRootPath: null,
    projectId: null,
    workspaceId: null,
    featureFlags: { runtime_v2: true },
    hostCapabilityVersions: { project_tools: "1.0.0" },
    startupTimeoutMs: 3_000,
    stopTimeoutMs: 500,
    ...overrides,
  });
  supervisors.push(supervisor);
  return supervisor;
}

interface Fixture { scriptPath: string; capturePath: string; scenario: string }

function createFixture(scenario: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-runtime-v2-supervisor-"));
  roots.push(root);
  const scriptPath = path.join(root, "fixture.cjs");
  const capturePath = path.join(root, "initialize.json");
  fs.writeFileSync(scriptPath, FIXTURE_SOURCE, "utf8");
  return { scriptPath, capturePath, scenario };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function providerConfig() {
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

const INFERENCE_RUN_ID = "57e76f0e-934e-4d35-9bf8-37963836fe87";
const INFERENCE_ID = "c837a70c-7547-453f-971f-8ab2b36368ed";
const INFERENCE_ATTEMPT_ID = "d3f55d5e-da1f-40d7-b061-7106a9238c21";
const INFERENCE_COMPILATION_ID = "51663fc0-144a-48ec-8f71-fd31c82e36a8";

function inferenceStartPayload() {
  return {
    inferenceId: INFERENCE_ID,
    attemptId: INFERENCE_ATTEMPT_ID,
    contextCompilationId: INFERENCE_COMPILATION_ID,
    requestNumber: 1,
    attemptNumber: 1,
    invocationId: "run-1:steward",
    inferenceIdempotencyKey: "inference-start-1",
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const FIXTURE_SOURCE = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const { createHash, randomUUID } = require("node:crypto");
const scenario = process.argv[2];
const capturePath = process.argv[3];
const now = new Date().toISOString();
const envelope = (version, name, payload, correlationId = null, sequence = 1, messageType = "control") => ({
  protocolVersion: version, messageId: randomUUID(), messageType, name, sentAt: now,
  correlationId, runId: null, sequence, payload,
});
const pinnedIdentity = () => {
  const policy = (id, digit) => ({ id, version: "1.0.0", sha256: digit.repeat(64) });
  return {
    projectId: "project-1", workspaceId: "workspace-1", sessionId: "session-1", sessionBranchId: "branch-1",
    userMessageId: "message-1", projectBranchId: "project-branch-1", goal: null, plan: null,
    provider: { profileId: "profile-1", providerId: "deepseek", modelId: "deepseek-chat", configSha256: "a".repeat(64) },
    promptBundle: policy("prompt", "b"), agentProfile: policy("agent", "c"), toolPolicy: policy("tool", "d"),
    contextPolicy: policy("context", "e"), runtimePolicy: policy("runtime", "f"), runtimeContractVersion: "1.0.0",
    mode: "assist", sourceCheckpointId: "checkpoint-1", scopeResourceIds: ["resource-1"],
    resourceScopeSha256: "1".repeat(64), userInputSha256: "2".repeat(64),
  };
};
if (scenario === "invalid-json") { process.stdout.write("not-json\n"); return; }
if (scenario === "stderr-exit") { process.stderr.write("controlled stderr\n"); process.exit(7); }
if (scenario === "early-exit") process.exit(6);
if (scenario === "no-output") { setInterval(() => {}, 1000); return; }
const version = scenario === "unsupported-version" ? 2 : 1;
process.stdout.write(JSON.stringify(envelope(version, "runtime.hello", {
  runtimeVersion: "0.1.0", protocolVersions: [version], capabilities: ["handshake"],
  build: { commit: "fixture", target: "win32-x64" },
})) + "\n");
const input = readline.createInterface({ input: process.stdin });
let initialized = false;
let runtimeSequence = 2;
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (initialized) {
    runtimeSequence += 1;
    if (scenario === "exit-on-status" && command.name === "runtime.status.get") process.exit(9);
    if (scenario === "ignore-status" && command.name === "runtime.status.get") return;
    if (command.name === "provider.inference.start" && scenario.startsWith("inference-terminal-")) {
      const identity = {
        runId: command.runId,
        inferenceId: command.payload.inferenceId,
        attemptId: command.payload.attemptId,
        contextCompilationId: command.payload.contextCompilationId,
        requestNumber: command.payload.requestNumber,
        attemptNumber: command.payload.attemptNumber,
      };
      const acceptedEnvelope = envelope(
        1, "provider.inference.accepted", identity, command.messageId, runtimeSequence, "response",
      );
      acceptedEnvelope.runId = command.runId;
      process.stdout.write(JSON.stringify(acceptedEnvelope) + "\n");
      runtimeSequence += 1;
      const terminalIdentity = scenario === "inference-terminal-identity-mismatch"
        ? { ...identity, attemptId: randomUUID() }
        : identity;
      const completed = {
        ...terminalIdentity,
        providerId: "deepseek",
        modelId: "deepseek-chat",
        responseIdSha256: "3".repeat(64),
        responseBodySha256: "4".repeat(64),
        stopReason: "stop",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        output: { text: "done", textSha256: createHash("sha256").update("done", "utf8").digest("hex"), utf8Bytes: 4 },
        toolCalls: [],
      };
      const completedEnvelope = envelope(
        1, "provider.inference.completed", completed, command.messageId, runtimeSequence, "event",
      );
      completedEnvelope.runId = command.runId;
      process.stdout.write(JSON.stringify(completedEnvelope) + "\n");
      if (scenario === "inference-terminal-duplicate") {
        runtimeSequence += 1;
        const duplicateEnvelope = envelope(
          1, "provider.inference.completed", completed, command.messageId, runtimeSequence, "event",
        );
        duplicateEnvelope.runId = command.runId;
        process.stdout.write(JSON.stringify(duplicateEnvelope) + "\n");
      }
      return;
    }
    if (command.name === "run.reconcile" && scenario.startsWith("reconcile-")) {
      if (scenario === "reconcile-rejected") {
        const rejected = envelope(1, "run.rejected", {
          code: "RUN_RECONCILIATION_REJECTED", class: "validation", retryable: false,
          publicMessage: "Run reconciliation was rejected.", stage: "run.reconcile", attempt: 0, diagnosticId: randomUUID(),
        }, command.messageId, runtimeSequence, "response");
        rejected.runId = command.runId;
        process.stdout.write(JSON.stringify(rejected) + "\n");
        return;
      }
      const receipt = {
        attemptId: scenario === "reconcile-identity-mismatch" ? randomUUID() : command.payload.attemptId,
        decision: command.payload.decision, state: "retrying",
      };
      const response = envelope(1, "run.reconciled", receipt, command.messageId, runtimeSequence, "response");
      response.runId = command.runId;
      process.stdout.write(JSON.stringify(response) + "\n");
      return;
    }
    if (command.name === "run.get" && scenario === "reconcile-success") {
      const snapshot = {
        runId: command.runId, pinnedIdentity: pinnedIdentity(), state: "retrying", recoveryClassification: "resumable",
        runSequence: 5, aggregateSequence: 4, createdAt: now, updatedAt: now, terminalError: null,
      };
      const response = envelope(1, "run.snapshot", snapshot, command.messageId, runtimeSequence, "response");
      response.runId = command.runId;
      process.stdout.write(JSON.stringify(response) + "\n");
      return;
    }
    if (command.name === "runtime.status.get" && scenario === "unknown-event-on-status") {
      process.stdout.write(JSON.stringify(envelope(1, "runtime.future", {}, null, runtimeSequence, "event")) + "\n");
      return;
    }
    if (command.name === "runtime.status.get" && scenario === "bad-event-sequence") {
      process.stdout.write(JSON.stringify(envelope(1, "runtime.error", {
        code: "RUNTIME_BUSY", class: "validation", retryable: true, publicMessage: "Runtime is busy.",
        stage: "runtime.actor", attempt: 0, diagnosticId: randomUUID(),
      }, null, runtimeSequence + 1, "event")) + "\n");
      return;
    }
    if (command.name === "runtime.status.get" && scenario === "orphan-correlated-event") {
      process.stdout.write(JSON.stringify(envelope(1, "runtime.error", {
        code: "RUNTIME_BUSY", class: "validation", retryable: true, publicMessage: "Runtime is busy.",
        stage: "runtime.actor", attempt: 0, diagnosticId: randomUUID(),
      }, randomUUID(), runtimeSequence, "event")) + "\n");
      return;
    }
    if (command.name === "provider.bind") {
      process.stdout.write(JSON.stringify(envelope(1, "provider.bound", {
        profileId: command.payload.config.profileId,
        providerId: command.payload.config.providerId,
        modelId: command.payload.config.modelId,
        configSha256: command.payload.configSha256,
        contextWindow: command.payload.config.contextWindow,
        maxTokens: command.payload.config.maxTokens,
      }, command.messageId, runtimeSequence, "response")) + "\n");
      return;
    }
    if (command.name === "runtime.status.get") {
      if (scenario === "event-before-status") {
        process.stdout.write(JSON.stringify(envelope(1, "runtime.error", {
          code: "RUNTIME_BUSY", class: "validation", retryable: true, publicMessage: "Runtime is busy.",
          stage: "runtime.actor", attempt: 0, diagnosticId: randomUUID(),
        }, null, runtimeSequence, "event")) + "\n");
        runtimeSequence += 1;
      }
      process.stdout.write(JSON.stringify(envelope(1, "runtime.status", {
        initialized: true, workspaceDatabaseConfigured: false, recoveredRunCount: 0,
        protocolVersion: 1, runtimeVersion: "0.1.0",
      }, command.messageId, runtimeSequence, "response")) + "\n");
      return;
    }
    if (command.name === "runtime.shutdown") {
      process.stdout.write(JSON.stringify(envelope(
        1, "runtime.stopped", { reason: "requested" }, command.messageId, runtimeSequence, "response",
      )) + "\n", () => process.exit(0));
    }
    return;
  }
  initialized = true;
  fs.writeFileSync(capturePath, JSON.stringify(command), "utf8");
  const correlationId = scenario === "bad-ready-correlation" ? randomUUID() : command.messageId;
  if (scenario.startsWith("initialization-failed")) {
    process.stderr.write("internal fixture stderr\n");
    const failureCorrelation = scenario === "initialization-failed-bad-correlation" ? randomUUID() : command.messageId;
    const payload = {
      code: "RUNTIME_JOURNAL_INTEGRITY_FAILED", class: "storage", retryable: false,
      publicMessage: "Runtime storage integrity check failed.", stage: "runtime.initialize", attempt: 1,
      diagnosticId: "d6a03646-04ef-4b3e-9639-47b2a843f3a2",
    };
    if (scenario === "initialization-failed-malformed") delete payload.diagnosticId;
    setTimeout(() => process.stdout.write(JSON.stringify(envelope(
      1, "runtime.initialization_failed", payload, failureCorrelation, 2,
    )) + "\n"), 20);
    return;
  }
  if (scenario === "unknown-second-message") {
    process.stdout.write(JSON.stringify(envelope(1, "runtime.future", {}, command.messageId, 2)) + "\n");
    return;
  }
  const runtimeVersion = scenario === "ready-identity-mismatch" ? "0.2.0" : "0.1.0";
  process.stdout.write(JSON.stringify(envelope(1, "runtime.ready", {
    selectedProtocolVersion: 1, runtime: { version: runtimeVersion, build: { commit: "fixture", target: "win32-x64" } },
    recoveredRunCount: 0,
  }, correlationId, 2)) + "\n");
});
if (scenario === "ignore-eof") { process.stdin.resume(); setInterval(() => {}, 1000); }
`;
