import { describe, expect, it } from "vitest";

const enabledCases = new Set(
  (process.env.NOVELX_TOOLCALL_BLACKBOX_CASES ?? "").split(",").map((value) => value.trim()).filter(Boolean),
);

const cases = [
  ["core_tools", "executes and journals list/read/search/glob/stat, then sends strict tool_call_id results on the second Provider turn"],
  ["unicode", "preserves Chinese project file names and Chinese UTF-8 content across Runtime, tool result and Provider request"],
  ["assist", "stops in Assist mode until a real authorization resolution and persisted permission lease exist"],
  ["restart", "recovers after restart without repeating a succeeded or outcome-unknown tool side effect"],
  ["missing_root", "fails closed when the verified project root is absent"],
  ["missing_provider", "fails closed when the Provider binding is absent"],
  ["outside_root", "rejects paths outside the verified project root"],
  ["invalid_utf8", "reports invalid UTF-8 as a typed file failure instead of fabricating text"],
  ["incomplete", "returns explicit incomplete receipts for file, byte, character, timeout and result budgets"],
] as const;

describe("Runtime V2 real cross-process ToolCall contract", () => {
  for (const [caseId, title] of cases) {
    it.skipIf(!enabledCases.has(caseId))(`${caseId}: ${title}`, async () => {
      await expect(runLiveCase(caseId)).resolves.toBeUndefined();
    });
  }
});

async function runLiveCase(caseId: typeof cases[number][0]): Promise<void> {
  // This deliberate failure turns each environment-enabled case into a real readiness gate.
  // Replace the corresponding branch with the real Runtime/Supervisor driver only when main.rs
  // exposes ToolCall dispatch; never satisfy it with a local fixture or direct dispatcher call.
  throw new Error(`ToolCall live black-box driver is not implemented for enabled case: ${caseId}`);
}
