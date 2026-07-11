import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBoundSpecialistToolSet,
  type SpecialistToolSetInput,
} from "../tools/createSpecialistTools";
import type { PublishedPrompt } from "../promptRegistry";

export function createCandidateSpecialistEvaluationTools(input: SpecialistToolSetInput): AgentTool[] {
  const writerPrompt = requireCandidatePrompt(input.prompts, "writer");
  const checkerPrompt = requireCandidatePrompt(input.prompts, "checker");
  return createBoundSpecialistToolSet(input, writerPrompt, checkerPrompt);
}

function requireCandidatePrompt(prompts: PublishedPrompt[], role: "writer" | "checker"): PublishedPrompt {
  const matches = prompts.filter((candidate) => candidate.role === role);
  const prompt = matches[0];
  if (
    matches.length !== 1
    || !prompt
    || prompt.id !== `novax.${role}`
    || prompt.status !== "candidate"
  ) {
    throw evaluationError("PROMPT_SET_INCOMPLETE");
  }
  return prompt;
}

function evaluationError(code: string): Error & { code: string } {
  return Object.assign(new Error("Candidate Specialist Prompt set is invalid."), { code });
}
