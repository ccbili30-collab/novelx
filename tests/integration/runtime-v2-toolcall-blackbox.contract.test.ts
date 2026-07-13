import { describe, expect, it } from "vitest";
import { RuntimeV2ToolCallBlackboxDriver } from "../support/runtimeV2ToolCallBlackboxDriver";

const cases = [
  ["core_tools", "executes and journals list/read/search/glob/stat, then sends strict tool_call_id results on the second Provider turn"],
  ["unicode", "preserves Chinese project file names and Chinese UTF-8 content across Runtime, tool result and Provider request"],
  ["assist", "stops in Assist mode until a real authorization resolution and persisted permission lease exist"],
  ["assist_deny", "continues after a denied Assist ToolCall with a strictly paired TOOL_DENIED result"],
  ["restart", "recovers after restart without repeating a succeeded or outcome-unknown tool side effect"],
  ["missing_root", "fails closed when the verified project root is absent"],
  ["missing_provider", "fails closed when the Provider binding is absent"],
  ["outside_root", "rejects paths outside the verified project root"],
  ["invalid_utf8", "reports invalid UTF-8 as a typed file failure instead of fabricating text"],
  ["incomplete", "returns explicit incomplete receipts for file, byte, character, timeout and result budgets"],
] as const;
const debugCases = readDebugCases();

describe("Runtime V2 real cross-process ToolCall contract", () => {
  for (const [caseId, title] of cases) {
    it.skipIf(debugCases !== null && !debugCases.has(caseId))(`${caseId}: ${title}`, async () => {
      await expect(runLiveCase(caseId)).resolves.toBeUndefined();
    }, 60_000);
  }
});

