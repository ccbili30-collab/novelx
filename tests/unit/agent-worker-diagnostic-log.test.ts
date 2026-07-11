import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentWorkerDiagnosticReporter } from "../../src/main/agentWorkerDiagnosticLog";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Agent Worker diagnostic log", () => {
  it("records bounded process metadata without runtime payloads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-worker-diagnostic-"));
    roots.push(root);
    const report = createAgentWorkerDiagnosticReporter(root);
    report({
      runId: "run-1",
      event: "process_exit",
      phase: "runtime",
      exitCode: 1,
      signal: null,
      errorMessage: "x".repeat(700),
    });

    const entry = JSON.parse(fs.readFileSync(path.join(root, "agent-worker-diagnostics.jsonl"), "utf8")) as Record<string, unknown>;
    expect(entry).toMatchObject({
      runId: "run-1",
      event: "process_exit",
      phase: "runtime",
      exitCode: 1,
      signal: null,
    });
    expect(String(entry.errorMessage)).toHaveLength(500);
    expect(entry).not.toHaveProperty("providerProfile");
    expect(entry).not.toHaveProperty("message");
  });
});
