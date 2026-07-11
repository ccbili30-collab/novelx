import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RuntimeV2ProcessSupervisor } from "../../src/main/runtimeV2ProcessSupervisor";
import { RUNTIME_V2_PROTOCOL_VERSION } from "../../src/shared/runtimeV2Protocol";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runtimeRoot = path.join(appRoot, "runtime");
const runtimeExecutable = path.join(
  runtimeRoot,
  "target",
  "debug",
  process.platform === "win32" ? "novelx-runtime.exe" : "novelx-runtime",
);

let supervisor: RuntimeV2ProcessSupervisor | null = null;

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

    await supervisor.stop();

    expect(supervisor.pid).toBeNull();
    expect(isProcessAlive(ownedPid!)).toBe(false);
  }, 30_000);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