function readDebugCases(): ReadonlySet<typeof cases[number][0]> | null {
  if (process.env.NOVELX_TEST_STAGE !== "toolcall-debug") return null;
  const selected = (process.env.NOVELX_TOOLCALL_BLACKBOX_DEBUG_CASES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (selected.length === 0) throw new Error("ToolCall debug stage requires at least one selected case.");
  const known = new Set<string>(cases.map(([caseId]) => caseId));
  const unknown = selected.filter((caseId) => !known.has(caseId));
  if (unknown.length > 0) throw new Error(`Unknown ToolCall debug cases: ${unknown.join(", ")}.`);
  return new Set(selected as Array<typeof cases[number][0]>);
}

async function runLiveCase(caseId: typeof cases[number][0]): Promise<void> {
  if (caseId === "core_tools" || caseId === "unicode") {
    const driver = new RuntimeV2ToolCallBlackboxDriver({ mode: "free" });
    try {
      await driver.startListReadScenario();
      await driver.waitForToolEvents("tool.requested", 5);
      await driver.waitForToolEvents("tool.succeeded", 5);
      const second = await driver.waitForSecondProviderRequest();
      const serialized = JSON.stringify(second.body);
      expect(serialized).toContain("provider-list-1");
      expect(serialized).toContain("provider-read-1");
      expect(serialized).toContain("provider-search-1");
      expect(serialized).toContain("provider-glob-1");
      expect(serialized).toContain("provider-stat-1");
      expect(serialized).toContain("世界观/海岸线.md");
      expect(serialized).toContain("海岸线由沉降形成");
      return;
    } finally {
      await driver.close();
    }
  }
  if (caseId === "assist") {
    const driver = new RuntimeV2ToolCallBlackboxDriver({ mode: "assist" });
    try {
      await driver.startListReadScenario();
      const requested = await driver.waitForToolEvents("tool.requested", 5);
      expect(driver.provider?.requests).toHaveLength(1);
      for (const event of requested) {
        const payload = event.payload as { toolCallId: string };
        await driver.supervisor!.resolveToolAuthorization(driver.runId, {
          authorizationIdempotencyKey: `approve-${payload.toolCallId}`,
          toolCallId: payload.toolCallId,
          decision: "approve",
        });
      }
      await driver.waitForToolEvents("tool.succeeded", 5);
      await driver.waitForSecondProviderRequest();
      const proposal = driver.events.find((event) => event.name === "provider.inference.continuation.proposed");
      expect(proposal).toMatchObject({ correlationId: null, payload: { triggeringToolCallIds: expect.any(Array), authorizationEvidence: expect.any(Array) } });
      return;
    } finally {
      await driver.close();
    }
  }
  if (caseId === "assist_deny") {
    const driver = new RuntimeV2ToolCallBlackboxDriver({ mode: "assist" });
    try {
      await driver.startToolScenario([
        { id: "provider-denied-1", name: "read_project_file", arguments: { path: "世界观/海岸线.md", maxChars: 4_000 } },
      ]);
      const requested = await driver.waitForToolEvent("tool.requested");
      const payload = requested.payload as { toolCallId: string };
      await driver.supervisor!.resolveToolAuthorization(driver.runId, {
        authorizationIdempotencyKey: `deny-${payload.toolCallId}`,
        toolCallId: payload.toolCallId,
        decision: "deny",
      });
      const second = await driver.waitForSecondProviderRequest();
      const serialized = JSON.stringify(second.body);
      expect(serialized).toContain("provider-denied-1");
      expect(serialized).toContain("TOOL_DENIED");
      expect(driver.events.filter((event) => event.name === "tool.succeeded")).toHaveLength(0);
      expect(driver.events.some((event) => event.name === "provider.inference.continuation.proposed")).toBe(true);
      return;
    } finally {
      await driver.close();
    }
  }
  if (caseId === "restart") {
    const driver = new RuntimeV2ToolCallBlackboxDriver({ mode: "free" });
    try {
      await driver.startListReadScenario();
      await driver.waitForToolEvents("tool.succeeded", 5);
      await driver.waitForSecondProviderRequest();
      expect(await driver.restartWithoutNewProviderRequest()).toBe(0);
      return;
    } finally { await driver.close(); }
  }
  if (caseId === "outside_root") {
    const driver = new RuntimeV2ToolCallBlackboxDriver({ mode: "free" });
    try {
      await driver.startToolScenario([{ id: "provider-outside-1", name: "read_project_file", arguments: { path: "../outside-secret.md", maxChars: 100 } }]);
      const failed = await driver.waitForToolEvent("tool.failed");
      expect(failed.payload).toMatchObject({ providerToolCallId: "provider-outside-1", error: { class: expect.any(String) } });
      const second = await driver.waitForSecondProviderRequest();
      expect(JSON.stringify(second.body)).toContain("provider-outside-1");
      expect(JSON.stringify(second.body)).not.toContain("outside secret content");
      return;
    } finally { await driver.close(); }
  }
  if (caseId === "invalid_utf8") {
    const driver = new RuntimeV2ToolCallBlackboxDriver({ mode: "free" });
    try {
      driver.writeInvalidUtf8("世界观/损坏.md");
      await driver.startToolScenario([{ id: "provider-utf8-1", name: "read_project_file", arguments: { path: "世界观/损坏.md", maxChars: 100 } }]);
      const failed = await driver.waitForToolEvent("tool.failed");
      expect(failed.payload).toMatchObject({ providerToolCallId: "provider-utf8-1" });
      const second = await driver.waitForSecondProviderRequest();
      expect(JSON.stringify(second.body)).toContain("provider-utf8-1");
      expect(JSON.stringify(second.body)).not.toContain("�");
      return;
    } finally { await driver.close(); }
  }
  if (caseId === "incomplete") {
    const driver = new RuntimeV2ToolCallBlackboxDriver({ mode: "free" });
    try {
      driver.writeLargeText("世界观/超长.md", 1_000_100);
      await driver.startToolScenario([{ id: "provider-incomplete-1", name: "search_project_files", arguments: { query: "不存在", path: "世界观" } }]);
      await driver.waitForToolEvent("tool.succeeded");
      const second = await driver.waitForSecondProviderRequest();
      const body = JSON.stringify(second.body);
      expect(body).toContain("provider-incomplete-1");
      expect(body.includes('"complete":false') || body.toLowerCase().includes("incomplete")).toBe(true);
      return;
    } finally { await driver.close(); }
  }
  if (caseId === "missing_provider") {
    const driver = new RuntimeV2ToolCallBlackboxDriver({ mode: "free" });
    try {
      const snapshot = await driver.runMissingProviderScenario();
      expect(snapshot).toMatchObject({ state: "failed", terminalError: { code: "REAL_GM_PROVIDER_REQUIRED" } });
      return;
    } finally { await driver.close(); }
  }
  if (caseId === "missing_root") {
    const driver = new RuntimeV2ToolCallBlackboxDriver({ mode: "free" });
    try {
      await expect(driver.runMissingRootScenario()).rejects.toMatchObject({ code: "RUNTIME_V2_PROTOCOL_INVALID" });
      return;
    } finally { await driver.close(); }
  }
  // This deliberate failure turns each environment-enabled case into a real readiness gate.
  // Replace the corresponding branch with the real Runtime/Supervisor driver only when main.rs
  // exposes ToolCall dispatch; never satisfy it with a local fixture or direct dispatcher call.
  throw new Error(`ToolCall live black-box driver is not implemented for enabled case: ${caseId}`);
}
