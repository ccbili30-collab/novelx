import { describe, it } from "vitest";

// Contract-only until Rust main.rs dispatches ToolCall commands/events. These are intentionally
// skipped rather than backed by a fixture that could be mistaken for live Runtime behavior.
describe.skip("Runtime V2 real cross-process ToolCall contract", () => {
  it("executes and journals list/read/search/glob/stat, then sends strict tool_call_id results on the second Provider turn", () => {});
  it("preserves Chinese project file names and Chinese UTF-8 content across Runtime, tool result and Provider request", () => {});
  it("stops in Assist mode until a real authorization resolution and persisted permission lease exist", () => {});
  it("recovers after restart without repeating a succeeded or outcome-unknown tool side effect", () => {});
  it("fails closed when the verified project root is absent", () => {});
  it("fails closed when the Provider binding is absent", () => {});
  it("rejects paths outside the verified project root", () => {});
  it("reports invalid UTF-8 as a typed file failure instead of fabricating text", () => {});
  it("returns explicit incomplete receipts for file, byte, character, timeout and result budgets", () => {});
});
