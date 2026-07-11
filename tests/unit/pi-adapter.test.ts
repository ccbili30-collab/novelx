import { describe, expect, it } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { NovaxPiRuntimeAdapter } from "../../src/agent-worker/pi/NovaxPiRuntimeAdapter";
import { modelProfileSchema } from "../../src/agent-worker/pi/modelProfile";

describe("Novax Pi Runtime Adapter contract fixture", () => {
  it("requires complete capability metadata for a custom Provider profile", () => {
    expect(() => modelProfileSchema.parse({ apiKey: "secret", modelId: "model" })).toThrow();
    expect(modelProfileSchema.parse({
      providerId: "custom-openai",
      displayName: "Custom OpenAI",
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret",
      modelId: "model",
      contextWindow: 64_000,
      maxTokens: 8_000,
      reasoning: false,
      input: ["text"],
    }).modelId).toBe("model");
  });

  it("uses explicit Pi streamFn and projects text without leaking thinking", async () => {
    const faux = fauxProvider({ provider: "novax-contract-fixture" });
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("绝不能泄露"), fauxText("可见文本")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const projected: unknown[] = [];
    const adapter = new NovaxPiRuntimeAdapter({
      model: faux.getModel(),
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
    });

    const result = await adapter.run({
      systemPrompt: "Contract fixture only.",
      userInput: "测试",
      tools: [],
      onEvent: (event) => projected.push(event),
    });

    expect(result).toMatchObject({
      text: "可见文本",
      stopReason: "stop",
      receipt: {
        contextPolicyVersion: "novax.estimated-tokens-v3@3.0.0",
      },
    });
    expect(projected).toContainEqual({ type: "text.delta", text: "可见文本" });
    expect(JSON.stringify(projected)).not.toContain("绝不能泄露");
  });

  it("places admitted private history before the current user turn and marks omissions", async () => {
    const faux = fauxProvider({ provider: "novax-history-fixture" });
    faux.setResponses([fauxAssistantMessage("已理解当前对话")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const contexts: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const adapter = new NovaxPiRuntimeAdapter({
      model: faux.getModel(),
      streamFn: (model, context, options) => {
        contexts.push({ messages: context.messages.map((message) => ({ role: message.role, content: message.content })) });
        return models.streamSimple(model, context, options);
      },
    });

    await adapter.run({
      systemPrompt: "Contract fixture only.",
      userInput: "现在继续",
      sessionHistory: {
        entries: [
          { role: "user", text: "先讨论海岸线", createdAt: "2026-07-10T12:00:00.000Z" },
          { role: "assistant", text: "需要检索正式资料", createdAt: "2026-07-10T12:00:01.000Z" },
        ],
        completeness: { incomplete: true, omittedMessages: 2 },
      },
      collaborationContext: {
        sharedMemories: [{
          title: "海岸线索引",
          content: "必须检索世界资料。",
          scopeResourceIds: ["world-coast"],
          checkpointId: "checkpoint-7",
          sourceSessionTitle: "世界观 Agent",
          createdAt: "2026-07-10T11:59:00.000Z",
        }],
        handoffs: [{
          title: "继续港口章节",
          instructions: "先核验事实，再写正文。",
          scopeResourceIds: ["story-port"],
          checkpointId: "checkpoint-7",
          senderSessionTitle: "世界观 Agent",
          status: "accepted",
          createdAt: "2026-07-10T11:59:30.000Z",
        }],
      },
      tools: [],
    });

    expect(contexts[0]?.messages.map((message) => message.role)).toEqual([
      "user", "user", "user", "user", "assistant", "user",
    ]);
    expect(JSON.stringify(contexts[0])).toContain("结构化任务交接");
    expect(JSON.stringify(contexts[0])).toContain("更早的 2 条消息未载入");
    expect(JSON.stringify(contexts[0])).toContain("现在继续");
  });

  it("does not mistake a resolved Pi prompt with stopReason error for success", async () => {
    const faux = fauxProvider({ provider: "novax-error-fixture" });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "apiKey=C:\\private" }),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new NovaxPiRuntimeAdapter({
      model: faux.getModel(),
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
    });

    await expect(adapter.run({
      systemPrompt: "Contract fixture only.",
      userInput: "测试",
      tools: [],
    })).rejects.toMatchObject({ code: "PROVIDER_RUNTIME_FAILED", message: "模型服务运行失败。" });
  });

  it("uses one audited follow-up turn when the model omits the required result tool", async () => {
    const faux = fauxProvider({
      provider: "novax-correction-fixture",
      models: [{ id: "correction-model", contextWindow: 64_000, maxTokens: 2_048 }],
    });
    faux.setResponses([
      fauxAssistantMessage("普通文本不是结构化结果"),
      fauxAssistantMessage(fauxToolCall("submit_result", { status: "done" })),
      fauxAssistantMessage("完成"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    let submitted = false;
    const adapter = new NovaxPiRuntimeAdapter({
      model: faux.getModel(),
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
    });

    const result = await adapter.run({
      systemPrompt: "Contract fixture only.",
      userInput: "测试",
      tools: [{
        name: "submit_result",
        label: "提交",
        description: "Submit the result.",
        parameters: Type.Object({ status: Type.Literal("done") }, { additionalProperties: false }),
        execute: async () => {
          submitted = true;
          return { content: [{ type: "text", text: "accepted" }], details: { accepted: true } };
        },
      }],
      completionGuard: { toolName: "submit_result", isSatisfied: () => submitted },
    });

    expect(submitted).toBe(true);
    expect(result.receipt.correctionAttempts).toBe(1);
    expect(faux.state.callCount).toBe(3);
  });

  it("forces the single specialist result tool at the OpenAI-compatible payload boundary", async () => {
    const faux = fauxProvider({ provider: "novax-forced-tool-fixture" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("submit_result", { status: "done" })),
      fauxAssistantMessage("完成"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const payloads: unknown[] = [];
    let submitted = false;
    const adapter = new NovaxPiRuntimeAdapter({
      model: faux.getModel(),
      streamFn: (model, context, options) => {
        if (options?.onPayload) {
          void Promise.resolve(options.onPayload({ model: model.id, messages: [] }, model))
            .then((payload) => payloads.push(payload));
        }
        return models.streamSimple(model, context, options);
      },
    });

    await adapter.run({
      systemPrompt: "Contract fixture only.",
      userInput: "测试",
      tools: [{
        name: "submit_result",
        label: "提交",
        description: "Submit the result.",
        parameters: Type.Object({ status: Type.Literal("done") }, { additionalProperties: false }),
        execute: async () => {
          submitted = true;
          return { content: [{ type: "text", text: "accepted" }], details: { accepted: true } };
        },
      }],
      completionGuard: { toolName: "submit_result", isSatisfied: () => submitted, forceTool: true },
    });

    expect(payloads).toContainEqual(expect.objectContaining({
      tool_choice: { type: "function", function: { name: "submit_result" } },
    }));
  });

  it("honors an already-aborted run before calling the Provider fixture", async () => {
    const faux = fauxProvider({ provider: "novax-abort-fixture" });
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new NovaxPiRuntimeAdapter({
      model: faux.getModel(),
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.run({
      systemPrompt: "Contract fixture only.",
      userInput: "测试",
      tools: [],
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "AGENT_RUN_CANCELLED" });
  });
});
