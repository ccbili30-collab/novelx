import { afterEach, describe, expect, it } from "vitest";
import {
  RuntimeV2LoopbackProvider, completionProviderResponse, toolCallProviderResponse,
} from "../support/runtimeV2LoopbackProvider";

let server: RuntimeV2LoopbackProvider | null = null;
afterEach(async () => { await server?.close(); server = null; });

describe("RuntimeV2LoopbackProvider", () => {
  it("scripts two Provider turns and captures a Chinese tool result with the original tool_call_id", async () => {
    server = await RuntimeV2LoopbackProvider.start([
      { body: toolCallProviderResponse("call-list-1", "list_project_files", { path: "世界观" }) },
      { body: completionProviderResponse("已读取海岸线设定。") },
    ]);
    const first = await fetch(`${server.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "检查世界观" }] }) });
    expect(await first.json()).toMatchObject({ choices: [{ message: { tool_calls: [{ id: "call-list-1" }] } }] });
    const secondBody = { messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call-list-1", type: "function", function: { name: "list_project_files", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-list-1", content: JSON.stringify({ paths: ["世界观/海岸线.md"], complete: true }) },
    ] };
    await fetch(`${server.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(secondBody) });
    const captured = await server.waitForRequest(1);
    expect(JSON.stringify(captured.body)).toContain("call-list-1");
    expect(JSON.stringify(captured.body)).toContain("世界观/海岸线.md");
    expect(server.remainingResponses).toBe(0);
  });
});
