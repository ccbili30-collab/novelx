import { createOpenAiCompatiblePiAdapter } from "../pi/NovaxPiRuntimeAdapter";
import type { RuntimeAdapter } from "../pi/runtimeAdapterContract";
import {
  growthEditorialSpecialistEventSchema,
  type GrowthEditorialSpecialistEvent,
  type GrowthEditorialSpecialistStart,
} from "../../shared/growthEditorialWorkerProtocol";
import { runGrowthEditorialSpecialist } from "./specialistRuntime";

const defaults = { createAdapter: createOpenAiCompatiblePiAdapter };

export async function handleGrowthEditorialSpecialistCommand(
  input: {
    command: GrowthEditorialSpecialistStart;
    signal: AbortSignal;
    emit(event: GrowthEditorialSpecialistEvent): void;
  },
  dependencies: {
    createAdapter(profile: NonNullable<GrowthEditorialSpecialistStart["providerProfile"]>): RuntimeAdapter;
  } = defaults,
): Promise<void> {
  const { command } = input;
  input.emit(growthEditorialSpecialistEventSchema.parse({
    type: "growth.editorial.specialist.started",
    runId: command.runId,
    attemptId: command.attemptId,
    capabilityId: command.binding.capabilityId,
  }));
  try {
    const result = await runGrowthEditorialSpecialist({
      command,
      createAdapter: dependencies.createAdapter,
      signal: input.signal,
    });
    const event = result.candidate.status === "ready"
      ? {
          type: "growth.editorial.specialist.completed" as const,
          runId: command.runId,
          attemptId: command.attemptId,
          candidate: result.candidate,
          artifacts: result.artifacts,
          receipt: projectReceipt(result.receipt),
        }
      : {
          type: "growth.editorial.specialist.evidence_requested" as const,
          runId: command.runId,
          attemptId: command.attemptId,
          request: result.candidate,
          receipt: projectReceipt(result.receipt),
        };
    input.emit(growthEditorialSpecialistEventSchema.parse(event));
  } catch (error) {
    input.emit(growthEditorialSpecialistEventSchema.parse({
      type: "growth.editorial.specialist.failed",
      runId: command.runId,
      attemptId: command.attemptId,
      error: {
        code: readErrorCode(error),
        message: "专业候选运行失败，未写入项目。",
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
  const value = error && typeof error === "object" && "code" in error ? String(error.code) : "GROWTH_SPECIALIST_FAILED";
  return /^[A-Z][A-Z0-9_]{0,119}$/.test(value) ? value : "GROWTH_SPECIALIST_FAILED";
}
