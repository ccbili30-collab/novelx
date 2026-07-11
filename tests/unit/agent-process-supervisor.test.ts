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

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
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
});
