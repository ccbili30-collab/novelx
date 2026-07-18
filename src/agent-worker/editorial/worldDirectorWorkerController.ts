import {
  type WorldDirectorEvent,
  type WorldDirectorStart,
  worldDirectorEventSchema,
} from "../../shared/growthEditorialWorkerProtocol";
import { createOpenAiCompatiblePiAdapter } from "../pi/NovaxPiRuntimeAdapter";
import type { RuntimeAdapter } from "../pi/runtimeAdapterContract";
import { runWorldDirector } from "./worldDirectorRuntime";

const defaults = { createAdapter: createOpenAiCompatiblePiAdapter };

export async function handleWorldDirectorCommand(
  input: {
    command: WorldDirectorStart;
    signal: AbortSignal;
    emit(event: WorldDirectorEvent): void;
  },
  dependencies: {
    createAdapter(profile: NonNullable<WorldDirectorStart["providerProfile"]>): RuntimeAdapter;
  } = defaults,
): Promise<void> {
  const { command } = input;
  input.emit(worldDirectorEventSchema.parse({
    type: "growth.editorial.director.started",
    runId: command.runId,
    invocationKind: command.invocationKind,
  }));
  try {
    const result = await runWorldDirector({
      command,
      createAdapter: dependencies.createAdapter,
      signal: input.signal,
    });
    const event = result.kind === "plan"
      ? {
          type: "growth.editorial.director.planned" as const,
          runId: command.runId,
          plan: result.plan,
          receipt: projectReceipt(result.receipt),
        }
      : {
          type: "growth.editorial.director.reviewed" as const,
          runId: command.runId,
          review: result.review,
          receipt: projectReceipt(result.receipt),
        };
    input.emit(worldDirectorEventSchema.parse(event));
  } catch (error) {
    input.emit(worldDirectorEventSchema.parse({
      type: "growth.editorial.director.failed",
      runId: command.runId,
      error: {
        code: readErrorCode(error),
        message: "世界总编运行失败，未写入项目。",
      },
    }));
  }
}

function projectReceipt(receipt: Awaited<ReturnType<RuntimeAdapter["run"]>>["receipt"] | undefined) {
  return {
    actualProviderId: receipt?.actualProviderId ?? null,
    actualModelId: receipt?.actualModelId ?? null,
    responseIdSha256: receipt?.responseIdSha256 ?? null,
    inputTokens: receipt?.inputTokens ?? null,
    outputTokens: receipt?.outputTokens ?? null,
    totalTokens: receipt?.totalTokens ?? null,
    correctionAttempts: receipt?.correctionAttempts ?? 0,
  };
}

function readErrorCode(error: unknown): string {
  const value = error && typeof error === "object" && "code" in error ? String(error.code) : "WORLD_DIRECTOR_FAILED";
  return /^[A-Z][A-Z0-9_]{0,119}$/.test(value) ? value : "WORLD_DIRECTOR_FAILED";
}
