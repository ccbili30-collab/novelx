import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalAuditHash } from "../../src/domain/audit/canonicalAuditHash";
import { RuntimeV2ProcessSupervisor, type RuntimeV2RuntimeEvent } from "../../src/main/runtimeV2ProcessSupervisor";
import type { RuntimeV2ContextCompilePayload, RuntimeV2RunStartPayload } from "../../src/shared/runtimeV2Protocol";
import { RuntimeV2LoopbackProvider, completionProviderResponse } from "./runtimeV2LoopbackProvider";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runtimeRoot = path.join(appRoot, "runtime");
const runtimeExecutable = path.join(runtimeRoot, "target", "debug", process.platform === "win32" ? "novelx-runtime.exe" : "novelx-runtime");

export interface ToolCallLiveFixtureOptions { mode: "free" | "assist" }
export interface ProviderToolCallSpec { id: string; name: string; arguments: Record<string, unknown> }

export class RuntimeV2ToolCallBlackboxDriver {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-toolcall-live-"));
  readonly databasePath = path.join(this.root, "runtime.db");
  readonly runId = randomUUID();
  readonly events: RuntimeV2RuntimeEvent[] = [];
  provider: RuntimeV2LoopbackProvider | null = null;
  supervisor: RuntimeV2ProcessSupervisor | null = null;

  constructor(readonly options: ToolCallLiveFixtureOptions) {
    fs.mkdirSync(path.join(this.root, "世界观"), { recursive: true });
    fs.writeFileSync(path.join(this.root, "世界观", "海岸线.md"), "海岸线由沉降形成。\n精灵居住在曲折海湾。\n", "utf8");
  }

  async startListReadScenario(): Promise<void> {
    await this.startToolScenario(defaultToolCalls());
  }

  async startToolScenario(calls: ProviderToolCallSpec[]): Promise<void> {
    this.provider = await RuntimeV2LoopbackProvider.start([
      { body: toolTurn(calls) },
      { body: completionProviderResponse("已读取海岸线设定。") },
    ]);
    const providerConfig = runtimeProviderConfig(this.provider.baseUrl);
    const configSha256 = canonicalAuditHash(providerConfig);
    const start = runStartPayload(this.options.mode, configSha256);
    this.supervisor = new RuntimeV2ProcessSupervisor({
      executablePath: runtimeExecutable,
      application: { id: "novelx.desktop.toolcall_blackbox", version: "0.2.7", commit: "toolcall-live-driver" },
      workspaceDatabasePath: this.databasePath, projectRootPath: this.root,
      projectId: "project-1", workspaceId: "workspace-1", featureFlags: { runtime_v2: true },
      hostCapabilityVersions: { runtime_supervisor: "1.0.0", project_tools: "1.0.0" },
      startupTimeoutMs: 10_000, commandTimeoutMs: 10_000, stopTimeoutMs: 2_000,
    });
    this.supervisor.subscribeRuntimeEvents((event) => this.events.push(event));
    await this.supervisor.start();
    await this.supervisor.bindProvider(providerConfig, configSha256, "toolcall-loopback-secret");
    await this.supervisor.startRun(this.runId, start);
    await this.supervisor.prepareRun(this.runId, { prepareIdempotencyKey: `prepare-${this.runId}` });
    const compilation = await this.supervisor.compileContext(this.runId, contextCompilePayload(start));
    await this.supervisor.startProviderInference(this.runId, {
      inferenceId: randomUUID(), attemptId: randomUUID(), invocationId: "steward-toolcall-1",
      contextCompilationId: compilation.compilationId, requestNumber: 1, attemptNumber: 1,
      inferenceIdempotencyKey: `inference-${this.runId}`,
    });
    await this.provider.waitForRequest(0, 10_000);
  }

  async runMissingProviderScenario() {
    const config = runtimeProviderConfig("http://127.0.0.1:9/v1");
    const start = runStartPayload(this.options.mode, canonicalAuditHash(config));
    this.supervisor = this.createSupervisor(this.root);
    await this.supervisor.start();
    await this.supervisor.startRun(this.runId, start);
    return this.supervisor.prepareRun(this.runId, { prepareIdempotencyKey: `prepare-missing-provider-${this.runId}` });
  }

  async runMissingRootScenario(): Promise<void> {
    this.supervisor = this.createSupervisor(null);
    await this.supervisor.start();
  }

  async restartWithoutNewProviderRequest(): Promise<number> {
    if (!this.provider || !this.supervisor) throw new Error("live scenario is not running");
    const before = this.provider.requests.length;
    await this.supervisor.stop();
    this.supervisor = this.createSupervisor(this.root);
    this.supervisor.subscribeRuntimeEvents((event) => this.events.push(event));
    await this.supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    return this.provider.requests.length - before;
  }

