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
    })).rejects.toMatchObject({ code: "PROVIDER_RUNTIME_FAILED", message: "模型服务运行失败：Provider 未提供可安全展示的错误详情。" });
  });

  it("maps known Provider errors to stable local categories without echoing sensitive text", async () => {
    const cases = [
      { errorMessage: "fetch failed: ECONNREFUSED token=secret-value", expected: "模型服务运行失败：网络连接失败。" },
      { errorMessage: "request timed out password=super-secret", expected: "模型服务运行失败：请求超时。" },
      { errorMessage: "Authorization: Basic dXNlcjpzZWNyZXQ= https://provider.invalid?secret=url-secret customKey=ABCDEFGH12345678", expected: "模型服务运行失败：Provider 未提供可安全展示的错误详情。" },
    ];

    for (const [index, scenario] of cases.entries()) {
      const faux = fauxProvider({ provider: `novax-safe-error-${index}` });
      faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: scenario.errorMessage })]);
      const models = createModels();
      models.setProvider(faux.provider);
      const adapter = new NovaxPiRuntimeAdapter({
        model: faux.getModel(),
        streamFn: (model, context, options) => models.streamSimple(model, context, options),
      });

      const error = await adapter.run({ systemPrompt: "Contract fixture only.", userInput: "测试", tools: [] })
        .then(() => undefined, (caught: unknown) => caught as Error);
      expect(error).toMatchObject({ code: "PROVIDER_RUNTIME_FAILED", message: scenario.expected });
      const message = (error as Error).message;
      for (const secret of ["secret-value", "super-secret", "dXNlcjpzZWNyZXQ=", "provider.invalid", "url-secret", "ABCDEFGH12345678"]) {
        expect(message).not.toContain(secret);
      }
    }
  });

  it("does not spend correction attempts after the Provider has already returned an error", async () => {
    const faux = fauxProvider({ provider: "novax-terminal-error-fixture" });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider rejected request" }),
      fauxAssistantMessage(fauxToolCall("submit_result", { status: "done" })),
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
      completionGuard: { toolName: "submit_result", isSatisfied: () => false, forceTool: true },
    })).rejects.toMatchObject({ code: "PROVIDER_RUNTIME_FAILED" });
    expect(faux.state.callCount).toBe(1);
  });

  it("does not spend correction attempts after aborted or length terminal messages", async () => {
    for (const stopReason of ["aborted", "length"] as const) {
      const faux = fauxProvider({ provider: `novax-terminal-${stopReason}-fixture` });
      faux.setResponses([
        fauxAssistantMessage("", { stopReason }),
        fauxAssistantMessage(fauxToolCall("submit_result", { status: "done" })),
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
        completionGuard: { toolName: "submit_result", isSatisfied: () => false, forceTool: true },
      })).rejects.toMatchObject({ code: stopReason === "aborted" ? "AGENT_RUN_CANCELLED" : "PROVIDER_OUTPUT_INCOMPLETE" });
      expect(faux.state.callCount).toBe(1);
    }
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
        parameters: Type.Object({ status: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params) => {
          if ((params as { status: string }).status !== "done") throw new Error("RESULT_SCHEMA_INVALID");
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

  it("ends a rejected final-tool turn so the bounded correction loop can repair it", async () => {
    const faux = fauxProvider({ provider: "novax-rejected-final-fixture" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("submit_result", { status: "bad" })),
      fauxAssistantMessage(fauxToolCall("submit_result", { status: "done" })),
      fauxAssistantMessage("完成"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    let attempts = 0;
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
        parameters: Type.Object({ status: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params) => {
          attempts += 1;
          if ((params as { status: string }).status !== "done") throw new Error("FINAL_SCHEMA_INVALID");
          submitted = true;
          return { content: [{ type: "text", text: "accepted" }], details: { accepted: true } };
        },
      }],
      completionGuard: { toolName: "submit_result", isSatisfied: () => submitted, forceTool: true },
    });

    expect(attempts).toBe(2);
    expect(result.receipt.correctionAttempts).toBe(1);
    expect(faux.state.callCount).toBe(3);
  });

  it("repairs one schema-invalid guarded result call with exactly one structured correction", async () => {
    const faux = fauxProvider({ provider: "novax-invalid-guarded-result-fixture" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("submit_result", { status: "invalid" })),
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
        parameters: Type.Object({ status: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params) => {
          if ((params as { status: string }).status !== "done") throw new Error("RESULT_SCHEMA_INVALID");
          submitted = true;
          return { content: [{ type: "text", text: "accepted" }], details: { accepted: true } };
        },
      }],
      completionGuard: { toolName: "submit_result", isSatisfied: () => submitted, forceTool: true },
    });

    expect(submitted).toBe(true);
    expect(result.receipt.correctionAttempts).toBe(1);
    expect(faux.state.callCount).toBe(3);
  });

  it("repairs an unsatisfied toolUse turn even when no guarded-tool execution error is emitted", async () => {
    const faux = fauxProvider({ provider: "novax-unsatisfied-tool-use-fixture" });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "toolUse" }),
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
      completionGuard: { toolName: "submit_result", isSatisfied: () => submitted, forceTool: true },
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

  it("removes an old raw file chunk from the actual Pi context after its durable note succeeds", async () => {
    const faux = fauxProvider({ provider: "novax-long-context-fixture" });
    const sha256 = "a".repeat(64);
    const source = { path: "world.md", sha256, startChar: 0, endChar: 24_000 };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_project_file", { path: "world.md", offsetChars: 0, maxChars: 24_000 })),
      fauxAssistantMessage(fauxToolCall("save_task_note", { title: "world", content: "海岸设定", source })),
      fauxAssistantMessage("完成"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const contexts: string[] = [];
    const adapter = new NovaxPiRuntimeAdapter({
      model: faux.getModel(),
      streamFn: (model, context, options) => {
        contexts.push(JSON.stringify(context));
        return models.streamSimple(model, context, options);
      },
    });

    await adapter.run({
      systemPrompt: "Long context fixture.",
      userInput: "read",
      tools: [
        {
          name: "read_project_file",
          label: "read",
          description: "read",
          parameters: Type.Object({ path: Type.String(), offsetChars: Type.Integer(), maxChars: Type.Integer() }),
          execute: async () => ({
            content: [{ type: "text", text: JSON.stringify({ result: { ...source, content: "甲".repeat(24_000) } }) }],
            details: { ...source },
          }),
        },
        {
          name: "save_task_note",
          label: "save",
          description: "save",
          parameters: Type.Object({ title: Type.String(), content: Type.String(), source: Type.Object({}) }, { additionalProperties: true }),
          execute: async () => ({
            content: [{ type: "text", text: JSON.stringify({ result: { id: "note-1", title: "world", content: "海岸设定", source } }) }],
            details: { id: "note-1", source },
          }),
        },
      ],
    });

    expect(contexts).toHaveLength(3);
    expect(contexts[1]).toContain("甲".repeat(1_000));
    expect(contexts[2]).not.toContain("甲".repeat(1_000));
    expect(contexts[2]).not.toContain("海岸设定");
    expect(contexts[2]).toContain("durable_file_receipt");
  });
});
