import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "@playwright/test";

const appRoot = path.resolve(import.meta.dirname, "..");
const oldVersion = process.env.NOVAX_UPDATE_FROM_VERSION ?? "0.1.0";
const expectedVersion = process.env.NOVAX_UPDATE_EXPECTED_VERSION ?? "0.2.0";
const installerPath = path.join(appRoot, "release", `novelx-Setup-${oldVersion}-x64.exe`);
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-old-client-update-"));
const installRoot = path.join(testRoot, "novelx");
const userDataRoot = path.join(testRoot, "UserData");
const environment = cleanProviderEnvironment({
  ...process.env,
  APPDATA: path.join(testRoot, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(testRoot, "AppData", "Local"),
});
const evidencePath = path.join(appRoot, "test-results", `novax-update-${oldVersion}-to-${expectedVersion}.json`);

assertFile(installerPath, "OLD_INSTALLER_MISSING");
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });

let completed = false;
try {
  await run(installerPath, ["/S", `/D=${installRoot}`], environment, 180_000);
  const executablePath = path.join(installRoot, "novelx.exe");
  assertFile(executablePath, "OLD_CLIENT_EXECUTABLE_MISSING");

  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataRoot}`],
    env: environment,
  });
  let updateState;
  try {
    const page = await app.firstWindow();
    updateState = await page.evaluate(async ({ expectedVersion }) => {
      const terminalKinds = new Set(["available", "up_to_date", "error", "not_configured"]);
      const first = await globalThis.novaxDesktop.update.check();
      if (terminalKinds.has(first.kind)) return first;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error("UPDATE_CHECK_TIMEOUT"));
        }, 60_000);
        const unsubscribe = globalThis.novaxDesktop.update.subscribe((state) => {
          if (!terminalKinds.has(state.kind)) return;
          clearTimeout(timer);
          unsubscribe();
          resolve(state);
        });
        void globalThis.novaxDesktop.update.getStatus().then((state) => {
          if (state.kind === "available" && state.availableVersion === expectedVersion) {
            clearTimeout(timer);
            unsubscribe();
            resolve(state);
          }
        });
      });
    }, { expectedVersion });
  } finally {
    await app.close();
  }

  assert(updateState.kind === "available", `OLD_CLIENT_UPDATE_NOT_AVAILABLE:${updateState.kind}`);
  assert(updateState.currentVersion === oldVersion, `OLD_CLIENT_VERSION_MISMATCH:${updateState.currentVersion}`);
  assert(updateState.availableVersion === expectedVersion, `UPDATE_TARGET_VERSION_MISMATCH:${updateState.availableVersion}`);
  assert(updateState.canDownload === true, "OLD_CLIENT_CANNOT_DOWNLOAD_UPDATE");

  const uninstallerPath = findUninstaller(installRoot);
  await run(uninstallerPath, ["/S"], environment, 180_000);

  const report = {
    ok: true,
    checkedAt: new Date().toISOString(),
    sourceVersion: oldVersion,
    availableVersion: updateState.availableVersion,
    state: updateState.kind,
    canDownload: updateState.canDownload,
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  completed = true;
} finally {
  if (completed) {
    await removeWithRetry(testRoot);
  } else {
    process.stderr.write(`OLD_CLIENT_UPDATE_TEST_ROOT_PRESERVED:${testRoot}\n`);
  }
}

async function removeWithRetry(target) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

function findUninstaller(root) {
  const name = fs.readdirSync(root).find((entry) => /^uninstall.*\.exe$/i.test(entry));
  assert(name, "UNINSTALLER_MISSING");
  return path.join(root, name);
}

function run(executable, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PROCESS_TIMEOUT:${path.basename(executable)}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`PROCESS_EXITED:${path.basename(executable)}:${code}`));
    });
  });
}

function cleanProviderEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    typeof value === "string" && !key.startsWith("NOVAX_PROVIDER_")));
}

function assertFile(target, code) {
  assert(fs.existsSync(target) && fs.statSync(target).isFile(), code);
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}
