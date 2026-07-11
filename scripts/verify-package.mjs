import { createRequire } from "node:module";
import { execFileSync, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "@playwright/test";

const require = createRequire(import.meta.url);
const { listPackage } = require("@electron/asar");
const appRoot = path.resolve(import.meta.dirname, "..");
const unpackedRoot = path.join(appRoot, "release", "win-unpacked");
const executablePath = path.join(unpackedRoot, "novelx.exe");
const asarPath = path.join(unpackedRoot, "resources", "app.asar");

assertFile(executablePath, "PACKAGED_EXECUTABLE_MISSING");
assertFile(asarPath, "PACKAGED_ASAR_MISSING");

const entries = listPackage(asarPath);
for (const required of [
  "\\out\\main\\index.js",
  "\\out\\main\\agent-worker.js",
  "\\out\\preload\\index.cjs",
  "\\out\\renderer\\index.html",
  "\\node_modules\\@earendil-works\\pi-ai\\package.json",
  "\\node_modules\\@earendil-works\\pi-agent-core\\package.json",
]) {
  assert(entries.includes(required), `ASAR_REQUIRED_ENTRY_MISSING:${required}`);
}

const forbiddenEntry = entries.find((entry) =>
  /(?:^|\\)(?:tests?|test-results|playwright-report|coverage|workspace\.db|provider-profile\.v1\.json|prompt-eval-runner(?:\.js)?|offlineAdversarialFixtures(?:\.js)?|\.novax)(?:\\|$)/i.test(entry));
assert(!forbiddenEntry, `ASAR_FORBIDDEN_ENTRY:${forbiddenEntry}`);

await verifyPackagedWorker();
await verifyPackagedWindow();

const executableBytes = fs.statSync(executablePath).size;
const asarBytes = fs.statSync(asarPath).size;
const totalBytes = directorySize(unpackedRoot);
const signatureStatus = getSignatureStatus(executablePath);
process.stdout.write(`${JSON.stringify({
  ok: true,
  executablePath,
  entries: entries.length,
  executableBytes,
  asarBytes,
  totalBytes,
  signed: signatureStatus === "Valid",
  signatureStatus,
}, null, 2)}\n`);

async function verifyPackagedWorker() {
  const workerPath = path.join(unpackedRoot, "resources", "app.asar", "out", "main", "agent-worker.js");
  const child = fork(workerPath, [], {
    execPath: executablePath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PACKAGED_WORKER_TIMEOUT")), 15_000);
      child.once("error", reject);
      child.on("message", (payload) => {
        if (!payload || typeof payload !== "object" || payload.type !== "runtime.ready") return;
        clearTimeout(timer);
        resolve(payload);
      });
      child.send({ type: "runtime.self-test" });
    });
    assert(result.piLoaded === true, "PACKAGED_PI_NOT_LOADED");
    assert(result.promptRegistryVerified === true, "PACKAGED_PROMPT_REGISTRY_NOT_VERIFIED");
  } finally {
    child.kill();
  }
}

async function verifyPackagedWindow() {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novax-package-user-data-"));
  let app;
  try {
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataRoot}`],
      env: cleanProviderEnvironment(process.env),
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 720 });
    assert(await page.title() === "novelx", "PACKAGED_WINDOW_TITLE_INVALID");
    const state = await page.evaluate(async () => ({
      apiType: typeof globalThis.novaxDesktop,
      workspace: await globalThis.novaxDesktop.workspace.getCurrent(),
      system: await globalThis.novaxDesktop.system.getStatus(),
      body: document.body.innerText,
    }));
    assert(state.apiType === "object", "PACKAGED_PRELOAD_MISSING");
    assert(state.workspace === null, "PACKAGED_WINDOW_SHOULD_START_WITHOUT_WORKSPACE");
    assert(state.system.platform === "win32", "PACKAGED_PLATFORM_INVALID");
    assert(!/apiKey|workspace\.db|rawJson|debugMessage/i.test(state.body), "PACKAGED_WINDOW_LEAKED_INTERNAL_TEXT");
    await page.screenshot({ path: path.join(appRoot, "test-results", "novax-packaged-1280x720.png"), fullPage: false });
    const closed = app.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await closed;
    app = undefined;
  } finally {
    if (app) await app.close();
    fs.rmSync(userDataRoot, { recursive: true, force: true });
  }
}

function cleanProviderEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) =>
    typeof value === "string" && !key.startsWith("NOVAX_PROVIDER_")));
}

function assertFile(target, code) {
  assert(fs.existsSync(target) && fs.statSync(target).isFile(), code);
}

function directorySize(root) {
  return fs.readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const target = path.join(root, entry.name);
    return total + (entry.isDirectory() ? directorySize(target) : fs.statSync(target).size);
  }, 0);
}

function getSignatureStatus(target) {
  const script = "(Get-AuthenticodeSignature -LiteralPath $env:NOVAX_SIGNATURE_TARGET).Status.ToString()";
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, NOVAX_SIGNATURE_TARGET: target },
    windowsHide: true,
  }).trim();
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}
