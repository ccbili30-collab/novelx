import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  AgentProcessSupervisor,
  createAgentWorkerEnvironment,
  type AgentRuntimeLease,
  type AgentToolGateway,
  type AgentWorkerProcess,
} from "../../src/main/agentProcessSupervisor";
import type { AgentAuditStore } from "../../src/domain/audit/agentAuditRepository";

class FakeWorkerProcess extends EventEmitter implements AgentWorkerProcess {
  killed = false;
  readonly sent: unknown[] = [];
  returnBackpressureAfter = Number.POSITIVE_INFINITY;

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    queueMicrotask(() => callback?.(null));
    return this.sent.length <= this.returnBackpressureAfter;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  spawn(): void {
    this.emit("spawn");
  }

  receive(message: unknown): void {
    this.emit("message", message);
  }
}

function createGateway(overrides: Partial<AgentToolGateway> = {}): AgentToolGateway {
  return {
    retrieveGraphEvidence: async () => ({
      branch: { id: "branch-1", headCheckpointId: "checkpoint-1" },
      scopes: [{ resourceId: "world-1", type: "world", title: "世界" }],
      assertions: [],
      documents: [],
      retrieval: {
        budget: {
          maxDocuments: 12,
          maxAssertions: 200,
          maxDocumentChars: 20_000,
          totalChars: 160_000,
        },
        usage: {
          assertions: 0,
          documents: 0,
          assertionChars: 0,
          documentChars: 0,
          totalChars: 0,
        },
        completeness: {
          incomplete: false,
          omittedAssertions: 0,
          omittedDocuments: 0,
          truncatedDocuments: 0,
          limitsHit: [],
        },
        ordering: {
          assertions: "repository_subject_predicate_assertion_id",
          documents: "requested_scope_order",
          relevanceRanking: "not_applied",
        },
      },
    }),
    inspectProjectFiles: async () => ({
      mode: "overview",
      listing: {
        root: ".",
        entries: [],
        ignoredDirectories: [".git", ".novax", "node_modules"],
        incomplete: false,
        omittedEntries: 0,
      },
      files: [],
      omittedReadableFiles: 0,
      totalReturnedChars: 0,
    }),
    listProjectDirectory: async () => ({
      root: ".",
      entries: [],
      ignoredDirectories: [".git", ".novax", "node_modules"],
      incomplete: false,
      omittedEntries: 0,
    }),
    statProjectFile: async () => ({
      path: "example.md",
      kind: "file",
      size: 0,
      modifiedAt: "2026-01-01T00:00:00.000Z",
      sha256: "a".repeat(64),
    }),
    globProjectFiles: async () => ({
      pattern: "**/*.md",
      entries: [],
      incomplete: false,
      omittedEntries: 0,
    }),
    searchProjectFiles: async () => ({
      query: "example",
      matches: [],
      scannedFiles: 0,
      skippedBinaryFiles: 0,
      incomplete: false,
    }),
    readProjectFile: async () => ({
      path: "example.md",
      kind: "text",
      size: 0,
      sha256: "a".repeat(64),
      content: "",
      complete: true,
      originalChars: 0,
      returnedChars: 0,
      startChar: 0,
      endChar: 0,
      hasMore: false,
    }),
    saveTaskNote: async (args) => ({
      id: "note-1",
      ...args,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    listTaskNotes: async () => ({ notes: [], total: 0, nextOffset: null }),
    generateImage: async (args) => ({
      jobId: "image-job-1",
      assetId: "image-asset-1",
      status: "ready",
      title: args.title,
      purpose: args.purpose,
      sourceResourceIds: args.sourceResourceIds,
      sourceVersionIds: args.sourceVersionIds,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      byteLength: 1024,
      sha256: "b".repeat(64),
      thumbnailUrl: "novax-asset://image/image-asset-1",
    }),
    proposeChangeSet: async (_args, context) => ({
      changeSetId: `change-${context.requestId}`,
      mode: context.mode,
      status: "pending",
      gateStatus: "review_pending",
      blockedReason: null,
      itemCount: 1,
    }),
    ...overrides,
  };
}

function createAuditStore(): AgentAuditStore {
  return {
    appendSafeDiagnostic: vi.fn(),
    beginRun: vi.fn(),
    beginInvocation: vi.fn(),
    beginTool: vi.fn(),
    appendRunCancelRequested: vi.fn(),
    appendRunTerminal: vi.fn(),
    appendInvocationTerminal: vi.fn(),
    appendToolTerminal: vi.fn(),
    linkTargets: vi.fn(),
    linkChangeSetOutputs: vi.fn(),
    assertToolInvocation: vi.fn(),
    terminalizeOpenRun: vi.fn(),
  };
}

function createLease(gateway = createGateway(), audit = createAuditStore()): AgentRuntimeLease {
  return { gateway, audit, release: vi.fn() };
}

function runRequest() {
  return { projectId: "project-1", sessionId: "session-1", userInput: "测试", mode: "assist" as const };
}

describe("Agent Process Supervisor internal tool gateway", () => {
  it("persists a strict Worker diagnostic only when its authority matches the active Run", () => {
    const child = new FakeWorkerProcess();
    const audit = createAuditStore();
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => createLease(createGateway(), audit),
      spawnWorker: () => child,
    });
    const runId = supervisor.start(runRequest(), () => undefined);
    child.spawn();
    const diagnostic = {
      schemaVersion: 1 as const,
      diagnosticId: "diagnostic-1", operationKind: "tool_call" as const, operationId: "tool-1",
      runId, cycleId: null, toolInvocationId: "tool-1", parentDiagnosticId: null,
      sequence: 1, owner: "worker_schema" as const, boundary: "worker_to_main" as const,
      code: "WORKER_SCHEMA_RESULT_INVALID", toolName: "propose_change_set",
      attempt: null, maxAttempts: null, sideEffectState: "none" as const,
      disposition: "terminal" as const, retryability: "do_not_retry" as const,
      occurredAt: "2026-07-17T00:00:00.000Z",
    };
    child.receive({
      type: "audit.request", runId, auditRequestId: "11111111-1111-4111-8111-111111111111",
      operation: { type: "safe_diagnostic.append", diagnostic },
    });
    expect(audit.appendSafeDiagnostic).toHaveBeenCalledWith(diagnostic);
    expect(child.sent.at(-1)).toMatchObject({ type: "audit.response", ok: true });

    child.receive({
      type: "audit.request", runId, auditRequestId: "22222222-2222-4222-8222-222222222222",
      operation: { type: "safe_diagnostic.append", diagnostic: { ...diagnostic, diagnosticId: "diagnostic-forged", runId: "other-run" } },
    });
    expect(audit.appendSafeDiagnostic).toHaveBeenCalledTimes(1);
    expect(child.sent.at(-1)).toMatchObject({ type: "audit.response", ok: false, error: { code: "AGENT_AUDIT_REQUIRED" } });
    supervisor.dispose();
  });

  it("preserves an allowlisted post-apply Change Set failure code without forwarding raw exception text", async () => {
    const child = new FakeWorkerProcess();
    const audit = createAuditStore();
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => createLease(createGateway({
        proposeChangeSet: async () => {
          throw Object.assign(new Error("token=secret password=hidden https://provider.example/?key=private"), {
            code: "RESOURCE_PARENT_NOT_FOUND",
          });
        },
      }), audit),
      spawnWorker: () => child,
    });
    const runId = supervisor.start(runRequest(), () => undefined);
    child.spawn();
    child.receive({
      type: "tool.request", runId, requestId: "66666666-6666-4666-8666-666666666666", tool: "propose_change_set",
      args: {
        summary: "safe", items: [{
          id: "world-item", dependsOn: [], kind: "resource.put",
          payload: { resourceId: "world-1", create: true, type: "world", objectKind: "world", title: "safe", parentId: "root-1", state: "active", sortOrder: 0 },
        }],
      },
    });
    await vi.waitFor(() => expect(child.sent).toHaveLength(2));
    const response = JSON.stringify(child.sent[1]);
    expect(child.sent[1]).toMatchObject({ type: "tool.response", ok: false, error: { code: "RESOURCE_PARENT_NOT_FOUND" } });
    expect(response).not.toContain("token=secret");
    expect(response).not.toContain("password=hidden");
    expect(response).not.toContain("provider.example");
    expect(audit.appendToolTerminal).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "failed", errorCode: "RESOURCE_PARENT_NOT_FOUND",
    }));
    expect(audit.appendSafeDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      operationKind: "tool_call", operationId: "66666666-6666-4666-8666-666666666666",
      owner: "domain_policy", boundary: "change_set_policy", code: "RESOURCE_PARENT_NOT_FOUND",
      sideEffectState: "none", disposition: "terminal",
    }));
  });

  it("collapses unknown or sensitive Change Set failures to AGENT_TOOL_FAILED", async () => {
    const child = new FakeWorkerProcess();
    const audit = createAuditStore();
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => createLease(createGateway({
        proposeChangeSet: async () => {
          throw Object.assign(new Error("custom_key=secret token=secret password=hidden https://provider.example/?key=private"), {
            code: "UNSAFE_CHANGE_SET_INTERNAL",
          });
        },
      }), audit),
      spawnWorker: () => child,
    });
    const runId = supervisor.start(runRequest(), () => undefined);
    child.spawn();
    child.receive({
      type: "tool.request", runId, requestId: "77777777-7777-4777-8777-777777777777", tool: "propose_change_set",
      args: {
        summary: "safe", items: [{
          id: "world-item", dependsOn: [], kind: "resource.put",
          payload: { resourceId: "world-1", create: true, type: "world", objectKind: "world", title: "safe", parentId: "root-1", state: "active", sortOrder: 0 },
        }],
      },
    });
    await vi.waitFor(() => expect(child.sent).toHaveLength(2));
    const response = JSON.stringify(child.sent[1]);
    expect(child.sent[1]).toMatchObject({ type: "tool.response", ok: false, error: { code: "AGENT_TOOL_FAILED" } });
    for (const sensitive of ["custom_key=secret", "token=secret", "password=hidden", "provider.example"]) expect(response).not.toContain(sensitive);
    expect(audit.appendToolTerminal).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AGENT_TOOL_FAILED" }));
    expect(audit.appendSafeDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      owner: "main_gateway", boundary: "tool_execution", code: "AGENT_TOOL_FAILED",
      sideEffectState: "request_sent",
    }));
    expect(JSON.stringify((audit.appendSafeDiagnostic as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("secret");
  });

  it("records an allowlisted image diagnostic subcode while keeping the Worker failure broad", async () => {
    const child = new FakeWorkerProcess();
    const audit = createAuditStore();
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => createLease(createGateway({
        generateImage: async () => {
          throw Object.assign(new Error("token=secret upstream body"), {
            code: "IMAGE_GENERATION_FAILED",
            diagnosticCode: "IMAGE_PROVIDER_RATE_LIMITED",
          });
        },
      }), audit),
      spawnWorker: () => child,
    });
    const runId = supervisor.start(runRequest(), () => undefined);
    child.spawn();
    child.receive({
      type: "tool.request", runId, requestId: "88888888-8888-4888-8888-888888888888",
      tool: "generate_image",
      args: {
        title: "safe", purpose: "scene", prompt: "safe",
        sourceResourceIds: ["resource-1"], sourceVersionIds: ["version-1"],
        idempotencyKey: "safe-image",
      },
    });
    await vi.waitFor(() => expect(child.sent).toHaveLength(2));
    expect(child.sent[1]).toMatchObject({
      type: "tool.response", ok: false, error: { code: "IMAGE_GENERATION_FAILED" },
    });
    expect(audit.appendToolTerminal).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "IMAGE_GENERATION_FAILED",
    }));
    expect(audit.appendSafeDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "IMAGE_PROVIDER_RATE_LIMITED", owner: "provider", boundary: "provider_inference",
      sideEffectState: "request_sent", retryability: "user_action",
    }));
    expect(JSON.stringify((audit.appendSafeDiagnostic as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("secret");
  });

  it("ignores an unknown image diagnostic subcode", async () => {
    const child = new FakeWorkerProcess();
    const audit = createAuditStore();
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => createLease(createGateway({
        generateImage: async () => {
          throw Object.assign(new Error("token=secret upstream body"), {
            code: "IMAGE_GENERATION_FAILED",
            diagnosticCode: "UPSTREAM_SECRET_CLASS",
          });
        },
      }), audit),
      spawnWorker: () => child,
    });
    const runId = supervisor.start(runRequest(), () => undefined);
    child.spawn();
    child.receive({
      type: "tool.request", runId, requestId: "99999999-9999-4999-8999-999999999999",
      tool: "generate_image",
      args: {
        title: "safe", purpose: "scene", prompt: "safe",
        sourceResourceIds: ["resource-1"], sourceVersionIds: ["version-1"],
        idempotencyKey: "safe-image-unknown",
      },
    });
    await vi.waitFor(() => expect(child.sent).toHaveLength(2));
    expect(audit.appendSafeDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "IMAGE_GENERATION_FAILED",
    }));
    expect(JSON.stringify((audit.appendSafeDiagnostic as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("UPSTREAM_SECRET_CLASS");
  });

  it("injects capability only, never workspace details, and does not project tool payloads", async () => {
    const child = new FakeWorkerProcess();
    const events: unknown[] = [];
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => createLease(),
      spawnWorker: () => child,
    });
    const runId = supervisor.start(runRequest(), (event) => events.push(event));
    child.spawn();

    expect(child.sent[0]).toEqual({
      type: "run.start",
      runId,
      userInput: "测试",
      mode: "assist",
      scopeResourceIds: [],
      sessionHistory: {
        entries: [],
        completeness: { incomplete: false, omittedMessages: 0 },
      },
      collaborationContext: { sharedMemories: [], handoffs: [] },
      toolsAvailable: true,
      providerProfile: null,
    });
    expect(JSON.stringify(child.sent[0])).not.toContain("workspacePath");

    child.receive({
      type: "tool.request",
      runId,
      requestId: "11111111-1111-4111-8111-111111111111",
      tool: "retrieve_graph_evidence",
      args: { scopeResourceIds: ["world-1"] },
    });
    await vi.waitFor(() => expect(child.sent).toHaveLength(2));
    expect(child.sent[1]).toMatchObject({
      type: "tool.response",
      runId,
      requestId: "11111111-1111-4111-8111-111111111111",
      ok: true,
      tool: "retrieve_graph_evidence",
    });
    expect(events).toEqual([
      { type: "run.activity", runId, label: "检索项目事实", phase: "started", domains: ["graph"] },
      { type: "run.activity", runId, label: "检索项目事实", phase: "completed", domains: ["graph", "world"] },
    ]);
  });

  it("does not interrupt a large tool response when child IPC reports backpressure", async () => {
    const child = new FakeWorkerProcess();
    child.returnBackpressureAfter = 1;
    const events: unknown[] = [];
    const largeContent = "x".repeat(119_500);
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => createLease(createGateway({
        inspectProjectFiles: async () => ({
          mode: "overview",
          listing: {
            root: ".",
            entries: [],
            ignoredDirectories: [".git", ".novax", "node_modules"],
            incomplete: false,
            omittedEntries: 0,
          },
          files: ["large-a.md", "large-b.md"].map((filePath) => ({
            path: filePath,
            kind: "text" as const,
            size: largeContent.length,
            sha256: "a".repeat(64),
            content: largeContent,
            complete: true,
            originalChars: largeContent.length,
            returnedChars: largeContent.length,
            startChar: 0,
            endChar: largeContent.length,
            hasMore: false,
          })),
          omittedReadableFiles: 0,
          totalReturnedChars: largeContent.length * 2,
        }),
      })),
      spawnWorker: () => child,
    });
    const runId = supervisor.start(runRequest(), (event) => events.push(event));
    child.spawn();
    child.receive({
      type: "tool.request",
      runId,
      requestId: "99999999-9999-4999-8999-999999999999",
      tool: "inspect_project_files",
      args: { mode: "overview", path: "" },
    });

    await vi.waitFor(() => expect(child.sent).toHaveLength(2));
    expect(Buffer.byteLength(JSON.stringify(child.sent[1]), "utf8")).toBeGreaterThan(200_000);
    expect(child.killed).toBe(false);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "run.failed" }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "run.activity",
      phase: "completed",
    }));
  });

  it("dispatches a source-bound world_map tool and emits only the structured ready result", async () => {
    const child = new FakeWorkerProcess();
    const events: unknown[] = [];
    const generateImage = vi.fn(async (args: Parameters<AgentToolGateway["generateImage"]>[0], context: Parameters<AgentToolGateway["generateImage"]>[1]) => {
      context.onImageProgress?.("queued");
      context.onImageProgress?.("generating");
      context.onImageProgress?.("ready");
      return createGateway().generateImage(args, context);
    });
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => createLease(createGateway({ generateImage })),
      spawnWorker: () => child,
    });
    const runId = supervisor.start(runRequest(), (event) => events.push(event));
    child.spawn();
    child.receive({
      type: "tool.request",
      runId,
      requestId: "33333333-3333-4333-8333-333333333333",
      tool: "generate_image",
      args: {
        title: "银湾夜潮",
        purpose: "world_map",
        prompt: "月光下的银湾海岸",
        sourceResourceIds: ["world-1"],
        sourceVersionIds: ["version-1"],
        idempotencyKey: "silver-bay-night-v1",
      },
    });

    await vi.waitFor(() => expect(child.sent).toHaveLength(2));
    expect(generateImage).toHaveBeenCalledOnce();
    expect(child.sent[1]).toMatchObject({
      ok: true,
      tool: "generate_image",
      result: { status: "ready", assetId: "image-asset-1" },
    });
    expect(JSON.stringify(child.sent[1])).not.toContain("apiKey");
    expect(events).toEqual([
      { type: "run.activity", runId, label: "生成世界地图", phase: "started", domains: ["asset"] },
      { type: "run.activity", runId, label: "世界地图排队中", phase: "started", domains: ["asset"] },
      { type: "run.activity", runId, label: "生成世界地图", phase: "started", domains: ["asset"] },
      { type: "run.activity", runId, label: "世界地图已生成", phase: "completed", domains: ["asset"] },
      { type: "run.activity", runId, label: "生成世界地图", phase: "completed", domains: ["asset"] },
    ]);
  });

  it("passes only Main-admitted private session history to the Worker", () => {
    const child = new FakeWorkerProcess();
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => createLease(),
      spawnWorker: () => child,
    });
    supervisor.start(runRequest(), () => undefined, {
      entries: [
        { role: "user", text: "先讨论海岸线", createdAt: "2026-07-10T12:00:00.000Z" },
        { role: "assistant", text: "需要检索正式资料", createdAt: "2026-07-10T12:00:01.000Z" },
      ],
      completeness: { incomplete: true, omittedMessages: 3 },
    });
    child.spawn();

    expect(child.sent[0]).toMatchObject({
      type: "run.start",
      sessionHistory: {
        entries: [
          { role: "user", text: "先讨论海岸线" },
          { role: "assistant", text: "需要检索正式资料" },
        ],
        completeness: { incomplete: true, omittedMessages: 3 },
      },
    });
  });

  it("uses the backend project scope when Renderer did not select a resource", () => {
    const child = new FakeWorkerProcess();
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => ({
        ...createLease(),
        authorizedScopeResourceIds: ["root-world", "root-story"],
        defaultScopeResourceIds: ["root-world", "root-story"],
      }),
      spawnWorker: () => child,
    });
    supervisor.start(runRequest(), () => undefined);
    child.spawn();

    expect(child.sent[0]).toMatchObject({
      type: "run.start",
      scopeResourceIds: ["root-world", "root-story"],
    });
  });

  it("rejects a Renderer scope that is outside the current backend workspace", async () => {
    const child = new FakeWorkerProcess();
    const events: unknown[] = [];
    const spawnWorker = vi.fn(() => child);
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => ({
        ...createLease(),
        authorizedScopeResourceIds: ["world-1"],
        defaultScopeResourceIds: ["world-1"],
      }),
      spawnWorker,
    });
    supervisor.start({ ...runRequest(), scopeResourceIds: ["other-project-world"] }, (event) => events.push(event));

    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "run.failed",
      code: "AGENT_RUN_FAILED",
    })));
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("fails unknown tools closed without invoking the gateway", () => {
    const child = new FakeWorkerProcess();
    const retrieve = vi.fn();
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => createLease(createGateway({ retrieveGraphEvidence: retrieve })),
      spawnWorker: () => child,
    });
    const runId = supervisor.start(runRequest(), () => undefined);
    child.spawn();
    child.receive({
      type: "tool.request",
      runId,
      requestId: "22222222-2222-4222-8222-222222222222",
      tool: "read_workspace_file",
      args: { path: "C:\\private" },
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(child.sent[1]).toMatchObject({
      ok: false,
      error: { code: "AGENT_TOOL_UNKNOWN" },
    });
  });

  it("fails closed before spawning when Main has no audited workspace lease", async () => {
    const child = new FakeWorkerProcess();
    const events: unknown[] = [];
    const supervisor = new AgentProcessSupervisor("worker.js", { spawnWorker: () => child });
    supervisor.start(runRequest(), (event) => events.push(event));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "run.failed",
      code: "AGENT_TOOLS_REQUIRED",
    })));
    expect(child.sent).toEqual([]);
  });

  it("injects a validated Provider profile only through internal child IPC", () => {
    const child = new FakeWorkerProcess();
    const supervisor = new AgentProcessSupervisor("worker.js", {
      acquireRuntimeLease: () => createLease(),
      getProviderProfile: () => ({
        providerId: "secure-provider",
        displayName: "Secure Provider",
        baseUrl: "https://provider.example/v1",
        apiKey: "internal-secret",
        modelId: "secure-model",
        contextWindow: 128_000,
        maxTokens: 16_000,
        reasoning: true,
        input: ["text"],
      }),
      spawnWorker: () => child,
    });
    supervisor.start(runRequest(), () => undefined);
    child.spawn();

    expect(child.sent[0]).toMatchObject({
      type: "run.start",
      providerProfile: { providerId: "secure-provider", apiKey: "internal-secret" },
    });
  });

  it("strips legacy Provider environment variables from the child process", () => {
    expect(createAgentWorkerEnvironment({
      PATH: "C:\\Windows",
      NOVAX_PROVIDER_API_KEY: "legacy-secret",
      NOVAX_PROVIDER_MODEL: "legacy-model",
    })).toEqual({ PATH: "C:\\Windows", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("aborts pending Main calls and kills the child after cancellation grace", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeWorkerProcess();
      let invocationSignal: AbortSignal | undefined;
      const gateway = createGateway({
        retrieveGraphEvidence: (_args, context) => {
          invocationSignal = context.signal;
          return new Promise(() => undefined);
        },
      });
      const events: unknown[] = [];
      const supervisor = new AgentProcessSupervisor("worker.js", {
        acquireRuntimeLease: () => createLease(gateway),
        spawnWorker: () => child,
        cancelGraceMs: 25,
      });
      const runId = supervisor.start(runRequest(), (event) => events.push(event));
      child.spawn();
      child.receive({
        type: "tool.request",
        runId,
        requestId: "44444444-4444-4444-8444-444444444444",
        tool: "retrieve_graph_evidence",
        args: { scopeResourceIds: ["world-1"] },
      });
      await Promise.resolve();

      supervisor.cancel(runId);
      expect(invocationSignal?.aborted).toBe(true);
      expect(child.sent.at(-1)).toEqual({ type: "run.cancel", runId });
      expect(events).toContainEqual(expect.objectContaining({ type: "run.failed", code: "AGENT_RUN_CANCELLED" }));
      await vi.advanceTimersByTimeAsync(26);
      expect(child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the longer image timeout and aborts a still-running generation at its own deadline", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeWorkerProcess();
      let invocationSignal: AbortSignal | undefined;
      const supervisor = new AgentProcessSupervisor("worker.js", {
        acquireRuntimeLease: () => createLease(createGateway({
          generateImage: (_args, context) => {
            invocationSignal = context.signal;
            return new Promise(() => undefined);
          },
        })),
        toolTimeoutMs: 5,
        imageToolTimeoutMs: 50,
        spawnWorker: () => child,
      });
      const runId = supervisor.start(runRequest(), () => undefined);
      child.spawn();
      child.receive({
        type: "tool.request",
        runId,
        requestId: "55555555-5555-4555-8555-555555555555",
        tool: "generate_image",
        args: {
          title: "银湾夜潮", purpose: "scene", prompt: "月光下的银湾海岸",
          sourceResourceIds: ["world-1"], sourceVersionIds: ["version-1"],
          idempotencyKey: "silver-bay-image-v1",
        },
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(6);
      expect(invocationSignal?.aborted).toBe(false);
      expect(child.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(44);
      expect(invocationSignal?.aborted).toBe(true);
      expect(child.sent.at(-1)).toMatchObject({
        type: "tool.response",
        ok: false,
        error: { code: "AGENT_TOOL_TIMEOUT" },
      });
      supervisor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
