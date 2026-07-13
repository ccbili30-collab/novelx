import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = path.join(appRoot, "tests");
const vitestCli = path.join(appRoot, "node_modules", "vitest", "vitest.mjs");
const stages = [
  { name: "unit", directory: path.join(testsRoot, "unit"), config: "vitest.config.ts" },
  { name: "integration", directory: path.join(testsRoot, "integration"), config: "vitest.integration.config.ts" },
];

const summary = {
  schemaVersion: 1,
  passed: false,
  skipPolicy: { kind: "zero_unexpected_skips", expectedSkipped: 0 },
  manifest: null,
  stages: [],
  orchestrationErrors: [],
};

try {
  summary.manifest = buildManifest();
  process.stdout.write(`[novelx-test-manifest] ${JSON.stringify(summary.manifest)}\n`);
  for (const stage of stages) runStage(stage, summary.stages);
} catch (error) {
  summary.orchestrationErrors.push(serializeError(error));
}

summary.passed = summary.orchestrationErrors.length === 0
  && summary.stages.length === stages.length
  && summary.stages.every((stage) => stage.exitCode === 0);
process.stdout.write(`\n[novelx-test-summary] ${JSON.stringify(summary)}\n`);
if (!summary.passed) process.exitCode = 1;

function buildManifest() {
  const allTestFiles = listTestFiles(testsRoot);
  const filesByStage = stages.map((stage) => ({ ...stage, files: listTestFiles(stage.directory) }));
  const stagedTestFiles = filesByStage.flatMap((stage) => stage.files);
  const stagedSet = new Set(stagedTestFiles);
  const unstaged = allTestFiles.filter((file) => !stagedSet.has(file));
  const overlaps = stagedTestFiles.filter((file, index) => stagedTestFiles.indexOf(file) !== index);
  if (overlaps.length > 0 || unstaged.length > 0 || stagedSet.size !== allTestFiles.length) {
    throw new Error(
      `Test stage manifest is incomplete or overlapping. Unstaged: ${unstaged.join(", ") || "none"}. `
      + `Overlapping: ${[...new Set(overlaps)].join(", ") || "none"}.`,
    );
  }
  return {
    status: "verified",
    totalFiles: allTestFiles.length,
    stages: filesByStage.map((stage) => ({ name: stage.name, files: stage.files.length })),
  };
}

function runStage(stage, results) {
  process.stdout.write(`\n[novelx-test-stage] ${stage.name}\n`);
  const result = spawnSync(process.execPath, [vitestCli, "run", "--config", stage.config], {
    cwd: appRoot,
    env: { ...process.env, NOVELX_TEST_STAGE: stage.name },
    stdio: "inherit",
    windowsHide: true,
  });
  const exitCode = result.status ?? 1;
  results.push({
    name: stage.name,
    status: result.error ? "spawn_failed" : exitCode === 0 ? "passed" : "failed",
    exitCode,
    signal: result.signal ?? null,
    expectedSkipped: 0,
  });
  if (result.error) process.stderr.write(`[novelx-test-stage-error] ${stage.name}: ${result.error.message}\n`);
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function listTestFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(resolved);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path.relative(appRoot, resolved).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}
