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
        projectId: null,
        workspaceId: null,
        featureFlags: { runtime_v2: true },
        hostCapabilityVersions: { project_tools: "1.0.0" },
      },
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
    ["no-output", "RUNTIME_V2_START_TIMEOUT"],
  ] as const)("rejects %s during startup", async (scenario, code) => {
    const supervisor = createSupervisor(createFixture(scenario), { startupTimeoutMs: 150 });
    await expect(supervisor.start()).rejects.toMatchObject({ code });
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
    projectId: null,
    workspaceId: null,
    featureFlags: { runtime_v2: true },
    hostCapabilityVersions: { project_tools: "1.0.0" },
    startupTimeoutMs: 1_000,
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
const { randomUUID } = require("node:crypto");
const scenario = process.argv[2];
const capturePath = process.argv[3];
const now = new Date().toISOString();
const envelope = (version, name, payload, correlationId = null, sequence = 1, messageType = "control") => ({
  protocolVersion: version, messageId: randomUUID(), messageType, name, sentAt: now,
  correlationId, runId: null, sequence, payload,
});
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
    if (command.name === "runtime.status.get") {
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
