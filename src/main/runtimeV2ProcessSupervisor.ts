import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { z } from "zod";
import {
  RUNTIME_V2_PROTOCOL_VERSION,
  RuntimeV2ProtocolVersionError,
  parseRuntimeV2HelloEnvelope,
  parseRuntimeV2ErrorEnvelope,
  parseRuntimeV2InitializationFailedEnvelope,
  parseRuntimeV2ReadyEnvelope,
  parseRuntimeV2RunRejectedEnvelope,
  parseRuntimeV2RunSnapshotEnvelope,
  parseRuntimeV2StatusEnvelope,
  parseRuntimeV2StoppedEnvelope,
  runtimeV2InitializeEnvelopeSchema,
  runtimeV2RunGetEnvelopeSchema,
  runtimeV2RunCancelEnvelopeSchema,
  runtimeV2RunStartEnvelopeSchema,
  runtimeV2ShutdownEnvelopeSchema,
  runtimeV2StatusGetEnvelopeSchema,
  type RuntimeV2HelloEnvelope,
  type RuntimeV2Error,
  type RuntimeV2InitializeEnvelope,
  type RuntimeV2ReadyEnvelope,
  type RuntimeV2RunSnapshotPayload,
  type RuntimeV2RunCancelPayload,
  type RuntimeV2RunStartPayload,
  type RuntimeV2StatusPayload,
} from "../shared/runtimeV2Protocol";

const MAX_STDERR_CHARS = 16_000;

export interface RuntimeV2ApplicationIdentity {
  id: string;
  version: string;
  commit: string;
}

export interface RuntimeV2ProcessSupervisorOptions {
  executablePath: string;
  executableArgs?: string[];
  application: RuntimeV2ApplicationIdentity;
  workspaceDatabasePath: string | null;
  projectId: string | null;
  workspaceId: string | null;
  featureFlags: Record<string, boolean>;
  hostCapabilityVersions: Record<string, string>;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  stopTimeoutMs?: number;
  onStderr?(text: string): void;
  onRuntimeFailure?(error: RuntimeV2SupervisorError): void;
}

export interface RuntimeV2Handshake {
  hello: RuntimeV2HelloEnvelope;
  ready: RuntimeV2ReadyEnvelope;
}

export type RuntimeV2SupervisorErrorCode =
  | "RUNTIME_V2_ALREADY_STARTED"
  | "RUNTIME_V2_SPAWN_FAILED"
  | "RUNTIME_V2_START_TIMEOUT"
  | "RUNTIME_V2_INVALID_JSON"
  | "RUNTIME_V2_PROTOCOL_INVALID"
  | "RUNTIME_V2_PROTOCOL_VERSION_UNSUPPORTED"
  | "RUNTIME_V2_INITIALIZATION_FAILED"
  | "RUNTIME_V2_EXITED_BEFORE_READY"
  | "RUNTIME_V2_NOT_READY"
  | "RUNTIME_V2_COMMAND_TIMEOUT"
  | "RUNTIME_V2_EXITED_AFTER_READY"
  | "RUNTIME_V2_RUN_REJECTED"
  | "RUNTIME_V2_WRITE_FAILED";

export class RuntimeV2SupervisorError extends Error {
  readonly publicPayload: RuntimeV2Error | null;
  readonly stderr: string;

  constructor(
    readonly code: RuntimeV2SupervisorErrorCode,
    message: string,
    options: ErrorOptions & { publicPayload?: RuntimeV2Error; stderr?: string } = {},
  ) {
    super(message, options);
    this.name = "RuntimeV2SupervisorError";
    this.publicPayload = options.publicPayload ?? null;
    this.stderr = options.stderr ?? "";
  }
}

export class RuntimeV2ProcessSupervisor {
  readonly #options: Required<Pick<RuntimeV2ProcessSupervisorOptions, "startupTimeoutMs" | "commandTimeoutMs" | "stopTimeoutMs">>
    & Omit<RuntimeV2ProcessSupervisorOptions, "startupTimeoutMs" | "commandTimeoutMs" | "stopTimeoutMs">;
  #child: ChildProcessWithoutNullStreams | null = null;
  #lines: readline.Interface | null = null;
  #stderr = "";
  #ready = false;
  #stopping = false;
  #nextHostSequence = 2;
  #expectedRuntimeSequence = 3;
  #pending = new Map<string, PendingCommand>();

  constructor(options: RuntimeV2ProcessSupervisorOptions) {
    this.#options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? 5_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 5_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 2_000,
    };
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  get stderr(): string {
    return this.#stderr;
  }

