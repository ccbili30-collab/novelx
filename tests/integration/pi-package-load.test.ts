import { describe, expect, it } from "vitest";

describe("installed Pi 0.80.6 package boundary", () => {
  it("loads only documented Novax entry points", async () => {
    const ai = await import("@earendil-works/pi-ai");
    const agent = await import("@earendil-works/pi-agent-core");
    const api = await import("@earendil-works/pi-ai/api/openai-completions.lazy");

    expect(typeof ai.createModels).toBe("function");
    expect(typeof ai.createProvider).toBe("function");
    expect(typeof agent.Agent).toBe("function");
    expect(typeof api.openAICompletionsApi).toBe("function");
  });
});

