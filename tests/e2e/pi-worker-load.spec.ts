import { expect, test } from "@playwright/test";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("loads the built Agent Worker and Pi runtime in Electron Node mode", async () => {
  const workerPath = path.resolve("out/main/agent-worker.js");
  const response = await new Promise<unknown>((resolve, reject) => {
    const child = fork(workerPath, [], {
      execPath: electronPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for Agent Worker self-test."));
    }, 10_000);
    child.once("error", reject);
    child.once("message", (message) => {
      clearTimeout(timeout);
      child.kill();
      resolve(message);
    });
    child.once("spawn", () => child.send({ type: "runtime.self-test" }));
  });

  expect(response).toEqual({ type: "runtime.ready", piLoaded: true, promptRegistryVerified: true });
});

