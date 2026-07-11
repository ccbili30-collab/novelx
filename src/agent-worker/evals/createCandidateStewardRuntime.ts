import type { AgentWorkerAuditOperation } from "../../shared/agentWorkerProtocol";
import type { ModelProfile } from "../pi/modelProfile";
import type { RuntimeAdapter } from "../pi/runtimeAdapterContract";
import type { PublishedPrompt } from "../promptRegistry";
import { runStewardRuntime } from "../stewardRuntime";
import { createAgentTools, type AgentToolExecutor } from "../tools/createAgentTools";
import { createCandidateSpecialistEvaluationTools } from "./createCandidateSpecialistTools";
import { createEvalResultTool } from "./evalResultTools";

export function runCandidateStewardEvaluation(input: {
  runId: string;
  userInput: string;
  mode: "free" | "assist";
  scopeResourceIds: string[];
  providerProfile: ModelProfile;
  prompts: PublishedPrompt[];
  adapter: RuntimeAdapter;
  executor: AgentToolExecutor;
  signal?: AbortSignal;
  audit: {
    record(runId: string, operation: AgentWorkerAuditOperation, signal?: AbortSignal): Promise<void>;
  };
}) {
  const stewardPrompt = requireCandidateStewardPrompt(input.prompts);
  const specialistTools = createCandidateSpecialistEvaluationTools({
    runId: input.runId,
    parentInvocationId: `${input.runId}:steward`,
    providerProfile: input.providerProfile,
    prompts: input.prompts,
    createAdapter: () => input.adapter,
    audit: input.audit,
  });
  return runStewardRuntime({
    runId: input.runId,
    userInput: input.userInput,
    mode: input.mode,
    scopeResourceIds: input.scopeResourceIds,
    providerProfile: input.providerProfile,
    prompt: stewardPrompt,
    adapter: input.adapter,
    tools: [...createAgentTools(input.executor), ...specialistTools],
    resultCapture: createEvalResultTool("steward"),
    audit: input.audit,
    signal: input.signal,
  });
}

function requireCandidateStewardPrompt(prompts: PublishedPrompt[]): PublishedPrompt {
  const matches = prompts.filter((candidate) => candidate.role === "steward");
  const prompt = matches[0];
  if (
    matches.length !== 1
    || !prompt
    || prompt.id !== "novax.steward"
    || prompt.status !== "candidate"
  ) {
    throw candidateRuntimeError("PROMPT_SET_INCOMPLETE");
  }
  return prompt;
}

function candidateRuntimeError(code: string): Error & { code: string } {
  return Object.assign(new Error("Candidate Steward Prompt set is invalid."), { code });
}
