import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runtimeRoot = path.join(appRoot, "runtime");
const runtimeExecutable = path.join(
  runtimeRoot,
  "target",
  "debug",
  process.platform === "win32" ? "novelx-runtime.exe" : "novelx-runtime",
);
const BUILD_TIMEOUT_MS = 120_000;

export function buildRuntimeV2ForTests(): void {
  const startedAt = Date.now();
  const build = spawnSync("cargo", [
    "build",
    "--manifest-path",
    path.join(runtimeRoot, "Cargo.toml"),
    "--bin",
    "novelx-runtime",
  ], {
    cwd: runtimeRoot,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (build.error) {
    const code = (build.error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const reason = code === "ETIMEDOUT" ? "timeout" : "spawn_error";
    reportBuildFailure(reason, code, build.signal);
    if (code === "ETIMEDOUT") {
      throw new Error(
        `Runtime V2 Cargo build timed out after ${BUILD_TIMEOUT_MS}ms (signal=${build.signal ?? "none"}).`,
        { cause: build.error },
      );
    }
    throw new Error(`Runtime V2 Cargo build could not start (code=${code}, signal=${build.signal ?? "none"}).`, { cause: build.error });
  }
  if (build.signal !== null) {
    reportBuildFailure("signal", null, build.signal);
    throw new Error(`Runtime V2 Cargo build terminated by signal ${build.signal}.`);
  }
  if (build.status !== 0) {
    reportBuildFailure("nonzero_exit", String(build.status), null);
    throw new Error(`Runtime V2 Cargo build failed.\n${build.stdout}\n${build.stderr}`);
  }
  if (!fs.existsSync(runtimeExecutable) || !fs.statSync(runtimeExecutable).isFile()) {
    throw new Error(`Runtime V2 Cargo build did not produce ${runtimeExecutable}.`);
  }
  process.stdout.write(`[novelx-runtime-test-build] ${JSON.stringify({
    schemaVersion: 1,
    status: "built",
    elapsedMs: Date.now() - startedAt,
    executable: path.relative(appRoot, runtimeExecutable).replaceAll("\\", "/"),
  })}\n`);
}

function reportBuildFailure(reason: string, code: string | null, signal: NodeJS.Signals | null): void {
  process.stderr.write(`[novelx-runtime-test-build] ${JSON.stringify({
    schemaVersion: 1,
    status: "failed",
    reason,
    code,
    signal,
    timeoutMs: BUILD_TIMEOUT_MS,
  })}\n`);
}
