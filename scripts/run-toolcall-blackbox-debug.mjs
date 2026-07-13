import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestCli = path.join(appRoot, "node_modules", "vitest", "vitest.mjs");
const requestedCases = process.argv.slice(2)
  .flatMap((value) => value.split(","))
  .map((value) => value.trim())
  .filter(Boolean);

if (requestedCases.length === 0) {
  process.stderr.write("Usage: npm run test:debug:toolcall -- core_tools[,unicode]\n");
  process.exitCode = 2;
} else {
  const result = spawnSync(process.execPath, [
    vitestCli,
    "run",
    "--config",
    "vitest.integration.config.ts",
    "tests/integration/runtime-v2-toolcall-blackbox.contract.test.ts",
  ], {
    cwd: appRoot,
    env: {
      ...process.env,
      NOVELX_TEST_STAGE: "toolcall-debug",
      NOVELX_TOOLCALL_BLACKBOX_DEBUG_CASES: [...new Set(requestedCases)].join(","),
    },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) process.stderr.write(`[novelx-toolcall-debug-error] ${result.error.message}\n`);
  process.exitCode = result.status ?? 1;
}