  async start(): Promise<RuntimeV2Handshake> {
    if (this.#child) {
      throw new RuntimeV2SupervisorError("RUNTIME_V2_ALREADY_STARTED", "Runtime V2 is already started.");
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#options.executablePath, this.#options.executableArgs ?? [], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new RuntimeV2SupervisorError("RUNTIME_V2_SPAWN_FAILED", "Runtime V2 could not be spawned.", { cause: error });
    }
    this.#child = child;
    this.#stderr = "";
    this.#stopping = false;
    this.#nextHostSequence = 2;
    this.#expectedRuntimeSequence = 3;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
      this.#options.onStderr?.(chunk);
    });

    try {
      const handshake = await this.#completeHandshake(child);
      this.#ready = true;
      this.#attachPostReadyListeners(child);
      return handshake;
    } catch (error) {
      await this.#terminateChild(child);
      throw error;
    }
  }

  async status(): Promise<RuntimeV2StatusPayload> {
    const response = await this.#sendCommand("runtime.status.get", "runtime.status", null, {});
    return parseRuntimeV2StatusEnvelope(response).payload;
  }

  async startRun(runId: string, payload: RuntimeV2RunStartPayload): Promise<RuntimeV2RunSnapshotPayload> {
    const response = await this.#sendCommand("run.start", "run.snapshot", runId, payload);
    return parseRuntimeV2RunSnapshotEnvelope(response).payload;
  }

  async getRun(runId: string): Promise<RuntimeV2RunSnapshotPayload> {
    const response = await this.#sendCommand("run.get", "run.snapshot", runId, {});
    return parseRuntimeV2RunSnapshotEnvelope(response).payload;
  }

  async cancelRun(runId: string, payload: RuntimeV2RunCancelPayload): Promise<RuntimeV2RunSnapshotPayload> {
    const response = await this.#sendCommand("run.cancel", "run.snapshot", runId, payload);
    return parseRuntimeV2RunSnapshotEnvelope(response).payload;
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    if (this.#ready) {
      try {
        const response = await this.#sendCommand("runtime.shutdown", "runtime.stopped", null, {}, this.#options.stopTimeoutMs);
        parseRuntimeV2StoppedEnvelope(response);
      } catch {
        // Cleanup must continue even when the runtime cannot complete protocol shutdown.
      }
    }
    await this.#terminateChild(child);
  }

  async #completeHandshake(child: ChildProcessWithoutNullStreams): Promise<RuntimeV2Handshake> {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#lines = lines;
    let hello: RuntimeV2HelloEnvelope | null = null;
    let initialize: RuntimeV2InitializeEnvelope | null = null;

    return new Promise<RuntimeV2Handshake>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(timer);
          child.off("error", onError);
          child.off("exit", onExit);
          lines.off("line", onLine);
        };
        const finish = (operation: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup();
          operation();
        };
        const fail = (error: RuntimeV2SupervisorError): void => finish(() => reject(error));
        const timer = setTimeout(() => fail(new RuntimeV2SupervisorError(
          "RUNTIME_V2_START_TIMEOUT",
          `Runtime V2 did not become ready within ${this.#options.startupTimeoutMs}ms.${stderrSuffix(this.#stderr)}`,
        )), this.#options.startupTimeoutMs);

        const onError = (error: Error): void => fail(new RuntimeV2SupervisorError(
          "RUNTIME_V2_SPAWN_FAILED",
          `Runtime V2 process failed to start.${stderrSuffix(this.#stderr)}`,
          { cause: error },
        ));
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => fail(new RuntimeV2SupervisorError(
          "RUNTIME_V2_EXITED_BEFORE_READY",
          `Runtime V2 exited before ready (code=${String(code)}, signal=${String(signal)}).${stderrSuffix(this.#stderr)}`,
        ));
        const onLine = (line: string): void => {
          if (settled || !line.trim()) return;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch (error) {
            fail(new RuntimeV2SupervisorError("RUNTIME_V2_INVALID_JSON", "Runtime V2 emitted invalid JSON.", { cause: error }));
            return;
          }
          try {
            if (!hello) {
              hello = parseRuntimeV2HelloEnvelope(value);
              initialize = createInitializeEnvelope(this.#options);
              child.stdin.write(`${JSON.stringify(initialize)}\n`, "utf8", (error) => {
                if (error) fail(new RuntimeV2SupervisorError(
                  "RUNTIME_V2_WRITE_FAILED",
                  "Runtime V2 initialize command could not be written.",
                  { cause: error },
                ));
              });
              return;
            }
            const secondName = readMessageName(value);
            if (secondName === "runtime.initialization_failed") {
              const failure = parseRuntimeV2InitializationFailedEnvelope(value);
              if (!initialize || failure.correlationId !== initialize.messageId) {
                throw new Error("runtime.initialization_failed correlationId does not match runtime.initialize messageId.");
              }
              throw new RuntimeV2SupervisorError(
                "RUNTIME_V2_INITIALIZATION_FAILED",
                failure.payload.publicMessage,
                { publicPayload: failure.payload, stderr: this.#stderr },
              );
            }
            if (secondName !== "runtime.ready") {
              throw new Error(`unexpected Runtime V2 handshake message: ${String(secondName)}.`);
            }
            const ready = parseRuntimeV2ReadyEnvelope(value);
            if (!initialize || ready.correlationId !== initialize.messageId) {
              throw new Error("runtime.ready correlationId does not match runtime.initialize messageId.");
            }
            const completedHello = hello;
            if (
              ready.payload.runtime.version !== completedHello.payload.runtimeVersion
              || ready.payload.runtime.build.commit !== completedHello.payload.build.commit
              || ready.payload.runtime.build.target !== completedHello.payload.build.target
            ) {
              throw new Error("runtime.ready identity does not match runtime.hello identity.");
            }
            finish(() => resolve({ hello: completedHello, ready }));
          } catch (error) {
            fail(toProtocolError(error));
          }
        };
        child.once("error", onError);
        child.once("exit", onExit);
        lines.on("line", onLine);
      });
  }

  #attachPostReadyListeners(child: ChildProcessWithoutNullStreams): void {
    const lines = this.#lines;
    if (!lines) throw new RuntimeV2SupervisorError("RUNTIME_V2_PROTOCOL_INVALID", "Runtime V2 output reader is unavailable.");
    lines.on("line", (line) => this.#handlePostReadyLine(line));
    child.once("error", (error) => this.#failRuntime(new RuntimeV2SupervisorError(
      "RUNTIME_V2_EXITED_AFTER_READY",
      `Runtime V2 process failed after ready.${stderrSuffix(this.#stderr)}`,
      { cause: error, stderr: this.#stderr },
    )));
    child.once("exit", (code, signal) => {
      if (!this.#ready || this.#stopping) return;
      this.#failRuntime(new RuntimeV2SupervisorError(
        "RUNTIME_V2_EXITED_AFTER_READY",
        `Runtime V2 exited after ready (code=${String(code)}, signal=${String(signal)}).${stderrSuffix(this.#stderr)}`,
        { stderr: this.#stderr },
      ));
    });
  }

  #handlePostReadyLine(line: string): void {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      const name = readMessageName(value);
      const response = name === "runtime.status"
        ? parseRuntimeV2StatusEnvelope(value)
        : name === "runtime.stopped"
          ? parseRuntimeV2StoppedEnvelope(value)
          : name === "runtime.error"
            ? parseRuntimeV2ErrorEnvelope(value)
            : name === "run.snapshot"
              ? parseRuntimeV2RunSnapshotEnvelope(value)
              : name === "run.rejected"
                ? parseRuntimeV2RunRejectedEnvelope(value)
            : null;
      if (!response) throw new Error(`unexpected Runtime V2 message after ready: ${String(name)}.`);
      if (response.sequence !== this.#expectedRuntimeSequence) {
        throw new Error(`runtime sequence must be ${this.#expectedRuntimeSequence}, received ${response.sequence}.`);
      }
      this.#expectedRuntimeSequence += 1;
      const correlationId = response.correlationId;
      if (!correlationId) throw new Error("Runtime V2 response is missing correlationId.");
      const pending = this.#pending.get(correlationId);
      if (!pending) throw new Error(`Runtime V2 response has no pending command: ${String(correlationId)}.`);
      this.#pending.delete(correlationId);
      clearTimeout(pending.timer);
      if (response.name === "runtime.error" || response.name === "run.rejected") {
        pending.reject(new RuntimeV2SupervisorError(
          response.name === "run.rejected" ? "RUNTIME_V2_RUN_REJECTED" : "RUNTIME_V2_PROTOCOL_INVALID",
          response.payload.publicMessage,
          { publicPayload: response.payload, stderr: this.#stderr },
        ));
        return;
      }
      if (response.name !== pending.expectedName) {
        throw new Error(`expected ${pending.expectedName}, received ${response.name}.`);
      }
      pending.resolve(response);
    } catch (error) {
      this.#failRuntime(toProtocolError(error));
    }
  }

  #sendCommand(
    name: "runtime.status.get" | "runtime.shutdown" | "run.start" | "run.get" | "run.cancel",
    expectedName: "runtime.status" | "runtime.stopped" | "run.snapshot",
    runId: string | null,
    payload: object,
    timeoutMs = this.#options.commandTimeoutMs,
  ): Promise<unknown> {
    const child = this.#child;
    if (!child || !this.#ready || child.stdin.destroyed) {
      return Promise.reject(new RuntimeV2SupervisorError("RUNTIME_V2_NOT_READY", "Runtime V2 is not ready."));
    }
    const sequence = this.#nextHostSequence;
    this.#nextHostSequence += 1;
    const base = {
      protocolVersion: RUNTIME_V2_PROTOCOL_VERSION,
      messageId: randomUUID(),
      messageType: "command" as const,
      name,
      sentAt: new Date().toISOString(),
      correlationId: null,
      runId,
      sequence,
      payload,
    };
    const command = name === "runtime.status.get"
      ? runtimeV2StatusGetEnvelopeSchema.parse(base)
      : name === "runtime.shutdown"
        ? runtimeV2ShutdownEnvelopeSchema.parse(base)
        : name === "run.start"
          ? runtimeV2RunStartEnvelopeSchema.parse(base)
          : name === "run.get"
            ? runtimeV2RunGetEnvelopeSchema.parse(base)
            : runtimeV2RunCancelEnvelopeSchema.parse(base);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(command.messageId);
        const error = new RuntimeV2SupervisorError(
          "RUNTIME_V2_COMMAND_TIMEOUT",
          `${name} did not complete within ${timeoutMs}ms.${stderrSuffix(this.#stderr)}`,
          { stderr: this.#stderr },
        );
        reject(error);
        this.#failRuntime(error);
      }, timeoutMs);
      this.#pending.set(command.messageId, { expectedName, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.#pending.get(command.messageId);
        if (!pending) return;
        this.#pending.delete(command.messageId);
        clearTimeout(pending.timer);
        const failure = new RuntimeV2SupervisorError("RUNTIME_V2_WRITE_FAILED", `${name} could not be written.`, { cause: error });
        reject(failure);
        this.#failRuntime(failure);
      });
    });
  }

  #failRuntime(error: RuntimeV2SupervisorError): void {
    if (!this.#ready) return;
    const child = this.#child;
    this.#ready = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#options.onRuntimeFailure?.(error);
    if (child) void this.#terminateChild(child);
  }

  async #terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.#child === child) this.#child = null;
    this.#ready = false;
    this.#stopping = false;
    this.#lines?.close();
    this.#lines = null;
    const pid = child.pid;
    const exited = waitForExit(child);
    if (!child.stdin.destroyed) child.stdin.end();
    if (await resolvesWithin(exited, this.#options.stopTimeoutMs)) return;
    if (pid) terminateOwnedProcessTree(pid);
    if (!child.killed) child.kill();
    await resolvesWithin(exited, this.#options.stopTimeoutMs);
  }
}

interface PendingCommand {
  expectedName: "runtime.status" | "runtime.stopped" | "run.snapshot";
  resolve(value: unknown): void;
  reject(error: RuntimeV2SupervisorError): void;
  timer: NodeJS.Timeout;
}

function createInitializeEnvelope(
  options: RuntimeV2ProcessSupervisorOptions,
): RuntimeV2InitializeEnvelope {
  return runtimeV2InitializeEnvelopeSchema.parse({
    protocolVersion: RUNTIME_V2_PROTOCOL_VERSION,
    messageId: randomUUID(),
    messageType: "command",
    name: "runtime.initialize",
    sentAt: new Date().toISOString(),
    correlationId: null,
    runId: null,
    sequence: 1,
    payload: {
      selectedProtocolVersion: RUNTIME_V2_PROTOCOL_VERSION,
      application: options.application,
      workspaceDatabasePath: options.workspaceDatabasePath,
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      featureFlags: options.featureFlags,
      hostCapabilityVersions: options.hostCapabilityVersions,
    },
  });
}

function toProtocolError(error: unknown): RuntimeV2SupervisorError {
  if (error instanceof RuntimeV2SupervisorError) return error;
  if (error instanceof RuntimeV2ProtocolVersionError) {
    return new RuntimeV2SupervisorError("RUNTIME_V2_PROTOCOL_VERSION_UNSUPPORTED", error.message, { cause: error });
  }
  if (error instanceof z.ZodError || error instanceof Error) {
    return new RuntimeV2SupervisorError("RUNTIME_V2_PROTOCOL_INVALID", `Runtime V2 handshake is invalid: ${error.message}`, { cause: error });
  }
  return new RuntimeV2SupervisorError("RUNTIME_V2_PROTOCOL_INVALID", "Runtime V2 handshake is invalid.");
}

function readMessageName(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("name" in value)) return undefined;
  return value.name;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function resolvesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    operation.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function terminateOwnedProcessTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The recorded child may have exited between the timeout and termination.
  }
}

function stderrSuffix(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed ? ` stderr: ${trimmed}` : "";
}