  async waitForToolEvent(name: RuntimeV2RuntimeEvent["name"], timeoutMs = 10_000): Promise<RuntimeV2RuntimeEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.find((candidate) => candidate.name === name);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Runtime did not emit ${name}`);
  }

  async waitForToolEvents(name: RuntimeV2RuntimeEvent["name"], count: number, timeoutMs = 10_000): Promise<RuntimeV2RuntimeEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.events.filter((candidate) => candidate.name === name);
      if (found.length >= count) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Runtime did not emit ${count} ${name} events`);
  }

  async waitForSecondProviderRequest() {
    if (!this.provider) throw new Error("loopback Provider is not started");
    return this.provider.waitForRequest(1, 10_000);
  }

  async close(): Promise<void> {
    try { await this.supervisor?.stop(); } finally {
      try { await this.provider?.close(); } finally { fs.rmSync(this.root, { recursive: true, force: true }); }
    }
  }

  writeInvalidUtf8(relativePath: string): void {
    fs.writeFileSync(path.join(this.root, relativePath), Buffer.from([0xff, 0xfe, 0xfd]));
  }

  writeLargeText(relativePath: string, characters: number): void {
    fs.writeFileSync(path.join(this.root, relativePath), "长".repeat(characters), "utf8");
  }

  private createSupervisor(projectRootPath: string | null): RuntimeV2ProcessSupervisor {
    return new RuntimeV2ProcessSupervisor({
      executablePath: runtimeExecutable,
      application: { id: "novelx.desktop.toolcall_blackbox", version: "0.2.7", commit: "toolcall-live-driver" },
      workspaceDatabasePath: this.databasePath, projectRootPath,
      projectId: "project-1", workspaceId: "workspace-1", featureFlags: { runtime_v2: true },
      hostCapabilityVersions: { runtime_supervisor: "1.0.0", project_tools: "1.0.0" },
      startupTimeoutMs: 10_000, commandTimeoutMs: 10_000, stopTimeoutMs: 2_000,
    });
  }
}

function defaultToolCalls(): ProviderToolCallSpec[] {
  return [
    { id: "provider-list-1", name: "list_project_directory", arguments: { path: "世界观" } },
    { id: "provider-read-1", name: "read_project_file", arguments: { path: "世界观/海岸线.md", offsetChars: 0, maxChars: 4_000 } },
    { id: "provider-search-1", name: "search_project_files", arguments: { query: "精灵", path: "世界观" } },
    { id: "provider-glob-1", name: "glob_project_files", arguments: { pattern: "**/*.md", path: "" } },
    { id: "provider-stat-1", name: "stat_project_file", arguments: { path: "世界观/海岸线.md" } },
  ];
}

function toolTurn(specs: ProviderToolCallSpec[]) {
  const calls = specs.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
  return { id: "response-tools-1", model: "deepseek-chat",
    choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls } }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } };
}

function runtimeProviderConfig(baseUrl: string) {
  return { schemaVersion: 1 as const, profileId: "profile-1", providerId: "deepseek", displayName: "DeepSeek",
    baseUrl, modelId: "deepseek-chat", apiFlavor: "open_ai_chat_completions" as const, authScheme: "bearer" as const,
    contextWindow: 1_000_000, maxTokens: null, reasoning: false, input: ["text" as const], requestTimeoutMs: 30_000,
    totalDeadlineMs: 120_000, retryPolicy: { maxAttempts: 3, maxTotalDelayMs: 30_000 } };
}

function runStartPayload(mode: "free" | "assist", configSha256: string): RuntimeV2RunStartPayload {
  const policy = (id: string, digit: string) => ({ id, version: "1.0.0", sha256: digit.repeat(64) });
  return { startIdempotencyKey: `start-${randomUUID()}`, pinnedIdentity: {
    projectId: "project-1", workspaceId: "workspace-1", sessionId: "session-1", sessionBranchId: "session-branch-1",
    userMessageId: "user-message-1", projectBranchId: "project-branch-1", goal: null, plan: null,
    assignment: null, parentRunId: null, delegationDepth: 0,
    provider: { profileId: "profile-1", providerId: "deepseek", modelId: "deepseek-chat", configSha256 },
    promptBundle: policy("novelx.steward", "b"), agentProfile: policy("novelx.agent.steward", "c"),
    toolPolicy: policy("novelx.tools", "d"), contextPolicy: policy("novelx.context", "e"), runtimePolicy: policy("novelx.runtime", "f"),
    runtimeContractVersion: "1.0.0", mode, sourceCheckpointId: "checkpoint-1",
    scopeResourceIds: ["resource-1", "resource-2"], resourceScopeSha256: sha256(JSON.stringify(["resource-1", "resource-2"])), userInputSha256: "2".repeat(64),
  } };
}

function contextCompilePayload(start: RuntimeV2RunStartPayload): RuntimeV2ContextCompilePayload {
  const system = "Use project tools and preserve exact source text.";
  const current = "列出世界观目录并读取海岸线设定。";
  return { compileIdempotencyKey: `compile-${randomUUID()}`, invocationId: "steward-toolcall-1", requestNumber: 1,
    provider: start.pinnedIdentity.provider, contextPolicy: start.pinnedIdentity.contextPolicy,
    compilerVersion: "1.0.0", contextWindow: 1_000_000, configuredMaxOutputTokens: null, safetyReserveTokens: 100_000,
    items: [
      { type: "system_prompt", itemId: "system-1", content: system, contentSha256: sha256(system), disclosure: "agent_internal", required: true },
      { type: "session_message", itemId: "current-1", messageId: "message-1", role: "user", content: current,
        contentSha256: sha256(current), createdAt: "2026-07-12T00:00:00Z", disclosure: "project_private", required: true },
    ] };
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
