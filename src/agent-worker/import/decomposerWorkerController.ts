import { createOpenAiCompatiblePiAdapter } from "../pi/NovaxPiRuntimeAdapter";
import { requireActiveDecomposerPrompt } from "./decomposerPromptRegistry";
import { runDecomposerWithReceipt } from "./decomposerRuntime";
import { decomposerWorkerEventSchema, type DecomposerWorkerEvent, type DecomposerWorkerStart } from "../../shared/decomposerWorkerProtocol";
import type { DecomposerPrompt } from "./decomposerPromptRegistry";
import type { RuntimeAdapter } from "../pi/runtimeAdapterContract";

const defaults = { loadPrompt: requireActiveDecomposerPrompt, createAdapter: createOpenAiCompatiblePiAdapter };

export async function handleDecomposerWorkerCommand(input: { command: DecomposerWorkerStart; signal: AbortSignal; emit(event: DecomposerWorkerEvent): void },
  dependencies: { loadPrompt(): DecomposerPrompt; createAdapter(profile: DecomposerWorkerStart["providerProfile"]): RuntimeAdapter } = defaults): Promise<void> {
  input.emit(decomposerWorkerEventSchema.parse({ type: "decompose.started", runId: input.command.runId }));
  try {
    const result = await runDecomposerWithReceipt({ chunks: input.command.chunks, providerProfile: input.command.providerProfile,
      prompt: dependencies.loadPrompt(), createAdapter: dependencies.createAdapter, signal: input.signal });
    const receipt = result.receipt;
    input.emit(decomposerWorkerEventSchema.parse({ type: "decompose.completed", runId: input.command.runId, output: result.output, receipt: {
      actualProviderId: receipt?.actualProviderId ?? null, actualModelId: receipt?.actualModelId ?? null, responseIdSha256: receipt?.responseIdSha256 ?? null,
      inputTokens: receipt?.inputTokens ?? null, outputTokens: receipt?.outputTokens ?? null, totalTokens: receipt?.totalTokens ?? null,
      contextPolicyVersion: receipt?.contextPolicyVersion ?? null, maxChargedInputBytes: receipt?.maxChargedInputBytes ?? null,
      configuredContextWindow: receipt?.configuredContextWindow ?? null, safetyReserve: receipt?.safetyReserve ?? null,
      outputReserve: receipt?.outputReserve ?? null, correctionAttempts: receipt?.correctionAttempts ?? 0,
    } }));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code).slice(0, 120) : "DECOMPOSITION_FAILED";
    input.emit(decomposerWorkerEventSchema.parse({ type: "decompose.failed", runId: input.command.runId, error: { code, message: "拆解运行失败，未写入候选。" } }));
  }
}
