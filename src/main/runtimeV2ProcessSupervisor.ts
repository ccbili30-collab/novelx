import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { z } from "zod";
import {
  RUNTIME_V2_PROTOCOL_VERSION,
  RuntimeV2ProtocolVersionError,
  parseRuntimeV2HelloEnvelope,
  parseRuntimeV2InitializationFailedEnvelope,
  parseRuntimeV2ReadyEnvelope,
  runtimeV2InitializeEnvelopeSchema,
  type RuntimeV2HelloEnvelope,
  type RuntimeV2Error,
  type RuntimeV2InitializeEnvelope,
  type RuntimeV2ReadyEnvelope,
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
  featureFlags: Record<string, boolean>;
  hostCapabilityVersions: Record<string, string>;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  onStderr?(text: string): void;
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
  readonly #options: Required<Pick<RuntimeV2ProcessSupervisorOptions, "startupTimeoutMs" | "stopTimeoutMs">>
    & Omit<RuntimeV2ProcessSupervisorOptions, "startupTimeoutMs" | "stopTimeoutMs">;
  #child: ChildProcessWithoutNullStreams | null = null;
  #stderr = "";

  constructor(options: RuntimeV2ProcessSupervisorOptions) {
    this.#options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? 5_000,
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
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
      this.#options.onStderr?.(chunk);
    });

    try {
      return await this.#completeHandshake(child);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    const pid = child.pid;
    const exited = waitForExit(child);
    if (!child.stdin.destroyed) child.stdin.end();
    if (await resolvesWithin(exited, this.#options.stopTimeoutMs)) return;
    if (pid) terminateOwnedProcessTree(pid);
    if (!child.killed) child.kill();
    await resolvesWithin(exited, this.#options.stopTimeoutMs);
  }

  async #completeHandshake(child: ChildProcessWithoutNullStreams): Promise<RuntimeV2Handshake> {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let hello: RuntimeV2HelloEnvelope | null = null;
    let initialize: RuntimeV2InitializeEnvelope | null = null;

    try {
      return await new Promise<RuntimeV2Handshake>((resolve, reject) => {
        let settled = false;
        const finish = (operation: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          operation();
        };
        const fail = (error: RuntimeV2SupervisorError): void => finish(() => reject(error));
        const timer = setTimeout(() => fail(new RuntimeV2SupervisorError(
          "RUNTIME_V2_START_TIMEOUT",
          `Runtime V2 did not become ready within ${this.#options.startupTimeoutMs}ms.${stderrSuffix(this.#stderr)}`,
        )), this.#options.startupTimeoutMs);

        child.once("error", (error) => fail(new RuntimeV2SupervisorError(
          "RUNTIME_V2_SPAWN_FAILED",
          `Runtime V2 process failed to start.${stderrSuffix(this.#stderr)}`,
          { cause: error },
        )));
        child.once("exit", (code, signal) => fail(new RuntimeV2SupervisorError(
          "RUNTIME_V2_EXITED_BEFORE_READY",
          `Runtime V2 exited before ready (code=${String(code)}, signal=${String(signal)}).${stderrSuffix(this.#stderr)}`,
        )));
        lines.on("line", (line) => {
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
        });
      });
    } finally {
      lines.close();
    }
  }
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
