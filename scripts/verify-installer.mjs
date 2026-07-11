import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "@playwright/test";

const appRoot = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
assert(typeof packageJson.version === "string" && /^\d+\.\d+\.\d+$/.test(packageJson.version), "PACKAGE_VERSION_INVALID");
const installerPath = path.join(appRoot, "release", `novelx-Setup-${packageJson.version}-x64.exe`);
assertFile(installerPath, "INSTALLER_MISSING");
assertNoProductionInstall();
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-installer-"));
const installRoot = path.join(testRoot, "novelx");
const roamingRoot = path.join(testRoot, "AppData", "Roaming");
const localRoot = path.join(testRoot, "AppData", "Local");
const installedUserDataRoot = path.join(testRoot, "UserData");
const evidencePath = path.join(appRoot, "test-results", "novax-installer-lifecycle.json");
const screenshotPath = path.join(appRoot, "test-results", "novax-installed-1280x720.png");
const environment = cleanProviderEnvironment({
  ...process.env,
  APPDATA: roamingRoot,
  LOCALAPPDATA: localRoot,
});

fs.mkdirSync(path.dirname(evidencePath), { recursive: true });

let completed = false;
try {
  await run(installerPath, ["/S", `/D=${installRoot}`], environment, 180_000);
  const executablePath = path.join(installRoot, "novelx.exe");
  assertFile(executablePath, "INSTALLED_EXECUTABLE_MISSING");

  const firstLaunch = await verifyInstalledWindow(executablePath, environment, installedUserDataRoot, screenshotPath);
  fs.mkdirSync(firstLaunch.userDataPath, { recursive: true });
  const retentionMarker = path.join(firstLaunch.userDataPath, "installer-retention.marker");
  fs.writeFileSync(retentionMarker, "novax-installer-retention", "utf8");

  const secondLaunch = await verifyInstalledWindow(executablePath, environment, installedUserDataRoot);
  assert(secondLaunch.userDataPath === firstLaunch.userDataPath, "INSTALLED_USER_DATA_PATH_CHANGED");
  assert(fs.readFileSync(retentionMarker, "utf8") === "novax-installer-retention", "RESTART_DID_NOT_RETAIN_USER_DATA");

  const uninstallerPath = findUninstaller(installRoot);
  await run(uninstallerPath, ["/S"], environment, 180_000);
  await waitFor(() => !fs.existsSync(executablePath), 30_000, "UNINSTALL_DID_NOT_REMOVE_EXECUTABLE");
  assert(fs.existsSync(retentionMarker), "UNINSTALL_REMOVED_USER_DATA");

  const installerSignatureStatus = getSignatureStatus(installerPath);
  const appSignatureStatus = getSignatureStatus(path.join(appRoot, "release", "win-unpacked", "novelx.exe"));
  const report = {
    ok: true,
    installedTwice: true,
    uninstallRemovedApplication: true,
    uninstallRetainedUserData: true,
    installerBytes: fs.statSync(installerPath).size,
    installerSignatureStatus,
    appSignatureStatus,
    signed: installerSignatureStatus === "Valid" && appSignatureStatus === "Valid",
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  completed = true;
} finally {
  if (completed) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`INSTALLER_TEST_ROOT_PRESERVED:${testRoot}\n`);
  }
}

async function verifyInstalledWindow(executablePath, env, userDataRoot, screenshot) {
  let app;
  try {
    app = await electron.launch({ executablePath, args: [`--user-data-dir=${userDataRoot}`], env });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 720 });
    assert(await page.title() === "novelx", "INSTALLED_WINDOW_TITLE_INVALID");
    const state = await page.evaluate(async () => ({
      apiType: typeof globalThis.novaxDesktop,
      workspace: await globalThis.novaxDesktop.workspace.getCurrent(),
      system: await globalThis.novaxDesktop.system.getStatus(),
      body: document.body.innerText,
    }));
    assert(state.apiType === "object", "INSTALLED_PRELOAD_MISSING");
    assert(state.workspace === null, "INSTALLED_WINDOW_SHOULD_START_WITHOUT_WORKSPACE");
    assert(state.system.platform === "win32", "INSTALLED_PLATFORM_INVALID");
    assert(!/apiKey|workspace\.db|rawJson|debugMessage/i.test(state.body), "INSTALLED_WINDOW_LEAKED_INTERNAL_TEXT");
    const userDataPath = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    if (screenshot) await page.screenshot({ path: screenshot, fullPage: false });
    const closed = app.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await closed;
    app = undefined;
    return { userDataPath };
  } finally {
    if (app) await app.close();
  }
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

async function waitFor(predicate, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(code);
}

function getSignatureStatus(target) {
  const script = "(Get-AuthenticodeSignature -LiteralPath $env:NOVAX_SIGNATURE_TARGET).Status.ToString()";
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, NOVAX_SIGNATURE_TARGET: target },
    windowsHide: true,
  }).trim();
}

function assertNoProductionInstall() {
  const script = [
    "$items = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue",
    "$match = $items | Where-Object { $_.DisplayName -match '^novelx(?:\\s|$)' } | Select-Object -First 1",
    "if ($match) { Write-Output $match.UninstallString }",
  ].join("; ");
  const installed = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  assert(!installed, `PRODUCTION_INSTALL_DETECTED:${installed}`);
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
